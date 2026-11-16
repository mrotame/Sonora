// Voxel Dreamscape: the road (pure, no Three.js, no DOM). A straight 3-block cobblestone road along x = 0 at a fixed
// height, with a cleared corridor. Where the natural terrain gets in the way it adapts like a road built by a player:
//   - land: cut through low hills, embankment over low ground;
//   - bridge: a river or small lake crossing the road gets an arched oak and cobblestone bridge; the road (and the
//     camera with it) rises and falls with the arch;
//   - causeway: a flat deck on pillars over a wide lake;
//   - tunnel: a 5 x 4 tunnel through mountains;
// The profile is a pure function of the world's terrain salts and the distance d, cached per chunk, and is the single
// source for both the camera (`bridgeOffsetAt`) and the segment generator (`profileAt`).
import { columnAt, TERRAIN, type TerrainSalts } from './terrain.ts';

export const ROAD = {
  /** Layer of the road blocks (the surface is its top, y = layer + 1) and the camera height above the surface (m). */
  layer: 4,
  eyeAbove: 2.2,
  /** Road blocks span bx in [-halfWidth, halfWidth]. */
  halfWidth: 1,
  /** Bridge deck: planks to |bx| <= planksHalf, cobblestone beams and fence railings at |bx| = deckHalf. */
  planksHalf: 2,
  deckHalf: 3,
  /** Free corridor: half-width and height above the surface (blocks). */
  clearHalf: 2,
  clearHeight: 6,
  /** The terrain on each side may rise this much above the road per block of distance from the corridor. */
  cutSlope: 1,
  /** Tunnel interior half-width (blocks); it is 4 blocks tall. */
  tunnelHalf: 2,
  /** Natural ground above this height over the road (layers above the road layer) becomes a tunnel. */
  tunnelAbove: 9,
  /** Bridges: longest arched span, margin on each bank, arch height range and pillar spacing (blocks). */
  maxArchSpan: 120,
  bankMargin: 5,
  archHeight: [3, 7],
  pillarSpacing: 9,
  /** Light posts: spacing along the road and distance from the centre line. */
  postSpacing: 24,
  postX: 3,
  postHeight: 6,
} as const;

export const RoadKind = { Land: 0, Bridge: 1, Causeway: 2, Tunnel: 3 } as const;
export type RoadKind = (typeof RoadKind)[keyof typeof RoadKind];

/** World height (m) of the road surface at offset 0. */
export const ROAD_SURFACE_Y = ROAD.layer + 1;

const CHUNK = 128;
const HALO = 200;

interface Chunk {
  /** Arch rise (m, continuous) of the road over the base height, for d = start .. start + CHUNK - 1 (block rows). */
  offset: Float32Array;
  kind: Uint8Array;
}

const cache = new Map<number, Map<number, Chunk>>();

function buildChunk(t: TerrainSalts, index: number): Chunk {
  const start = index * CHUNK;
  const lo = start - HALO, n = CHUNK + 2 * HALO;
  const ground = new Int16Array(n);
  for (let i = 0; i < n; i++) ground[i] = columnAt(t, 0, lo + i).h;
  const kind = new Uint8Array(n);
  const offset = new Float32Array(n);

  // Pointwise kinds first.
  for (let i = 0; i < n; i++) {
    const g = ground[i]!;
    kind[i] = g <= TERRAIN.seaY ? RoadKind.Bridge : g > ROAD.layer + ROAD.tunnelAbove ? RoadKind.Tunnel : RoadKind.Land;
  }
  // Merge short gaps inside a kind (a road does not dip in and out of a tunnel), and extend tunnels so the portals sit
  // inside the hill.
  const closeGaps = (k: number, gap: number) => {
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (kind[i] !== k) continue;
      if (last >= 0 && i - last > 1 && i - last <= gap) for (let j = last + 1; j < i; j++) if (kind[j] === RoadKind.Land) kind[j] = k;
      last = i;
    }
  };
  closeGaps(RoadKind.Tunnel, 14);
  closeGaps(RoadKind.Bridge, 6);

  // Bridge runs (with a bank margin on each side): short ones are arched, long ones become flat causeways. Runs are
  // found first and applied after, so the margins of one run are not mistaken for a new run.
  const runs: [number, number][] = [];
  for (let i = 0; i < n;) {
    if (kind[i] !== RoadKind.Bridge) { i++; continue; }
    let j = i;
    while (j + 1 < n && kind[j + 1] === RoadKind.Bridge) j++;
    runs.push([i, j]);
    i = j + 1;
  }
  for (const [i, j] of runs) {
    const a = Math.max(0, i - ROAD.bankMargin), b = Math.min(n - 1, j + ROAD.bankMargin);
    const length = b - a + 1;
    if (length > ROAD.maxArchSpan) {
      for (let k = i; k <= j; k++) kind[k] = RoadKind.Causeway;
      continue;
    }
    const peak = Math.min(ROAD.archHeight[1], Math.max(ROAD.archHeight[0], length / 6));
    for (let k = a; k <= b; k++) {
      offset[k] = Math.max(offset[k]!, peak * Math.sin((Math.PI * (k - a + 0.5)) / length) ** 2);
      if (kind[k] === RoadKind.Land) kind[k] = RoadKind.Bridge; // bank margin: the arch rises from the bank
    }
  }
  return { offset: offset.slice(HALO, HALO + CHUNK), kind: kind.slice(HALO, HALO + CHUNK) };
}

function chunkOf(t: TerrainSalts, d: number): { chunk: Chunk; at: number } {
  const index = Math.floor(d / CHUNK);
  let perWorld = cache.get(t.height);
  if (!perWorld) {
    // Bounded: a world only ever needs the chunks near the camera; old worlds are dropped.
    if (cache.size > 4) cache.clear();
    cache.set(t.height, (perWorld = new Map()));
  }
  let chunk = perWorld.get(index);
  if (!chunk) {
    if (perWorld.size > 64) perWorld.clear();
    perWorld.set(index, (chunk = buildChunk(t, index)));
  }
  return { chunk, at: d - index * CHUNK };
}

/** Kind and arch rise of the road at block row bd. */
export function profileAt(t: TerrainSalts, bd: number): { kind: RoadKind; offset: number } {
  const { chunk, at } = chunkOf(t, Math.floor(bd));
  return { kind: chunk.kind[at]! as RoadKind, offset: chunk.offset[at]! };
}

/** Continuous arch rise (m) at distance d (linear between block rows); the camera's `heightAt`. */
export function bridgeOffsetAt(t: TerrainSalts, d: number): number {
  const x = d - 0.5;
  const i = Math.floor(x), f = x - i;
  const a = profileAt(t, i).offset, b = profileAt(t, i + 1).offset;
  return a + (b - a) * f;
}

/** Rise over run of the arch at distance d. */
export function bridgeSlopeAt(t: TerrainSalts, d: number): number {
  return (bridgeOffsetAt(t, d + 1) - bridgeOffsetAt(t, d - 1)) / 2;
}

/** Layer of the road blocks (the deck) at block row bd. */
export const deckLayer = (offset: number): number => ROAD.layer + Math.round(offset);
