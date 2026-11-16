// Abuse protection primitives. Pure and clock-injectable so they can be unit tested.
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';

/** Sliding-window counter per key. `allows` and `record` are separate so several windows can be checked atomically. */
export class SlidingWindow {
  private hits = new Map<string, number[]>();
  private limit: number;
  private windowMs: number;
  private now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  allows(key: string): boolean {
    return this.recent(key).length < this.limit;
  }

  record(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
  }

  /** Records and returns true only when under the limit. */
  tryHit(key: string): boolean {
    if (!this.allows(key)) return false;
    this.record(key);
    return true;
  }

  prune(): void {
    for (const key of [...this.hits.keys()]) this.recent(key);
  }

  get size(): number {
    return this.hits.size;
  }
}

/** Stops sending traffic to the source after repeated blocks, so the host IP is not burned further. */
export class Breaker {
  private consecutive = 0;
  private pausedUntil = 0;
  private threshold: number;
  private pauseMs: number;
  private now: () => number;

  constructor(threshold: number, pauseMs: number, now: () => number = Date.now) {
    this.threshold = threshold;
    this.pauseMs = pauseMs;
    this.now = now;
  }

  isOpen(): boolean {
    return this.now() < this.pausedUntil;
  }

  recordBlocked(): void {
    if (++this.consecutive >= this.threshold) {
      this.pausedUntil = this.now() + this.pauseMs;
      this.consecutive = 0;
    }
  }

  recordOk(): void {
    this.consecutive = 0;
  }
}

interface QuotaState {
  day: string;
  dayBytes: number;
  month: string;
  monthBytes: number;
}

/** Global egress quota (UTC day and month), persisted so restarts and deploys do not reset it. */
export class Quota {
  private state: QuotaState;
  private file: string | null;
  private max: { dayBytes: number; monthBytes: number };
  private now: () => number;

  constructor(file: string | null, max: { dayBytes: number; monthBytes: number }, now: () => number = Date.now) {
    this.file = file;
    this.max = max;
    this.now = now;
    this.state = this.load();
  }

  private stamp(): { day: string; month: string } {
    const iso = new Date(this.now()).toISOString();
    return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
  }

  private load(): QuotaState {
    const { day, month } = this.stamp();
    const fresh: QuotaState = { day, dayBytes: 0, month, monthBytes: 0 };
    if (!this.file) return fresh;
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<QuotaState>;
      if (typeof s.day === 'string' && typeof s.month === 'string' && Number.isFinite(s.dayBytes) && Number.isFinite(s.monthBytes)) {
        return s as QuotaState;
      }
    } catch {
      // missing or corrupt: start clean
    }
    return fresh;
  }

  private roll(): void {
    const { day, month } = this.stamp();
    if (this.state.month !== month) this.state = { day, dayBytes: 0, month, monthBytes: 0 };
    else if (this.state.day !== day) this.state = { ...this.state, day, dayBytes: 0 };
  }

  exceeded(): boolean {
    this.roll();
    return this.state.dayBytes >= this.max.dayBytes || this.state.monthBytes >= this.max.monthBytes;
  }

  add(bytes: number): void {
    if (!(bytes > 0)) return;
    this.roll();
    this.state.dayBytes += bytes;
    this.state.monthBytes += bytes;
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch {
      // persistence is best effort; the in-memory counter still protects this run
    }
  }
}

function expandIPv6(ip: string): string[] | null {
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : null;
  let groups: string[];
  if (tail === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  }
  return groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
}

/** Rate-limit key: IPv4 as is, IPv6 collapsed to its /64 (one host can rotate within it for free). */
export function normalizeIp(raw: string): string {
  const ip = raw.split('%')[0]!;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const groups = expandIPv6(ip);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : ip;
}

/**
 * The client key. With trustProxy the LAST X-Forwarded-For entry is used: it is the one our own
 * reverse proxy appended, while earlier entries can be forged by the client.
 */
export function clientKey(req: IncomingMessage, trustProxy: boolean): string {
  let ip = req.socket.remoteAddress ?? 'unknown';
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const value = Array.isArray(header) ? header.at(-1) : header;
    const last = value?.split(',').at(-1)?.trim();
    if (last) ip = last;
  }
  return normalizeIp(ip);
}
