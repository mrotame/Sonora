import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { config } from '../server/config.ts';
import { classifyStatus, downloadViaRapidApi } from '../server/rapidapi.ts';
import { SourceError } from '../server/ytdlp.ts';

fs.mkdirSync(config.tempDir, { recursive: true });
const live = () => new AbortController().signal;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake provider: answers by path, records every call. */
function fakeProvider(routes: Record<string, () => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => new URL(url).pathname + new URL(url).search === k || new URL(url).pathname === k);
    if (!key) throw new Error(`unexpected ${url}`);
    return routes[key]!();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('creates, polls and downloads the file', async () => {
  const audio = Buffer.from('fake m4a bytes');
  let polls = 0;
  const { calls, fetchImpl } = fakeProvider({
    '/api/v2/jobs': () => json({ jobId: 'j1', status: 'pending' }, 202),
    '/api/v2/jobs/j1': () => json(++polls < 2 ? { jobId: 'j1', status: 'converting' } : { jobId: 'j1', status: 'done', mediaDurationSeconds: 200, fileSize: audio.length }),
    '/api/v2/jobs/j1/download': () => new Response(audio),
  });
  let downloading = false;
  const file = await downloadViaRapidApi('dQw4w9WgXcQ', 'test-ok', live(), { fetchImpl, idempotencyKey: 'k1', onDownloading: () => (downloading = true) });
  try {
    assert.deepEqual(fs.readFileSync(file), audio);
    assert.ok(downloading);
    const create = calls[0]!;
    assert.equal((create.init!.headers as Record<string, string>)['idempotency-key'], 'k1');
    assert.ok((create.init!.headers as Record<string, string>)['x-rapidapi-key'] !== undefined);
    assert.deepEqual(JSON.parse(create.init!.body as string), { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', format: 'm4a', quality: '128' });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('maps provider HTTP errors', () => {
  assert.equal(classifyStatus(413), 'TOO_LONG');
  assert.equal(classifyStatus(422), 'UNAVAILABLE');
  assert.equal(classifyStatus(429), 'QUOTA_EXCEEDED');
  assert.equal(classifyStatus(503), 'DOWNLOAD_FAILED');
});

test('a failed provider job becomes a Sonora error', async () => {
  const { fetchImpl } = fakeProvider({
    '/api/v2/jobs': () => json({ jobId: 'j2', status: 'error', error: { code: 'MEDIA_UNAVAILABLE', message: 'Video is private' } }, 202),
  });
  await assert.rejects(downloadViaRapidApi('dQw4w9WgXcQ', 'test-err', live(), { fetchImpl, idempotencyKey: 'k2' }),
    (e: unknown) => e instanceof SourceError && e.code === 'UNAVAILABLE');
});

test('a temporary provider failure stays generic, so it is retried', async () => {
  const { fetchImpl } = fakeProvider({
    '/api/v2/jobs': () => json({ jobId: 'j5', status: 'error', error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: 'Conversion service is temporarily unavailable. Retry later.' } }, 202),
  });
  await assert.rejects(downloadViaRapidApi('dQw4w9WgXcQ', 'test-tmp', live(), { fetchImpl, idempotencyKey: 'k5' }),
    (e: unknown) => e instanceof SourceError && e.code === 'DOWNLOAD_FAILED');
});

test('rejects a video above the duration limit before transferring it', async () => {
  const { calls, fetchImpl } = fakeProvider({
    '/api/v2/jobs': () => json({ jobId: 'j3', status: 'done', mediaDurationSeconds: config.maxDurationS + 1 }, 202),
  });
  await assert.rejects(downloadViaRapidApi('dQw4w9WgXcQ', 'test-long', live(), { fetchImpl, idempotencyKey: 'k3' }),
    (e: unknown) => e instanceof SourceError && e.code === 'TOO_LONG');
  assert.equal(calls.length, 1);
});

test('stops a transfer above the size limit and removes the partial file', async () => {
  const { fetchImpl } = fakeProvider({
    '/api/v2/jobs': () => json({ jobId: 'j4', status: 'done' }, 202),
    '/api/v2/jobs/j4/download': () => new Response(Buffer.alloc(config.maxFileBytes + 1)),
  });
  await assert.rejects(downloadViaRapidApi('dQw4w9WgXcQ', 'test-big', live(), { fetchImpl, idempotencyKey: 'k4' }),
    (e: unknown) => e instanceof SourceError && e.code === 'TOO_LARGE');
  assert.ok(!fs.existsSync(`${config.tempDir}/test-big.m4a`));
});
