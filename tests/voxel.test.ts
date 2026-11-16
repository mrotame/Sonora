import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../src/audio/analysis/analyze.ts';
import { Timeline } from '../src/audio/intelligence/timeline.ts';
import { voxelLogic, type VoxelSegment } from '../src/scenarios/voxel/logic.ts';
import { PACE, createVoxelPath, islandIntensityAt } from '../src/scenarios/voxel/path.ts';
import { B } from '../src/scenarios/voxel/blocks.ts';
import { buildVolume } from '../src/scenarios/voxel/chunk.ts';
import { ISLANDS, clusterAt, islandContext } from '../src/scenarios/voxel/islands.ts';
import { meshVolume } from '../src/scenarios/voxel/mesher.ts';
import { ROAD, ROAD_SURFACE_Y, RoadKind, bridgeOffsetAt, profileAt } from '../src/scenarios/voxel/road.ts';
import { SCHEDULE, hourAt, netherAt, scheduleOf } from '../src/scenarios/voxel/schedule.ts';
import { TERRAIN, columnAt, saltsFor } from '../src/scenarios/voxel/terrain.ts';
import { createWorldSeed, deriveSeed } from '../src/world/identity/seed.ts';
import type { SegmentInput } from '../src/scenarios/types.ts';

const SR = 22050;
/** Synthetic track: a quiet tone with loud noisy passages at the given [from, to) seconds. */
function track(passages: [number, number][], duration: number): Timeline {
  const left = new Float32Array(duration * SR);
  let s = 12345;
  for (let i = 0; i < left.length; i++) {
    const t = i / SR;
    s = (Math.imul(s, 1103515245) + 12345) | 0;
    const noise = ((s >>> 8) / 16777216) * 2 - 1;
    const loud = passages.some(([a, b]) => t >= a && t < b);
    left[i] = loud ? 0.5 * noise + 0.3 * Math.sin(2 * Math.PI * 80 * t) : 0.03 * Math.sin(2 * Math.PI * 220 * t);
  }
  return new Timeline(analyzeTrack(left, left, SR));
}

const timeline = track([[20, 45]], 80);
const seedOf = (key: string) => createWorldSeed({ audioIdentity: key.repeat(64), scenarioId: voxelLogic.id, scenarioVersion: voxelLogic.version });
const worldSeed = seedOf('a');
const path = createVoxelPath(timeline, worldSeed);
const L = voxelLogic.config.segmentLength;

function input(index: number, seed = worldSeed, p = path, tl = timeline): SegmentInput {
  return { index, startDistance: index * L, length: L, worldSeed: seed, seed: deriveSeed(seed, 'segment', index), timeline: tl, speed: voxelLogic.config.speed, path: p };
}

test('voxel: a segment is reproducible and independent of generation order', () => {
  const a = voxelLogic.generateSegment(input(5));
  voxelLogic.generateSegment(input(12));
  const b = voxelLogic.generateSegment(input(5));
  assert.deepEqual(a, b);
});

test('voxel: different worlds differ', () => {
  const other = seedOf('b');
  const a = voxelLogic.generateSegment(input(3));
  const b = voxelLogic.generateSegment(input(3, other, createVoxelPath(timeline, other)));
  assert.notDeepEqual(a.solid.vertices, b.solid.vertices);
});

test('voxel: the volume at the seams is the same from both sides (no gaps, no duplicates)', () => {
  const t = saltsFor(worldSeed);
  const left = buildVolume(t, 10 * L, L).volume;
  const right = buildVolume(t, 11 * L, L).volume;
  // Left rows 11L (its padding row) and right row 11L (its first row) must hold the same blocks, and so for 11L - 1 / 12L.
  let compared = 0;
  for (const bd of [11 * L - 1, 11 * L]) {
    for (let x = -20; x <= 20; x++) {
      for (let y = -4; y < 30; y++) {
        const get = (v: typeof left) => v.data[(x - v.ox) + v.sx * ((-bd - 1 - v.oz) + v.sz * (y - v.oy))];
        assert.equal(get(left), get(right), `block (${x}, ${y}, ${bd}) differs between neighbours`);
        compared++;
      }
    }
  }
  assert.ok(compared > 1000);
});

