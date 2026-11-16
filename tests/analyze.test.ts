import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../src/audio/analysis/analyze.ts';
import { FFT } from '../src/audio/analysis/fft.ts';
import { Timeline } from '../src/audio/intelligence/timeline.ts';

const SR = 44100;

function tone(freq: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

test('FFT puts a pure tone in the expected bin', () => {
  const n = 1024, fft = new FFT(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 64 * i) / n);
  fft.transform(re, im);
  let best = 1;
  for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k]!, im[k]!) > Math.hypot(re[best]!, im[best]!)) best = k;
  assert.equal(best, 64);
});

test('bands separate a bass tone, silence and a treble tone', () => {
  const bass = tone(80, 2), silence = new Float32Array(SR), high = tone(5000, 2);
  const left = new Float32Array(bass.length + silence.length + high.length);
  left.set(bass, 0);
  left.set(silence, bass.length);
  left.set(high, bass.length + silence.length);
  const tl = new Timeline(analyzeTrack(left, left, SR));
  assert.equal(tl.durationS, 5);

  const inBass = tl.evaluate(1), inSilence = tl.evaluate(2.5), inHigh = tl.evaluate(4);
  assert.ok(inBass.bass > 0.8 && inBass.high < 0.05, JSON.stringify(inBass));
  assert.ok(inHigh.high > 0.8 && inHigh.bass < 0.05, JSON.stringify(inHigh));
  assert.ok(inSilence.energy < 0.01 && inSilence.bass < 0.01 && inSilence.high < 0.01, JSON.stringify(inSilence));
});

test('flux spikes at an onset and is quiet in a steady tone', () => {
  const left = new Float32Array(3 * SR);
  left.set(tone(440, 2), SR); // silence for 1 s, then a tone starts
  const tl = new Timeline(analyzeTrack(left, left, SR));
  assert.ok(tl.evaluate(1.0).flux > 0.5, String(tl.evaluate(1.0).flux));
  assert.ok(tl.evaluate(2.0).flux < 0.1, String(tl.evaluate(2.0).flux));
});

test('analysis and evaluation are deterministic and clamp outside the track', () => {
  const left = tone(220, 1);
  const a = analyzeTrack(left, left, SR), b = analyzeTrack(left, left, SR);
  assert.deepEqual(a.tracks.bass, b.tracks.bass);
  const tl = new Timeline(a);
  assert.deepEqual(tl.evaluate(0.37), tl.evaluate(0.37));
  assert.deepEqual(tl.evaluate(-5), tl.evaluate(0));
  assert.deepEqual(tl.evaluate(999), tl.evaluate(a.durationS + 0.5));
});

test('a fully silent track stays at zero', () => {
  const z = new Float32Array(SR);
  const tl = new Timeline(analyzeTrack(z, z, SR));
  assert.equal(tl.evaluate(0.5).energy, 0);
  assert.equal(tl.evaluate(0.5).flux, 0);
});
