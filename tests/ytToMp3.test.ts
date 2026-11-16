import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { config } from '../server/config.ts';
import { SourceError } from '../server/ytdlp.ts';
import { downloadViaYtToMp3, pickAudio, YT_TO_MP3_HOST } from '../server/ytToMp3.ts';

fs.mkdirSync(config.tempDir, { recursive: true });
const live = () => new AbortController().signal;

/** A relay URL shaped like the real one (2026-11-16): relay ?url= proxy ?id= base64(YouTube URL). */
function relay(itag: number, mime: string): string {
  const yt = `https://rr1---sn-x.googlevideo.com/videoplayback?expire=1&itag=${itag}&mime=${encodeURIComponent(mime)}&clen=10`;
  const proxy = `https://proxy.example/api/proxy-media?engine=youtube&id=${encodeURIComponent(Buffer.from(yt).toString('base64'))}`;
  return `https://relay.example/?url=${encodeURIComponent(proxy)}`;
}

/** Same structure as the observed response for "Me at the zoo". */
const RESPONSE = {
  title: 'Me at the zoo',
  medias: [
    { type: 'video', quality: '240p', duration: 19, download_url: relay(133, 'video/mp4') },
    { type: 'audio', quality: '107kbps', duration: 19, download_url: relay(251, 'audio/webm') },
    { type: 'audio', quality: '130kbps', duration: 19, download_url: relay(140, 'audio/mp4') },
  ],
};

test('picks the m4a/AAC audio entry (YouTube format 140)', () => {
  assert.equal(pickAudio(RESPONSE.medias), RESPONSE.medias[2]);
  // Without recognizable format markers it falls back to the highest bitrate audio.
  const plain = [{ type: 'audio', quality: '64kbps', download_url: 'https://a' }, { type: 'audio', quality: '128kbps', download_url: 'https://b' }];
  assert.equal(pickAudio(plain)?.download_url, 'https://b');
  assert.equal(pickAudio([{ type: 'video', download_url: 'https://v' }]), undefined);
});

test('calls POST /output.php with the url, then downloads the picked relay', async () => {
  const audio = Buffer.from('fake m4a bytes');
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith(`https://${YT_TO_MP3_HOST}/output.php`)) return new Response(JSON.stringify(RESPONSE), { headers: { 'content-type': 'application/json' } });
    if (url === RESPONSE.medias[2]!.download_url) return new Response(audio, { status: 206 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  let downloading = false;
  const file = await downloadViaYtToMp3('jNQXAC9IVRw', 'yt-ok', live(), () => (downloading = true), fetchImpl);
  try {
    assert.deepEqual(fs.readFileSync(file), audio);
    assert.ok(downloading);
    const first = calls[0]!;
    assert.equal(first.init!.method, 'POST');
    assert.equal((first.init!.body as FormData).get('url'), 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
    assert.equal((first.init!.headers as Record<string, string>)['x-rapidapi-host'], YT_TO_MP3_HOST);
    // The relay must not receive the RapidAPI key.
    assert.equal(calls[1]!.init!.headers, undefined);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('quota and missing audio become fallback-able errors; long videos stop', async () => {
  const respond = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  await assert.rejects(downloadViaYtToMp3('jNQXAC9IVRw', 'yt-q', live(), () => {}, respond({ message: 'quota' }, 429)),
    (e: unknown) => e instanceof SourceError && e.code === 'QUOTA_EXCEEDED');
  await assert.rejects(downloadViaYtToMp3('jNQXAC9IVRw', 'yt-n', live(), () => {}, respond({ medias: [] })),
    (e: unknown) => e instanceof SourceError && e.code === 'DOWNLOAD_FAILED');
  const long = { medias: [{ type: 'audio', quality: '130kbps', duration: config.maxDurationS + 1, download_url: 'https://a' }] };
  await assert.rejects(downloadViaYtToMp3('jNQXAC9IVRw', 'yt-l', live(), () => {}, respond(long)),
    (e: unknown) => e instanceof SourceError && e.code === 'TOO_LONG');
});
