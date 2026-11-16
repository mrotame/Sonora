import os from 'node:os';
import path from 'node:path';

// Initial operating values: starting points to be calibrated, not decisions
// (TECHNICAL_ARCHITECTURE.md Section 5.1). All can be overridden by environment.
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: num('PORT', 8787),
  maxDurationS: num('MAX_DURATION_S', 600),
  maxConcurrentJobs: num('MAX_CONCURRENT_JOBS', 2),
  maxQueuedJobs: num('MAX_QUEUED_JOBS', 10),
  jobTimeoutMs: num('JOB_TIMEOUT_MS', 120_000),
  /** Extra attempts after a generic (possibly transient) yt-dlp failure; starting values. */
  downloadRetries: num('DOWNLOAD_RETRIES', 2),
  retryDelayMs: num('RETRY_DELAY_MS', 1500),
  readyTtlMs: num('READY_TTL_MS', 600_000),
  maxFileBytes: num('MAX_FILE_BYTES', 30 * 1024 * 1024),
  rateLimitPerMinute: num('RATE_LIMIT_PER_MIN', 10),
  ytdlpPath: process.env.YTDLP_PATH ?? 'yt-dlp',
  tempDir: path.join(os.tmpdir(), 'sonora-jobs'),
  // Logs extractor diagnostics (may contain video ids). Off by default.
  debug: process.env.SONORA_DEBUG === '1',
};
