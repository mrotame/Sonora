// Voxel Dreamscape: block volume of one segment of the overworld (pure, no Three.js, no DOM). Combines the natural
// terrain, the road (cut, embankment, bridges, tunnels, light posts) and the decoration (trees, plants). The volume
// covers the segment's rows plus one padding row on each side and one padding column on each side, generated from the
// same pure functions as the neighbours, so faces at the seams are culled exactly as inside a segment.
// Coordinates: block column bx (block covers x in [bx, bx + 1] in the mesher; the scene shifts the meshes by -0.5 so
// the road, bx in -1..1, is centred on x = 0), block row bd along the travel axis (scene z = -bd - 1 .. -bd), layer y.
import { B } from './blocks.ts';
import type { Volume } from './mesher.ts';
import { deckLayer, profileAt, ROAD, RoadKind } from './road.ts';
import { columnAt, naturalBlock, TERRAIN, type Column, type TerrainSalts } from './terrain.ts';
import { hash01, perlin2 } from './noise.ts';
import { ISLANDS, clusterAt, islandOf, type Cluster, type IslandContext } from './islands.ts';

/** Vertical extent of the volume (layer of index 0, and number of layers). */
export const VOLUME_Y = { origin: -12, size: 72 } as const;
/** Tree blocks stick out of their trunk's row by at most this many rows; the surface grid covers them. */
const REACH = 4;

interface Surface {
  /** First free layer above the solid ground, after the road has cut or filled it. */
  h: Int16Array;
  col: (Column | null)[];
  rows: number;
  cols: number;
  firstRow: number;
}

/** Terrain column with the road applied: flat road bed near the road, bounded slopes farther out. */
function roadColumn(t: TerrainSalts, bx: number, bd: number): Column {
  const col = columnAt(t, bx, bd);
  const { kind, offset } = profileAt(t, bd);
  if (kind === RoadKind.Tunnel) return col;
  const ax = Math.abs(bx);
  if (ax > 40 || col.h <= TERRAIN.seaY) return col; // open water and far terrain stay natural
  const dl = deckLayer(offset);
  const lo = dl - Math.max(0, ax - ROAD.clearHalf); // embankment: the ground is raised up to this
  const hi = dl + ROAD.clearHeight + Math.max(0, ax - ROAD.clearHalf) * ROAD.cutSlope; // cut: removed above this
  const h = ax <= ROAD.clearHalf ? dl : Math.min(hi, Math.max(lo, col.h));
  return h === col.h ? col : { h, river: 0, mountain: 0 };
}

export interface IslandVolume {
  cluster: Cluster;
  volume: Volume;
}

