// Voxel Dreamscape (version 3): deterministic logic (no Three.js, no DOM).
// World: the camera rides a straight cobblestone road at a fixed height through a natural block world (sea level,
// hills, mountains, rivers, lakes, one biome). Arched bridges cross rivers and the camera rises and falls with them. The
// music sets three levels: calm passages ride the open road (no mountains near it), medium ones go through a cave
// section inside a mountain, and intense ones go through a portal from that cave into the Nether. The world is made of 1 m blocks, meshed per segment in the Worker.
// Every value is a pure function of the world seed, the timeline and block coordinates, so segments have no seams
// and regenerating a segment reproduces it exactly. Coordinates: x across (the road is x = 0), d = distance along the
// travel axis (the scene maps it to z = -d), y up (the sea surface is y = 0).
import type { Features } from '../../audio/intelligence/timeline.ts';
import { rand, type Seed } from '../../world/identity/seed.ts';
import type { ScenarioLogic, SegmentInput } from '../types.ts';
import { cavePulse, type CavePulse } from './cavePulse.ts';
import { buildVolume } from './chunk.ts';
import { buildFarSegment, FAR, type FarSegment } from './far.ts';
import { buildNetherVolume, NETHER, placePortal } from './nether.ts';
import { isPostRow, netherPostRows } from './netherPosts.ts';
import { LIGHT_REACH } from './light.ts';
import { meshVolume, type MeshArrays } from './mesher.ts';
import { createVoxelPath, moodAt, voxelTerrain } from './path.ts';
import { deckLayer, profileAt, ROAD_SURFACE_Y, ROAD } from './road.ts';
import { hourAt, netherAt, scheduleOf } from './schedule.ts';

export interface VoxelSegment {
  /** Opaque blocks (and lava). */
  solid: MeshArrays;
  /** Translucent water surface. */
  water: MeshArrays;
  /** Plants, fences and rails (double sided, cutout). */
  cross: MeshArrays;
  /** Slow (~20 s) intensity at the segment start and end, 0..1. */
  mood: [number, number];
  /** Hour of the day (0..24) at the segment start and end. */
  hour: [number, number];
  /** Nether blocks of the segment (null when no row of it is in the Nether). */
  nether: { solid: MeshArrays; cross: MeshArrays } | null;
  /** 1 when the segment starts inside the Nether. */
  nether0: number;
  /** Distances (m) of the portals (entries and exits alternate) that lie in the segment. */
  portals: number[];
  /** Pulse of the light blocks around the segment's time span: bass and mids tracks (cavePulse.ts). */
  cavePulse: CavePulse;
}

export interface VoxelParams {
  /** Water glints with the highs. */
  sparkle: number;
  /** Cloud brightness with the mids. */
  cloudGlow: number;
  /** Drifting cubes: a spin kick and an edge flash on onsets (spectral flux). */
  cubeKick: number;
  cubeGlow: number;
  /** Portals: brightness with the energy. */
  energy: number;
  /** Caves: raw energy (the slow breathing of their light), 0..1. */
  caveEnergy: number;
  /** Constant per world: varies stars, clouds and cubes between tracks. */
  worldSalt: number;
}

