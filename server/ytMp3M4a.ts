// Source adapter: RapidAPI "YouTube MP3 M4A Converter", host youtube-mp3-m4a-converter.p.rapidapi.com.
// `GET /audio?id=<videoId>` returns JSON with the video metadata (`lengthSeconds`, `isLiveContent`)
// and `linkDownload`, a plain URL (token inside, no RapidAPI key needed) that serves the m4a.
// Observed 2026-11-16: audio/mp4, AAC 128 kbps, duration matching the video. The provider's own
// documentation lists `/download` and `/stream`, but those did not work (404 / "Not found data");
// `/audio` is the endpoint that does, so it may change without notice.
// Errors come as `{error: true, status, message}`, sometimes with HTTP 200.
import { config } from './config.ts';
import { classifyStatus } from './rapidapi.ts';
import { type AudioSource, saveResponse } from './sources.ts';
import { SourceError } from './ytdlp.ts';

type Fetch = typeof fetch;

export const YT_MP3_M4A_HOST = 'youtube-mp3-m4a-converter.p.rapidapi.com';

interface AudioResponse {
  error?: boolean | string;
  status?: number;
  lengthSeconds?: number | string;
  isLiveContent?: boolean;
  isPrivate?: boolean;
  linkDownload?: string;
}

function debug(label: string, text: string): void {
  if (config.debug) console.error(`[yt-mp3-m4a:${label}] ${text.slice(0, 300)}`);
}

export async function downloadViaYtMp3M4a(videoId: string, jobId: string, signal: AbortSignal, onDownloading: () => void, fetchImpl: Fetch = fetch): Promise<string> {
  async function get(target: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchImpl(target, { ...init, signal });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new SourceError('DOWNLOAD_FAILED');
    }
  }

  const res = await get(`https://${YT_MP3_M4A_HOST}/audio?id=${encodeURIComponent(videoId)}`, {
    headers: { 'x-rapidapi-key': config.rapidApiKey, 'x-rapidapi-host': YT_MP3_M4A_HOST },
  });
  if (!res.ok) {
    debug(`http ${res.status}`, await res.text().catch(() => ''));
    throw new SourceError(classifyStatus(res.status));
  }
  let info: AudioResponse;
  try {
    info = (await res.json()) as AudioResponse;
  } catch {
    throw new SourceError('DOWNLOAD_FAILED');
  }
  // The provider reports its own failures in the body. The cause is unknown (it is not a verdict
  // on the video), so let the next source try.
  if ((info.error !== false && info.error !== undefined && info.error !== 'false') || typeof info.linkDownload !== 'string') {
    debug('body', JSON.stringify(info));
    throw new SourceError('DOWNLOAD_FAILED');
  }
  if (info.isLiveContent) throw new SourceError('LIVE');
  const duration = Number(info.lengthSeconds);
  if (Number.isFinite(duration) && duration > config.maxDurationS) throw new SourceError('TOO_LONG');

  onDownloading();
  const file = await get(info.linkDownload, { redirect: 'follow' });
  if (!file.ok) {
    debug(`media http ${file.status}`, '');
    throw new SourceError('DOWNLOAD_FAILED');
  }
  // A failure can also come back as JSON/HTML instead of audio.
  if (/json|html|text/i.test(file.headers.get('content-type') ?? '')) {
    debug('media content-type', file.headers.get('content-type') ?? '');
    throw new SourceError('DOWNLOAD_FAILED');
  }
  return saveResponse(file, jobId, signal);
}

export const ytMp3M4a: AudioSource = {
  name: 'yt-mp3-m4a-converter',
  download: (videoId, jobId, signal, ctx) => downloadViaYtMp3M4a(videoId, jobId, signal, ctx.onDownloading),
};
