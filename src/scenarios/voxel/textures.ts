// Voxel Dreamscape block textures: unmodified 32x32 textures from the Faithful 32x resource pack
// (https://faithfulpack.net, license in ./textures/LICENSE.txt). They are packed at load time into one
// DataArrayTexture (one layer per texture or animation frame), so every voxel shader needs a single sampler and picks
// its layer per fragment. Pixels stay sharp up close (nearest magnification) and blend in the distance (mipmaps).
import * as THREE from 'three';
import grassTopUrl from './textures/grass_block_top.png';
import grassSideUrl from './textures/grass_block_side.png';
import dirtUrl from './textures/dirt.png';
import stoneUrl from './textures/stone.png';
import deepslateUrl from './textures/deepslate.png';
import oakLogUrl from './textures/oak_log.png';
import oakLeavesUrl from './textures/oak_leaves.png';
import cherryLeavesUrl from './textures/cherry_leaves.png';
import amethystUrl from './textures/amethyst_block.png';
import cryingObsidianUrl from './textures/crying_obsidian.png';
import purpurUrl from './textures/purpur_block.png';
import glowstoneUrl from './textures/glowstone.png';
import prismarineUrl from './textures/prismarine.png';
import netherPortalUrl from './textures/nether_portal.png';

const SIZE = 32;

/** Source files in layer order; `frames` > 1 for vertical animation strips (each frame becomes one layer). */
const SOURCES = [
  { url: grassTopUrl, frames: 1 },
  { url: grassSideUrl, frames: 1 },
  { url: dirtUrl, frames: 1 },
  { url: stoneUrl, frames: 1 },
  { url: deepslateUrl, frames: 1 },
  { url: oakLogUrl, frames: 1 },
  { url: oakLeavesUrl, frames: 1 },
  { url: cherryLeavesUrl, frames: 1 },
  { url: amethystUrl, frames: 1 },
  { url: cryingObsidianUrl, frames: 1 },
  { url: purpurUrl, frames: 1 },
  { url: glowstoneUrl, frames: 1 },
  { url: prismarineUrl, frames: 1 }, // first frame of its 4-frame strip
  { url: netherPortalUrl, frames: 32 },
] as const;

/** Layer index of each texture (GLSL constants are generated from this). */
export const LAYER = {
  grassTop: 0, grassSide: 1, dirt: 2, stone: 3, deepslate: 4, oakLog: 5, oakLeaves: 6, cherryLeaves: 7,
  amethyst: 8, cryingObsidian: 9, purpur: 10, glowstone: 11, prismarine: 12, portal: 13,
} as const;
export const PORTAL_FRAMES = 32;
const LAYERS = SOURCES.reduce((n, s) => n + s.frames, 0);

/** GLSL: the atlas sampler, layer constants, a sampler with explicit gradients, and the Minecraft biome tints. */
export const ATLAS_GLSL = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2DArray uAtlas;
  ${Object.entries(LAYER).map(([k, v]) => `const float L_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()} =${v.toFixed(1)};`).join('\n  ')}
  // Gray textures that the game tints by biome (plains grass and oak foliage).
  const vec3 GRASS_TINT = vec3(0.569, 0.741, 0.349);
  const vec3 FOLIAGE_TINT = vec3(0.467, 0.671, 0.184);

  // uv in tiles (unwrapped); the gradients come from the unwrapped uv so tile borders do not break mip selection.
  vec4 atlas(vec2 uv, float layer, vec2 dx, vec2 dy) {
    return textureGrad(uAtlas, vec3(fract(uv), layer), dx, dy);
  }
`;

async function loadPixels(url: string): Promise<{ data: Uint8ClampedArray; height: number }> {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, height: canvas.height };
}

export class VoxelAtlas {
  readonly texture: THREE.DataArrayTexture;
  readonly loaded: Promise<void>;

  constructor() {
    const data = new Uint8Array(SIZE * SIZE * 4 * LAYERS);
    this.texture = new THREE.DataArrayTexture(data, SIZE, SIZE, LAYERS);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.anisotropy = 8;
    // Colours stay in the same (display) space the shaders author their colours in.
    this.texture.colorSpace = THREE.NoColorSpace;
    this.loaded = this.load(data);
  }

  private async load(target: Uint8Array): Promise<void> {
    const images = await Promise.all(SOURCES.map((s) => loadPixels(s.url)));
    let layer = 0;
    SOURCES.forEach((source, i) => {
      const { data, height } = images[i]!;
      if (height < source.frames * SIZE) throw new Error(`voxel texture ${source.url}: expected ${source.frames} frames`);
      for (let f = 0; f < source.frames; f++, layer++) {
        // Rows are flipped so that v = 1 is the top of the image (the grass edge of grass_block_side is at the top).
        for (let y = 0; y < SIZE; y++) {
          const src = ((f * SIZE) + (SIZE - 1 - y)) * SIZE * 4;
          target.set(data.subarray(src, src + SIZE * 4), (layer * SIZE + y) * SIZE * 4);
        }
      }
    });
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
