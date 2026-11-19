import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../src/audio/analysis/analyze.ts';
import { Timeline } from '../src/audio/intelligence/timeline.ts';
import { RAILS_NONE, voxelLogic, type VoxelSegment } from '../src/scenarios/voxel/logic.ts';
import { PACE, createVoxelPath, fovForSpeed, netherRails, netherRailsOf, voxelTerrain } from '../src/scenarios/voxel/path.ts';
import { RAILS, quantizeRails, railSurfaceAt, smoothRailSlopeAt } from '../src/scenarios/voxel/rails.ts';
import { CART_PIVOT, minecartGeometry } from '../src/scenarios/voxel/minecart.ts';
import { FAR, FAR_EDGES, buildFarSegment, cellSizeAt } from '../src/scenarios/voxel/far.ts';
import { B, BAND, BLOCKS, FLAG, LAYER, LIGHT_EMIT, hasFlag, materialFlags } from '../src/scenarios/voxel/blocks.ts';
import { buildVolume } from '../src/scenarios/voxel/chunk.ts';
import { PACK, RAIL_LIFT, meshVolume } from '../src/scenarios/voxel/mesher.ts';
import { BEATS, bassBeatTimes, beatTimes, beatsUpTo } from '../src/scenarios/voxel/beats.ts';
import { cavePulse, pulseAt } from '../src/scenarios/voxel/cavePulse.ts';
import { LIGHT_REACH, computeLight } from '../src/scenarios/voxel/light.ts';
import { ROAD, ROAD_SURFACE_Y, RoadKind, bridgeOffsetAt, bridgeSlopeAt, deckLayer, deckStairAt, profileAt } from '../src/scenarios/voxel/road.ts';
import { SCHEDULE, caveAt, exitHourOf, hourAt, netherAt, scheduleOf } from '../src/scenarios/voxel/schedule.ts';
import { NETHER, buildNetherVolume, railDeckLayer } from '../src/scenarios/voxel/nether.ts';
import { POSTS, isPostRow, netherPostRows, postExitTime } from '../src/scenarios/voxel/netherPosts.ts';
import { OPAQUE } from '../src/scenarios/voxel/blocks.ts';
import { TERRAIN, baseColumnAt, columnAt, mountainShape, naturalBlock, softTop, terrainSalts } from '../src/scenarios/voxel/terrain.ts';
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

/** Like `track`, but the loud passage pulses (full, then a third of the level, every 6 s): a Nether visit with ups and downs. */
function pulsingTrack(from: number, to: number, duration: number): Timeline {
  const left = new Float32Array(duration * SR);
  let s = 777;
  for (let i = 0; i < left.length; i++) {
    const t = i / SR;
    s = (Math.imul(s, 1103515245) + 12345) | 0;
    const noise = ((s >>> 8) / 16777216) * 2 - 1;
    const gain = t >= from && t < to ? (Math.floor((t - from) / 3) % 2 === 0 ? 1 : 0.35) : 0;
    left[i] = gain > 0 ? gain * (0.5 * noise + 0.3 * Math.sin(2 * Math.PI * 80 * t)) : 0.03 * Math.sin(2 * Math.PI * 220 * t);
  }
  return new Timeline(analyzeTrack(left, left, SR));
}

const timeline = track([[20, 45]], 80);
/** Version baked into the test worlds' seed: a scenario version bump must not swap the worlds these tests were written on. */
const TEST_WORLD_VERSION = 11;
const seedOf = (key: string) => createWorldSeed({ audioIdentity: key.repeat(64), scenarioId: voxelLogic.id, scenarioVersion: TEST_WORLD_VERSION });
const worldSeed = seedOf('a');
const path = createVoxelPath(timeline, worldSeed);
const L = voxelLogic.config.segmentLength;

/** The Nether rail deck offsets of visit `iv` of a timeline (the bridge's `deckOffsetAt`), null outside the visit. */
function railOffsets(tl: Timeline, iv: { t0: number }): (bd: number) => number | null {
  const rails = netherRails(tl);
  const k = rails.visits.findIndex((v) => v.t0 === iv.t0);
  return (bd) => {
    const v = rails.visits[k]!, i = bd - v.first;
    return i >= 0 && i < v.layers.length ? v.layers[i]! - ROAD.layer : null;
  };
}

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
  const t = voxelTerrain(timeline, worldSeed);
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
  const t = voxelTerrain(timeline, worldSeed);
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
  const t = voxelTerrain(timeline, worldSeed);
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
  const t = voxelTerrain(timeline, worldSeed);
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
  // 8 x 8 x 1 slab in open air: the top and the four sides are one quad each (uniform light); the underside is lit
  // only by the sky light spreading in from the sides, so it darkens toward its centre (as under any roof).
  const perFace = new Array<number>(6).fill(0);
  let edgeSky = 0, centreSky = 99;
  for (let i = 0; i < m.solid.vertices.length; i += 7) {
    const packed = m.solid.vertices[i + 6]!;
    if (i % 28 === 0) perFace[packed % 8]!++;
    if (packed % 8 !== 3) continue;
    const sky = Math.floor(packed / PACK.sky) % 64;
    const x = m.solid.vertices[i]!, z = m.solid.vertices[i + 2]!;
    if (x === 2 || x === 10) edgeSky = Math.max(edgeSky, sky);
    if (x === 6 && z === 6) centreSky = Math.min(centreSky, sky);
  }
  assert.deepEqual([perFace[0], perFace[1], perFace[2], perFace[4], perFace[5]], [1, 1, 1, 1, 1]);
  assert.ok(perFace[3]! > 1, 'the underside is shaded');
  assert.ok(centreSky < edgeSky, `the underside is darker at its centre (${centreSky} vs ${edgeSky})`);
});

