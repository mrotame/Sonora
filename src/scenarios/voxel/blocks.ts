// Voxel Dreamscape: block ids, shapes and texture layers (pure, no Three.js, no DOM). Shared by the Worker (mesher)
// and the scene (atlas layout and shader constants). One block = 1 m. Block column bx covers x in [bx - 0.5, bx + 0.5]
// (the road is centred on x = 0), block row bd covers d in [bd, bd + 1], block layer by covers y in [by, by + 1].

/** Atlas layers in order: name and number of animation frames (each frame is one layer). */
export const LAYER_SOURCES = [
  ['grassTop', 1], ['grassSide', 1], ['dirt', 1], ['stone', 1], ['cobblestone', 1], ['sand', 1], ['gravel', 1],
  ['coalOre', 1], ['ironOre', 1], ['oakLog', 1], ['oakLogTop', 1], ['oakLeaves', 1], ['oakPlanks', 1],
  ['birchLog', 1], ['birchLogTop', 1], ['birchLeaves', 1], ['glowstone', 1], ['obsidian', 1], ['cryingObsidian', 1],
  ['amethyst', 1], ['purpur', 1], ['netherrack', 1], ['netherBricks', 1], ['soulSand', 1], ['quartzOre', 1],
  ['shortGrass', 1], ['dandelion', 1], ['poppy', 1], ['sugarCane', 1], ['rail', 1], ['poweredRail', 1],
  ['snow', 1], ['andesite', 1], ['tuff', 1], ['coarseDirt', 1],
  ['spruceLog', 1], ['spruceLogTop', 1], ['spruceLeaves', 1], ['fern', 1], ['redstoneLampOn', 1], ['sun', 1], ['moon', 1], ['magma', 3], ['lava', 20], ['water', 32], ['portal', 32],
] as const;

export type LayerName = (typeof LAYER_SOURCES)[number][0];

/** First layer of each texture. */
export const LAYER = (() => {
  const out = {} as Record<LayerName, number>;
  let n = 0;
  for (const [name, frames] of LAYER_SOURCES) {
    out[name] = n;
    n += frames;
  }
  return out;
})();
export const LAYER_COUNT = LAYER_SOURCES.reduce((n, [, f]) => n + f, 0);

/** Block ids (Uint8 in the volumes). */
export const B = {
  air: 0,
  stone: 1, dirt: 2, grass: 3, sand: 4, gravel: 5, coalOre: 6, ironOre: 7, cobblestone: 8, oakPlanks: 9,
  oakLog: 10, oakLeaves: 11, birchLog: 12, birchLeaves: 13, glowstone: 14, obsidian: 15, cryingObsidian: 16,
  amethyst: 17, netherrack: 18, netherBricks: 19, soulSand: 20, magma: 21, quartzOre: 22,
  portal: 23, water: 24, lava: 25, snow: 26, andesite: 27, tuff: 28, coarseDirt: 29,
  shortGrass: 30, dandelion: 31, poppy: 32, sugarCane: 33, spruceLog: 34, spruceLeaves: 35, fern: 36,
  // Cave and Nether light blocks, never on the open road. Only the cave wall lamps and the Nether glowstone glow with the
  // music (see FLAG.energy); the cave ceiling glowstone and the Nether lava falls are steady.
  oakFence: 40, netherFence: 41, redstoneLamp: 42, caveLamp: 43, caveGlowstone: 44, netherGlowstone: 45, lavaFall: 46,
  // Oak stairs of the bridge arch, named by the side of the high half along the road (rows d grow ahead of the camera).
  oakStairsAhead: 47, oakStairsBehind: 48,
  rail: 50, poweredRail: 51,
} as const;

export const Shape = { None: 0, Cube: 1, Cross: 2, Fence: 3, Pane: 4, Rail: 5, Stairs: 6 } as const;
export type Shape = (typeof Shape)[keyof typeof Shape];

/** Tint of a gray texture: 0 none, 1 grass, 2 oak foliage, 3 birch foliage. */
export const Tint = { None: 0, Grass: 1, Foliage: 2, Birch: 3 } as const;

