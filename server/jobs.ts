import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ErrorCode, JobResponse, JobStatus } from '../shared/contract.ts';
import { config } from './config.ts';
import { Breaker } from './limits.ts';
import { audioDownloaderConverter } from './rapidapi.ts';
import { withRetry } from './retry.ts';
import { type AudioSource, downloadWithFallback } from './sources.ts';
import { ytMp3M4a } from './ytMp3M4a.ts';
import { ytToMp3 } from './ytToMp3.ts';
import { downloadAudio, fetchMetadata, SourceError } from './ytdlp.ts';

// Job state lives in memory only (ADR 0008). Files live in the OS temp dir.
interface Job {
  id: string;
  videoId: string;
  status: JobStatus;
  errorCode?: ErrorCode;
  filePath?: string;
  abort: AbortController;
  expiry?: NodeJS.Timeout;
  owner: string;
  serves: number;
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running = 0;

/** Production sources, highest priority first. Used only when RAPIDAPI_KEY is set (Cloud Run).
 * Both share the same RapidAPI key; each needs its own (free) subscription on that account. */
const PROVIDERS: readonly AudioSource[] = [ytMp3M4a, ytToMp3, audioDownloaderConverter];

/** Stops hitting the source after repeated blocks (see limits.ts). */
export const breaker = new Breaker(config.breakerThreshold, config.breakerPauseMs);

/** Jobs of a client that are still being prepared (queued or running). */
export function activeJobs(owner: string): number {
  let n = 0;
  for (const job of jobs.values()) {
    if (job.owner === owner && (job.status === 'queued' || job.status === 'fetching_metadata' || job.status === 'downloading')) n++;
  }
  return n;
}

/** Startup cleanup: removes orphaned files from a previous run. */
export function initStorage(): void {
  fs.rmSync(config.tempDir, { recursive: true, force: true });
  fs.mkdirSync(config.tempDir, { recursive: true });
}

/** Returns the job id, or undefined when the queue is full. */
export function createJob(videoId: string, owner: string): string | undefined {
  if (queue.length >= config.maxQueuedJobs) return undefined;
  const job: Job = { id: randomUUID(), videoId, status: 'queued', abort: new AbortController(), owner, serves: 0 };
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  return job.id;
}

export function getJob(id: string): JobResponse | undefined {
  const job = jobs.get(id);
  return job && { jobId: job.id, status: job.status, errorCode: job.errorCode };
}

/** The file of a ready job. The caller must call removeJob after a complete download. */
export function getReadyFile(id: string): { filePath: string; size: number } | 'NOT_FOUND' | 'NOT_READY' {
  const job = jobs.get(id);
  if (!job) return 'NOT_FOUND';
  if (job.status !== 'ready' || !job.filePath) return 'NOT_READY';
  // Bounded re-delivery: aborted and repeated downloads would otherwise multiply egress.
  if (job.serves >= config.maxServeAttempts) return 'NOT_FOUND';
  job.serves++;
  return { filePath: job.filePath, size: fs.statSync(job.filePath).size };
}

export function removeJob(id: string): void {
  const job = jobs.get(id);
  if (!job) return;
  clearTimeout(job.expiry);
  jobs.delete(id);
  removeFiles(id);
}

function removeFiles(id: string): void {
  for (const name of fs.readdirSync(config.tempDir)) {
    if (name.startsWith(id)) fs.rmSync(path.join(config.tempDir, name), { force: true });
  }
}

function pump(): void {
  while (running < config.maxConcurrentJobs && queue.length > 0) void run(queue.shift()!);
}

async function run(job: Job): Promise<void> {
  running++;
  const timer = setTimeout(() => job.abort.abort(), config.jobTimeoutMs);
  try {
    if (breaker.isOpen()) throw new SourceError('BLOCKED'); // queued before the pause began
    job.filePath = await withRetry(async () => {
      removeFiles(job.id); // a failed attempt may leave partial files
      if (config.rapidApiKey) {
        // Third-party APIs in priority order (datacenter IPs are blocked by YouTube, ADR 0012).
        job.status = 'fetching_metadata';
        return downloadWithFallback(PROVIDERS, job.videoId, job.id, job.abort.signal, {
          onDownloading: () => (job.status = 'downloading'),
        }, (name, code) => {
          if (config.debug) console.error(`[job] source ${name} failed (${code}), trying the next one`);
        });
      }
      job.status = 'fetching_metadata';
      const meta = await fetchMetadata(job.videoId, job.abort.signal);
      if (meta.isLive) throw new SourceError('LIVE');
      if (meta.durationS === null) throw new SourceError('UNAVAILABLE');
      if (meta.durationS > config.maxDurationS) throw new SourceError('TOO_LONG');
      job.status = 'downloading';
      return downloadAudio(job.videoId, job.id, job.abort.signal);
    }, { retries: config.downloadRetries, delayMs: config.retryDelayMs }, job.abort.signal, (n) => {
      if (config.debug) console.error(`[job] transient failure, retry ${n}/${config.downloadRetries}`);
    });
    job.status = 'ready';
    breaker.recordOk();
  } catch (e) {
    if (job.abort.signal.aborted) job.errorCode = 'TIMEOUT';
    else if (e instanceof SourceError) {
      job.errorCode = e.code;
      if (e.code === 'BLOCKED' && !breaker.isOpen()) breaker.recordBlocked();
    }
    else {
      job.errorCode = 'DOWNLOAD_FAILED';
      if (config.debug) console.error('[job] unexpected error:', e);
    }
    job.status = 'failed';
    removeFiles(job.id);
  } finally {
    clearTimeout(timer);
    job.videoId = ''; // the source locator is not kept after use
    running--;
    job.expiry = setTimeout(() => removeJob(job.id), config.readyTtlMs);
    job.expiry.unref();
    pump();
  }
}
