// Voxel Dreamscape: deterministic logic (no Three.js, no DOM).
// World: the camera glides low over a straight river through a valley of terraced voxel banks. The signature: whole
// pieces of the banks break off and float up as archipelagos; the more intense the music where the camera meets
// them, the more of them break off and the higher they rise. They carry trees, crystals and portals.
// Every value is a pure function of the world seed, the timeline and world-space coordinates, so segments have no
// seams and regenerating a segment reproduces it exactly. Coordinates: x across (0 = river centre), d = distance
// along the travel axis (the scene maps it to z = -d), y up (the water is at y = 0).
import type { Features, Timeline } from '../../audio/intelligence/timeline.ts';
import { deriveSeed, rand, rand2, type Seed } from '../../world/identity/seed.ts';
import type { ScenarioLogic, SegmentInput, TrackPath } from '../types.ts';
import { createVoxelPath, islandIntensityAt, moodAt } from './path.ts';

/** Banks: a grid of voxel columns. */
export const BANKS = {
  /** Horizontal voxel size (m) and vertical terrace step (m). */
  cell: 5,
  step: 2.5,
  /** The banks reach this far to each side; the valley walls there hide the end of the generated world. */
  halfWidth: 230,
  /** Half-width of the river: base value and how much its edge wanders. The camera (x = 0) always stays over water. */
  riverHalf: 15,
  riverWander: 6,
  /** Height at the river edge, and how much the valley rises toward its walls. */
  shoreHeight: 2.5,
  valleyRise: 70,
  noiseScale: 45,
  noiseAmp: 16,
  /** Depth of the column below its top (bottom of the box), so steps never show a gap. */
  skirt: 12,
  treeChance: 0.035,
  crystalChance: 0.004,
} as const;

/** Archipelagos (the signature). Clusters are cells of a coarse world-space grid; each is one island piece. */
export const ISLANDS = {
  clusterSize: 64,
  /** Island radius range (m). */
  radius: [14, 30],
  /** Share of clusters that break off: from calm (0) to most intense (1). */
  density: [0.1, 0.75],
  /** Altitude (m) of the island above its original position: from calm to most intense. The minimum keeps the
   * thickest island bottom well above the camera when it drifts over the river. */
  altitude: [45, 140],
  /** Per-island altitude spread (multiplier range). */
  altitudeSpread: [0.8, 1.3],
  /** Rock below the island top: thicker in the centre (stalactite shape). */
  thickness: [3, 26],
  /** While rising, islands also drift toward the river by this share of their distance (at most `driftMax`). */
  drift: 0.4,
  driftMax: 70,
  /** Clusters whose centre is closer than this to the river centre do not break off (they would be mostly water). */
  minCentreX: 30,
  portalChance: [0.3, 0.7],
  crystalChance: 0.55,
  treeChance: 0.1,
} as const;

/**
 * Box kinds in the segment buffers. One box = one instanced unit cube placed and sized by the scene shader.
 * Layout (BOX_STRIDE floats): x, d, y0, y1, sx, sd, kind, lift, drift, phase.
 */
export const BOX_STRIDE = 10;
export const KIND = { rock: 0, trunk: 1, canopy: 2, crystal: 3, portalFrame: 4, portalCore: 5, cherryCanopy: 6 } as const;

/** Trees: built from leaf and log blocks like a block game, in a few archetypes with per-tree variation. */
export const TREES = {
  /** Size of one leaf / log block (m). Keeps tree sizes close to the earlier single-box canopies (5 to 10 m). */
  block: 1.25,
  cherryChance: 0.15,
  /** Leaf boxes stay at least this far (m) from the river centre, which the camera follows. */
  riverClearance: 8,
} as const;

export interface VoxelSegment {
  /** Bank columns and trees on the banks (static ground group). */
  ground: Float32Array;
  /** Floating archipelagos: island rock and the trees on them (signature group). */
  islands: Float32Array;
  /** Portals and crystals, on islands (lifted with them) and rarely on the banks (luminous structures group). */
  glow: Float32Array;
  /** Slow (~20 s) intensity at the segment start and end (horizon group), 0..1. */
  mood: [number, number];
}

