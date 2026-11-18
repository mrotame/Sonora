// Voxel Dreamscape: the Nether (pure, no Three.js, no DOM). A cave with a netherrack ceiling and walls, a sea of lava, and
// a fortress-style nether-brick bridge carrying the rails, all built relative to the rail height at each row, so the
// whole cave descends with the minecart. Also the obsidian portals that join the two dimensions.
import { B } from './blocks.ts';
import type { Volume } from './mesher.ts';
import { hash01, lerp, perlin2, perlin3, smoothstep } from './noise.ts';
import { deckLayer, ROAD } from './road.ts';
import type { TerrainSalts } from './terrain.ts';

export const NETHER = {
  /** Half-width of the generated cavern (blocks); beyond it the rock closes in (a wall that fades in over the last 26). */
  halfWidth: 88,
  /** Heights relative to the deck. The lava sea sits 9 below it, as before (the rails ride 9 blocks over the lava). */
  lavaRel: -9,
  /**
   * Game coordinates of the Nether Wastes (data/minecraft/worldgen/noise_settings/nether.json, JAR 26.3): lava sea level
   * `seaNy` = 32 (sea_level), solid floor below ny 0 and roof above `topNy`. The game's roof is at 128; here it is 112
   * (PROPOSED approximation) to bound the volume of a segment. Relative height ry = ny - 41 (the sea is ry -9).
   */
  seaNy: 32,
  topNy: 112,
  /** Density lattice of the game (cell_size_xz 4, cell_size_y 8): terrain is blended trilinearly between its corners. */
  cellXZ: 4,
  cellY: 8,
  /** Clear corridor above the deck, spacing of the bridge pillars and of the powered rails (blocks). */
  corridor: 9,
  pillarSpacing: 8,
  poweredSpacing: 7,
  /**
   * Light posts on both sides of the bridge: a nether-brick bracket just outside the railing, a nether-brick fence column
   * on it, a one-block arm toward the rails and an always-lit redstone lamp under the arm, the overworld post's shape
   * (ROAD.postHeight tall). Their rows follow the beats (netherPosts.ts); without a path, every postSpacing rows.
   */
  postSpacing: 16,
  postX: 3,
  /**
   * Scenery that must always be in view (2026-11-18, user-requested: some moments showed no lava or glowstone). A lava
   * fall starts at one roof column in `1 / lavaFallDensity`; a glowstone cluster hangs in one cell of `glowCell` blocks
   * with chance `glowKeep` (the cell is dropped when no roof is found). Measured on 3 worlds in `tests/voxel.test.ts`.
   * The cell was 18 until the glowstone started pulsing on the bass (2026-11-18, user-requested: more glowstone).
   * The fall density was 1 / 75 until 2026-11-18 (user-requested: too many falls). The falls are steady (no music).
   */
  lavaFallDensity: 1 / 150,
  glowCell: 12,
  glowKeep: 0.95,
  /**
   * Rows (blocks) the Nether keeps going past the exit portal, level at the rail height of the exit, so the view through
   * and around the portal shows the cavern up to the haze instead of ending at the frame. Longer than the Nether fog end
   * (scene.ts: FOG_RANGE end x NETHER_FOG_SCALE, 61 m by default, 72 m at the widest detailed volume) with a margin.
   */
  exitTail: 96,
} as const;

/** ny (game height) of a height relative to the deck. */
const NY0 = NETHER.seaNy - NETHER.lavaRel; // ny of the deck row: 41

type Set = (bx: number, y: number, bd: number, id: number, onlyAir?: boolean) => void;

/** Obsidian portal across the road: a 3 x 5 opening filled with the animated portal pane, in a 5 x 7 frame. */
export function placePortal(set: Set, dl: number, bd: number): void {
  for (let x = -2; x <= 2; x++) {
    for (let y = 0; y <= 6; y++) {
      const edge = Math.abs(x) === 2 || y === 0 || y === 6;
      if (edge) set(x, dl + y, bd, hash01(7, x, y, bd) < 0.18 ? B.cryingObsidian : B.obsidian);
      else set(x, dl + y, bd, B.portal);
    }
  }
}