test('voxel: pace runs 40..100 km/h (ends at 25 km/h)', () => {
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

test('voxel schedule: several visits end at sunset then night, earlier exits at noon or spread over the day', () => {
  const tl = track([[15, 30], [45, 60], [75, 90]], 110);
  const s = scheduleOf(tl);
  assert.equal(s.intervals.length, 3);
  const hours = s.intervals.map((i) => i.exitHour);
  assert.deepEqual(hours, [SCHEDULE.midExitHour, SCHEDULE.sunsetExitHour, SCHEDULE.lastExitHour]);
  assert.ok(s.intervals.every((iv, k) => k === 0 || iv.t0 - s.intervals[k - 1]!.t1 >= SCHEDULE.minOverworldS));
  const hoursOf = (n: number) => Array.from({ length: n }, (_, k) => exitHourOf(k, n));
  assert.deepEqual(hoursOf(1), [21]);
  assert.deepEqual(hoursOf(2), [17.5, 21]);
  assert.deepEqual(hoursOf(3), [12, 17.5, 21]);
  assert.deepEqual(hoursOf(4), [9, 15, 17.5, 21]);
  assert.deepEqual(hoursOf(5), [9, 12, 15, 17.5, 21]);
  assert.deepEqual(hoursOf(6), [9, 11, 13, 15, 17.5, 21]);
});

test('voxel schedule: without a Nether visit the day runs from dawn to midnight', () => {
  const calm = scheduleOf(track([], 60));
  assert.equal(calm.intervals.length, 0);
  assert.equal(hourAt(calm, 0), SCHEDULE.startHour);
  assert.ok(Math.abs(hourAt(calm, calm.musicEndS) - 24) < 1e-9);
  assert.ok(hourAt(calm, calm.musicEndS / 2) > 12 && hourAt(calm, calm.musicEndS / 2) < 18);
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
  assert.equal(path.heightAt(iv.t0 - 1), bridgeOffsetAt(voxelTerrain(timeline, worldSeed), path.distanceAt(iv.t0 - 1)));
  const mid = (iv.t0 + iv.t1) / 2;
  assert.ok(path.heightAt(mid) < -20, `a net descent (${path.heightAt(mid)})`);
  assert.ok(Math.abs(path.heightAt(iv.t1 + 0.1)) < 12);
});

test('voxel path: in the Nether the rails climb and descend with the music, fastest on the steepest descents', () => {
  const tl = pulsingTrack(20, 80, 110);
  const path = createVoxelPath(tl, worldSeed);
  const iv = scheduleOf(tl).intervals[0]!;
  assert.ok(iv, 'the pulsing passage opens a Nether visit');
  const speedAt = (t: number) => (path.distanceAt(t + 0.05) - path.distanceAt(t - 0.05)) / 0.1;
  const samples: { slope: number; speed: number }[] = [];
  for (let t = iv.t0 + 2; t < iv.t1 - 1; t += 0.25) samples.push({ slope: path.slopeAt(t), speed: speedAt(t) });
  const slopes = samples.map((s) => s.slope);
  assert.ok(Math.min(...slopes) < -0.3, `a steep descent (${Math.min(...slopes)})`);
  assert.ok(Math.max(...slopes) > 0.02, `and a stretch that climbs (${Math.max(...slopes)})`);
  assert.ok(Math.max(...slopes) <= 0.28 + 1e-9 && Math.min(...slopes) >= -1 - 1e-9, 'slopes stay within their limits');
  const steep = samples.filter((s) => s.slope < -0.3), gentle = samples.filter((s) => s.slope > -0.1);
  const mean = (a: { speed: number }[]) => a.reduce((x, s) => x + s.speed, 0) / Math.max(1, a.length);
  assert.ok(steep.length > 0 && gentle.length > 0 && mean(steep) > mean(gentle) * 1.15, 'faster on the steep descents than on the level or climbing stretches');
  // The overworld road is untouched: no slope but the bridges'.
  assert.equal(path.slopeAt(iv.t0 - 1), bridgeSlopeAt(voxelTerrain(tl, worldSeed), path.distanceAt(iv.t0 - 1)));
  assert.ok(path.heightAt((iv.t0 + iv.t1) / 2 + 3) < -30, 'and the visit still goes down as a whole');
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
  assert.ok(hi.sparkle > lo.sparkle && hi.cloudGlow > lo.cloudGlow);
  assert.ok(hi.cubeKick > lo.cubeKick && hi.cubeGlow > lo.cubeGlow && hi.energy > lo.energy);
  assert.equal(lo.worldSalt, hi.worldSalt);
});

test('voxel light: glowstone lights the cells around it, falling 1 level per block and stopped by walls', () => {
  const n = 20;
  const data = new Uint8Array(n * n * n);
  const at = (x: number, y: number, z: number) => x + n * (z + n * y);
  for (let i = 0; i < data.length; i++) data[i] = B.stone;
  // A closed room of air (no sky) with a glowstone in the middle and a wall splitting it.
  for (let y = 2; y < 18; y++) for (let z = 2; z < 18; z++) for (let x = 2; x < 18; x++) data[at(x, y, z)] = B.air;
  for (let y = 2; y < 18; y++) for (let z = 2; z < 18; z++) data[at(12, y, z)] = B.stone;
  data[at(6, 9, 9)] = B.glowstone;
  const { sky, block } = computeLight({ data, sx: n, sy: n, sz: n, ox: 0, oy: 0, oz: 0 }, true);
  assert.equal(block[at(6, 9, 9)], 15);
  assert.equal(block[at(7, 9, 9)], 14);
  assert.equal(block[at(9, 9, 9)], 12);
  assert.equal(block[at(6, 9, 13)], 11);
  assert.equal(block[at(12, 9, 9)], 0, 'opaque blocks hold no light');
  assert.equal(block[at(13, 9, 9)], 0, 'the wall stops it (the room is closed)');
  assert.equal(sky[at(6, 10, 9)], 0, 'no sky light inside a closed room');
});

test('voxel light: the sky lights open air fully and fades under an overhang', () => {
  const n = 24;
  const data = new Uint8Array(n * n * n);
  const at = (x: number, y: number, z: number) => x + n * (z + n * y);
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) for (let y = 0; y <= 2; y++) data[at(x, y, z)] = B.stone;
  // A roof over x in 4..19 at y = 6.
  for (let z = 0; z < n; z++) for (let x = 4; x < 20; x++) data[at(x, 6, z)] = B.stone;
  const { sky } = computeLight({ data, sx: n, sy: n, sz: n, ox: 0, oy: 0, oz: 0 }, true);
  assert.equal(sky[at(2, 3, 10)], 15);
  assert.equal(sky[at(4, 3, 10)], 14);
  assert.equal(sky[at(11, 3, 10)], 7);
  assert.equal(sky[at(10, 7, 10)], 15);
});

test('voxel light: segments light their seams the same from both sides', () => {
  const s = voxelLogic.generateSegment(input(7));
  const again = voxelLogic.generateSegment(input(7));
  assert.deepEqual(s.solid.vertices, again.solid.vertices);
  // The rows on both sides of the seam are lit the same by both segments (each holds the other's rows in its light
  // margin). This compares the light field itself: comparing mesh vertices by position would mix different faces that
  // only share a corner where the terrain steps exactly on the seam.
  const t = voxelTerrain(timeline, worldSeed);
  const va = buildVolume(t, 7 * L, L, LIGHT_REACH).volume, vb = buildVolume(t, 8 * L, L, LIGHT_REACH).volume;
  const la = computeLight(va, true), lb = computeLight(vb, true);
  const cell = (v: typeof va, x: number, y: number, bd: number) => (x - v.ox) + v.sx * ((-bd - 1 - v.oz) + v.sz * (y - v.oy));
  let compared = 0;
  for (const bd of [8 * L - 1, 8 * L]) {
    for (let x = -TERRAIN.halfWidth; x <= TERRAIN.halfWidth; x++) {
      for (let y = va.oy + 1; y < Math.min(va.oy + va.sy, vb.oy + vb.sy) - 1; y++) {
        const i = cell(va, x, y, bd), j = cell(vb, x, y, bd);
        assert.equal(va.data[i], vb.data[j], `block (${x}, ${y}, ${bd})`);
        assert.equal(la.sky[i], lb.sky[j], `sky light differs at (${x}, ${y}, ${bd})`);
        assert.equal(la.block[i], lb.block[j], `block light differs at (${x}, ${y}, ${bd})`);
        compared++;
      }
    }
  }
  assert.ok(compared > 10000, `compared ${compared}`);
});

/** A varying interpolated in float32 as a GPU does: perspective-correct barycentric weights over a triangle. */
function interpolate32(value: number, rnd: () => number): number {
  const f = Math.fround;
  const w = [rnd(), rnd(), rnd()].map((x) => f(0.05 + x)), iw = w.map((x) => f(1 / x));
  const b = [rnd(), rnd(), rnd()], sum = b[0]! + b[1]! + b[2]!;
  const bc = b.map((x) => f(x / sum));
  let num = 0, den = 0;
  for (let k = 0; k < 3; k++) { num = f(num + f(f(bc[k]! * f(value)) * iw[k]!)); den = f(den + f(bc[k]! * iw[k]!)); }
  return f(num / den);
}

test('voxel: material flags survive the interpolation of the varying (no flicker)', () => {
  let s = 1;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  let naiveWrong = 0;
  for (const info of BLOCKS) {
    if (!info) continue;
    for (let i = 0; i < 2000; i++) {
      const v = interpolate32(info.flags, rnd);
      assert.equal(materialFlags(v), info.flags);
      for (const bit of [FLAG.cutout, FLAG.emissive, FLAG.animated, FLAG.energy]) {
        assert.equal(hasFlag(materialFlags(v), bit), (info.flags & bit) !== 0);
      }
      assert.equal(materialFlags(v) % 4, info.flags & FLAG.tintMask); // tint
      if (Math.floor(v) !== info.flags) naiveWrong++;
    }
  }
  // The bug this guards against: flooring the raw varying does lose bits at some pixels.
  assert.ok(naiveWrong > 0, 'the emulated interpolation is inexact');
});

test('voxel: glowstone and portal quads carry their emissive flag', () => {
  const n = 8;
  const data = new Uint8Array(n * n * n);
  data[3 + n * (3 + n * 3)] = B.glowstone;
  data[5 + n * (4 + n * 3)] = B.portal;
  const m = meshVolume({ data, sx: n, sy: n, sz: n, ox: 0, oy: 0, oz: 0 });
  const flagsOf = (v: Float32Array) => { const out = new Set<number>(); for (let i = 6; i < v.length; i += 7) out.add(Math.floor(v[i]! / PACK.flags)); return out; };
  assert.deepEqual([...flagsOf(m.solid.vertices)], [BLOCKS[B.glowstone]!.flags]);
  assert.deepEqual([...flagsOf(m.cross.vertices)], [BLOCKS[B.portal]!.flags]);
  assert.ok(hasFlag(BLOCKS[B.glowstone]!.flags, FLAG.emissive) && hasFlag(BLOCKS[B.portal]!.flags, FLAG.emissive));
});

test('atmosphere: pure function of the hour, sun light by day, moon light by night, no jump at the swap', async () => {
  const { atmosphereAt } = await import('../src/scenarios/voxel/atmosphere.ts');
  assert.deepEqual(atmosphereAt(13.7), atmosphereAt(13.7));
  const noon = atmosphereAt(12), night = atmosphereAt(0);
  assert.ok(noon.sunDir[1] > 0.8 && noon.lightDir[1] > 0.8, 'sun high at noon and it is the light');
  assert.ok(night.lightDir[1] > 0.5, 'at midnight the light comes from the moon, above');
  const lum = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  assert.ok(lum(noon.lightColor) > 10 * lum(night.lightColor), 'moonlight is much dimmer');
  assert.ok(lum(noon.ambientUp) > lum(night.ambientUp));
  // Around sunrise and sunset the light fades to zero before the source swaps: no visible step from hour to hour.
  for (let h = 0; h < 24; h += 0.01) {
    const a = atmosphereAt(h), b = atmosphereAt(h + 0.01);
    assert.ok(Math.abs(lum(a.lightColor) - lum(b.lightColor)) < 0.05, `light continuous at ${h.toFixed(2)} h`);
    for (const c of [a.horizon, a.zenith, a.ambientUp, a.lightColor]) assert.ok(c.every((v) => Number.isFinite(v) && v >= 0));
  }
});

test('cloud noise: deterministic, tileable and spread over the full range', async () => {
  const { buildCloudNoise } = await import('../src/scenarios/voxel/cloudNoise.ts');
  const n = 16;
  const a = buildCloudNoise(n), b = buildCloudNoise(n);
  assert.deepEqual(a, b, 'same bytes every run');
  for (let c = 0; c < 2; c++) {
    let lo = 255, hi = 0, sum = 0;
    for (let i = c; i < a.length; i += 2) { lo = Math.min(lo, a[i]!); hi = Math.max(hi, a[i]!); sum += a[i]!; }
    assert.ok(lo === 0 && hi === 255, `channel ${c} spans 0..255`);
    const mean = sum / (a.length / 2);
    assert.ok(mean > 70 && mean < 185, `channel ${c} mean ${mean.toFixed(0)} is mid-range`);
  }
  // Periodic: the step across the wrap (x = n-1 -> 0) is no larger than a typical step inside the volume.
  let wrapStep = 0, innerStep = 0;
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) {
    const at = (i: number) => a[(i + n * (j + n * k)) * 2]!;
    wrapStep += Math.abs(at(n - 1) - at(0));
    innerStep += Math.abs(at(n / 2) - at(n / 2 - 1));
  }
  assert.ok(wrapStep < innerStep * 1.5, `no seam at the wrap (${wrapStep} vs ${innerStep})`);
});

test('voxel path: the field of view widens in the Nether and returns to normal after it', () => {
  const iv = scheduleOf(timeline).intervals[0]!;
  const speedAt = (t: number) => (path.distanceAt(t + 0.05) - path.distanceAt(t - 0.05)) / 0.1;
  const ratio = (t: number) => path.fovAt!(t) / fovForSpeed(speedAt(t));
  assert.ok(Math.abs(ratio(iv.t0 - 2) - 1) < 0.01, 'normal before the entry');
  const mid = (iv.t0 + iv.t1) / 2;
  assert.ok(path.fovAt!(mid) <= PACE.fovMaxDeg + 1e-9);
  assert.ok(ratio(mid) > 1.05, `wider in the Nether (${ratio(mid)})`);
  assert.ok(Math.abs(ratio(iv.t1 + PACE.netherFovS + 1) - 1) < 0.01, 'normal again after the exit');
  for (let t = iv.t0 - 1; t < iv.t1 + 3; t += 0.05) assert.ok(Math.abs(path.fovAt!(t + 0.05) - path.fovAt!(t)) < 2.5, `no jump at ${t}s`);
});