export interface VoxelParams {
  // Ground (banks): seams between voxels glow with the bass.
  groundGlow: number;
  // River: sparkling glints with the highs.
  riverSparkle: number;
  // Aurora and sky: curtain brightness and reach with the mids.
  auroraGlow: number;
  auroraReach: number;
  // Drifting cubes: a spin kick and an edge flash on onsets (spectral flux).
  cubeKick: number;
  cubeGlow: number;
  // Portals and crystals (luminous structures): brightness with the energy.
  portalGlow: number;
  /** Constant per world: varies stars, cubes and horizon between tracks. */
  worldSalt: number;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const smoothstep = (a: number, b: number, x: number) => smooth(Math.min(1, Math.max(0, (x - a) / (b - a))));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function valueNoise(seed: Seed, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = smooth(x - ix), fz = smooth(z - iz);
  const a = rand2(seed, ix, iz), b = rand2(seed, ix + 1, iz);
  const c = rand2(seed, ix, iz + 1), e = rand2(seed, ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + e) * fx * fz;
}

function fbm(seed: Seed, x: number, z: number): number {
  let sum = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 3; o++) {
    sum += amp * valueNoise(seed, x * freq + o * 31, z * freq);
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / 0.875;
}

/** Half-width of the river at distance d (continuous, always above riverHalf - riverWander). */
export function riverHalfAt(seed: Seed, d: number): number {
  return BANKS.riverHalf + BANKS.riverWander * (valueNoise(seed, d / 90, 3.5) * 2 - 1);
}

/** Terraced bank height at a column centre (multiple of `step`), or 0 where the column is under the river. */
export function bankHeight(terrainSeed: Seed, x: number, d: number): number {
  const ax = Math.abs(x);
  const edge = riverHalfAt(terrainSeed, d);
  if (ax < edge) return 0;
  const valley = Math.pow(smoothstep(edge, BANKS.halfWidth, ax), 1.4) * BANKS.valleyRise;
  const n = fbm(terrainSeed, x / BANKS.noiseScale, d / BANKS.noiseScale);
  const near = smoothstep(edge, edge + 25, ax); // low shore right by the water
  const h = BANKS.shoreHeight + valley + near * BANKS.noiseAmp * n;
  return Math.max(BANKS.step, Math.round(h / BANKS.step) * BANKS.step);
}

/** One archipelago: a coarse grid cell whose piece of bank breaks off, decided at the time the camera reaches it. */
export interface Cluster {
  cx: number;
  cd: number;
  radius: number;
  /** Final altitude (m) above its original position, 0 when it does not break off. */
  altitude: number;
  thickness: number;
  phase: number;
  id: number;
  intensity: number;
}

function clusterIndexId(i: number, j: number): number {
  return (Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) | 0;
}

/** Cluster for coarse cell (i, j) along x and d. Pure: the same cell always gives the same island. */
export function clusterAt(islandSeed: Seed, timeline: Timeline, path: TrackPath | undefined, speed: number, i: number, j: number): Cluster {
  const id = clusterIndexId(i, j);
  const C = ISLANDS.clusterSize;
  const cx = (i + 0.2 + 0.6 * rand(islandSeed, id)) * C;
  const cd = (j + 0.2 + 0.6 * rand(islandSeed, id + 1)) * C;
  const t = path ? path.timeAt(cd) : cd / speed;
  const intensity = islandIntensityAt(timeline, t);
  const radius = lerp(ISLANDS.radius[0], ISLANDS.radius[1], rand(islandSeed, id + 2));
  const density = lerp(ISLANDS.density[0], ISLANDS.density[1], intensity);
  const breaks = Math.abs(cx) >= ISLANDS.minCentreX && Math.abs(cx) + radius < BANKS.halfWidth - 10 && rand(islandSeed, id + 3) < density;
  const spread = lerp(ISLANDS.altitudeSpread[0], ISLANDS.altitudeSpread[1], rand(islandSeed, id + 4));
  const altitude = breaks ? lerp(ISLANDS.altitude[0], ISLANDS.altitude[1], intensity) * spread : 0;
  const thickness = lerp(ISLANDS.thickness[0] + 8, ISLANDS.thickness[1], rand(islandSeed, id + 5));
  return { cx, cd, radius, altitude, thickness, phase: rand(islandSeed, id + 6), id, intensity };
}

/** Lateral drift toward the river of an island centred at cx (negative = toward x = 0 on the right bank). */
export function driftFor(cx: number): number {
  return -Math.sign(cx) * Math.min(Math.abs(cx) * ISLANDS.drift, ISLANDS.driftMax);
}

class BoxWriter {
  private data: number[] = [];
  push(x: number, d: number, y0: number, y1: number, sx: number, sd: number, kind: number, lift = 0, drift = 0, phase = 0): void {
    this.data.push(x, d, y0, y1, sx, sd, kind, lift, drift, phase);
  }
  build(): Float32Array {
    return Float32Array.from(this.data);
  }
}

// `phase` drives the slow bob of lifted boxes (so everything on one island must share the island's phase) and the
// time offset of the per-box animations (canopy sway, crystal and portal pulses).

type TreeShape = 'oak' | 'round' | 'wide';

/**
 * A block tree standing on y = top: a log trunk and a canopy of leaf blocks on a TREES.block grid. Three archetypes:
 * - oak: the classic small tree (two 5x5 layers with random missing corners, a 3x3 layer that may lean, a plus on top);
 * - round: a big lumpy crown (one main blob and 1 to 3 smaller ones held by branches), roots at the base;
 * - wide: a flat crown of jagged disc layers on a 2x2 trunk.
 * Leaves are collected per layer and merged into as few boxes as possible (greedy rectangles of whole blocks).
 */
function tree(out: BoxWriter, seed: Seed, n: number, x: number, d: number, top: number, lift: number, drift: number, phase: number): void {
  const B = TREES.block;
  const r = (k: number) => rand(seed, Math.imul(n, 64) + k);
  /** Stable value per block of this tree. */
  const cell = (i: number, j: number, k: number) => rand2(seed, Math.imul(n, 131) + i * 977 + k * 7919, j + 4096);

  const roll = r(0);
  let shape: TreeShape = roll < 0.45 ? 'oak' : roll < 0.75 ? 'round' : 'wide';
  const roundR = 2.6 + 1.4 * r(1), wideR = 3.2 + 1.6 * r(1);
  const reach = (shape === 'round' ? roundR * 1.6 + 1.5 : shape === 'wide' ? wideR + 2 : 3) * B;
  if (Math.abs(x) - reach < TREES.riverClearance) shape = 'oak';

  const w = shape === 'wide' || (shape === 'round' && r(2) < 0.3) ? 2 : 1; // trunk width in blocks
  const ci = (w - 1) / 2; // crown centre in block coordinates; the trunk covers blocks 0..w-1
  const H = (shape === 'round' ? 5 : shape === 'oak' ? 4 : 3) + Math.floor(3 * r(3)); // trunk height in blocks
  const leafKind = r(4) < TREES.cherryChance ? KIND.cherryCanopy : KIND.canopy;
  const bx = (i: number) => x + (i - ci) * B, bd = (j: number) => d + (j - ci) * B, by = (k: number) => top + k * B;

  const OFF = 16, SPAN = 2 * OFF + 1;
  const key = (i: number, j: number) => (i + OFF) * SPAN + (j + OFF);
  const logs = new Set<number>();
  const layers = new Map<number, Set<number>>();
  const leaf = (i: number, j: number, k: number) => {
    if (k < 1 || Math.abs(i) >= OFF || Math.abs(j) >= OFF || logs.has(key(i, j) + k * SPAN * SPAN)) return;
    let layer = layers.get(k);
    if (!layer) layers.set(k, (layer = new Set()));
    layer.add(key(i, j));
  };
  const log = (i0: number, j0: number, k0: number, wi: number, wj: number, hk: number, height = hk * B) => {
    for (let i = i0; i < i0 + wi; i++) for (let j = j0; j < j0 + wj; j++) for (let k = k0; k < k0 + hk; k++) logs.add(key(i, j) + k * SPAN * SPAN);
    out.push(bx(i0 + (wi - 1) / 2), bd(j0 + (wj - 1) / 2), by(k0), by(k0) + height, wi * B, wj * B, KIND.trunk, lift, drift, phase);
  };

  log(0, 0, 0, w, w, H);

  if (shape === 'oak') {
    const leanRoll = r(5), side = r(6) < 0.5 ? 1 : -1;
    const li = leanRoll < 0.25 ? side : 0, lj = leanRoll >= 0.25 && leanRoll < 0.5 ? side : 0;
    for (let k = H - 2; k <= H + 1; k++) {
      const upper = k >= H;
      const rad = upper ? 1 : 2;
      for (let i = -rad; i <= rad; i++) {
        for (let j = -rad; j <= rad; j++) {
          const corner = Math.abs(i) === rad && Math.abs(j) === rad;
          if (corner && (k === H + 1 || cell(i, j, k) < 0.5)) continue;
          leaf(i + (upper ? li : 0), j + (upper ? lj : 0), k);
        }
      }
    }
    if (r(7) < 0.4) leaf(li, lj, H + 2);
  } else if (shape === 'round') {
    const blobs: [number, number, number, number, number][] = [[ci, ci, H + 1, roundR, roundR * 0.8]];
    const subs = 1 + Math.floor(3 * r(8));
    for (let s = 0; s < subs; s++) {
      const a = 6.2831853 * (r(9) + s / subs);
      const dist = roundR * (0.75 + 0.35 * r(10 + s));
      const ca = Math.cos(a), sa = Math.sin(a);
      const k = H - 0.5 + 2 * r(14 + s);
      blobs.push([ci + ca * dist, ci + sa * dist, k, roundR * 0.6, roundR * 0.5]);
      // A branch from the trunk toward the blob, along its dominant axis; mostly hidden in the leaves.
      const len = Math.max(1, Math.round(dist - 1));
      const k0 = Math.max(2, Math.floor(k) - 1);
      if (Math.abs(ca) > Math.abs(sa)) log(ca > 0 ? w : -len, 0, k0, len, 1, 1);
      else log(0, sa > 0 ? w : -len, k0, 1, len, 1);
    }
    for (const [cx, cz, cy, rh, rv] of blobs) {
      for (let i = Math.floor(cx - rh - 1); i <= Math.ceil(cx + rh + 1); i++) {
        for (let j = Math.floor(cz - rh - 1); j <= Math.ceil(cz + rh + 1); j++) {
          for (let k = Math.floor(cy - rv - 1); k <= Math.ceil(cy + rv + 1); k++) {
            const q = ((i - cx) / rh) ** 2 + ((j - cz) / rh) ** 2 + ((k - cy) / rv) ** 2;
            if (q < 1 + 0.45 * (cell(i, j, k) - 0.5)) leaf(i, j, k);
          }
        }
      }
    }
    // Roots: half-height log blocks flaring out at the base of a thin trunk.
    if (w === 1) {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
      for (let s = 0; s < 4; s++) if (r(20 + s) < 0.55) log(dirs[s]![0], dirs[s]![1], 0, 1, 1, 1, B * 0.5);
    }
  } else {
    // The disc edge is mostly shared by all layers, so the crown reads as stepped cliffs of leaves.
    const layerR = [wideR - 1.3, wideR, wideR - 0.4, wideR - 1.9];
    for (let l = 0; l < layerR.length; l++) {
      const k = H - 1 + l, R = layerR[l]!;
      const lo = Math.floor(ci - R - 1), hi = Math.ceil(ci + R + 1);
      for (let i = lo; i <= hi; i++) {
        for (let j = lo; j <= hi; j++) {
          const edge = R + 1.1 * (cell(i, j, 0) - 0.5) + 0.4 * (cell(i, j, k) - 0.5);
          if (Math.hypot(i - ci, j - ci) < edge) leaf(i, j, k);
        }
      }
    }
    for (let i = -2; i <= 3; i++) for (let j = -2; j <= 3; j++) if (Math.hypot(i - ci, j - ci) < wideR - 2.2 && cell(i, j, 99) > 0.7) leaf(i, j, H + 3);
  }

  // Greedy merge per layer: grow a run along i, then extend it along j while the whole run is free.
  for (const k of [...layers.keys()].sort((a, b) => a - b)) {
    const cells = layers.get(k)!;
    const used = new Set<number>();
    const free = (i: number, j: number) => cells.has(key(i, j)) && !used.has(key(i, j));
    for (let j = 1 - OFF; j < OFF; j++) {
      for (let i = 1 - OFF; i < OFF; i++) {
        if (!free(i, j)) continue;
        let wi = 1;
        while (free(i + wi, j)) wi++;
        let wj = 1;
        for (;;) {
          let ok = true;
          for (let t = 0; t < wi && ok; t++) ok = free(i + t, j + wj);
          if (!ok) break;
          wj++;
        }
        for (let a = 0; a < wi; a++) for (let b = 0; b < wj; b++) used.add(key(i + a, j + b));
        out.push(bx(i + (wi - 1) / 2), bd(j + (wj - 1) / 2), by(k), by(k + 1), wi * B, wj * B, leafKind, lift, drift, phase);
      }
    }
  }
}

/** A thin glowing crystal pillar standing on y = top. */
function crystal(out: BoxWriter, seed: Seed, n: number, x: number, d: number, top: number, lift: number, drift: number, phase: number): void {
  const h = 6 + 14 * rand(seed, n);
  const w = 1.2 + 1.6 * rand(seed, n + 1);
  out.push(x, d, top - 1, top + h, w, w, KIND.crystal, lift, drift, phase);
}

/** A voxel portal arch (two posts, a lintel and a glowing core) facing the river, standing on y = top. */
function portal(out: BoxWriter, seed: Seed, n: number, x: number, d: number, top: number, lift: number, drift: number, phase: number): void {
  const w = 7 + 5 * rand(seed, n);
  const h = 10 + 8 * rand(seed, n + 1);
  const post = 1.8;
  out.push(x, d - w / 2, top - 1, top + h, post, post, KIND.portalFrame, lift, drift, phase);
  out.push(x, d + w / 2, top - 1, top + h, post, post, KIND.portalFrame, lift, drift, phase);
  out.push(x, d, top + h, top + h + post, post, w + post, KIND.portalFrame, lift, drift, phase);
  out.push(x, d, top, top + h, 0.4, w - post, KIND.portalCore, lift, drift, phase);
}

function generateSegment(input: SegmentInput): VoxelSegment {
  const terrainSeed = deriveSeed(input.worldSeed, 'terrain');
  const islandSeed = deriveSeed(input.worldSeed, 'islands');
  const propSeed = deriveSeed(input.worldSeed, 'props');
  const treeSeed = deriveSeed(input.worldSeed, 'trees');
  const { timeline, path, speed } = input;
  const C = ISLANDS.clusterSize;
  const cell = BANKS.cell;
  const ground = new BoxWriter(), islands = new BoxWriter(), glow = new BoxWriter();

  // Clusters that can reach this segment, memoized for this call only.
  const clusters = new Map<string, Cluster>();
  const getCluster = (i: number, j: number) => {
    const key = `${i},${j}`;
    let c = clusters.get(key);
    if (!c) clusters.set(key, (c = clusterAt(islandSeed, timeline, path, speed, i, j)));
    return c;
  };
  /** Breaking cluster this column belongs to, if any (nearest centre among the 3x3 neighbourhood, irregular edge). */
  const islandOf = (x: number, d: number): { c: Cluster; w: number } | null => {
    const i0 = Math.floor(x / C), j0 = Math.floor(d / C);
    let best: { c: Cluster; w: number } | null = null;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const c = getCluster(i0 + di, j0 + dj);
        if (c.altitude === 0) continue;
        const edge = c.radius * (0.7 + 0.6 * valueNoise(islandSeed, x / 11 + c.id * 0.01, d / 11));
        const dist = Math.hypot(x - c.cx, d - c.cd);
        if (dist < edge) {
          const w = 1 - dist / edge;
          if (!best || w > best.w) best = { c, w };
        }
      }
    }
    return best;
  };

  // Columns are owned by the segment containing their centre, so neighbours never duplicate or miss one.
  const rowStart = Math.ceil(input.startDistance / cell - 0.5);
  const rowEnd = Math.ceil((input.startDistance + input.length) / cell - 0.5);
  const cols = Math.round(BANKS.halfWidth / cell);
  for (let r = rowStart; r < rowEnd; r++) {
    const d = (r + 0.5) * cell;
    for (let c = -cols; c < cols; c++) {
      const x = (c + 0.5) * cell;
      const h = bankHeight(terrainSeed, x, d);
      if (h === 0) continue; // river
      const n = Math.imul(r, 4099) ^ c;
      const island = islandOf(x, d);
      if (island) {
        const { c: cl, w } = island;
        // The island takes the top of the column, thicker in the centre (stalactite). Where it is thicker than the
        // column, the whole column leaves and the water fills the hole; the part below y = 0 is hidden by the river
        // until it rises, so the island and the stub left behind never overlap above the water.
        const thick = Math.max(BANKS.step, Math.round((ISLANDS.thickness[0] + (cl.thickness - ISLANDS.thickness[0]) * Math.pow(w, 0.7)) / BANKS.step) * BANKS.step);
        const cut = h - thick;
        if (cut > 0) ground.push(x, d, -BANKS.skirt, cut, cell, cell, KIND.rock);
        const drift = driftFor(cl.cx);
        islands.push(x, d, cut, h, cell, cell, KIND.rock, cl.altitude, drift, cl.phase);
        if (w > 0.3 && rand2(propSeed, c, r) < ISLANDS.treeChance) tree(islands, treeSeed, n, x, d, h, cl.altitude, drift, cl.phase);
        continue;
      }
      // A box costs the same whatever its height, so every column reaches below the water: no gaps between steps.
      ground.push(x, d, -BANKS.skirt, h, cell, cell, KIND.rock);
      const pick = rand2(propSeed, c, r);
      if (pick < BANKS.treeChance && h < 40) tree(ground, treeSeed, n, x, d, h, 0, 0, rand(propSeed, n * 7 + 5));
      else if (pick > 1 - BANKS.crystalChance) crystal(glow, propSeed, n * 7 + 3, x, d, h, 0, 0, rand(propSeed, n * 7 + 6));
    }
  }

  // Props at the island centres: each breaking cluster whose centre lies in this segment owns its portal and crystals.
  const j0 = Math.floor(input.startDistance / C) - 1, j1 = Math.floor((input.startDistance + input.length) / C) + 1;
  const i1 = Math.ceil(BANKS.halfWidth / C);
  for (let j = j0; j <= j1; j++) {
    for (let i = -i1; i <= i1; i++) {
      const cl = getCluster(i, j);
      if (cl.altitude === 0 || cl.cd < input.startDistance || cl.cd >= input.startDistance + input.length) continue;
      const top = bankHeight(terrainSeed, cl.cx, cl.cd);
      if (top === 0) continue;
      const drift = driftFor(cl.cx);
      const n = cl.id * 13;
      if (rand(propSeed, n) < lerp(ISLANDS.portalChance[0], ISLANDS.portalChance[1], cl.intensity)) {
        portal(glow, propSeed, n + 1, cl.cx, cl.cd, top, cl.altitude, drift, cl.phase);
      }
      if (rand(propSeed, n + 5) < ISLANDS.crystalChance) {
        const count = 1 + Math.floor(3 * rand(propSeed, n + 6));
        for (let k = 0; k < count; k++) {
          const a = 6.2831853 * rand(propSeed, n + 10 + k);
          const rr = cl.radius * 0.45 * rand(propSeed, n + 20 + k) + 4;
          const x = cl.cx + Math.cos(a) * rr, d = cl.cd + Math.sin(a) * rr;
          const h = bankHeight(terrainSeed, x, d);
          if (h > 0) crystal(glow, propSeed, n + 30 + k * 3, x, d, h, cl.altitude, drift, cl.phase);
        }
      }
    }
  }

  const tAt = (d: number) => (path ? path.timeAt(d) : d / speed);
  return {
    ground: ground.build(),
    islands: islands.build(),
    glow: glow.build(),
    mood: [moodAt(timeline, tAt(input.startDistance)), moodAt(timeline, tAt(input.startDistance + input.length))],
  };
}

