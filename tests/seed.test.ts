import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, createWorldSeed, deriveSeed, rand, rand2 } from '../src/world/identity/seed.ts';

const id = { audioIdentity: 'a'.repeat(64), scenarioId: 'synthwave', scenarioVersion: 1 };

test('same inputs give the same world seed', () => {
  assert.deepEqual(createWorldSeed(id), createWorldSeed({ ...id }));
});

test('each identity input changes the seed', () => {
  const base = createWorldSeed(id);
  assert.notDeepEqual(base, createWorldSeed({ ...id, audioIdentity: 'b'.repeat(64) }));
  assert.notDeepEqual(base, createWorldSeed({ ...id, scenarioId: 'other' }));
  assert.notDeepEqual(base, createWorldSeed({ ...id, scenarioVersion: 2 }));
  assert.notDeepEqual(base, createWorldSeed(id, 2));
});

test('sub-seeds are stable, path-dependent and independent of call order', () => {
  const w = createWorldSeed(id);
  const a1 = deriveSeed(w, 'segment', 3, 'terrain');
  deriveSeed(w, 'something', 'else');
  const a2 = deriveSeed(w, 'segment', 3, 'terrain');
  assert.deepEqual(a1, a2);
  assert.notDeepEqual(a1, deriveSeed(w, 'segment', 4, 'terrain'));
  assert.notDeepEqual(a1, deriveSeed(w, 'segment', 3, 'props'));
  assert.notDeepEqual(deriveSeed(w, 'a', 1), deriveSeed(w, 'a1'));
});

test('rng sequences are reproducible and in [0,1)', () => {
  const s = deriveSeed(createWorldSeed(id), 'x');
  const r1 = createRng(s), r2 = createRng(s);
  for (let i = 0; i < 1000; i++) {
    const v = r1();
    assert.equal(v, r2());
    assert.ok(v >= 0 && v < 1);
  }
});

test('rand is stateless, uniform enough and deterministic', () => {
  const s = deriveSeed(createWorldSeed(id), 'y');
  assert.equal(rand(s, 123456), rand(s, 123456));
  let sum = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const v = rand(s, i);
    assert.ok(v >= 0 && v < 1);
    sum += v;
  }
  assert.ok(Math.abs(sum / n - 0.5) < 0.01);
  assert.equal(rand2(s, -5, 9), rand2(s, -5, 9));
  assert.notEqual(rand2(s, 1, 2), rand2(s, 2, 1));
});
