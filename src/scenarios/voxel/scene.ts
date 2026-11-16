// Voxel Dreamscape: Three.js side (main thread). Turns segment descriptors into instanced voxel boxes and applies the
// interpreted parameters to one material per visual group. Shaders are GLSL ES 3.00 (three.js adds the version header
// and the varying/gl_FragColor compatibility defines for ShaderMaterial). Every animation is a pure function of the
// track time, the camera position and baked attributes: there is no per-frame state.
import * as THREE from 'three';
import type { ScenarioScene } from '../types.ts';
import { BANKS, BOX_STRIDE, TREES, voxelLogic, type VoxelParams, type VoxelSegment } from './logic.ts';
import { ATLAS_GLSL, PORTAL_FRAMES, VoxelAtlas } from './textures.ts';

/** One block texture tile covers one terrace (BANKS.step metres), so the 5 m columns are 2 x 2 blocks per terrace. */
const TILE = BANKS.step.toFixed(1);
const TREE_BLOCK = TREES.block.toFixed(2);

const SEGMENT_LENGTH = voxelLogic.config.segmentLength;
const LOADED_AHEAD = voxelLogic.config.segmentsAhead * SEGMENT_LENGTH;
/** Fog starts at x and is complete at y, inside what is always loaded ahead. */
const FOG_RANGE = [180, 0.93 * LOADED_AHEAD] as const;
/**
 * Signature: an archipelago is still part of the bank while it is more than `start` metres ahead of the camera, breaks
 * off and rises as the camera approaches, and is at its full altitude from `done` metres on (pure function of distance).
 */
const RISE = { start: 760, done: 200 } as const;
const HORIZON = new THREE.Color(0.55, 0.25, 0.6);
/** Horizontal size of the water plane around the camera (it is also the lake under the horizon ring). */
const WATER_SIZE = 7000;
/** Horizon ring: voxel peaks in the lake, beyond the generated valley. */
const RING = { inner: 1450, depth: 1100, count: 1100 } as const;
/** Drifting cubes: a box of the world kept around the camera ([width, min height, height span, depth]). */
const CUBE_COUNT = 650;
const CUBE_BOX = [560, 14, 190, 1100] as const;
const CUBE_BEHIND = 60;