/** Per-quad material flags (packed in the vertex attributes, read by the shaders). */
export const FLAG = {
  /** Low 2 bits: tint (Tint). */
  tintMask: 3,
  /** Cutout texture: leaves fill their holes with a dark foliage colour; plants discard them. */
  cutout: 4,
  /** Light source (glowstone, magma, lava, portal): drawn at its own constant brightness, never darkened or pulsed. */
  emissive: 8,
  /** Animated strip: the layer is the first frame (portal 32, magma 3). */
  animated: 16,
  /**
   * Music-driven light source. The low 2 bits (tint, which these blocks never use) then hold its kind (BAND): 0 the portal
   * (steady, follows the energy), 1 following the bass level over its local floor (almost dark between hits, cavePulse.ts),
   * 2 the same on the mids. Only cave and Nether blocks use 1 and 2, so the open overworld is untouched.
   */
  energy: 32,
  /** Spruce foliage: the gray texture takes the game's fixed spruce green (not a biome tint). */
  spruce: 64,
} as const;

/** Kind of a music-driven block (low 2 bits of its flags when FLAG.energy is set). */
export const BAND = { none: 0, bass: 1, mid: 2 } as const;

/**
 * Reading the flags in the fragment shader. They reach it through an interpolated float varying, which is not exact:
 * 8.0 at every vertex can arrive as 7.9999995 at some pixels, so flooring it straight away drops the bit (glowstone,
 * portals and crying obsidian flickered between lit and unlit / tinted as the camera moved). The value is rounded back
 * to the integer first. `materialFlags` / `hasFlag` are the same decoding in TypeScript, for the tests.
 */
export const FLAGS_GLSL = /* glsl */ `
  float materialFlags(float interpolated) { return floor(interpolated + 0.5); }
  float flag(float flags, float bit) { return mod(floor(flags / bit), 2.0); }
`;
export const materialFlags = (interpolated: number): number => Math.floor(interpolated + 0.5);
export const hasFlag = (flags: number, bit: number): boolean => Math.floor(flags / bit) % 2 === 1;

interface BlockInfo {
  shape: Shape;
  /** Texture layer per face: +x, -x, +y, -y, +d, -d. */
  faces: [number, number, number, number, number, number];
  flags: number;
}

const L = LAYER;
const all = (layer: number): BlockInfo['faces'] => [layer, layer, layer, layer, layer, layer];
const column = (side: number, top: number, bottom = top): BlockInfo['faces'] => [side, side, top, bottom, side, side];

