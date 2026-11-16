// Voxel Dreamscape: seeded gradient noise (pure, no Three.js, no DOM). Values are pure functions of a 32-bit salt
// derived from the world seed and of world-space coordinates, so any column can be evaluated in any segment.
import { rand, type Seed } from '../../world/identity/seed.ts';

/** 32-bit salt of a seed for the inline hashes below. */
export const saltOf = (seed: Seed): number => (rand(seed, 0x51ed) * 4294967296) | 0;

/** Integer hash of a lattice point (3 ints + salt) to a 32-bit value. */
export function hash3i(salt: number, x: number, y: number, z: number): number {
  let h = salt ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash of a lattice point to [0, 1). */
export const hash01 = (salt: number, x: number, y: number, z = 0): number => hash3i(salt, x, y, z) / 4294967296;

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

function grad2(h: number, x: number, z: number): number {
  switch (h & 7) {
    case 0: return x + z;
    case 1: return x - z;
    case 2: return -x + z;
    case 3: return -x - z;
    case 4: return x;
    case 5: return -x;
    case 6: return z;
    default: return -z;
  }
}

/** 2D Perlin noise, about -1..1. */
export function perlin2(salt: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fade(fx), v = fade(fz);
  const a = grad2(hash3i(salt, ix, 0, iz), fx, fz);
  const b = grad2(hash3i(salt, ix + 1, 0, iz), fx - 1, fz);
  const c = grad2(hash3i(salt, ix, 0, iz + 1), fx, fz - 1);
  const d = grad2(hash3i(salt, ix + 1, 0, iz + 1), fx - 1, fz - 1);
  const ab = a + (b - a) * u, cd = c + (d - c) * u;
  return (ab + (cd - ab) * v) * 0.9;
}

function grad3(h: number, x: number, y: number, z: number): number {
  const g = h % 12;
  const u = g < 8 ? x : y, v = g < 4 ? y : g === 12 || g === 14 ? x : z;
  return ((g & 1) === 0 ? u : -u) + ((g & 2) === 0 ? v : -v);
}

/** 3D Perlin noise, about -1..1. */
export function perlin3(salt: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const g = (dx: number, dy: number, dz: number) => grad3(hash3i(salt, ix + dx, iy + dy, iz + dz), fx - dx, fy - dy, fz - dz);
  const x00 = g(0, 0, 0) + (g(1, 0, 0) - g(0, 0, 0)) * u;
  const x10 = g(0, 1, 0) + (g(1, 1, 0) - g(0, 1, 0)) * u;
  const x01 = g(0, 0, 1) + (g(1, 0, 1) - g(0, 0, 1)) * u;
  const x11 = g(0, 1, 1) + (g(1, 1, 1) - g(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

/** Fractal sum of 2D Perlin octaves, about -1..1. */
export function fbm2(salt: number, x: number, z: number, octaves: number): number {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * perlin2(salt + o * 1013, x * f, z * f);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
