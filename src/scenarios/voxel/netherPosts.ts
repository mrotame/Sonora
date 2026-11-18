// Voxel Dreamscape: where the Nether bridge's light posts stand (pure, no Three.js, no DOM). Each post is placed so the
// camera passes it on a beat of the music: on the beat the post is as close to the screen as it gets while still in view,
// and it leaves the screen POSTS.leadS later (POSTS.windowS: 80..150 ms). Rows are whole blocks, so a post can only leave
// at the times its row allows: a beat whose nearest row misses the window gets no post. Not every beat gets one either:
// the posts follow the beats of the bass line (bassBeatTimes) and are never closer than POSTS.minGap rows, so when the
// beats are fast a post stands on every 2nd or 3rd one; a stretch without usable beats (a quiet passage, or no clear
// pulse) gets evenly spaced posts so the bridge is never left dark.
// Pure function of the timeline and the path (the camera's distance, height, slope and field of view), memoized per path.
import type { Timeline } from '../../audio/intelligence/timeline.ts';
import type { TrackPath } from '../types.ts';
import { bassBeatTimes, beatsUpTo } from './beats.ts';
import { NETHER } from './nether.ts';
import { netherRailsOf } from './path.ts';
import { deckLayer, ROAD } from './road.ts';
import { scheduleOf } from './schedule.ts';

export const POSTS = {
  /** Seconds from the beat to the moment the post leaves the screen: the target, and the accepted window around it. */
  leadS: 0.115,
  windowS: [0.08, 0.15],
  /** Rows between posts: the spacing of the fill-in posts, the least allowed (posts never bunch up), and the gap beyond which they fill in. */
  spacing: 16,
  minGap: 8,
  maxGap: 32,
  /**
   * Screen aspect (width / height) the exit is computed for: the world is generated in the Worker and cannot depend on
   * the window. The lamp (the last part to go) leaves through the top of the screen, which does not depend on it.
   */
  aspect: 16 / 9,
  /** The controller's camera: default vertical field of view, near plane, and the share of the slope angle it pitches by. */
  defaultFovDeg: 70,
  near: 0.5,
  pathTilt: ROAD.cameraTilt,
} as const;

/** One box of a post: x across (m, from the road centre), y above the deck surface, d from the start of the post's row. */
interface Box { x0: number; x1: number; y0: number; y1: number; d0: number; d1: number }

/** The post on the right side (x > 0; the left one is its mirror image, so it leaves the screen at the same time). */
const BOXES: Box[] = (() => {
  const px = NETHER.postX, h = ROAD.postHeight;
  return [
    { x0: px - 0.5, x1: px + 0.5, y0: -1, y1: 0, d0: 0, d1: 1 }, // nether-brick bracket (the deck layer)
    { x0: px - 0.125, x1: px + 0.125, y0: 0, y1: h, d0: 0.375, d1: 0.625 }, // fence column
    { x0: px - 1.125, x1: px - 0.875, y0: h - 1, y1: h, d0: 0.375, d1: 0.625 }, // arm (fence post)
    { x0: px - 0.875, x1: px - 0.125, y0: h - 0.625, y1: h - 0.0625, d0: 0.4375, d1: 0.5625 }, // arm bars
    { x0: px - 1.5, x1: px - 0.5, y0: h - 2, y1: h - 1, d0: 0, d1: 1 }, // redstone lamp
  ];
})();

/** True while some part of the post on row bd (deck layer dl) is in the camera's view at track time t. */
function onScreen(path: TrackPath, bd: number, dl: number, t: number): boolean {
  const fov = path.fovAt?.(t) ?? POSTS.defaultFovDeg;
  const tanV = Math.tan((fov * Math.PI) / 360), tanH = POSTS.aspect * tanV;
  const pitch = Math.atan(path.slopeAt(t)) * POSTS.pathTilt;
  const c = Math.cos(pitch), s = Math.sin(pitch);
  const camD = path.distanceAt(t);
  // Eye above this row's deck surface: the eye rides ROAD.eyeAbove over the deck under the camera.
  const eye = ROAD.eyeAbove + (ROAD.layer + path.heightAt(t)) - dl;
  for (const b of BOXES) {
    // The box is out of view only if all its corners are beyond the same plane of the view frustum.
    let left = 0, right = 0, top = 0, bottom = 0, behind = 0;
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? b.x1 : b.x0, u = (k & 2 ? b.y1 : b.y0) - eye, f = bd + (k & 4 ? b.d1 : b.d0) - camD;
      const fwd = f * c + u * s, up = u * c - f * s;
      if (fwd < POSTS.near) behind++;
      if (x > fwd * tanH) right++;
      if (-x > fwd * tanH) left++;
      if (up > fwd * tanV) top++;
      if (-up > fwd * tanV) bottom++;
    }
    if (behind < 8 && left < 8 && right < 8 && top < 8 && bottom < 8) return true;
  }
  return false;
}

