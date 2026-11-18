// Voxel Dreamscape: far-field terrain (pure, no Three.js, no DOM). Runs in the Worker. A coarser level of detail of the
// same natural terrain (terrain.ts) that extends the view to the distant mountains beyond the detailed segments: one
// column per cell, sampled at its centre, drawn as a block-like box (top face, and side walls where a neighbour is lower)
// with the block textures, and a flat water surface at the sea level. Forests: in the fine cells (2 and 4 blocks) a cell
// may hold a small tree (trunk and two leaf boxes, at the detailed terrain's own density), in the 8-block cells a raised
// leaf canopy of varying height (scenario version 10, user-requested: the distance looked bare). The cells
// grow with the distance from the road (scenario version 8, user-requested: the sides were too coarse): 2 x 2 blocks
// next to the detailed band, then 4 x 4, then 8 x 8 (`FAR.bands`), along the road and across alike. No road, no caves,
// no decoration: the detailed segments cover the area around the camera and the scene clips the far terrain inside it
// (the cells never straddle that area's border, see `FAR_EDGES`).
// Coordinates and vertex layout are the detailed meshes' own (mesher.ts), so the same materials draw them.
import { B, BLOCKS, FLAG, Tint } from './blocks.ts';
import { PACK, WATER_DROP, type MeshArrays } from './mesher.ts';
import { deckLayer, profileAt, ROAD, RoadKind } from './road.ts';
import { baseColumnAt, columnAt, grassCover, naturalBlock, raiseCaveMountain, strataBand, strataBandBottom, strataRock, TERRAIN, type Column, type TerrainSalts } from './terrain.ts';
import { hash01, perlin2 } from './noise.ts';
import { spruceHeight } from './chunk.ts';

export const FAR = {
  /**
   * Cell size (blocks) and the distance from the road (blocks, |x|) up to which it is used; the last one goes to the edge.
   * Every size divides the next and the detailed segment length, so cell borders line up along both axes.
   */
  bands: [[2, 256], [4, 576], [8, Infinity]] as readonly (readonly [number, number])[],
  /** Largest cell size (the row grid every band's rows subdivide). */
  cell: 8,
  /** Far segment length (blocks) and streaming window (segments): past the end of the fog ahead. */
  segmentLength: 256,
  segmentsAhead: 4,
  segmentsBehind: 2,
  /** Half-width (blocks) of the far terrain around the road: just past the end of the fog. */
  halfWidth: 896,
  /** Height (blocks) of the leaf canopy over a coarse forest cell: base and the extra range (hash of the cell). */
  canopy: 5,
  canopyExtra: 3,
  /** Cells up to this size (blocks, both ways) hold a tree of their own instead of a canopy. */
  treeCell: 4,
  /** Tree density per block (the detailed terrain's own: dense forest, light woodland, open land). */
  treeDensity: [0.045, 0.012, 0.002] as const,
  /**
   * Spruce forest of the extremely distant mountains (scenario version 13, user-requested: pines only on the very far
   * mountains, not on the near and middle ground): from this distance from the road (blocks, |x|) on, the mountain cells hold
   * a spruce tree (chance `spruceChance`, `spruceTall` blocks taller than the detailed spruce, so it reads from afar).
   */
  spruceFrom: 576,
  spruceChance: 0.85,
  spruceTall: 2,
  /** Walls that may face the detailed area go down to this layer, so no gap opens below the detailed terrain's edge. */
  floorY: -16,
} as const;

/**
 * Column edges (bx) of the far cells. The detailed segments span bx in [-H, H] (H = TERRAIN.halfWidth, an odd count of
 * columns): the cells of that central band run from -H in steps of FAR.cell and the last one stretches to H, so no cell
 * straddles the band's border and the cells outside start exactly at -H - 1 and H + 1.
 */
export const FAR_EDGES: readonly number[] = (() => {
  const H = TERRAIN.halfWidth, C = FAR.cell;
  const centre: number[] = [];
  for (let x = -H; x < H + 1 - C; x += C) centre.push(x);
  // Outside the band: cells of the size of the band they start in, out to the far half-width.
  const outward = (from: number): number[] => {
    const out: number[] = [from];
    let x = from;
    while (x < FAR.halfWidth + C) {
      x += cellSizeAt(x);
      out.push(x);
    }
    return out;
  };
  const right = outward(H + 1);
  const left = outward(H + 1).map((x) => -x + 1).reverse(); // mirror: edge e on the right is 1 - e on the left
  // left ends at -H, where the centre starts.
  return [...left.slice(0, -1), ...centre, ...right];
})();