function interpret(f: Features, seed: Seed): VoxelParams {
  return {
    groundGlow: 0.15 + 0.85 * f.bass,
    riverSparkle: 0.2 + 0.8 * f.high,
    auroraGlow: 0.35 + 0.9 * f.mid,
    auroraReach: 0.5 + 0.5 * f.mid,
    cubeKick: 0.9 * f.flux,
    cubeGlow: 0.2 + 1.2 * f.flux * f.flux,
    portalGlow: 0.35 + 1.4 * f.energy,
    worldSalt: 1 + 99 * rand(seed, 1),
  };
}

export const voxelLogic: ScenarioLogic<VoxelParams, VoxelSegment> = {
  id: 'voxel-dreamscape',
  // 1: first version (terraced river valley, floating archipelagos driven by the slow intensity, music-driven pace).
  // 2: block trees (oak, round and wide archetypes made of leaf and log blocks) instead of one box per canopy.
  version: 2,
  // `speed` is only the fallback for code without a path (tests); the real pace comes from createPath (see path.ts).
  // 14 segments ahead (1.12 km) cover the fog range even at the 600 km/h maximum.
  // 3 segments behind: with the widest look and field of view the view reaches slightly backward to the banks.
  config: { segmentLength: 80, speed: 78, segmentsAhead: 14, segmentsBehind: 3, eyeHeight: 3, viewDistance: 4000, speedGraph: false },
  createPath: (timeline) => createVoxelPath(timeline),
  interpret,
  generateSegment,
};
