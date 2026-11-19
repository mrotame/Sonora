// Voxel Dreamscape: which section the camera is in and what time it is in the overworld (pure, no Three.js, no DOM).
// The music's section intensity (about 3 s of smoothing, centered so it adds no lag) is read at three levels, each with
// hysteresis: calm passages ride the open road, medium ones go through a cave section inside a mountain, and intense
// ones take the camera through a portal into the Nether, which always opens inside a cave (open -> caves -> Nether ->
// caves -> open). Time of day starts at dawn; every exit from the Nether leaves the world at a later hour: the last exit
// is at night, the one before it at sunset, earlier ones from morning to afternoon. Without a visit the day runs from
// dawn to midnight. Everything is a pure function of the timeline, memoized per timeline.
import type { Timeline } from '../../audio/intelligence/timeline.ts';
import { intensityCurves } from './path.ts';

export const SCHEDULE = {
  /**
   * Levels on the section scale (0 calmest .. 1 most intense part of the music, path.ts SECTION_SCALE), user-requested:
   * below 50% open road, 50..69% caves, 70..100% Nether. A small hysteresis around each boundary.
   */
  caveEnter: 0.52,
  caveExit: 0.48,
  enter: 0.72,
  exit: 0.68,
  /** Minimum time (s) of a cave section and of the open road between two of them (shorter gaps are merged). */
  minCaveS: 5,
  minOpenS: 5,
  /** Cave time (s) at least before every Nether entry and after every Nether exit. */
  caveLeadS: 3,
  /** Minimum time (s) in the Nether, in the overworld between two visits, and before the first entry. */
  minNetherS: 6,
  minOverworldS: 8,
  firstEntryS: 6,
  /** No cave starts before this time (s). */
  firstCaveS: 3,
  /** Caves and the Nether are closed this long (s) before the music ends: the epilogue is always on the open road. */
  endMarginS: 2,
  /**
   * Exit hours, counted from the last visit (user-requested): the last exit is at night, the one before it at sunset
   * (golden hour; the overworld drift then carries it to the orange peak near 18.5 h), and any earlier ones spread
   * evenly from morning to afternoon (a single earlier one at noon).
   */
  startHour: 6.5,
  firstExitHour: 9,
  midExitHour: 12,
  lastDayExitHour: 15,
  sunsetExitHour: 17.5,
  lastExitHour: 21,
  /** Without any Nether visit the day runs from dawn to midnight over the music. */
  idleEndHour: 24,
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

export interface Span {
  t0: number;
  t1: number;
}

export interface Schedule {
  /** Nether visits. */
  intervals: Interval[];
  /** Cave sections (track times of the mouth and of the exit); every Nether visit lies inside one, with a lead. */
  caves: Span[];
  musicEndS: number;
}

/** Spans where the curve is above `enter` until it drops below `exit` (each at least `minS` long, starting at `fromS`). */
function hysteresis(curve: Float64Array, rate: number, enter: number, exit: number, minS: number, fromS: number, gapS: number, untilS: number): [number, number][] {
  const out: [number, number][] = [];
  let inside = false, start = 0, lastExit = -1e9;
  for (let i = 0; i < curve.length; i++) {
    const t = i / rate, x = curve[i]!;
    if (t >= untilS) break;
    if (!inside && x > enter && t >= fromS && t - lastExit >= gapS) {
      inside = true;
      start = t;
    } else if (inside && x < exit && t - start >= minS) {
      out.push([start, t]);
      inside = false;
      lastExit = t;
    }
  }
  if (inside) out.push([start, untilS]);
  return out;
}

/** Hour right after exit k of n visits: night for the last, sunset for the one before, the day spread over the rest. */
export function exitHourOf(k: number, n: number): number {
  const S = SCHEDULE;
  const fromEnd = n - 1 - k;
  if (fromEnd === 0) return S.lastExitHour;
  if (fromEnd === 1) return S.sunsetExitHour;
  const m = n - 2; // exits before the sunset one
  if (m === 1) return S.midExitHour;
  return S.firstExitHour + ((S.lastDayExitHour - S.firstExitHour) * k) / (m - 1);
}

const cache = new WeakMap<Timeline, Schedule>();

export function scheduleOf(timeline: Timeline): Schedule {
  const hit = cache.get(timeline);
  if (hit) return hit;
  const { rate } = timeline.data;
  const curve = intensityCurves(timeline).section;
  const musicEndS = timeline.musicEndS;
  const S = SCHEDULE;
  const caveClose = musicEndS - S.endMarginS;
  const netherClose = caveClose - S.caveLeadS;

  // The Nether: the intense passages. The last one may have been cut short by the forced exit; drop it when it is too
  // brief to be worth a visit.
  const nether = hysteresis(curve, rate, S.enter, S.exit, S.minNetherS, S.firstEntryS, S.minOverworldS, netherClose)
    .filter(([a, b]) => b - a >= S.minNetherS * 0.5);

  // Caves: the medium passages, widened so that every Nether visit has its cave lead on both sides.
  const spans = hysteresis(curve, rate, S.caveEnter, S.caveExit, 0, S.firstCaveS, 0, caveClose);
  for (const [a, b] of nether) spans.push([Math.max(S.firstCaveS, a - S.caveLeadS), Math.min(caveClose, b + S.caveLeadS)]);
  spans.sort((p, q) => p[0] - q[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a - last[1] < S.minOpenS) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const caves = merged.filter(([a, b]) => b - a >= S.minCaveS || nether.some(([c, d]) => c >= a && d <= b)).map(([t0, t1]) => ({ t0, t1 }));

  const intervals = nether.map(([t0, t1], k): Interval => ({ t0, t1, exitHour: exitHourOf(k, nether.length) }));
  const schedule = { intervals, caves, musicEndS };
  cache.set(timeline, schedule);
  return schedule;
}

/** Interval containing track time t, or null in the overworld. */
export function netherAt(s: Schedule, t: number): Interval | null {
  for (const iv of s.intervals) if (t >= iv.t0 && t < iv.t1) return iv;
  return null;
}

/** Cave section containing track time t, or null on the open road (a Nether visit is inside a cave section). */
export function caveAt(s: Schedule, t: number): Span | null {
  for (const c of s.caves) if (t >= c.t0 && t < c.t1) return c;
  return null;
}

/** Hour of the day (0..24; with visits it stops at the last exit hour, without them it reaches midnight) at track time t. */
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