function generateSegment(input: SegmentInput): VoxelSegment {
  const t = voxelTerrain(input.timeline, input.worldSeed);
  const startRow = input.index * input.length;
  const schedule = scheduleOf(input.timeline);
  const path = input.path;
  const tAt = (d: number) => (path ? path.timeAt(d) : d / input.speed);
  const dAt = (tt: number) => (path ? path.distanceAt(tt) : tt * input.speed);

  // Portals (distance of every entry and exit) and the rows they stand on.
  const portals: number[] = [];
  const portalRows: { bd: number; tt: number }[] = [];
  for (const iv of schedule.intervals) {
    for (const [tt, nether] of [[iv.t0, false], [iv.t1, true]] as const) {
      const d = dAt(tt);
      if (d >= input.startDistance && d < input.startDistance + input.length) portals.push(d);
      const bd = Math.floor(d);
      // Also the rows of the light margin, so a portal next door lights this segment exactly as its own.
      if (bd >= startRow - 1 - LIGHT_REACH && bd <= startRow + input.length + LIGHT_REACH) portalRows.push({ bd, tt: nether ? tt - 1e-3 : tt });
    }
  }

  const { volume } = buildVolume(t, startRow, input.length, LIGHT_REACH);
  // Overworld side of every portal: it stands on the road at that row.
  const setWorld = (bx: number, y: number, bd: number, id: number) => {
    const x = bx - volume.ox, z = -bd - 1 - volume.oz, yy = y - volume.oy;
    if (x < 0 || x >= volume.sx || z < 0 || z >= volume.sz || yy < 0 || yy >= volume.sy) return;
    volume.data[x + volume.sx * (z + volume.sz * yy)] = id;
  };
  for (const { bd } of portalRows) placePortal(setWorld, deckLayer(profileAt(t, bd).offset), bd);
  const meshes = meshVolume(volume);

  // The Nether: rows whose track time is inside an interval, relative to the rail height of the path, and a level tail of
  // NETHER.exitTail rows past every exit portal (at the rail height of the exit, never into the next visit), so the
  // cavern goes on behind the exit portal up to the haze. Only seen from inside the Nether: past the portal the scene
  // shows the overworld.
  let nether: VoxelSegment['nether'] = null;
  if (path && schedule.intervals.length > 0) {
    const tails = schedule.intervals.map((iv, k) => {
      const d1 = dAt(iv.t1), next = schedule.intervals[k + 1];
      return { d1, end: Math.min(d1 + NETHER.exitTail, next ? dAt(next.t0) : Infinity), offset: path.heightAt(iv.t1 - 1e-3) };
    });
    const offsetAt = (bd: number): number | null => {
      const tt = path.timeAt(bd + 0.5);
      if (schedule.intervals.some((iv) => tt >= iv.t0 && tt < iv.t1)) return path.heightAt(tt);
      const tail = tails.find((v) => bd + 0.5 >= v.d1 && bd + 0.5 < v.end);
      return tail ? tail.offset : null;
    };
    const portalAt = portalRows.map(({ bd, tt }) => ({ bd, offset: path.heightAt(tt) }));
    // Light posts on the rows the camera passes on a beat (netherPosts.ts).
    const posts = netherPostRows(input.timeline, path);
    const vol = buildNetherVolume(t, startRow, input.length, offsetAt, portalAt, LIGHT_REACH, (bd) => isPostRow(posts, bd));
    if (vol) {
      const m = meshVolume(vol, null, false); // no sky in the Nether: only block light
      nether = { solid: m.solid, cross: m.cross };
    }
  }

  const tStart = tAt(input.startDistance), tEnd = tAt(input.startDistance + input.length);
  return {
    ...meshes,
    nether,
    hour: [hourAt(schedule, tStart), hourAt(schedule, tEnd)],
    nether0: netherAt(schedule, tStart) ? 1 : 0,
    portals,
    mood: [moodAt(input.timeline, tStart), moodAt(input.timeline, tEnd)],
    cavePulse: cavePulse(input.timeline, tStart, tEnd),
  };
}

function interpret(f: Features, seed: Seed): VoxelParams {
  return {
    sparkle: 0.2 + 0.8 * f.high,
    cloudGlow: 0.3 + 0.7 * f.mid,
    cubeKick: 0.9 * f.flux,
    cubeGlow: 0.2 + 1.2 * f.flux * f.flux,
    energy: 0.35 + 1.4 * f.energy,
    caveEnergy: f.energy,
    worldSalt: 1 + 99 * rand(seed, 1),
  };
}

