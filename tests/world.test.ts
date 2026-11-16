import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../src/audio/analysis/analyze.ts';
import { Timeline } from '../src/audio/intelligence/timeline.ts';
import { amplitudeAt, synthwaveLogic } from '../src/scenarios/synthwave/logic.ts';
import { PATH } from '../src/scenarios/synthwave/path.ts';
import { createWorldSeed, deriveSeed } from '../src/world/identity/seed.ts';
import { SegmentManager } from '../src/world/segments/manager.ts';
import { PITCH_DOWN_LIMIT_RAD, PITCH_UP_LIMIT_RAD, YAW_LIMIT_RAD, LookState } from '../src/experience/camera/lookState.ts';
import type { SegmentInput } from '../src/scenarios/types.ts';

const SR = 44100;
const left = new Float32Array(20 * SR);
for (let i = 0; i < left.length; i++) left[i] = 0.4 * Math.sin((2 * Math.PI * 70 * i) / SR) * (1 + Math.sin(i / SR)) / 2;
const timeline = new Timeline(analyzeTrack(left, left, SR));
const worldSeed = createWorldSeed({ audioIdentity: 'f'.repeat(64), scenarioId: 'synthwave', scenarioVersion: synthwaveLogic.version });
const L = synthwaveLogic.config.segmentLength;

function input(index: number, seed = worldSeed): SegmentInput {
  return { index, startDistance: index * L, length: L, worldSeed: seed, seed: deriveSeed(seed, 'segment', index), timeline, speed: synthwaveLogic.config.speed };
}

test('a segment is reproducible: regenerating it gives identical output', () => {
  const a = synthwaveLogic.generateSegment(input(3));
  synthwaveLogic.generateSegment(input(9)); // generating others in between must not matter
  const b = synthwaveLogic.generateSegment(input(3));
  assert.deepEqual(a.heights, b.heights);
});

test('adjacent segments share their boundary row (no seams)', () => {
  const a = synthwaveLogic.generateSegment(input(4));
  const b = synthwaveLogic.generateSegment(input(5));
  const stride = a.cols + 1;
  assert.deepEqual(a.heights.slice(a.rows * stride), b.heights.slice(0, stride));
});

test('different worlds differ; the road stays flat; mountains rise', () => {
  const other = createWorldSeed({ audioIdentity: '0'.repeat(64), scenarioId: 'synthwave', scenarioVersion: synthwaveLogic.version });
  const a = synthwaveLogic.generateSegment(input(2));
  const b = synthwaveLogic.generateSegment(input(2, other));
  assert.notDeepEqual(a.heights, b.heights);
  const mid = Math.floor(a.cols / 2);
  for (let r = 0; r <= a.rows; r++) assert.equal(a.heights[r * (a.cols + 1) + mid], 0);
  assert.ok(Math.max(...a.heights) > 10);
});

test('interpret is pure and responds to bass', () => {
  const quiet = synthwaveLogic.interpret({ energy: 0, bass: 0, mid: 0, high: 0, flux: 0 }, worldSeed);
  const loud = synthwaveLogic.interpret({ energy: 1, bass: 1, mid: 0, high: 0, flux: 0 }, worldSeed);
  assert.ok(loud.gridGlow > quiet.gridGlow && loud.sunScale > quiet.sunScale);
  assert.deepEqual(quiet, synthwaveLogic.interpret({ energy: 0, bass: 0, mid: 0, high: 0, flux: 0 }, worldSeed));
});

test('each star population follows its own band, and the mountains pulse with bass', () => {
  const at = (bass: number, mid: number, high: number) => synthwaveLogic.interpret({ energy: 0.5, bass, mid, high, flux: 0 }, worldSeed);
  const base = at(0, 0, 0);
  const bassOnly = at(1, 0, 0), midOnly = at(0, 1, 0), highOnly = at(0, 0, 1);
  assert.ok(bassOnly.starBass > base.starBass && bassOnly.starMid === base.starMid && bassOnly.starHigh === base.starHigh);
  assert.ok(midOnly.starMid > base.starMid && midOnly.starBass === base.starBass && midOnly.starHigh === base.starHigh);
  assert.ok(highOnly.starHigh > base.starHigh && highOnly.starBass === base.starBass && highOnly.starMid === base.starMid);
  assert.ok(bassOnly.mountainPulse > base.mountainPulse);
  assert.equal(base.worldSalt, synthwaveLogic.interpret({ energy: 1, bass: 1, mid: 1, high: 1, flux: 1 }, worldSeed).worldSalt);
});

