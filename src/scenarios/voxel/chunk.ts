// Voxel Dreamscape: block volume of one segment of the overworld (pure, no Three.js, no DOM). Combines the natural
// terrain, the road (cut, embankment, bridges, tunnels, light posts) and the decoration (trees, plants). The volume
// covers the segment's rows plus one padding row on each side and one padding column on each side, generated from the
// same pure functions as the neighbours, so faces at the seams are culled exactly as inside a segment.
// Coordinates: block column bx (block covers x in [bx, bx + 1] in the mesher; the scene shifts the meshes by -0.5 so
// the road, bx in -1..1, is centred on x = 0), block row bd along the travel axis (scene z = -bd - 1 .. -bd), layer y.
import { B } from './blocks.ts';
import type { Volume } from './mesher.ts';
import { deckLayer, deckStairAt, profileAt, ROAD, RoadKind } from './road.ts';
import { baseColumnAt, cliffWeight, densityTop, groundBlock, naturalBlock, raiseCaveMountain, surfaceSlope, TERRAIN, type Column, type TerrainSalts } from './terrain.ts';
import { hash01, lerp, perlin2, perlin3, smoothstep } from './noise.ts';
import { caveRangeAt, caveWeight } from './caveMask.ts';

/**
 * Vertical extent of the volume: layer of index 0 and the minimum number of layers. A segment with taller mountains gets
 * a taller volume (the highest column plus `headroom`, for trees and the sky light above them), up to TERRAIN.topY.
 */
export const VOLUME_Y = { origin: -12, size: 72, headroom: 10 } as const;
/**
 * Cave sections: a wide cavern around the road inside the mountain raised over them (terrain.ts). Its half-width and
 * height wander along the road, its walls, floor and ceiling are rough with 3D noise; lava pools on the floor, glowstone
 * in the walls and ceiling, ores in the walls. The road corridor in the middle stays clear.
 */
export const CAVE = {
  halfWidth: [5, 12],
  height: [8, 15],
  /** Wall lamps (glowstone at eye height on both sides) every this many rows. */
  lampEvery: 10,
  /** Lava pools: noise threshold (higher = fewer) and minimum distance from the centre. */
  lava: 0.42,
  lavaFrom: 5,
  /** Lava (no fluid flow) only on a floor at most this many layers above the road's, with this many free layers above it. */
  lavaMaxRise: 3,
  lavaHeadroom: 3,
  /** Near its mouth and exit the cavern is lower (this share of its height), opening up over `mouthRows` rows. */
  mouthHeight: 0.6,
  mouthRows: 14,
} as const;

/**
 * Rows the surface grid holds beyond the volume's: tree blocks stick out of their trunk's row by at most 4 rows, and a
 * cliff column reads the heights of the columns up to TERRAIN.caveCliffWarp + 1 rows away (fillCliff, between two rows);
 * the grid covers all of them, so no value the volume reads comes from the clamped edge of the grid.
 */
const REACH = Math.max(4, TERRAIN.caveCliffWarp + 2);

interface Surface {
  /** First free layer above the solid ground, after the road has cut or filled it. */
  h: Int16Array;
  col: (Column | null)[];
  rows: number;
  cols: number;
  firstRow: number;
}

/**
 * Terrain column with the road applied: flat road bed near the road, bounded slopes farther out. The road cuts and fills
 * the natural land only; the mountain of a cave section is raised after it (terrain.ts `raiseCaveMountain`), so the cut
 * never slices that mountain into a flat trench ending in a plane wall at the cave mouth.
 */