export const voxelLogic: ScenarioLogic<VoxelParams, VoxelSegment> = {
  id: 'voxel-dreamscape',
  // 1: terraced river valley with floating archipelagos (removed in 11). 2: block trees. 3: natural block world (1 m blocks, greedy
  // meshes), cobblestone road with bridges and tunnels, day/night cycle and the Nether. 4: flood-filled sky and block
  // light (0..15) with smooth lighting. 5: far-field terrain (distant mountains, about 1.3 km of view). 6: three
  // section levels (open road, caves, Nether); no mountains near the road outside the caves. 7: section scale over the
  // music only, levels at 50% (caves) and 70% (Nether); the cave mountain is natural, with the mouth in its face.
  // 8: natural mountains (erosion, folded ridges, per-massif size, jagged peaks, snow and bare stone), up to layer 160;
  // far field with 2-block cells next to the detailed band, then 4 and 8. 9: natural mountain surfaces (soil thinning
  // with slope and altitude, scree, rock strata of stone, andesite and tuff, also in the far field) and cliffs displaced
  // into ledges; the road cut no longer slices the cave mountain, which meets the road in valley slopes and a face that
  // leans back over the mouth. 10: far field with trees (boxes of trunk and crown in the fine cells, a leaf canopy of
  // varying height in the coarse ones) and occlusion at the foot of its walls. 11: no floating islands. 12: mountains
  // covered with grass (also on steep faces) and wooded up to the snow line, in the detailed and the far terrain. 13: spruce forest (cone trees) only on the extremely distant mountains (far field, 576+ blocks from the road); the near and middle ground keep the ordinary forest.
  // 13: cave lava only on the floor, in places it could not run from (no fluid flow): none on walls or over a drop.
  // 14: detailed volume widened to 32 chunks (512 blocks) each side and 48 chunks (12 segments) ahead.
  // 15: the Nether rebuilt as the classic Nether Wastes (game density lattice, lava sea, lava falls, glowstone clusters); rails, bridge and path unchanged.
  // 16: the Nether rails climb and descend with the music (steepest descents fastest) instead of only descending.
  // 17: detailed volume reduced to 32 chunks (8 segments = 512 blocks) ahead and 24 chunks (384 blocks) to each side; the
  // fog is derived from the detailed volume (scene.ts FOG_RANGE: 173..384 m), so it closes where the detailed terrain ends; the far field (4 segments of 256 ahead, 896 blocks to each side) shrinks too.
  // 18: mountains without towers: peaks as broad as they are tall (jagged blades of 6 blocks removed), heights eased under
  // the ceiling instead of cut flat at it, and cliffs displaced by a shift bounded by their slope (no holes, slits or loose
  // blocks; soil and snow only on exposed blocks); the wide cave-mouth shift only near the mouth.
  // 19: Nether rails ramp between levels (the block game's ascending rail, tilted 45 degrees) and single-row pits in the
  // deck are raised, so the track is continuous.
  // 20: the Nether goes on for NETHER.exitTail rows past the exit portal (level at the exit's rail height), so it no
  // longer ends at the portal frame.
  // 21: light posts stand on the Nether bridge (nether-brick fence) instead of hanging in mid-air, each holding a redstone
  // lamp switched on and off by the beats, with its light in its own channel. The overworld posts are unchanged (glowstone).
  // 22: the Nether post lamps are always lit (an ordinary light source), and the posts stand on the rows the camera passes
  // on a beat (it leaves the screen 80..150 ms after the beat), about 16 rows apart (netherPosts.ts).
  // 24: caves hold amethyst crystals (bass: hanging clusters, mids: bud with spike, highs: single buds) and glowstone lamps
  // (mids and highs) that pulse with their band, never on the open road; the Nether has more lava falls and glowstone
  // clusters, and its light posts follow the bass beat (every 2nd or 3rd beat when the beats are fast, never bunched up).
  // 25: pulsed light blocks, dark between pulses: cave redstone on the bass beats, cave glowstone (ceiling and wall lamps)
  // on the mids hits; Nether glowstone (denser clusters) on the bass, Nether lava falls on the mids (the sea stays steady).
  // 26: (tried: the pulsed blocks following the live level of their band; reverted in 27, it lit them by default).
  // 27: pulsed blocks almost dark between pulses with a stronger peak and a 70 ms attack; the cave redstone is binary,
  // lit from each bass beat while its note lasts (at most 0.3 s), dark otherwise and with no wave.
  // 28: no beat detection for the pulsed blocks: like the Synthwave mountains and sun they follow the level of their band
  // every frame, over its local floor (dark by default, every hit flashes); the redstone is on while that bass pulse is
  // high; no wave from the camera. Peak and dark levels unchanged.
  // 29: brighter caves (block light 0.5 -> 0.7), lower glowstone and redstone peaks (1.9, 2.0), half as many Nether lava
  // falls, 40% of them steadily lit.
  // 30: no cave redstone ore; the cave ceiling glowstone and every Nether lava fall are steady (only the cave wall lamps
  // and the Nether glowstone follow the music); brighter caves (block light 0.7 -> 0.9).
  // 31: a bridge arch never reaches into a cave section (it used to be cut short at the mouth, dropping the deck and the
  // camera 2-3 blocks in one row) and rises at most one block per row; the camera no longer pitches with the road (the
  // block game's level view), so the Nether posts, placed by when they leave the screen, move with it.
  // 32: smaller glowstone clusters under the low Nether overhangs near the bridge (NETHER.lowGlow), so no stretch of a
  // visit is left without glowstone in view where the rock hides the high roofs.
  version: 32,
  // `speed` is only the fallback for code without a path (tests); the real pace comes from createPath (see path.ts).
  // The detailed segments: 8 ahead (512 m = 32 chunks), 2 behind, 384 blocks (24 chunks) to each side (TERRAIN.halfWidth).
  // Beyond them the far field (far.ts) carries the terrain to the end of the fog; the far plane covers its corners.
  config: {
    segmentLength: 64, speed: 17, segmentsAhead: 8, segmentsBehind: 2, eyeHeight: ROAD_SURFACE_Y + ROAD.eyeAbove, viewDistance: 1500,
    pathTilt: ROAD.cameraTilt,
  },
  farField: {
    config: { segmentLength: FAR.segmentLength, segmentsAhead: FAR.segmentsAhead, segmentsBehind: FAR.segmentsBehind },
    generateSegment: (input): FarSegment => buildFarSegment(voxelTerrain(input.timeline, input.worldSeed), input.startDistance, input.length, 64),
  },
  createPath: (timeline, worldSeed) => createVoxelPath(timeline, worldSeed),
  interpret,
  generateSegment,
};
