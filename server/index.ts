import fs from 'node:fs';
import http from 'node:http';
import type { ApiError, CreateJobResponse, ErrorCode } from '../shared/contract.ts';
import { config } from './config.ts';
import { createJob, getJob, getReadyFile, initStorage, removeJob } from './jobs.ts';
import { parseYouTubeVideoId } from '../shared/youtubeUrl.ts';

// Simple per-IP rate limit on job creation (the remote address is used as is;
// behind a proxy this must be revisited when the host is chosen).
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > config.rateLimitPerMinute;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of hits) if (ts.every((t) => now - t >= 60_000)) hits.delete(ip);
}, 60_000).unref();

const STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_URL: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  BUSY: 503,
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}
function sendError(res: http.ServerResponse, code: ErrorCode): void {
  sendJson(res, STATUS[code] ?? 500, { errorCode: code } satisfies ApiError);
}

function readBody(req: http.IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;

  if (req.method === 'POST' && path === '/api/jobs') {
    if (rateLimited(req.socket.remoteAddress ?? 'unknown')) return sendError(res, 'RATE_LIMITED');
    let url: unknown;
    try {
      url = (JSON.parse(await readBody(req)) as { url?: unknown }).url;
    } catch {
      return sendError(res, 'INVALID_URL');
    }
    const videoId = typeof url === 'string' ? parseYouTubeVideoId(url) : null;
    if (!videoId) return sendError(res, 'INVALID_URL');
    const jobId = createJob(videoId);
    if (!jobId) return sendError(res, 'BUSY');
    return sendJson(res, 202, { jobId } satisfies CreateJobResponse);
  }

  const m = /^\/api\/jobs\/([0-9a-f-]{36})(\/audio)?$/.exec(path);
  if (req.method === 'GET' && m) {
    const id = m[1]!;
    if (!m[2]) {
      const job = getJob(id);
      return job ? sendJson(res, 200, job) : sendError(res, 'NOT_FOUND');
    }
    const file = getReadyFile(id);
    if (file === 'NOT_FOUND') return sendError(res, 'NOT_FOUND');
    if (file === 'NOT_READY') return sendJson(res, 409, { errorCode: 'NOT_FOUND' } satisfies ApiError);
    res.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': file.size, 'cache-control': 'no-store' });
    // The file is deleted after the first complete download.
    res.on('close', () => {
      if (res.writableFinished) removeJob(id);
    });
    fs.createReadStream(file.filePath).pipe(res);
    return;
  }

  sendError(res, 'NOT_FOUND');
}

initStorage();
http
  .createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 'DOWNLOAD_FAILED');
      else res.destroy();
    });
  })
  .listen(config.port, config.host, () => console.log(`Sonora acquisition backend on http://${config.host}:${config.port}`));