test('voxel: the camera volume above the road is free of solid blocks, except at portals', () => {
  const t = saltsFor(worldSeed);
  const portalRows = new Set<number>();
  for (const iv of scheduleOf(timeline).intervals) for (const tt of [iv.t0, iv.t1]) portalRows.add(Math.floor(path.distanceAt(tt)));
  for (let index = 0; index < 40; index++) {
    const { volume: v } = buildVolume(t, index * L, L);
    for (let bd = index * L; bd < (index + 1) * L; bd++) {
      if ([...portalRows].some((p) => Math.abs(p - bd) <= 1)) continue;
      const deck = ROAD.layer + Math.round(profileAt(t, bd).offset);
      for (const x of [-1, 0, 1]) {
        for (let y = deck + 1; y <= deck + 4; y++) {
          const id = v.data[(x - v.ox) + v.sx * ((-bd - 1 - v.oz) + v.sz * (y - v.oy))]!;
          assert.ok(id === B.air, `solid block ${id} in the corridor at x=${x} y=${y} d=${bd}`);
        }
      }
    }
  }
});

test('voxel: rivers cross the road, and the road over them is a bridge that the camera rides', () => {
  const t = saltsFor(worldSeed);
  let wet = 0, bridge = 0, maxRise = 0;
  for (let d = 0; d < 6000; d++) {
    if (columnAt(t, 0, d).h <= TERRAIN.seaY) wet++;
    const { kind } = profileAt(t, d);
    if (kind === RoadKind.Bridge) bridge++;
    maxRise = Math.max(maxRise, bridgeOffsetAt(t, d));
    // A bridge row is never plain land under water: wet ground on the road line is always bridge or causeway.
    if (columnAt(t, 0, d).h <= TERRAIN.seaY) assert.ok(kind === RoadKind.Bridge || kind === RoadKind.Causeway, `wet row ${d} is ${kind}`);
  }
  assert.ok(wet > 0 && bridge >= wet, `wet ${wet} bridge ${bridge}`);
  assert.ok(maxRise >= ROAD.archHeight[0] - 0.5, `the arch rises (${maxRise})`);
  // The camera height follows the arch.
  let rode = false;
  for (let d = 0; d < 6000 && !rode; d += 2) {
    if (bridgeOffsetAt(t, d) > 3) {
      assert.ok(Math.abs(path.heightAt(path.timeAt(d)) - bridgeOffsetAt(t, d)) < 1e-6 || netherAt(scheduleOf(timeline), path.timeAt(d)) !== null);
      rode = true;
    }
  }
  assert.ok(rode);
});

test('voxel: road blocks are cobblestone on land and the camera sits above them', () => {
  const t = saltsFor(worldSeed);
  const { volume: v } = buildVolume(t, 0, L);
  let found = 0;
  for (let bd = 0; bd < L; bd++) {
    if (profileAt(t, bd).kind !== RoadKind.Land) continue;
    const id = v.data[(0 - v.ox) + v.sx * ((-bd - 1 - v.oz) + v.sz * (ROAD.layer - v.oy))]!;
    assert.equal(id, B.cobblestone);
    found++;
  }
  assert.ok(found > 0, 'the first segment has road on land');
  assert.ok(voxelLogic.config.eyeHeight > ROAD_SURFACE_Y);
});