test('voxel far field: reproducible, cells tile the width and never straddle the detailed band', () => {
  const t = voxelTerrain(timeline, worldSeed);
  const a = buildFarSegment(t, FAR.segmentLength, FAR.segmentLength, L);
  assert.deepEqual(a, buildFarSegment(t, FAR.segmentLength, FAR.segmentLength, L));
  assert.ok(a.solid.indices.length > 0);
  assert.equal(L % FAR.cell, 0);
  assert.equal(FAR.segmentLength % L, 0);
  for (let i = 1; i < FAR_EDGES.length; i++) assert.ok(FAR_EDGES[i]! > FAR_EDGES[i - 1]!);
  assert.ok(FAR_EDGES[0]! <= -FAR.halfWidth && FAR_EDGES[FAR_EDGES.length - 1]! >= FAR.halfWidth);
  assert.ok(FAR_EDGES.includes(-TERRAIN.halfWidth) && FAR_EDGES.includes(TERRAIN.halfWidth + 1));
  // The far field reaches past the end of the fog on every side the camera looks.
  assert.ok(FAR.segmentLength * FAR.segmentsAhead >= 875 && FAR.halfWidth >= 875); // the fog now ends well inside this
  assert.ok(voxelLogic.config.viewDistance! >= Math.hypot(FAR.halfWidth, FAR.segmentLength * FAR.segmentsAhead));
});

test('voxel far field: finer cells next to the detailed band, coarser far out, every edge on its band grid', () => {
  assert.equal(cellSizeAt(120), 2);
  assert.equal(cellSizeAt(-400), 4);
  assert.equal(cellSizeAt(1000), 8);
  for (let i = 1; i < FAR_EDGES.length; i++) {
    const a = FAR_EDGES[i - 1]!, b = FAR_EDGES[i]!;
    if (a >= -TERRAIN.halfWidth && b <= TERRAIN.halfWidth + 1) continue; // the clipped central band
    assert.ok(b - a <= FAR.cell, `cell ${a}..${b} no wider than the coarsest band`);
    for (const [size] of FAR.bands) assert.equal(FAR.segmentLength % size, 0);
  }
  // The cells just outside the detailed band use the finest size of the band they start in (with the detailed band at 96
  // blocks that was 2; with it at 512 the 2-block band lies inside the detailed volume, so the far field starts at 4).
  const H = TERRAIN.halfWidth;
  const outside = FAR_EDGES.slice(1).map((e, i) => ({ a: FAR_EDGES[i]!, w: e - FAR_EDGES[i]! })).filter(({ a }) => a >= H + 1 && a < H + 1 + 32);
  assert.ok(outside.length > 0 && outside.every(({ w }) => w === cellSizeAt(H + 1)), 'the band beside the detailed terrain uses the finest band size there');
});

test('voxel far field: trees in the fine cells, none in the coarse ones, walls darken at their foot', () => {
  const t = voxelTerrain(timeline, worldSeed);
  const seg = buildFarSegment(t, FAR.segmentLength, FAR.segmentLength, L);
  const v = seg.solid.vertices;
  const logLayers = new Set([BLOCKS[B.oakLog]!.faces[0], BLOCKS[B.birchLog]!.faces[0]]);
  let trunks = 0, fineTrunks = 0, aoLow = 0;
  for (let i = 0; i < v.length; i += 7 * 4) {
    const packed = v[i + 6]!;
    if (logLayers.has(v[i + 3]!)) {
      trunks++;
      // A trunk is a 1-block column: tell fine from coarse by the distance to the road (trees only up to the 4-block band).
      if (Math.abs(v[i]!) <= FAR.bands[1]![1] + FAR.treeCell) fineTrunks++; // the last 4-block cell may end just past the band
    }
    if (Math.floor(packed / 8) % 4 < 3) aoLow++;
  }
  assert.ok(trunks > 20, `trees stand in the distance (${trunks} trunk faces)`);
  assert.equal(trunks, fineTrunks, 'no tree beyond the 4-block cells');
  assert.ok(aoLow > 0, 'wall feet are darkened');
  // Deterministic, and the trees agree between neighbouring builds of the same segment.
  assert.deepEqual(seg, buildFarSegment(t, FAR.segmentLength, FAR.segmentLength, L));
});

test('voxel mountains: massifs differ in height and shape; snow on high tops, stone on cliffs', () => {
  const t = terrainSalts(12345);
  // Peaks of 8 separate areas far from the road: their heights spread widely (not one repeated mountain).
  const peaks: number[] = [];
  for (let k = 0; k < 8; k++) {
    let best = 0;
    for (let x = 300; x < 700; x += 6) for (let d = k * 900; d < k * 900 + 500; d += 6) best = Math.max(best, columnAt(t, x, d).h);
    peaks.push(best);
  }
  const lo = Math.min(...peaks), hi = Math.max(...peaks);
  assert.ok(hi - lo >= 30, `peak heights vary (${peaks.join(', ')})`);
  assert.ok(hi > 90 && hi <= TERRAIN.topY, `some massifs are tall (${hi})`);
  // Surface rules.
  const col = { h: 130, river: 0, mountain: 1 };
  assert.equal(naturalBlock(t, { ...col, steep: 0.5 }, 0, 129, 0), B.snow);
  assert.ok(ROCK.has(naturalBlock(t, { ...col, steep: 5 }, 0, 129, 0)), 'a sheer face at the top is rock');
  assert.equal(naturalBlock(t, { h: 20, river: 0, mountain: 0, steep: 0.5 }, 0, 19, 0), B.grass);
  assert.ok(ROCK.has(naturalBlock(t, { h: 20, river: 0, mountain: 0, steep: 5 }, 0, 19, 0)), 'a sheer cliff is rock');
});

const ROCK = new Set<number>([B.stone, B.andesite, B.tuff, B.coalOre, B.ironOre]);

test('voxel mountains: no towers on the massifs, no summit cut flat at the ceiling, no holes in the cliffs', () => {
  const t = terrainSalts(12345);
  // The mountain field grows out of the massif's slopes: almost none of it is a wall (towers on the massifs were jagged
  // blades about 6 blocks wide; with them 0.22% of this sample rose more than 6 layers per block, now about 0.05%).
  let walls = 0, samples = 0;
  for (let d = 0; d < 1500; d += 3) for (let x = 120; x <= 600; x += 3) {
    samples++;
    if (Math.hypot(mountainShape(t, x + 1, d, 1) - mountainShape(t, x - 1, d, 1), mountainShape(t, x, d + 1, 1) - mountainShape(t, x, d - 1, 1)) / 2 > 6) walls++;
  }
  assert.ok(walls / samples < 0.001, `the mountains have no tower walls (${(100 * walls / samples).toFixed(3)}% steeper than 6)`);
  // The highest summits ease under the ceiling instead of being cut flat at it.
  let atCeiling = 0;
  for (let d = 0; d < 3200; d += 4) for (let x = -384; x <= 384; x += 4) if (baseColumnAt(t, x, d).h >= TERRAIN.topY) atCeiling++;
  assert.equal(atCeiling, 0, 'no summit is cut flat at the ceiling');
  assert.ok(softTop(TERRAIN.topKnee) === TERRAIN.topKnee && softTop(1000) <= TERRAIN.topY && softTop(150) > softTop(140), 'the ceiling eases heights smoothly');
  // The cliffs are solid: no column of a cliff has air inside its rock, and no rock floats off the ground.
  const SOLID = new Set<number>([...ROCK, B.dirt, B.coarseDirt, B.grass, B.gravel, B.sand, B.snow, B.cobblestone]);
  let cliffs = 0, holed = 0, buried = 0, floating = 0;
  for (const start of [192, 1088]) {
    const { volume: v, surface } = buildVolume(t, start, L);
    const at = (x: number, y: number, z: number) => v.data[x + v.sx * (z + v.sz * y)]!;
    const seen = new Uint8Array(v.data.length), stack: number[] = [];
    for (let z = 0; z < v.sz; z++) for (let x = 0; x < v.sx; x++) if (SOLID.has(at(x, 0, z))) { seen[x + v.sx * z] = 1; stack.push(x + v.sx * z); }
    while (stack.length) {
      const i = stack.pop()!, x = i % v.sx, z = Math.floor(i / v.sx) % v.sz, y = Math.floor(i / (v.sx * v.sz));
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < 0 || nx >= v.sx || ny < 0 || ny >= v.sy || nz < 0 || nz >= v.sz) continue;
        const j = nx + v.sx * (nz + v.sz * ny);
        if (!seen[j] && SOLID.has(v.data[j]!)) { seen[j] = 1; stack.push(j); }
      }
    }
    for (let i = 0; i < v.data.length; i++) {
      const x = i % v.sx, z = Math.floor(i / v.sx) % v.sz;
      if (!seen[i] && SOLID.has(v.data[i]!) && x > 0 && x < v.sx - 1 && z > 0 && z < v.sz - 1) floating++;
    }
    for (let z = 1; z < v.sz - 1; z++) for (let x = 1; x < v.sx - 1; x++) {
      const bd = start + L - z;
      const col = surface.col[(bd - surface.firstRow) * surface.cols + x]!;
      if (col.mountain < 0.15 || (col.steep ?? 0) <= TERRAIN.cliffSlope[1]) continue;
      cliffs++;
      let top = -1;
      for (let y = v.sy - 1; y >= 0; y--) if (SOLID.has(at(x, y, z))) { top = y; break; }
      let gap = false, soil = false;
      for (let y = 1; y < top; y++) {
        if (!SOLID.has(at(x, y, z))) gap = true;
        else if ((at(x, y, z) === B.snow || at(x, y, z) === B.grass) && y < top - 4 && SOLID.has(at(x, y + 1, z))) soil = true;
      }
      if (gap) holed++;
      if (soil) buried++;
    }
  }
  assert.ok(cliffs > 2000, `cliffs were sampled (${cliffs})`);
  assert.ok(holed / cliffs < 0.03, `the cliffs are solid (${holed} of ${cliffs} columns with air in their rock)`);
  assert.equal(buried, 0, 'no grass or snow inside a cliff face');
  assert.ok(floating < 40, `no rock floats off the mountains (${floating} blocks)`);
});