/** Cell size (blocks) of the band a column at |x| belongs to. */
export function cellSizeAt(x: number): number {
  const ax = Math.abs(x);
  for (const [size, upTo] of FAR.bands) if (ax < upTo) return size;
  return FAR.cell;
}

export interface FarSegment {
  solid: MeshArrays;
  water: MeshArrays;
}

/** One vertical layer band of a cell's column: [y0, y1) drawn with a block's side texture. */
interface Band {
  y0: number;
  y1: number;
  layer: number;
  flags: number;
}

interface Cell {
  /** First free layer above the cell (ground, or the canopy top). */
  top: number;
  topLayer: number;
  topFlags: number;
  /** Bands of the walls, top down; the last one reaches FAR.floorY. */
  bands: Band[];
  wet: boolean;
  /** A tree standing on the cell: block offset inside the cell (column, row), trunk height, birch or oak. */
  tree: { dx: number; dd: number; height: number; birch: boolean; spruce: boolean } | null;
}

const sideOf = (id: number) => BLOCKS[id]!.faces[0];
const flagsOf = (id: number, side: boolean) => {
  const f = BLOCKS[id]!.flags;
  return side && id === B.grass ? f & ~FLAG.tintMask : f; // only the top of a grass block is tinted
};

/** Cells up to FAR.treeCell blocks both ways hold ordinary trees. */
const fine0 = (w: number, rows: number): boolean => w <= FAR.treeCell && rows <= FAR.treeCell;

/**
 * `steep`: slope of the cell (rise per block) from its neighbour cells, for the surface rules. `x0`, `w`, `d0`, `rows`:
 * the cell's first block column and row and its size, which decide its tree (a pure function of those).
 */
