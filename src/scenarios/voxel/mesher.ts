// Voxel Dreamscape: block volume to triangle meshes (pure, no Three.js, no DOM). Runs in the Worker.
// - Greedy meshing: coplanar faces of the same texture, tint, light and ambient occlusion merge into one quad.
// - Smooth lighting as in a block game: sky and block light (0..15, flood filled by light.ts) averaged per
//   vertex over the 4 cells in front of the corner, plus per-vertex ambient occlusion.
// - Three meshes: `solid` (opaque cubes, plus lava), `water` (translucent top surface) and `cross` (plants, fences,
//   rails and panes: small non-cube shapes, drawn double sided).
// Coordinates are scene coordinates: x across, y up, z = -d (the camera travels toward -z). Volume index of cell
// (x, y, z) is `x + sx * (z + sz * y)`; world block position = origin + index. The outermost cells are padding: they are
// read (face culling, occlusion) but never meshed.
import { B, BLOCKS, FLAG, isLava, OPAQUE, Shape } from './blocks.ts';
import { computeLight } from './light.ts';

export interface Volume {
  data: Uint8Array;
  sx: number;
  sy: number;
  sz: number;
  /** World block coordinate of index 0 on each axis. */
  ox: number;
  oy: number;
  oz: number;
  /** Rows (z) on each side kept only for the light of the neighbours: read, never meshed. Default 0. */
  margin?: number;
}

/** Floats per vertex: x, y, z, layer, u, v, packed (see PACK_*). */
export const VERTEX_STRIDE = 7;
/**
 * packed = face + 8 * ao + 32 * sky + 2048 * block + 131072 * flags; face: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z;
 * ao 0 (dark) .. 3; sky and block: sum of the 4 light levels around the corner (0..60, the shader divides by 4).
 */
export const PACK = { ao: 8, sky: 32, block: 2048, flags: 131072 } as const;
/** Drop of the water surface below the top of its block (m). */
export const WATER_DROP = 0.11;
/** Height of a flat rail over the floor of its cell (the block game's 1/16). */
export const RAIL_LIFT = 0.0625;

export interface MeshArrays {
  vertices: Float32Array;
  indices: Uint32Array;
  /** Optional per-vertex constant attributes (3 floats), e.g. lift, drift and phase of a floating island. */
  extra: Float32Array | null;
}

export interface VolumeMeshes {
  solid: MeshArrays;
  water: MeshArrays;
  cross: MeshArrays;
}

class Builder {
  readonly v: number[] = [];
  readonly i: number[] = [];
  readonly e: number[] = [];
  count = 0;
  private readonly extra: readonly [number, number, number] | null;
  constructor(extra: readonly [number, number, number] | null) {
    this.extra = extra;
  }

  /** One quad from 4 corners (12 position floats, 8 uv floats). `flip` picks the other diagonal; `reverse` the other winding. */
  quad(p: ArrayLike<number>, uv: ArrayLike<number>, layer: number, pk: ArrayLike<number>, flip: boolean, reverse: boolean): void {
    const n = this.count;
    for (let c = 0; c < 4; c++) {
      this.v.push(p[c * 3]!, p[c * 3 + 1]!, p[c * 3 + 2]!, layer, uv[c * 2]!, uv[c * 2 + 1]!, pk[c]!);
      if (this.extra) this.e.push(this.extra[0], this.extra[1], this.extra[2]);
    }
    const t = flip ? [1, 2, 3, 1, 3, 0] : [0, 1, 2, 0, 2, 3];
    for (let k = 0; k < 6; k += 3) {
      if (reverse) this.i.push(n + t[k]!, n + t[k + 2]!, n + t[k + 1]!);
      else this.i.push(n + t[k]!, n + t[k + 1]!, n + t[k + 2]!);
    }
    this.count += 4;
  }

  build(): MeshArrays {
    return {
      vertices: Float32Array.from(this.v),
      indices: Uint32Array.from(this.i),
      extra: this.extra ? Float32Array.from(this.e) : null,
    };
  }
}

/** Plane axes (u, v) of the faces of each axis, chosen so that v is up on the side faces. */
const PLANE = [[2, 1], [0, 2], [0, 1]] as const;
/** Direction of u x v for each face axis: a quad built (u0,v0) (u1,v0) (u1,v1) (u0,v1) faces this way along the axis. */
const SIGMA = [-1, -1, 1] as const;
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;

/**
 * `extra`: per-vertex constants of a floating island. `skyLit`: false for a dimension without sky (the Nether), where
 * only block light reaches.
 */
