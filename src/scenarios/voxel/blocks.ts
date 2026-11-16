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
  ['sun', 1], ['moon', 1], ['magma', 3], ['lava', 20], ['water', 32], ['portal', 32],
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
  portal: 23, water: 24, lava: 25,
  shortGrass: 30, dandelion: 31, poppy: 32, sugarCane: 33,
  oakFence: 40, netherFence: 41,
  rail: 50, poweredRail: 51,
} as const;

export const Shape = { None: 0, Cube: 1, Cross: 2, Fence: 3, Pane: 4, Rail: 5 } as const;
export type Shape = (typeof Shape)[keyof typeof Shape];

/** Tint of a gray texture: 0 none, 1 grass, 2 oak foliage, 3 birch foliage. */
export const Tint = { None: 0, Grass: 1, Foliage: 2, Birch: 3 } as const;

/** Per-quad material flags (packed in the vertex attributes, read by the shaders). */
export const FLAG = {
  /** Low 2 bits: tint (Tint). */
  tintMask: 3,
  /** Cutout texture: leaves fill their holes with a dark foliage colour; plants discard them. */
  cutout: 4,
  /** Light source (glowstone, magma, lava, portal): not darkened by the night or by shade, pulses with its driver. */
  emissive: 8,
  /** Animated strip: the layer is the first frame (portal 32, magma 3). */
  animated: 16,
  /** Portal or amethyst: brightness follows the energy. */
  energy: 32,
} as const;

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
def(B.glowstone, Shape.Cube, all(L.glowstone), FLAG.emissive);
def(B.obsidian, Shape.Cube, all(L.obsidian));
def(B.cryingObsidian, Shape.Cube, all(L.cryingObsidian), FLAG.energy);
def(B.amethyst, Shape.Cube, all(L.amethyst), FLAG.energy);
def(B.netherrack, Shape.Cube, all(L.netherrack));
def(B.netherBricks, Shape.Cube, all(L.netherBricks));
def(B.soulSand, Shape.Cube, all(L.soulSand));
def(B.magma, Shape.Cube, all(L.magma), FLAG.emissive | FLAG.animated);
def(B.quartzOre, Shape.Cube, all(L.quartzOre));
def(B.water, Shape.Cube, all(L.water), FLAG.animated | Tint.None);
def(B.lava, Shape.Cube, all(L.lava), FLAG.emissive | FLAG.animated);
def(B.portal, Shape.Pane, all(L.portal), FLAG.emissive | FLAG.animated | FLAG.energy);
def(B.shortGrass, Shape.Cross, all(L.shortGrass), Tint.Grass | FLAG.cutout);
def(B.dandelion, Shape.Cross, all(L.dandelion), FLAG.cutout);
def(B.poppy, Shape.Cross, all(L.poppy), FLAG.cutout);
def(B.sugarCane, Shape.Cross, all(L.sugarCane), FLAG.cutout);
def(B.oakFence, Shape.Fence, all(L.oakPlanks));
def(B.netherFence, Shape.Fence, all(L.netherBricks));
def(B.rail, Shape.Rail, all(L.rail), FLAG.cutout);
def(B.poweredRail, Shape.Rail, all(L.poweredRail), FLAG.cutout);

/** Opaque full cube: hides the faces of its neighbours and casts ambient occlusion. */
export const OPAQUE = new Uint8Array(256);
for (let id = 0; id < 256; id++) OPAQUE[id] = BLOCKS[id]?.shape === Shape.Cube && id !== B.water && id !== B.lava ? 1 : 0;