function cellAt(t: TerrainSalts, col: Column, bx: number, bd: number, steep: number, x0: number, w: number, d0: number, rows: number): Cell {
  col.steep = steep;
  // The road's cut, seen from afar: the cells on the road never rise above its surface. As in the detailed volume, the
  // cut applies to the natural land and the mountain of a cave section rises on it afterwards (no trench into it).
  if (Math.abs(bx) <= ROAD.flatHalf) {
    const { kind, offset } = profileAt(t, bd);
    const surface = deckLayer(offset) + 1;
    if (kind !== RoadKind.Cave) {
      const base = baseColumnAt(t, bx, bd);
      if (base.h > surface) col = { ...raiseCaveMountain(t, bx, bd, { h: surface, river: 0, mountain: 0 }), steep };
    }
  }
  const h = col.h;
  let id = naturalBlock(t, col, bx, h - 1, bd);
  if (id === B.air) id = B.stone; // an overhang cut at the sample point
  const bands: Band[] = [];
  const wooded = id === B.grass && col.river === 0 && h > TERRAIN.seaY + 1 && h < TERRAIN.treeLine;
  const forestNoise = wooded ? perlin2(t.deco + 7, bx / 55, bd / 55) : -1;
  // The spruce forest: only the mountains of the coarse cells, far from the road (see FAR.spruceFrom).
  const mountainous = wooded && col.mountain > 0.15 && steep <= TERRAIN.treeSlope && Math.abs(bx) >= FAR.spruceFrom && !fine0(w, rows);
  const fine = fine0(w, rows);
  let top = h, topLayer = BLOCKS[id]!.faces[2], topFlags = flagsOf(id, false);
  let tree: Cell['tree'] = null;
  if (wooded && fine) {
    // One tree per cell at most, with the chance of the blocks it stands for (the detailed terrain's own density).
    const [dense, light, open] = FAR.treeDensity;
    const density: number = forestNoise > 0.2 ? dense : forestNoise > -0.15 ? light : open;
    if (steep < 1.2 && hash01(t.deco + 31, x0, d0, 1) < Math.min(0.9, density * w * rows)) {
      const roll = hash01(t.deco + 31, x0, d0, 2);
      const birch = forestNoise > 0.3 ? roll < 0.4 : roll < 0.1;
      tree = {
        dx: Math.floor(hash01(t.deco + 31, x0, d0, 3) * w), dd: Math.floor(hash01(t.deco + 31, x0, d0, 4) * rows),
        height: (birch ? 5 : 4) + Math.floor(3 * hash01(t.deco + 31, x0, d0, 5)), birch, spruce: false,
      };
    }
  } else if (mountainous) {
    // Extremely distant mountain: one spruce per cell (most of them), standing in the cell so its cone never spills over
    // the neighbour (the cone is 7 wide, the cell 8), over the grass of the mountain.
    if (hash01(t.deco + 31, x0, d0, 1) < FAR.spruceChance) {
      tree = {
        dx: 3 + Math.floor(2 * hash01(t.deco + 31, x0, d0, 3)), dd: 3 + Math.floor(2 * hash01(t.deco + 31, x0, d0, 4)),
        height: spruceHeight(hash01(t.deco + 31, x0, d0, 5)) + FAR.spruceTall, birch: false, spruce: true,
      };
    }
  } else if (wooded && forestNoise > 0.2) {
    // Coarse cell of a forest: a leaf canopy whose height varies from cell to cell (not one flat slab).
    top = h + FAR.canopy + Math.floor(FAR.canopyExtra * hash01(t.deco + 33, x0, d0));
    const crown = B.oakLeaves;
    topLayer = BLOCKS[crown]!.faces[2];
    topFlags = BLOCKS[crown]!.flags;
    bands.push({ y0: h, y1: top, layer: sideOf(crown), flags: topFlags });
  }
  // The block's side for its own layer, then the soil under it (dirt under grass; none under bare rock), then the rock
  // strata of the detailed terrain (terrain.ts `rockAt`, without the ores), one band per stratum down to FAR.floorY.
  // On steep ground the grass also covers the blocks under the top one (terrain.ts `grassCover`): the wall keeps its green.
  const cover = id === B.grass ? grassCover(steep) : 0;
  bands.push({ y0: h - 1 - cover, y1: h, layer: sideOf(id), flags: flagsOf(id, true) });
  const under = id === B.grass || id === B.coarseDirt || id === B.dirt ? B.dirt : id === B.sand || id === B.gravel ? id : B.air;
  let rockTop = h - 1 - cover;
  if (under !== B.air) {
    rockTop = h - 1 - cover - TERRAIN.dirtDepth[0];
    bands.push({ y0: rockTop, y1: h - 1 - cover, layer: sideOf(under), flags: flagsOf(under, true) });
  }
  for (let y1 = rockTop; y1 > FAR.floorY;) {
    const band = strataBand(t, col, bx, y1 - 1, bd);
    const y0 = Math.max(FAR.floorY, strataBandBottom(col, band));
    const layer = sideOf(strataRock(t, col, bx, band, bd));
    const last = bands[bands.length - 1]!;
    if (last.layer === layer && last.y0 === y1) last.y0 = y0; // same rock as the band above: one band
    else bands.push({ y0, y1, layer, flags: 0 });
    y1 = y0;
  }
  return { top, topLayer, topFlags, bands, wet: h < TERRAIN.seaY, tree }; // water fills the air below layer seaY
}

class Quads {
  private readonly v: number[] = [];
  private readonly i: number[] = [];
  private count = 0;

