// Voxel Dreamscape: natural terrain of the overworld (pure, no Three.js, no DOM). Alpha/Beta style: a sea level, fbm
// heights with hills and mountains, a coarse 3D density for overhangs on high ground, meandering rivers and lakes.
// Everything is a pure function of the terrain salt and block coordinates, so any column can be evaluated in any
// segment. Coordinates: bx = block column across (centre of block bx is x = bx), bd = block row along the travel
// axis, by = block layer (block by covers y in [by, by + 1]); the sea surface is the top of layer SEA_Y - 1.
import { deriveSeed, type Seed } from '../../world/identity/seed.ts';
import { B } from './blocks.ts';
import { CAVE_MASK, caveRangeAt, caveWeight, NO_CAVES, type CaveMask } from './caveMask.ts';
import { fbm2, hash01, lerp, perlin2, perlin3, saltOf, smoothstep } from './noise.ts';

/**
 * Half-width of the detailed 1-block volume: 384 blocks = 24 Minecraft chunks on each side of the road (scenario version
 * 17, user-requested: loading was slow and the road outran the generator at speed; it was 512 = 32 chunks since version
 * 14, user-requested: the loss of detail at 6 chunks was too close to the screen; PROPOSED value, to be tuned by frame rate
 * and generation time; 2048 was measured at about 18 s per segment and rejected). The far field (far.ts) starts where the
 * detailed volume ends. The build variable `VITE_VOXEL_NEAR_HALF` (96..512) overrides it, e.g. 256 on a slower machine.
 * Read in both the Worker and the main thread (same bundle define), so they always agree. Unset (and in tests) it is 384.
 */
const NEAR_HALF = (() => {
  // Typed locally: the server tsconfig has no Vite types, and under Node (tests) `import.meta.env` does not exist.
  const env = (import.meta as { env?: Record<string, unknown> }).env;
  const v = Math.round(Number(env?.VITE_VOXEL_NEAR_HALF));
  return Number.isFinite(v) && v >= 96 ? Math.min(512, v) : 384;
})();

