import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ErrorCode, JobResponse, JobStatus } from '../shared/contract.ts';
import { config } from './config.ts';
import { withRetry } from './retry.ts';
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
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running = 0;

/** Startup cleanup: removes orphaned files from a previous run. */
export function initStorage(): void {
  fs.rmSync(config.tempDir, { recursive: true, force: true });
  fs.mkdirSync(config.tempDir, { recursive: true });
}

/** Returns the job id, or undefined when the queue is full. */
export function createJob(videoId: string): string | undefined {
  if (queue.length >= config.maxQueuedJobs) return undefined;
  const job: Job = { id: randomUUID(), videoId, status: 'queued', abort: new AbortController() };
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
    job.filePath = await withRetry(async () => {
      removeFiles(job.id); // a failed attempt may leave partial files
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
  } catch (e) {
    if (job.abort.signal.aborted) job.errorCode = 'TIMEOUT';
    else if (e instanceof SourceError) job.errorCode = e.code;
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
