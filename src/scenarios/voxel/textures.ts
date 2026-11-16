// Voxel Dreamscape block textures: unmodified textures from the Faithful 32x resource pack
// (https://faithfulpack.net, license in ./textures/LICENSE.txt). They are packed at load time into one
// DataArrayTexture (one layer per texture or animation frame, in the order of LAYER_SOURCES in blocks.ts), so every
// voxel shader needs a single sampler and picks its layer per fragment. Pixels stay sharp up close (nearest
// magnification) and blend in the distance (mipmaps). Sources wider than 32 px (sun, moon) are scaled down to 32.
import * as THREE from 'three';
import { LAYER, LAYER_COUNT, LAYER_SOURCES, type LayerName } from './blocks.ts';
import grassTopUrl from './textures/grass_block_top.png';
import grassSideUrl from './textures/grass_block_side.png';
import dirtUrl from './textures/dirt.png';
import stoneUrl from './textures/stone.png';
import cobblestoneUrl from './textures/cobblestone.png';
import sandUrl from './textures/sand.png';
import gravelUrl from './textures/gravel.png';
import coalOreUrl from './textures/coal_ore.png';
import ironOreUrl from './textures/iron_ore.png';
import oakLogUrl from './textures/oak_log.png';
import oakLogTopUrl from './textures/oak_log_top.png';
import oakLeavesUrl from './textures/oak_leaves.png';
import oakPlanksUrl from './textures/oak_planks.png';
import birchLogUrl from './textures/birch_log.png';
import birchLogTopUrl from './textures/birch_log_top.png';
import birchLeavesUrl from './textures/birch_leaves.png';
import glowstoneUrl from './textures/glowstone.png';
import obsidianUrl from './textures/obsidian.png';
import cryingObsidianUrl from './textures/crying_obsidian.png';
import amethystUrl from './textures/amethyst_block.png';
import purpurUrl from './textures/purpur_block.png';
import netherrackUrl from './textures/netherrack.png';
import netherBricksUrl from './textures/nether_bricks.png';
import soulSandUrl from './textures/soul_sand.png';
import quartzOreUrl from './textures/nether_quartz_ore.png';
import shortGrassUrl from './textures/short_grass.png';
import dandelionUrl from './textures/dandelion.png';
import poppyUrl from './textures/poppy.png';
import sugarCaneUrl from './textures/sugar_cane.png';
import railUrl from './textures/rail.png';
import poweredRailUrl from './textures/powered_rail.png';
import sunUrl from './textures/sun.png';
import moonUrl from './textures/moon.png';
import magmaUrl from './textures/magma.png';
import lavaUrl from './textures/lava_still.png';
import waterUrl from './textures/water_still.png';
import portalUrl from './textures/nether_portal.png';

export { LAYER };
export const PORTAL_FRAMES = 32;
export const WATER_FRAMES = 32;
export const LAVA_FRAMES = 20;
export const MAGMA_FRAMES = 3;

const SIZE = 32;

const URLS: Record<LayerName, string> = {
  grassTop: grassTopUrl, grassSide: grassSideUrl, dirt: dirtUrl, stone: stoneUrl, cobblestone: cobblestoneUrl,
  sand: sandUrl, gravel: gravelUrl, coalOre: coalOreUrl, ironOre: ironOreUrl, oakLog: oakLogUrl, oakLogTop: oakLogTopUrl,
  oakLeaves: oakLeavesUrl, oakPlanks: oakPlanksUrl, birchLog: birchLogUrl, birchLogTop: birchLogTopUrl,
  birchLeaves: birchLeavesUrl, glowstone: glowstoneUrl, obsidian: obsidianUrl, cryingObsidian: cryingObsidianUrl,
  amethyst: amethystUrl, purpur: purpurUrl, netherrack: netherrackUrl, netherBricks: netherBricksUrl, soulSand: soulSandUrl,
  quartzOre: quartzOreUrl, shortGrass: shortGrassUrl, dandelion: dandelionUrl, poppy: poppyUrl, sugarCane: sugarCaneUrl,
  rail: railUrl, poweredRail: poweredRailUrl, sun: sunUrl, moon: moonUrl, magma: magmaUrl, lava: lavaUrl, water: waterUrl,
  portal: portalUrl,
};

/** GLSL: the atlas sampler, layer constants (L_SNAKE_CASE), a sampler with explicit gradients, and the biome tints. */
export const ATLAS_GLSL = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2DArray uAtlas;
  ${Object.entries(LAYER).map(([k, v]) => `const float L_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()} = ${v.toFixed(1)};`).join('\n  ')}
  // Gray textures that the game tints by biome (plains grass and oak / birch foliage).
  const vec3 GRASS_TINT = vec3(0.569, 0.741, 0.349);
  const vec3 FOLIAGE_TINT = vec3(0.467, 0.671, 0.184);
  const vec3 BIRCH_TINT = vec3(0.502, 0.655, 0.333);

  // uv in tiles (unwrapped); the gradients come from the unwrapped uv so tile borders do not break mip selection.
  vec4 atlas(vec2 uv, float layer, vec2 dx, vec2 dy) {
    return textureGrad(uAtlas, vec3(fract(uv), layer), dx, dy);
  }
`;

/** Pixels of a source scaled to SIZE px wide (a vertical strip keeps its frames). */
async function loadPixels(url: string): Promise<{ data: Uint8ClampedArray; height: number }> {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const height = Math.round((bitmap.height * SIZE) / bitmap.width);
  const canvas = new OffscreenCanvas(SIZE, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, SIZE, height);
  bitmap.close();
  return { data: ctx.getImageData(0, 0, SIZE, height).data, height };
}

export class VoxelAtlas {
  readonly texture: THREE.DataArrayTexture;
  readonly loaded: Promise<void>;

  constructor() {
    const data = new Uint8Array(SIZE * SIZE * 4 * LAYER_COUNT);
    this.texture = new THREE.DataArrayTexture(data, SIZE, SIZE, LAYER_COUNT);
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
    const images = await Promise.all(LAYER_SOURCES.map(([name]) => loadPixels(URLS[name])));
    let layer = 0;
    LAYER_SOURCES.forEach(([name, frames], i) => {
      const { data, height } = images[i]!;
      if (height < frames * SIZE) throw new Error(`voxel texture ${name}: expected ${frames} frames`);
      for (let f = 0; f < frames; f++, layer++) {
        // Rows are flipped so that v = 1 is the top of the image (the grass edge of grass_block_side is at the top).
        for (let y = 0; y < SIZE; y++) {
          const src = (f * SIZE + (SIZE - 1 - y)) * SIZE * 4;
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