test('voxel mountains: covered with grass, rock only on the highest and sheerest ground', () => {
  const t = terrainSalts(12345);
  // Mountain columns far from the road, their slope measured as the detailed volume does (two blocks each side).
  const X0 = 300, W = 300, D = 1500;
  const h = new Int16Array(W * D), m = new Float32Array(W * D);
  for (let d = 0; d < D; d++) for (let x = 0; x < W; x++) { const c = columnAt(t, X0 + x, d); h[d * W + x] = c.h; m[d * W + x] = c.mountain; }
  const H = (x: number, d: number) => h[d * W + x]!;
  const byBand = [new Map<number, number>(), new Map<number, number>(), new Map<number, number>()];
  const top = new Map<number, number>();
  const add = (map: Map<number, number>, id: number) => map.set(id, (map.get(id) ?? 0) + 1);
  for (let d = 2; d < D - 2; d += 2) for (let x = 2; x < W - 2; x += 2) {
    const v = H(x, d);
    if (m[d * W + x]! < 0.3 || v < 20) continue;
    const step = Math.max(Math.abs(v - H(x + 1, d)), Math.abs(v - H(x - 1, d)), Math.abs(v - H(x, d + 1)), Math.abs(v - H(x, d - 1)));
    const steep = Math.max(Math.hypot((H(x + 2, d) - H(x - 2, d)) / 4, (H(x, d + 2) - H(x, d - 2)) / 4), 0.6 * step);
    const id = naturalBlock(t, { h: v, river: 0, mountain: 0, steep }, X0 + x, v - 1, d);
    add(top, id);
    // High ground from the snow line (scenario version 18: below it the peaks no longer stand as sheer towers, so their
    // slopes keep their grass, as the rest of the mountain's).
    add(byBand[v < 50 ? 0 : v < TERRAIN.snowLine ? 1 : 2]!, id);
  }
  const share = (map: Map<number, number>, set: Set<number>) => { let k = 0, all = 0; for (const [id, c] of map) { all += c; if (set.has(id)) k += c; } return k / Math.max(1, all); };
  const GRASS = new Set<number>([B.grass]);
  // The mountains are green: grass on most of the surface at every altitude below the snow, and grass dominates the whole.
  assert.ok(share(byBand[0]!, GRASS) > 0.9, 'the lower slopes are grass');
  assert.ok(share(byBand[1]!, GRASS) > 0.8, 'the middle slopes are grass');
  assert.ok(share(top, GRASS) > 0.8, 'grass covers most of the mountains');
  assert.ok(share(top, ROCK) < 0.12, 'rock is the exception');
  // The rock that remains is layered, and the highest ground still shows rock (and some snow).
  assert.ok((top.get(B.andesite) ?? 0) + (top.get(B.tuff) ?? 0) > 0, 'the rock shows strata');
  assert.ok(share(byBand[2]!, ROCK) + share(byBand[2]!, new Set([B.snow])) > 0.2, 'high ground shows rock and snow');
  // On a steep slope the grass also covers the blocks under the top one, so the faces of the steps are green.
  const col = { h: 40, river: 0, mountain: 1, steep: 2.2 };
  let green = 0;
  for (let x = 0; x < 200; x++) if (naturalBlock(t, col, x, 38, 7) === B.grass) green++;
  assert.ok(green > 40, `grass shows under the top block of a steep slope (${green}/200)`);
});

test('voxel mountains: spruce forest only on the extremely distant mountains', () => {
  const t = terrainSalts(12345);
  const spruceBlocks = new Set<number>([B.spruceLog, B.spruceLeaves]);
  // The detailed terrain (near and middle ground) has no spruce: its mountains carry the ordinary forest.
  let spruceNear = 0, trunks = 0;
  for (const startRow of [0, 64, 128, 192, 256, 320, 384, 448]) {
    const { volume: v } = buildVolume(t, startRow, 64);
    for (const id of v.data) if (spruceBlocks.has(id)) spruceNear++;
    const at = (x: number, y: number, z: number) => v.data[x + v.sx * (z + v.sz * y)]!;
    for (let z = 2; z < v.sz - 2; z++) for (let x = 0; x < v.sx; x++) for (let y = 1; y < v.sy; y++) {
      const id = at(x, y, z);
      if ((id === B.oakLog || id === B.birchLog) && at(x, y - 1, z) !== id) trunks++;
    }
  }
  assert.equal(spruceNear, 0, 'no spruce in the detailed terrain');
  assert.ok(trunks > 50, `the land keeps its ordinary trees (${trunks} trunks)`);
  // The far terrain: spruce only from FAR.spruceFrom out, on its mountains, and plenty of it there.
  const spruceLayers = new Set([BLOCKS[B.spruceLeaves]!.faces[2], BLOCKS[B.spruceLeaves]!.faces[0], BLOCKS[B.spruceLog]!.faces[0]]);
  let nearest = Infinity, far = 0, high = 0;
  for (const startRow of [0, 1280, 2560]) {
    const v = buildFarSegment(t, startRow, FAR.segmentLength, L).solid.vertices;
    for (let i = 0; i < v.length; i += 7 * 4) if (spruceLayers.has(v[i + 3]!)) {
      far++;
      nearest = Math.min(nearest, Math.abs(v[i]!));
      if (v[i + 1]! > 40) high++;
    }
  }
  assert.ok(far > 200, `the extremely distant mountains carry spruce (${far} quads)`);
  assert.ok(high > 50, `spruce stands high on them (${high} quads above layer 40)`);
  assert.ok(nearest >= FAR.spruceFrom - FAR.cell, `no spruce closer than ${FAR.spruceFrom} blocks (nearest ${nearest})`);
});

test('voxel caves: the face over a cave mouth climbs in ledges, not one flat wall', () => {
  const t = voxelTerrain(timeline, worldSeed);
  const [a] = t.caves.ranges[0]!;
  const vols = new Map<number, ReturnType<typeof buildVolume>['volume']>();
  const solid = (x: number, y: number, bd: number) => {
    const i = Math.floor(bd / L);
    let v = vols.get(i);
    if (!v) vols.set(i, (v = buildVolume(t, i * L, L).volume));
    return OPAQUE[v.data[(x - v.ox) + v.sx * ((-bd - 1 - v.oz) + v.sz * (y - v.oy))]!] === 1;
  };
  // Seen from the road before the mouth, the depth (row) of the first rock at each height above the cavern: a plane wall
  // would put every height of the face on the same row; the face leans back, so higher layers stand farther in.
  const depth = (x: number, y: number) => { let d = a - 20; while (d < a + 24 && !solid(x, y, d)) d++; return d - a; };
  for (const x of [-4, 0, 4]) {
    const low = depth(x, ROAD_SURFACE_Y + 14), high = depth(x, ROAD_SURFACE_Y + 26);
    assert.ok(high - low >= 4, `the face over the mouth leans back at x=${x} (${low} -> ${high})`);
  }
  // Across the face at one height, the first rock is at several depths (ledges and bays), not on one row.
  const rows = new Set<number>();
  for (let x = -12; x <= 12; x++) rows.add(depth(x, ROAD_SURFACE_Y + 22));
  assert.ok(rows.size >= 4, `the face is irregular (${[...rows].join(', ')})`);
});

test('voxel caves: lava lies only on the floor, with no side face exposed (there is no fluid flow)', () => {
  const t = voxelTerrain(timeline, worldSeed);
  let lava = 0, caveSegments = 0;
  for (const [a, b] of t.caves.ranges) {
    for (let k = Math.floor(a / L); k <= Math.floor((b - 1) / L); k++) {
      const { volume: v } = buildVolume(t, k * L, L);
      caveSegments++;
      const at = (x: number, y: number, z: number) => v.data[x + v.sx * (z + v.sz * y)]!;
      // Padding rows and columns at the edge are generated by the neighbours: only the inside is checked here.
      for (let y = 1; y < v.sy - 4; y++) for (let z = 1; z < v.sz - 1; z++) for (let x = 1; x < v.sx - 1; x++) {
        if (at(x, y, z) !== B.lava) continue;
        lava++;
        const where = `lava at (${v.ox + x}, ${v.oy + y}, z ${z})`;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          assert.notEqual(at(x + dx, y, z + dz), B.air, `${where} has an exposed side face (${dx}, ${dz})`);
        }
        for (let up = 1; up <= 3; up++) assert.equal(at(x, y + up, z), B.air, `${where} is under rock, not on an open floor`);
      }
    }
  }
  assert.ok(caveSegments > 0);
  assert.ok(lava > 0, 'the caves still have lava');
});

test('voxel caves: the cave mountain and its cliffs are the same from both sides of a seam', () => {
  const t = voxelTerrain(timeline, worldSeed);
  const [a] = t.caves.ranges[0]!;
  const k = Math.floor(a / L);
  const left = buildVolume(t, (k - 1) * L, L).volume, right = buildVolume(t, k * L, L).volume;
  let compared = 0;
  for (const bd of [k * L - 1, k * L]) {
    for (let x = -60; x <= 60; x++) {
      for (let y = -4; y < 60; y++) {
        const get = (v: typeof left) => v.data[(x - v.ox) + v.sx * ((-bd - 1 - v.oz) + v.sz * (y - v.oy))];
        assert.equal(get(left), get(right), `block (${x}, ${y}, ${bd}) differs between neighbours`);
        compared++;
      }
    }
  }
  assert.ok(compared > 10000);
});