export function meshVolume(vol: Volume, extra: readonly [number, number, number] | null = null, skyLit = true): VolumeMeshes {
  const { data, sx, sy, sz } = vol;
  const dims = [sx, sy, sz] as const;
  const origin = [vol.ox, vol.oy, vol.oz] as const;
  const stride = [1, sx * sz, sx] as const;
  const solid = new Builder(extra), water = new Builder(extra), cross = new Builder(extra);
  const margin = vol.margin ?? 0;
  const light = computeLight(vol, skyLit);
  const solidAt = (idx: number) => (OPAQUE[data[idx]!] ? 1 : 0);
  /**
   * Smooth light of one face corner (a block game's rule): the average of the cell in front of the face and its 3
   * neighbours around that corner, leaving out opaque ones (they hold no light); if both sides are opaque the diagonal
   * is hidden too. Returns 4 x the level (0..60) of each channel: sky + 64 * block.
   */
  const cornerLight = (front: number, side1: number, side2: number, diag: number): number => {
    let skySum = light.sky[front]!, blockSum = light.block[front]!, count = 1;
    const add = (i: number) => { skySum += light.sky[i]!; blockSum += light.block[i]!; count++; };
    const o1 = OPAQUE[data[side1]!], o2 = OPAQUE[data[side2]!];
    if (!o1) add(side1);
    if (!o2) add(side2);
    if (!(o1 && o2) && !OPAQUE[data[diag]!]) add(diag);
    const q = (sum: number) => Math.round((sum * 4) / count);
    return q(skySum) + 64 * q(blockSum);
  };

  // Vertical band that can show faces: below it every cell is solid, above it every cell is air.
  let yLo = sy, yHi = -1;
  for (let y = 0; y < sy; y++) {
    const row = y * sx * sz;
    let solid = 0, air = 0;
    for (let c = 0; c < sx * sz; c++) {
      const id = data[row + c]!;
      if (id === 0) air++;
      else if (OPAQUE[id]) solid++;
    }
    const total = sx * sz;
    if (air < total) yHi = y;
    if (solid < total && yLo === sy) yLo = y;
  }
  yLo = Math.max(1, yLo - 1);
  yHi = Math.min(sy - 2, yHi + 1);
  if (yHi < yLo) return { solid: solid.build(), water: water.build(), cross: cross.build() };

  // Meshed cells per axis: the padding (and the light margin rows) are only read.
  const lo: readonly number[] = [1, yLo, 1 + margin], hi: readonly number[] = [sx - 2, yHi, sz - 2 - margin];
  const su = Math.max(sx, sy, sz);
  // Greedy mask: material key (layer, ao, flags, kind) and the corner light (4 x sky, 4 x block, 6 bits each).
  const mask = new Int32Array(su * su), maskSky = new Int32Array(su * su), maskBlock = new Int32Array(su * su);
  const p = new Array<number>(12), uv = new Array<number>(8), pk = new Array<number>(4), ao = [0, 0, 0, 0], lt = [0, 0, 0, 0];

  for (let a = 0; a < 3; a++) {
    const [pu, pv] = PLANE[a]!;
    for (const s of [1, -1] as const) {
      const face = a * 2 + (s > 0 ? 0 : 1);
      const nu = dims[pu];
      const uLo = lo[pu]!, uHi = hi[pu]!, vLo = lo[pv]!, vHi = hi[pv]!;
      for (let c = lo[a]!; c <= hi[a]!; c++) {
        mask.fill(0, 0, nu * dims[pv]!);
        let any = false;
        for (let v = vLo; v <= vHi; v++) {
          for (let u = uLo; u <= uHi; u++) {
            const pos = c * stride[a]! + u * stride[pu]! + v * stride[pv]!;
            const id = data[pos]!;
            if (id === 0) continue;
            const info = BLOCKS[id];
            if (!info || info.shape !== Shape.Cube) continue;
            const nb = data[pos + s * stride[a]!]!;
            let visible: boolean;
            if (id === B.water) visible = a === 1 && s > 0 && nb !== B.water && !OPAQUE[nb];
            else if (isLava(id)) visible = !isLava(nb) && !OPAQUE[nb];
            else visible = !OPAQUE[nb];
            if (!visible) continue;
            const front = pos + s * stride[a]!;
            // Ambient occlusion and smooth light of the 4 corners of the face, from the cells around the front cell.
            let sky = 0, blk = 0;
            for (let k = 0; k < 4; k++) {
              const du = CORNERS[k]![0] ? 1 : -1, dv = CORNERS[k]![1] ? 1 : -1;
              const i1 = front + du * stride[pu], i2 = front + dv * stride[pv], id2 = i1 + dv * stride[pv];
              const s1 = solidAt(i1), s2 = solidAt(i2), cc = solidAt(id2);
              ao[k] = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
              const l = cornerLight(front, i1, i2, id2);
              sky |= (l & 63) << (6 * k);
              blk |= (l >> 6) << (6 * k);
            }
            let flags = info.flags;
            if (id === B.grass && face !== 2) flags &= ~FLAG.tintMask; // only the top of a grass block is tinted
            const layer = info.faces[face]!;
            const m = v * nu + u;
            mask[m] = layer | (ao[0]! | (ao[1]! << 2) | (ao[2]! << 4) | (ao[3]! << 6)) << 8 | flags << 16 | 1 << 26 | (id === B.water ? 1 << 27 : 0);
            maskSky[m] = sky;
            maskBlock[m] = blk;
            any = true;
          }
        }
        if (!any) continue;
        for (let v = vLo; v <= vHi; v++) {
          for (let u = uLo; u <= uHi; u++) {
            const m = v * nu + u;
            const key = mask[m]!;
            if (key === 0) continue;
            const aoBits = (key >> 8) & 255, sky = maskSky[m]!, blk = maskBlock[m]!;
            // All four corners equal (occlusion and both lights): the quad can grow over equal neighbours.
            const flat = aoBits % 85 === 0 && sky % 266305 === 0 && blk % 266305 === 0;
            const same = (j: number) => mask[j] === key && maskSky[j] === sky && maskBlock[j] === blk;
            let w = 1, h = 1;
            if (flat) {
              while (u + w <= uHi && same(m + w)) w++;
              grow: for (;;) {
                if (v + h > vHi) break;
                for (let t = 0; t < w; t++) if (!same((v + h) * nu + u + t)) break grow;
                h++;
              }
            }
            for (let dv = 0; dv < h; dv++) for (let du = 0; du < w; du++) mask[(v + dv) * nu + u + du] = 0;

            const layer = key & 255, flags = (key >> 16) & 127;
            const q = a * 2 + (s > 0 ? 0 : 1);
            const plane = origin[a]! + c + (s > 0 ? 1 : 0);
            const u0 = origin[pu] + u, u1 = u0 + w, v0 = origin[pv] + v, v1 = v0 + h;
            for (let k = 0; k < 4; k++) {
              const du = CORNERS[k]![0], dv = CORNERS[k]![1];
              p[k * 3 + a] = plane;
              p[k * 3 + pu] = du ? u1 : u0;
              p[k * 3 + pv] = dv ? v1 : v0;
              uv[k * 2] = du ? w : 0;
              uv[k * 2 + 1] = dv ? h : 0;
              const ls = (sky >> (6 * k)) & 63, lb = (blk >> (6 * k)) & 63;
              pk[k] = q + PACK.ao * ((aoBits >> (2 * k)) & 3) + PACK.sky * ls + PACK.block * lb + PACK.flags * flags;
              lt[k] = 3 * ((aoBits >> (2 * k)) & 3) + Math.max(ls, lb) / 4;
            }
            // Split the quad along the diagonal whose corners are the most alike, so the shading does not show a crease.
            const [a0, a1, a2, a3] = lt as [number, number, number, number];
            const reverse = SIGMA[a] !== s;
            const target = key & (1 << 27) ? water : solid;
            if (target === water) for (let k = 0; k < 4; k++) p[k * 3 + 1]! -= WATER_DROP;
            target.quad(p, uv, layer, pk, a0 + a2 < a1 + a3, reverse);
          }
        }
      }
    }
  }

  // Non-cube shapes: one pass over the inner cells.
  for (let y = 1; y < sy - 1; y++) {
    for (let z = 1 + margin; z < sz - 1 - margin; z++) {
      for (let x = 1; x < sx - 1; x++) {
        const cell = x + sx * (z + sz * y);
        const id = data[cell]!;
        if (id === 0) continue;
        const info = BLOCKS[id];
        if (!info || info.shape === Shape.Cube || info.shape === Shape.None) continue;
        const wx = origin[0] + x, wy = origin[1] + y, wz = origin[2] + z;
        // Thin shapes take the light of their own cell (they do not block it).
        const layer = info.faces[2]!;
        const base = 3 * PACK.ao + PACK.sky * 4 * light.sky[cell]! + PACK.block * 4 * light.block[cell]! + PACK.flags * info.flags;
        const all = (face: number) => [base + face, base + face, base + face, base + face];
        switch (info.shape) {
          case Shape.Cross: {
            const sides = [[wx, wz, wx + 1, wz + 1], [wx + 1, wz, wx, wz + 1]] as const;
            for (const [ax, az, bx, bz] of sides) {
              cross.quad([ax, wy, az, bx, wy, bz, bx, wy + 1, bz, ax, wy + 1, az], [0, 0, 1, 0, 1, 1, 0, 1], layer, all(2), false, false);
            }
            break;
          }
          case Shape.Rail: {
            // As in the block game (models/block/template_rail_raised_*.json): a rail with another rail one layer up in
            // the next cell along the track (z) is the flat rail tilted 45 degrees and stretched, rising one block over its
            // cell from 1/16 to 1 + 1/16, so both ends meet the flat rails of the two levels. Toward -z first if both.
            const railAt = (dz: number) => BLOCKS[data[cell + sx * dz + sx * sz]!]?.shape === Shape.Rail;
            const up = railAt(-1) ? -1 : railAt(1) ? 1 : 0;
            const y0 = wy + RAIL_LIFT + (up < 0 ? 1 : 0), y1 = wy + RAIL_LIFT + (up > 0 ? 1 : 0);
            cross.quad([wx, y0, wz, wx + 1, y0, wz, wx + 1, y1, wz + 1, wx, y1, wz + 1], [0, 0, 1, 0, 1, 1, 0, 1], layer, all(2), false, false);
            break;
          }
          case Shape.Pane:
            cross.quad([wx, wy, wz + 0.5, wx + 1, wy, wz + 0.5, wx + 1, wy + 1, wz + 0.5, wx, wy + 1, wz + 0.5], [0, 0, 1, 0, 1, 1, 0, 1], layer, all(4), false, false);
            break;
          case Shape.Stairs: {
            // A bottom half-slab plus a half-depth upper step on the high side (rows d grow with -z, so "ahead" is the -z half).
            box(cross, wx, wy, wz, wx + 1, wy + 0.5, wz + 1, layer, base);
            const ahead = id === B.oakStairsAhead;
            box(cross, wx, wy + 0.5, ahead ? wz : wz + 0.5, wx + 1, wy + 1, ahead ? wz + 0.5 : wz + 1, layer, base);
            break;
          }
          case Shape.Fence: {
            const connects = (dx: number, dz: number) => {
              const nb = data[x + dx + sx * (z + dz + sz * y)]!;
              return BLOCKS[nb]?.shape === Shape.Fence || OPAQUE[nb] === 1;
            };
            box(cross, wx + 0.375, wy, wz + 0.375, wx + 0.625, wy + 1, wz + 0.625, layer, base);
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              if (!connects(dx, dz)) continue;
              const x0 = dx > 0 ? wx + 0.625 : dx < 0 ? wx : wx + 0.4375, x1 = dx > 0 ? wx + 1 : dx < 0 ? wx + 0.375 : wx + 0.5625;
              const z0 = dz > 0 ? wz + 0.625 : dz < 0 ? wz : wz + 0.4375, z1 = dz > 0 ? wz + 1 : dz < 0 ? wz + 0.375 : wz + 0.5625;
              box(cross, x0, wy + 0.375, z0, x1, wy + 0.5625, z1, layer, base);
              box(cross, x0, wy + 0.75, z0, x1, wy + 0.9375, z1, layer, base);
            }
            break;
          }
        }
      }
    }
  }

  return { solid: solid.build(), water: water.build(), cross: cross.build() };
}

/** Axis-aligned box of 6 quads (double sided material, so the winding does not matter). */
function box(b: Builder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, layer: number, base: number): void {
  const q = (face: number, p: number[], uv: number[]) => b.quad(p, uv, layer, [base + face, base + face, base + face, base + face], false, false);
  q(0, [x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0], [z0, y0, z1, y0, z1, y1, z0, y1]);
  q(1, [x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0], [z0, y0, z1, y0, z1, y1, z0, y1]);
  q(2, [x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1], [x0, z0, x1, z0, x1, z1, x0, z1]);
  q(3, [x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1], [x0, z0, x1, z0, x1, z1, x0, z1]);
  q(4, [x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1], [x0, y0, x1, y0, x1, y1, x0, y1]);
  q(5, [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0], [x0, y0, x1, y0, x1, y1, x0, y1]);
}