  /**
   * Quad from 4 corners in order around its edge, facing `face` (0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z); the winding is
   * fixed here so the front is always the face direction. uv in tiles (1 per block). `ao` (0 dark .. 3) per corner or one
   * for all; `sky` is the sky light level (0..15; under a crown the direct sun is off).
   */
  quad(c: readonly (readonly [number, number, number])[], uv: readonly (readonly [number, number])[], face: number, layer: number, flags: number, ao: number | readonly number[] = 3, sky = 15): void {
    const n = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]][face]!;
    const p0 = c[0]!, p1 = c[1]!, p2 = c[2]!;
    const a = [p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!], b = [p2[0]! - p0[0]!, p2[1]! - p0[1]!, p2[2]! - p0[2]!];
    const dot = (a[1]! * b[2]! - a[2]! * b[1]!) * n[0]! + (a[2]! * b[0]! - a[0]! * b[2]!) * n[1]! + (a[0]! * b[1]! - a[1]! * b[0]!) * n[2]!;
    // Open sky and no block light: the far terrain is lit by the sun and the sky ambient. Occlusion only where it is cheap
    // to know: the foot of a wall and the underside of a tree (see `wall`, `addTree`).
    const base = this.count;
    for (let k = 0; k < 4; k++) {
      const packed = face + PACK.ao * (typeof ao === 'number' ? ao : ao[k]!) + PACK.sky * 4 * sky + PACK.flags * flags;
      this.v.push(c[k]![0], c[k]![1], c[k]![2], layer, uv[k]![0], uv[k]![1], packed);
    }
    if (dot > 0) this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else this.i.push(base, base + 2, base + 1, base, base + 3, base + 2);
    this.count += 4;
  }

  build(): MeshArrays {
    return { vertices: Float32Array.from(this.v), indices: Uint32Array.from(this.i), extra: null };
  }
}

/** Box [x0, x1] x [y0, y1] x [z0, z1]: the four sides and the top, no underside. */
function addBox(q: Quads, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, block: number, ao: readonly number[], sky: number): void {
  const side = BLOCKS[block]!.faces[0], top = BLOCKS[block]!.faces[2], flags = BLOCKS[block]!.flags;
  const h = y1 - y0, dx = x1 - x0, dz = z1 - z0;
  q.quad([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], [[0, 0], [dz, 0], [dz, h], [0, h]], 0, side, flags, ao, sky);
  q.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [[0, 0], [dz, 0], [dz, h], [0, h]], 1, side, flags, ao, sky);
  q.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [[0, 0], [dx, 0], [dx, h], [0, h]], 4, side, flags, ao, sky);
  q.quad([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [[0, 0], [dx, 0], [dx, h], [0, h]], 5, side, flags, ao, sky);
  q.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [[0, 0], [dx, 0], [dx, dz], [0, dz]], 2, top, flags, 3, 15);
}

/**
 * A tree on the cell whose first column is `x0` and first row `d0`, on ground `ground`: the trunk (no direct sun under
 * the crown), the 5 x 5 leaf layers around its top and the 3 x 3 ones above them, as in the detailed terrain.
 */
function addTree(q: Quads, tree: NonNullable<Cell['tree']>, x0: number, d0: number, ground: number): void {
  const tx = x0 + tree.dx, td = d0 + tree.dd; // trunk column and row; row bd covers z in [-bd - 1, -bd]
  const log = tree.spruce ? B.spruceLog : tree.birch ? B.birchLog : B.oakLog, leaf = tree.spruce ? B.spruceLeaves : tree.birch ? B.birchLeaves : B.oakLeaves;
  const H = ground + tree.height;
  addBox(q, tx, tx + 1, ground, H, -td - 1, -td, log, [1, 1, 2, 2], 9);
  if (tree.spruce) {
    // Cone in three tiers (the detailed spruce's outline: 7 wide at the foot, 5, then 3 and a tip).
    addBox(q, tx - 3, tx + 4, ground + 2, ground + 2 + Math.ceil(tree.height / 3), -td - 4, -td + 3, leaf, [2, 2, 3, 3], 15);
    addBox(q, tx - 2, tx + 3, ground + 2 + Math.ceil(tree.height / 3), ground + 2 + Math.ceil((2 * tree.height) / 3), -td - 3, -td + 2, leaf, [3, 3, 3, 3], 15);
    addBox(q, tx - 1, tx + 2, ground + 2 + Math.ceil((2 * tree.height) / 3), H + 2, -td - 2, -td + 1, leaf, [3, 3, 3, 3], 15);
    return;
  }
  addBox(q, tx - 2, tx + 3, H - 2, H, -td - 3, -td + 2, leaf, [2, 2, 3, 3], 15);
  addBox(q, tx - 1, tx + 2, H, H + 2, -td - 2, -td + 1, leaf, [3, 3, 3, 3], 15);
}

