import { SourceError } from './ytdlp.ts';

export interface RetryPolicy {
  retries: number;
  delayMs: number;
}

/**
 * Retries only the generic, possibly transient failure (DOWNLOAD_FAILED).
 * Definitive outcomes (unavailable, live, too long, blocked, too large) and
 * aborts (timeout) are never retried. The delay grows linearly per attempt.
 */
export async function withRetry<T>(
  attempt: () => Promise<T>,
  policy: RetryPolicy,
  signal: AbortSignal,
  onRetry?: (n: number) => void,
): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (e) {
      const transient = e instanceof SourceError && e.code === 'DOWNLOAD_FAILED';
      if (!transient || n >= policy.retries || signal.aborted) throw e;
      onRetry?.(n + 1);
      await new Promise((r) => setTimeout(r, policy.delayMs * (n + 1)));
    }
  }
}