function roadColumn(t: TerrainSalts, bx: number, bd: number): Column {
  const col = baseColumnAt(t, bx, bd);
  const { kind, offset } = profileAt(t, bd);
  if (kind === RoadKind.Cave) return raiseCaveMountain(t, bx, bd, col);
  const ax = Math.abs(bx);
  if (ax > ROAD.influence || col.h <= TERRAIN.seaY) return raiseCaveMountain(t, bx, bd, col); // open water and far terrain stay natural
  const dl = deckLayer(offset);
  // Embankment: the ground is raised up to this. Next to the road it is flush with the road surface (grass against the
  // cobblestone, no gutter) and steps down one block per block farther out.
  const lo = dl + 1 - Math.max(0, ax - ROAD.clearHalf - 1);
  // Cut: near the road the ground never rises above the road surface (dl + 1); farther out it may climb back toward the
  // natural height. The flat width and the climb vary with noise on each side and along the road, with a rough edge, so
  // the cut through a slope is not a straight, symmetric staircase (scenario version 8, user-requested).
  const side = bx > 0 ? 0.37 : 5.71;
  const flat = ROAD.flatHalf + 7 * (0.5 + 0.5 * perlin2(t.detail + 61, side, bd / 53));
  const climb = ROAD.cutSlope * lerp(0.55, 2, 0.5 + 0.5 * perlin2(t.detail + 67, side + 2.3, bd / 41));
  const rough = 3 * perlin2(t.detail + 71, bx / 6, bd / 6);
  const hi = dl + 1 + Math.max(0, Math.max(0, ax - flat) * climb + (ax > flat ? rough : 0));
  // The road blocks themselves (|bx| <= halfWidth) fill layer dl; the kerb columns beside them are grass at the same level.
  const h = ax <= ROAD.halfWidth ? dl : ax <= ROAD.clearHalf ? dl + 1 : Math.min(hi, Math.max(lo, col.h));
  return raiseCaveMountain(t, bx, bd, h === col.h ? col : { h, river: 0, mountain: 0 });
}

/**
 * Volume of the rows [coreStart, coreStart + coreLength). With `margin` > 0 it also holds `margin` more rows on each side:
 * the mesher skips them (Volume.margin); they only let the light of the neighbouring segments reach this one (light.ts).
 */