test('mountain height follows the track energy: quiet passages are lower than loud ones', () => {
  const samples = (energy: number) => {
    const flat = { rate: 100, durationS: 20, tracks: { energy: new Float32Array(2001).fill(energy), bass: new Float32Array(2001), mid: new Float32Array(2001), high: new Float32Array(2001), flux: new Float32Array(2001) } };
    return amplitudeAt(new Timeline(flat), 300, synthwaveLogic.config.speed);
  };
  assert.ok(samples(1) > 2 * samples(0));
});

test('mountain sizes vary widely, start small and grow; the road stays flat', () => {
  const seg = synthwaveLogic.generateSegment(input(2));
  assert.ok(seg.startRatio.every((r) => r > 0 && r <= 1));
  assert.ok(seg.startRatio.some((r) => r < 0.7), 'far mountains start smaller than their final size');
  const peaks = new Set<number>();
  for (let i = 0; i < 120; i++) { // a larger sample, so the check does not depend on one seed's luck
    const s = synthwaveLogic.generateSegment(input(i));
    // Only a central band (+-160): over the whole, much wider segment some giant is always present.
    const cell = (2 * s.halfWidth) / s.cols;
    let peak = 0;
    for (let r = 0; r <= s.rows; r++) {
      for (let c = 0; c <= s.cols; c++) {
        if (Math.abs(-s.halfWidth + c * cell) <= 160) peak = Math.max(peak, s.heights[r * (s.cols + 1) + c]!);
      }
    }
    peaks.add(Math.round(peak));
  }
  const sorted = [...peaks].sort((a, b) => a - b);
  assert.ok(sorted[sorted.length - 1]! > 2 * sorted[0]!, `peak heights should vary widely, got ${sorted.join(',')}`);
});

// A track that is quiet for 30 s, then loud for 30 s, at 100 Hz.
function twoPaceTimeline(): Timeline {
  const n = 6001;
  const fill = (lo: number, hi: number) => Float32Array.from({ length: n }, (_, i) => (i < n / 2 ? lo : hi));
  return new Timeline({ rate: 100, durationS: 60, tracks: { energy: fill(0.1, 0.9), bass: new Float32Array(n), mid: new Float32Array(n), high: new Float32Array(n), flux: fill(0.1, 0.9) } });
}

const kmhAt = (path: { distanceAt(t: number): number }, t: number) => (path.distanceAt(t + 0.1) - path.distanceAt(t)) * 36;

const flat = (n: number) => new Float32Array(n);
/** A timeline at 100 Hz whose energy and flux both follow `level(t)`. */
function levelTimeline(durationS: number, level: (t: number) => number): Timeline {
  const n = durationS * 100 + 1;
  const sig = Float32Array.from({ length: n }, (_, i) => level(i / 100));
  return new Timeline({ rate: 100, durationS, tracks: { energy: sig, bass: flat(n), mid: flat(n), high: flat(n), flux: sig } });
}

test('synthwave path: calm passages climb and go slow, intense passages descend and go fast', () => {
  const path = synthwaveLogic.createPath!(twoPaceTimeline());
  assert.ok(path.slopeAt(15) > 0.1 && path.slopeAt(50) < -0.1, `${path.slopeAt(15)} / ${path.slopeAt(50)}`);
  assert.ok(kmhAt(path, 15) < 120 && kmhAt(path, 50) > 300, `${kmhAt(path, 15)} / ${kmhAt(path, 50)}`);
  assert.ok(path.heightAt(25) > path.heightAt(5), 'climbing during the calm passage');
  assert.ok(path.heightAt(55) < path.heightAt(35), 'descending during the intense passage');
  for (let t = 0; t <= 60; t += 0.5) {
    const kmh = kmhAt(path, Math.min(t, 59.8));
    assert.ok(kmh >= PATH.minKmh - 1e-6 && kmh <= PATH.maxKmh + 1e-6, `t=${t} ${kmh} km/h`);
    assert.ok(Math.abs(path.slopeAt(t)) <= PATH.maxSlope + 1e-9, `t=${t}`);
  }
});

