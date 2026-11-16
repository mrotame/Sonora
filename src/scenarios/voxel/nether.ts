// Voxel Dreamscape: the Nether (pure, no Three.js, no DOM). A cave with a netherrack ceiling and walls, a sea of lava, and
// a fortress-style nether-brick bridge carrying the rails, all built relative to the rail height at each row, so the
// whole cave descends with the minecart. Also the obsidian portals that join the two dimensions.
import { B } from './blocks.ts';
import type { Volume } from './mesher.ts';
import { hash01, perlin2, perlin3 } from './noise.ts';
import { deckLayer, ROAD } from './road.ts';
import type { TerrainSalts } from './terrain.ts';

export const NETHER = {
  /** Half-width of the generated cave (blocks); solid rock beyond. */
  halfWidth: 40,
  /** Vertical size of a segment volume and the room under / over the mid deck height. */
  sizeY: 112,
  below: 56,
  /** Heights relative to the deck: lava surface, ceiling, clear corridor above the deck. */
  lavaRel: -9,
  ceilingRel: 24,
  corridor: 9,
  /** Spacing of the bridge pillars and of the powered rails (blocks). */
  pillarSpacing: 8,
  poweredSpacing: 7,
} as const;

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

/** Nether volume of the rows [startRow, startRow + length) whose deck layer is `deckAt(bd)` (null = not in the Nether). */
export function buildNetherVolume(t: TerrainSalts, startRow: number, length: number, deckOffsetAt: (bd: number) => number | null, portals: { bd: number; offset: number }[]): Volume | null {
  let mid = 0, rows = 0;
  for (let bd = startRow; bd < startRow + length; bd++) {
    const o = deckOffsetAt(bd);
    if (o !== null) { mid += o; rows++; }
  }
  if (rows === 0) return null;
  const half = NETHER.halfWidth;
  const sx = 2 * half + 3, sz = length + 2, sy = NETHER.sizeY;
  const ox = -half - 1, oz = -(startRow + length) - 1;
  const midLayer = deckLayer(mid / rows); // mean over the rows that are in the Nether (a segment can straddle a portal)
  const oy = midLayer - NETHER.below;
  const data = new Uint8Array(sx * sy * sz);
  const rowOf = (bd: number) => startRow + length - bd;
  const idx = (x: number, y: number, z: number) => x + sx * (z + sz * y);
  const salt = t.deco + 991;

  for (let z = 0; z < sz; z++) {
    const bd = startRow + length - z;
    const offset = deckOffsetAt(bd);
    if (offset === null) continue;
    const dl = deckLayer(offset);
    const lava = dl + NETHER.lavaRel;
    for (let x = 0; x < sx; x++) {
      const bx = ox + x;
      const ax = Math.abs(bx);
      // Cave profile: walls wander, the ceiling and the rock floor undulate.
      const wall = 17 + 8 * perlin2(salt, bd / 38, bx > 0 ? 3.1 : 8.7) + 4 * perlin2(salt + 1, bd / 11, bx > 0 ? 0.7 : 5.2);
      const ceiling = dl + NETHER.ceilingRel + 5 * perlin2(salt + 2, bx / 20, bd / 20);
      const floor = lava - 7 + 9 * perlin2(salt + 3, bx / 14, bd / 14) + 3 * perlin2(salt + 4, bx / 5, bd / 5);
      for (let y = 0; y < sy; y++) {
        const wy = oy + y;
        let id: number = B.air;
        if (ax >= wall || wy >= ceiling || wy < floor - 2 || wy < dl - 38) {
          id = B.netherrack;
        } else if (ax > 7 && wy > lava + 2 && wy < ceiling - 2) {
          // Pillars, ledges and stalactites from 3D noise.
          const n = perlin3(salt + 5, bx / 9, wy / 7, bd / 9);
          if (n > 0.5 + 0.12 * (1 - Math.min(1, (ax - 7) / 8))) id = B.netherrack;
        }
        if (id === B.air && wy < floor) id = B.netherrack;
        if (id === B.air && wy <= lava) id = B.lava;
        if (id === B.netherrack) {
          if (wy >= ceiling - 1 && hash01(salt + 6, bx, wy >> 1, bd) < 0.004) id = B.glowstone;
          else if (hash01(salt + 7, bx, wy, bd) < 0.012) id = B.quartzOre;
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

  // Soul sand and magma on the rock floor tops under the lava level; soul sand patches above it.
  for (let z = 1; z < sz - 1; z++) {
    const bd = startRow + length - z;
    const offset = deckOffsetAt(bd);
    if (offset === null) continue;
    const dl = deckLayer(offset);
    for (let x = 1; x < sx - 1; x++) {
      const bx = ox + x;
      for (let y = sy - 2; y >= 1; y--) {
        const id = data[idx(x, y, z)]!;
        if (id !== B.netherrack) continue;
        const above = data[idx(x, y + 1, z)]!;
        if (above === B.air || above === B.lava) {
          const r = hash01(salt + 8, bx, y, bd);
          const p = perlin2(salt + 9, bx / 6, bd / 6);
          if (above === B.air && p > 0.25) data[idx(x, y, z)] = B.soulSand;
          else if (above === B.lava && r < 0.16) data[idx(x, y, z)] = B.magma;
        }
        if (above === B.air || above === B.lava) break;
      }
    }
    void dl;
  }

  // The bridge: nether-brick deck, fences, rails, pillars; a clear corridor above it.
  for (let bd = startRow - 1; bd <= startRow + length; bd++) {
    const offset = deckOffsetAt(bd);
    if (offset === null) continue;
    const dl = deckLayer(offset);
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
    // Glowstone lanterns hang from the ceiling above the corridor from time to time.
    if (((bd % 16) + 16) % 16 === 0) for (const s of [-1, 1]) {
      const y = dl + NETHER.corridor + 1;
      set(s * 3, y, bd, B.glowstone);
      set(s * 3, y - 1, bd, B.netherFence);
    }
  }
  for (const { bd, offset } of portals) placePortal(set, deckLayer(offset), bd);
  void ROAD;
  return { data, sx, sy, sz, ox, oy, oz: oz };
}
