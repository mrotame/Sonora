// Acquisition source chain (ADR 0012). Tries each configured source in priority order and
// falls back to the next one when a source fails for a reason another source may not share
// (provider down, quota used up, blocked). Outcomes about the video itself stop the chain.
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ErrorCode } from '../shared/contract.ts';
import { config } from './config.ts';
import { SourceError } from './ytdlp.ts';

export interface SourceContext {
  /** Called when the source starts transferring or converting (maps to the 'downloading' status). */
  onDownloading: () => void;
}

export interface AudioSource {
  /** Short name for diagnostics only. */
  name: string;
  /** Downloads the audio of a video to the temp dir. Returns the file path. Throws SourceError. */
  download(videoId: string, jobId: string, signal: AbortSignal, ctx: SourceContext): Promise<string>;
}

/** The video itself cannot be used: another source would give the same answer and spend quota. */
const DEFINITIVE: ReadonlySet<ErrorCode> = new Set(['UNAVAILABLE', 'LIVE', 'TOO_LONG', 'TOO_LARGE']);

export async function downloadWithFallback(
  sources: readonly AudioSource[],
  videoId: string,
  jobId: string,
  signal: AbortSignal,
  ctx: SourceContext,
  onFallback?: (failed: string, code: ErrorCode) => void,
): Promise<string> {
  let last: unknown = new SourceError('DOWNLOAD_FAILED');
  for (const source of sources) {
    try {
      return await source.download(videoId, jobId, signal, ctx);
    } catch (e) {
      if (signal.aborted) throw e; // the job timeout covers the whole chain
      const code: ErrorCode = e instanceof SourceError ? e.code : 'DOWNLOAD_FAILED';
      if (DEFINITIVE.has(code)) throw e;
      onFallback?.(source.name, code);
      last = e instanceof SourceError ? e : new SourceError('DOWNLOAD_FAILED');
    }
  }
  throw last;
}

/** Streams an HTTP response body to `<tempDir>/<jobId>.m4a`, enforcing the size limit even
 * without a declared size. Removes the partial file on failure. Returns the file path. */
export async function saveResponse(res: Response, jobId: string, signal: AbortSignal): Promise<string> {
  if (!res.body) throw new SourceError('DOWNLOAD_FAILED');
  const declared = Number(res.headers.get('content-length'));
  if (declared > config.maxFileBytes) throw new SourceError('TOO_LARGE');
  const file = path.join(config.tempDir, `${jobId}.m4a`);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      done(bytes > config.maxFileBytes ? new SourceError('TOO_LARGE') : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as never), limit, fs.createWriteStream(file), { signal });
  } catch (e) {
    fs.rmSync(file, { force: true });
    if (e instanceof SourceError || signal.aborted) throw e;
    throw new SourceError('DOWNLOAD_FAILED');
  }
  if (bytes === 0) {
    fs.rmSync(file, { force: true });
    throw new SourceError('DOWNLOAD_FAILED');
  }
  return file;
}