export const TERRAIN = {
  /** Water fills every air block below this layer (the top water block is layer SEA_Y - 1). */
  seaY: 0,
  /** Lowest generated layer. */
  floorY: -24,
  /** Highest generated layer of the natural terrain. */
  topY: 160,
  /**
   * Heights above this layer are compressed smoothly toward `topY` (scenario version 18, user-reported: summits cut flat
   * at the ceiling looked like the tops of towers), so no mountain is ever cut flat at the ceiling.
   */
  topKnee: 128,
  /** Half-width (blocks) of the generated world around the road. */
  halfWidth: NEAR_HALF as number,
  /** Typical dry land height above the sea. */
  baseHeight: 5,
  hillAmp: 9,
  /**
   * Mountains (scenario version 8, user-requested: natural and all different), after the block game's ideas, not its
   * code: where a massif stands (`mountainScale`), erosion (low erosion = tall, steep and jagged), folded ridges for
   * peaks and valleys, a per-massif size, and pointed peaks only on the high ridges of uneroded massifs. Heights in layers.
   * The peaks (scenario version 18, user-reported: towers standing on the mountains) are as wide as they are tall, so their
   * flanks continue the massif's slopes: at a scale of 26 blocks and up to 36 layers they were blades about 6 blocks wide
   * with near-vertical walls on top of the massif.
   */
  mountainAmp: 100,
  jagAmp: 22,
  mountainSize: [0.35, 1.3],
  /** Horizontal scales (blocks). */
  hillScale: 70,
  continentScale: 260,
  mountainScale: 220,
  erosionScale: 700,
  ridgeScale: 190,
  jagScale: 90,
  warp: 70,
  riverScale: 320,
  /**
   * Surface (scenario version 9, user-requested: the mountains were bare stone; version 12, user-requested: cover them with
   * grass and trees). Snow above `snowLine` (with noise) unless the slope (rise per block) reaches `snowSteep`. Elsewhere the
   * soil (grass over dirt) thins only on the sheerest ground, from `rockSlope[0]` to bare rock at `rockSlope[1]`, and a
   * little with the altitude over `alpine` (layers, weight `alpineWeight`); the thresholds wander with noise, so the line
   * between grass and rock is ragged. Thin soil is grass, coarse dirt or gravel scree. On slopes steeper than `coverSlope`
   * the grass also covers the blocks under the top one (up to `coverMax`), so the faces of the steps stay green.
   * `steepSlope` is the slope from which the far field counts a cell as steep (fewer neighbour samples).
   */
  snowLine: 100,
  steepSlope: 1.4,
  snowSteep: 2.6,
  rockSlope: [2.6, 3.8],
  alpine: [96, 140],
  alpineWeight: 0.9,
  coverSlope: 1.2,
  coverMax: 4,
  /** Rock strata: band thickness (layers) and the warp of the bands (layers, broad and fine). */
  strata: 6,
  strataWarp: [5, 2],
  /**
   * Cliffs: on steep mountain columns the detailed volume takes, layer by layer, the height of the surface at a point
   * shifted by smooth 3D noise of up to `cliffWarp` blocks (`caveCliffWarp` on the face over a cave mouth, fading back to
   * `cliffWarp` over `caveBrowHalf`), so cliffs and cave mountain faces get ledges, bays and overhangs instead of flat
   * walls. Applied from slope `cliffSlope[0]` (none) to `cliffSlope[1]` (full), never within `cliffRoad` blocks of the road.
   * Scenario version 18 (user-reported: mountains like towers and planets, full of holes and loose blocks): the shift is
   * also at most `cliffRise` / slope blocks, so the face moves at most `cliffRise` layers up or down whatever its slope
   * (a shift of W blocks on a slope s moves it W x s layers, and the column then switched between rock and air from layer
   * to layer); the noise (`cliffScale`: horizontal and vertical scale, blocks) changes slowly with the height.
   */
  cliffWarp: 3,
  caveCliffWarp: 6,
  cliffRise: 6,
  cliffScale: [12, 12],
  cliffSlope: [2.3, 3.4],
  cliffRoad: 4,
  /** No trees or forest canopy from this surface layer up (just under the snow). */
  treeLine: 98,
  /** Steepest slope that still holds a spruce on the extremely distant mountains (far.ts). */
  treeSlope: 3,
  /** Share of the columns of a dense forest with a bush (a low blob of leaves) is a third of this. */
  bushDensity: 0.05,
  /** Rivers: width of the channel in noise units (|noise| below this is river) and its depth below the sea. */
  riverWidth: 0.02,
  riverDepth: 4,
  /** Layers of dirt under the grass. */
  dirtDepth: [3, 4],
  /**
   * Centre of the map (around the road): within `centreClear[0]` blocks the mountains are removed and the land is kept
   * at most `centreCap` layers high (no tunnel), fading back to the natural terrain by `centreClear[1]`.
   */
  centreClear: [36, 120],
  centreCap: 11,
  /** Mountain raised over a cave section: ridge height (layers) range and its half-width across (full, then fading). */
  caveRidge: [34, 52],
  caveHalf: [28, 80],
  /**
   * Shape of that mountain along the road (user-requested 2026-11-17: a natural mountain with the cave mouth in it, not a
   * straight wall). Within `caveMouthHalf` blocks of the road its face is a cliff on the cave's first row; farther out
   * its edge comes forward `caveRecede` rows per block and rises over 1 + `caveSlope` rows per block. The face is
   * `caveFace` layers high and the mountain climbs to its crest over `caveFaceDepth` rows behind it.
   */
  caveMouthHalf: [3, 5],
  caveRecede: 1.1,
  caveSlope: 0.45,
  caveFace: [17, 23],
  caveFaceDepth: 30,
  /**
   * Valley before a cave mouth (and after its exit), scenario version 9 (user-requested: no artificial walls). Outside the
   * cave rows the mountain climbs from the road (`caveValley[0]`, the road surface) at `caveValley[1..2]` layers per block
   * away from it (per side and along the road, with noise), plus rough noise: valley slopes, rock on the steep parts and
   * soil on the gentle ones, instead of vertical walls right beside the road.
   */
  caveValley: [5, 0.6, 1.5],
  /**
   * Face over a cave mouth (and exit): instead of a vertical plane the size of the mountain, it rises from `caveBrow[0]`
   * layers (just enough rock over the cavern's low mouth) and leans back `caveBrow[1..2]` layers per row into the
   * mountain, with rough noise of `caveBrow[3]` layers, so it climbs in irregular ledges.
   */
  caveBrow: [18, 1.2, 2.6, 4],
  /** Half-width (blocks from the road) over which that face fades into the rest of the mountain. */
  caveBrowHalf: [8, 22],
} as const;