test('voxel: the mesher merges flat faces and culls hidden ones', () => {
  const n = 12;
  const data = new Uint8Array(n * n * n);
  for (let z = 2; z <= 9; z++) for (let x = 2; x <= 9; x++) data[x + n * (z + n * 3)] = B.stone;
  const m = meshVolume({ data, sx: n, sy: n, sz: n, ox: 0, oy: 0, oz: 0 });
  // 8 x 8 x 1 slab in open air: the top and the four sides are one quad each; the underside is split into rings because
  // the sky light fades toward its centre (as under any roof).
  const perFace = new Array<number>(6).fill(0);
  for (let i = 0; i < m.solid.vertices.length; i += 28) perFace[m.solid.vertices[i + 6]! % 8]!++;
  assert.deepEqual([perFace[0], perFace[1], perFace[2], perFace[4], perFace[5]], [1, 1, 1, 1, 1]);
  assert.ok(perFace[3]! > 1 && perFace[3]! < 64, 'the underside merges into a few light rings, not 64 quads');
});

test('voxel: pace keeps the overworld scale (100..600 km/h, cruise 280, ends at 50 km/h)', () => {
  const speed = (t: number) => (path.distanceAt(t + 0.05) - path.distanceAt(t - 0.05)) / 0.1;
  for (let t = 1; t < 18; t += 1) {
    const kmh = speed(t) * 3.6;
    assert.ok(kmh >= PACE.minKmh - 1 && kmh <= PACE.maxKmh + 1, `${kmh} km/h at ${t}s`);
  }
  const end = timeline.musicEndS + 4;
  assert.ok(Math.abs(speed(end) * 3.6 - PACE.endKmh) < 2);
});

test('voxel: timeAt inverts distanceAt', () => {
  for (const t of [0.5, 5, 22, 33, 60]) assert.ok(Math.abs(path.timeAt(path.distanceAt(t)) - t) < 1e-3);
});

test('voxel: archipelagos grow with the slow intensity', () => {
  const calm = islandIntensityAt(timeline, 8), intense = islandIntensityAt(timeline, 32);
  assert.ok(intense > calm + 0.3);
  const count = (t0: number, t1: number) => {
    let n = 0;
    // Only the clusters are counted (a cheap pure function), not whole segments.
    const ctx = islandContext(worldSeed, timeline, path, voxelLogic.config.speed);
    const j0 = Math.floor(path.distanceAt(t0) / ISLANDS.clusterSize), j1 = Math.floor(path.distanceAt(t1) / ISLANDS.clusterSize);
    for (let j = j0; j < j1; j++) for (let i = -2; i <= 2; i++) if (clusterAt(ctx, i, j).altitude > 0) n++;
    return n;
  };
  assert.ok(count(18, 40) > count(0, 15), 'more islands break off in the intense passage');
});

test('voxel schedule: one intense passage gives one Nether visit, entered while intense and left at night', () => {
  const s = scheduleOf(timeline);
  assert.equal(s.intervals.length, 1);
  const iv = s.intervals[0]!;
  assert.ok(iv.t0 > 19 && iv.t0 < 26 && iv.t1 > 40 && iv.t1 <= timeline.musicEndS);
  assert.equal(hourAt(s, 0), SCHEDULE.startHour);
  assert.equal(hourAt(s, iv.t1 + 0.1), SCHEDULE.lastExitHour);
  assert.equal(hourAt(s, timeline.musicEndS), SCHEDULE.lastExitHour);
  assert.ok(netherAt(s, (iv.t0 + iv.t1) / 2) !== null && netherAt(s, 5) === null && netherAt(s, iv.t1 + 1) === null);
});

test('voxel schedule: several visits spread the exit hours, ending at night; none keeps the day short', () => {
  const tl = track([[15, 30], [45, 60], [75, 90]], 110);
  const s = scheduleOf(tl);
  assert.equal(s.intervals.length, 3);
  const hours = s.intervals.map((i) => i.exitHour);
  assert.deepEqual(hours, [9, 15, 21]);
  assert.ok(s.intervals.every((iv, k) => k === 0 || iv.t0 - s.intervals[k - 1]!.t1 >= SCHEDULE.minOverworldS));
  const calm = scheduleOf(track([], 60));
  assert.equal(calm.intervals.length, 0);
  assert.ok(hourAt(calm, 60) <= SCHEDULE.idleEndHour + 1e-9 && hourAt(calm, 60) > SCHEDULE.startHour);
});