export function buildVolume(t: TerrainSalts, coreStart: number, coreLength: number, margin = 0): { volume: Volume; surface: Surface } {
  const startRow = coreStart - margin, length = coreLength + 2 * margin;
  const half = TERRAIN.halfWidth;
  const sx = 2 * half + 1 + 2, sz = length + 2;
  const ox = -half - 1, oz = -(startRow + length) - 1, oy = VOLUME_Y.origin;
  const rowOf = (bd: number) => startRow + length - bd; // volume z index of block row bd (padding at 0 and length + 1)
  const idx = (x: number, y: number, z: number) => x + sx * (z + sz * y);

  // Surface grid: segment rows, padding and the rows trees can reach.
  const firstRow = startRow - 1 - REACH, rows = length + 2 + 2 * REACH;
  const cols = sx;
  const surface: Surface = { h: new Int16Array(rows * cols), col: new Array<Column | null>(rows * cols).fill(null), rows, cols, firstRow };
  let highest = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const col = roadColumn(t, ox + c, firstRow + r);
      surface.col[r * cols + c] = col;
      surface.h[r * cols + c] = col.h;
      highest = Math.max(highest, col.h);
    }
  }
  // Slope of every column, for the surface rules (grass, scree, bare rock, snow). Measured over two blocks on each side,
  // so a slope reads the same whatever its staircase looks like; the grid holds REACH rows beyond the volume's, so every
  // row of the volume (padding included) has its neighbours and both sides of a seam agree.
  const hAt = (r: number, c: number) => surface.h[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))]!;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = hAt(r, c);
      const step = Math.max(Math.abs(h - hAt(r, c - 1)), Math.abs(h - hAt(r, c + 1)), Math.abs(h - hAt(r - 1, c)), Math.abs(h - hAt(r + 1, c)));
      const cl = Math.max(0, c - 2), cr = Math.min(cols - 1, c + 2), rl = Math.max(0, r - 2), rr = Math.min(rows - 1, r + 2);
      const s = surfaceSlope((hAt(r, cr) - hAt(r, cl)) / Math.max(1, cr - cl), (hAt(rr, c) - hAt(rl, c)) / Math.max(1, rr - rl), step);
      if (s > 0) surface.col[r * cols + c]!.steep = s;
    }
  }
  const sy = Math.max(VOLUME_Y.size, Math.min(TERRAIN.topY + VOLUME_Y.headroom, highest + 12 + VOLUME_Y.headroom) - oy);
  const data = new Uint8Array(sx * sy * sz);
  const surfaceAt = (bx: number, bd: number) => surface.h[(bd - firstRow) * cols + (bx - ox)]!;

  // Natural ground, water, then the road on top.
  for (let z = 0; z < sz; z++) {
    const bd = startRow + length - z;
    const r = bd - firstRow;
    const caveRow = profileAt(t, bd).kind === RoadKind.Cave;
    const nearCave = caveRow || caveWeight(t.caves, bd) > 0;
    for (let x = 0; x < sx; x++) {
      const bx = ox + x;
      const col = surface.col[r * cols + x]!;
      const k = cliffWeight(col, bx, nearCave);
      if (k > 0) {
        // The wider shift only on the face over the cave mouth (near the road), not on every cliff of these rows.
        const W = nearCave ? lerp(TERRAIN.caveCliffWarp, TERRAIN.cliffWarp, smoothstep(TERRAIN.caveBrowHalf[0], TERRAIN.caveBrowHalf[1], Math.abs(bx))) : TERRAIN.cliffWarp;
        fillCliff(t, surface, col, k, W, bx, bd, x, r, (y, id) => (data[idx(x, y, z)] = id), sy, caveRow);
        continue;
      }
      // The overhangs move the surface by at most 3 layers, so nothing solid lies higher than this.
      const reach = Math.min(sy - 1, Math.max(col.h, TERRAIN.seaY) - oy + 6);
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
    if (kind === RoadKind.Cave) carveCave(t, bd, dl, set, get);
    // Clear corridor.
    for (let bx = -ROAD.clearHalf; bx <= ROAD.clearHalf; bx++) for (let y = dl + 1; y <= dl + ROAD.clearHeight; y++) set(bx, y, bd, B.air);
    if (span) {
      // Where the deck climbs or falls a layer, the planks become oak stairs (high half toward the higher row), so the
      // step is two half-blocks instead of one full-block jump (scenario version 35, user-requested).
      const stair = deckStairAt(deckLayer(profileAt(t, bd - 1).offset), dl, deckLayer(profileAt(t, bd + 1).offset));
      for (let bx = -ROAD.planksHalf; bx <= ROAD.planksHalf; bx++) set(bx, dl, bd, stair ?? B.oakPlanks);
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
  const volume: Volume = { data, sx, sy, sz, ox, oy, oz, margin };
  return { volume, surface };
}

/**
 * One steep mountain column (a cliff), weight k > 0 (terrain.ts `cliffWeight`). Layer by layer it is solid where the
 * layer is under the surface at a nearby point: the column's position shifted by smooth 3D noise of up to W blocks, the
 * height there read bilinearly from the surface grid (the same terrain, displaced horizontally a little differently at
 * every height), so the cliff gets ledges, bays and overhangs instead of a flat wall.
 *
 * Scenario version 18 (user-reported: mountains like towers and planets, full of holes, slits and loose blocks): a shift
 * of W blocks on a slope s moves the face by W x s layers, and the shift used to jump by whole blocks from one layer to
 * the next on the steepest faces, so the column switched between rock and air at random layers. Now the shift is also
 * at most TERRAIN.cliffRise / s blocks (the face moves at most cliffRise layers, whatever the slope), the noise changes
 * slowly with the height (TERRAIN.cliffScale) and is not rounded, and the column is filled run by run: soil, grass and
 * snow lie only on the top block of each solid run (exposed to the sky above it), never inside the face.
 *
 * The shift is a pure function of the block position and the grid holds the rows it reaches (REACH), so the segments on
 * both sides of a seam agree. Below the lowest surface around, the column's own rock is kept (nothing to displace).
 */
function fillCliff(t: TerrainSalts, surface: Surface, col: Column, k: number, W: number, bx: number, bd: number, x: number, r: number, put: (y: number, id: number) => void, sy: number, caveRow: boolean): void {
  const oy = VOLUME_Y.origin;
  const hGrid = (rr: number, cc: number) => surface.h[Math.min(surface.rows - 1, Math.max(0, rr)) * surface.cols + Math.min(surface.cols - 1, Math.max(0, cc))]!;
  /** Surface height at a fractional offset (columns, rows) from this column, bilinear between the four grid columns. */
  const hAt = (fx: number, fd: number) => {
    const c0 = Math.floor(fx), r0 = Math.floor(fd), u = fx - c0, v = fd - r0;
    const a = hGrid(r + r0, x + c0), b = hGrid(r + r0, x + c0 + 1), c = hGrid(r + r0 + 1, x + c0), e = hGrid(r + r0 + 1, x + c0 + 1);
    return (a + (b - a) * u) * (1 - v) + (c + (e - c) * u) * v;
  };
  // Over the open road next to a cave mouth nothing may overhang the road: there the column keeps its own surface.
  const amp = !caveRow && Math.abs(bx) <= ROAD.clearHalf + 1 ? 0 : Math.min(W, TERRAIN.cliffRise / Math.max(1, col.steep ?? 0)) * k;
  let lo = col.h, hi = col.h;
  const reachW = Math.ceil(amp) + 1;
  for (let dr = -reachW; dr <= reachW; dr++) for (let dc = -reachW; dc <= reachW; dc++) {
    const h = hGrid(r + dr, x + dc);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  const reach = Math.min(sy - 1, Math.max(hi, TERRAIN.seaY) - oy + 6);
  const salt = t.density + 4111;
  const [sh, sv] = TERRAIN.cliffScale;
  // Bays and spurs, and finer ledges; clamped to 1, so a column never reads beyond the rows the surface grid holds.
  const n = (o: number, wy: number) => Math.max(-1, Math.min(1, 1.3 * perlin3(salt + o, bx / sh, wy / sv, bd / sh) + 0.35 * perlin3(salt + o + 9, bx / (sh / 2), wy / (sv / 2), bd / (sh / 2))));
  /** First free layer above the displaced surface at layer wy, before the density cut (it may carve wy out). */
  const topAt = (wy: number) => (amp > 0 ? Math.round(hAt(amp * n(0, wy), amp * n(5, wy))) : col.h);
  const solidAt = (wy: number) => wy < lo - 4 || wy < densityTop(t, col, bx, wy, bd, topAt(wy));
  // Top down, so each block knows the top of its solid run: the run's top block is the surface there.
  let runTop = -Infinity;
  for (let y = reach; y >= 0; y--) {
    const wy = oy + y;
    let id: number;
    if (y === 0) id = B.stone;
    else if (wy < lo - 4) id = naturalBlock(t, col, bx, wy, bd);
    else if (!solidAt(wy)) {
      runTop = -Infinity;
      id = wy < TERRAIN.seaY ? B.water : B.air;
    } else {
      if (runTop === -Infinity) runTop = wy + 1;
      id = groundBlock(t, col, bx, wy, bd, runTop);
    }
    put(y, id);
  }
}

type Set = (bx: number, y: number, bd: number, id: number, onlyAir?: boolean) => void;
type Get = (bx: number, y: number, bd: number) => number;

const SOLID_ROCK = new Set<number>([B.stone, B.andesite, B.tuff, B.dirt, B.coarseDirt, B.grass, B.gravel, B.sand, B.coalOre, B.ironOre]);

/** Shape of one row of a cave section: a pure function of the row. */
interface CaveRow {
  salt: number;
  bd: number;
  /** Deck layer of the row. */
  dl: number;
  halfW: number;
  height: number;
}

function caveRowAt(t: TerrainSalts, bd: number): CaveRow {
  const salt = t.density + 7717;
  const halfW = lerp(CAVE.halfWidth[0], CAVE.halfWidth[1], 0.5 + 0.5 * perlin2(salt, bd / 34, 0.3));
  const range = caveRangeAt(t.caves, bd);
  const fromEnd = range ? Math.min(bd - range[0], range[1] - 1 - bd) : 0;
  const mouth = lerp(CAVE.mouthHeight, 1, Math.min(1, fromEnd / CAVE.mouthRows));
  const height = mouth * lerp(CAVE.height[0], CAVE.height[1], 0.5 + 0.5 * perlin2(salt + 1, bd / 27, 4.1));
  return { salt, bd, dl: deckLayer(profileAt(t, bd).offset), halfW, height };
}

const CAVE_REACH = CAVE.halfWidth[1] + 4;

/** Whether the cavern is carved out at this block of its row. */
function caveOpen(row: CaveRow, bx: number, y: number): boolean {
  const rel = y - row.dl;
  const n = perlin3(row.salt + 2, bx / 7, y / 5, row.bd / 7);
  const u = Math.abs(bx) / Math.max(1, row.halfW + 3 * n);
  const v = rel / Math.max(1, row.height + 3 * n);
  const floor = 1 + 2.5 * u * u + 1.5 * perlin2(row.salt + 3, bx / 5, row.bd / 5);
  return u * u + v * v < 1 && rel >= floor;
}

/** First carved layer of a column of the cavern (its floor is the layer below), or null where there is none. */
function caveFloorAt(row: CaveRow, bx: number): number | null {
  if (Math.abs(bx) > CAVE_REACH) return null;
  for (let y = row.dl + 1, top = row.dl + CAVE.height[1] + 4; y <= top; y++) if (caveOpen(row, bx, y)) return y;
  return null;
}

/**
 * Whether the floor block of this column of the cavern is lava. There is no fluid flow, so lava may only lie where it
 * could not run: a floor close to the road's level, with room above, and no neighbour column (4 sides) whose floor is
 * lower. Lava never shows a side face hanging over a drop, or on a wall or ceiling. Pure in (row, bx) and the two
 * neighbour rows, so segments agree at their seams.
 */
function caveLavaAt(t: TerrainSalts, row: CaveRow, bx: number, floorY: number): boolean {
  if (Math.abs(bx) < CAVE.lavaFrom) return false;
  if (floorY - row.dl > CAVE.lavaMaxRise) return false;
  if (perlin2(row.salt + 4, bx / 6, row.bd / 6) <= CAVE.lava) return false;
  for (let y = floorY + 1; y <= floorY + CAVE.lavaHeadroom; y++) if (!caveOpen(row, bx, y)) return false;
  const next = [row, caveRowAt(t, row.bd - 1), caveRowAt(t, row.bd + 1)];
  for (const r of next.slice(1)) if (profileAt(t, r.bd).kind !== RoadKind.Cave) return false;
  for (const [r, x] of [[row, bx - 1], [row, bx + 1], [next[1]!, bx], [next[2]!, bx]] as const) {
    const f = caveFloorAt(r, x);
    if (f === null || f < floorY) return false;
  }
  return true;
}

/** Carves one row of a cave section (deck layer dl); a pure function of the row, like everything in a segment. */
function carveCave(t: TerrainSalts, bd: number, dl: number, set: Set, get: Get): void {
  const salt = t.density + 7717;
  const row = caveRowAt(t, bd);
  const reach = CAVE_REACH, top = dl + CAVE.height[1] + 4;
  const floorAt = new Map<number, number>();
  for (let bx = -reach; bx <= reach; bx++) {
    for (let y = dl + 1; y <= top; y++) {
      if (caveOpen(row, bx, y)) {
        set(bx, y, bd, B.air);
        if (!floorAt.has(bx)) floorAt.set(bx, y);
      }
    }
  }
  // Lava pools on the floor away from the road (their light, with the lamps, is what lights the cave).
  for (const [bx, y] of floorAt) {
    if (SOLID_ROCK.has(get(bx, y - 1, bd)) && caveLavaAt(t, row, bx, y)) set(bx, y - 1, bd, B.lava);
  }
  // Ores and glowstone on the rock faces of this row.
  for (let bx = -reach - 1; bx <= reach + 1; bx++) {
    for (let y = dl; y <= top + 1; y++) {
      if (!SOLID_ROCK.has(get(bx, y, bd))) continue;
      const open = get(bx + 1, y, bd) === B.air || get(bx - 1, y, bd) === B.air || get(bx, y - 1, bd) === B.air;
      if (!open || (Math.abs(bx) <= ROAD.halfWidth && y === dl)) continue;
      const r = hash01(salt + 5, bx, y, bd);
      if (get(bx, y - 1, bd) === B.air && r < 0.012) set(bx, y, bd, B.caveGlowstone);
      else if (r < 0.05) set(bx, y, bd, B.coalOre);
      else if (r < 0.065) set(bx, y, bd, B.ironOre);
    }
  }
  // Wall lamps: the first rock out from the corridor at eye height on each side.
  if (((bd % CAVE.lampEvery) + CAVE.lampEvery) % CAVE.lampEvery === 0) {
    for (const s of [-1, 1]) {
      for (let ax = ROAD.clearHalf + 1; ax <= reach + 1; ax++) {
        if (get(s * ax, dl + 3, bd) !== B.air) { set(s * ax, dl + 3, bd, B.caveLamp); break; }
      }
    }
  }
}

/** Trees and plants. Each belongs to its own column, so the segments around it agree on it. */
function decorate(t: TerrainSalts, startRow: number, length: number, surface: Surface, surfaceAt: (bx: number, bd: number) => number, set: Set, get: Get): void {
  const half = TERRAIN.halfWidth;
  for (let bd = startRow - REACH; bd < startRow + length + REACH; bd++) {
    const { kind } = profileAt(t, bd);
    for (let bx = -half; bx <= half; bx++) {
      const ax = Math.abs(bx);
      if (ax <= ROAD.clearHalf + 1 && kind !== RoadKind.Cave) continue; // road, kerbs and posts
      const col = surface.col[(bd - surface.firstRow) * surface.cols + (bx + half + 1)]!;
      const h = col.h;
      if (h <= TERRAIN.seaY || h >= TERRAIN.treeLine || col.river > 0 || cliffWeight(col, bx, true) > 0) continue;
      const inside = bd >= startRow - 1 && bd <= startRow + length;
      const top = naturalTopBlock(t, col, bx, bd);
      const forest = perlin2(t.deco + 7, bx / 55, bd / 55);
      const r = hash01(t.deco, bx, bd, 1);
      // Trees keep their crowns (2 blocks, 4 for a big oak) off the road corridor and the light posts beside it.
      if (top === B.grass && ax >= ROAD.postX + 4 && kind !== RoadKind.Cave) {
        // The detailed terrain keeps the ordinary forest everywhere (the spruce forest is only on the far mountains, far.ts).
        const density = forest > 0.2 ? 0.045 : forest > -0.15 ? 0.012 : 0.002;
        if (r < density) {
          // Do not plant a tree against another trunk or on a slope the road cut left steep.
          if (surfaceAt(bx + 1, bd) - h <= 2 && surfaceAt(bx - 1, bd) - h <= 2 && surfaceAt(bx, bd + 1) - h <= 2 && surfaceAt(bx, bd - 1) - h <= 2) {
            tree(t, bx, bd, h, forest, set, ax);
            continue;
          }
        }
        // Undergrowth: low bushes (a blob of leaves on the ground) in the dense forests.
        if (forest > 0.2 && hash01(t.deco, bx, bd, 8) < TERRAIN.bushDensity / 3) {
          const leaf = B.oakLeaves;
          set(bx, h, bd, leaf, true);
          for (const [dx, dd] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            // Only where the neighbour's ground is level with this one (a leaf never hangs over a drop).
            if (surfaceAt(bx + dx, bd + dd) === h && hash01(t.deco, bx + dx, bd + dd, 9) < 0.6) set(bx + dx, h, bd + dd, leaf, true);
          }
          if (hash01(t.deco, bx, bd, 10) < 0.5) set(bx, h + 1, bd, leaf, true);
          continue;
        }
      }
      if (!inside || ax <= ROAD.clearHalf + 1) continue;
      if (top === B.grass) {
        const g = hash01(t.deco, bx, bd, 2);
        const flowers = perlin2(t.deco + 13, bx / 18, bd / 18) > 0.35;
        if (flowers && g < 0.12) set(bx, h, bd, hash01(t.deco, bx, bd, 3) < 0.5 ? B.dandelion : B.poppy, true);
        else if (g < (forest > 0 ? 0.3 : 0.22)) {
          // Ferns among the grass in the dense forests.
          const fern = forest > 0.2 && hash01(t.deco, bx, bd, 11) < 0.45;
          set(bx, h, bd, fern ? B.fern : B.shortGrass, true);
        }
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

/**
 * Spruce (the tree of the extremely distant mountains, drawn only by the far field, far.ts): trunk height from a hash.
 */
export function spruceHeight(h01: number): number {
  return 7 + Math.floor(5 * h01);
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