/** Salts of the independent noise fields (derived once per world). */
export interface TerrainSalts {
  height: number;
  hills: number;
  continent: number;
  mountain: number;
  river: number;
  density: number;
  detail: number;
  deco: number;
  ore: number;
  /** Cave sections of this world's road (from the music); empty for a world without a timeline. */
  caves: CaveMask;
}

export function terrainSalts(world: number): TerrainSalts {
  const s = (k: number) => (Math.imul(world ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(k, 0xc2b2ae35)) | 0;
  return { height: s(1), hills: s(2), continent: s(3), mountain: s(4), river: s(5), density: s(6), detail: s(7), deco: s(8), ore: s(9), caves: NO_CAVES };
}

const saltCache = new WeakMap<Seed, TerrainSalts>();
/** The same world with the cave sections of a track: a new object (the road caches are per object). */
export function withCaves(t: TerrainSalts, caves: CaveMask): TerrainSalts {
  return { ...t, caves };
}

/** Terrain salts of a world without caves (memoized per seed object; a pure function of the seed). */
export function saltsFor(worldSeed: Seed): TerrainSalts {
  let t = saltCache.get(worldSeed);
  if (!t) saltCache.set(worldSeed, (t = terrainSalts(saltOf(deriveSeed(worldSeed, 'terrain')))));
  return t;
}

/**
 * Surface description of one column: `h` is the first free layer above the solid ground (the top block is h - 1);
 * `river` is 1 in the middle of a river channel and fades to 0 at its banks; `wet` is whether the column is under water.
 */
export interface Column {
  h: number;
  river: number;
  mountain: number;
  /** Surface slope (rise per block) from the neighbouring columns, set by a caller that has them; absent = gentle. */
  steep?: number;
  /** Strata offset of the column (layers), cached by `rockAt`. */
  strata?: number;
}

const ridged = (v: number) => 1 - Math.abs(v);

/** Distance-like river field: 0 on the river centre line, growing with the distance to it (noise units). */
export function riverField(t: TerrainSalts, x: number, d: number): number {
  // Warp the position so the channels meander instead of following the noise lattice.
  const wx = x + 38 * perlin2(t.river + 11, x / 120, d / 120);
  const wd = d + 38 * perlin2(t.river + 23, x / 120 + 7.3, d / 120);
  return Math.abs(fbm2(t.river, wx / TERRAIN.riverScale, wd / TERRAIN.riverScale, 3));
}

/**
 * Natural column: heights from continents, hills and mountains; rivers carve below the sea level. Near the road the
 * mountains are removed, except over the cave sections, where a mountain ridge rises around the road.
 */
export function columnAt(t: TerrainSalts, x: number, d: number): Column {
  return raiseCaveMountain(t, x, d, baseColumnAt(t, x, d));
}

/**
 * The natural column without the mountain of the cave sections. The road (chunk.ts) cuts and fills this one and only
 * then raises the cave mountain on it (`raiseCaveMountain`), so the cut, made for low hills, never slices that mountain
 * (it used to leave a flat trench ending in a plane wall on the cave's first row).
 */
export function baseColumnAt(t: TerrainSalts, x: number, d: number): Column {
  const cont = fbm2(t.continent, x / TERRAIN.continentScale, d / TERRAIN.continentScale, 3); // -1..1
  const hills = fbm2(t.hills, x / TERRAIN.hillScale, d / TERRAIN.hillScale, 4);
  const ax = Math.abs(x);
  const centre = 1 - smoothstep(TERRAIN.centreClear[0], TERRAIN.centreClear[1], ax);
  const range = centre >= 1 ? 0 : smoothstep(-0.22, 0.12, fbm2(t.mountain, x / TERRAIN.mountainScale, d / TERRAIN.mountainScale, 3) + 0.15 * cont) * (1 - centre);
  let h = TERRAIN.baseHeight + 6 * cont + TERRAIN.hillAmp * hills + (range > 0 ? mountainShape(t, x, d, range) : 0);
  h = lerp(h, Math.min(h, TERRAIN.centreCap), centre);
  // Lakes: low continentalness sinks the land under the sea level (smoothly).
  h -= 9 * smoothstep(-0.18, -0.5, cont);
  // Rivers: carve a channel; the banks slope down to it.
  const rf = riverField(t, x, d);
  const river = 1 - smoothstep(TERRAIN.riverWidth * 0.55, TERRAIN.riverWidth, rf);
  const bank = 1 - smoothstep(TERRAIN.riverWidth, TERRAIN.riverWidth * 2.6, rf);
  h = lerp(h, Math.min(h, TERRAIN.seaY + 1.2), bank * (1 - 0.35 * range));
  h = lerp(h, TERRAIN.seaY - TERRAIN.riverDepth, river);
  return { h: Math.round(softTop(h)), river, mountain: range };
}

/**
 * Heights over `TERRAIN.topKnee` eased toward `TERRAIN.topY` (same value and slope at the knee, never reaching the ceiling),
 * so the highest summits stay pointed instead of being cut flat at the top of the world.
 */
export function softTop(h: number): number {
  const { topKnee: knee, topY: top } = TERRAIN;
  if (h <= knee) return h;
  const room = top - knee;
  return Math.min(top, knee + room * (1 - Math.exp(-(h - knee) / room)));
}

/** Cave section: a natural mountain around the road over it (caveMountain), rough with the peaks noise, on `col`. */
export function raiseCaveMountain(t: TerrainSalts, x: number, d: number, col: Column): Column {
  const w = t.caves.ranges.length > 0 ? caveWeight(t.caves, d) : 0;
  if (w <= 0) return col;
  const ax = Math.abs(x);
  const half = TERRAIN.caveHalf[0] + 8 * perlin2(t.mountain + 5, d / 40, x > 0 ? 1.3 : 6.1);
  const across = 1 - smoothstep(half, TERRAIN.caveHalf[1], ax);
  const shape = caveMountain(t, x, d);
  const m = shape.weight * across;
  let h = col.h, range = col.mountain;
  if (m > 0) {
    // The same generator as every other mountain (fully grown here), never lower than a roof over the cavern.
    const crest = Math.max(TERRAIN.caveRidge[0] + 6 * perlin2(t.height + 3, x / 40, d / 40), TERRAIN.baseHeight + mountainShape(t, x, d, 1));
    const face = TERRAIN.caveFace[0] + (TERRAIN.caveFace[1] - TERRAIN.caveFace[0]) * (0.5 + 0.5 * perlin2(t.height + 9, x / 11, d / 11));
    let target = lerp(face, crest, smoothstep(0, TERRAIN.caveFaceDepth, shape.inside));
    const cave = caveRangeAt(t.caves, d);
    if (cave) {
      // Over the mouth: a face that leans back in rough ledges (never under the rock the cavern needs over it).
      const [base, l0, l1, rough] = TERRAIN.caveBrow;
      const k = Math.min(d - cave[0], cave[1] - 1 - d);
      const lean = lerp(l0, l1, 0.5 + 0.5 * perlin2(t.mountain + 67, x / 19, d > (cave[0] + cave[1]) / 2 ? 3.1 : 8.7));
      const brow = base + lean * k + rough * (perlin2(t.mountain + 69, x / 6, d / 6) + 0.5 * perlin2(t.mountain + 71, x / 2.5, d / 2.5));
      // Only around the mouth: farther out the mountain's edge already comes forward around the road (caveMountain).
      target = lerp(Math.min(target, Math.max(base, brow)), target, smoothstep(TERRAIN.caveBrowHalf[0], TERRAIN.caveBrowHalf[1], ax + 3 * perlin2(t.mountain + 73, d / 9, x > 0 ? 1.7 : 5.3)));
    } else {
      // Before the mouth (after the exit): valley slopes rising from the road instead of walls beside it.
      const [floor, s0, s1] = TERRAIN.caveValley;
      const side = x > 0 ? 4.3 : 7.9;
      const slope = lerp(s0, s1, 0.5 + 0.5 * perlin2(t.mountain + 61, side, d / 37));
      const bank = floor + slope * Math.max(0, ax - 2) + 2.5 * perlin2(t.mountain + 63, x / 7, d / 7) + 1.5 * perlin2(t.mountain + 65, x / 3, d / 3);
      target = Math.min(target, Math.max(floor, bank));
    }
    // `col.h` has already been eased under the ceiling (softTop is not applied twice to it): only the raised height is.
    h = Math.max(h, softTop(lerp(h, target, m)));
    range = Math.max(range, m);
  }
  return { h: Math.round(h), river: w > 0.5 ? col.river * (1 - w) : col.river, mountain: range };
}

const clampUnit = (v: number) => Math.min(1, Math.max(-1, v));

/**
 * Height (layers above the base land) of the mountains at a column, `massif` 0..1 being how much a massif stands there.
 * Inspired by the block game's terrain shaping (not its code): domain-warped noise so ranges bend and branch; erosion
 * sets how tall and rugged a massif is; folded ridge noise (1 - 3 | |r| - 2/3 |) gives ridgelines with valleys between
 * them; every massif gets its own size; pointed peaks rise only on the high ridges of uneroded massifs, as broad as they
 * are tall (`jagScale`), so they grow out of the massif's slopes instead of standing on it like towers.
 */
export function mountainShape(t: TerrainSalts, x: number, d: number, massif: number): number {
  const T = TERRAIN;
  const wx = x + T.warp * perlin2(t.mountain + 31, x / 320, d / 320);
  const wd = d + T.warp * perlin2(t.mountain + 37, x / 320 + 5.1, d / 320 + 2.7);
  const rugged = smoothstep(0.22, -0.22, fbm2(t.mountain + 41, wx / T.erosionScale, wd / T.erosionScale, 3));
  const r = clampUnit(fbm2(t.height, wx / T.ridgeScale, wd / T.ridgeScale, 4) / 0.35);
  const pv = 0.5 + 0.5 * (1 - 3 * Math.abs(Math.abs(r) - 2 / 3)); // 1 on the ridges, 0 in the valleys
  const size = lerp(T.mountainSize[0], T.mountainSize[1], smoothstep(-0.3, 0.3, perlin2(t.mountain + 53, wx / 520, wd / 520)));
  const body = T.mountainAmp * size * (0.25 + 0.75 * Math.pow(pv, 1.4)) * lerp(0.4, 1, rugged);
  const peakZone = rugged * smoothstep(0.55, 0.95, pv);
  // Ridged noise at a scale of about four times its height: the flanks of a peak rise at most about as steeply as the
  // massif's own slopes (rise per block under 1 for most of them), and it is pointed only at its summit.
  const spike = peakZone > 0 ? Math.pow(ridged(clampUnit(fbm2(t.height + 71, wx / T.jagScale, wd / T.jagScale, 3) / 0.3)), 2) : 0;
  return massif * (body + T.jagAmp * size * peakZone * spike);
}

/**
 * Footprint of the mountain of a cave section, per column. Over the road (|x| within caveMouthHalf) its face is a cliff
 * standing exactly on the cave's first (and last) row, with the cave mouth carved in it; farther out the mountain
 * reaches forward around the road (its edge recedes `caveRecede` rows per block, with noise) and rises over a longer
 * slope, so the road enters a natural valley that closes into the cliff. `weight` is 0..1 along the road; `inside` is
 * how many rows the column is behind the mountain's edge (the height grows from the face toward the crest with it).
 */
function caveMountain(t: TerrainSalts, x: number, d: number): { weight: number; inside: number } {
  const ax = Math.abs(x);
  // Only the columns over the road corridor rise straight on the cave's first row (the mouth's lintel); the half-width of
  // that strip wanders a little, and everything beyond it comes forward around the road with its own ragged edge.
  const mouthHalf = lerp(TERRAIN.caveMouthHalf[0], TERRAIN.caveMouthHalf[1], 0.5 + 0.5 * perlin2(t.mountain + 13, x > 0 ? 2.9 : 8.3, d / 60));
  const beyond = Math.max(0, ax - mouthHalf);
  // Each side and each mouth gets its own irregular edge (spurs and bays), so the valley is not a symmetric V.
  const jitter = 20 * (0.5 + 0.5 * fbm2(t.mountain + 17, x / 23, d / 47, 2) / 0.35) * smoothstep(0, 5, beyond);
  const recede = TERRAIN.caveRecede * lerp(0.55, 1.5, 0.5 + 0.5 * perlin2(t.mountain + 19, x > 0 ? 3.7 : 9.1, d / 90));
  const reach = Math.min(CAVE_MASK.approach - 2, Math.max(0, beyond * recede + jitter));
  const rise = Math.min(CAVE_MASK.approach - reach, 1 + TERRAIN.caveSlope * beyond);
  let weight = 0, inside = 0;
  for (const [a, b] of t.caves.ranges) {
    if (d >= a && d < b) {
      weight = 1;
      inside = Math.max(inside, reach + Math.min(d - a, b - 1 - d));
      continue;
    }
    // Rows outside the section: how far before its mouth (or after its exit) the column is, against its own edge.
    const out = d < a ? a - d : d - (b - 1);
    const v = Math.min(1, Math.max(0, (reach + rise - out) / rise));
    if (v > 0) {
      weight = Math.max(weight, v * v * (3 - 2 * v));
      inside = Math.max(inside, reach - out);
    }
  }
  return { weight, inside: Math.max(0, inside) };
}

/** Overhang density bonus on high ground (coarse noise, trilinear by construction of perlin3). */
function overhang(t: TerrainSalts, x: number, y: number, d: number, mountain: number): number {
  // Coarse lattice (4 x 4 x 4 blocks) with a trilinear blend, like the game's interpolated density: 8 corner noises per
  // cell are cached, so a whole segment evaluates each corner once.
  const gx = Math.floor(x / 4), gy = Math.floor(y / 4), gd = Math.floor(d / 4);
  const fx = (x - gx * 4) / 4, fy = (y - gy * 4) / 4, fd = (d - gd * 4) / 4;
  const c = (i: number, j: number, k: number) => corner(t, gx + i, gy + j, gd + k);
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * fx, x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * fx;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * fx, x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * fx;
  const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
  return mountain * 7 * (y0 + (y1 - y0) * fd);
}

const cornerCache = new Map<number, number>();
function corner(t: TerrainSalts, gx: number, gy: number, gd: number): number {
  const key = ((gx + 4096) * 8192 + (gd + 4096)) * 64 + (gy + 8) + t.density * 1e-9;
  const hit = cornerCache.get(key);
  if (hit !== undefined) return hit;
  if (cornerCache.size > 400000) cornerCache.clear();
  const v = perlin3(t.density, gx / 5.5, gy / 3.5, gd / 5.5);
  cornerCache.set(key, v);
  return v;
}

/**
 * How much a column is a cliff (0..1): steep mountain ground. The detailed volume displaces such columns layer by layer
 * (chunk.ts `fillCliff`) so cliffs are not flat walls; decoration skips them. Near the road only around a cave section
 * (`nearCave`): there the face over the cave mouth is a cliff too, and the cave and the corridor are carved after it.
 */
export function cliffWeight(col: Column, x: number, nearCave = false): number {
  const slope = col.steep ?? 0;
  if (slope <= TERRAIN.cliffSlope[0] || col.mountain < 0.15 || col.river > 0.01) return 0;
  const ax = Math.abs(x);
  return smoothstep(TERRAIN.cliffSlope[0], TERRAIN.cliffSlope[1], slope) * (nearCave ? 1 : smoothstep(TERRAIN.cliffRoad, TERRAIN.cliffRoad + 4, ax));
}

/** Slope of a column (rise per block) from its gradient and its largest step to a neighbour (a lone 3-block step is a ledge). */
export function surfaceSlope(gx: number, gd: number, step: number): number {
  return Math.max(Math.hypot(gx, gd), 0.6 * step);
}

/**
 * Rock at layer y: stone with strata of andesite and tuff. The bands are tilted and warped by noise (so they do not run
 * level), each band's rock is picked by hash and its lenses come and go along it, so cliffs, peaks and cave walls show
 * layered rock instead of one uniform stone. Ores stay in the stone.
 */
export function rockAt(t: TerrainSalts, col: Column, x: number, y: number, d: number): number {
  const rock = strataRock(t, col, x, strataBand(t, col, x, y, d), d);
  if (rock !== B.stone) return rock;
  const r = hash01(t.ore, x >> 1, y >> 1, d >> 1);
  if (r < 0.012) return B.coalOre;
  if (r > 0.9965 && y < TERRAIN.seaY + 20) return B.ironOre;
  return B.stone;
}

/** Strata band of layer y in a column (bands are TERRAIN.strata layers thick, offset per column by warp noise). */
export function strataBand(t: TerrainSalts, col: Column, x: number, y: number, d: number): number {
  const off = (col.strata ??= TERRAIN.strataWarp[0] * perlin2(t.ore + 31, x / 70, d / 70) + TERRAIN.strataWarp[1] * perlin2(t.ore + 33, x / 17, d / 17));
  return Math.floor((y + off) / TERRAIN.strata);
}

/** Lowest layer of a strata band in a column (the inverse of `strataBand`). */
export function strataBandBottom(col: Column, band: number): number {
  return Math.ceil(band * TERRAIN.strata - (col.strata ?? 0));
}

/** Rock of a strata band (stone, andesite or tuff; no ores), constant over the band at a column. */
export function strataRock(t: TerrainSalts, _col: Column, x: number, band: number, d: number): number {
  const kind = hash01(t.ore + 37, band, 0);
  if (kind < 0.24 || kind > 0.8) {
    const lens = perlin2(t.ore + 39, x / 38 + band * 3.1, d / 38 - band * 1.7);
    if (kind < 0.24 && lens > -0.15) return B.andesite;
    if (kind > 0.8 && lens > 0.05) return B.tuff;
  }
  return B.stone;
}

/** Blocks under the top one that stay grass on a slope (0 on gentle ground). */
export function grassCover(slope: number): number {
  return slope <= TERRAIN.coverSlope ? 0 : Math.min(TERRAIN.coverMax, Math.round((slope - TERRAIN.coverSlope) * 1.8));
}

/** Natural block at layer y of a column (air above the surface, caves and overhangs excluded). `ground` is the column. */
export function naturalBlock(t: TerrainSalts, col: Column, x: number, y: number, d: number): number {
  if (y < TERRAIN.floorY) return B.stone;
  const top = densityTop(t, col, x, y, d, col.h);
  if (y >= top) return B.air;
  return groundBlock(t, col, x, y, d, top);
}

/**
 * First free layer above the ground at layer y of a column whose surface is `h`: the 3D density, only where the terrain
 * is high enough to have cliffs, raises or cuts the surface locally (-Infinity where it carves layer y out).
 */
export function densityTop(t: TerrainSalts, col: Column, x: number, y: number, d: number, h: number): number {
  let top = h;
  if (col.mountain > 0.15 && col.river < 0.01) {
    const bump = overhang(t, x, y, d, col.mountain);
    if (y >= top - 12 && y < top + 12) top += Math.round(bump * 0.4);
    if (y >= top - 12 && y < top + 12 && bump > 3.2 && y > top - 3) return -Infinity;
  }
  return top;
}

/**
 * Solid block at layer y (below `top`, the first free layer above it) of a column: soil, snow, sand or rock by its depth
 * under `top` and the column's slope. `naturalBlock` passes the column's own surface; a displaced cliff (chunk.ts
 * `fillCliff`) passes the top of each solid run it builds, so its soil and snow lie only on blocks that are exposed.
 */
export function groundBlock(t: TerrainSalts, col: Column, x: number, y: number, d: number, top: number): number {
  const depth = top - 1 - y; // 0 at the top block
  if (depth > TERRAIN.dirtDepth[1]) return rockAt(t, col, x, y, d); // deep rock (the common case)
  const dirtLayers = TERRAIN.dirtDepth[0] + (hash01(t.detail, x, d) < 0.5 ? 0 : 1);
  const surface = top - 1;
  const gravelPatch = hash01(t.detail + 5, x >> 3, d >> 3) < 0.18 && perlin2(t.detail + 9, x / 14, d / 14) > 0.15;
  // River and lake beds, beaches.
  if (surface < TERRAIN.seaY - 5) return depth <= dirtLayers ? B.gravel : rockAt(t, col, x, y, d);
  if (surface <= TERRAIN.seaY + 1 && surface >= TERRAIN.seaY - 4 && (col.mountain < 0.3 || surface < TERRAIN.seaY - 1)) {
    if (depth === 0 && gravelPatch && surface <= TERRAIN.seaY) return B.gravel;
    return depth <= dirtLayers ? B.sand : rockAt(t, col, x, y, d);
  }
  // Land (the block game's surface rules, in spirit): the soil thins with the slope and the altitude, along a threshold
  // that wanders with broad and fine noise, so grass gives way to thin soil, scree and then bare rock organically; snow
  // caps the high tops except on the sheerest faces.
  const slope = col.steep ?? 0;
  const alt = smoothstep(TERRAIN.alpine[0], TERRAIN.alpine[1], surface);
  const effective = slope + 0.45 * perlin2(t.detail + 21, x / 48, d / 48) + 0.3 * perlin2(t.detail + 23, x / 9, d / 9) + TERRAIN.alpineWeight * alt;
  const rock = smoothstep(TERRAIN.rockSlope[0], TERRAIN.rockSlope[1], effective);
  const soil = Math.round((1 - rock) * (dirtLayers + 1)); // blocks of soil, the top one included
  const snowLine = TERRAIN.snowLine + 10 * perlin2(t.detail + 3, x / 34, d / 34);
  const snowy = surface > snowLine && slope < TERRAIN.snowSteep;
  if (depth === 0) {
    if (snowy) return B.snow;
    if (soil === 0) return rockAt(t, col, x, y, d);
    if (soil <= 2) {
      // Thin soil: scree of gravel, coarse dirt up high and in patches, grass elsewhere.
      const scree = perlin2(t.detail + 27, x / 11, d / 11);
      if (scree > 0.22) return B.gravel;
      if (alt > 0.15 || scree < -0.32) return B.coarseDirt;
    }
    return B.grass;
  }
  if (snowy && depth === 1) return B.snow;
  if (depth < soil) {
    if (soil <= 2 && perlin2(t.detail + 27, x / 11, d / 11) > 0.22) return B.gravel;
    // Steep ground: grass over the first blocks under the top one, so the faces of the steps are green, not bare dirt.
    if (grassCover(slope) >= depth && hash01(t.detail + 41, x, y, d) < 0.7) return B.grass;
    return B.dirt;
  }
  return rockAt(t, col, x, y, d);
}