test('voxel schedule: music that ends intense leaves the Nether before the end', () => {
  const tl = track([[20, 40], [70, 90]], 90);
  const s = scheduleOf(tl);
  const last = s.intervals[s.intervals.length - 1]!;
  assert.ok(last.t1 < tl.musicEndS, `exit ${last.t1} before the end ${tl.musicEndS}`);
  assert.equal(last.exitHour, SCHEDULE.lastExitHour);
});

test('voxel path: the Nether descends fast, the overworld stays level; leaving returns to the road', () => {
  const iv = scheduleOf(timeline).intervals[0]!;
  assert.equal(path.heightAt(iv.t0 - 1), bridgeOffsetAt(saltsFor(worldSeed), path.distanceAt(iv.t0 - 1)));
  const mid = (iv.t0 + iv.t1) / 2;
  assert.ok(path.heightAt(mid) < -100, `a net descent (${path.heightAt(mid)})`);
  assert.ok(path.slopeAt(mid) < -0.2);
  const speedAt = (t: number) => (path.distanceAt(t + 0.05) - path.distanceAt(t - 0.05)) / 0.1;
  assert.ok(speedAt(mid) > speedAt(iv.t0 - 3) * 1.2, 'faster in the Nether');
  assert.ok(Math.abs(path.heightAt(iv.t1 + 0.1)) < 12);
});

test('voxel: Nether blocks (and rails) exist only in segments of the Nether', () => {
  const iv = scheduleOf(timeline).intervals[0]!;
  const inside = Math.floor(path.distanceAt((iv.t0 + iv.t1) / 2) / L);
  const outside = Math.floor(path.distanceAt(5) / L);
  assert.ok(voxelLogic.generateSegment(input(inside)).nether !== null);
  assert.equal(voxelLogic.generateSegment(input(outside)).nether, null);
});

test('voxel: segment descriptors carry the baked hour and portals', () => {
  const iv = scheduleOf(timeline).intervals[0]!;
  const index = Math.floor(path.distanceAt(iv.t0) / L);
  const seg: VoxelSegment = voxelLogic.generateSegment(input(index));
  assert.ok(seg.portals.some((d) => Math.abs(d - path.distanceAt(iv.t0)) < 1e-6));
  assert.ok(seg.hour[0] >= SCHEDULE.startHour && seg.hour[1] >= seg.hour[0]);
  assert.equal(seg.nether0, 0);
});

test('voxel: interpret maps each feature to its driver', () => {
  const seed = deriveSeed(worldSeed, 'interpret');
  const lo = voxelLogic.interpret({ energy: 0, bass: 0, mid: 0, high: 0, flux: 0 }, seed);
  const hi = voxelLogic.interpret({ energy: 1, bass: 1, mid: 1, high: 1, flux: 1 }, seed);
  assert.ok(hi.glowPulse > lo.glowPulse && hi.sparkle > lo.sparkle && hi.cloudGlow > lo.cloudGlow);
  assert.ok(hi.cubeKick > lo.cubeKick && hi.cubeGlow > lo.cubeGlow && hi.energy > lo.energy);
  assert.equal(lo.worldSalt, hi.worldSalt);
});

test('voxel: islands carry their own blocks, lifted by the cluster altitude', () => {
  let found = false;
  for (let i = 0; i < 80 && !found; i++) {
    const seg = voxelLogic.generateSegment(input(i));
    for (const isl of seg.islands) {
      assert.ok(isl.solid.extra && isl.solid.extra.length === (isl.solid.vertices.length / 7) * 3);
      assert.ok(isl.solid.extra[0]! >= ISLANDS.altitude[0] * ISLANDS.altitudeSpread[0] - 1);
      found = true;
    }
  }
  assert.ok(found, 'some island breaks off in the first 80 segments');
});
