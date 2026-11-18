// Voxel Dreamscape: atmosphere state by hour of the day (pure, no Three.js, no DOM). One source for the sky, the
// clouds, the fog and the block lighting: sky colours, sun direction, the colour of the light that falls on the world
// (sun by day, moon by night) and the ambient light of the sky dome. A pure function of the hour, which is itself
// baked in the segments, so the whole atmosphere is time-addressable.
// The keys are authored as display colours (what the eye sees on screen); `atmosphereAt` returns linear values, the
// space the HDR pipeline lights, fogs and tone-maps in (the final pass encodes back to display).

export type RGB = [number, number, number];

/** Sky colours by hour of the day (display space): horizon (also the fog colour) and zenith. Linear blends between keys. */
export const SKY_KEYS: { hour: number; horizon: RGB; zenith: RGB }[] = [
  { hour: 0, horizon: [0.07, 0.09, 0.17], zenith: [0.025, 0.035, 0.09] },
  { hour: 5, horizon: [0.09, 0.1, 0.2], zenith: [0.03, 0.04, 0.11] },
  { hour: 6.3, horizon: [0.95, 0.6, 0.45], zenith: [0.25, 0.34, 0.66] },
  { hour: 7.5, horizon: [0.8, 0.84, 0.92], zenith: [0.3, 0.5, 0.92] },
  { hour: 9, horizon: [0.72, 0.84, 1.0], zenith: [0.28, 0.5, 0.97] },
  { hour: 16, horizon: [0.72, 0.84, 1.0], zenith: [0.28, 0.5, 0.97] },
  { hour: 18, horizon: [0.98, 0.66, 0.42], zenith: [0.32, 0.4, 0.8] },
  { hour: 19.2, horizon: [0.62, 0.32, 0.35], zenith: [0.16, 0.16, 0.38] },
  { hour: 20.5, horizon: [0.12, 0.11, 0.21], zenith: [0.04, 0.045, 0.12] },
  { hour: 24, horizon: [0.07, 0.09, 0.17], zenith: [0.025, 0.035, 0.09] },
];

/** Linear colours: warm band of a low sun, light of a high sun, of a low (golden) sun, and of the moon. */
export const SUNSET_COLOR: RGB = [1.0, 0.3, 0.08];
const SUN_HIGH: RGB = [1.25, 1.12, 0.95];
const SUN_LOW: RGB = [1.15, 0.48, 0.16];
const MOON: RGB = [0.07, 0.09, 0.15];
/** Ambient (linear) never drops below this at night, so the world stays readable under the moon. */
const NIGHT_AMBIENT: RGB = [0.014, 0.018, 0.034];
/** Share of the sky colour that reaches the blocks as ambient light, and how much of its saturation it keeps. */
const AMBIENT_SCALE = 0.9;
const AMBIENT_SATURATION = 0.55;

export interface Atmosphere {
  /** Linear sky colours at the horizon (also the fog colour) and at the zenith. */
  horizon: RGB;
  zenith: RGB;
  /** Unit vector toward the sun (world space: x right, y up, -z the travel direction). */
  sunDir: RGB;
  /** Unit vector toward the light that falls on the world: the sun while it is up, else the moon (opposite the sun). */
  lightDir: RGB;
  /** Colour and intensity of that light: 0 while the light is under the horizon, so the swap sun / moon is invisible. */
  lightColor: RGB;
  /** The sun's own light (0 once it has set): sun glare in the sky, light shafts, silver lining of the clouds. */
  sunColor: RGB;
  /** Ambient light from the upper and lower half of the sky dome. */
  ambientUp: RGB;
  ambientDown: RGB;
  /** 1 day .. 0 night (stars). */
  day: number;
  /** 0..1, strongest with the sun at the horizon (sunset band, warm glare). */
  sunset: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale3 = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
/** Display colour to linear (gamma 2.2, the encoding the final pass undoes). */
export const toLinear = (c: RGB): RGB => [c[0] ** 2.2, c[1] ** 2.2, c[2] ** 2.2];

/** Sun direction at an hour: it crosses the sky from east to west, tilted toward the travel direction (sunrise and sunset in view). */
export function sunDirAt(hour: number): RGB {
  const a = ((hour - 6) / 24) * Math.PI * 2;
  const x = -Math.cos(a) * 0.55, y = Math.sin(a), z = -Math.cos(a) * 0.83 - 0.25;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

export function atmosphereAt(hour: number): Atmosphere {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < SKY_KEYS.length - 2 && h > SKY_KEYS[i + 1]!.hour) i++;
  const a = SKY_KEYS[i]!, b = SKY_KEYS[i + 1]!;
  const f = clamp01((h - a.hour) / (b.hour - a.hour));
  const horizonD = mix3(a.horizon, b.horizon, f), zenithD = mix3(a.zenith, b.zenith, f);
  // Daylight: 1 from 7.5 to 17, 0 from 20 to 5.
  const day = clamp01(h < 12 ? (h - 5.5) / 2.2 : (20.2 - h) / 2.6);
  const sunDir = sunDirAt(h);
  const sy = sunDir[1];
  // Sun and moon fade out before they cross the horizon, so the light source can swap while both are at 0.
  const sunUp = smooth(0, 0.12, sy), moonUp = smooth(0.02, 0.2, -sy);
  const sunIsLight = sy > 0;
  const lightDir: RGB = sunIsLight ? sunDir : [-sunDir[0], -sunDir[1], -sunDir[2]];
  const sunColor = scale3(mix3(SUN_LOW, SUN_HIGH, smooth(0.04, 0.45, sy)), sunUp);
  const lightColor: RGB = sunIsLight ? sunColor : scale3(MOON, moonUp);
  // Ambient: the sky colour, half desaturated (a fully blue fill reads as a colour cast on the blocks).
  const amb = (c: RGB): RGB => {
    const l = 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2];
    const d = scale3(toLinear(mix3([l, l, l], c, AMBIENT_SATURATION)), AMBIENT_SCALE);
    return [Math.max(NIGHT_AMBIENT[0], d[0]), Math.max(NIGHT_AMBIENT[1], d[1]), Math.max(NIGHT_AMBIENT[2], d[2])];
  };
  const sunset = Math.exp(-((sy - 0.03) * (sy - 0.03)) / (0.16 * 0.16));
  return {
    horizon: toLinear(horizonD),
    zenith: toLinear(zenithD),
    sunDir,
    lightDir,
    lightColor,
    sunColor,
    ambientUp: amb(zenithD),
    ambientDown: amb(mix3(horizonD, zenithD, 0.5)),
    day,
    sunset,
  };
}