/**
 * Density of the Nether Wastes at (x, ry, d), `ry` being the height above the rail deck (positive = solid). Follows the
 * game's final_density (noise_settings/nether.json, JAR 26.3): blended 3D noise, forced solid under ny 24 (2.5 at ny -8:
 * the floor) and toward the roof (0.9375 at the top). Only the noise itself is approximated (3 octaves of Perlin in place of
 * the game's old_blended_noise). On top: an open volume around the rail (so the road never runs in a tunnel) and the
 * cavern's side walls, which close in over the last 26 blocks.
 */
function density(salt: number, x: number, ry: number, d: number): number {
  const ny = ry + NY0;
  const n = 0.62 * perlin3(salt, x / 52, ry / 30, d / 52) + 0.3 * perlin3(salt + 1, x / 26, ry / 15, d / 26) + 0.16 * perlin3(salt + 2, x / 13, ry / 8, d / 13);
  const roof = Math.min(1, Math.max(0, (ny - (NETHER.topNy - 24)) / 24));
  const mid = lerp(n - 0.08, 0.9375, roof);
  const floor = Math.min(1, Math.max(0, (ny + 8) / 32));
  let v = lerp(2.5, mid, floor);
  const e = Math.hypot(x / 20, (ry - 8) / 19);
  v -= 1.7 * (1 - smoothstep(0.5, 1, e));
  v += 3 * smoothstep(NETHER.halfWidth - 26, NETHER.halfWidth - 2, Math.abs(x));
  return v;
}

/**
 * Deck layer of the bridge at row `bd` (null = not in the Nether). The rail height changes by at most one layer per row,
 * and a rail only ramps up toward one neighbour (mesher.ts, the block game's ascending rail), so a single-row pit (both
 * neighbours higher) could not connect on both sides: it is raised to the lower of its neighbours. Only reads the
 * neighbouring rows, so every segment agrees on the rows they share.
 */
export function railDeckLayer(deckOffsetAt: (bd: number) => number | null, bd: number): number | null {
  const o = deckOffsetAt(bd);
  if (o === null) return null;
  const dl = deckLayer(o);
  const a = deckOffsetAt(bd - 1), b = deckOffsetAt(bd + 1);
  if (a === null || b === null) return dl;
  const la = deckLayer(a), lb = deckLayer(b);
  return la > dl && lb > dl ? Math.min(la, lb) : dl;
}

