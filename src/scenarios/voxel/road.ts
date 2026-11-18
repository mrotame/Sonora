// Voxel Dreamscape: the road (pure, no Three.js, no DOM). A straight 3-block cobblestone road along x = 0 at a fixed
// height, with a cleared corridor. Where the natural terrain gets in the way it adapts like a road built by a player:
//   - land: cut through low hills, embankment over low ground;
//   - bridge: a river or small lake crossing the road gets an arched oak and cobblestone bridge; the road (and the
//     camera with it) rises and falls with the arch;
//   - causeway: a flat deck on pillars over a wide lake;
//   - cave: inside a cave section of the music (caveMask.ts) the road runs level through a wide cavern carved in the
//     mountain that rises around it there (chunk.ts); the centre of the map has no other mountains, so no tunnels.
// The profile is a pure function of the world's terrain salts and the distance d, cached per chunk, and is the single
// source for both the camera (`bridgeOffsetAt`) and the segment generator (`profileAt`).
import { caveRangeAt } from './caveMask.ts';
import { columnAt, TERRAIN, type TerrainSalts } from './terrain.ts';

export const ROAD = {
  /** Layer of the road blocks (the surface is its top, y = layer + 1) and the camera height above the surface (m). */
  layer: 4,
  eyeAbove: 2.2,
  /**
   * Share of the slope angle the camera pitches by (ScenarioConfig.pathTilt): 0, the block game's walk, where the view stays
   * level on steps, bridges and Nether ramps (scenario version 31, user-requested). The Nether posts (netherPosts.ts) use it too.
   */
  cameraTilt: 0,
  /** Road blocks span bx in [-halfWidth, halfWidth]. */
  halfWidth: 1,
  /** Bridge deck: planks to |bx| <= planksHalf, cobblestone beams and fence railings at |bx| = deckHalf. */
  planksHalf: 2,
  deckHalf: 3,
  /** Free corridor: half-width and height above the surface (blocks). */
  clearHalf: 2,
  clearHeight: 6,
  /** Within this many blocks of the centre the terrain never rises above the road surface; beyond it, it may rise this much per block. */
  flatHalf: 10,
  cutSlope: 1,
  /** Beyond this distance (blocks) the terrain is fully natural. */
  influence: 72,
  /** Bridges: longest arched span, margin on each bank, arch height range and pillar spacing (blocks). */
  maxArchSpan: 120,
  bankMargin: 5,
  archHeight: [3, 7],
  pillarSpacing: 9,
  /** Steepest rise of an arch (layers per row), under 1 so the deck never skips a step. */
  maxArchRise: 0.9,
  /** Light posts: spacing along the road and distance from the centre line. */
  postSpacing: 24,
  postX: 3,
  postHeight: 6,
} as const;

export const RoadKind = { Land: 0, Bridge: 1, Causeway: 2, Cave: 3 } as const;
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

// Per terrain object: a world with the cave sections of a track is its own object (see `terrainOf` in path.ts).
const cache = new WeakMap<TerrainSalts, Map<number, Chunk>>();

function buildChunk(t: TerrainSalts, index: number): Chunk {
  const start = index * CHUNK;
  const lo = start - HALO, n = CHUNK + 2 * HALO;
  const ground = new Int16Array(n);
  for (let i = 0; i < n; i++) ground[i] = columnAt(t, 0, lo + i).h;
  const kind = new Uint8Array(n);
  const offset = new Float32Array(n);

  // Pointwise kinds first: the rows of a cave section are cave whatever the ground (its mountain covers them).
  for (let i = 0; i < n; i++) {
    const g = ground[i]!;
    kind[i] = caveRangeAt(t.caves, lo + i) ? RoadKind.Cave : g <= TERRAIN.seaY ? RoadKind.Bridge : RoadKind.Land;
  }
  // Merge short gaps inside a kind (a road does not dip in and out of a bridge).
  const closeGaps = (k: number, gap: number) => {
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (kind[i] !== k) continue;
      if (last >= 0 && i - last > 1 && i - last <= gap) for (let j = last + 1; j < i; j++) if (kind[j] === RoadKind.Land) kind[j] = k;
      last = i;
    }
  };
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
    // The bank margins never reach into a cave section: the cave floor is level at the base height, so an arch cut short
    // there used to drop the deck (and the camera) 2-3 blocks in one row at the mouth when a river ran against it. With
    // the margin stopped at the mouth the arch is shaped over the rows it really has and comes down to the cave's level.
    let a = Math.max(0, i - ROAD.bankMargin), b = Math.min(n - 1, j + ROAD.bankMargin);
    while (a < i && kind[a] === RoadKind.Cave) a++;
    while (b > j && kind[b] === RoadKind.Cave) b--;
    const length = b - a + 1;
    if (length > ROAD.maxArchSpan) {
      for (let k = i; k <= j; k++) kind[k] = RoadKind.Causeway;
      continue;
    }
    // The steepest rise of peak * sin^2 over `length` rows is pi * peak / length: kept under one block per row (a short
    // arch cut at a cave mouth would otherwise skip steps), so the deck climbs at most one layer between rows.
    const peak = Math.min(ROAD.archHeight[1], Math.max(ROAD.archHeight[0], length / 6), (ROAD.maxArchRise * length) / Math.PI);
    for (let k = a; k <= b; k++) {
      offset[k] = Math.max(offset[k]!, peak * Math.sin((Math.PI * (k - a + 0.5)) / length) ** 2);
      if (kind[k] === RoadKind.Land) kind[k] = RoadKind.Bridge; // bank margin: the arch rises from the bank
    }
  }
  return { offset: offset.slice(HALO, HALO + CHUNK), kind: kind.slice(HALO, HALO + CHUNK) };
}

function chunkOf(t: TerrainSalts, d: number): { chunk: Chunk; at: number } {
  const index = Math.floor(d / CHUNK);
  let perWorld = cache.get(t);
  if (!perWorld) cache.set(t, (perWorld = new Map()));
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
