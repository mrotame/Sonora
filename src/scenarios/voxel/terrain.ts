// Voxel Dreamscape: natural terrain of the overworld (pure, no Three.js, no DOM). Alpha/Beta style: a sea level, fbm
// heights with hills and mountains, a coarse 3D density for overhangs on high ground, meandering rivers and lakes.
// Everything is a pure function of the terrain salt and block coordinates, so any column can be evaluated in any
// segment. Coordinates: bx = block column across (centre of block bx is x = bx), bd = block row along the travel
// axis, by = block layer (block by covers y in [by, by + 1]); the sea surface is the top of layer SEA_Y - 1.
import { deriveSeed, type Seed } from '../../world/identity/seed.ts';
import { B } from './blocks.ts';
import { fbm2, hash01, lerp, perlin2, perlin3, saltOf, smoothstep } from './noise.ts';

export const TERRAIN = {
  /** Water fills every air block below this layer (the top water block is layer SEA_Y - 1). */
  seaY: 0,
  /** Lowest generated layer. */
  floorY: -24,
  /** Highest generated layer of the natural terrain. */
  topY: 64,
  /** Half-width (blocks) of the generated world around the road. */
  halfWidth: 96,
  /** Typical dry land height above the sea. */
  baseHeight: 5,
  hillAmp: 9,
  mountainAmp: 44,
  /** Horizontal scales (blocks). */
  hillScale: 70,
  continentScale: 260,
  mountainScale: 150,
  riverScale: 320,
  /** Rivers: width of the channel in noise units (|noise| below this is river) and its depth below the sea. */
  riverWidth: 0.02,
  riverDepth: 4,
  /** Layers of dirt under the grass. */
  dirtDepth: [3, 4],
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
}

export function terrainSalts(world: number): TerrainSalts {
  const s = (k: number) => (Math.imul(world ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(k, 0xc2b2ae35)) | 0;
  return { height: s(1), hills: s(2), continent: s(3), mountain: s(4), river: s(5), density: s(6), detail: s(7), deco: s(8), ore: s(9) };
}

const saltCache = new WeakMap<Seed, TerrainSalts>();
/** Terrain salts of a world (memoized per seed object; a pure function of the seed). */
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
}

const ridged = (v: number) => 1 - Math.abs(v);

/** Distance-like river field: 0 on the river centre line, growing with the distance to it (noise units). */
export function riverField(t: TerrainSalts, x: number, d: number): number {
  // Warp the position so the channels meander instead of following the noise lattice.
  const wx = x + 38 * perlin2(t.river + 11, x / 120, d / 120);
  const wd = d + 38 * perlin2(t.river + 23, x / 120 + 7.3, d / 120);
  return Math.abs(fbm2(t.river, wx / TERRAIN.riverScale, wd / TERRAIN.riverScale, 3));
}

/** Natural column: heights from continents, hills and mountains; rivers carve below the sea level. */
export function columnAt(t: TerrainSalts, x: number, d: number): Column {
  const cont = fbm2(t.continent, x / TERRAIN.continentScale, d / TERRAIN.continentScale, 3); // -1..1
  const hills = fbm2(t.hills, x / TERRAIN.hillScale, d / TERRAIN.hillScale, 4);
  const range = smoothstep(-0.05, 0.4, fbm2(t.mountain, x / TERRAIN.mountainScale, d / TERRAIN.mountainScale, 3) + 0.15 * cont);
  const peaks = ridged(fbm2(t.height, x / 55, d / 55, 3));
  let h = TERRAIN.baseHeight + 6 * cont + TERRAIN.hillAmp * hills + range * (TERRAIN.mountainAmp * (0.35 + 0.65 * peaks));
  // Lakes: low continentalness sinks the land under the sea level (smoothly).
  h -= 9 * smoothstep(-0.18, -0.5, cont);
  // Rivers: carve a channel; the banks slope down to it.
  const rf = riverField(t, x, d);
  const river = 1 - smoothstep(TERRAIN.riverWidth * 0.55, TERRAIN.riverWidth, rf);
  const bank = 1 - smoothstep(TERRAIN.riverWidth, TERRAIN.riverWidth * 2.6, rf);
  h = lerp(h, Math.min(h, TERRAIN.seaY + 1.2), bank * (1 - 0.35 * range));
  h = lerp(h, TERRAIN.seaY - TERRAIN.riverDepth, river);
  return { h: Math.round(h), river, mountain: range };
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

/** Natural block at layer y of a column (air above the surface, caves and overhangs excluded). `ground` is the column. */
export function naturalBlock(t: TerrainSalts, col: Column, x: number, y: number, d: number): number {
  if (y < TERRAIN.floorY) return B.stone;
  // 3D density only where the terrain is high enough to have cliffs: raises or cuts the surface locally.
  let top = col.h;
  if (col.mountain > 0.15 && col.river < 0.01) {
    const bump = overhang(t, x, y, d, col.mountain);
    if (y >= top - 12 && y < top + 12) top += Math.round(bump * 0.4);
    if (y >= top - 12 && y < top + 12 && bump > 3.2 && y > top - 3) return B.air;
  }
  if (y >= top) return B.air;
  const depth = top - 1 - y; // 0 at the top block
  if (depth > TERRAIN.dirtDepth[1]) {
    // Deep stone (the common case): only ores need a hash.
    const r = hash01(t.ore, x >> 1, y >> 1, d >> 1);
    if (r < 0.012) return B.coalOre;
    if (r > 0.9965 && y < TERRAIN.seaY + 20) return B.ironOre;
    return B.stone;
  }
  const dirtLayers = TERRAIN.dirtDepth[0] + (hash01(t.detail, x, d) < 0.5 ? 0 : 1);
  const beach = top - 1 <= TERRAIN.seaY + 1 && top - 1 >= TERRAIN.seaY - 4 && col.mountain < 0.3;
  const gravelPatch = hash01(t.detail + 5, x >> 3, d >> 3) < 0.18 && perlin2(t.detail + 9, x / 14, d / 14) > 0.15;
  if (depth === 0) {
    if (top - 1 < TERRAIN.seaY - 5) return B.gravel; // river and lake beds
    if (top - 1 < TERRAIN.seaY - 1) return gravelPatch ? B.gravel : B.sand;
    if (beach) return gravelPatch && top - 1 <= TERRAIN.seaY ? B.gravel : B.sand;
    if (top - 1 > 42 + 6 * perlin2(t.detail + 3, x / 30, d / 30)) return B.stone; // bare peaks
    return B.grass;
  }
  if (depth <= dirtLayers) {
    if (top - 1 < TERRAIN.seaY - 5) return B.gravel;
    if (top - 1 <= TERRAIN.seaY + 1 && top - 1 >= TERRAIN.seaY - 4) return B.sand;
    if (top - 1 > 42) return B.stone;
    return B.dirt;
  }
  // Ores in stone: sparse blobs by hash of a coarse cell.
  const r = hash01(t.ore, x >> 1, y >> 1, d >> 1);
  if (r < 0.012) return B.coalOre;
  if (r > 0.9965 && y < TERRAIN.seaY + 20) return B.ironOre;
  return B.stone;
}
