// Voxel Dreamscape: Three.js side (main thread). Turns the Worker's segment meshes into three meshes per segment (opaque
// blocks, translucent water, cutout plants) that share one block-texture atlas, plus the sky (gradient, square sun and
// moon, stars, flat block clouds). Shaders are GLSL ES 3.00 (three.js adds the version header and the varying /
// gl_FragColor compatibility defines for ShaderMaterial). Every animation is a pure function of the track time, the camera
// position and baked attributes: there is no per-frame state.
// Vertex layout (see mesher.ts): position (3), then (layer, u, v, packed) with packed = face + 8 ao + 32 light + 256 flags.
import * as THREE from 'three';
import type { ScenarioScene } from '../types.ts';
import { ISLANDS } from './islands.ts';
import { TERRAIN } from './terrain.ts';
import type { MeshArrays } from './mesher.ts';
import { voxelLogic, type VoxelParams, type VoxelSegment } from './logic.ts';
import minecartUrl from './textures/minecart.png';
import { ATLAS_GLSL, LAVA_FRAMES, MAGMA_FRAMES, PORTAL_FRAMES, VoxelAtlas, WATER_FRAMES } from './textures.ts';

const SEGMENT_LENGTH = voxelLogic.config.segmentLength;
/** Distance fog like a block game's render distance: starts at x, complete at y. */
const FOG_RANGE = [70, 150] as const;
/** Clouds: grid cell (m) and height of the layer. */
const CLOUD_CELL = 12;
const CLOUD_HEIGHT = 96;
/**
 * Drifting cubes (same logic as before): a box of the world kept around the camera ([width, min height, height span, depth]).
 * They keep away from the road: nothing closer than CUBE_CLEAR_X to the road's side or lower than CUBE_CLEAR_Y above it.
 */
const CUBE_COUNT = 90;
const CUBE_BOX = [300, 30, 90, 420] as const;
const CUBE_BEHIND = 40;
const CUBE_CLEAR_X = 30;
const CUBE_CLEAR_Y = 28;

/** Sky colours by hour of the day: horizon (also the fog colour) and zenith. Linear blends between keys. */
const SKY_KEYS: { hour: number; horizon: [number, number, number]; zenith: [number, number, number] }[] = [
  { hour: 0, horizon: [0.03, 0.04, 0.09], zenith: [0.01, 0.015, 0.05] },
  { hour: 5, horizon: [0.05, 0.06, 0.12], zenith: [0.015, 0.02, 0.07] },
  { hour: 6.3, horizon: [0.95, 0.55, 0.38], zenith: [0.25, 0.32, 0.6] },
  { hour: 7.5, horizon: [0.78, 0.78, 0.85], zenith: [0.38, 0.55, 0.95] },
  { hour: 9, horizon: [0.753, 0.847, 1.0], zenith: [0.47, 0.655, 1.0] },
  { hour: 16, horizon: [0.753, 0.847, 1.0], zenith: [0.47, 0.655, 1.0] },
  { hour: 18, horizon: [0.98, 0.62, 0.35], zenith: [0.42, 0.45, 0.8] },
  { hour: 19.2, horizon: [0.55, 0.28, 0.35], zenith: [0.16, 0.16, 0.38] },
  { hour: 20.5, horizon: [0.08, 0.07, 0.15], zenith: [0.03, 0.03, 0.1] },
  { hour: 24, horizon: [0.03, 0.04, 0.09], zenith: [0.01, 0.015, 0.05] },
];

const NETHER_FOG = new THREE.Color(0.2, 0.03, 0.02);

function skyAt(hour: number, horizon: THREE.Color, zenith: THREE.Color): number {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < SKY_KEYS.length - 2 && h > SKY_KEYS[i + 1]!.hour) i++;
  const a = SKY_KEYS[i]!, b = SKY_KEYS[i + 1]!;
  const f = Math.min(1, Math.max(0, (h - a.hour) / (b.hour - a.hour)));
  horizon.setRGB(a.horizon[0] + (b.horizon[0] - a.horizon[0]) * f, a.horizon[1] + (b.horizon[1] - a.horizon[1]) * f, a.horizon[2] + (b.horizon[2] - a.horizon[2]) * f);
  zenith.setRGB(a.zenith[0] + (b.zenith[0] - a.zenith[0]) * f, a.zenith[1] + (b.zenith[1] - a.zenith[1]) * f, a.zenith[2] + (b.zenith[2] - a.zenith[2]) * f);
  // Daylight: 1 from 7.5 to 17, 0 from 20 to 5.
  return Math.min(1, Math.max(0, h < 12 ? (h - 5.5) / 2.2 : (20.2 - h) / 2.6));
}

