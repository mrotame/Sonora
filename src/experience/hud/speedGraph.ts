// Track profile HUD (Audiosurf-style): the road height over the WHOLE track (uphill rises, downhill falls),
// with a dot at "now" and a speed readout. Pure function of track time and the scenario path.
import type { TrackPath } from '../../scenarios/types.ts';

const SAMPLE_RATE = 20; // Hz of the precomputed speed table
const KMH = 3.6; // 1 world unit = 1 m (ARCHITECTURE 11)
/** Slope (rise over run) shown as fully saturated: matches the steepest slope of Synthwave's path (PATH.maxSlope). */
const STEEP_SLOPE = 0.75;
const WHITE: readonly [number, number, number] = [255, 255, 255];
const GREEN: readonly [number, number, number] = [60, 255, 120]; // climb
const RED: readonly [number, number, number] = [255, 60, 60]; // descent

/** White when flat, fading to green (uphill) or red (downhill) as the slope gets drastic. */
function slopeColor(slope: number): string {
  const k = Math.min(1, Math.abs(slope) / STEEP_SLOPE);
  const target = slope >= 0 ? GREEN : RED;
  const r = Math.round(WHITE[0] + (target[0] - WHITE[0]) * k);
  const g = Math.round(WHITE[1] + (target[1] - WHITE[1]) * k);
  const b = Math.round(WHITE[2] + (target[2] - WHITE[2]) * k);
  return `rgb(${r},${g},${b})`;
}

export class SpeedGraph {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly speeds: Float32Array; // km/h, one value per 1 / SAMPLE_RATE seconds
  private readonly slopes: Float32Array; // road slope, same sampling
  private readonly heights: Float32Array; // road height, same sampling
  private readonly lo: number;
  private readonly hi: number;
  private readonly durationS: number;

  constructor(canvas: HTMLCanvasElement, path: TrackPath, durationS: number) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.durationS = durationS;
    const n = Math.max(2, Math.ceil(durationS * SAMPLE_RATE) + 1);
    const h = 0.25; // seconds; distanceAt is piecewise linear, so a short difference is the local speed
    this.speeds = new Float32Array(n);
    this.slopes = new Float32Array(n);
    this.heights = new Float32Array(n);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      this.slopes[i] = path.slopeAt(t);
      this.speeds[i] = ((path.distanceAt(t + h) - path.distanceAt(t)) / h) * KMH;
      const y = path.heightAt(t);
      this.heights[i] = y;
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    const pad = Math.max(1, (hi - lo) * 0.1);
    this.lo = lo - pad;
    this.hi = hi + pad;
  }

  private lerp(table: Float32Array, t: number): number {
    const p = Math.min(Math.max(t * SAMPLE_RATE, 0), table.length - 1);
    const i = Math.floor(p);
    const j = Math.min(i + 1, table.length - 1);
    return table[i]! + (table[j]! - table[i]!) * (p - i);
  }

  /** Redraws the profile for track time t (seconds). */
  draw(t: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padX = 6, padTop = 16, padBottom = 6;
    const plotW = w - padX * 2, plotH = h - padTop - padBottom;
    const dur = Math.max(this.durationS, 1e-6);
    const xOfT = (tt: number) => padX + (tt / dur) * plotW;
    const yOf = (v: number) => padTop + (1 - (v - this.lo) / (this.hi - this.lo)) * plotH;
    const tOf = (x: number) => ((x - padX) / plotW) * dur;
    const endX = padX + plotW;

    // Soft fill under the whole profile.
    ctx.beginPath();
    for (let x = padX; x <= endX; x += 1) {
      const y = yOf(this.lerp(this.heights, tOf(x)));
      if (x === padX) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineTo(endX, h - padBottom);
    ctx.lineTo(padX, h - padBottom);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fill();

    // Line, one short piece per pixel column, colored by the road slope there. Already-played part is dimmed.
    const nowX = xOfT(Math.min(Math.max(t, 0), dur));
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    let prevX = padX, prevY = yOf(this.lerp(this.heights, 0));
    for (let x = padX + 1; x <= endX; x += 1) {
      const tt = tOf(x);
      const y = yOf(this.lerp(this.heights, tt));
      ctx.beginPath();
      ctx.moveTo(prevX, prevY);
      ctx.lineTo(x, y);
      ctx.globalAlpha = x <= nowX ? 0.45 : 1;
      ctx.strokeStyle = slopeColor(this.lerp(this.slopes, tt));
      ctx.stroke();
      prevX = x;
      prevY = y;
    }
    ctx.globalAlpha = 1;

    // Dot at the current instant (same color as the line there) and the speed readout.
    const dotColor = slopeColor(this.lerp(this.slopes, t));
    ctx.beginPath();
    ctx.arc(nowX, yOf(this.lerp(this.heights, t)), 4, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.shadowColor = dotColor;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(244,233,255,0.9)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(this.lerp(this.speeds, t))} km/h`, w - padX, 11);
  }
}