test('voxel caves: the road cut does not slice the cave mountain into a flat wall at the mouth', () => {
  const t = voxelTerrain(timeline, worldSeed);
  const [a] = t.caves.ranges[0]!;
  const start = Math.floor((a - 20) / L) * L;
  const vols = [buildVolume(t, start, L).volume, buildVolume(t, start + L, L).volume];
  const topAt = (x: number, bd: number) => {
    const v = vols.find((v) => bd >= -(v.oz + v.sz) + 1 && bd <= -v.oz - 2)!;
    const z = -bd - 1 - v.oz;
    for (let y = v.sy - 1; y >= 0; y--) if (OPAQUE[v.data[(x - v.ox) + v.sx * (z + v.sz * y)]!]) return y + v.oy + 1;
    return -99;
  };
  // Beside the road corridor (|x| 8..14), the rows just before the mouth already rise with the valley slopes (before the
  // fix the road's flat bed ran up to the first cave row, where a cliff stood): the mountain comes forward around the road.
  let rising = 0, total = 0;
  for (const x of [-14, -12, -10, -8, 8, 10, 12, 14]) {
    total++;
    if (topAt(x, a - 3) >= ROAD_SURFACE_Y + 4) rising++;
  }
  assert.ok(rising >= 0.75 * total, `the mountain wraps around the mouth (${rising}/${total} columns)`);
  // Away from the mouth the face does not cut a trench across the mountain on the cave's first rows.
  for (const x of [-60, -45, 45, 60]) assert.ok(topAt(x, a + 1) >= columnAt(t, x, a - 2).h - 6, `no trench across the mountain at x=${x}`);
  // The cut is applied before the mountain: the base land alone is low there, yet the final surface is high.
  assert.ok(baseColumnAt(t, 10, a - 3).h < columnAt(t, 10, a - 3).h);
});


/** Synthetic track with passages of a given loudness: [from, to, gain] (gain 1 = the loud passages above). */
function leveled(passages: [number, number, number][], duration: number): Timeline {
  const left = new Float32Array(duration * SR);
  let s = 12345;
  for (let i = 0; i < left.length; i++) {
    const t = i / SR;
    s = (Math.imul(s, 1103515245) + 12345) | 0;
    const noise = ((s >>> 8) / 16777216) * 2 - 1;
    const g = passages.find(([a, b]) => t >= a && t < b)?.[2] ?? 0;
    left[i] = g > 0 ? g * (0.5 * noise + 0.3 * Math.sin(2 * Math.PI * 80 * t)) : 0.03 * Math.sin(2 * Math.PI * 220 * t);
  }
  return new Timeline(analyzeTrack(left, left, SR));
}

test('voxel schedule: a medium passage is a cave section only; an intense one goes open -> caves -> Nether -> caves -> open', () => {
  const s = scheduleOf(leveled([[10, 30, 0.5], [45, 70, 1]], 90));
  assert.equal(s.intervals.length, 1, 'only the intense passage opens the Nether');
  const iv = s.intervals[0]!;
  assert.ok(iv.t0 > 43 && iv.t0 < 48 && iv.t1 > 67 && iv.t1 < 73, `the Nether follows the intense passage (${iv.t0}..${iv.t1})`);
  assert.ok(caveAt(s, 20) !== null && netherAt(s, 20) === null, 'the medium passage is a cave');
  assert.ok(caveAt(s, 5) === null && caveAt(s, 38) === null && caveAt(s, 85) === null, 'calm passages are open road');
  const around = caveAt(s, iv.t0)!;
  assert.ok(around && around.t0 <= iv.t0 - SCHEDULE.caveLeadS + 1e-9 && around.t1 >= iv.t1 + SCHEDULE.caveLeadS - 1e-9, 'a cave on both sides of the Nether');
});

test('voxel terrain: no mountain over the open road; a closed cave over every cave section', () => {
  const t = voxelTerrain(timeline, worldSeed);
  const s = scheduleOf(timeline);
  assert.ok(t.caves.ranges.length === s.caves.length && s.caves.length > 0);
  let caveRows = 0, openRows = 0;
  for (let index = 0; index < 30; index++) {
    const { volume: v } = buildVolume(t, index * L, L);
    const at = (x: number, y: number, bd: number) => v.data[(x - v.ox) + v.sx * ((-bd - 1 - v.oz) + v.sz * (y - v.oy))]!;
    for (let bd = index * L; bd < (index + 1) * L; bd++) {
      const { kind, offset } = profileAt(t, bd);
      const dl = ROAD.layer + Math.round(offset);
      let roof = false;
      for (let y = dl + 5; y < v.oy + v.sy - 1 && !roof; y++) roof = OPAQUE[at(0, y, bd)] === 1;
      const inCave = caveAt(s, path.timeAt(bd + 0.5)) !== null;
      if (kind === RoadKind.Cave) { caveRows++; assert.ok(roof, `the cave at ${bd} has a roof`); }
      else { openRows++; assert.ok(!roof, `open road at ${bd} has nothing overhead`); }
      const edge = t.caves.ranges.some(([a, b]) => Math.abs(bd - a) <= 1 || Math.abs(bd - b) <= 1);
      if (!edge) assert.equal(kind === RoadKind.Cave, inCave, `row ${bd} kind matches the schedule`);
    }
  }
  assert.ok(caveRows > 100 && openRows > 100);
  // Near the road, away from the caves, the land stays low (no tunnel-sized mountains).
  for (let d = 0; d < 6000; d += 7) {
    if (t.caves.ranges.some(([a, b]) => d > a - 80 && d < b + 80)) continue;
    for (const x of [-20, -8, 0, 8, 20]) assert.ok(columnAt(t, x, d).h <= TERRAIN.centreCap, `low land at (${x}, ${d})`);
  }
});

const RAIL_LAYERS = new Set([BLOCKS[B.rail]!.faces[2], BLOCKS[B.poweredRail]!.faces[2]]);
/**
 * Ends of every rail quad of a cross mesh, keyed by the world z of the edge: the height of the track at that edge, one
 * entry per rail that reaches it. Also counts the ramps (quads whose two ends differ).
 */
function railEdges(cross: { vertices: Float32Array }, edges = new Map<number, number[]>()): { edges: Map<number, number[]>; up: number; down: number } {
  const v = cross.vertices;
  let up = 0, down = 0;
  for (let q = 0; q < v.length; q += 4 * 7) {
    if (!RAIL_LAYERS.has(v[q + 3]!)) continue;
    const corners = [0, 1, 2, 3].map((k) => ({ y: v[q + k * 7 + 1]!, z: v[q + k * 7 + 2]! }));
    const zLo = Math.min(...corners.map((c) => c.z)), zHi = Math.max(...corners.map((c) => c.z));
    const yLo = corners.filter((c) => c.z === zLo).map((c) => c.y), yHi = corners.filter((c) => c.z === zHi).map((c) => c.y);
    assert.equal(zHi - zLo, 1, 'a rail spans one block along the track');
    assert.ok(Math.abs(yLo[0]! - yLo[1]!) < 1e-6 && Math.abs(yHi[0]! - yHi[1]!) < 1e-6, 'level across the track');
    const rise = yLo[0]! - yHi[0]!;
    assert.ok(Math.abs(rise) < 1e-6 || Math.abs(Math.abs(rise) - 1) < 1e-6, `flat or a 45 degree ramp (rise ${rise})`);
    if (rise > 0.5) up++;
    else if (rise < -0.5) down++;
    for (const [z, y] of [[zLo, yLo[0]!], [zHi, yHi[0]!]] as const) {
      const list = edges.get(z) ?? [];
      list.push(y);
      edges.set(z, list);
    }
  }
  return { edges, up, down };
}
/** Every edge shared by two rails has the same height on both sides; returns the number of such joints. */
function assertRailsConnect(edges: Map<number, number[]>): number {
  let joints = 0;
  for (const [z, ys] of edges) {
    assert.ok(ys.length <= 2, `at most two rails meet at z=${z}`);
    if (ys.length < 2) continue;
    assert.ok(Math.abs(ys[0]! - ys[1]!) < 1e-6, `the rails meeting at z=${z} join (${ys[0]} vs ${ys[1]})`);
    joints++;
  }
  return joints;
}

test('voxel mesher: a rail below the next one ramps up 45 degrees to meet it, as in the block game', () => {
  // A staircase of rails along z (up, up, flat, down), each on a brick, and a flat run around it.
  const n = 14, sx = 3;
  const data = new Uint8Array(sx * n * n);
  const at = (x: number, y: number, z: number) => x + sx * (z + n * y);
  const levels = [2, 2, 3, 4, 4, 4, 3, 2, 2, 3, 2];
  levels.forEach((dl, i) => {
    data[at(1, dl, i + 1)] = B.netherBricks;
    data[at(1, dl + 1, i + 1)] = i % 3 === 0 ? B.poweredRail : B.rail;
  });
  const m = meshVolume({ data, sx, sy: n, sz: n, ox: 0, oy: 0, oz: 0 }, null, false);
  const { edges, up, down } = railEdges(m.cross);
  assert.equal(assertRailsConnect(edges), levels.length - 1, 'every pair of neighbouring rails joins');
  assert.ok(up > 0 && down > 0, 'ramps both ways');
  // The ramp lies in the lower cell, from 1/16 over its floor to 1/16 over the next floor.
  const ys = edges.get(3)!;
  assert.ok(Math.abs(ys[0]! - (4 + RAIL_LIFT)) < 1e-6, `the joint sits on the upper rail (${ys[0]})`);
});

test('voxel Nether: a single-row pit in the deck is raised, so a rail never needs to ramp both ways', () => {
  const offsets = new Map([[0, 0.6], [1, 0.4], [2, 0.55], [3, 1.4], [4, 2.6]]);
  const at = (bd: number) => offsets.get(bd) ?? null;
  const dl = (bd: number) => railDeckLayer(at, bd)! - ROAD.layer;
  assert.deepEqual([0, 1, 2, 3, 4].map(dl), [1, 1, 1, 1, 3], 'the pit at row 1 is filled; the rest keep their rounded height');
  assert.equal(railDeckLayer(at, 9), null);
});