const VERTEX = /* glsl */ `
  attribute vec4 aTex; // layer, u, v, packed
  varying vec3 vWorld;
  varying vec3 vUv; // u, v (tiles), layer
  varying vec4 vInfo; // face, ao (0..3), light (0..7), flags
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    float packed = aTex.w;
    float face = mod(packed, 8.0);
    float ao = mod(floor(packed / 8.0), 4.0);
    float light = mod(floor(packed / 32.0), 8.0);
    float flags = floor(packed / 256.0);
    vUv = vec3(aTex.y, aTex.z, aTex.x);
    vInfo = vec4(face, ao, light, flags);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// Floating islands: the vertex shader lifts the island as the camera approaches (a pure function of the distance ahead and
// of the baked altitude, drift and phase), then bobs it slowly. The block shading is the ground's own.
const ISLAND_VERTEX = /* glsl */ `
  attribute vec4 aTex;
  attribute vec3 aIsland; // altitude, drift, phase
  uniform float uTime;
  varying vec3 vWorld;
  varying vec3 vUv;
  varying vec4 vInfo;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    float ahead = (-world.z) + 0.0 - (-cameraPosition.z);
    float rise = 1.0 - smoothstep(${ISLANDS.rise.done.toFixed(1)}, ${ISLANDS.rise.start.toFixed(1)}, ahead);
    world.y += aIsland.x * rise + sin(uTime * 0.35 + aIsland.z * 6.2831853) * 1.6 * rise;
    world.x += aIsland.y * rise;
    vWorld = world.xyz;
    float packed = aTex.w;
    vUv = vec3(aTex.y, aTex.z, aTex.x);
    vInfo = vec4(mod(packed, 8.0), mod(floor(packed / 8.0), 4.0), mod(floor(packed / 32.0), 8.0), floor(packed / 256.0));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const COMMON = /* glsl */ `
  precision highp float;
  ${ATLAS_GLSL}
  uniform float uTime;
  uniform float uDay; // 1 day .. 0 night
  uniform vec2 uFog;
  uniform vec3 uFogColor;
  uniform float uGlow; // glowstone pulse (bass)
  uniform float uEnergy; // portals, amethyst
  uniform float uNether;
  varying vec3 vWorld;
  varying vec3 vUv;
  varying vec4 vInfo;

  float flag(float flags, float bit) { return mod(floor(flags / bit), 2.0); }

  float frameCount(float layer) {
    if (abs(layer - L_LAVA) < 0.5) return ${LAVA_FRAMES.toFixed(1)};
    if (abs(layer - L_MAGMA) < 0.5) return ${MAGMA_FRAMES.toFixed(1)};
    if (abs(layer - L_PORTAL) < 0.5) return ${PORTAL_FRAMES.toFixed(1)};
    return ${WATER_FRAMES.toFixed(1)};
  }

  // Fixed per-face shade of a block game: top 1, north / south 0.8, east / west 0.6, bottom 0.5.
  float faceShade(float face) {
    if (face < 1.5) return 0.6;
    if (face < 2.5) return 1.0;
    if (face < 3.5) return 0.5;
    return 0.8;
  }

  // Sky light level 0..7 to brightness (the game's curve), scaled by the time of day. In the Nether there is no sky:
  // a dim reddish ambient light replaces it.
  float skyBrightness(float level) {
    float l = level / 7.0;
    float b = l / (4.0 - 3.0 * l);
    float day = mix(0.1 * (0.4 + 0.6 * b), b, uDay);
    return mix(day, 0.62, uNether);
  }

  vec3 applyFog(vec3 color, vec3 world) {
    float dist = length(world - cameraPosition);
    float range = mix(1.0, 0.45, uNether);
    return mix(color, uFogColor, smoothstep(uFog.x * range, uFog.y * range, dist));
  }

  // Colour of the block at this fragment with its tint, texture animation, and (if cutout) its alpha.
  vec4 blockColor(out float emissive) {
    float flags = vInfo.w;
    float tint = mod(flags, 4.0);
    float layer = vUv.z;
    if (flag(flags, 16.0) > 0.5) layer += mod(floor(uTime * 8.0), frameCount(layer));
    vec2 uv = vUv.xy;
    vec4 tex = atlas(uv, layer, dFdx(uv), dFdy(uv));
    vec3 rgb = tex.rgb;
    if (tint > 2.5) rgb *= BIRCH_TINT;
    else if (tint > 1.5) rgb *= FOLIAGE_TINT * 1.1;
    else if (tint > 0.5) rgb *= GRASS_TINT;
    emissive = flag(flags, 8.0);
    return vec4(rgb, tex.a);
  }

  vec3 shade(vec3 rgb, float emissive) {
    float ao = 0.45 + 0.55 * vInfo.y / 3.0;
    float bl = mod(floor(vInfo.w / 64.0), 4.0) / 3.0;
    float sky = max(skyBrightness(vInfo.z), 0.05);
    float lit = (sky + bl * bl * 0.95 * (1.0 - 0.5 * sky)) * faceShade(vInfo.x) * ao;
    // Block light is warm.
    rgb *= mix(vec3(1.0), vec3(1.0, 0.82, 0.6), clamp(bl * 1.3 - sky, 0.0, 1.0));
    // Glowstone, lava and magma shine at night; during the day they are just bright blocks.
    float glow = (0.9 + 0.35 * uGlow) * (0.8 + 0.2 * (1.0 - uDay) + 0.45 * uNether);
    return mix(rgb * lit, rgb * glow, emissive);
  }
`;

