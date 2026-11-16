import os from 'node:os';
import path from 'node:path';

// Initial operating values: starting points to be calibrated, not decisions
// (TECHNICAL_ARCHITECTURE.md Section 5.1). All can be overridden by environment.
// The defaults are deliberately strict (abuse protection on a 1 GB / free-egress host).
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const MB = 1024 * 1024;

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: num('PORT', 8787),
  maxDurationS: num('MAX_DURATION_S', 600),
  maxConcurrentJobs: num('MAX_CONCURRENT_JOBS', 1),
  maxQueuedJobs: num('MAX_QUEUED_JOBS', 3),
  jobTimeoutMs: num('JOB_TIMEOUT_MS', 90_000),
  /** Extra attempts after a generic (possibly transient) yt-dlp failure; starting values. */
  downloadRetries: num('DOWNLOAD_RETRIES', 1),
  retryDelayMs: num('RETRY_DELAY_MS', 1500),
  readyTtlMs: num('READY_TTL_MS', 180_000),
  maxFileBytes: num('MAX_FILE_BYTES', 16 * MB),
  ytdlpPath: process.env.YTDLP_PATH ?? 'yt-dlp',
  /** When set, audio comes from the RapidAPI conversion API instead of yt-dlp (server/rapidapi.ts). Secret. */
  rapidApiKey: process.env.RAPIDAPI_KEY ?? '',
  rapidApiHost: process.env.RAPIDAPI_HOST ?? 'youtube-audio-downloader-converter.p.rapidapi.com',
  tempDir: path.join(os.tmpdir(), 'sonora-jobs'),
  // Logs extractor diagnostics (may contain video ids). Off by default.
  debug: process.env.SONORA_DEBUG === '1',

  // --- Abuse protection ---
  /** Behind our own reverse proxy (Caddy): use the client IP it appends to X-Forwarded-For. */
  trustProxy: process.env.TRUST_PROXY === '1',
  /** Browser origin allowed to call the API (CORS). Empty: no CORS headers (same-origin / dev proxy). */
  allowedOrigin: process.env.ALLOWED_ORIGIN ?? '',
  /** Per client (IPv4, or IPv6 /64). */
  requestsPerMinute: num('REQUESTS_PER_MIN', 120), // any endpoint, includes status polling
  jobsPerMinute: num('JOBS_PER_MIN', 3),
  jobsPerHour: num('JOBS_PER_HOUR', 10),
  jobsPerDay: num('JOBS_PER_DAY', 25),
  maxActiveJobsPerClient: num('MAX_ACTIVE_JOBS_PER_CLIENT', 1),
  /** Global. */
  globalJobsPerHour: num('GLOBAL_JOBS_PER_HOUR', 30),
  dailyEgressBytes: num('DAILY_EGRESS_BYTES', 40 * MB),
  monthlyEgressBytes: num('MONTHLY_EGRESS_BYTES', 600 * MB), // free tier: 1 GB/month
  /** Persisted so restarts and deploys do not reset the egress quota. */
  stateFile: process.env.STATE_FILE ?? path.join(os.tmpdir(), 'sonora-state.json'),
  /** Source-block circuit breaker. */
  breakerThreshold: num('BREAKER_THRESHOLD', 2),
  breakerPauseMs: num('BREAKER_PAUSE_MS', 30 * 60_000),
  /** Delivery: attempts per job and a hard cap on send time (slow readers). */
  maxServeAttempts: num('MAX_SERVE_ATTEMPTS', 2),
  sendTimeoutMs: num('SEND_TIMEOUT_MS', 60_000),
  maxConnections: num('MAX_CONNECTIONS', 100),
};