test('voxel Nether: the rails of a whole visit always connect, inside segments and across their boundaries', () => {
  const tl = pulsingTrack(20, 80, 110);
  const p = createVoxelPath(tl, worldSeed);
  const t = voxelTerrain(tl, worldSeed);
  const iv = scheduleOf(tl).intervals[0]!;
  const offsetAt = railOffsets(tl, iv);
  const first = Math.floor(p.distanceAt(iv.t0) / L), last = Math.floor(p.distanceAt(iv.t1) / L);
  const edges = new Map<number, number[]>();
  let up = 0, down = 0, rows = 0;
  for (let s = first; s <= last; s++) {
    // The deck itself never steps by more than one layer between neighbouring rows.
    for (let bd = s * L; bd < (s + 1) * L; bd++) {
      const a = railDeckLayer(offsetAt, bd), b = railDeckLayer(offsetAt, bd + 1);
      if (a === null || b === null) continue;
      assert.ok(Math.abs(a - b) <= 1, `row ${bd}: the deck steps ${b - a} layers`);
      rows++;
    }
    const vol = buildNetherVolume(t, s * L, L, offsetAt, [], LIGHT_REACH);
    if (!vol) continue;
    const r = railEdges(meshVolume(vol, null, false).cross, edges);
    up += r.up;
    down += r.down;
  }
  const joints = assertRailsConnect(edges);
  assert.ok(rows > 200 && joints > 200, `a long track was checked (${rows} rows, ${joints} joints)`);
  assert.ok(up > 0 && down > 0, `the track climbs (${up} ramps) and descends (${down} ramps)`);
  // Only the two ends of the rails are loose: everything else is one continuous track.
  assert.equal([...edges.values()].filter((ys) => ys.length === 1).length, 2);
});

test('voxel: the exit portal stands on the Nether bridge, as the entry one does', () => {
  const t = voxelTerrain(timeline, worldSeed);
  const iv = scheduleOf(timeline).intervals[0]!;
  for (const tt of [iv.t0, iv.t1 - 1e-3]) {
    const bd = Math.floor(path.distanceAt(tt));
    const offsetAt = railOffsets(timeline, iv);
    const start = Math.floor(bd / L) * L;
    const v = buildNetherVolume(t, start, L, offsetAt, [{ bd, offset: offsetAt(bd) ?? offsetAt(bd + 1)! }], 0);
    assert.ok(v, 'the segment has Nether rows');
    assert.ok(v!.data.some((id) => id === B.portal), `portal blocks at the ${tt === iv.t0 ? 'entry' : 'exit'}`);
  }
  // The rail height just before the exit is the Nether's, not the road's.
  assert.ok(path.heightAt(iv.t1 - 1e-3) < -50);
});

test('voxel Nether: the cavern goes on past the exit portal, level, up to beyond the haze', () => {
  const iv = scheduleOf(timeline).intervals[0]!;
  const d1 = path.distanceAt(iv.t1);
  // The segment right after the exit portal still has Nether blocks, with the rail at the exit's height.
  const afterExit = Math.floor((d1 + 40) / L);
  const seg = voxelLogic.generateSegment(input(afterExit));
  assert.ok(seg.nether !== null, 'Nether blocks past the exit portal');
  // ... and the tail ends: far past the exit there is none.
  const farAfter = Math.floor((d1 + NETHER.exitTail + 2 * L) / L);
  assert.equal(voxelLogic.generateSegment(input(farAfter)).nether, null);
});

/** Synthetic track: a kick drum (a low thump with a click) every 60 / bpm s over a quiet pad. */
function kickTrack(bpm: number, duration: number, from = 0): Timeline {
  const left = new Float32Array(duration * SR);
  const period = 60 / bpm;
  for (let i = 0; i < left.length; i++) {
    const t = i / SR;
    let v = 0.02 * Math.sin(2 * Math.PI * 330 * t);
    if (t >= from) {
      const k = (t - from) % period;
      v += Math.exp(-k * 30) * (0.7 * Math.sin(2 * Math.PI * 60 * k) + 0.2 * Math.sin(2 * Math.PI * 1800 * k));
    }
    left[i] = v;
  }
  return new Timeline(analyzeTrack(left, left, SR));
}

test('voxel beats: a steady kick gives one beat per kick, on time, at its tempo', () => {
  for (const bpm of [96, 128, 150]) {
    const tl = kickTrack(bpm, 30);
    const beats = beatTimes(tl);
    const period = 60 / bpm;
    const expected = Math.floor(30 / period);
    assert.ok(Math.abs(beats.length - expected) <= 2, `${bpm} BPM: ${beats.length} beats, expected about ${expected}`);
    // Every inner beat sits on a kick (within 30 ms) and the spacing is the period.
    let onKick = 0;
    for (let i = 1; i < beats.length - 1; i++) {
      const phase = beats[i]! % period;
      if (Math.min(phase, period - phase) < 0.03) onKick++;
      assert.ok(Math.abs(beats[i]! - beats[i - 1]! - period) < 0.03, `${bpm} BPM: beat ${i} spaced ${(beats[i]! - beats[i - 1]!).toFixed(3)} s`);
    }
    assert.ok(onKick >= beats.length - 3, `${bpm} BPM: ${onKick} of ${beats.length} beats on a kick`);
    for (let i = 1; i < beats.length; i++) assert.ok(beats[i]! > beats[i - 1]!);
  }
});

test('voxel beats: no beats in silence; deterministic; counted by binary search', () => {
  const tl = kickTrack(120, 20, 8);
  const beats = beatTimes(tl);
  assert.ok(beats.length > 15, `beats once the kick starts (${beats.length})`);
  assert.ok(beats[0]! > 7.5, `no beat in the quiet intro (first at ${beats[0]!.toFixed(2)} s)`);
  assert.deepEqual([...beatTimes(kickTrack(120, 20, 8))], [...beats]);
  assert.equal(beatsUpTo(beats, 0), 0);
  assert.equal(beatsUpTo(beats, beats[3]!), 4);
  assert.equal(beatsUpTo(beats, 1e9), beats.length);
  assert.ok(BEATS.minBpm < BEATS.centreBpm && BEATS.centreBpm < BEATS.maxBpm);
});

test('voxel: the overworld light posts keep glowstone; the Nether redstone lamp is an always-lit light source', () => {
  const t = voxelTerrain(timeline, worldSeed);
  let lamps = 0, glowstone = 0;
  for (let index = 0; index < 8; index++) {
    const { volume: v } = buildVolume(t, index * L, L);
    for (let bd = index * L; bd < (index + 1) * L; bd++) {
      if (bd % ROAD.postSpacing !== 0 || profileAt(t, bd).kind !== RoadKind.Land) continue;
      const s = Math.floor(bd / ROAD.postSpacing) % 2 === 0 ? 1 : -1;
      const dl = ROAD.layer + Math.round(profileAt(t, bd).offset);
      const at = (bx: number, y: number) => v.data[(bx - v.ox) + v.sx * ((-bd - 1 - v.oz) + v.sz * (y - v.oy))]!;
      if (at(s * ROAD.postX - s, dl + ROAD.postHeight - 1) === B.redstoneLamp) lamps++;
      if (at(s * ROAD.postX - s, dl + ROAD.postHeight - 1) === B.glowstone) glowstone++;
    }
  }
  assert.ok(glowstone >= 10, `posts with a glowstone (${glowstone})`);
  assert.equal(lamps, 0, 'no redstone lamp in the overworld');
  // The lamp: the lit texture, a steady light source (emissive, block light 15), like glowstone.
  const info = BLOCKS[B.redstoneLamp]!;
  assert.ok(info.faces.every((l) => l === LAYER.redstoneLampOn));
  assert.ok(hasFlag(info.flags, FLAG.emissive));
  const n = 12;
  const data = new Uint8Array(n * n * n);
  data[6 + n * (6 + n * 6)] = B.redstoneLamp;
  const light = computeLight({ data, sx: n, sy: n, sz: n, ox: 0, oy: 0, oz: 0 }, false);
  assert.equal(light.block[7 + n * (6 + n * 6)], 14);
  assert.equal(light.block[9 + n * (6 + n * 6)], 12);
});

/** Synthetic track: a kick every 60 / bpm s, quiet outside the loud [from, to) passage (which becomes a Nether visit). */
function kickPassage(bpm: number, duration: number, loud: [number, number]): Timeline {
  const left = new Float32Array(duration * SR);
  const period = 60 / bpm;
  let s = 99;
  for (let i = 0; i < left.length; i++) {
    const t = i / SR, k = t % period;
    s = (Math.imul(s, 1103515245) + 12345) | 0;
    const noise = ((s >>> 8) / 16777216) * 2 - 1;
    const g = t >= loud[0] && t < loud[1] ? 1 : 0.15;
    left[i] = g * (0.25 * noise * Math.exp(-k * 8) + Math.exp(-k * 30) * 0.7 * Math.sin(2 * Math.PI * 60 * k));
  }
  return new Timeline(analyzeTrack(left, left, SR));
}

test('voxel Nether: each light post leaves the screen 80..150 ms after a bass beat, never bunched up', () => {
  const tl = kickPassage(128, 80, [20, 45]);
  const p = createVoxelPath(tl, seedOf('b'));
  const iv = scheduleOf(tl).intervals[0]!;
  assert.ok(iv, 'the loud passage is a Nether visit');
  const beats = bassBeatTimes(tl);
  const rows = netherPostRows(tl, p);
  assert.deepEqual([...netherPostRows(tl, createVoxelPath(tl, seedOf('b')))], [...rows], 'deterministic');
  const entry = p.distanceAt(iv.t0), exit = p.distanceAt(iv.t1);
  const inside = [...rows].filter((r) => r > entry && r < exit);
  assert.ok(inside.length >= 30, `posts along the visit (${inside.length})`);
  for (const r of inside) {
    const te = postExitTime(p, r);
    const lead = Math.min(...[...beats].map((b) => (te - b >= 0 ? te - b : Infinity)));
    assert.ok(lead >= POSTS.windowS[0] - 1e-6 && lead <= POSTS.windowS[1] + 1e-6, `row ${r}: leaves the screen ${(lead * 1000).toFixed(0)} ms after a beat`);
    assert.ok(isPostRow(rows, r) && !isPostRow(rows, r + 1));
  }
  // Spacing: never closer than minGap, never farther than maxGap; fast beats make posts skip to every 2nd or 3rd beat.
  for (let i = 1; i < inside.length; i++) {
    const gap = inside[i]! - inside[i - 1]!;
    assert.ok(gap >= POSTS.minGap && gap <= POSTS.maxGap, `gap ${gap} at row ${inside[i]}`);
  }
  const mean = (inside[inside.length - 1]! - inside[0]!) / (inside.length - 1);
  assert.ok(mean >= POSTS.minGap && mean <= 2.5 * POSTS.spacing, `mean spacing ${mean.toFixed(1)} rows`);
  // The exit time is where the post really goes off screen: a moment before it, it is still in view.
  const r = inside[5]!;
  assert.ok(postExitTime(p, r) > p.timeAt(r - 6) && postExitTime(p, r) < p.timeAt(r + 1));
});

