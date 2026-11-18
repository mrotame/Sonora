// Voxel Dreamscape: light levels of a block volume (pure, no Three.js, no DOM). Runs in the Worker.
// Same model as a block game: two channels of 0..15 per cell.
// - Sky light: 15 straight down from the open sky (leaves and water dim it by 1 per block, opaque blocks stop it), then
//   it spreads to the neighbours losing 1 per block, so overhangs and tunnels darken gradually.
// - Block light: emitters (glowstone, lava, portals...) start at their level and spread the same way; walls stop it.
// Light never changes over time: it is baked once per volume.
import { LIGHT_EMIT, LIGHT_OPACITY } from './blocks.ts';
import type { Volume } from './mesher.ts';

export const LIGHT_LEVELS = 15;
/**
 * Farthest a cell can be from the light that reaches it (blocks). A volume built with this many extra rows on each side
 * of the rows it meshes lights them exactly as its neighbours do, so no seam shows between segments.
 */
export const LIGHT_REACH = 15;

export interface LightField {
  sky: Uint8Array;
  block: Uint8Array;
}

export function computeLight(vol: Volume, skyLit: boolean): LightField {
  const { data, sx, sy, sz } = vol;
  const n = data.length, layer = sx * sz;
  const sky = new Uint8Array(n), block = new Uint8Array(n);
  // Ring queue; a cell is never queued twice at once, so n slots are enough.
  const queue = new Int32Array(n);
  const queued = new Uint8Array(n);
  let head = 0, tail = 0, size = 0;
  const push = (i: number) => {
    if (queued[i]) return;
    queued[i] = 1;
    queue[tail] = i;
    tail = tail + 1 === n ? 0 : tail + 1;
    size++;
  };
  const visit = (lv: Uint8Array, j: number, level: number) => {
    const op = LIGHT_OPACITY[data[j]!]!;
    if (op >= LIGHT_LEVELS) return;
    const next = level - (op > 1 ? op : 1);
    if (next > lv[j]!) {
      lv[j] = next;
      push(j);
    }
  };
  const spread = (lv: Uint8Array) => {
    while (size > 0) {
      const i = queue[head]!;
      head = head + 1 === n ? 0 : head + 1;
      size--;
      queued[i] = 0;
      const level = lv[i]!;
      if (level <= 1) continue;
      const x = i % sx, z = Math.floor(i / sx) % sz, y = Math.floor(i / layer);
      if (x > 0) visit(lv, i - 1, level);
      if (x < sx - 1) visit(lv, i + 1, level);
      if (z > 0) visit(lv, i - sx, level);
      if (z < sz - 1) visit(lv, i + sx, level);
      if (y > 0) visit(lv, i - layer, level);
      if (y < sy - 1) visit(lv, i + layer, level);
    }
  };

  if (skyLit) {
    // Straight down from the top of the volume. `dark[c]` = highest layer of column c below full sky light (-1: none).
    const dark = new Int16Array(layer).fill(-1);
    for (let c = 0; c < layer; c++) {
      let level = LIGHT_LEVELS;
      for (let y = sy - 1; y >= 0; y--) {
        const i = c + y * layer;
        const op = LIGHT_OPACITY[data[i]!]!;
        level = op >= LIGHT_LEVELS ? 0 : Math.max(0, level - op);
        if (level < LIGHT_LEVELS && dark[c]! < 0) dark[c] = y;
        if (level === 0) break;
        sky[i] = level;
        if (level < LIGHT_LEVELS && level > 1) push(i); // under leaves or water: spreads sideways too
      }
    }
    // Sideways spread starts only where a fully lit cell touches a darker column.
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const c = x + z * sx, own = dark[c]!;
        let reach = own;
        if (x > 0) reach = Math.max(reach, dark[c - 1]!);
        if (x < sx - 1) reach = Math.max(reach, dark[c + 1]!);
        if (z > 0) reach = Math.max(reach, dark[c - sx]!);
        if (z < sz - 1) reach = Math.max(reach, dark[c + sx]!);
        for (let y = own + 1; y <= reach; y++) push(c + y * layer);
      }
    }
    spread(sky);
  }

  for (let i = 0; i < n; i++) {
    const e = LIGHT_EMIT[data[i]!]!;
    if (e > 0) block[i] = e;
  }
  // Only emitters with a neighbour that can still take light start the spread (the inside of a lava sea is skipped).
  const seed = (i: number) => {
    const e = block[i]!;
    if (e <= 1) return;
    const takes = (j: number) => LIGHT_OPACITY[data[j]!]! < LIGHT_LEVELS && block[j]! < e - 1;
    const x = i % sx, z = Math.floor(i / sx) % sz, y = Math.floor(i / layer);
    if ((x > 0 && takes(i - 1)) || (x < sx - 1 && takes(i + 1)) || (z > 0 && takes(i - sx)) || (z < sz - 1 && takes(i + sx)) || (y > 0 && takes(i - layer)) || (y < sy - 1 && takes(i + layer))) push(i);
  };
  for (let i = 0; i < n; i++) seed(i);
  spread(block);
  return { sky, block };
}