export const BLOCKS: (BlockInfo | undefined)[] = [];
const def = (id: number, shape: Shape, faces: BlockInfo['faces'], flags = 0) => { BLOCKS[id] = { shape, faces, flags }; };
def(B.stone, Shape.Cube, all(L.stone));
def(B.dirt, Shape.Cube, all(L.dirt));
def(B.grass, Shape.Cube, column(L.grassSide, L.grassTop, L.dirt), Tint.Grass); // only the top is tinted (shader)
def(B.sand, Shape.Cube, all(L.sand));
def(B.gravel, Shape.Cube, all(L.gravel));
def(B.coalOre, Shape.Cube, all(L.coalOre));
def(B.ironOre, Shape.Cube, all(L.ironOre));
def(B.cobblestone, Shape.Cube, all(L.cobblestone));
def(B.oakPlanks, Shape.Cube, all(L.oakPlanks));
def(B.oakLog, Shape.Cube, column(L.oakLog, L.oakLogTop));
def(B.oakLeaves, Shape.Cube, all(L.oakLeaves), Tint.Foliage | FLAG.cutout);
def(B.birchLog, Shape.Cube, column(L.birchLog, L.birchLogTop));
def(B.birchLeaves, Shape.Cube, all(L.birchLeaves), Tint.Birch | FLAG.cutout);
def(B.spruceLog, Shape.Cube, column(L.spruceLog, L.spruceLogTop));
def(B.spruceLeaves, Shape.Cube, all(L.spruceLeaves), FLAG.spruce | FLAG.cutout);
def(B.glowstone, Shape.Cube, all(L.glowstone), FLAG.emissive);
// The lamp of the Nether bridge's light posts (the overworld posts keep glowstone): always lit, a steady light source.
def(B.redstoneLamp, Shape.Cube, all(L.redstoneLampOn), FLAG.emissive);
// The cave wall lamps glow on the mids and the Nether glowstone on the bass, dark between their pulses (their texture lit
// by the scene); the light they cast on the scene is steady. The cave ceiling glowstone and the Nether lava falls are
// steady light sources (2026-11-18, user-requested: no music on them; the cave redstone ore was removed).
def(B.caveLamp, Shape.Cube, all(L.glowstone), FLAG.emissive | FLAG.energy | BAND.mid);
def(B.caveGlowstone, Shape.Cube, all(L.glowstone), FLAG.emissive);
def(B.netherGlowstone, Shape.Cube, all(L.glowstone), FLAG.emissive | FLAG.energy | BAND.bass);
def(B.lavaFall, Shape.Cube, all(L.lava), FLAG.emissive | FLAG.animated);
def(B.obsidian, Shape.Cube, all(L.obsidian));
def(B.cryingObsidian, Shape.Cube, all(L.cryingObsidian), FLAG.energy);
def(B.amethyst, Shape.Cube, all(L.amethyst), FLAG.energy);
def(B.netherrack, Shape.Cube, all(L.netherrack));
def(B.netherBricks, Shape.Cube, all(L.netherBricks));
def(B.soulSand, Shape.Cube, all(L.soulSand));
def(B.magma, Shape.Cube, all(L.magma), FLAG.emissive | FLAG.animated);
def(B.quartzOre, Shape.Cube, all(L.quartzOre));
def(B.snow, Shape.Cube, all(L.snow));
def(B.andesite, Shape.Cube, all(L.andesite));
def(B.tuff, Shape.Cube, all(L.tuff));
def(B.coarseDirt, Shape.Cube, all(L.coarseDirt));
def(B.water, Shape.Cube, all(L.water), FLAG.animated | Tint.None);
def(B.lava, Shape.Cube, all(L.lava), FLAG.emissive | FLAG.animated);
def(B.portal, Shape.Pane, all(L.portal), FLAG.emissive | FLAG.animated | FLAG.energy);
def(B.shortGrass, Shape.Cross, all(L.shortGrass), Tint.Grass | FLAG.cutout);
def(B.dandelion, Shape.Cross, all(L.dandelion), FLAG.cutout);
def(B.poppy, Shape.Cross, all(L.poppy), FLAG.cutout);
def(B.sugarCane, Shape.Cross, all(L.sugarCane), FLAG.cutout);
def(B.fern, Shape.Cross, all(L.fern), Tint.Grass | FLAG.cutout);
def(B.oakFence, Shape.Fence, all(L.oakPlanks));
def(B.netherFence, Shape.Fence, all(L.netherBricks));
def(B.oakStairsAhead, Shape.Stairs, all(L.oakPlanks));
def(B.oakStairsBehind, Shape.Stairs, all(L.oakPlanks));
def(B.rail, Shape.Rail, all(L.rail), FLAG.cutout);
def(B.poweredRail, Shape.Rail, all(L.poweredRail), FLAG.cutout);

/** Opaque full cube: hides the faces of its neighbours and casts ambient occlusion. */
export const OPAQUE = new Uint8Array(256);
/** Lava, still or falling (one fluid: no faces between them). */
export const isLava = (id: number): boolean => id === B.lava || id === B.lavaFall;
for (let id = 0; id < 256; id++) OPAQUE[id] = BLOCKS[id]?.shape === Shape.Cube && id !== B.water && !isLava(id) ? 1 : 0;

/** Block light emitted (0..15), as in the block game: glowstone, lit redstone lamp and lava 15, portal 11, crying obsidian 10, magma 3. */
export const LIGHT_EMIT = new Uint8Array(256);
LIGHT_EMIT[B.glowstone] = 15;
LIGHT_EMIT[B.redstoneLamp] = 15;
LIGHT_EMIT[B.lava] = 15;
LIGHT_EMIT[B.portal] = 11;
LIGHT_EMIT[B.cryingObsidian] = 10;
LIGHT_EMIT[B.magma] = 3;
// Cave lamps and ceiling glowstone light the cave (their light is baked; the lamps' pulse is visual).
LIGHT_EMIT[B.caveLamp] = 10;
LIGHT_EMIT[B.caveGlowstone] = 15;
LIGHT_EMIT[B.netherGlowstone] = 15;
LIGHT_EMIT[B.lavaFall] = 15;

/** How much a block dims light passing through it: 15 blocks it, 1 for leaves and fluids, 0 for air and thin shapes. */
export const LIGHT_OPACITY = new Uint8Array(256);
for (let id = 0; id < 256; id++) LIGHT_OPACITY[id] = OPAQUE[id] ? 15 : 0;
LIGHT_OPACITY[B.oakLeaves] = 1;
LIGHT_OPACITY[B.birchLeaves] = 1;
LIGHT_OPACITY[B.spruceLeaves] = 1;
LIGHT_OPACITY[B.water] = 1;
LIGHT_OPACITY[B.lava] = 1;
LIGHT_OPACITY[B.lavaFall] = 1;