/** Nether volume of the rows [startRow, startRow + length) whose deck layer is `deckAt(bd)` (null = not in the Nether). */
export function buildNetherVolume(t: TerrainSalts, coreStart: number, coreLength: number, deckOffsetAt: (bd: number) => number | null, portals: { bd: number; offset: number }[], margin = 0, postAt?: (bd: number) => boolean): Volume | null {
  // `margin` extra rows on each side carry only the light of the neighbours (see buildVolume).
  const startRow = coreStart - margin, length = coreLength + 2 * margin;
  let rows = 0, minDl = Infinity, maxDl = -Infinity;
  for (let bd = startRow - 1; bd <= startRow + length; bd++) {
    const o = deckOffsetAt(bd);
    if (o === null) continue;
    if (bd >= coreStart && bd < coreStart + coreLength) rows++;
    const dl = deckLayer(o);
    minDl = Math.min(minDl, dl);
    maxDl = Math.max(maxDl, dl);
  }
  if (rows === 0) return null;
  const half = NETHER.halfWidth;
  // The volume spans the game's whole height (ny 0..topNy) relative to the deck of every row, so it is as tall as the descent needs.
  const ryLo = -NY0 - 2, ryHi = NETHER.topNy - NY0 + 2;
  const sx = 2 * half + 3, sz = length + 2, sy = maxDl - minDl + (ryHi - ryLo) + 1;
  const ox = -half - 1, oz = -(startRow + length) - 1;
  const oy = minDl + ryLo;
  const data = new Uint8Array(sx * sy * sz);
  const rowOf = (bd: number) => startRow + length - bd;
  const idx = (x: number, y: number, z: number) => x + sx * (z + sz * y);
  const salt = t.deco + 991;

  // Density on the game's lattice (cells of 4 x 8 x 4 blocks), interpolated trilinearly like the game does.
  const CX = NETHER.cellXZ, CY = NETHER.cellY;
  const bdLo = startRow - 1, bdHi = startRow + length;
  const gx0 = Math.floor(ox / CX), gx1 = Math.floor((ox + sx - 1) / CX) + 1;
  const gd0 = Math.floor(bdLo / CX), gd1 = Math.floor(bdHi / CX) + 1;
  const gy0 = Math.floor(ryLo / CY) - 1, gy1 = Math.floor((ryHi + (maxDl - minDl)) / CY) + 2;
  const nGx = gx1 - gx0 + 1, nGd = gd1 - gd0 + 1, nGy = gy1 - gy0 + 1;
  const corners = new Float32Array(nGx * nGd * nGy);
  for (let i = 0; i < nGx; i++) for (let j = 0; j < nGd; j++) for (let k = 0; k < nGy; k++) {
    corners[(i * nGd + j) * nGy + k] = density(salt, (gx0 + i) * CX, (gy0 + k) * CY, (gd0 + j) * CX);
  }

  for (let z = 0; z < sz; z++) {
    const bd = startRow + length - z;
    const offset = deckOffsetAt(bd);
    if (offset === null) continue;
    const dl = deckLayer(offset);
    const j = Math.floor(bd / CX) - gd0, fd = bd / CX - Math.floor(bd / CX);
    for (let x = 0; x < sx; x++) {
      const bx = ox + x;
      const i = Math.floor(bx / CX) - gx0, fx = bx / CX - Math.floor(bx / CX);
      const c00 = (i * nGd + j) * nGy, c10 = ((i + 1) * nGd + j) * nGy, c01 = (i * nGd + j + 1) * nGy, c11 = ((i + 1) * nGd + j + 1) * nGy;
      const w00 = (1 - fx) * (1 - fd), w10 = fx * (1 - fd), w01 = (1 - fx) * fd, w11 = fx * fd;
      for (let y = 0; y < sy; y++) {
        const ry = oy + y - dl;
        const ny = ry + NY0;
        let id: number = B.air;
        if (ny < 0 || ny >= NETHER.topNy) id = B.netherrack; // the game's bedrock floor and roof (netherrack here)
        else {
          const k = Math.floor(ry / CY) - gy0, fy = ry / CY - Math.floor(ry / CY);
          let v = w00 * (corners[c00 + k]! * (1 - fy) + corners[c00 + k + 1]! * fy) + w10 * (corners[c10 + k]! * (1 - fy) + corners[c10 + k + 1]! * fy)
            + w01 * (corners[c01 + k]! * (1 - fy) + corners[c01 + k + 1]! * fy) + w11 * (corners[c11 + k]! * (1 - fy) + corners[c11 + k + 1]! * fy);
          if (Math.abs(v) < 0.14) v += 0.1 * perlin3(salt + 3, bx / 4, ry / 3.2, bd / 4); // block-scale roughness near the surface only
          if (v > 0) id = B.netherrack;
          else if (ry <= NETHER.lavaRel) id = B.lava;
        }
        data[idx(x, y, z)] = id;
      }
    }
  }

  const set: Set = (bx, y, bd, id, onlyAir = false) => {
    const x = bx - ox, z = rowOf(bd), yy = y - oy;
    if (x < 0 || x >= sx || z < 0 || z >= sz || yy < 0 || yy >= sy) return;
    const i = idx(x, yy, z);
    if (onlyAir && data[i] !== B.air) return;
    data[i] = id;
  };
  const at = (bx: number, y: number, bd: number) => {
    const x = bx - ox, z = rowOf(bd), yy = y - oy;
    return x < 0 || x >= sx || z < 0 || z >= sz || yy < 0 || yy >= sy ? B.netherrack : data[idx(x, yy, z)]!;
  };
  const dlOf = (z: number) => { const o = deckOffsetAt(startRow + length - z); return o === null ? null : deckLayer(o); };
  const layer = sx * sz;

  // Surface of the rock, from the base terrain only: magma in the band the game gives it (ny 27..36, ore_magma) where rock
  // meets the lava, gravel in blobs (ore_gravel_nether, ny 5..41), a little soul sand on floors above the lava, quartz ore.
  for (let z = 1; z < sz - 1; z++) {
    const dl = dlOf(z);
    if (dl === null) continue;
    const bd = startRow + length - z;
    for (let x = 1; x < sx - 1; x++) {
      const bx = ox + x;
      for (let y = 1; y < sy - 1; y++) {
        const i = idx(x, y, z);
        if (data[i] !== B.netherrack) continue;
        const ry = oy + y - dl, ny = ry + NY0;
        const up = data[i + layer]!;
        const exposed = up === B.air || up === B.lava || data[i - layer] === B.air || data[i - 1] === B.air || data[i + 1] === B.air || data[i - sx] === B.air || data[i + sx] === B.air;
        if (!exposed) { if (hash01(salt + 7, bx, ry, bd) < 0.012) data[i] = B.quartzOre; continue; }
        if (ny >= 27 && ny <= 36 && (up === B.lava || up === B.air) && perlin2(salt + 8, bx / 5, bd / 5) > 0.12 + 0.35 * hash01(salt + 12, bx, ry, bd)) data[i] = B.magma;
        else if (ny >= 5 && ny <= 41 && perlin3(salt + 10, bx / 7, ry / 5, bd / 7) > 0.5) data[i] = B.gravel;
        else if (up === B.air && ny > 33 && perlin2(salt + 9, bx / 6, bd / 6) > 0.58) data[i] = B.soulSand;
        else if (hash01(salt + 7, bx, ry, bd) < 0.008) data[i] = B.quartzOre;
      }
    }
  }
  const rockLike = (id: number) => id === B.netherrack || id === B.gravel || id === B.magma || id === B.soulSand;

  // Lava pools in basins at every height: the top of a floor whose four side neighbours are rock, where a patch noise says so.
  for (let z = 1; z < sz - 1; z++) {
    const dl = dlOf(z);
    if (dl === null) continue;
    const bd = startRow + length - z;
    for (let x = 1; x < sx - 1; x++) {
      const bx = ox + x;
      if (Math.abs(bx) < 7 || perlin2(salt + 14, bx / 14, bd / 14) < 0.22) continue;
      for (let y = 1; y < sy - 2; y++) {
        const i = idx(x, y, z);
        if (!rockLike(data[i]!) || data[i + layer] !== B.air) continue;
        const ny = oy + y - dl + NY0;
        if (ny <= NETHER.seaNy || ny > 100) continue;
        if (data[i - 1] === B.air || data[i + 1] === B.air || data[i - sx] === B.air || data[i + sx] === B.air) continue;
        data[i] = B.lava;
      }
    }
  }

  // Lava falls: a source in the roof pours down a 1-block column until it meets rock or the sea.
  for (let z = 1; z < sz - 1; z++) {
    const dl = dlOf(z);
    if (dl === null) continue;
    const bd = startRow + length - z;
    for (let x = 1; x < sx - 1; x++) {
      const bx = ox + x;
      if (Math.abs(bx) < 8 || hash01(salt + 20, bx, bd) > NETHER.lavaFallDensity) continue;
      let y = dl + 14 + Math.floor(hash01(salt + 21, bx, bd) * 44) - oy;
      if (y < 1 || y >= sy - 2 || data[idx(x, y, z)] !== B.air) continue;
      while (y < sy - 2 && data[idx(x, y, z)] === B.air) y++;
      if (!rockLike(data[idx(x, y, z)]!)) continue;
      // Its own block (the same lava, steady like the sea and the pools).
      data[idx(x, y, z)] = B.lavaFall;
      for (let k = y - 1, n = 0; k > 0 && n < 90 && data[idx(x, k, z)] === B.air; k--, n++) data[idx(x, k, z)] = B.lavaFall;
    }
  }

  // Glowstone clusters hanging from roofs: one anchor per NETHER.glowCell cell (jittered, so clusters never overlap), under the
  // ceiling found by scanning up from a random height. Each is an irregular ellipsoid that only holds where the layer
  // above it holds (a hanging growth, not floating blocks).
  const CELL = NETHER.glowCell;
  const cx0 = Math.floor(ox / CELL) - 1, cx1 = Math.floor((ox + sx) / CELL) + 1;
  const cd0 = Math.floor(bdLo / CELL) - 1, cd1 = Math.floor(bdHi / CELL) + 1;
  const jitter = CELL - 8; // anchors stay 4 blocks inside their cell, so two clusters are never closer than 8 blocks
  for (let gx = cx0; gx <= cx1; gx++) for (let gd = cd0; gd <= cd1; gd++) {
    if (hash01(salt + 30, gx, gd) > NETHER.glowKeep) continue;
    const ax = gx * CELL + 4 + Math.floor(hash01(salt + 31, gx, gd) * jitter), ad = gd * CELL + 4 + Math.floor(hash01(salt + 32, gx, gd) * jitter);
    const x = ax - ox, z = rowOf(ad);
    if (x < 1 || x >= sx - 1 || z < 1 || z >= sz - 1) continue;
    const dl = dlOf(z);
    if (dl === null) continue;
    let y = dl + 16 + Math.floor(hash01(salt + 33, gx, gd) * 46) - oy;
    if (y >= sy - 2 || data[idx(x, y, z)] !== B.air) continue;
    while (y < sy - 2 && data[idx(x, y, z)] === B.air) y++;
    if (!rockLike(data[idx(x, y, z)]!)) continue;
    const topY = y - 1; // first air layer under the roof
    const R = 2 + hash01(salt + 34, gx, gd) * 2.6, depth = R * (1 + 0.8 * hash01(salt + 35, gx, gd));
    if (Math.abs(ax) < 9 && topY + oy - dl - depth - 1 < NETHER.corridor + 3) continue; // never down into the clear corridor
    for (let dy = 0; dy <= depth + 1; dy++) {
      for (let dz = -Math.ceil(R); dz <= Math.ceil(R); dz++) for (let dx = -Math.ceil(R); dx <= Math.ceil(R); dx++) {
        const px = x + dx, pz = z + dz, py = topY - dy;
        if (px < 1 || px >= sx - 1 || pz < 1 || pz >= sz - 1 || py < 1) continue;
        const q = (dx * dx + dz * dz) / (R * R * (1 - 0.5 * dy / (depth + 1))) + (dy * dy) / (depth * depth);
        if (q > 0.9 + 0.5 * (hash01(salt + 36, ax + dx, py, ad + dz) - 0.5)) continue;
        const pi = idx(px, py, pz);
        if (data[pi] !== B.air) continue;
        const above = data[pi + layer]!;
        if (above === B.netherGlowstone || rockLike(above)) data[pi] = B.netherGlowstone; // pulses on the bass
      }
    }
  }

  // The bridge: nether-brick deck, fences, rails, pillars; a clear corridor above it.
  for (let bd = startRow - 1; bd <= startRow + length; bd++) {
    const dl = railDeckLayer(deckOffsetAt, bd);
    if (dl === null) continue;
    for (let bx = -3; bx <= 3; bx++) for (let y = dl + 1; y <= dl + NETHER.corridor; y++) set(bx, y, bd, B.air);
    for (let bx = -2; bx <= 2; bx++) set(bx, dl, bd, B.netherBricks);
    for (const s of [-1, 1]) {
      set(s * 2, dl + 1, bd, B.netherFence);
      const pillar = ((bd % NETHER.pillarSpacing) + NETHER.pillarSpacing) % NETHER.pillarSpacing === 0;
      if (pillar) for (let y = dl - 1; y > dl - 45; y--) {
        const cur = at(s * 2, y, bd);
        if (cur === B.netherrack || cur === B.soulSand || cur === B.magma) break;
        set(s * 2, y, bd, B.netherBricks);
      }
    }
    const powered = ((bd % NETHER.poweredSpacing) + NETHER.poweredSpacing) % NETHER.poweredSpacing === 0;
    set(0, dl + 1, bd, powered ? B.poweredRail : B.rail);
    // Light posts standing on the bridge (they used to hang in mid-air above the corridor, with nothing under them).
    const post = (postAt ? postAt(bd) : ((bd % NETHER.postSpacing) + NETHER.postSpacing) % NETHER.postSpacing === 0) && !portals.some((p) => Math.abs(p.bd - bd) <= 1);
    if (post) for (const s of [-1, 1]) {
      const px = s * NETHER.postX;
      set(px, dl, bd, B.netherBricks);
      for (let y = dl + 1; y <= dl + ROAD.postHeight; y++) set(px, y, bd, B.netherFence);
      set(px - s, dl + ROAD.postHeight, bd, B.netherFence);
      set(px - s, dl + ROAD.postHeight - 1, bd, B.redstoneLamp);
    }
  }
  for (const { bd, offset } of portals) placePortal(set, deckLayer(offset), bd);
  return { data, sx, sy, sz, ox, oy, oz, margin };
}