test('voxel Nether: without usable beats the posts fall back to an even spacing', () => {
  const p = createVoxelPath(timeline, worldSeed);
  const iv = scheduleOf(timeline).intervals[0]!;
  const rows = [...netherPostRows(timeline, p)].filter((r) => r > p.distanceAt(iv.t0) && r < p.distanceAt(iv.t1));
  assert.ok(rows.length >= 10, `posts along the visit (${rows.length})`);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i]! - rows[i - 1]! >= POSTS.minGap && rows[i]! - rows[i - 1]! <= POSTS.maxGap);
});

test('voxel Nether: the light posts stand on the bridge, a fence column from the deck up to the lamp', () => {
  const iv = scheduleOf(timeline).intervals[0]!;
  const t = voxelTerrain(timeline, worldSeed);
  const offsetAt = railOffsets(timeline, iv);
  const first = Math.floor(path.distanceAt(iv.t0) / L) + 1;
  let posts = 0;
  for (let s = first; s < first + 3; s++) {
    const v = buildNetherVolume(t, s * L, L, offsetAt, [], 0)!;
    const at = (bx: number, y: number, bd: number) => v.data[(bx - v.ox) + v.sx * ((-bd - 1 - v.oz) + v.sz * (y - v.oy))]!;
    for (let bd = s * L; bd < (s + 1) * L; bd++) {
      const dl = railDeckLayer(offsetAt, bd);
      if (dl === null || bd % NETHER.postSpacing !== 0) continue;
      for (const side of [-1, 1]) {
        const px = side * NETHER.postX;
        assert.equal(at(px, dl, bd), B.netherBricks, `row ${bd}: the post stands on nether bricks`);
        for (let y: number = dl + 1; y <= dl + ROAD.postHeight; y++) assert.equal(at(px, y, bd), B.netherFence, `row ${bd}: fence at ${y - dl}`);
        assert.equal(at(px - side, dl + ROAD.postHeight, bd), B.netherFence, 'the arm');
        assert.equal(at(px - side, dl + ROAD.postHeight - 1, bd), B.redstoneLamp, 'the lamp under the arm');
        posts++;
      }
    }
  }
  assert.ok(posts >= 16, `posts along the bridge (${posts})`);
});

/** Kicks every `period` s, each followed by a second kick `double` s later (a "tum-tum"), and a mid snare halfway. */
function doubleKickTrack(duration: number, period: number, double: number): Timeline {
  const left = new Float32Array(duration * SR);
  let noise = 1;
  for (let i = 0; i < left.length; i++) {
    const t = i / SR, s = (t + period / 2) % period;
    noise = (noise * 16807) % 2147483647;
    let v = 0.02 * Math.sin(2 * Math.PI * 330 * t);
    for (const off of [0, double]) {
      if (t < off) continue;
      const k = (t - off) % period;
      v += Math.exp(-k * 30) * 0.7 * Math.sin(2 * Math.PI * 60 * k);
    }
    v += Math.exp(-s * 25) * (0.35 * Math.sin(2 * Math.PI * 700 * s) + 0.15 * (noise / 2147483647 - 0.5));
    left[i] = v;
  }
  return new Timeline(analyzeTrack(left, left, SR));
}

test('voxel pulsed blocks: follow the band level every frame, so each kick of a "tum-tum" flashes; dark between; deterministic', () => {
  const period = 0.5, double = 0.15, duration = 12;
  const tl = doubleKickTrack(duration, period, double);
  const p = cavePulse(tl, 0, duration);
  assert.deepEqual(cavePulse(tl, 0, duration), p);
  for (let b = 2; b < 20; b++) {
    for (const off of [0, double]) {
      const t = b * period + off;
      // Each kick rises near the top, and the light falls back to dark before the next kick.
      let peak = 0;
      for (let x = t - 0.01; x <= t + 0.04; x += 0.005) peak = Math.max(peak, pulseAt(p, x).bass);
      assert.ok(peak > 0.8, `kick at ${t.toFixed(2)} s flashes (${peak.toFixed(2)})`);
      const gap = t + (off === 0 ? double : period - double) - 0.03;
      assert.ok(pulseAt(p, gap).bass < 0.15, `dark before the next kick (${t.toFixed(2)} s)`);
    }
    // The snare halfway lights the mids channel.
    let mid = 0;
    for (let x = b * period + period / 2 - 0.01; x <= b * period + period / 2 + 0.04; x += 0.005) mid = Math.max(mid, pulseAt(p, x).mid);
    assert.ok(mid > 0.6, `snare at beat ${b} (${mid.toFixed(2)})`);
  }
  // Silence: nothing glows.
  const zeros = new Float32Array(10 * SR);
  const silent = cavePulse(new Timeline(analyzeTrack(zeros, zeros, SR)), 0, 10);
  assert.deepEqual(pulseAt(silent, 5), { bass: 0, mid: 0 });
});

test('voxel pulsed blocks: only the cave wall lamps and the Nether glowstone follow the music; ceiling glowstone, lava falls and the overworld are steady', () => {
  const kindOf = (id: number) => (hasFlag(BLOCKS[id]!.flags, FLAG.energy) ? BLOCKS[id]!.flags & FLAG.tintMask : -1);
  assert.equal(kindOf(B.netherGlowstone), BAND.bass);
  assert.equal(kindOf(B.caveLamp), BAND.mid);
  assert.equal(kindOf(B.caveGlowstone), -1);
  assert.equal(kindOf(B.lavaFall), -1);
  assert.equal(kindOf(B.glowstone), -1);
  assert.equal(kindOf(B.lava), -1);
  assert.ok(hasFlag(BLOCKS[B.caveGlowstone]!.flags, FLAG.emissive) && hasFlag(BLOCKS[B.lavaFall]!.flags, FLAG.emissive));
  // The falls are the same lava: light, fluid faces (none between still and falling lava).
  assert.deepEqual(BLOCKS[B.lavaFall]!.faces, BLOCKS[B.lava]!.faces);
  assert.equal(LIGHT_EMIT[B.lavaFall], LIGHT_EMIT[B.lava]);
  assert.equal(LIGHT_EMIT[B.netherGlowstone], LIGHT_EMIT[B.glowstone]);
  assert.equal(LIGHT_EMIT[B.caveGlowstone], LIGHT_EMIT[B.glowstone]);
  assert.equal(OPAQUE[B.lavaFall], 0);
});

