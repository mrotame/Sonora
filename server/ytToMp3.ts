// Source adapter: RapidAPI "YouTube to MP3 Converter API" (GatiMan), host
// youtube-to-mp3-converter-api.p.rapidapi.com. Despite the name it does not convert:
// `POST /output.php` (multipart `url`, also in the query string as the listing shows) returns JSON
// `{title, thumbnail, medias[]}`, where each media has `type` (video/audio), `quality` (e.g. "130kbps")
// and `download_url`, a third-party proxy that relays YouTube's own stream. Observed 2026-11-16:
// the 130 kbps audio entry is YouTube format 140 (m4a/AAC, DASH container), the same stream
// yt-dlp downloads, and it decodes in Edge.
// Free plan: 4 requests per month, so it only makes sense as the first choice of a fallback chain.
import { canonicalUrl } from '../shared/youtubeUrl.ts';
import { config } from './config.ts';
import { classifyStatus } from './rapidapi.ts';
import { type AudioSource, saveResponse } from './sources.ts';
import { SourceError } from './ytdlp.ts';

type Fetch = typeof fetch;

export const YT_TO_MP3_HOST = 'youtube-to-mp3-converter-api.p.rapidapi.com';

interface Media {
  type?: string;
  quality?: string | null;
  duration?: number | null;
  download_url?: string;
}

function debug(label: string, text: string): void {
  if (config.debug) console.error(`[yt-to-mp3:${label}] ${text.slice(0, 300)}`);
}

/** The m4a/AAC entry when recognizable (YouTube's format 140 is about 130 kbps), else the best audio entry. */
export function pickAudio(medias: readonly Media[]): Media | undefined {
  const audio = medias.filter((m) => m.type === 'audio' && typeof m.download_url === 'string');
  const kbps = (m: Media) => Number(/(\d+)\s*kbps/i.exec(m.quality ?? '')?.[1] ?? 0);
  const m4a = audio.find((m) => /mime(%3D|=)audio(%2F|\/)mp4|itag(%3D|=)140\b/i.test(decodeDeep(m.download_url!)));
  return m4a ?? [...audio].sort((a, b) => kbps(b) - kbps(a))[0];
}

/** The download URL nests the YouTube URL (percent-encoded, then base64). Best effort, for format detection only. */
function decodeDeep(url: string): string {
  let text = url;
  try {
    text = decodeURIComponent(decodeURIComponent(url));
    const id = /[?&]id=([A-Za-z0-9+/=_-]+)/.exec(text)?.[1];
    if (id) text += ' ' + Buffer.from(id, 'base64').toString('latin1');
  } catch {
    // keep what was decoded
  }
  return text;
}

export async function downloadViaYtToMp3(videoId: string, jobId: string, signal: AbortSignal, onDownloading: () => void, fetchImpl: Fetch = fetch): Promise<string> {
  const url = canonicalUrl(videoId);
  const body = new FormData();
  body.set('url', url);

  async function get(target: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(target, { ...init, signal });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new SourceError('DOWNLOAD_FAILED');
    }
  }

  const res = await get(`https://${YT_TO_MP3_HOST}/output.php?url=${encodeURIComponent(url)}`, {
    method: 'POST',
    headers: { 'x-rapidapi-key': config.rapidApiKey, 'x-rapidapi-host': YT_TO_MP3_HOST },
    body,
  });
  if (!res.ok) {
    debug(`http ${res.status}`, await res.text().catch(() => ''));
    throw new SourceError(classifyStatus(res.status));
  }
  let medias: Media[];
  try {
    const json = (await res.json()) as { medias?: unknown };
    medias = Array.isArray(json.medias) ? (json.medias as Media[]) : [];
  } catch {
    throw new SourceError('DOWNLOAD_FAILED');
  }
  const audio = pickAudio(medias);
  if (!audio) {
    debug('no audio', JSON.stringify(medias.map((m) => [m.type, m.quality])));
    throw new SourceError('DOWNLOAD_FAILED'); // unknown cause: let the next source try
  }
  if (typeof audio.duration === 'number' && audio.duration > config.maxDurationS) throw new SourceError('TOO_LONG');

  onDownloading();
  // The relay is a plain URL (no RapidAPI key), served with HTTP 206 for the whole file.
  const file = await get(audio.download_url!, { redirect: 'follow' });
  if (!file.ok) {
    debug(`media http ${file.status}`, '');
    throw new SourceError('DOWNLOAD_FAILED');
  }
  return saveResponse(file, jobId, signal);
}

export const ytToMp3: AudioSource = {
  name: 'yt-to-mp3-converter',
  download: (videoId, jobId, signal, ctx) => downloadViaYtToMp3(videoId, jobId, signal, ctx.onDownloading),
};