/**
 * Far segment of the rows [startRow, startRow + length). `nearSegment` is the detailed segment length: the detailed
 * window starts and ends on its multiples, so walls there reach down to FAR.floorY. Each column of cells (between two
 * FAR_EDGES) has rows of its own band's size; where two bands meet, a wall faces the coarser neighbour row it overlaps.
 * Pure function of its arguments.
 */
export function buildFarSegment(t: TerrainSalts, startRow: number, length: number, nearSegment: number): FarSegment {
  const E = FAR_EDGES, nx = E.length - 1;
  const H = TERRAIN.halfWidth;
  /** Cells of the detailed area's band (clipped by the scene where the detailed segments are loaded): never merged with others. */
  const inBand = (c: number) => E[c]! >= -H && E[c + 1]! <= H + 1;
  // Row size of every cell column: the band size (the central band uses the largest size, as before).
  const size = new Int32Array(nx);
  for (let c = 0; c < nx; c++) size[c] = inBand(c) ? FAR.cell : cellSizeAt(E[c]! < 0 ? E[c + 1]! - 1 : E[c]!);
  // Cells per column with one padding row on each side (shared with the neighbouring segments, same pure function).
  // Columns first (with one more padding row each side for the slopes), then the cells with the slope to their neighbours.
  const cols: Cell[][] = [];
  for (let c = 0; c < nx; c++) {
    const C = size[c]!, n = length / C;
    const bx = Math.floor((E[c]! + E[c + 1]!) / 2);
    const raw: Column[] = [];
    for (let r = -2; r <= n + 1; r++) raw.push(columnAt(t, bx, startRow + r * C + C / 2));
    const side = (dc: number, k: number): number | null => {
      const o = c + dc;
      if (o < 0 || o >= nx) return null;
      return columnAt(t, Math.floor((E[o]! + E[o + 1]!) / 2), startRow + (k - 2) * C + C / 2).h;
    };
    const list: Cell[] = [];
    for (let k = 1; k <= n + 2; k++) {
      const col = raw[k]!;
      let rise = Math.max(Math.abs(raw[k + 1]!.h - col.h), Math.abs(raw[k - 1]!.h - col.h)) / C;
      // Across, only where the slope along the road does not already decide it (saves most of the extra samples).
      if (rise < TERRAIN.steepSlope && col.h > TERRAIN.seaY + 3) {
        for (const dc of [-1, 1]) {
          const h = side(dc, k);
          if (h !== null) rise = Math.max(rise, Math.abs(h - col.h) / ((E[c + 1]! - E[c]! + (E[c + dc + 1]! - E[c + dc]!)) / 2));
        }
      }
      list.push(cellAt(t, col, bx, startRow + (k - 2) * C + C / 2, rise, E[c]!, E[c + 1]! - E[c]!, startRow + (k - 2) * C, C));
    }
    cols.push(list);
  }
  /** Cell of column c that covers row bd (padding rows included), or null outside the columns. */
  const at = (c: number, bd: number): Cell | null => {
    if (c < 0 || c >= nx) return null;
    const C = size[c]!;
    return cols[c]![Math.floor((bd - startRow) / C) + 1]!;
  };
  const solid = new Quads(), water = new Quads();

  // Top faces, merged along x while height, texture and row size stay the same (rows of equal size share their borders).
  for (const C of [...new Set(size)]) {
    for (let r = 0; r < length / C; r++) {
      const d0 = startRow + r * C, d1 = d0 + C;
      const z0 = -d1, z1 = -d0; // block row bd covers z in [-bd - 1, -bd]
      for (let c = 0; c < nx;) {
        if (size[c] !== C) { c++; continue; }
        const cell = cols[c]![r + 1]!;
        let e = c + 1;
        while (e < nx && size[e] === C) {
          const o = cols[e]![r + 1]!;
          if (o.top !== cell.top || o.topLayer !== cell.topLayer || o.topFlags !== cell.topFlags || inBand(e) !== inBand(c)) break;
          e++;
        }
        const x0 = E[c]!, x1 = E[e]!, y = cell.top;
        solid.quad([[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], [[0, 0], [x1 - x0, 0], [x1 - x0, C], [0, C]], 2, cell.topLayer, cell.topFlags);
        c = e;
      }
      // Water surface over the wet cells (same drop below the block top as the detailed water).
      for (let c = 0; c < nx;) {
        if (size[c] !== C || !cols[c]![r + 1]!.wet) { c++; continue; }
        let e = c + 1;
        while (e < nx && size[e] === C && cols[e]![r + 1]!.wet) e++;
        const x0 = E[c]!, x1 = E[e]!, y = TERRAIN.seaY - WATER_DROP;
        water.quad([[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], [[0, 0], [x1 - x0, 0], [x1 - x0, C], [0, C]], 2, BLOCKS[B.water]!.faces[2], BLOCKS[B.water]!.flags | Tint.None);
        c = e;
      }
    }
  }

  // Trees of the fine cells (a trunk and two leaf boxes, 5 x 5 and 3 x 3, like the detailed trees) and the spruces of the
  // extremely distant mountains (a trunk and a cone of three boxes).
  for (let c = 0; c < nx; c++) {
    const C = size[c]!;
    for (let r = 0; r < length / C; r++) {
      const cell = cols[c]![r + 1]!;
      if (cell.tree) addTree(solid, cell.tree, E[c]!, startRow + r * C, cell.top);
    }
  }

  // Walls toward lower neighbours. On the detailed area's possible borders (its sides, every detailed segment border)
  // they reach FAR.floorY, so the far terrain closes the edge of the detailed one whatever their heights.
  const wall = (cell: Cell, low: number, face: number, x0: number, x1: number, z0: number, z1: number) => {
    if (low >= cell.top) return;
    // Ambient occlusion at the foot of the wall (not on the detailed area's borders, which reach down to the floor): the
    // darker the taller the wall, fading out over the first 4 blocks above the ground it meets.
    const foot = low > FAR.floorY ? (cell.top - low >= 6 ? 1 : 2) : 3;
    const aoAt = (y: number) => (foot === 3 || y - low >= 4 ? 3 : Math.min(3, foot + (y - low > 0 ? 1 : 0)));
    for (const band of cell.bands) {
      const ya = Math.max(band.y0, low), yb = Math.min(band.y1, cell.top);
      if (yb <= ya) continue;
      const v0 = ya - band.y0, v1 = yb - band.y0;
      const ao = [aoAt(ya), aoAt(ya), aoAt(yb), aoAt(yb)];
      if (face === 0 || face === 1) {
        const x = face === 0 ? x1 : x0;
        solid.quad([[x, ya, z0], [x, ya, z1], [x, yb, z1], [x, yb, z0]], [[0, v0], [z1 - z0, v0], [z1 - z0, v1], [0, v1]], face, band.layer, band.flags, ao);
      } else {
        const z = face === 4 ? z1 : z0;
        solid.quad([[x0, ya, z], [x1, ya, z], [x1, yb, z], [x0, yb, z]], [[0, v0], [x1 - x0, v0], [x1 - x0, v1], [0, v1]], face, band.layer, band.flags, ao);
      }
    }
  };
  for (let c = 0; c < nx; c++) {
    const C = size[c]!, x0 = E[c]!, x1 = E[c + 1]!, band = inBand(c);
    for (let r = 0; r < length / C; r++) {
      const cell = cols[c]![r + 1]!;
      const d0 = startRow + r * C, d1 = d0 + C;
      const z0 = -d1, z1 = -d0;
      // Along the road (same column): toward smaller d (+z) and larger d (-z).
      wall(cell, band && d0 % nearSegment === 0 ? FAR.floorY : cols[c]![r]!.top, 4, x0, x1, z0, z1);
      wall(cell, band && d1 % nearSegment === 0 ? FAR.floorY : cols[c]![r + 2]!.top, 5, x0, x1, z0, z1);
      // Across: the neighbour column may have other row sizes; split this side at its row borders.
      for (const [nc, face, border] of [[c + 1, 0, x1 === -H || x1 === H + 1], [c - 1, 1, x0 === H + 1 || x0 === -H]] as const) {
        if (nc < 0 || nc >= nx) continue;
        const step = Math.min(C, size[nc]!);
        for (let s0 = d0; s0 < d1; s0 += step) {
          const nb = at(nc, s0)!;
          wall(cell, border ? FAR.floorY : nb.top, face, x0, x1, -(s0 + step), -s0);
        }
      }
    }
  }
  return { solid: solid.build(), water: water.build() };
}
