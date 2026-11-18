import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGE_RANGES, stageProgress, toPercent } from '../src/home/progress.ts';

const ORDER = ['queued', 'fetching_metadata', 'downloading', 'transferring', 'decoding', 'analyzing', 'building'];

test('stage ranges are contiguous, ordered and cover 0..1', () => {
  assert.equal(STAGE_RANGES[ORDER[0]!]!.from, 0);
  assert.equal(STAGE_RANGES[ORDER.at(-1)!]!.to, 1);
  for (let i = 1; i < ORDER.length; i++) assert.equal(STAGE_RANGES[ORDER[i]!]!.from, STAGE_RANGES[ORDER[i - 1]!]!.to);
});

test('a real fraction maps linearly into the stage range', () => {
  const r = STAGE_RANGES.analyzing!;
  assert.equal(stageProgress('analyzing', 0, 0), r.from);
  assert.equal(stageProgress('analyzing', 0, 1), r.to);
  assert.ok(Math.abs(stageProgress('analyzing', 0, 0.5)! - (r.from + r.to) / 2) < 1e-12);
});

test('a fraction outside 0..1 is clamped', () => {
  const r = STAGE_RANGES.analyzing!;
  assert.equal(stageProgress('analyzing', 0, -3), r.from);
  assert.equal(stageProgress('analyzing', 0, 7), r.to);
});

test('without a fraction the value creeps up but never reaches the end of the stage', () => {
  for (const stage of ORDER) {
    const r = STAGE_RANGES[stage]!;
    let prev = stageProgress(stage, 0)!;
    assert.equal(prev, r.from);
    for (const ms of [500, 2000, 8000, 30_000, 600_000]) {
      const v = stageProgress(stage, ms)!;
      assert.ok(v >= prev, `${stage} non-decreasing`);
      assert.ok(v < r.to, `${stage} stays below the end of its range`);
      prev = v;
    }
  }
});

test('an unknown stage has no progress', () => {
  assert.equal(stageProgress('nope', 100), null);
});

test('toPercent rounds and clamps', () => {
  assert.equal(toPercent(0), 0);
  assert.equal(toPercent(0.456), 46);
  assert.equal(toPercent(1), 100);
  assert.equal(toPercent(1.4), 100);
  assert.equal(toPercent(-1), 0);
});
