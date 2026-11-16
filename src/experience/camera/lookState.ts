// Camera look offset (TECHNICAL_ARCHITECTURE 11): accumulated from input,
// clamped independently per axis (+-65 degrees horizontal, 55 degrees up and
// 30 degrees down), and slowly returning to the forward direction when input
// stops. Pure logic; no DOM.

const DEG = Math.PI / 180;
export const YAW_LIMIT_RAD = 65 * DEG;
export const PITCH_UP_LIMIT_RAD = 55 * DEG;
export const PITCH_DOWN_LIMIT_RAD = 30 * DEG;

export interface LookTuning {
  /** Radians of look per pixel of pointer movement (initial value, to tune in the prototype). */
  sensitivity: number;
  /** Seconds without input before the offset starts returning to center. */
  idleDelayS: number;
  /** Exponential return rate per second. */
  returnRate: number;
}

export const DEFAULT_LOOK_TUNING: LookTuning = { sensitivity: 0.00165, idleDelayS: 0.8, returnRate: 1.2 };

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export class LookState {
  /** Positive yaw looks right; positive pitch looks up. */
  yaw = 0;
  pitch = 0;
  private lastInputS = -Infinity;

  private readonly tuning: LookTuning;

  constructor(tuning: LookTuning = DEFAULT_LOOK_TUNING) {
    this.tuning = tuning;
  }

  /** dx > 0 moves the pointer right, dy > 0 moves it down (screen coordinates). */
  addInput(dx: number, dy: number, nowS: number): void {
    this.yaw = clamp(this.yaw + dx * this.tuning.sensitivity, -YAW_LIMIT_RAD, YAW_LIMIT_RAD);
    this.pitch = clamp(this.pitch - dy * this.tuning.sensitivity, -PITCH_DOWN_LIMIT_RAD, PITCH_UP_LIMIT_RAD);
    this.lastInputS = nowS;
  }

  update(dtS: number, nowS: number): void {
    if (nowS - this.lastInputS < this.tuning.idleDelayS) return;
    const k = Math.exp(-this.tuning.returnRate * dtS);
    this.yaw *= k;
    this.pitch *= k;
    if (Math.abs(this.yaw) < 1e-5) this.yaw = 0;
    if (Math.abs(this.pitch) < 1e-5) this.pitch = 0;
  }
}