const SOLID_FRAGMENT = /* glsl */ `
  ${COMMON}
  void main() {
    float emissive;
    vec4 c = blockColor(emissive);
    vec3 rgb = c.rgb;
    // Leaves are opaque meshes: the holes of the cutout texture show a dark foliage colour instead of what is behind.
    if (flag(vInfo.w, 4.0) > 0.5) rgb = mix(FOLIAGE_TINT * 0.28, rgb, step(0.5, c.a));
    gl_FragColor = vec4(applyFog(shade(rgb, emissive), vWorld), 1.0);
  }
`;

const CROSS_FRAGMENT = /* glsl */ `
  ${COMMON}
  void main() {
    float emissive;
    vec4 c = blockColor(emissive);
    if (c.a < 0.5) discard;
    gl_FragColor = vec4(applyFog(shade(c.rgb, emissive), vWorld), 1.0);
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  ${COMMON}
  uniform float uSparkle;
  void main() {
    float emissive;
    vec4 c = blockColor(emissive);
    vec3 rgb = c.rgb * vec3(0.3, 0.48, 1.0) * 1.15;
    float lit = max(skyBrightness(vInfo.z), 0.03);
    vec3 view = normalize(vWorld - cameraPosition);
    float fres = pow(1.0 - clamp(-view.y, 0.0, 1.0), 3.0);
    rgb = mix(rgb * lit, uFogColor, 0.35 * fres);
    // Glints on the highs.
    vec2 cell = floor(vWorld.xz);
    float h = fract(sin(dot(cell + floor(uTime * 3.0), vec2(12.9898, 78.233))) * 43758.5453);
    rgb += vec3(1.0) * step(1.0 - 0.01 * uSparkle, h) * (1.0 - smoothstep(30.0, 120.0, length(vWorld - cameraPosition))) * uDay;
    gl_FragColor = vec4(applyFog(rgb, vWorld), 0.74);
  }
`;

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Sky: gradient by time of day, square sun and moon (block textures), night stars.
const SKY_FRAGMENT = /* glsl */ `
  precision highp float;
  ${ATLAS_GLSL}
  uniform vec3 uFogColor;
  uniform vec3 uZenith;
  uniform vec3 uSunDir;
  uniform float uDay;
  uniform float uSalt;
  uniform float uNether;
  varying vec3 vDir;

  float hash3(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195) + uSalt * 0.013);
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  // Square body (sun or moon) of half-size "size" seen along "axis": the texel colour and its alpha.
  vec4 body(vec3 d, vec3 axis, float size, float layer) {
    float facing = dot(d, axis);
    if (facing <= 0.0) return vec4(0.0);
    vec3 up = abs(axis.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 right = normalize(cross(up, axis));
    vec3 upv = cross(axis, right);
    vec2 q = vec2(dot(d, right), dot(d, upv)) / facing / size;
    if (abs(q.x) > 1.0 || abs(q.y) > 1.0) return vec4(0.0);
    return textureLod(uAtlas, vec3(q * 0.5 + 0.5, layer), 0.0);
  }

  void main() {
    vec3 d = normalize(vDir);
    float e = d.y;
    vec3 col = mix(uFogColor, uZenith, smoothstep(0.0, 0.55, e));
    col = mix(col, uFogColor * 0.9, smoothstep(0.0, -0.4, e));
    if (uNether < 0.5) {
      vec3 cell = floor(d * 220.0);
      float h = hash3(cell);
      float star = step(0.9965, h) * smoothstep(0.02, 0.25, e) * (1.0 - uDay) * (0.6 + 0.4 * sin(h * 80.0));
      col += vec3(star);
      vec4 sun = body(d, uSunDir, 0.085, L_SUN);
      col = mix(col, sun.rgb * 1.5, sun.a);
      vec4 moon = body(d, -uSunDir, 0.07, L_MOON);
      col = mix(col, moon.rgb * 1.1, moon.a * (1.0 - uDay));
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Clouds: one flat layer of blocks drifting with the wind; each cell of the grid is a cloud or not (value noise).
const CLOUD_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = vec3(cameraPosition.x + position.x, ${CLOUD_HEIGHT.toFixed(1)}, cameraPosition.z + position.z);
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const CLOUD_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uDay;
  uniform float uSalt;
  uniform float uCloud;
  uniform float uNether;
  uniform vec3 uFogColor;
  uniform vec2 uFog;
  varying vec3 vWorld;
  float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSalt * 17.13) * 43758.5453); }
  void main() {
    if (uNether > 0.5) discard;
    vec2 p = (vWorld.xz + vec2(uTime * 1.6, 0.0)) / ${CLOUD_CELL.toFixed(1)};
    vec2 c = floor(p);
    float n = h2(floor(c / 4.0)) * 0.55 + h2(c) * 0.45;
    if (n < 0.64) discard;
    float dist = length(vWorld - cameraPosition);
    float a = 0.85 * (1.0 - smoothstep(uFog.y * 1.2, uFog.y * 3.0, dist));
    if (a <= 0.01) discard;
    vec3 col = mix(vec3(0.08, 0.09, 0.14), vec3(1.0), uDay) * (0.9 + 0.2 * uCloud);
    gl_FragColor = vec4(mix(col, uFogColor, 0.25), a);
  }
`;

