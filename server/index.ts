import fs from 'node:fs';
import http from 'node:http';
import { pipeline } from 'node:stream';
import type { ApiError, CreateJobResponse, ErrorCode } from '../shared/contract.ts';
import { config } from './config.ts';
import { activeJobs, breaker, createJob, getJob, getReadyFile, initStorage, removeJob } from './jobs.ts';
import { clientKey, Quota, SlidingWindow } from './limits.ts';
import { parseYouTubeVideoId } from '../shared/youtubeUrl.ts';

// Abuse protection (all in memory except the egress quota). Single instance only (ADR 0008).
const requests = new SlidingWindow(config.requestsPerMinute, 60_000);
const jobsMinute = new SlidingWindow(config.jobsPerMinute, 60_000);
const jobsHour = new SlidingWindow(config.jobsPerHour, 3_600_000);
const jobsDay = new SlidingWindow(config.jobsPerDay, 86_400_000);
const globalJobsHour = new SlidingWindow(config.globalJobsPerHour, 3_600_000);
const quota = new Quota(config.stateFile, { dayBytes: config.dailyEgressBytes, monthBytes: config.monthlyEgressBytes });
const GLOBAL = 'global';
setInterval(() => {
  for (const w of [requests, jobsMinute, jobsHour, jobsDay, globalJobsHour]) w.prune();
}, 60_000).unref();

const STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_URL: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  BUSY: 503,
  BLOCKED: 503,
  QUOTA_EXCEEDED: 503,
};

function baseHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  // Only the configured site may read responses in a browser. This is not access control
  // (non-browser clients ignore CORS); the limits above are.
  if (config.allowedOrigin && req.headers.origin === config.allowedOrigin) {
    headers['access-control-allow-origin'] = config.allowedOrigin;
    headers.vary = 'Origin';
  }
  return headers;
}

function sendJson(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...baseHeaders(req), 'content-type': 'application/json', ...extra }).end(JSON.stringify(body));
}
function sendError(req: http.IncomingMessage, res: http.ServerResponse, code: ErrorCode, retryAfterS?: number): void {
  sendJson(req, res, STATUS[code] ?? 500, { errorCode: code } satisfies ApiError, retryAfterS ? { 'retry-after': String(retryAfterS) } : {});
}

function readBody(req: http.IncomingMessage, limit = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    const timer = setTimeout(() => {
      reject(new Error('slow body'));
      req.destroy();
    }, 5_000);
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) {
        clearTimeout(timer);
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(body);
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const client = clientKey(req, config.trustProxy);

  if (req.method === 'OPTIONS') {
    const headers = baseHeaders(req);
    if (headers['access-control-allow-origin']) {
      headers['access-control-allow-methods'] = 'GET, POST';
      headers['access-control-allow-headers'] = 'content-type';
      headers['access-control-max-age'] = '600';
    }
    res.writeHead(204, headers).end();
    return;
  }

  // Every request counts, including status polling and unknown paths.
  if (!requests.tryHit(client)) return sendError(req, res, 'RATE_LIMITED', 60);

  if (req.method === 'POST' && path === '/api/jobs') {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendError(req, res, 'INVALID_URL');
    let url: unknown;
    try {
      url = (JSON.parse(await readBody(req)) as { url?: unknown }).url;
    } catch {
      return sendError(req, res, 'INVALID_URL');
    }
    const videoId = typeof url === 'string' && url.length <= 200 ? parseYouTubeVideoId(url) : null;
    if (!videoId) return sendError(req, res, 'INVALID_URL');

    // Cheapest, most specific refusals first; nothing is recorded unless the job is created.
    if (breaker.isOpen()) return sendError(req, res, 'BLOCKED', 600);
    if (quota.exceeded()) return sendError(req, res, 'QUOTA_EXCEEDED', 3600);
    if (activeJobs(client) >= config.maxActiveJobsPerClient) return sendError(req, res, 'RATE_LIMITED', 30);
    if (!jobsMinute.allows(client) || !jobsHour.allows(client) || !jobsDay.allows(client)) return sendError(req, res, 'RATE_LIMITED', 60);
    if (!globalJobsHour.allows(GLOBAL)) return sendError(req, res, 'QUOTA_EXCEEDED', 600);

    const jobId = createJob(videoId, client);
    if (!jobId) return sendError(req, res, 'BUSY', 30);
    jobsMinute.record(client);
    jobsHour.record(client);
    jobsDay.record(client);
    globalJobsHour.record(GLOBAL);
    return sendJson(req, res, 202, { jobId } satisfies CreateJobResponse);
  }

  const m = /^\/api\/jobs\/([0-9a-f-]{36})(\/audio)?$/.exec(path);
  if (req.method === 'GET' && m) {
    const id = m[1]!;
    if (!m[2]) {
      const job = getJob(id);
      return job ? sendJson(req, res, 200, job) : sendError(req, res, 'NOT_FOUND');
    }
    const file = getReadyFile(id);
    if (file === 'NOT_FOUND') return sendError(req, res, 'NOT_FOUND');
    if (file === 'NOT_READY') return sendJson(req, res, 409, { errorCode: 'NOT_FOUND' } satisfies ApiError);
    quota.add(file.size); // counted when delivery starts: aborted transfers still use egress
    res.writeHead(200, { ...baseHeaders(req), 'content-type': 'audio/mp4', 'content-length': file.size });
    // A slow reader cannot hold the connection and the file indefinitely.
    const sendTimer = setTimeout(() => res.destroy(), config.sendTimeoutMs);
    res.on('close', () => {
      clearTimeout(sendTimer);
      // The file is deleted after the first complete download.
      if (res.writableFinished) removeJob(id);
    });
    pipeline(fs.createReadStream(file.filePath), res, () => {});
    return;
  }

  sendError(req, res, 'NOT_FOUND');
}

initStorage();
const server = http.createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) sendError(req, res, 'DOWNLOAD_FAILED');
    else res.destroy();
  });
});
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxConnections = config.maxConnections;
server.listen(config.port, config.host, () => console.log(`Sonora acquisition backend on http://${config.host}:${config.port}`));
