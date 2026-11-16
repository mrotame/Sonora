import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { config } from '../server/config.ts';
import { SourceError } from '../server/ytdlp.ts';
import { downloadViaYtMp3M4a, YT_MP3_M4A_HOST } from '../server/ytMp3M4a.ts';

fs.mkdirSync(config.tempDir, { recursive: true });
const live = () => new AbortController().signal;
const LINK = 'https://cdn.example/download?video_id=abc&ext=m4a&token=t';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const respond = (body: unknown, status = 200) => (async () => json(body, status)) as unknown as typeof fetch;
const fail = (e: unknown) => e instanceof SourceError ? e.code : 'other';

test('calls GET /audio with the id, then downloads linkDownload without the RapidAPI key', async () => {
  const audio = Buffer.from('fake m4a bytes');
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith(`https://${YT_MP3_M4A_HOST}/audio`)) return json({ error: false, lengthSeconds: '19', isLiveContent: false, linkDownload: LINK });
    if (url === LINK) return new Response(audio, { headers: { 'content-type': 'audio/mp4' } });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  let downloading = false;
  const file = await downloadViaYtMp3M4a('jNQXAC9IVRw', 'mm-ok', live(), () => (downloading = true), fetchImpl);
  try {
    assert.deepEqual(fs.readFileSync(file), audio);
    assert.ok(downloading);
    assert.equal(calls[0]!.url, `https://${YT_MP3_M4A_HOST}/audio?id=jNQXAC9IVRw`);
    assert.equal((calls[0]!.init!.headers as Record<string, string>)['x-rapidapi-host'], YT_MP3_M4A_HOST);
    assert.equal(calls[1]!.init!.headers, undefined);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('provider failures are fallback-able; live and long videos stop the chain', async () => {
  const run = (f: typeof fetch) => downloadViaYtMp3M4a('jNQXAC9IVRw', 'mm-x', live(), () => {}, f);
  await assert.rejects(run(respond({ message: 'quota' }, 429)), (e) => fail(e) === 'QUOTA_EXCEEDED');
  // Error in the body with HTTP 200 (observed: "Not found data").
  await assert.rejects(run(respond({ error: true, status: 404, message: 'Not found data' })), (e) => fail(e) === 'DOWNLOAD_FAILED');
  await assert.rejects(run(respond({ error: false })), (e) => fail(e) === 'DOWNLOAD_FAILED'); // no link
  await assert.rejects(run(respond({ error: false, isLiveContent: true, linkDownload: LINK })), (e) => fail(e) === 'LIVE');
  await assert.rejects(run(respond({ error: false, lengthSeconds: String(config.maxDurationS + 1), linkDownload: LINK })), (e) => fail(e) === 'TOO_LONG');
});

test('a JSON body instead of audio from the download link is a failure', async () => {
  const fetchImpl = (async (url: string) =>
    url === LINK ? json({ error: true }) : json({ error: false, lengthSeconds: 19, linkDownload: LINK })) as unknown as typeof fetch;
  await assert.rejects(downloadViaYtMp3M4a('jNQXAC9IVRw', 'mm-j', live(), () => {}, fetchImpl), (e) => fail(e) === 'DOWNLOAD_FAILED');
});