// Drifting cubes: each has a fixed world position (plus a slow sway on track time) that wraps inside a box kept mostly
// ahead of the camera. Onsets (flux) kick their rotation and flash their edges. Cubes that fall in the exclusion zone
// around the road are pushed out of it, so nothing floats in the way of the view.
const CUBE_VERTEX = /* glsl */ `
  attribute vec4 aRand;
  uniform float uTime;
  uniform float uKick;
  uniform float uSalt;
  uniform vec4 uBox; // width, min height, height span, depth
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying float vHash;

  float wrapInto(float seed, float lo, float size) { return lo + fract((seed - lo) / size) * size; }

  vec3 rotate(vec3 v, vec3 axis, float a) {
    float c = cos(a), s = sin(a);
    return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
  }

  void main() {
    vec4 r = fract(aRand + uSalt * 0.6180339);
    vec3 c;
    c.x = wrapInto(r.x * uBox.x, cameraPosition.x - 0.5 * uBox.x, uBox.x);
    c.z = wrapInto(r.z * uBox.w, cameraPosition.z + ${CUBE_BEHIND.toFixed(1)} - uBox.w, uBox.w);
    c.y = cameraPosition.y + uBox.y + r.y * uBox.z + sin(uTime * (0.15 + 0.2 * r.w) + r.x * 6.2831) * 3.0;
    // Exclusion zone: near the road's side, a cube moves out to the edge of the zone.
    float side = c.x >= cameraPosition.x ? 1.0 : -1.0;
    float dx = abs(c.x - cameraPosition.x);
    c.x = cameraPosition.x + side * max(dx, ${CUBE_CLEAR_X.toFixed(1)} + 6.0 * r.w);
    c.y = max(c.y, cameraPosition.y + ${CUBE_CLEAR_Y.toFixed(1)});
    float ahead = cameraPosition.z - c.z;
    float fade = smoothstep(uBox.w - ${CUBE_BEHIND.toFixed(1)}, (uBox.w - ${CUBE_BEHIND.toFixed(1)}) * 0.75, ahead)
      * smoothstep(0.5 * uBox.x + 20.0, 0.4 * uBox.x + 20.0, abs(c.x - cameraPosition.x))
      * smoothstep(-${CUBE_BEHIND.toFixed(1)}, -${(CUBE_BEHIND * 0.5).toFixed(1)}, ahead);
    float size = (1.2 + 5.0 * r.w * r.w) * fade;
    vec3 axis = normalize(vec3(r.x, r.y, r.z) - 0.5 + 0.001);
    float angle = uTime * (0.08 + 0.25 * r.y) + r.z * 6.2831 + uKick * (0.6 + r.x);
    vec3 local = rotate(position, axis, angle);
    vWorld = c + local * size;
    vNormal = rotate(normal, axis, angle);
    vLocal = position;
    vHash = r.w + r.x * 3.1;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const CUBE_FRAGMENT = /* glsl */ `
  precision highp float;
  ${ATLAS_GLSL}
  uniform float uDay;
  uniform float uCubeGlow;
  uniform vec2 uFog;
  uniform vec3 uFogColor;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying float vHash;

  void main() {
    vec3 n = normalize(vNormal);
    float k = fract(vHash);
    // One block per cube: amethyst, obsidian-like crying obsidian or glowstone.
    float id = k < 0.45 ? L_AMETHYST : (k < 0.8 ? L_CRYING_OBSIDIAN : L_GLOWSTONE);
    vec3 a = abs(vLocal) * 2.0;
    vec2 uv = (a.x > 0.999 ? vLocal.zy : (a.y > 0.999 ? vLocal.xz : vLocal.xy)) + 0.5;
    vec3 base = atlas(uv, id, dFdx(uv), dFdy(uv)).rgb;
    vec3 L = normalize(vec3(0.35, 0.85, -0.4));
    float shade = (0.5 + 0.5 * max(dot(n, L), 0.0)) * mix(0.35, 1.0, uDay);
    vec3 color = base * shade;
    if (k >= 0.8) color = mix(color, base, 0.7); // glowstone is a light source
    vec3 e = 0.5 - abs(vLocal);
    float edge = a.x > 0.999 ? min(e.y, e.z) : (a.y > 0.999 ? min(e.x, e.z) : min(e.x, e.y));
    float line = 1.0 - smoothstep(0.0, max(0.06, fwidth(edge) * 1.5), edge);
    vec3 glow = mix(vec3(0.3, 1.0, 0.9), vec3(0.8, 0.4, 1.0), step(0.5, fract(vHash * 5.3))) * line * uCubeGlow;
    float dist = length(vWorld - cameraPosition);
    gl_FragColor = vec4(mix(color + glow * 0.8, uFogColor, smoothstep(uFog.y * 1.2, uFog.y * 2.6, dist)), 1.0);
  }
