// Voxel Dreamscape: tileable 3D noise for the volumetric clouds (pure, no Three.js, no DOM).
// Two channels per voxel, both periodic over the cube so the texture repeats without seams:
// - r: "Perlin-Worley" (gradient-noise fbm eroded by inverted cellular noise): the billowy cloud shape.
// - g: inverted cellular-noise fbm at higher frequencies: the detail that erodes the shape's edges.
// Integer hashes with a fixed salt, no Math.random: the texture is identical in every run.

export const CLOUD_NOISE_SIZE = 64;

function hash(x: number, y: number, z: number, salt: number): number {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f) ^ Math.imul(salt, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const wrap = (i: number, n: number) => ((i % n) + n) % n;
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** The 12 edge directions of a cube: gradients of the Perlin noise. */
const GRAD = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1],
  [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
] as const;

/** Gradient noise of period `p` lattice cells, at a point of [0, 1)^3. About -1..1. */
function perlin(x: number, y: number, z: number, p: number, salt: number): number {
  x *= p; y *= p; z *= p;
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const dot = (cx: number, cy: number, cz: number) => {
    const g = GRAD[Math.floor(hash(wrap(ix + cx, p), wrap(iy + cy, p), wrap(iz + cz, p), salt) * 12)]!;
    return g[0] * (fx - cx) + g[1] * (fy - cy) + g[2] * (fz - cz);
  };
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(dot(0, 0, 0), dot(1, 0, 0), u), lerp(dot(0, 1, 0), dot(1, 1, 0), u), v),
    lerp(lerp(dot(0, 0, 1), dot(1, 0, 1), u), lerp(dot(0, 1, 1), dot(1, 1, 1), u), v),
    w,
  );
}

/** Feature points of a periodic cellular grid of `c` cells per side (one point per cell). */
function featurePoints(c: number, salt: number): Float32Array {
  const pts = new Float32Array(c * c * c * 3);
  for (let z = 0; z < c; z++) for (let y = 0; y < c; y++) for (let x = 0; x < c; x++) {
    const i = (x + c * (y + c * z)) * 3;
    pts[i] = hash(x, y, z, salt);
    pts[i + 1] = hash(x, y, z, salt + 1);
    pts[i + 2] = hash(x, y, z, salt + 2);
  }
  return pts;
}

/** Distance to the nearest feature point, in cells (0 at a point, about 1 at most), periodic. */
function worley(x: number, y: number, z: number, c: number, pts: Float32Array): number {
  x *= c; y *= c; z *= c;
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let best = 9;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy, cz = iz + dz;
    const i = (wrap(cx, c) + c * (wrap(cy, c) + c * wrap(cz, c))) * 3;
    const ex = cx + pts[i]! - x, ey = cy + pts[i + 1]! - y, ez = cz + pts[i + 2]! - z;
    const d = ex * ex + ey * ey + ez * ez;
    if (d < best) best = d;
  }
  return Math.min(1, Math.sqrt(best));
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const remap = (v: number, lo: number, hi: number) => clamp01((v - lo) / (hi - lo));

/** RG bytes of a `size`^3 periodic volume (x fastest, then y, then z), ready for a 3D texture. */
export function buildCloudNoise(size = CLOUD_NOISE_SIZE): Uint8Array {
  const n = size * size * size;
  const raw = new Float32Array(n * 2);
  const w4 = featurePoints(4, 11), w8 = featurePoints(8, 23), w16 = featurePoints(16, 37), w32 = featurePoints(32, 53);
  for (let k = 0; k < size; k++) for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = i / size, y = j / size, z = k / size;
    const p = 0.5 + 0.5 * (perlin(x, y, z, 4, 3) * 0.6 + perlin(x, y, z, 8, 5) * 0.3 + perlin(x, y, z, 16, 7) * 0.15);
    const cells = 1 - (worley(x, y, z, 4, w4) * 0.625 + worley(x, y, z, 8, w8) * 0.25 + worley(x, y, z, 16, w16) * 0.125);
    // Perlin-Worley: the gradient noise gives the large forms, the cellular noise rounds them into billows.
    const o = (i + size * (j + size * k)) * 2;
    raw[o] = remap(p, -(1 - cells) * 0.9, 1);
    raw[o + 1] = 1 - (worley(x, y, z, 8, w8) * 0.625 + worley(x, y, z, 16, w16) * 0.25 + worley(x, y, z, 32, w32) * 0.125);
  }
  // Stretch each channel to the full byte range (1st..99th percentile), so the shader's coverage threshold spans 0..1.
  const out = new Uint8Array(n * 2);
  for (let c = 0; c < 2; c++) {
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) values[i] = raw[i * 2 + c]!;
    values.sort();
    const lo = values[Math.floor(n * 0.01)]!, hi = values[Math.floor(n * 0.99)]!;
    for (let i = 0; i < n; i++) out[i * 2 + c] = Math.round(remap(raw[i * 2 + c]!, lo, hi) * 255);
  }
  return out;
}
