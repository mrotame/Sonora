// World identity and deterministic seeding (TECHNICAL_ARCHITECTURE 7.1 and 7.3).
// Pure and DOM-free so it runs in the Worker, the main thread and Node tests.
// No ambient randomness: every value derives from the world seed and a named path.

/** Bump when a change to generation rules alters output (7.3). */
export const GENERATION_VERSION = 1;

/** 128-bit seed as four uint32 words. */
export type Seed = readonly [number, number, number, number];

// cyrb128 string hash (public domain).
function hashString(str: string): Seed {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const x = h1 ^ h2 ^ h3 ^ h4;
  return [(x ^ h1) >>> 0, (x ^ h2) >>> 0, (x ^ h3) >>> 0, (x ^ h4) >>> 0];
}

export interface WorldIdentity {
  /** SHA-256 hex of the delivered file bytes (ADR 0009). */
  audioIdentity: string;
  scenarioId: string;
  scenarioVersion: number;
}

/** world_seed = HASH(audio_identity + scenario_id + scenario_version + generation_version). */
export function createWorldSeed(id: WorldIdentity, generationVersion = GENERATION_VERSION): Seed {
  return hashString(`world|${id.audioIdentity}|${id.scenarioId}|${id.scenarioVersion}|${generationVersion}`);
}

/** Derives an independent sub-seed from a named, indexed path, e.g. ('segment', 12, 'terrain'). */
export function deriveSeed(seed: Seed, ...path: (string | number)[]): Seed {
  const parts = path.map((p) => {
    if (typeof p === 'number') {
      if (!Number.isInteger(p)) throw new Error('path indices must be integers');
      return `#${p}`;
    }
    if (p.includes('/')) throw new Error('path names must not contain "/"');
    return p;
  });
  return hashString(`${seed.join('.')}|${parts.join('/')}`);
}

/** Small seeded PRNG (sfc32) for scopes that need a sequence. Returns floats in [0, 1). */
export function createRng(seed: Seed): () => number {
  let [a, b, c, d] = seed;
  // Warm-up discards the weak first outputs of sfc32.
  const next = (): number => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

/** Stateless index-addressed value in [0, 1): any element n can be evaluated directly at any time. */
export function rand(seed: Seed, n: number): number {
  let h = (seed[0] + Math.imul(n | 0, 0x9e3779b1)) | 0;
  h ^= seed[1];
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ seed[2], 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h ^ seed[3], 0x165667b1);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Stateless 2D value in [0, 1) for world-space lattices. */
export function rand2(seed: Seed, x: number, z: number): number {
  return rand(seed, Math.imul(x | 0, 0x1b873593) ^ Math.imul(z | 0, 0x2545f491));
}