`;

// Portal flash: a full-screen purple veil (like the game's portal nausea) hiding the switch of dimension.
const FLASH_VERTEX = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const FLASH_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uFlash;
  void main() { gl_FragColor = vec4(0.5, 0.12, 0.85, 0.92 * uFlash); }
`;
/** Half-length (m) of the flash along the road around a portal: about 0.5 s at cruise speed. */
const FLASH_HALF = 22;

/** Minecart: floor and four walls of the entity texture (128 x 64), in cart space: x across, y up, -z forward. */
function minecartGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const W = 0.7, Lh = 0.9, floorY = 0.28, top = 0.62;
  const quad = (c: number[], rect: [number, number, number, number]) => {
    const n = pos.length / 3;
    pos.push(...c);
    const [u0, v0, u1, v1] = rect;
    uv.push(u0 / 128, 1 - v1 / 64, u1 / 128, 1 - v1 / 64, u1 / 128, 1 - v0 / 64, u0 / 128, 1 - v0 / 64);
    idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  };
  const wall: [number, number, number, number] = [4, 4, 36, 20];
  quad([-W, floorY, Lh, W, floorY, Lh, W, top, Lh, -W, top, Lh], wall);
  quad([-W, floorY, -Lh, W, floorY, -Lh, W, top, -Lh, -W, top, -Lh], wall);
  quad([-W, floorY, -Lh, -W, floorY, Lh, -W, top, Lh, -W, top, -Lh], wall);
  quad([W, floorY, -Lh, W, floorY, Lh, W, top, Lh, W, top, -Lh], wall);
  quad([-W, floorY, -Lh, W, floorY, -Lh, W, floorY, Lh, -W, floorY, Lh], [4, 24, 44, 56]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

interface SegmentMeshes {
  /** Overworld meshes (shown while the camera is in the overworld) and Nether meshes (shown inside the Nether). */
  meshes: THREE.Mesh[];
  nether: THREE.Mesh[];
  mood: [number, number];
  hour: [number, number];
  nether0: number;
  portals: number[];
}

export class VoxelScene implements ScenarioScene {
  readonly scene = new THREE.Scene();
  readonly background = new THREE.Color(0.753, 0.847, 1.0);

  private readonly segments = new Map<number, SegmentMeshes>();
  /** Uniforms shared by every material. */
  private readonly shared = {
    uTime: { value: 0 },
    uDay: { value: 1 },
    uFog: { value: new THREE.Vector2(...FOG_RANGE) },
    uFogColor: { value: new THREE.Color(0.753, 0.847, 1.0) },
    uGlow: { value: 1 },
    uEnergy: { value: 0.5 },
    uNether: { value: 0 },
    uSalt: { value: 1 },
    uAtlas: { value: null as THREE.DataArrayTexture | null },
  };
  private readonly solidMaterial: THREE.ShaderMaterial;
  private readonly crossMaterial: THREE.ShaderMaterial;
  private readonly islandSolidMaterial: THREE.ShaderMaterial;
  private readonly islandCrossMaterial: THREE.ShaderMaterial;
  private readonly waterMaterial: THREE.ShaderMaterial;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly cloudMaterial: THREE.ShaderMaterial;
  private readonly atlas = new VoxelAtlas();
  private readonly sky: THREE.Mesh;
  private readonly clouds: THREE.Mesh;
  private readonly cubes: THREE.Mesh;
  private readonly cubeMaterial: THREE.ShaderMaterial;
  private readonly flashMesh: THREE.Mesh;
  private readonly flashMaterial: THREE.ShaderMaterial;
  private readonly cart: THREE.Mesh;
  private readonly cartTexture: THREE.Texture;
  private readonly lastCam = new THREE.Vector3();
  private cartSlope = 0;
  private inNether = false;
  private readonly horizon = new THREE.Color();
  private readonly zenith = new THREE.Color();
  private readonly sunDir = new THREE.Vector3(0, 1, 0);
  private mood = 0.5;
  private hour = 6.5;

  constructor() {
    this.shared.uAtlas.value = this.atlas.texture;
    const make = (fragmentShader: string, extra: Record<string, THREE.IUniform> = {}, options: THREE.ShaderMaterialParameters = {}) =>
      new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader, uniforms: { ...this.shared, ...extra }, ...options });
    this.solidMaterial = make(SOLID_FRAGMENT);
    this.crossMaterial = make(CROSS_FRAGMENT, {}, { side: THREE.DoubleSide });
    const island = (fragmentShader: string, options: THREE.ShaderMaterialParameters = {}) =>
      new THREE.ShaderMaterial({ vertexShader: ISLAND_VERTEX, fragmentShader, uniforms: { ...this.shared }, ...options });
    this.islandSolidMaterial = island(SOLID_FRAGMENT);
    this.islandCrossMaterial = island(CROSS_FRAGMENT, { side: THREE.DoubleSide });
    this.waterMaterial = make(WATER_FRAGMENT, { uSparkle: { value: 0.5 } }, { transparent: true, depthWrite: false });

    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: { ...this.shared, uZenith: { value: new THREE.Color() }, uSunDir: { value: this.sunDir } },
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), this.skyMaterial);
    this.sky.renderOrder = -2;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this.cloudMaterial = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      uniforms: { ...this.shared, uCloud: { value: 0.5 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400, 1, 1).rotateX(-Math.PI / 2), this.cloudMaterial);
    this.clouds.renderOrder = 3;
    this.clouds.frustumCulled = false;
    this.scene.add(this.clouds);

    this.cubeMaterial = new THREE.ShaderMaterial({
      vertexShader: CUBE_VERTEX,
      fragmentShader: CUBE_FRAGMENT,
      uniforms: { ...this.shared, uKick: { value: 0 }, uCubeGlow: { value: 0.3 }, uBox: { value: new THREE.Vector4(...CUBE_BOX) } },
    });
    // Cube attributes come from a fixed hash of the index (no Math.random), so they are identical in every run.
    const fixedHash = (i: number) => {
      const x = Math.sin((i + 1) * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    };
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const cubeGeometry = new THREE.InstancedBufferGeometry();
    cubeGeometry.setAttribute('position', unit.getAttribute('position'));
    cubeGeometry.setAttribute('normal', unit.getAttribute('normal'));
    cubeGeometry.setIndex(unit.index!);
    const rand = new Float32Array(CUBE_COUNT * 4);
    for (let i = 0; i < rand.length; i++) rand[i] = fixedHash(i);
    cubeGeometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 4));
    cubeGeometry.instanceCount = CUBE_COUNT;
    this.cubes = new THREE.Mesh(cubeGeometry, this.cubeMaterial);
    this.cubes.frustumCulled = false;
    this.scene.add(this.cubes);

    this.flashMaterial = new THREE.ShaderMaterial({
      vertexShader: FLASH_VERTEX,
      fragmentShader: FLASH_FRAGMENT,
      uniforms: { uFlash: { value: 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.flashMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.flashMaterial);
    this.flashMesh.renderOrder = 100;
    this.flashMesh.frustumCulled = false;
    this.flashMesh.visible = false;
    this.scene.add(this.flashMesh);

    this.cartTexture = new THREE.TextureLoader().load(minecartUrl);
    this.cartTexture.magFilter = THREE.NearestFilter;
    this.cartTexture.minFilter = THREE.NearestFilter;
    this.cartTexture.colorSpace = THREE.NoColorSpace;
    this.cart = new THREE.Mesh(minecartGeometry(), new THREE.MeshBasicMaterial({ map: this.cartTexture, side: THREE.DoubleSide, alphaTest: 0.5, color: 0x9a9aa8 }));
    this.cart.frustumCulled = false;
    this.cart.visible = false;
    this.scene.add(this.cart);
  }

  ready(): Promise<void> {
    return this.atlas.loaded;
  }

  private meshOf(data: MeshArrays, startDistance: number, material: THREE.ShaderMaterial, order: number): THREE.Mesh | null {
    if (data.indices.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    const buffer = new THREE.InterleavedBuffer(data.vertices, 7);
    geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute('aTex', new THREE.InterleavedBufferAttribute(buffer, 4, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    if (data.extra) {
      geometry.setAttribute('aIsland', new THREE.BufferAttribute(data.extra, 3));
      // Lifted islands rise up to ~200 m and drift: generous bounds so culling never hides them.
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 100, -(startDistance + SEGMENT_LENGTH / 2)), TERRAIN.halfWidth + SEGMENT_LENGTH + 120);
    } else {
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 30, -(startDistance + SEGMENT_LENGTH / 2)), TERRAIN.halfWidth + SEGMENT_LENGTH);
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = -0.5; // block column bx covers x in [bx, bx + 1]; the road (bx -1..1) is centred on x = 0
    mesh.renderOrder = order;
    return mesh;
  }

  private netherMeshOf(data: MeshArrays, material: THREE.ShaderMaterial, order: number): THREE.Mesh | null {
    if (data.indices.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    const buffer = new THREE.InterleavedBuffer(data.vertices, 7);
    geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute('aTex', new THREE.InterleavedBufferAttribute(buffer, 4, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = -0.5;
    mesh.renderOrder = order;
    mesh.visible = false;
    return mesh;
  }

  addSegment(index: number, descriptor: unknown, startDistance: number): void {
    const seg = descriptor as VoxelSegment;
    const meshes = [
      this.meshOf(seg.solid, startDistance, this.solidMaterial, 0),
      this.meshOf(seg.cross, startDistance, this.crossMaterial, 1),
      this.meshOf(seg.water, startDistance, this.waterMaterial, 2),
    ].filter((m): m is THREE.Mesh => m !== null);
    for (const isl of seg.islands) {
      for (const m of [this.meshOf(isl.solid, startDistance, this.islandSolidMaterial, 0), this.meshOf(isl.cross, startDistance, this.islandCrossMaterial, 1)]) if (m) meshes.push(m);
    }
    const nether = seg.nether
      ? [this.netherMeshOf(seg.nether.solid, this.solidMaterial, 0), this.netherMeshOf(seg.nether.cross, this.crossMaterial, 1)].filter((m): m is THREE.Mesh => m !== null)
      : [];
    for (const mesh of [...meshes, ...nether]) this.scene.add(mesh);
    this.segments.set(index, { meshes, nether, mood: seg.mood, hour: seg.hour, nether0: seg.nether0, portals: seg.portals });
  }

  removeSegment(index: number): void {
    const seg = this.segments.get(index);
    if (!seg) return;
    for (const mesh of [...seg.meshes, ...seg.nether]) {
      this.scene.remove(mesh);
      mesh.geometry.dispose(); // the shared materials stay alive
    }
    this.segments.delete(index);
  }

  /** Interpolates a baked [start, end] pair of the segment under the camera (pure function of descriptors and distance). */
  private bakedAt(distance: number, pick: (s: SegmentMeshes) => [number, number], fallback: number): number {
    const index = Math.floor(distance / SEGMENT_LENGTH);
    const seg = this.segments.get(index);
    if (!seg) return fallback; // still loading: hold the last value
    const f = Math.min(1, Math.max(0, distance / SEGMENT_LENGTH - index));
    const [a, b] = pick(seg);
    return a + (b - a) * f;
  }

  /** Whether the camera is in the Nether at this distance: the state at the segment start flipped by each portal crossed. */
  private netherAt(distance: number): boolean {
    const seg = this.segments.get(Math.floor(distance / SEGMENT_LENGTH));
    if (!seg) return this.inNether; // still loading: hold the last value
    let state = seg.nether0 === 1;
    for (const d of seg.portals) if (distance >= d) state = !state;
    return state;
  }

  /** Flash intensity (0..1) from the distance to the nearest portal of the loaded segments. */
  private flashAt(distance: number): number {
    let best = FLASH_HALF;
    for (const seg of this.segments.values()) for (const d of seg.portals) best = Math.min(best, Math.abs(distance - d));
    const x = 1 - best / FLASH_HALF;
    return x * x * (3 - 2 * x);
  }

  update(params: unknown, cameraPosition: THREE.Vector3, trackTime: number): void {
    const p = params as VoxelParams;
    const distance = -cameraPosition.z;
    this.inNether = this.netherAt(distance);
    for (const seg of this.segments.values()) {
      for (const m of seg.meshes) m.visible = !this.inNether;
      for (const m of seg.nether) m.visible = this.inNether;
    }
    this.shared.uNether.value = this.inNether ? 1 : 0;
    this.cubes.visible = !this.inNether;
    this.cubeMaterial.uniforms.uKick!.value = p.cubeKick;
    this.cubeMaterial.uniforms.uCubeGlow!.value = p.cubeGlow;
    const flash = this.flashAt(distance);
    this.flashMaterial.uniforms.uFlash!.value = flash;
    this.flashMesh.visible = flash > 0.002;
    // Minecart: rides at the camera, pitched with the road slope (estimated from the last frame's motion, smoothed).
    this.cart.visible = this.inNether;
    const dd = this.lastCam.z - cameraPosition.z;
    if (dd > 1e-3 && dd < 20) this.cartSlope += ((cameraPosition.y - this.lastCam.y) / dd - this.cartSlope) * 0.25;
    this.lastCam.copy(cameraPosition);
    this.cart.position.set(0, cameraPosition.y - 1.5, cameraPosition.z + 0.15);
    this.cart.rotation.x = Math.atan(this.cartSlope);
    this.mood = this.bakedAt(distance, (s) => s.mood, this.mood);
    this.hour = this.bakedAt(distance, (s) => s.hour, this.hour);
    const day = skyAt(this.hour, this.horizon, this.zenith);
    // The sun crosses the sky from east to west, tilted toward the travel direction so sunrise and sunset stay in view.
    const a = ((this.hour - 6) / 24) * Math.PI * 2;
    this.sunDir.set(-Math.cos(a) * 0.55, Math.sin(a), -Math.cos(a) * 0.83 - 0.25).normalize();
    this.shared.uTime.value = trackTime;
    this.shared.uDay.value = day;
    this.shared.uSalt.value = p.worldSalt;
    if (this.inNether) {
      this.horizon.copy(NETHER_FOG);
      this.zenith.copy(NETHER_FOG);
    }
    this.shared.uFogColor.value.copy(this.horizon);
    this.skyMaterial.uniforms.uZenith!.value.copy(this.zenith);
    this.background.copy(this.horizon);
    this.shared.uGlow.value = p.glowPulse;
    this.shared.uEnergy.value = p.energy;
    this.waterMaterial.uniforms.uSparkle!.value = p.sparkle;
    this.cloudMaterial.uniforms.uCloud!.value = p.cloudGlow;
    this.sky.position.copy(cameraPosition);
  }

  dispose(): void {
    for (const index of [...this.segments.keys()]) this.removeSegment(index);
    for (const mesh of [this.sky, this.clouds, this.cubes, this.flashMesh, this.cart]) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    for (const material of [this.solidMaterial, this.crossMaterial, this.islandSolidMaterial, this.islandCrossMaterial, this.waterMaterial, this.skyMaterial, this.cloudMaterial, this.cubeMaterial, this.flashMaterial]) material.dispose();
    (this.cart.material as THREE.Material).dispose();
    this.cartTexture.dispose();
    this.atlas.dispose();
  }
}

// The Nether overrides (fog colour) are applied by the dimension code; kept here so the constant has one home.
export { NETHER_FOG };
