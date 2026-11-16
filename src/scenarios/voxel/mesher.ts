// Voxel Dreamscape: block volume to triangle meshes (pure, no Three.js, no DOM). Runs in the Worker.
// - Greedy meshing: coplanar faces of the same texture, tint, light and ambient occlusion merge into one quad.
// - Per-vertex ambient occlusion (the classic "smooth lighting" corner rule) and an approximate sky light per face
//   (open sky = full, covered cells fall off with the distance to open sky, so tunnels and island undersides are dark).
// - Three meshes: `solid` (opaque cubes, plus lava), `water` (translucent top surface) and `cross` (plants, fences,
//   rails and panes: small non-cube shapes, drawn double sided).
// Coordinates are scene coordinates: x across, y up, z = -d (the camera travels toward -z). Volume index of cell
// (x, y, z) is `x + sx * (z + sz * y)`; world block position = origin + index. The outermost cells are padding: they are
// read (face culling, occlusion) but never meshed.
import { B, BLOCKS, FLAG, OPAQUE, Shape } from './blocks.ts';

export interface Volume {
  data: Uint8Array;
  sx: number;
  sy: number;
  sz: number;
  /** World block coordinate of index 0 on each axis. */
  ox: number;
  oy: number;
  oz: number;
}

/** Floats per vertex: x, y, z, layer, u, v, packed (see PACK_*). */
export const VERTEX_STRIDE = 7;
/** packed = face + 8 * ao + 32 * light + 256 * flags; face: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z; ao 0 (dark) .. 3; light 0..7. */
export const PACK = { ao: 8, light: 32, flags: 256 } as const;
export const LIGHT_MAX = 7;
/** Drop of the water surface below the top of its block (m). */
export const WATER_DROP = 0.11;

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

