import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ErrorCode } from '../shared/contract.ts';
import { type AudioSource, downloadWithFallback } from '../server/sources.ts';
import { SourceError } from '../server/ytdlp.ts';

const ctx = { onDownloading: () => {} };
const live = () => new AbortController().signal;

function source(name: string, outcome: string | ErrorCode, calls: string[]): AudioSource {
  return {
    name,
    async download() {
      calls.push(name);
      if (outcome.startsWith('/')) return outcome;
      throw new SourceError(outcome as ErrorCode);
    },
  };
}

test('uses the first source that works, in priority order', async () => {
  const calls: string[] = [];
  const file = await downloadWithFallback([source('a', '/a.m4a', calls), source('b', '/b.m4a', calls)], 'v', 'j', live(), ctx);
  assert.equal(file, '/a.m4a');
  assert.deepEqual(calls, ['a']);
});

test('falls back on provider failures (down, quota, blocked)', async () => {
  for (const code of ['DOWNLOAD_FAILED', 'QUOTA_EXCEEDED', 'BLOCKED'] as const) {
    const calls: string[] = [];
    const fallbacks: string[] = [];
    const file = await downloadWithFallback([source('a', code, calls), source('b', '/b.m4a', calls)], 'v', 'j', live(), ctx, (n) => fallbacks.push(n));
    assert.equal(file, '/b.m4a', code);
    assert.deepEqual(calls, ['a', 'b']);
    assert.deepEqual(fallbacks, ['a']);
  }
});

test('stops on outcomes about the video itself', async () => {
  for (const code of ['UNAVAILABLE', 'LIVE', 'TOO_LONG', 'TOO_LARGE'] as const) {
    const calls: string[] = [];
    await assert.rejects(downloadWithFallback([source('a', code, calls), source('b', '/b.m4a', calls)], 'v', 'j', live(), ctx),
      (e: unknown) => e instanceof SourceError && e.code === code);
    assert.deepEqual(calls, ['a'], code);
  }
});

test('reports the last failure when every source fails', async () => {
  const calls: string[] = [];
  await assert.rejects(downloadWithFallback([source('a', 'DOWNLOAD_FAILED', calls), source('b', 'QUOTA_EXCEEDED', calls)], 'v', 'j', live(), ctx),
    (e: unknown) => e instanceof SourceError && e.code === 'QUOTA_EXCEEDED');
});

test('does not fall back after the job timeout', async () => {
  const abort = new AbortController();
  const calls: string[] = [];
  const first: AudioSource = { name: 'a', async download() { calls.push('a'); abort.abort(); throw new Error('aborted'); } };
  await assert.rejects(downloadWithFallback([first, source('b', '/b.m4a', calls)], 'v', 'j', abort.signal, ctx));
  assert.deepEqual(calls, ['a']);
});