export function buildVolume(t: TerrainSalts, startRow: number, length: number, islands?: IslandContext): { volume: Volume; surface: Surface; islandVolumes: IslandVolume[] } {
  const half = TERRAIN.halfWidth;
  const sx = 2 * half + 1 + 2, sz = length + 2, sy = VOLUME_Y.size;
  const ox = -half - 1, oz = -(startRow + length) - 1, oy = VOLUME_Y.origin;
  const data = new Uint8Array(sx * sy * sz);
  const rowOf = (bd: number) => startRow + length - bd; // volume z index of block row bd (padding at 0 and length + 1)
  const idx = (x: number, y: number, z: number) => x + sx * (z + sz * y);

  // Surface grid: segment rows, padding and the rows trees can reach.
  const firstRow = startRow - 1 - REACH, rows = length + 2 + 2 * REACH;
  const cols = sx;
  const surface: Surface = { h: new Int16Array(rows * cols), col: new Array<Column | null>(rows * cols).fill(null), rows, cols, firstRow };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const col = roadColumn(t, ox + c, firstRow + r);
      surface.col[r * cols + c] = col;
      surface.h[r * cols + c] = col.h;
    }
  }
  const surfaceAt = (bx: number, bd: number) => surface.h[(bd - firstRow) * cols + (bx - ox)]!;

  // Natural ground, water, then the road on top.
  for (let z = 0; z < sz; z++) {
    const bd = startRow + length - z;
    const r = bd - firstRow;
    for (let x = 0; x < sx; x++) {
      const bx = ox + x;
      const col = surface.col[r * cols + x]!;
      const reach = Math.min(sy - 1, col.mountain > 0.15 ? sy - 1 : Math.max(col.h, TERRAIN.seaY) - oy + 6);
      for (let y = 0; y <= reach; y++) {
        const wy = oy + y;
        let id = y === 0 ? B.stone : naturalBlock(t, col, bx, wy, bd);
        if (id === B.air && wy < TERRAIN.seaY) id = B.water;
        data[idx(x, y, z)] = id;
      }
    }
  }

  const set = (bx: number, y: number, bd: number, id: number, onlyAir = false) => {
    const x = bx - ox, z = rowOf(bd), yy = y - oy;
    if (x < 0 || x >= sx || z < 0 || z >= sz || yy < 0 || yy >= sy) return;
    const i = idx(x, yy, z);
    if (onlyAir && data[i] !== B.air) return;
    data[i] = id;
  };
  const get = (bx: number, y: number, bd: number) => {
    const x = bx - ox, z = rowOf(bd), yy = y - oy;
    if (x < 0 || x >= sx || z < 0 || z >= sz || yy < 0 || yy >= sy) return B.stone;
    return data[idx(x, yy, z)]!;
  };

  // Road.
  for (let bd = startRow - 1; bd <= startRow + length; bd++) {
    const { kind, offset } = profileAt(t, bd);
    const dl = deckLayer(offset);
    const span = kind === RoadKind.Bridge || kind === RoadKind.Causeway;
    // Clear corridor.
    const top = kind === RoadKind.Tunnel ? dl + 4 : dl + ROAD.clearHeight;
    const wide = kind === RoadKind.Tunnel ? ROAD.tunnelHalf : ROAD.clearHalf;
    for (let bx = -wide; bx <= wide; bx++) for (let y = dl + 1; y <= top; y++) set(bx, y, bd, B.air);
    if (kind === RoadKind.Tunnel) {
      // Stone lining (the natural rock mostly is), with glowstone in the ceiling every 12 rows.
      for (let bx = -wide - 1; bx <= wide + 1; bx++) for (let y = dl; y <= top + 1; y++) {
        const inside = Math.abs(bx) <= wide && y > dl && y <= top;
        if (!inside && get(bx, y, bd) === B.air) set(bx, y, bd, B.stone);
      }
      if (((bd % 12) + 12) % 12 === 0) { set(-ROAD.tunnelHalf, top, bd, B.glowstone); set(ROAD.tunnelHalf, top, bd, B.glowstone); }
    }
    if (span) {
      for (let bx = -ROAD.planksHalf; bx <= ROAD.planksHalf; bx++) set(bx, dl, bd, B.oakPlanks);
      for (const s of [-1, 1]) {
        set(s * ROAD.deckHalf, dl, bd, B.cobblestone);
        set(s * ROAD.deckHalf, dl + 1, bd, B.oakFence);
        // Arch rib under the beam, and pillars at the ends of the span and at regular intervals.
        set(s * ROAD.deckHalf, dl - 1, bd, B.cobblestone, true);
        const edge = profileAt(t, bd - 1).kind !== kind || profileAt(t, bd + 1).kind !== kind || ((bd % ROAD.pillarSpacing) + ROAD.pillarSpacing) % ROAD.pillarSpacing === 0;
        if (edge || kind === RoadKind.Causeway) {
          if (kind === RoadKind.Bridge || ((bd % ROAD.pillarSpacing) + ROAD.pillarSpacing) % ROAD.pillarSpacing === 0) {
            for (let y = dl - 1; y >= oy + 1; y--) {
              const cur = get(s * ROAD.deckHalf, y, bd);
              if (cur !== B.air && cur !== B.water) break;
              set(s * ROAD.deckHalf, y, bd, B.cobblestone);
            }
          }
        }
      }
      // Under the deck near the banks the earth is kept up to the planks (no gap under the ramp).
    } else {
      for (let bx = -ROAD.halfWidth; bx <= ROAD.halfWidth; bx++) set(bx, dl, bd, B.cobblestone);
      // Light posts: a fence post, a one-block arm toward the road and a glowstone hanging under it.
      const k = Math.floor(bd / ROAD.postSpacing);
      if (bd === k * ROAD.postSpacing && kind === RoadKind.Land) {
        const s = k % 2 === 0 ? 1 : -1;
        const px = s * ROAD.postX;
        set(px, dl, bd, B.cobblestone);
        for (let y = dl + 1; y <= dl + ROAD.postHeight; y++) set(px, y, bd, B.oakFence);
        set(px - s, dl + ROAD.postHeight, bd, B.oakFence);
        set(px - s, dl + ROAD.postHeight - 1, bd, B.glowstone);
      }
    }
  }

  decorate(t, startRow, length, surface, surfaceAt, set, get);
  const volume: Volume = { data, sx, sy, sz, ox, oy, oz };
  return { volume, surface, islandVolumes: islands ? splitIslands(t, volume, surface, startRow, length, islands) : [] };
}

