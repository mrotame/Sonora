// Source adapter: the only module that knows about yt-dlp / YouTube.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ErrorCode } from '../shared/contract.ts';
import { config } from './config.ts';
import { canonicalUrl } from '../shared/youtubeUrl.ts';

export class SourceError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface SourceMetadata {
  durationS: number | null;
  isLive: boolean;
}

const CAP = 64 * 1024;

function run(args: string[], signal: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-CAP)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-CAP)));
    child.on('error', reject); // includes abort and a missing executable
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

function classify(stderr: string): ErrorCode {
  if (/sign in to confirm (you|that)|not a bot|HTTP Error 429|too many requests/i.test(stderr)) return 'BLOCKED';
  if (/private video|video unavailable|this video is unavailable|has been removed|members-only|confirm your age|not available in your country|copyright/i.test(stderr))
    return 'UNAVAILABLE';
  return 'DOWNLOAD_FAILED';
}

function debug(label: string, text: string): void {
  if (config.debug) console.error(`[ytdlp:${label}] ${text.trim().split('\n').slice(-3).join(' | ')}`);
}

export async function fetchMetadata(videoId: string, signal: AbortSignal): Promise<SourceMetadata> {
  const { stdout, stderr, code } = await run(
    ['--no-playlist', '--no-warnings', '--skip-download', '--print', '%(duration)s|%(is_live)s|%(live_status)s', '--', canonicalUrl(videoId)],
    signal,
  );
  if (code !== 0) {
    debug('metadata', stderr);
    throw new SourceError(classify(stderr));
  }
  const [duration, isLive, liveStatus] = stdout.trim().split('\n').pop()!.split('|');
  const d = Number(duration);
  return {
    durationS: Number.isFinite(d) ? d : null,
    isLive: isLive === 'True' || liveStatus === 'is_live' || liveStatus === 'is_upcoming',
  };
}

/** Downloads the original m4a/AAC stream (no re-encoding). Returns the file path. */
export async function downloadAudio(videoId: string, jobId: string, signal: AbortSignal): Promise<string> {
  const { stdout, stderr, code } = await run(
    [
      '--no-playlist', '--no-warnings', '--no-progress',
      '-f', 'ba[ext=m4a]',
      '--max-filesize', String(config.maxFileBytes),
      '-o', path.join(config.tempDir, `${jobId}.%(ext)s`),
      '--', canonicalUrl(videoId),
    ],
    signal,
  );
  if (code !== 0) {
    debug('download', stderr);
    throw new SourceError(classify(stderr));
  }
  const file = path.join(config.tempDir, `${jobId}.m4a`);
  if (!fs.existsSync(file)) {
    debug('download', stdout + stderr);
    // yt-dlp skips (exit 0) a file above --max-filesize
    throw new SourceError(/larger than max-filesize/i.test(stdout + stderr) ? 'TOO_LARGE' : 'DOWNLOAD_FAILED');
  }
  return file;
}
