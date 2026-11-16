import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../src/audio/analysis/analyze.ts';
import { Timeline } from '../src/audio/intelligence/timeline.ts';
import { BOX_STRIDE, ISLANDS, KIND, TREES, voxelLogic, type VoxelSegment } from '../src/scenarios/voxel/logic.ts';
import { PACE, createVoxelPath, islandIntensityAt } from '../src/scenarios/voxel/path.ts';
import { createWorldSeed, deriveSeed } from '../src/world/identity/seed.ts';
import type { SegmentInput } from '../src/scenarios/types.ts';

const SR = 44100;
/** 30 s: quiet tone (0-10 s), loud noisy section (10-20 s), quiet again (20-30 s). */
function contrastTrack(): Timeline {
  const left = new Float32Array(30 * SR);
  let s = 12345;
  for (let i = 0; i < left.length; i++) {
    const t = i / SR;
    s = (Math.imul(s, 1103515245) + 12345) | 0;
    const noise = ((s >>> 8) / 16777216) * 2 - 1;
    const loud = t >= 10 && t < 20;
    left[i] = loud ? 0.5 * noise + 0.3 * Math.sin(2 * Math.PI * 80 * t) : 0.03 * Math.sin(2 * Math.PI * 220 * t);
  }
  return new Timeline(analyzeTrack(left, left, SR));
}

const timeline = contrastTrack();
const path = createVoxelPath(timeline);
const worldSeed = createWorldSeed({ audioIdentity: 'a'.repeat(64), scenarioId: voxelLogic.id, scenarioVersion: voxelLogic.version });
const L = voxelLogic.config.segmentLength;

function input(index: number, seed = worldSeed): SegmentInput {
  return { index, startDistance: index * L, length: L, worldSeed: seed, seed: deriveSeed(seed, 'segment', index), timeline, speed: voxelLogic.config.speed, path };
}

const boxes = (data: Float32Array) => {
  const out: { x: number; d: number; y0: number; y1: number; sx: number; sd: number; kind: number; lift: number }[] = [];
  for (let o = 0; o < data.length; o += BOX_STRIDE) out.push({ x: data[o]!, d: data[o + 1]!, y0: data[o + 2]!, y1: data[o + 3]!, sx: data[o + 4]!, sd: data[o + 5]!, kind: data[o + 6]!, lift: data[o + 7]! });
  return out;
};

test('voxel: a segment is reproducible and independent of generation order', () => {
  const a = voxelLogic.generateSegment(input(5));
  voxelLogic.generateSegment(input(12));
  const b = voxelLogic.generateSegment(input(5));
  assert.deepEqual(a, b);
});

test('voxel: different worlds differ; the river under the camera stays clear', () => {
  const other = createWorldSeed({ audioIdentity: 'b'.repeat(64), scenarioId: voxelLogic.id, scenarioVersion: voxelLogic.version });
  const a = voxelLogic.generateSegment(input(3));
  assert.notDeepEqual(a.ground, voxelLogic.generateSegment(input(3, other)).ground);
  for (let i = 0; i < 40; i++) {
    const seg = voxelLogic.generateSegment(input(i));
    for (const b of boxes(seg.ground)) assert.ok(Math.abs(b.x) > 8, `ground box at x=${b.x} blocks the river`);
  }
});

test('voxel: columns are owned by exactly one segment (no seams, no duplicates)', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const seg = voxelLogic.generateSegment(input(i));
    for (const b of boxes(seg.ground).filter((b) => b.kind === 0)) {
      const key = `${b.x},${b.d}`;
      assert.ok(!seen.has(key), `column ${key} generated twice`);
      seen.add(key);
      assert.ok(b.d >= i * L && b.d < (i + 1) * L);
    }
  }
  // Every column of the bank grid exists (as a ground column or as an island piece) between segments 0 and 6.
  const rows = new Set([...seen].map((k) => Number(k.split(',')[1])));
  assert.equal(rows.size, (6 * L) / 5);
});

/** Islands lifted in segments covering track times [t0, t1). */
function islandStats(t0: number, t1: number): { count: number; meanLift: number } {
  const lifts = new Map<number, number>();
  const i0 = Math.floor(path.distanceAt(t0) / L), i1 = Math.floor(path.distanceAt(t1) / L);
  for (let i = i0; i < i1; i++) {
    const seg: VoxelSegment = voxelLogic.generateSegment(input(i));
    for (let o = 0; o < seg.islands.length; o += BOX_STRIDE) lifts.set(seg.islands[o + 9]! * 1e6 + Math.round(seg.islands[o + 7]!), seg.islands[o + 7]!);
  }
  const values = [...lifts.values()];
  const km = (path.distanceAt(t1) - path.distanceAt(t0)) / 1000;
  return { count: values.length / km, meanLift: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length) };
}