/** Deck layer of the rails at row bd: the path's rail table (a path without one: its height when the camera is there). */
const deckAt = (path: TrackPath, bd: number) => netherRailsOf(path)?.layerAt(bd) ?? deckLayer(path.heightAt(path.timeAt(bd + 0.5)));

/**
 * Track time at which the post on row bd leaves the screen: the last moment it is in view before the camera passes it
 * (scanned in 5 cm steps over the 12 m before the row, then bisected to 1 mm).
 */
export function postExitTime(path: TrackPath, bd: number): number {
  const dl = deckAt(path, bd);
  const step = 0.05;
  let lastIn = -1;
  for (let d = bd - 12; d <= bd + 1; d += step) if (onScreen(path, bd, dl, path.timeAt(d))) lastIn = d;
  if (lastIn < 0) return path.timeAt(bd);
  let a = lastIn, b = lastIn + step;
  while (b - a > 1e-3) {
    const m = (a + b) / 2;
    if (onScreen(path, bd, dl, path.timeAt(m))) a = m;
    else b = m;
  }
  return path.timeAt(a);
}

const cache = new WeakMap<TrackPath, WeakMap<Timeline, Int32Array>>();

/** Rows (increasing) of the Nether light posts of every visit, the tail past each exit portal included. */
export function netherPostRows(timeline: Timeline, path: TrackPath): Int32Array {
  let byTimeline = cache.get(path);
  if (!byTimeline) cache.set(path, (byTimeline = new WeakMap()));
  const hit = byTimeline.get(timeline);
  if (hit) return hit;
  const rows = build(timeline, path);
  byTimeline.set(timeline, rows);
  return rows;
}

/** True when a Nether light post stands on row bd. */
export function isPostRow(rows: Int32Array, bd: number): boolean {
  const k = beatsUpTo(rows, bd);
  return k > 0 && rows[k - 1] === bd;
}

function build(timeline: Timeline, path: TrackPath): Int32Array {
  const { intervals } = scheduleOf(timeline);
  const beats = bassBeatTimes(timeline);
  const half = (POSTS.windowS[1] - POSTS.windowS[0]) / 2, mid = (POSTS.windowS[0] + POSTS.windowS[1]) / 2;
  const out: number[] = [];
  intervals.forEach((iv, k) => {
    const entry = Math.floor(path.distanceAt(iv.t0)), exit = Math.floor(path.distanceAt(iv.t1));
    const lo = entry + 2, hi = exit - 2; // never within a row of a portal
    // One candidate per beat of the visit: the row whose post leaves the screen closest to leadS after the beat, kept
    // only if that is inside the window.
    const candidates: number[] = [];
    for (let i = beatsUpTo(beats, iv.t0); i < beats.length && beats[i]! < iv.t1; i++) {
      const target = beats[i]! + POSTS.leadS;
      const r0 = Math.floor(path.distanceAt(target));
      let best = -1, bestErr = Infinity;
      for (let r = r0 - 1; r <= r0 + 2; r++) {
        const err = Math.abs(postExitTime(path, r) - target);
        if (err < bestErr) { bestErr = err; best = r; }
      }
      const lead = postExitTime(path, best) - beats[i]!;
      if (Math.abs(lead - mid) > half + 1e-9) continue;
      if (best >= lo && best <= hi && (candidates.length === 0 || best > candidates[candidates.length - 1]!)) candidates.push(best);
    }
    // Spacing: every bass beat gets a post, except those closer than minGap rows to the last post: when the beats are fast
    // (or the camera slow) the posts fall on every 2nd or 3rd beat instead. Where the next usable beat is more than maxGap
    // rows away, evenly spaced posts fill in.
    let last = lo - POSTS.minGap;
    const fill = (until: number) => {
      while (until - last > POSTS.maxGap) { last += POSTS.spacing; out.push(last); }
    };
    for (const row of candidates) {
      if (row < last + POSTS.minGap) continue;
      fill(row);
      last = row;
      out.push(row);
    }
    fill(hi + 1);
    // The tail past the exit portal (only seen through and around it): evenly spaced, up to its end.
    const next = intervals[k + 1];
    const tailEnd = Math.min(exit + NETHER.exitTail, next ? Math.floor(path.distanceAt(next.t0)) - 2 : Infinity);
    for (let r = exit + POSTS.spacing; r <= tailEnd; r += POSTS.spacing) out.push(r);
  });
  return Int32Array.from(out);
}