type Set = (bx: number, y: number, bd: number, id: number, onlyAir?: boolean) => void;
type Get = (bx: number, y: number, bd: number) => number;

/** Trees and plants. Each belongs to its own column, so the segments around it agree on it. */
function decorate(t: TerrainSalts, startRow: number, length: number, surface: Surface, surfaceAt: (bx: number, bd: number) => number, set: Set, get: Get): void {
  const half = TERRAIN.halfWidth;
  for (let bd = startRow - REACH; bd < startRow + length + REACH; bd++) {
    const { kind } = profileAt(t, bd);
    for (let bx = -half; bx <= half; bx++) {
      const ax = Math.abs(bx);
      if (ax <= ROAD.clearHalf + 1 && kind !== RoadKind.Tunnel) continue; // road, kerbs and posts
      const col = surface.col[(bd - surface.firstRow) * surface.cols + (bx + half + 1)]!;
      const h = col.h;
      if (h <= TERRAIN.seaY || h >= 52 || col.river > 0) continue;
      const inside = bd >= startRow - 1 && bd <= startRow + length;
      const top = naturalTopBlock(t, col, bx, bd);
      const forest = perlin2(t.deco + 7, bx / 55, bd / 55);
      const r = hash01(t.deco, bx, bd, 1);
      // Trees keep their crowns (2 blocks, 4 for a big oak) off the road corridor and the light posts beside it.
      if (top === B.grass && ax >= ROAD.postX + 4 && kind !== RoadKind.Tunnel) {
        const density = forest > 0.2 ? 0.045 : forest > -0.15 ? 0.012 : 0.002;
        if (r < density) {
          // Do not plant a tree against another trunk or on a slope the road cut left steep.
          if (surfaceAt(bx + 1, bd) - h <= 2 && surfaceAt(bx - 1, bd) - h <= 2 && surfaceAt(bx, bd + 1) - h <= 2 && surfaceAt(bx, bd - 1) - h <= 2) {
            tree(t, bx, bd, h, forest, set, ax);
            continue;
          }
        }
      }
      if (!inside || ax <= ROAD.clearHalf + 1) continue;
      if (top === B.grass) {
        const g = hash01(t.deco, bx, bd, 2);
        const flowers = perlin2(t.deco + 13, bx / 18, bd / 18) > 0.35;
        if (flowers && g < 0.12) set(bx, h, bd, hash01(t.deco, bx, bd, 3) < 0.5 ? B.dandelion : B.poppy, true);
        else if (g < (forest > 0 ? 0.3 : 0.22)) set(bx, h, bd, B.shortGrass, true);
      } else if (top === B.sand && h <= TERRAIN.seaY + 2) {
        // Sugar cane on the sand or grass next to water.
        const wet = surfaceAt(bx + 1, bd) <= TERRAIN.seaY || surfaceAt(bx - 1, bd) <= TERRAIN.seaY || surfaceAt(bx, bd + 1) <= TERRAIN.seaY || surfaceAt(bx, bd - 1) <= TERRAIN.seaY;
        if (wet && h === TERRAIN.seaY + 1 && hash01(t.deco, bx, bd, 4) < 0.28) {
          const n = 1 + Math.floor(3 * hash01(t.deco, bx, bd, 5));
          for (let k = 0; k < n; k++) set(bx, h + k, bd, B.sugarCane, true);
        }
      }
      void get;
    }
  }
}

