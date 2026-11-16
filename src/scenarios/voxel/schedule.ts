// Voxel Dreamscape: when the camera is in the Nether and what time it is in the overworld (pure, no Three.js, no DOM).
// The slow intensity of the music (with hysteresis) opens a Nether interval at each intense passage and closes it when
// the music calms down. Time of day starts at dawn; every exit from the Nether leaves the world at a later hour, and the
// last exit is at night. Everything is a pure function of the timeline, memoized per timeline.
import type { Timeline } from '../../audio/intelligence/timeline.ts';
import { intensityCurves } from './path.ts';

export const SCHEDULE = {
  /** Slow intensity above which the camera enters the Nether, and below which it leaves. */
  enter: 0.7,
  exit: 0.45,
  /** Minimum time (s) in the Nether, in the overworld between two visits, and before the first entry. */
  minNetherS: 8,
  minOverworldS: 10,
  firstEntryS: 6,
  /** The Nether is closed this long (s) before the music ends: the epilogue is always in the overworld. */
  endMarginS: 2,
  /** Hours: dawn at the start, the first and last exit hours (the last is at night). */
  startHour: 6.5,
  firstExitHour: 9,
  lastExitHour: 21,
  /** Without any Nether visit the day only advances to this hour over the music. */
  idleEndHour: 12,
  /** Share of the hours to the next exit that the overworld advances while the camera stays there. */
  driftShare: 0.3,
} as const;

export interface Interval {
  /** Track time (s) of the entry portal and of the exit portal. */
  t0: number;
  t1: number;
  /** Hour of the day right after the exit. */
  exitHour: number;
}

export interface Schedule {
  intervals: Interval[];
  musicEndS: number;
}

const cache = new WeakMap<Timeline, Schedule>();

export function scheduleOf(timeline: Timeline): Schedule {
  const hit = cache.get(timeline);
  if (hit) return hit;
  const { rate } = timeline.data;
  const curve = intensityCurves(timeline).islands;
  const musicEndS = timeline.musicEndS;
  const raw: [number, number][] = [];
  let inside = false, start = 0, lastExit = -1e9;
  for (let i = 0; i < curve.length; i++) {
    const t = i / rate, x = curve[i]!;
    if (t >= musicEndS) break;
    if (!inside && x > SCHEDULE.enter && t >= SCHEDULE.firstEntryS && t - lastExit >= SCHEDULE.minOverworldS) {
      inside = true;
      start = t;
    } else if (inside && x < SCHEDULE.exit && t - start >= SCHEDULE.minNetherS) {
      raw.push([start, t]);
      inside = false;
      lastExit = t;
    }
  }
  const closeAt = musicEndS - SCHEDULE.endMarginS;
  if (inside) raw.push([start, closeAt]);
  // The last interval may have been cut short by the forced exit; drop it when it is too brief to be worth a visit.
  const kept = raw.filter(([a, b]) => b - a >= SCHEDULE.minNetherS * 0.5 && b <= closeAt + 1e-6);
  const n = kept.length;
  const intervals = kept.map(([t0, t1], k): Interval => ({
    t0,
    t1,
    exitHour: n === 1 ? SCHEDULE.lastExitHour : SCHEDULE.firstExitHour + ((SCHEDULE.lastExitHour - SCHEDULE.firstExitHour) * k) / (n - 1),
  }));
  const schedule = { intervals, musicEndS };
  cache.set(timeline, schedule);
  return schedule;
}

/** Interval containing track time t, or null in the overworld. */
export function netherAt(s: Schedule, t: number): Interval | null {
  for (const iv of s.intervals) if (t >= iv.t0 && t < iv.t1) return iv;
  return null;
}

/** Hour of the day (0..24, may exceed 24 only never; it stops at the last exit hour) at track time t. */
export function hourAt(s: Schedule, t: number): number {
  const { intervals } = s;
  if (intervals.length === 0) {
    return SCHEDULE.startHour + (SCHEDULE.idleEndHour - SCHEDULE.startHour) * Math.min(1, Math.max(0, t / Math.max(1, s.musicEndS)));
  }
  let prevT = 0, prevHour: number = SCHEDULE.startHour;
  for (const iv of intervals) {
    const next = iv.exitHour;
    if (t < iv.t0) {
      // Overworld before this visit: a slow drift toward (a share of) the hour after the exit.
      const f = (t - prevT) / Math.max(1e-6, iv.t0 - prevT);
      return prevHour + (next - prevHour) * SCHEDULE.driftShare * f;
    }
    const entryHour = prevHour + (next - prevHour) * SCHEDULE.driftShare;
    if (t < iv.t1) return entryHour + (next - entryHour) * ((t - iv.t0) / (iv.t1 - iv.t0)); // inside: not visible
    prevT = iv.t1;
    prevHour = next;
  }
  return prevHour; // after the last exit: night
}