test('voxel caves: no redstone ore (removed); the ceiling glowstone and wall lamps remain', () => {
  const t = voxelTerrain(timeline, worldSeed);
  const counts = new Map<number, number>();
  for (const [a, b] of t.caves.ranges) {
    for (let k = Math.floor(a / L); k <= Math.floor((b - 1) / L); k++) {
      const { volume: v } = buildVolume(t, k * L, L);
      for (const id of v.data) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  assert.equal(counts.get(37) ?? 0, 0, 'no block with the old redstone ore id');
  assert.ok((counts.get(B.caveGlowstone) ?? 0) > 0 && (counts.get(B.caveLamp) ?? 0) > 0);
});

test('voxel road: the deck never skips a step, not even where a bridge meets a cave mouth', () => {
  // Scenario version 31 (user-reported): a river against a cave mouth cut its arch short at the first cave row, so the
  // deck and the camera dropped 2-3 blocks in one row. Seeds a..z with three cave sections found 27 such rows before.
  const tl = track([[20, 45], [70, 95], [120, 140]], 160);
  let mouths = 0;
  for (const k of 'abcdefghijklmnopqrstuvwxyz') {
    const t = voxelTerrain(tl, seedOf(k));
    const end = t.caves.ranges.at(-1)![1] + 300;
    let prev = deckLayer(profileAt(t, 0).offset);
    for (let d = 1; d < end; d++) {
      const dl = deckLayer(profileAt(t, d).offset);
      assert.ok(Math.abs(dl - prev) <= 1, `seed ${k}: deck jumps ${dl - prev} layers at row ${d}`);
      prev = dl;
    }
    for (const [a, b] of t.caves.ranges) for (const edge of [a - 1, b]) if (profileAt(t, edge).kind === RoadKind.Bridge) mouths++;
  }
  assert.ok(mouths > 0, 'some bridge meets a cave mouth');
});

test('voxel road: bridge decks climb and fall on oak stairs (high half toward the higher row), planks on the level', () => {
  assert.equal(deckStairAt(4, 5, 6), B.oakStairsAhead);
  assert.equal(deckStairAt(6, 5, 4), B.oakStairsBehind);
  assert.equal(deckStairAt(5, 5, 5), null);
  assert.equal(deckStairAt(4, 5, 4), null, 'the crest stays planks');
  const tl = track([[20, 45]], 80);
  let stairs = 0;
  for (const k of 'abcdefgh') {
    const t = voxelTerrain(tl, seedOf(k));
    for (let s = -1; s < 6; s++) {
      const { volume: v } = buildVolume(t, s * L, L);
      for (let bd = s * L; bd < (s + 1) * L; bd++) {
        const p = profileAt(t, bd);
        if (p.kind !== RoadKind.Bridge && p.kind !== RoadKind.Causeway) continue;
        const dl = deckLayer(p.offset);
        const want = deckStairAt(deckLayer(profileAt(t, bd - 1).offset), dl, deckLayer(profileAt(t, bd + 1).offset));
        const got = v.data[(0 - v.ox) + v.sx * ((-bd - 1 - v.oz) + v.sz * (dl - v.oy))]!;
        assert.equal(got, want ?? B.oakPlanks, `seed ${k} row ${bd}`);
        if (want !== null) stairs++;
      }
    }
  }
  assert.ok(stairs > 0, 'some bridge has stairs');
});

test('voxel camera: the view stays level on steps, bridges and Nether ramps, and the Nether posts assume the same camera', () => {
  assert.equal(voxelLogic.config.pathTilt, 0);
  assert.equal(POSTS.pathTilt, voxelLogic.config.pathTilt);
});

test('voxel Nether: glowstone is in view all along a visit, also where low rock hides the high roofs', () => {
  // A visibility probe: from the eye every 8 rows, the exposed glowstone faces ahead within 56 m (the Nether fog ends at about 61 m) and inside a wide view
  // are ray-marched through the volume (opaque blocks stop the ray). Every stop must see some glowstone.
  const tl = pulsingTrack(20, 80, 110);
  const EYE = ROAD.eyeAbove + 0.6, REACH = 56, STEP = 8, MIN_VISIBLE = 4;
  const clear = new Set<number>([B.air, B.netherGlowstone, B.rail, B.poweredRail, B.netherFence, B.lavaFall]);
  for (const key of ['a', 'b', 'c']) {
    const seed = seedOf(key), p = createVoxelPath(tl, seed), t = voxelTerrain(tl, seed);
    const iv = scheduleOf(tl).intervals[0]!;
    const offsetAt = railOffsets(tl, iv);
    const d0 = Math.ceil(p.distanceAt(iv.t0)) + 10, d1 = Math.floor(p.distanceAt(iv.t1)) - REACH - 10;
    const len = d1 - d0 + REACH + 2;
    const { data, sx, sy, sz, ox, oy } = buildNetherVolume(t, d0, len, offsetAt, [], 0)!;
    const layer = sx * sz, rowOf = (bd: number) => d0 + len - bd;
    const get = (bx: number, y: number, bd: number) => {
      const x = bx - ox, yy = y - oy, z = rowOf(bd);
      return x < 0 || x >= sx || yy < 0 || yy >= sy || z < 0 || z >= sz ? B.netherrack : data[x + sx * (z + sz * yy)]!;
    };
    // Exposed glowstone (an air neighbour), grouped by row.
    const byRow = new Map<number, [number, number][]>();
    for (let z = 1; z < sz - 1; z++) for (let y = 1; y < sy - 1; y++) for (let x = 1; x < sx - 1; x++) {
      const i = x + sx * (z + sz * y);
      if (data[i] !== B.netherGlowstone || ![i - 1, i + 1, i - sx, i + sx, i - layer].some((j) => data[j] === B.air)) continue;
      const bd = d0 + len - z;
      if (!byRow.has(bd)) byRow.set(bd, []);
      byRow.get(bd)!.push([x + ox, y + oy]);
    }
    let worst = Infinity;
    for (let cam = d0; cam < d1; cam += STEP) {
      const ey = ROAD.layer + offsetAt(cam)! + EYE;
      let seen = 0;
      for (let bd = cam + 2; bd < cam + REACH && seen < MIN_VISIBLE; bd++) for (const [bx, y] of byRow.get(bd) ?? []) {
        const vx = bx + 0.5, vy = y + 0.5 - ey, dz = bd + 0.5 - cam, dist = Math.hypot(vx, vy, dz);
        if (dist > REACH || Math.abs(vx) > dz * 1.4 + 2) continue;
        const n = Math.ceil(dist * 2);
        let open = true;
        for (let k = 1; k < n - 2 && open; k++) open = clear.has(get(Math.floor(vx * k / n), Math.floor(ey + vy * k / n), Math.floor(cam + dz * k / n)));
        if (open && ++seen >= MIN_VISIBLE) break;
      }
      worst = Math.min(worst, seen);
    }
    assert.ok(worst >= MIN_VISIBLE, `world ${key}: some stop of the visit sees only ${worst} glowstone blocks`);
  }
});

test('voxel rails: the grade becomes runs of 45 degree ramps with level rows between them, within a band under the grade', () => {
  for (const grade of [-1, -0.6, -0.3, -0.05, 0.28]) {
    const target = Array.from({ length: 400 }, (_, i) => grade * i + 0.8 * Math.sin(i / 11));
    const q = quantizeRails(target);
    let runs = 0, rampRows = 0, lo = 0, hi = 0;
    for (let i = 1; i < q.length; i++) {
      const step = q[i]! - q[i - 1]!;
      assert.ok(Math.abs(step) <= 1, 'at most one layer per row');
      // A ramp toward both neighbours (a one-row pit or peak) cannot be built.
      if (i + 1 < q.length) assert.ok(!(q[i - 1]! > q[i]! && q[i + 1]! > q[i]!) && !(q[i - 1]! < q[i]! && q[i + 1]! < q[i]!), `row ${i}: a one-row pit or peak`);
      if (step !== 0) { rampRows++; if (q[i - 1]! - q[i - 2 < 0 ? 0 : i - 2]! !== step) runs++; }
      lo = Math.min(lo, q[i]! - target[i]!);
      hi = Math.max(hi, q[i]! - target[i]!);
    }
    // Within the band, give or take one row of a reversal (the level row it needs).
    assert.ok(lo >= -RAILS.below - 1.3 && hi <= RAILS.above + 1.3, `grade ${grade}: rails between ${lo.toFixed(2)} and ${hi.toFixed(2)} of it`);
    if (Math.abs(grade) > 0.5) assert.ok(rampRows / runs >= 2.5, `grade ${grade}: ramps come in runs (${(rampRows / runs).toFixed(1)} rows each)`);
  }
  assert.deepEqual([...quantizeRails([0.2, -0.3, 0.4, 0.1])], [0, 0, 0, 0], 'small wiggles stay level');
});

test('voxel rails: the rail surface is level on flat rows and climbs 1 m over a ramp row; smoothed, the slope is 0 or 1', () => {
  const layers = new Map([[0, 4], [1, 4], [2, 4], [3, 5], [4, 6], [5, 6], [6, 6]]);
  const at = (bd: number) => layers.get(bd) ?? null;
  // Row 2 ramps up to row 3 (one layer up, toward +d), so its surface runs from 5 to 6.
  assert.equal(railSurfaceAt(at, 1.5), 5);
  assert.equal(railSurfaceAt(at, 2.25), 5.25);
  assert.equal(railSurfaceAt(at, 3.5), 6.5);
  assert.equal(railSurfaceAt(at, 5.5), 7);
  assert.equal(railSurfaceAt(at, 9), null);
  assert.ok(Math.abs(smoothRailSlopeAt(at, 1)!) < 1e-9);
  assert.ok(Math.abs(smoothRailSlopeAt(at, 3)! - 1) < 1e-9);
  const s = smoothRailSlopeAt(at, 2 + RAILS.smoothM / 2)!;
  assert.ok(s > 0 && s < 1, 'the corner is rounded');
});

test('voxel Nether: the camera rides the smooth wave, seated over rails that keep within their band; ramps and level rails', () => {
  const tl = pulsingTrack(20, 80, 110);
  const p = createVoxelPath(tl, worldSeed);
  const iv = scheduleOf(tl).intervals[0]!;
  const rails = netherRailsOf(p)!;
  assert.equal(rails, netherRails(tl), 'the path rides the timeline\'s rail table');
  let ramps = 0, flats = 0;
  for (let t = iv.t0 + 0.5; t < iv.t1 - 0.5; t += 0.05) {
    const d = p.distanceAt(t);
    const surface = railSurfaceAt(rails.layerAt, d)!;
    const eye = voxelLogic.config.eyeHeight + p.heightAt(t);
    // The rails stay in a band under the seated eye: never up through the cart, never far below it.
    const gap = eye - RAILS.eyeAbove - surface;
    assert.ok(gap >= -RAILS.above - 1.1 && gap <= RAILS.below + 1.3, `t=${t.toFixed(2)}: the rails ${gap.toFixed(2)} m under the cart`);
    const slope = smoothRailSlopeAt(rails.layerAt, d)!;
    if (Math.abs(Math.abs(slope) - 1) < 1e-9) ramps++;
    else if (Math.abs(slope) < 1e-9) flats++;
  }
  assert.ok(ramps > 50 && flats > 50, `the cart rides 45 degree ramps (${ramps}) and level rails (${flats})`);
  // The segment descriptors carry the same rails, for the minecart.
  const index = Math.floor(p.distanceAt((iv.t0 + iv.t1) / 2) / L);
  const seg = voxelLogic.generateSegment(input(index, worldSeed, p, tl));
  assert.ok(seg.rails && seg.rails.length === L + 2);
  for (let i = 0; i < seg.rails!.length; i++) {
    const l = rails.layerAt(index * L - 1 + i);
    assert.equal(seg.rails![i], l === null ? RAILS_NONE : l - ROAD.layer);
  }
  // No rails, no rail table in the overworld segments of a world without a Nether.
  assert.equal(voxelLogic.generateSegment(input(0, worldSeed, createVoxelPath(track([], 30), worldSeed), track([], 30))).rails, null);
});

test('voxel minecart: the block game proportions (20 x 16 x 10 px), walls 2 px thick, uv inside the texture', () => {
  const g = minecartGeometry();
  g.computeBoundingBox();
  const { min, max } = g.boundingBox!;
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  assert.ok(close(max.x - min.x, 1) && close(max.z - min.z, 1.25) && close(max.y - min.y, 0.625), 'one block wide, 1.25 long, 0.625 tall');
  assert.ok(close(min.y + CART_PIVOT, 0.0625), 'the floor rides 1/16 over the rail');
  assert.equal(g.getIndex()!.count / 6, 30, 'five boxes, six faces each');
  const n = g.getAttribute('normal'), pos = g.getAttribute('position'), uv = g.getAttribute('uv');
  const up = new Set<string>();
  for (let i = 0; i < n.count; i++) if (n.getY(i) > 0.99) up.add((pos.getY(i) + CART_PIVOT).toFixed(4));
  assert.deepEqual([...up].sort(), ['0.1875', '0.6875'], 'the floor top 2 px up, the wall rims 11 px up');
  for (let i = 0; i < uv.count * 2; i++) assert.ok(uv.array[i]! >= 0 && uv.array[i]! <= 1);
});