function naturalTopBlock(t: TerrainSalts, col: Column, bx: number, bd: number): number {
  return naturalBlock(t, col, bx, col.h - 1, bd);
}

/** Classic oak and birch (a trunk with two 5x5 leaf layers, a 3x3 layer and a plus on top) and a rare big oak. */
function tree(t: TerrainSalts, bx: number, bd: number, ground: number, forest: number, set: Set, ax: number): void {
  const r = (k: number) => hash01(t.deco, bx, bd, 20 + k);
  const kindRoll = r(0);
  const birch = forest > 0.3 ? kindRoll < 0.4 : kindRoll < 0.1;
  const big = !birch && kindRoll > 0.965 && ax >= ROAD.postX + 6;
  const log = birch ? B.birchLog : B.oakLog, leaf = birch ? B.birchLeaves : B.oakLeaves;
  const H = big ? 7 + Math.floor(3 * r(1)) : (birch ? 5 : 4) + Math.floor(3 * r(1));
  if (big) {
    for (let dy = -3; dy <= 2; dy++) {
      const rad = [2.4, 3.3, 3.5, 3.1, 2.3, 1.2][dy + 3]!;
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
        if (Math.hypot(dx, dz) < rad + 0.6 * (hash01(t.deco, bx + dx, bd + dz, 40 + dy) - 0.5)) set(bx + dx, ground + H + dy, bd + dz, leaf, true);
      }
    }
  } else {
    for (let dy = -2; dy <= 1; dy++) {
      const rad = dy <= -1 ? 2 : dy === 0 ? 1 : 1;
      for (let dx = -rad; dx <= rad; dx++) for (let dz = -rad; dz <= rad; dz++) {
        const corner = Math.abs(dx) === rad && Math.abs(dz) === rad;
        if (dy === 1 && corner) continue;
        if (corner && hash01(t.deco, bx + dx, bd + dz, 60 + dy) < 0.5) continue;
        set(bx + dx, ground + H + dy, bd + dz, leaf, true);
      }
    }
  }
  for (let y = 0; y < H + (big ? 1 : 0); y++) set(bx, ground + y, bd, log);
}

/**
 * Island pass: the top `thick` blocks of every column that belongs to a breaking cluster (with whatever grows on them)
 * move from the ground volume into a volume of their own, one per cluster, which the scene lifts. Where the ground below
 * the cut is under the sea level, the hole fills with water.
 */