test('voxel signature: intense music breaks off more archipelagos, and they float higher', () => {
  assert.ok(islandIntensityAt(timeline, 15) > islandIntensityAt(timeline, 4) + 0.5);
  const calm = islandStats(1, 8), loud = islandStats(12, 18);
  assert.ok(loud.count > calm.count * 1.5, `islands per km: calm ${calm.count.toFixed(1)}, loud ${loud.count.toFixed(1)}`);
  assert.ok(loud.meanLift > calm.meanLift + 30, `mean lift: calm ${calm.meanLift.toFixed(0)}, loud ${loud.meanLift.toFixed(0)}`);
  assert.ok(loud.meanLift <= ISLANDS.altitude[1] * ISLANDS.altitudeSpread[1] + 1e-6);
});

test('voxel trees: block-grid canopies of several boxes, varied sizes, clear of the river', () => {
  const B = TREES.block;
  const sizes = new Set<string>();
  let trunks = 0, leaves = 0, cherry = 0;
  for (let i = 0; i < 30; i++) {
    const seg = voxelLogic.generateSegment(input(i));
    for (const b of [...boxes(seg.ground), ...boxes(seg.islands)]) {
      if (b.kind === KIND.trunk) trunks++;
      if (b.kind !== KIND.canopy && b.kind !== KIND.cherryCanopy) continue;
      leaves++;
      if (b.kind === KIND.cherryCanopy) cherry++;
      assert.ok(Math.abs(b.y1 - b.y0 - B) < 1e-4, 'one leaf layer is one block tall');
      assert.ok(Math.abs(b.x) - b.sx / 2 > TREES.riverClearance - 1e-3, `leaves at x=${b.x} reach over the river`);
      sizes.add(`${b.sx},${b.sd}`);
    }
  }
  assert.ok(trunks > 0 && leaves > trunks * 3, `${leaves} leaf boxes for ${trunks} log boxes`);
  assert.ok(sizes.size > 10, `only ${sizes.size} distinct leaf box footprints`);
  assert.ok(cherry > 0 && cherry < leaves * 0.5);
});

test('voxel: portals and crystals sit on the archipelagos and rise with them', () => {
  let lifted = 0;
  for (let i = 0; i < 60; i++) for (const b of boxes(voxelLogic.generateSegment(input(i)).glow)) if (b.lift > 0) lifted++;
  assert.ok(lifted > 0);
});

test('voxel pace: faster and wider field of view in intense passages; flat river; slow epilogue', () => {
  const v = (t: number) => (path.distanceAt(t + 0.25) - path.distanceAt(t)) / 0.25 * 3.6;
  assert.ok(v(15) > v(5) * 1.4, `calm ${v(5).toFixed(0)} km/h, loud ${v(15).toFixed(0)} km/h`);
  assert.ok(path.fovAt!(15) > path.fovAt!(5) + 4);
  for (const t of [0, 5, 15, 25]) {
    assert.equal(path.heightAt(t), 0);
    assert.ok(v(t) >= PACE.endKmh - 1 && v(t) <= PACE.maxKmh + 1);
  }
  const end = timeline.musicEndS;
  assert.ok(Math.abs(v(end + 3) - PACE.endKmh) < 3, `end speed ${v(end + 3).toFixed(1)}`);
  // Average pace is in Synthwave's range (cruise 280 km/h).
  const avg = (path.distanceAt(end) / end) * 3.6;
  assert.ok(avg > 150 && avg < 450, `average ${avg.toFixed(0)} km/h`);
});

test('voxel pace: timeAt inverts distanceAt and the path is pure', () => {
  for (const t of [0.5, 7, 14.2, 29]) assert.ok(Math.abs(path.timeAt(path.distanceAt(t)) - t) < 1e-6);
  const again = createVoxelPath(timeline);
  for (const t of [1, 13, 27]) assert.equal(again.distanceAt(t), path.distanceAt(t));
});

test('voxel interpret: pure, and each group follows its own driver', () => {
  const at = (f: Partial<Record<'energy' | 'bass' | 'mid' | 'high' | 'flux', number>>) =>
    voxelLogic.interpret({ energy: 0, bass: 0, mid: 0, high: 0, flux: 0, ...f }, worldSeed);
  const base = at({});
  assert.deepEqual(base, at({}));
  assert.ok(at({ bass: 1 }).groundGlow > base.groundGlow && at({ bass: 1 }).portalGlow === base.portalGlow);
  assert.ok(at({ energy: 1 }).portalGlow > base.portalGlow && at({ energy: 1 }).groundGlow === base.groundGlow);
  assert.ok(at({ mid: 1 }).auroraGlow > base.auroraGlow);
  assert.ok(at({ high: 1 }).riverSparkle > base.riverSparkle);
  assert.ok(at({ flux: 1 }).cubeKick > base.cubeKick);
});

test('voxel: a silent track gives a calm, valid world', () => {
  const silent = new Timeline(analyzeTrack(new Float32Array(5 * SR), new Float32Array(5 * SR), SR));
  const p = createVoxelPath(silent);
  assert.ok(Number.isFinite(p.distanceAt(3)) && p.distanceAt(3) > 0);
  const seg = voxelLogic.generateSegment({ ...input(1), timeline: silent, path: p });
  assert.ok(seg.ground.length > 0);
});
