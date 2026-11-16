import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../server/retry.ts';
import { SourceError } from '../server/ytdlp.ts';

const policy = { retries: 2, delayMs: 1 };
const live = () => new AbortController().signal;

test('recovers from a single transient failure', async () => {
  let calls = 0;
  const retries: number[] = [];
  const result = await withRetry(async () => {
    if (++calls === 1) throw new SourceError('DOWNLOAD_FAILED');
    return 'ok';
  }, policy, live(), (n) => retries.push(n));
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(retries, [1]);
});

test('gives up after the configured number of retries', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new SourceError('DOWNLOAD_FAILED'); }, policy, live()),
    (e: unknown) => e instanceof SourceError && e.code === 'DOWNLOAD_FAILED',
  );
  assert.equal(calls, 3); // 1 attempt + 2 retries
});

test('never retries definitive outcomes', async () => {
  for (const code of ['UNAVAILABLE', 'LIVE', 'TOO_LONG', 'TOO_LARGE', 'BLOCKED'] as const) {
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw new SourceError(code); }, policy, live()));
    assert.equal(calls, 1, code);
  }
});

test('does not retry after an abort (timeout)', async () => {
  const abort = new AbortController();
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; abort.abort(); throw new SourceError('DOWNLOAD_FAILED'); }, policy, abort.signal));
  assert.equal(calls, 1);
});