function splitIslands(t: TerrainSalts, vol: Volume, surface: Surface, startRow: number, length: number, ctx: IslandContext): IslandVolume[] {
  const { data, sx, sy, sz, ox, oy } = vol;
  const found = new Map<number, IslandVolume>();
  for (let z = 0; z < sz; z++) {
    const bd = startRow + length - z;
    for (let x = 0; x < sx; x++) {
      const bx = ox + x;
      const m = islandOf(ctx, bx, bd);
      if (!m) continue;
      const h = surface.h[(bd - surface.firstRow) * surface.cols + x]!;
      if (h <= TERRAIN.seaY) continue;
      let target = found.get(m.cluster.id);
      if (!target) found.set(m.cluster.id, (target = { cluster: m.cluster, volume: { data: new Uint8Array(data.length), sx, sy, sz, ox: vol.ox, oy: vol.oy, oz: vol.oz } }));
      for (let y = Math.max(0, h - m.thick - oy); y < sy; y++) {
        const i = x + sx * (z + sz * y);
        const id = data[i]!;
        if (id === B.air || id === B.water) continue;
        target.volume.data[i] = id;
        data[i] = oy + y < TERRAIN.seaY ? B.water : B.air;
      }
    }
  }
  // Props at the cluster centres (ruined portal, amethyst), owned by the segment that contains the centre row.
  const C = ISLANDS.clusterSize;
  for (let j = Math.floor(startRow / C) - 1; j <= Math.floor((startRow + length) / C) + 1; j++) {
    for (let i = -Math.ceil(TERRAIN.halfWidth / C); i <= Math.ceil(TERRAIN.halfWidth / C); i++) {
      const c = clusterAt(ctx, i, j);
      if (c.altitude === 0 || c.cd < startRow || c.cd >= startRow + length) continue;
      const target = found.get(c.id);
      if (!target) continue;
      islandProps(t, target.volume, c, startRow, length, surface);
    }
  }
  return [...found.values()];
}

function islandProps(t: TerrainSalts, vol: Volume, c: Cluster, startRow: number, length: number, surface: Surface): void {
  const { data, sx, sy, sz, ox, oy } = vol;
  const rowOf = (bd: number) => startRow + length - bd;
  const topAt = (bx: number, bd: number): number => {
    const r = bd - surface.firstRow;
    return r < 0 || r >= surface.rows ? TERRAIN.seaY : surface.h[r * surface.cols + (bx - ox)]!;
  };
  const put = (bx: number, y: number, bd: number, id: number) => {
    const x = bx - ox, z = rowOf(bd), yy = y - oy;
    if (x < 0 || x >= sx || z < 1 || z >= sz - 1 || yy < 0 || yy >= sy) return;
    data[x + sx * (z + sz * yy)] = id;
  };
  const seedKey = c.id * 13;
  const r = (k: number) => hash01(t.deco + 4001, seedKey, k);
  const cx = Math.round(c.cx), cd = Math.round(c.cd);

  // Ruined portal: an obsidian frame facing the road (in the plane x = const), some blocks missing, some crying obsidian.
  if (r(0) < 0.3 + 0.4 * c.intensity) {
    const base = topAt(cx, cd);
    for (let dd = -2; dd <= 2; dd++) {
      for (let dy = 0; dy <= 6; dy++) {
        const edge = Math.abs(dd) === 2 || dy === 0 || dy === 6;
        const k = dd * 11 + dy;
        if (edge) {
          if (hash01(t.deco + 4002, seedKey, k) < 0.22) continue; // ruin
          put(cx, base + dy, cd + dd, hash01(t.deco + 4003, seedKey, k) < 0.3 ? B.cryingObsidian : B.obsidian);
        } else if (r(1) < 0.45) {
          put(cx, base + dy, cd + dd, B.portal); // still lit
        }
      }
    }
  }
  // Amethyst clusters: short crystal columns with a tip.
  if (r(2) < ISLANDS.amethystChance) {
    const n = 1 + Math.floor(3 * r(3));
    for (let k = 0; k < n; k++) {
      const a = 6.2831853 * r(10 + k);
      const rr = 3 + c.radius * 0.4 * r(20 + k);
      const bx = Math.round(c.cx + Math.cos(a) * rr), bd = Math.round(c.cd + Math.sin(a) * rr);
      if (bd < startRow || bd >= startRow + length) continue;
      const base = topAt(bx, bd);
      const h = 2 + Math.floor(4 * r(30 + k));
      for (let y = 0; y < h; y++) put(bx, base + y, bd, B.amethyst);
      for (const [dx, dd] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (r(40 + k * 4 + dx * 2 + dd) < 0.6) put(bx + dx, base, bd + dd, B.amethyst);
    }
  }
}