export function meshVolume(vol: Volume, extra: readonly [number, number, number] | null = null): VolumeMeshes {
  const { data, sx, sy, sz } = vol;
  const dims = [sx, sy, sz] as const;
  const origin = [vol.ox, vol.oy, vol.oz] as const;
  const stride = [1, sx * sz, sx] as const;
  const solid = new Builder(extra), water = new Builder(extra), cross = new Builder(extra);

  // Highest opaque cell of every column: the sky light reaches everything above it.
  const top = new Int16Array(sx * sz).fill(-1);
  for (let y = sy - 1; y >= 0; y--) {
    const row = y * sx * sz;
    for (let c = 0; c < sx * sz; c++) if (top[c]! < 0 && OPAQUE[data[row + c]!]) top[c] = y;
  }
  const lightCache = new Map<number, number>();
  const lightAt = (x: number, y: number, z: number): number => {
    // Floating pieces hang in open air: the sky reaches every side (only the ambient occlusion shades them).
    if (extra) return LIGHT_MAX - 1;
    if (y > top[x + z * sx]!) return LIGHT_MAX;
    const key = (x + z * sx) * 128 + Math.min(127, Math.max(0, y));
    const hit = lightCache.get(key);
    if (hit !== undefined) return hit;
    let best = 0;
    for (let dz = -3; dz <= 3; dz++) {
      const zz = z + dz;
      if (zz < 0 || zz >= sz) continue;
      for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= sx) continue;
        if (y > top[xx + zz * sx]!) best = Math.max(best, LIGHT_MAX - 2 * Math.max(Math.abs(dx), Math.abs(dz)));
      }
    }
    const out = Math.max(0, best);
    lightCache.set(key, out);
    return out;
  };
  const solidAt = (idx: number) => (OPAQUE[data[idx]!] ? 1 : 0);

  // Block light: glowstone lights the cells within 3 blocks (level 3 next to it), not blocked by walls (cheap and
  // good enough for lamps and ceilings). Stored in 2 bits per face (flags bits 64 and 128).
  const blockLight = new Uint8Array(data.length);
  for (let i = data.indexOf(B.glowstone); i >= 0; i = data.indexOf(B.glowstone, i + 1)) {
    const gx = i % sx, gz = Math.floor(i / sx) % sz, gy = Math.floor(i / (sx * sz));
    for (let dy = -3; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      const x = gx + dx, y = gy + dy, z = gz + dz;
      if (x < 0 || x >= sx || y < 0 || y >= sy || z < 0 || z >= sz) continue;
      const lvl = 4 - Math.ceil(Math.sqrt(dx * dx + dy * dy + dz * dz));
      const j = x + sx * (z + sz * y);
      if (lvl > blockLight[j]!) blockLight[j] = lvl;
    }
  }

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

  const su = Math.max(sx, sy, sz);
  const mask = new Int32Array(su * su);
  const co = [0, 0, 0];
  const p = new Array<number>(12), uv = new Array<number>(8), pk = new Array<number>(4), ao = [0, 0, 0, 0];

  for (let a = 0; a < 3; a++) {
    const [pu, pv] = PLANE[a]!;
    const nu = dims[pu], nv = dims[pv];
    for (const s of [1, -1] as const) {
      const face = a * 2 + (s > 0 ? 0 : 1);
      const cLo = a === 1 ? yLo : 1, cHi = a === 1 ? yHi : dims[a]! - 2;
      for (let c = cLo; c <= cHi; c++) {
        mask.fill(0, 0, nu * nv);
        const vLo = pv === 1 ? yLo : 1, vHi = pv === 1 ? yHi : nv - 2;
        let any = false;
        for (let v = vLo; v <= vHi; v++) {
          for (let u = 1; u < nu - 1; u++) {
            const pos = c * stride[a]! + u * stride[pu]! + v * stride[pv]!;
            const id = data[pos]!;
            if (id === 0) continue;
            const info = BLOCKS[id];
            if (!info || info.shape !== Shape.Cube) continue;
            const nb = data[pos + s * stride[a]!]!;
            let visible: boolean;
            if (id === B.water) visible = a === 1 && s > 0 && nb !== B.water && !OPAQUE[nb];
            else if (id === B.lava) visible = nb !== B.lava && !OPAQUE[nb];
            else visible = !OPAQUE[nb];
            if (!visible) continue;
            co[a] = c; co[pu] = u; co[pv] = v;
            const front = pos + s * stride[a]!;
            const light = lightAt(co[0]! + (a === 0 ? s : 0), co[1]! + (a === 1 ? s : 0), co[2]! + (a === 2 ? s : 0));
            // Ambient occlusion of the 4 corners of the face, from the cells around the front cell.
            for (let k = 0; k < 4; k++) {
              const du = CORNERS[k]![0] ? 1 : -1, dv = CORNERS[k]![1] ? 1 : -1;
              const s1 = solidAt(front + du * stride[pu]), s2 = solidAt(front + dv * stride[pv]);
              const cc = solidAt(front + du * stride[pu] + dv * stride[pv]);
              ao[k] = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
            }
            let flags = info.flags | (blockLight[front]! << 6);
            if (id === B.grass && face !== 2) flags &= ~FLAG.tintMask; // only the top of a grass block is tinted
            const layer = info.faces[face]!;
            mask[v * nu + u] = layer | (ao[0]! | (ao[1]! << 2) | (ao[2]! << 4) | (ao[3]! << 6)) << 8 | light << 16 | flags << 19 | 1 << 26 | (id === B.water ? 1 << 27 : 0);
            any = true;
          }
        }
        if (!any) continue;
        for (let v = vLo; v <= vHi; v++) {
          for (let u = 1; u < nu - 1; u++) {
            const key = mask[v * nu + u]!;
            if (key === 0) continue;
            const aoBits = (key >> 8) & 255;
            const flat = aoBits % 85 === 0; // all four corners equal: the quad can grow
            let w = 1, h = 1;
            if (flat) {
              while (u + w < nu - 1 && mask[v * nu + u + w] === key) w++;
              grow: for (;;) {
                if (v + h > vHi) break;
                for (let t = 0; t < w; t++) if (mask[(v + h) * nu + u + t] !== key) break grow;
                h++;
              }
            }
            for (let dv = 0; dv < h; dv++) for (let du = 0; du < w; du++) mask[(v + dv) * nu + u + du] = 0;

            const layer = key & 255, light = (key >> 16) & 7, flags = (key >> 19) & 127;
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
              pk[k] = q + PACK.ao * ((aoBits >> (2 * k)) & 3) + PACK.light * light + PACK.flags * flags;
            }
            const a0 = aoBits & 3, a1 = (aoBits >> 2) & 3, a2 = (aoBits >> 4) & 3, a3 = (aoBits >> 6) & 3;
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
    for (let z = 1; z < sz - 1; z++) {
      for (let x = 1; x < sx - 1; x++) {
        const id = data[x + sx * (z + sz * y)]!;
        if (id === 0) continue;
        const info = BLOCKS[id];
        if (!info || info.shape === Shape.Cube || info.shape === Shape.None) continue;
        const light = lightAt(x, y, z);
        const wx = origin[0] + x, wy = origin[1] + y, wz = origin[2] + z;
        const layer = info.faces[2]!;
        const base = 3 * PACK.ao + PACK.light * light + PACK.flags * info.flags;
        const all = (face: number) => [base + face, base + face, base + face, base + face];
        switch (info.shape) {
          case Shape.Cross: {
            const sides = [[wx, wz, wx + 1, wz + 1], [wx + 1, wz, wx, wz + 1]] as const;
            for (const [ax, az, bx, bz] of sides) {
              cross.quad([ax, wy, az, bx, wy, bz, bx, wy + 1, bz, ax, wy + 1, az], [0, 0, 1, 0, 1, 1, 0, 1], layer, all(2), false, false);
            }
            break;
          }
          case Shape.Rail:
            cross.quad([wx, wy + 0.06, wz, wx + 1, wy + 0.06, wz, wx + 1, wy + 0.06, wz + 1, wx, wy + 0.06, wz + 1], [0, 0, 1, 0, 1, 1, 0, 1], layer, all(2), false, false);
            break;
          case Shape.Pane:
            cross.quad([wx, wy, wz + 0.5, wx + 1, wy, wz + 0.5, wx + 1, wy + 1, wz + 0.5, wx, wy + 1, wz + 0.5], [0, 0, 1, 0, 1, 1, 0, 1], layer, all(4), false, false);
            break;
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
