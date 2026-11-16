// Audio source adapter: talks to the Sonora acquisition backend. The rest of
// the app depends on this module's interface, not on YouTube or the HTTP contract.
import type { ApiError, CreateJobResponse, ErrorCode, JobResponse, JobStatus } from '../../../shared/contract';
import { parseYouTubeVideoId } from '../../../shared/youtubeUrl';
import { getCachedAudio, putCachedAudio } from './audioCache';

export type AcquisitionErrorCode = ErrorCode | 'BACKEND_UNREACHABLE' | 'CANCELLED';

export class AcquisitionError extends Error {
  code: AcquisitionErrorCode;
  constructor(code: AcquisitionErrorCode) {
    super(code);
    this.code = code;
  }
}

export type AcquisitionStatus = Exclude<JobStatus, 'failed' | 'ready'> | 'transferring';

const POLL_INTERVAL_MS = 700;
const ACQUISITION_TIMEOUT_MS = 150_000; // initial value, to be calibrated
const TRANSIENT_RETRIES = 3; // simple retry on network failures only (PRODUCT_SPEC 2.4)
// Backend origin for builds served from another host (e.g. GitHub Pages). Empty means
// same origin, which the Vite dev proxy uses in development.
const API_BASE = String(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

async function request(input: string, init: RequestInit | undefined, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(input, { ...init, signal });
    } catch {
      if (signal.aborted) throw new AcquisitionError('CANCELLED');
      if (attempt >= TRANSIENT_RETRIES) throw new AcquisitionError('BACKEND_UNREACHABLE');
      await sleep(500 * (attempt + 1), signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new AcquisitionError('CANCELLED')); }, { once: true });
  });
}

async function failFrom(res: Response): Promise<never> {
  // A body without the contract's errorCode comes from a proxy or gateway, not
  // from the backend: a 5xx there means the backend is not reachable.
  let code: AcquisitionErrorCode = res.status >= 500 ? 'BACKEND_UNREACHABLE' : 'DOWNLOAD_FAILED';
  try {
    const body = (await res.json()) as Partial<ApiError>;
    if (body.errorCode) code = body.errorCode;
  } catch {
    // keep the status-based code
  }
  throw new AcquisitionError(code);
}

/**
 * Returns the audio bytes for a YouTube URL: from the local cache when the
 * video was downloaded before, otherwise from the backend (then cached).
 */
export async function acquireAudio(
  url: string,
  onStatus: (status: AcquisitionStatus) => void,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const videoId = parseYouTubeVideoId(url);
  if (videoId) {
    const cached = await getCachedAudio(videoId);
    if (signal.aborted) throw new AcquisitionError('CANCELLED');
    if (cached) return cached;
  }
  const data = await downloadFromBackend(url, onStatus, signal);
  // IndexedDB structured-clones the buffer, so `data` stays usable by the caller.
  if (videoId) await putCachedAudio(videoId, data);
  return data;
}

async function downloadFromBackend(
  url: string,
  onStatus: (status: AcquisitionStatus) => void,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const deadline = Date.now() + ACQUISITION_TIMEOUT_MS;

  const created = await request(`${API_BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  }, signal);
  if (!created.ok) return failFrom(created);
  const { jobId } = (await created.json()) as CreateJobResponse;

  for (;;) {
    if (Date.now() > deadline) throw new AcquisitionError('TIMEOUT');
    const res = await request(`${API_BASE}/api/jobs/${jobId}`, undefined, signal);
    if (!res.ok) return failFrom(res);
    const job = (await res.json()) as JobResponse;
    if (job.status === 'failed') throw new AcquisitionError(job.errorCode ?? 'DOWNLOAD_FAILED');
    if (job.status === 'ready') break;
    onStatus(job.status);
    await sleep(POLL_INTERVAL_MS, signal);
  }

  onStatus('transferring');
  const audio = await request(`${API_BASE}/api/jobs/${jobId}/audio`, undefined, signal);
  if (!audio.ok) return failFrom(audio);
  return audio.arrayBuffer();
}
