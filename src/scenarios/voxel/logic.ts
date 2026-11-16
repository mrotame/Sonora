// Voxel Dreamscape (version 3): deterministic logic (no Three.js, no DOM).
// World: the camera rides a straight cobblestone road at a fixed height through a natural block world (sea level,
// hills, mountains, rivers, lakes, one biome). Tunnels cross mountains and arched bridges cross rivers; the camera
// rises and falls with the bridges. The world is made of 1 m blocks, meshed per segment in the Worker.
// Every value is a pure function of the world seed, the timeline and block coordinates, so segments have no seams
// and regenerating a segment reproduces it exactly. Coordinates: x across (the road is x = 0), d = distance along the
// travel axis (the scene maps it to z = -d), y up (the sea surface is y = 0).
import type { Features } from '../../audio/intelligence/timeline.ts';
import { rand, type Seed } from '../../world/identity/seed.ts';
import type { ScenarioLogic, SegmentInput } from '../types.ts';
import { buildVolume } from './chunk.ts';
import { islandContext } from './islands.ts';
import { buildNetherVolume, placePortal } from './nether.ts';
import { meshVolume, type MeshArrays } from './mesher.ts';
import { createVoxelPath, moodAt } from './path.ts';
import { deckLayer, profileAt, ROAD_SURFACE_Y, ROAD } from './road.ts';
import { hourAt, netherAt, scheduleOf } from './schedule.ts';
import { saltsFor } from './terrain.ts';

export interface VoxelSegment {
  /** Opaque blocks (and lava). */
  solid: MeshArrays;
  /** Translucent water surface. */
  water: MeshArrays;
  /** Plants, fences and rails (double sided, cutout). */
  cross: MeshArrays;
  /** Floating islands, one entry per cluster: blocks and plants with lift, drift and phase per vertex. */
  islands: { solid: MeshArrays; cross: MeshArrays }[];
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
}

export interface VoxelParams {
  /** Glowstone brightness pulse with the bass. */
  glowPulse: number;
  /** Water glints with the highs. */
  sparkle: number;
  /** Cloud brightness with the mids. */
  cloudGlow: number;
  /** Drifting cubes: a spin kick and an edge flash on onsets (spectral flux). */
  cubeKick: number;
  cubeGlow: number;
  /** Portals and amethyst: brightness with the energy. */
  energy: number;
  /** Constant per world: varies stars, clouds and cubes between tracks. */
  worldSalt: number;
}

function generateSegment(input: SegmentInput): VoxelSegment {
  const t = saltsFor(input.worldSeed);
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
      if (bd >= startRow - 1 && bd <= startRow + input.length) portalRows.push({ bd, tt: nether ? tt - 1e-3 : tt });
    }
  }

  const { volume, islandVolumes } = buildVolume(t, startRow, input.length, islandContext(input.worldSeed, input.timeline, path, input.speed));
  // Overworld side of every portal: it stands on the road at that row.
  const setWorld = (bx: number, y: number, bd: number, id: number) => {
    const x = bx - volume.ox, z = -bd - 1 - volume.oz, yy = y - volume.oy;
    if (x < 0 || x >= volume.sx || z < 0 || z >= volume.sz || yy < 0 || yy >= volume.sy) return;
    volume.data[x + volume.sx * (z + volume.sz * yy)] = id;
  };
  for (const { bd } of portalRows) placePortal(setWorld, deckLayer(profileAt(t, bd).offset), bd);
  const meshes = meshVolume(volume);
  const islands = islandVolumes.map(({ cluster, volume: v }) => {
    const m = meshVolume(v, [cluster.altitude, cluster.drift, cluster.phase]);
    return { solid: m.solid, cross: m.cross };
  });

  // The Nether: rows whose track time is inside an interval, relative to the rail height of the path.
  let nether: VoxelSegment['nether'] = null;
  if (path && schedule.intervals.length > 0) {
    const offsetAt = (bd: number): number | null => {
      const tt = path.timeAt(bd + 0.5);
      return schedule.intervals.some((iv) => tt >= iv.t0 && tt < iv.t1) ? path.heightAt(tt) : null;
    };
    const portalAt = portalRows.map(({ bd, tt }) => ({ bd, offset: path.heightAt(tt) }));
    const vol = buildNetherVolume(t, startRow, input.length, offsetAt, portalAt);
    if (vol) {
      const m = meshVolume(vol);
      nether = { solid: m.solid, cross: m.cross };
    }
  }

  const tStart = tAt(input.startDistance), tEnd = tAt(input.startDistance + input.length);
  return {
    ...meshes,
    islands,
    nether,
    hour: [hourAt(schedule, tStart), hourAt(schedule, tEnd)],
    nether0: netherAt(schedule, tStart) ? 1 : 0,
    portals,
    mood: [moodAt(input.timeline, tStart), moodAt(input.timeline, tEnd)],
  };
}

function interpret(f: Features, seed: Seed): VoxelParams {
  return {
    glowPulse: 0.8 + 0.5 * f.bass,
    sparkle: 0.2 + 0.8 * f.high,
    cloudGlow: 0.3 + 0.7 * f.mid,
    cubeKick: 0.9 * f.flux,
    cubeGlow: 0.2 + 1.2 * f.flux * f.flux,
    energy: 0.35 + 1.4 * f.energy,
    worldSalt: 1 + 99 * rand(seed, 1),
  };
}

export const voxelLogic: ScenarioLogic<VoxelParams, VoxelSegment> = {
  id: 'voxel-dreamscape',
  // 1: terraced river valley with floating archipelagos. 2: block trees. 3: natural block world (1 m blocks, greedy
  // meshes), cobblestone road with bridges and tunnels, day/night cycle and the Nether.
  version: 3,
  // `speed` is only the fallback for code without a path (tests); the real pace comes from createPath (see path.ts).
  // 6 segments ahead (384 m) cover the fog range; 2 behind keep the view to the sides and back.
  config: {
    segmentLength: 64, speed: 78, segmentsAhead: 6, segmentsBehind: 2, eyeHeight: ROAD_SURFACE_Y + ROAD.eyeAbove, viewDistance: 1500, speedGraph: false,
  },
  createPath: (timeline, worldSeed) => createVoxelPath(timeline, worldSeed),
  interpret,
  generateSegment,
};