// Sky for a view direction. `skyHaze` (gradient and horizon glow, tinted by the slow mood) is also the fog colour of
// every group, so distant geometry dissolves into exactly the sky behind it. `skyColor` adds stars and the aurora.
const SKY_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uSalt;
  uniform float uMood; // slow intensity of the music where the camera is (0 calm .. 1 intense), baked in segments
  uniform vec2 uAurora; // x: brightness, y: reach (height) of the curtains

  float hash1(float n) { return fract(sin(n * 127.1 + uSalt * 311.7) * 43758.5453); }
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSalt * 17.13) * 43758.5453); }
  float hash3(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash2(i), b = hash2(i + vec2(1.0, 0.0)), c = hash2(i + vec2(0.0, 1.0)), d = hash2(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  vec3 skyHaze(vec3 dir) {
    float e = dir.y;
    vec3 zenith = vec3(0.03, 0.02, 0.13);
    vec3 mid = vec3(0.22, 0.08, 0.42);
    // Calm passages keep a cool violet-pink horizon; intense ones warm it toward magenta and orange.
    vec3 horizon = mix(vec3(0.62, 0.30, 0.68), vec3(0.95, 0.38, 0.42), uMood);
    vec3 col = mix(horizon, mid, smoothstep(0.0, 0.22, e));
    col = mix(col, zenith, smoothstep(0.18, 0.85, e));
    // Glow band on the horizon ahead.
    float ahead = max(-dir.z, 0.0);
    col += mix(vec3(0.9, 0.35, 0.6), vec3(1.0, 0.55, 0.25), uMood) * exp(-abs(e - 0.01) * 18.0) * (0.25 + 0.3 * ahead) * (0.6 + 0.6 * uMood);
    // Below the horizon (seen in reflections and fog): a darker violet.
    col = mix(col, vec3(0.30, 0.14, 0.40), smoothstep(0.0, -0.3, e));
    return col;
  }

  float aurora(vec3 dir, out float vpos) {
    vpos = 0.0;
    float e = dir.y;
    if (e < 0.03) return 0.0;
    float u = atan(dir.x, -dir.z) * 1.6; // 0 straight ahead
    float t = uTime;
    float bend = (vnoise(vec2(u * 1.1 + 3.0, t * 0.035)) - 0.5) * 1.6;
    float s = vnoise(vec2((u + bend) * 13.0, t * 0.12)) * 0.65 + vnoise(vec2((u + bend) * 31.0, t * 0.2 + 5.0)) * 0.35;
    float streak = pow(s, 2.5);
    float base = 0.10 + 0.10 * vnoise(vec2(u * 2.0, t * 0.05 + 9.0));
    float top = base + 0.2 + 0.5 * uAurora.y;
    vpos = clamp((e - base) / (top - base), 0.0, 1.0);
    float env = smoothstep(base, base + 0.07, e) * (1.0 - smoothstep(base + 0.05, top, e));
    float sheet = smoothstep(0.25, 0.75, vnoise(vec2(u * 0.7 - t * 0.02, 7.0))); // curtains come and go across the sky
    return streak * env * (0.35 + 0.65 * sheet);
  }

  vec3 skyColor(vec3 dir) {
    vec3 col = skyHaze(dir);
    // Stars, twinkling on their own clock.
    vec3 cell = floor(dir * 260.0);
    float h = hash3(cell);
    float star = step(0.9972, h) * smoothstep(0.06, 0.3, dir.y);
    float tw = 0.55 + 0.45 * sin(uTime * (1.0 + 3.0 * hash3(cell + 3.1)) + h * 40.0);
    col += vec3(0.85, 0.9, 1.0) * star * tw;
    // Aurora: green at the base of the curtains, cyan and violet toward the top.
    float vpos;
    float a = aurora(dir, vpos);
    vec3 ac = mix(vec3(0.15, 1.0, 0.45), vec3(0.2, 0.75, 1.0), smoothstep(0.1, 0.6, vpos));
    ac = mix(ac, vec3(0.65, 0.3, 1.0), smoothstep(0.55, 1.0, vpos));
    col += ac * a * uAurora.x * 1.3;
    return col;
  }

  vec3 applyFog(vec3 color, vec3 world, vec2 range, float keep) {
    vec3 toFrag = world - cameraPosition;
    float dist = length(toFrag);
    float fog = smoothstep(range.x, range.y, dist);
    return mix(color, skyHaze(toFrag / dist), fog * (1.0 - keep));
  }
`;

// Voxel boxes (banks, archipelagos, trees, crystals, portals): one instanced unit box per descriptor entry.
// Instance attributes (see logic.ts BOX_STRIDE): aA = (x, d, y0, y1), aB = (sx, sd, kind, lift), aC = (drift, phase).
const BOX_VERTEX = /* glsl */ `
  attribute vec4 aA;
  attribute vec4 aB;
  attribute vec2 aC;
  uniform float uTime;
  uniform vec2 uRise; // x: distance ahead where an island starts to rise, y: where it reaches its altitude
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vLocal; // position in the unit box, centred: [-0.5, 0.5]^3
  varying vec3 vSize;
  varying float vKind;
  varying float vRise;
  varying float vLifted;
  varying float vPhase;
  varying float vHash;
  varying float vTop; // world height of the top of the box (before lifting)

  void main() {
    vec3 size = vec3(aB.x, aA.w - aA.z, aB.y);
    vec3 p = vec3(aA.x, aA.z, -aA.y) + position * size; // position: x, z in [-0.5, 0.5], y in [0, 1]
    // Signature: lifted boxes rise and drift toward the river as the camera approaches, then bob slowly.
    float ahead = aA.y - (-cameraPosition.z); // the camera travels toward -z
    float rise = 1.0 - smoothstep(uRise.y, uRise.x, ahead);
    float lifted = step(0.001, aB.w);
    float bob = sin(uTime * 0.35 + aC.y * 6.2831853) * 2.2 * rise * lifted;
    p.y += aB.w * rise + bob;
    p.x += aC.x * rise;
    vHash = fract(sin(dot(aA.xy, vec2(12.9898, 78.233))) * 43758.5453);
    // Leaves sway gently on their tree's clock (phase): a shared shift, so the blocks of one crown stay together.
    if (aB.z > 1.5 && aB.z < 2.5 || aB.z > 5.5) p.x += sin(uTime * 0.7 + aC.y * 6.2831853) * 0.12;
    vWorld = p;
    vNormal = normal;
    vLocal = position - vec3(0.0, 0.5, 0.0);
    vSize = size;
    vKind = aB.z;
    vRise = rise;
    vLifted = lifted;
    vPhase = aC.y;
    vTop = aA.w;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

// Shared helpers for the box fragment shaders: distance to the nearest edge of this face (world units), and terraces.
const BOX_COMMON = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec3 vSize;
  varying float vKind;
  varying float vRise;
  varying float vLifted;
  varying float vPhase;
  varying float vHash;
  varying float vTop;
  uniform vec2 uFog;

  float faceEdge() {
    vec3 e = (0.5 - abs(vLocal)) * vSize;
    vec3 n = abs(vNormal);
    if (n.y > 0.5) return min(e.x, e.z);
    if (n.x > 0.5) return min(e.y, e.z);
    return min(e.x, e.y);
  }

  float lineMask(float dist, float width) {
    float w = max(width, fwidth(dist) * 1.2);
    return 1.0 - smoothstep(0.0, w, dist);
  }

  // Position on the box in metres, relative to its base corner (x, z) and in world height (y), before lifting.
  vec3 boxMetric() {
    vec3 m = (vLocal + 0.5) * vSize;
    m.y += vTop - vSize.y;
    return m;
  }

  // Texture coordinates (metres) on this face, with v up on the sides; horizontal faces use x and z.
  vec2 faceCoords(vec3 n, vec3 m) {
    vec3 a = abs(n);
    if (a.y > 0.5) return m.xz;
    if (a.x > 0.5) return vec2(n.x > 0.0 ? vSize.z - m.z : m.z, m.y);
    return vec2(n.z > 0.0 ? m.x : vSize.x - m.x, m.y);
  }

  float lighting(vec3 n) {
    vec3 L = normalize(vec3(0.35, 0.85, -0.4));
    return 0.42 + 0.5 * max(dot(n, L), 0.0) + 0.12 * max(n.y, 0.0);
  }
`;

// Terrain rock, trees: banks (ground group) and archipelagos (signature group) use this shader with their own material.
// Block textures (Faithful 32x): grass on top, a grass-edged layer below it, then dirt, stone and deepslate with depth.
const ROCK_FRAGMENT = /* glsl */ `
  precision highp float;
  ${SKY_GLSL}
  ${BOX_COMMON}
  ${ATLAS_GLSL}
  uniform float uSeamGlow; // banks: bass-lit seams; archipelagos: none (their own glow is the levitation light)
  uniform float uLevitate; // archipelagos only: glow under the rising rock

  void main() {
    vec3 n = normalize(vNormal);
    float kind = vKind;
    vec3 m = boxMetric(); // metres, before lifting, so the textures stay fixed on the rock
    float yLocal = (vLocal.y + 0.5) * vSize.y;
    float yWorld = m.y;
    float below = vTop - yWorld; // depth below the top of the column
    vec2 face = faceCoords(n, m);
    float under = step(n.y, -0.5);
    vec3 color;
    if (kind < 0.5) {
      // Rock column: one texture tile per ${TILE} m terrace.
      vec2 uv = face / ${TILE};
      vec2 dx = dFdx(uv), dy = dFdy(uv);
      if (n.y > 0.5) {
        color = atlas(uv, L_GRASS_TOP, dx, dy).rgb * GRASS_TINT;
      } else if (under > 0.5) {
        color = atlas(uv, L_DEEPSLATE, dx, dy).rgb;
      } else {
        float layer = max(0.0, floor(below / ${TILE} - 0.0001));
        float id = layer < 0.5 ? L_GRASS_SIDE : (layer < 2.5 ? L_DIRT : (layer < 8.5 ? L_STONE : L_DEEPSLATE));
        color = atlas(uv, id, dx, dy).rgb;
      }
    } else if (kind < 1.5) {
      // Trunk, branches and roots: one log tile per tree block.
      vec2 uv = face / ${TREE_BLOCK};
      color = atlas(uv, L_OAK_LOG, dFdx(uv), dFdy(uv)).rgb;
    } else {
      // Leaves: one leaf tile per tree block (a merged box spans several); the holes of the cutout leaves are filled
      // with the deep foliage colour (an opaque box cannot show its inside). Each block gets a slight brightness
      // jitter so merged boxes still read as separate blocks, and each tree a slight hue shift.
      vec2 uv = face / ${TREE_BLOCK};
      bool cherry = kind > 5.5;
      vec4 leaf = atlas(uv, cherry ? L_CHERRY_LEAVES : L_OAK_LEAVES, dFdx(uv), dFdy(uv));
      vec3 tint = cherry ? vec3(1.0) : FOLIAGE_TINT * 1.2 * mix(vec3(0.92, 1.0, 0.9), vec3(1.08, 1.0, 1.1), fract(vPhase * 7.31));
      vec3 hole = cherry ? vec3(0.42, 0.22, 0.30) : FOLIAGE_TINT * 0.3;
      vec3 block = floor((m - n * 0.01) / ${TREE_BLOCK});
      float jitter = 0.9 + 0.16 * fract(sin(dot(block, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      color = mix(hole, leaf.rgb / max(leaf.a, 0.01) * tint, leaf.a) * jitter;
    }
    color *= lighting(n);

    // Bass light on the voxel seams of the banks: box edges and terrace lines.
    float seam = lineMask(faceEdge(), 0.12);
    if (kind < 0.5 && abs(n.y) < 0.5) seam = max(seam, lineMask(abs(fract(yWorld / ${TILE} + 0.5) - 0.5) * ${TILE}, 0.08));
    vec3 glow = vec3(0.55, 0.3, 1.0) * seam * uSeamGlow * 0.55;

    // Levitation light under the islands while they rise and float, concentrated on the voxel seams.
    glow += vec3(1.0, 0.35, 0.85) * vLifted * vRise * uLevitate * under * (0.12 + 0.5 * seam);
    glow += vec3(0.9, 0.4, 1.0) * vLifted * vRise * uLevitate * 0.18 * (1.0 - smoothstep(0.0, 4.0, yLocal)) * step(abs(n.y), 0.5);

    color = applyFog(color, vWorld, uFog, 0.0) + glow * (1.0 - 0.7 * smoothstep(uFog.x, uFog.y, length(vWorld - cameraPosition)));
    gl_FragColor = vec4(color, 1.0);
  }
`;

// Luminous structures: crystals, portal frames and portal cores (the energy group).
const GLOW_FRAGMENT = /* glsl */ `
  precision highp float;
  ${SKY_GLSL}
  ${BOX_COMMON}
  ${ATLAS_GLSL}
  uniform float uPortal; // brightness from the energy

  void main() {
    vec3 n = normalize(vNormal);
    float kind = vKind;
    float pulse = 0.75 + 0.25 * sin(uTime * 1.3 + vPhase * 6.2831853);
    vec2 face = faceCoords(n, boxMetric());
    vec3 color;
    float keep = 0.0;
    if (kind < 3.5) {
      // Crystal: amethyst or prismarine, lit from within, brighter facet edges.
      bool teal = vHash < 0.5;
      vec2 uv = face / vSize.x;
      vec3 tex = atlas(uv, teal ? L_PRISMARINE : L_AMETHYST, dFdx(uv), dFdy(uv)).rgb;
      vec3 tint = teal ? vec3(0.3, 0.95, 0.85) : vec3(0.75, 0.45, 1.0);
      float edge = lineMask(faceEdge(), 0.25);
      color = tex * (0.55 + 0.8 * uPortal * pulse) + tint * edge * (0.3 + 0.7 * uPortal);
      keep = 0.5;
    } else if (kind < 4.5) {
      // Portal frame: crying obsidian; its glowing purple tears brighten with the energy.
      vec2 uv = face / vSize.x;
      vec3 tex = atlas(uv, L_CRYING_OBSIDIAN, dFdx(uv), dFdy(uv)).rgb;
      float tears = smoothstep(0.3, 0.6, max(tex.r, tex.b));
      color = tex * lighting(n) + tex * tears * uPortal * pulse * 1.3;
      keep = 0.3;
    } else {
      // Portal core: the animated portal texture (20 frames per second of track time), facing the river.
      float tile = vSize.z / max(1.0, floor(vSize.z / 2.5 + 0.5));
      vec2 uv = face / tile;
      float frame = mod(floor(uTime * 20.0 + vPhase * ${PORTAL_FRAMES.toFixed(1)}), ${PORTAL_FRAMES.toFixed(1)});
      vec3 tex = atlas(uv, L_PORTAL + frame, dFdx(uv), dFdy(uv)).rgb;
      color = tex * (0.6 + 1.1 * uPortal);
      keep = 0.6;
    }
    gl_FragColor = vec4(applyFog(color, vWorld, uFog, keep), 1.0);
  }
`;

// Water: a mirror plane around the camera (the river, and the lake beyond the valley). It reflects the sky (with the
// aurora); waves flow on track time; glints sparkle with the highs.
const WATER_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = vec3(cameraPosition.x + position.x, 0.0, cameraPosition.z + position.z);
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  precision highp float;
  ${SKY_GLSL}
  varying vec3 vWorld;
  uniform vec2 uFog;
  uniform float uSparkle;

  void main() {
    vec3 toFrag = vWorld - cameraPosition;
    float dist = length(toFrag);
    vec3 view = toFrag / dist;
    vec2 p = vWorld.xz;
    float t = uTime;
    // Gentle waves flowing toward the camera; they flatten with distance so the far water does not shimmer.
    float amp = 0.07 / (1.0 + dist * 0.012);
    vec2 g = vec2(0.0);
    g += vec2(0.21, 0.13) * cos(p.x * 0.21 + p.y * 0.13 - t * 1.3);
    g += vec2(-0.17, 0.29) * cos(-p.x * 0.17 + p.y * 0.29 - t * 1.7);
    g += vec2(0.53, -0.41) * cos(p.x * 0.53 - p.y * 0.41 - t * 2.3) * 0.5;
    vec3 n = normalize(vec3(-g.x * amp * 4.0, 1.0, -g.y * amp * 4.0));
    vec3 refl = reflect(view, n);
    refl.y = abs(refl.y);
    float fresnel = 0.25 + 0.75 * pow(1.0 - max(dot(-view, n), 0.0), 3.0);
    vec3 deep = vec3(0.04, 0.05, 0.16);
    vec3 color = mix(deep, skyColor(refl) * 0.9, fresnel);
    // Glints: random cells light up briefly, more of them with the highs; only near the camera.
    vec2 cell = floor(p * 0.9);
    float slot = floor(t * 5.0 + hash2(cell) * 10.0);
    float glint = step(1.0 - 0.012 * uSparkle, hash2(cell + slot * 0.618)) * (1.0 - smoothstep(60.0, 260.0, dist));
    vec2 f = fract(p * 0.9) - 0.5;
    glint *= 1.0 - smoothstep(0.0, 0.25, length(f));
    color += vec3(0.85, 0.95, 1.0) * glint * 1.6;
    gl_FragColor = vec4(applyFog(color, vWorld, vec2(uFog.x * 2.0, uFog.y * 2.4), 0.0), 1.0);
  }
`;

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  precision highp float;
  ${SKY_GLSL}
  varying vec3 vDir;
  void main() {
    gl_FragColor = vec4(skyColor(normalize(vDir)), 1.0);
  }
`;

// Drifting cubes: each has a fixed world position (plus a slow sway on track time) that wraps inside a box kept mostly
// ahead of the camera, so the camera flies through them. Onsets (flux) kick their rotation and flash their edges.
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
  varying float vSize;

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
    c.y = uBox.y + r.y * uBox.z + sin(uTime * (0.15 + 0.2 * r.w) + r.x * 6.2831) * 3.0;
    float ahead = cameraPosition.z - c.z;
    // Shrink to nothing where the box wraps (far end, sides) and right next to the camera, so nothing pops.
    float fade = smoothstep(uBox.w - ${CUBE_BEHIND.toFixed(1)}, (uBox.w - ${CUBE_BEHIND.toFixed(1)}) * 0.75, ahead)
      * smoothstep(0.5 * uBox.x, 0.4 * uBox.x, abs(c.x - cameraPosition.x))
      * smoothstep(-${CUBE_BEHIND.toFixed(1)}, -${(CUBE_BEHIND * 0.5).toFixed(1)}, ahead);
    float size = (1.2 + 6.0 * r.w * r.w) * fade;
    vec3 axis = normalize(vec3(r.x, r.y, r.z) - 0.5 + 0.001);
    float angle = uTime * (0.08 + 0.25 * r.y) + r.z * 6.2831 + uKick * (0.6 + r.x);
    vec3 local = rotate(position, axis, angle);
    vWorld = c + local * size;
    vNormal = rotate(normal, axis, angle);
    vLocal = position;
    vHash = r.w + r.x * 3.1;
    vSize = size;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const CUBE_FRAGMENT = /* glsl */ `
  precision highp float;
  ${SKY_GLSL}
  ${ATLAS_GLSL}
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying float vHash;
  varying float vSize;
  uniform vec2 uFog;
  uniform float uCubeGlow;

  void main() {
    vec3 n = normalize(vNormal);
    float k = fract(vHash);
    // One block per cube: amethyst, purpur or glowstone.
    float id = k < 0.45 ? L_AMETHYST : (k < 0.8 ? L_PURPUR : L_GLOWSTONE);
    vec3 a = abs(vLocal) * 2.0;
    vec2 uv = (a.x > 0.999 ? vLocal.zy : (a.y > 0.999 ? vLocal.xz : vLocal.xy)) + 0.5;
    vec3 base = atlas(uv, id, dFdx(uv), dFdy(uv)).rgb;
    vec3 L = normalize(vec3(0.35, 0.85, -0.4));
    vec3 color = base * (0.45 + 0.55 * max(dot(n, L), 0.0));
    if (k >= 0.8) color = mix(color, base, 0.6); // glowstone is a light source
    // Edge distance on this face of the unit cube (local coordinates are not rotated).
    vec3 e = 0.5 - abs(vLocal);
    float edge = a.x > 0.999 ? min(e.y, e.z) : (a.y > 0.999 ? min(e.x, e.z) : min(e.x, e.y));
    float line = 1.0 - smoothstep(0.0, max(0.06, fwidth(edge) * 1.5), edge);
    vec3 glow = mix(vec3(0.3, 1.0, 0.9), vec3(0.8, 0.4, 1.0), step(0.5, fract(vHash * 5.3))) * line * uCubeGlow;
    gl_FragColor = vec4(applyFog(color, vWorld, uFog, 0.0) + glow * 0.8, 1.0);
  }
`;

// Horizon ring: voxel peaks standing in the lake far beyond the valley, around the camera. Each column's place and size
// are a hash of its slot and the world salt; heights follow a few broad peaks so the skyline reads as mountains.
const RING_VERTEX = /* glsl */ `
  attribute float aSlot;
  uniform float uSalt;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vY;
  varying float vH;

  float h11(float n) { return fract(sin(n * 127.1 + uSalt * 311.7) * 43758.5453); }
  float noise1(float x) {
    float i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(h11(i + 500.0), h11(i + 501.0), f);
  }

  void main() {
    float id = aSlot;
    float a = (id + h11(id) * 0.8) / ${RING.count.toFixed(1)} * 6.2831853;
    float radius = ${RING.inner.toFixed(1)} + ${RING.depth.toFixed(1)} * h11(id + 0.3);
    float peaks = pow(noise1(a * 2.2 + uSalt), 2.0) * 0.7 + pow(noise1(a * 6.0 + 40.0), 3.0) * 0.6;
    float height = 30.0 + 420.0 * peaks * (0.55 + 0.45 * h11(id + 0.5));
    height *= mix(0.6, 1.0, smoothstep(${RING.inner.toFixed(1)}, ${(RING.inner + RING.depth).toFixed(1)}, radius)); // back rows taller
    float spire = step(0.985, h11(id + 0.7)); // rare tall thin spires
    float width = mix(60.0 + 90.0 * h11(id + 0.2), 22.0, spire);
    height += spire * 380.0;
    // Snap heights to 20 m voxel layers.
    height = max(20.0, floor(height / 20.0) * 20.0);
    vec2 radial = vec2(sin(a), -cos(a));
    vec2 tangent = vec2(cos(a), sin(a));
    vec2 xz = radial * radius + tangent * position.x * width + radial * position.z * width;
    float y = mix(-20.0, height, position.y);
    vY = y;
    vH = height;
    vWorld = vec3(cameraPosition.x + xz.x, y, cameraPosition.z + xz.y);
    vNormal = vec3(normal.x * tangent.x + normal.z * radial.x, normal.y, normal.x * tangent.y + normal.z * radial.y);
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const RING_FRAGMENT = /* glsl */ `
  precision highp float;
  ${SKY_GLSL}
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vY;
  varying float vH;

  void main() {
    vec3 n = normalize(vNormal);
    vec3 L = normalize(vec3(0.35, 0.85, -0.4));
    vec3 color = mix(vec3(0.2, 0.1, 0.35), vec3(0.42, 0.22, 0.55), vY / max(vH, 1.0)) * (0.55 + 0.45 * max(dot(n, L), 0.0));
    float layer = abs(fract(vY / 20.0 + 0.5) - 0.5) * 20.0;
    color *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, max(0.8, fwidth(vY) * 1.5), layer));
    vec3 toFrag = vWorld - cameraPosition;
    // Heavy haze at the base (mist on the lake), lighter on the peaks: distant silhouettes, as in the references.
    float fog = mix(0.92, 0.55, smoothstep(0.0, 260.0, vY));
    gl_FragColor = vec4(mix(color, skyHaze(normalize(toFrag)), fog), 1.0);
  }
`;

interface SegmentMeshes {
  meshes: THREE.Mesh[];
  mood: [number, number];
}

export class VoxelScene implements ScenarioScene {
  readonly scene = new THREE.Scene();
  readonly background = HORIZON;

  private readonly segments = new Map<number, SegmentMeshes>();
  // Unit box (x, z in [-0.5, 0.5], y in [0, 1]) shared on the CPU side; every geometry wraps it in its own attributes,
  // because disposing a geometry frees the GPU buffers of its attributes.
  private readonly boxPosition: Float32Array;
  private readonly boxNormal: Float32Array;
  private readonly boxIndex: Uint16Array;
  /** Uniforms shared by every material (sky, fog colour, clock). */
  private readonly shared = {
    uTime: { value: 0 },
    uSalt: { value: 1 },
    uMood: { value: 0.5 },
    uAurora: { value: new THREE.Vector2(0.6, 0.6) },
    uFog: { value: new THREE.Vector2(...FOG_RANGE) },
    uAtlas: { value: null as THREE.DataArrayTexture | null },
  };
  private readonly groundMaterial: THREE.ShaderMaterial;
  private readonly islandMaterial: THREE.ShaderMaterial;
  private readonly glowMaterial: THREE.ShaderMaterial;
  private readonly waterMaterial: THREE.ShaderMaterial;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly cubeMaterial: THREE.ShaderMaterial;
  private readonly ringMaterial: THREE.ShaderMaterial;
  private readonly atlas = new VoxelAtlas();
  private readonly fixed: THREE.Mesh[] = [];
  private readonly sky: THREE.Mesh;
  private mood = 0.5;

  constructor() {
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.boxPosition = Float32Array.from(box.getAttribute('position').array as Float32Array);
    this.boxNormal = Float32Array.from(box.getAttribute('normal').array as Float32Array);
    this.boxIndex = Uint16Array.from(box.index!.array as ArrayLike<number>);
    box.dispose();
    this.shared.uAtlas.value = this.atlas.texture;

    const rise = { uRise: { value: new THREE.Vector2(RISE.start, RISE.done) } };
    const rock = (seamGlow: number, levitate: number) => new THREE.ShaderMaterial({
      vertexShader: BOX_VERTEX,
      fragmentShader: ROCK_FRAGMENT,
      uniforms: { ...this.shared, ...rise, uSeamGlow: { value: seamGlow }, uLevitate: { value: levitate } },
    });
    this.groundMaterial = rock(0.3, 0);
    this.islandMaterial = rock(0, 1);
    this.glowMaterial = new THREE.ShaderMaterial({
      vertexShader: BOX_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      uniforms: { ...this.shared, ...rise, uPortal: { value: 0.5 } },
    });

    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: this.shared,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), this.skyMaterial);
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this.waterMaterial = new THREE.ShaderMaterial({
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      uniforms: { ...this.shared, uSparkle: { value: 0.5 } },
    });
    const water = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE, 1, 1).rotateX(-Math.PI / 2);
    this.addFixed(new THREE.Mesh(water, this.waterMaterial));

    this.ringMaterial = new THREE.ShaderMaterial({ vertexShader: RING_VERTEX, fragmentShader: RING_FRAGMENT, uniforms: this.shared });
    this.addFixed(new THREE.Mesh(this.instancedBoxes('aSlot', RING.count, 1, (i) => [i], false), this.ringMaterial));

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
    this.addFixed(new THREE.Mesh(
      this.instancedBoxes('aRand', CUBE_COUNT, 4, (i) => [fixedHash(i * 4), fixedHash(i * 4 + 1), fixedHash(i * 4 + 2), fixedHash(i * 4 + 3)], true),
      this.cubeMaterial,
    ));
  }

  ready(): Promise<void> {
    return this.atlas.loaded;
  }

  private addFixed(mesh: THREE.Mesh): void {
    mesh.frustumCulled = false; // the vertex shaders place these around the camera
    this.fixed.push(mesh);
    this.scene.add(mesh);
  }

  /** Unit-box geometry instanced `count` times with one per-instance attribute; `centred` moves y from [0, 1] to [-0.5, 0.5]. */
  private instancedBoxes(name: string, count: number, itemSize: number, values: (i: number) => number[], centred: boolean): THREE.InstancedBufferGeometry {
    const geometry = this.boxGeometry();
    if (centred) {
      const shifted = Float32Array.from(this.boxPosition);
      for (let i = 1; i < shifted.length; i += 3) shifted[i]! -= 0.5;
      geometry.setAttribute('position', new THREE.BufferAttribute(shifted, 3));
    }
    const data = new Float32Array(count * itemSize);
    for (let i = 0; i < count; i++) data.set(values(i), i * itemSize);
    geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data, itemSize));
    geometry.instanceCount = count;
    return geometry;
  }

  private boxGeometry(): THREE.InstancedBufferGeometry {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.boxPosition, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(this.boxNormal, 3));
    geometry.setIndex(new THREE.BufferAttribute(this.boxIndex, 1));
    return geometry;
  }

  /** One instanced mesh for a box buffer of the segment, or null when the buffer is empty. */
  private boxMesh(data: Float32Array, startDistance: number, material: THREE.ShaderMaterial): THREE.Mesh | null {
    const count = data.length / BOX_STRIDE;
    if (count === 0) return null;
    const geometry = this.boxGeometry();
    const buffer = new THREE.InstancedInterleavedBuffer(data, BOX_STRIDE, 1);
    geometry.setAttribute('aA', new THREE.InterleavedBufferAttribute(buffer, 4, 0));
    geometry.setAttribute('aB', new THREE.InterleavedBufferAttribute(buffer, 4, 4));
    geometry.setAttribute('aC', new THREE.InterleavedBufferAttribute(buffer, 2, 8));
    geometry.instanceCount = count;
    // Generous bounds (banks are 460 m wide; islands rise up to ~200 m and drift), so frustum culling still drops the
    // segments behind the camera without ever hiding a lifted island.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 80, -(startDistance + SEGMENT_LENGTH / 2)), 340);
    return new THREE.Mesh(geometry, material);
  }

  addSegment(index: number, descriptor: unknown, startDistance: number): void {
    const seg = descriptor as VoxelSegment;
    const meshes = [
      this.boxMesh(seg.ground, startDistance, this.groundMaterial),
      this.boxMesh(seg.islands, startDistance, this.islandMaterial),
      this.boxMesh(seg.glow, startDistance, this.glowMaterial),
    ].filter((m): m is THREE.Mesh => m !== null);
    for (const mesh of meshes) this.scene.add(mesh);
    this.segments.set(index, { meshes, mood: seg.mood });
  }

  removeSegment(index: number): void {
    const seg = this.segments.get(index);
    if (!seg) return;
    for (const mesh of seg.meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose(); // the shared materials stay alive
    }
    this.segments.delete(index);
  }

  /** Slow mood at the camera from the loaded segment under it (pure function of the descriptors and the distance). */
  private moodAt(distance: number): number {
    const index = Math.floor(distance / SEGMENT_LENGTH);
    const seg = this.segments.get(index);
    if (!seg) return this.mood; // still loading: hold the last value
    const f = Math.min(1, Math.max(0, distance / SEGMENT_LENGTH - index));
    return seg.mood[0] + (seg.mood[1] - seg.mood[0]) * f;
  }

  update(params: unknown, cameraPosition: THREE.Vector3, trackTime: number): void {
    const p = params as VoxelParams;
    // Shared: clock, world salt, horizon mood (fog colour of every group).
    this.shared.uTime.value = trackTime;
    this.shared.uSalt.value = p.worldSalt;
    this.mood = this.moodAt(-cameraPosition.z);
    this.shared.uMood.value = this.mood;
    // Ground (banks): seams glow with the bass.
    this.groundMaterial.uniforms.uSeamGlow!.value = p.groundGlow;
    // Luminous structures: portals and crystals with the energy.
    this.glowMaterial.uniforms.uPortal!.value = p.portalGlow;
    // River: glints with the highs.
    this.waterMaterial.uniforms.uSparkle!.value = p.riverSparkle;
    // Aurora and sky: the mids.
    this.shared.uAurora.value.set(p.auroraGlow, p.auroraReach);
    // Drifting cubes: onsets.
    this.cubeMaterial.uniforms.uKick!.value = p.cubeKick;
    this.cubeMaterial.uniforms.uCubeGlow!.value = p.cubeGlow;
    this.sky.position.copy(cameraPosition);
  }

  dispose(): void {
    for (const index of [...this.segments.keys()]) this.removeSegment(index);
    for (const mesh of this.fixed) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.scene.remove(this.sky);
    this.sky.geometry.dispose();
    for (const material of [this.groundMaterial, this.islandMaterial, this.glowMaterial, this.waterMaterial, this.skyMaterial, this.cubeMaterial, this.ringMaterial]) {
      material.dispose();
    }
    this.atlas.dispose();
  }
}
