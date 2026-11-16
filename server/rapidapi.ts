// Source adapter: third-party conversion API on RapidAPI ("YouTube Audio Downloader & Converter").
// Used instead of yt-dlp when RAPIDAPI_KEY is set, because YouTube blocks datacenter IPs
// (Cloud Run) with its bot check. The provider downloads from YouTube and hosts the result;
// this module creates a job, long-polls it, and streams the finished file to the temp dir.
import { randomUUID } from 'node:crypto';
import type { ErrorCode } from '../shared/contract.ts';
import { canonicalUrl } from '../shared/youtubeUrl.ts';
import { config } from './config.ts';
import { type AudioSource, saveResponse } from './sources.ts';
import { SourceError } from './ytdlp.ts';

type Fetch = typeof fetch;

interface ProviderJob {
  jobId: string;
  status: 'pending' | 'downloading' | 'converting' | 'done' | 'error' | 'cancelled';
  mediaDurationSeconds?: number;
  fileSize?: number;
  error?: { code?: string; message?: string };
}

/** Fixed request: same format and bitrate for every video, so a video always yields the same kind of file. */
const REQUEST = { format: 'm4a', quality: '128' } as const;
const MAX_POLLS = 8; // each long poll waits up to 25 s; the job timeout ends it earlier

function debug(label: string, text: string): void {
  if (config.debug) console.error(`[rapidapi:${label}] ${text.slice(0, 300)}`);
}

/** Provider HTTP status -> Sonora error code. */
export function classifyStatus(status: number): ErrorCode {
  if (status === 413) return 'TOO_LONG';
  if (status === 422) return 'UNAVAILABLE';
  if (status === 429) return 'QUOTA_EXCEEDED'; // plan quota (hard limit) or provider queue limit
  return 'DOWNLOAD_FAILED'; // 400, 403 (bad key), 409, 5xx: generic (5xx may be transient and is retried)
}

/** Provider job error code -> Sonora error code. The provider's codes are not documented, so this is a best guess. */
function classifyJobError(job: ProviderJob): ErrorCode {
  const text = `${job.error?.code ?? ''} ${job.error?.message ?? ''}`;
  // Observed: {code: 'SERVICE_TEMPORARILY_UNAVAILABLE'}. Must stay generic (retried), not 'UNAVAILABLE'.
  if (/temporar|retry/i.test(text)) return 'DOWNLOAD_FAILED';
  if (/live/i.test(text)) return 'LIVE';
  if (/long|duration/i.test(text)) return 'TOO_LONG';
  if (/private|unavailable|removed|restricted|no audio|not found/i.test(text)) return 'UNAVAILABLE';
  return 'DOWNLOAD_FAILED';
}

export interface RapidApiOptions {
  fetchImpl?: Fetch;
  /** Called when the provider starts working on the job (maps to the 'downloading' status). */
  onDownloading?: () => void;
  /** Makes provider retries of the same attempt idempotent. */
  idempotencyKey: string;
}

/** Downloads the audio of a video through the provider. Returns the file path. */
export async function downloadViaRapidApi(videoId: string, jobId: string, signal: AbortSignal, opts: RapidApiOptions): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = `https://${config.rapidApiHost}`;
  const headers = { 'x-rapidapi-key': config.rapidApiKey, 'x-rapidapi-host': config.rapidApiHost };

  async function call(pathname: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(base + pathname, { ...init, headers: { ...headers, ...init.headers }, signal });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new SourceError('DOWNLOAD_FAILED'); // network failure: possibly transient
    }
    if (!res.ok && res.status !== 202) {
      debug(`http ${res.status}`, await res.text().catch(() => ''));
      throw new SourceError(classifyStatus(res.status));
    }
    return res;
  }

  // 1. Create the job.
  let job = (await (await call('/api/v2/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': opts.idempotencyKey },
    body: JSON.stringify({ url: canonicalUrl(videoId), ...REQUEST }),
  })).json()) as ProviderJob;

  // 2. Long-poll until terminal.
  for (let n = 0; job.status !== 'done'; n++) {
    if (job.status === 'error' || job.status === 'cancelled') {
      debug('job', JSON.stringify(job.error ?? {}));
      throw new SourceError(classifyJobError(job));
    }
    if (job.status === 'downloading' || job.status === 'converting') opts.onDownloading?.();
    if (n >= MAX_POLLS) throw new SourceError('DOWNLOAD_FAILED');
    job = (await (await call(`/api/v2/jobs/${encodeURIComponent(job.jobId)}?waitSeconds=25`)).json()) as ProviderJob;
  }
  opts.onDownloading?.();

  // 3. Checks before transferring (the conversion is already spent, the transfer is not).
  if (job.mediaDurationSeconds !== undefined && job.mediaDurationSeconds > config.maxDurationS) throw new SourceError('TOO_LONG');
  if (job.fileSize !== undefined && job.fileSize > config.maxFileBytes) throw new SourceError('TOO_LARGE');

  // 4. Stream the result to disk.
  const res = await call(`/api/v2/jobs/${encodeURIComponent(job.jobId)}/download`);
  return saveResponse(res, jobId, signal);
}

/** "YouTube Audio Downloader & Converter" (nbdy0) as a source of the fallback chain. A fresh
 * idempotency key per call: the provider returns the original (failed) job for a repeated key. */
export const audioDownloaderConverter: AudioSource = {
  name: 'audio-downloader-converter',
  download: (videoId, jobId, signal, ctx) =>
    downloadViaRapidApi(videoId, jobId, signal, { idempotencyKey: randomUUID(), onDownloading: ctx.onDownloading }),
};