test('synthwave path: reacts within about a second of a change, with no step', () => {
  const path = synthwaveLogic.createPath!(levelTimeline(60, (t) => (t < 30 ? 0.3 : 0.8)));
  // Centered smoothing: the descent is already under way one second after the change (the old model took ~8 s).
  assert.ok(path.slopeAt(31) < -0.1, `slope 1 s after the change: ${path.slopeAt(31)}`);
  assert.ok(kmhAt(path, 32) > 1.5 * kmhAt(path, 28), `${kmhAt(path, 28)} -> ${kmhAt(path, 32)}`);
  for (let t = 0; t < 59.8; t += 0.1) assert.ok(Math.abs(path.slopeAt(t + 0.1) - path.slopeAt(t)) < 0.2, `jump at ${t}`);
});

test('synthwave path: a subtle change bends the road a little, a big change bends it a lot', () => {
  const base = (t: number) => 0.4 + 0.2 * Math.sin(t / 7); // keeps the normalization comparable between both
  const small = synthwaveLogic.createPath!(levelTimeline(120, (t) => base(t) + (t > 60 && t < 70 ? 0.015 : 0)));
  const big = synthwaveLogic.createPath!(levelTimeline(120, (t) => base(t) + (t > 60 && t < 70 ? 0.06 : 0)));
  const none = synthwaveLogic.createPath!(levelTimeline(120, base));
  const ds = Math.abs(small.slopeAt(65) - none.slopeAt(65)), db = Math.abs(big.slopeAt(65) - none.slopeAt(65));
  assert.ok(ds > 0.01, `a subtle change must have an effect: ${ds}`);
  assert.ok(db > 2 * ds, `${ds} vs ${db}`);
});

test('synthwave path: steeper climbs brake more; descents are steeper than climbs (AS2 ratios)', () => {
  const steps = [0.5, 0.4, 0.5, 0.15, 0.5, 0.8, 0.5]; // 20 s each: mild calm, deep calm, intense
  const path = synthwaveLogic.createPath!(levelTimeline(140, (t) => steps[Math.min(6, Math.floor(t / 20))]!));
  const mild = path.slopeAt(30), deep = path.slopeAt(70), drop = path.slopeAt(110);
  assert.ok(mild > 0 && deep > mild, `climbs ${mild} < ${deep}`);
  assert.ok(kmhAt(path, 70) < kmhAt(path, 30), 'the steeper climb is slower');
  assert.ok(-drop > deep * 0.9, `descent ${drop} vs climb ${deep}`);
});

test('synthwave path: timeAt inverts distanceAt, distance is monotonic, and evaluation is pure', () => {
  const path = synthwaveLogic.createPath!(twoPaceTimeline());
  let prev = -Infinity;
  for (const t of [-2, 0, 0.5, 7, 29.9, 30, 45.3, 59.99, 60, 65]) {
    const d = path.distanceAt(t);
    assert.ok(d > prev);
    prev = d;
    assert.ok(Math.abs(path.timeAt(d) - t) < 1e-6, `t=${t}`);
  }
  assert.equal(path.heightAt(33.3), path.heightAt(33.3));
  assert.equal(synthwaveLogic.createPath!(twoPaceTimeline()).heightAt(33.3), path.heightAt(33.3)); // rebuilt from the same timeline
});

test('segments follow the path: roadY matches the camera height, seams stay shared, and constant-speed scenarios are unaffected', () => {
  const tl = twoPaceTimeline();
  const path = synthwaveLogic.createPath!(tl);
  const withPath = (index: number): SegmentInput => ({ ...input(index), timeline: tl, path });
  const a = synthwaveLogic.generateSegment(withPath(4));
  const b = synthwaveLogic.generateSegment(withPath(5));
  assert.equal(a.roadY[a.rows], b.roadY[0]);
  assert.ok(Math.abs(a.roadY[0]! - path.heightAt(path.timeAt(4 * L))) < 1e-4);
  const flat = synthwaveLogic.generateSegment(input(4));
  assert.ok(flat.roadY.every((y) => y === 0));
});

test('segment manager keeps the window, nearest first, and drops stale results', async () => {
  const requested: number[] = [], added: number[] = [], removed: number[] = [];
  const resolvers = new Map<number, () => void>();
  const manager = new SegmentManager<number>({
    length: 10, ahead: 2, behind: 1,
    source: { request: (i) => { requested.push(i); return new Promise((res) => resolvers.set(i, () => res(i))); } },
    onAdd: (i) => added.push(i), onRemove: (i) => removed.push(i), onError: (e) => { throw e; },
  });
  const settled = manager.update(25); // current = 2 -> window [1, 4]
  assert.deepEqual(requested, [2, 3, 4, 1]);
  resolvers.get(2)!(); resolvers.get(3)!(); resolvers.get(4)!(); resolvers.get(1)!();
  await settled;
  assert.deepEqual(added.sort(), [1, 2, 3, 4]);

  const next = manager.update(45); // current = 4 -> window [3, 6]; 1 and 2 leave
  assert.deepEqual(removed.sort(), [1, 2]);
  assert.deepEqual(requested.slice(4), [5, 6]);
  const stale = manager.update(105); // current = 10 -> window [9, 12]; 5 and 6 leave before finishing
  resolvers.get(5)!(); resolvers.get(6)!();
  for (const i of [9, 10, 11, 12]) resolvers.get(i)!();
  await Promise.all([next, stale]);
  assert.ok(!added.includes(5) && !added.includes(6));
});

test('look offset clamps per axis and recenters after idling', () => {
  const look = new LookState();
  look.addInput(100000, -100000, 0);
  assert.equal(look.yaw, YAW_LIMIT_RAD);
  assert.equal(look.pitch, PITCH_UP_LIMIT_RAD);
  look.addInput(-100000, 100000, 0);
  assert.equal(look.yaw, -YAW_LIMIT_RAD);
  assert.equal(look.pitch, -PITCH_DOWN_LIMIT_RAD);

  look.addInput(300, 0, 10);
  const before = look.yaw;
  look.update(0.1, 10.2); // still inside the idle delay
  assert.equal(look.yaw, before);
  for (let t = 11; t < 40; t += 0.1) look.update(0.1, t);
  assert.equal(look.yaw, 0);
  assert.equal(look.pitch, 0);
});

test('timeline: the music ends at the last non-silent frame, before trailing silence', () => {
  const tl = levelTimeline(40, (t) => (t < 30 ? 0.5 : 0));
  assert.ok(Math.abs(tl.musicEndS - 30) < 0.02, `${tl.musicEndS}`);
  assert.equal(levelTimeline(10, () => 0).musicEndS, 10); // silent throughout: the whole track counts
});

test('synthwave path: a calm or fading ending flattens the road; an intense ending keeps following the music', () => {
  const wave = (t: number) => 0.5 + 0.3 * Math.sin(t / 3); // hilly road all along
  const calm = synthwaveLogic.createPath!(levelTimeline(90, (t) => (t < 80 ? wave(t) : 0.15)));
  const fade = synthwaveLogic.createPath!(levelTimeline(90, (t) => (t < 80 ? wave(t) : 0.8 * (1 - (t - 80) / 10) + 0.05)));
  const loud = synthwaveLogic.createPath!(levelTimeline(90, (t) => (t < 80 ? wave(t) : 0.9 + 0.1 * Math.sin(t * 2))));
  for (let t = 82; t < 89.5; t += 0.25) {
    assert.ok(Math.abs(calm.slopeAt(t)) < 0.05, `calm t=${t} slope ${calm.slopeAt(t)}`);
    assert.ok(Math.abs(fade.slopeAt(t)) < 0.05, `fade t=${t} slope ${fade.slopeAt(t)}`);
  }
  assert.ok(Math.abs(loud.slopeAt(86)) > 0.1, `intense ending still descends: ${loud.slopeAt(86)}`);
  for (let t = 70; t < 95; t += 0.1) assert.ok(Math.abs(calm.slopeAt(t + 0.1) - calm.slopeAt(t)) < 0.2, `jump at ${t}`);
});

test('synthwave path: after the music ends the road is flat and the camera slows to the end speed', () => {
  const path = synthwaveLogic.createPath!(levelTimeline(60, (t) => (t < 50 ? 0.5 + 0.4 * Math.sin(t) : 0)));
  for (const t of [54, 56, 58, 62, 65]) {
    assert.ok(Math.abs(path.slopeAt(t)) < 1e-3, `t=${t} slope ${path.slopeAt(t)}`);
    assert.ok(Math.abs(kmhAt(path, t) - PATH.endKmh) < 0.5, `t=${t} ${kmhAt(path, t)} km/h`);
  }
  // An abrupt end (no trailing silence) still reaches the end speed in the epilogue, past the audio.
  const abrupt = synthwaveLogic.createPath!(levelTimeline(60, () => 0.8));
  assert.ok(Math.abs(kmhAt(abrupt, 63.5) - PATH.endKmh) < 0.5, `${kmhAt(abrupt, 63.5)} km/h`);
  assert.ok(Math.abs(abrupt.timeAt(abrupt.distanceAt(64)) - 64) < 1e-6);
});
