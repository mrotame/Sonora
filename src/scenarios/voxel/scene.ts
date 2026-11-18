// Voxel Dreamscape: Three.js side (main thread). Turns the Worker's segment meshes into three meshes per segment (opaque
// blocks, translucent water, cutout plants) that share one block-texture atlas, plus the sky dome (gradient, square sun
// and moon, stars). The scene is lit and drawn in linear HDR and handed to the post pipeline (post.ts: volumetric clouds,
// light shafts, bloom, tone map). Materials write their visibility through the distance fog to alpha (the sky dome
// writes 0): that is where the clouds show through. Shaders are GLSL ES 3.00 (three.js adds the version header and the
// varying / gl_FragColor compatibility defines for ShaderMaterial). Every animation is a pure function of the track
// time, the camera position and baked attributes: there is no per-frame state.
// Vertex layout (see mesher.ts): position (3), then (layer, u, v, packed) with
// packed = face + 8 ao + 32 (4 x sky light) + 2048 (4 x block light) + 131072 flags.
import * as THREE from 'three';
import type { ScenarioScene } from '../types.ts';
import { TERRAIN } from './terrain.ts';
import type { MeshArrays } from './mesher.ts';
import { RAILS_NONE, voxelLogic, type VoxelParams, type VoxelSegment } from './logic.ts';
import { CART_FRAGMENT, CART_PIVOT, CART_VERTEX, minecartGeometry } from './minecart.ts';
import { RAILS, smoothRailSlopeAt } from './rails.ts';
import { ROAD } from './road.ts';
import type { FarSegment } from './far.ts';
import minecartUrl from './textures/minecart.png';
import { FLAGS_GLSL } from './blocks.ts';
import { pulseAt, type CavePulse } from './cavePulse.ts';
import { ATLAS_GLSL, LAVA_FRAMES, MAGMA_FRAMES, PORTAL_FRAMES, VoxelAtlas, WATER_FRAMES } from './textures.ts';
import { atmosphereAt, toLinear, type RGB } from './atmosphere.ts';
import { SKY_GLSL } from './skyGlsl.ts';
import { VoxelPost } from './post.ts';

const SEGMENT_LENGTH = voxelLogic.config.segmentLength;
/** Distance fog (m): starts at x, complete at y. The far field (far.ts) lies beyond the detailed volume, inside the fog. */
const FOG_RANGE = ((): readonly [number, number] => {
  // Derived from the detailed volume, so changing the chunks changes the fog with them: complete where the nearest edge of
  // the detailed terrain lies (the sides, TERRAIN.halfWidth; ahead, one segment less than the window, since the camera is
  // somewhere inside its own segment), which hides the far field almost at once. It starts at 45% of that.
  const { segmentLength, segmentsAhead } = voxelLogic.config;
  const end = Math.min(TERRAIN.halfWidth, (segmentsAhead - 1) * segmentLength);
  return [end * 0.45, end];
})();
/** Share of FOG_RANGE in the Nether (about 28..61 m with the default detailed volume; the game's fog_start 10 / fog_end 96 is shorter, widened to show the cavern's scale). */
const NETHER_FOG_SCALE = 0.16;
/** Volumetric cloud coverage from the baked mood (slow intensity 0..1): calm passages clear up, intense ones build up. */
const CLOUD_COVERAGE = [0.42, 0.62] as const;
/** Exposure at night, by day and in the Nether: a pure function of the hour, like an eye adapted to the light. */
const EXPOSURE = { night: 2.0, day: 1.0, nether: 1.3 } as const;
/** Time constants (s) of the smoothed drivers: portal and amethyst energy, cloud brightness. */
const ENERGY_SMOOTH_S = 0.25;
const CLOUD_SMOOTH_S = 0.6;
/** Water glints follow the highs this slowly: faster reads as random flicker unrelated to the music. */
const SPARKLE_SMOOTH_S = 1.5;
/** Caves: the breathing of their light follows the energy this slowly. */
const CAVE_BREATH_S = 0.6;
/**
 * Caves: gain of the block light (glowstone, lava) on the scene, before the breathing (0.75..1.25). Was 0.5, then 0.7,
 * until 2026-11-18 (user-requested twice: the caves were too dark).
 */
const CAVE_LIGHT = 0.9;
/**
 * Pulsed blocks (cave wall lamps, Nether glowstone): their glow on a pulse of 1 (x the 3.6 of a steady light source), and
 * how much of the scene light their glowing pixels keep between pulses (almost dark, so the pulses stand out). The peak
 * was 2.4 until 2026-11-18 (user-requested: a slightly lower peak).
 */
const PULSE_PEAK = 1.9;
const PULSE_DARK = 0.15;
/**
 * Drifting cubes (same logic as before): a box of the world kept around the camera ([width, min height, height span, depth]).
 * They keep away from the road: nothing closer than CUBE_CLEAR_X to the road's side or lower than CUBE_CLEAR_Y above it.
 */
const CUBE_COUNT = 90;
const CUBE_BOX = [300, 30, 90, 420] as const;
const CUBE_BEHIND = 40;
const CUBE_CLEAR_X = 30;
const CUBE_CLEAR_Y = 28;

/** Nether atmosphere: the haze (display colour) and the ambient light of the lava sea (linear, warmer from below). */
const NETHER_FOG = new THREE.Color(0.2, 0.03, 0.03); // the biome's fog_color #330808, a touch brighter
const NETHER_FOG_LINEAR: RGB = toLinear([NETHER_FOG.r, NETHER_FOG.g, NETHER_FOG.b]);
const NETHER_AMBIENT_UP: RGB = [0.22, 0.095, 0.07];
const NETHER_AMBIENT_DOWN: RGB = [0.38, 0.15, 0.06];

// Waving plants (grass, flowers, sugar cane): the top vertices of cross quads sway with a wind that is a pure function
// of the track time and the world position; bottom vertices stay on the ground. Rails, fences and leaves do not move.
const WAVE_GLSL = /* glsl */ `
  vec3 wave(vec3 world, float packed, float v, float layer) {
    float flags = floor(packed / 131072.0 + 0.5);
    bool cutout = mod(floor(flags / 4.0), 2.0) > 0.5;
    bool rail = abs(layer - L_RAIL) < 0.5 || abs(layer - L_POWERED_RAIL) < 0.5;
    float face = mod(floor(packed + 0.5), 8.0);
    if (!cutout || rail || abs(face - 2.0) > 0.5 || v < 0.5) return world;
    float gust = 0.6 + 0.4 * sin(uTime * 0.7 + world.x * 0.05 + world.z * 0.03);
    vec2 sway = vec2(sin(uTime * 1.9 + world.x * 0.6 + world.z * 0.4), cos(uTime * 1.6 + world.z * 0.7 - world.x * 0.3));
    world.xz += sway * 0.09 * gust;
    return world;
  }
`;

const VERTEX = /* glsl */ `
  ${ATLAS_GLSL}
  uniform float uTime;
  ${WAVE_GLSL}
  attribute vec4 aTex; // layer, u, v, packed
  varying vec3 vWorld;
  varying vec3 vUv; // u, v (tiles), layer
  varying vec4 vInfo; // face, ao (0..3), sky light (0..15), flags
  varying float vBlockLight; // 0..15
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    float packed = aTex.w;
    float layer = aTex.x;
    world.xyz = wave(world.xyz, packed, aTex.z, layer);
    vWorld = world.xyz;
    vUv = vec3(aTex.y, aTex.z, layer);
    vInfo = vec4(mod(packed, 8.0), mod(floor(packed / 8.0), 4.0), mod(floor(packed / 32.0), 64.0) / 4.0, floor(packed / 131072.0));
    vBlockLight = mod(floor(packed / 2048.0), 64.0) / 4.0;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const COMMON = /* glsl */ `
  precision highp float;
  ${ATLAS_GLSL}
  ${SKY_GLSL}
  uniform float uTime;
  uniform vec2 uFog;
  uniform float uEnergy; // portals
  // Pulsed light blocks (cavePulse.ts): the band levels this frame, and the slow breathing of the cave light (smoothed energy).
  uniform float uPulseBass; // 0..1: the bass level over its local floor, this frame
  uniform float uPulseMid;  // 0..1: the same for the mids
  uniform float uCaveBreath;
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform vec3 uAmbUp;
  uniform vec3 uAmbDown;
  varying vec3 vWorld;
  varying vec3 vUv;
  varying vec4 vInfo;
  varying float vBlockLight;
  // Far-field meshes only: the area the detailed segments cover (x min, x max, d min, d max), where they are not drawn.
  uniform vec4 uNearClip;

  ${FLAGS_GLSL}

  void clipFar() {
  #ifdef FAR_LAYER
    float d = -vWorld.z;
    if (vWorld.x > uNearClip.x + 0.01 && vWorld.x < uNearClip.y - 0.01 && d > uNearClip.z + 0.01 && d < uNearClip.w - 0.01) discard;
  #endif
  }

  // Far-field meshes only: a tone per block-sized patch (the far cells are boxes of 2 to 8 blocks that the mip chain turns
  // into one flat colour at a distance), so the distant land keeps a mottled, textured look instead of a smooth paint.
  float farHash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float farTone(vec3 n) {
  #ifdef FAR_LAYER
    vec3 p = vWorld - n * 0.05;
    float cellTone = farHash(floor(vec3(p.x, p.y * 0.5, p.z) / 3.0));
    float broad = farHash(floor(vec3(p.x, 0.0, p.z) / 48.0) + 17.0);
    return mix(0.84, 1.14, cellTone) * mix(0.94, 1.06, broad);
  #else
    return 1.0;
  #endif
  }

  float frameCount(float layer) {
    if (abs(layer - L_LAVA) < 0.5) return ${LAVA_FRAMES.toFixed(1)};
    if (abs(layer - L_MAGMA) < 0.5) return ${MAGMA_FRAMES.toFixed(1)};
    if (abs(layer - L_PORTAL) < 0.5) return ${PORTAL_FRAMES.toFixed(1)};
    return ${WATER_FRAMES.toFixed(1)};
  }

  // Face index (0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z) to its normal. Rounded first: it reaches here interpolated.
  vec3 faceNormal(float face) {
    float f = floor(face + 0.5);
    if (f < 0.5) return vec3(1.0, 0.0, 0.0);
    if (f < 1.5) return vec3(-1.0, 0.0, 0.0);
    if (f < 2.5) return vec3(0.0, 1.0, 0.0);
    if (f < 3.5) return vec3(0.0, -1.0, 0.0);
    if (f < 4.5) return vec3(0.0, 0.0, 1.0);
    return vec3(0.0, 0.0, -1.0);
  }

  // Light level (0..15) to brightness: the block game's curve, steep near the source and long, dim tails.
  float brightness(float level) {
    float l = clamp(level / 15.0, 0.0, 1.0);
    return l / (4.0 - 3.0 * l);
  }

  // Lighting in linear HDR, in the style of the shader packs: ambient from the sky dome (upper and lower hemisphere,
  // scaled by the baked sky light, so caves, tunnels and overhangs darken), direct sun or moon light where the sky is
  // open (sky light near 15 stands in for a shadow map: under trees, roofs and in tunnels there is no direct light), and
  // warm block light from glowstone, lava and portals. Changes only with the hour: no music driver touches it.
  vec3 lighting(float sky, float block, vec3 n, float ao) {
    // The Nether has no sky light: its ambient (the glow of the lava sea) reaches everywhere.
    float skyB = mix(brightness(sky), 1.0, uNether);
    vec3 ambient = mix(uAmbDown, uAmbUp, n.y * 0.5 + 0.5) * skyB * mix(0.35, 1.0, ao);
    float open = smoothstep(11.5, 15.0, sky);
    float ndl = max(dot(n, uLightDir), 0.0);
    vec3 direct = uLightColor * ndl * open * mix(0.7, 1.0, ao);
    float bl = clamp(block / 15.0, 0.0, 1.0);
    float parabolic = (2.0 * bl - 1.0) * (2.0 * bl - 1.0);
    vec3 warm = mix(vec3(1.0, 0.45, 0.16), vec3(1.0, 0.82, 0.62), 0.8 * parabolic);
    // Caves (no sky light, not the Nether): dimmer block light, tinted red. It only breathes slowly with the energy: a
    // large surface pulsing on every beat reads as flicker (the beat lives in the wall lamps).
    float cave = (1.0 - uNether) * (1.0 - smoothstep(0.0, 3.0, sky));
    warm = mix(warm, vec3(1.0, 0.16, 0.06), 0.6 * cave);
    float caveGain = mix(1.0, ${CAVE_LIGHT.toFixed(2)} * (0.75 + 0.5 * uCaveBreath), cave);
    vec3 torch = warm * brightness(block) * 1.9 * caveGain * mix(0.55, 1.0, ao);
    return vec3(0.006) * mix(0.4, 1.0, ao) + ambient + direct + torch;
  }

  // Distance fog toward the colour of the sky behind the fragment, so far terrain melts into the sky. Alpha is what is
  // left of the fragment (1 - fog): the clouds show through the rest in the composite pass.
  vec4 applyFog(vec3 color, vec3 world) {
    vec3 toFrag = world - cameraPosition;
    float dist = length(toFrag);
    float range = mix(1.0, ${NETHER_FOG_SCALE}, uNether);
    float f = pow(smoothstep(uFog.x * range, uFog.y * range, dist), 1.35);
    return vec4(mix(color, skyBase(toFrag / max(dist, 1e-3)), f), 1.0 - f);
  }

  // Colour (linear) of the block at this fragment with its tint, texture animation, and (if cutout) its alpha.
  vec4 blockColor(out float emissive) {
    float flags = materialFlags(vInfo.w);
    float tint = mod(flags, 4.0) * (1.0 - flag(flags, 32.0)); // music-driven blocks keep these bits for their band
    float layer = floor(vUv.z + 0.5);
    if (flag(flags, 16.0) > 0.5) layer += mod(floor(uTime * 8.0), frameCount(layer));
    vec2 uv = vUv.xy;
    // Far field: the texture gradient is scaled down, so the mip chain keeps one more level of detail at a distance.
    float sharp = 1.0;
  #ifdef FAR_LAYER
    sharp = 0.55;
  #endif
    vec4 tex = atlas(uv, layer, dFdx(uv) * sharp, dFdy(uv) * sharp);
    vec3 rgb = tex.rgb;
    if (tint > 2.5) rgb *= BIRCH_TINT;
    else if (tint > 1.5) rgb *= FOLIAGE_TINT * 1.1;
    else if (tint > 0.5) rgb *= GRASS_TINT;
    if (flag(flags, 64.0) > 0.5) rgb *= SPRUCE_TINT;
    emissive = flag(flags, 8.0);
    return vec4(pow(rgb, vec3(2.2)), tex.a);
  }

  // Light sources (glowstone, lava, magma, portal) glow above white (HDR), so the bloom picks them up; constant
  // brightness, day and night. Everything else takes the lighting of its face.
  vec3 shade(vec3 rgb, float emissive) {
    float ao = vInfo.y / 3.0;
    vec3 n = faceNormal(vInfo.x);
    vec3 lit = rgb * farTone(n) * lighting(vInfo.z, vBlockLight, n, ao);
    // Pulsed blocks (FLAG.energy with a kind in the low bits: 1 bass, 2 mids): almost dark between their pulses (the
    // texture lit by the scene and dimmed to PULSE_DARK) and glowing on them, following the level of their band this frame
    // as the Synthwave mountains do (Nether glowstone on the bass, cave wall lamps on the mids). The light they cast is
    // steady. The portal (kind 0) keeps its steady glow.
    float flags = materialFlags(vInfo.w);
    float kind = mod(flags, 4.0) * flag(flags, 32.0);
    if (kind > 0.5) {
      float glow = ${PULSE_PEAK.toFixed(2)} * (kind < 1.5 ? uPulseBass : uPulseMid);
      return lit * mix(1.0, ${PULSE_DARK.toFixed(2)}, emissive) + rgb * 3.6 * glow * emissive;
    }
    return mix(lit, rgb * 3.6, emissive);
  }
`;

const SOLID_FRAGMENT = /* glsl */ `
  ${COMMON}
  void main() {
    clipFar();
    float emissive;
    vec4 c = blockColor(emissive);
    vec3 rgb = c.rgb;
    // Leaves are opaque meshes: the holes of the cutout texture show a dark foliage colour instead of what is behind.
    if (flag(materialFlags(vInfo.w), 4.0) > 0.5) rgb = mix(pow(FOLIAGE_TINT * 0.28, vec3(2.2)), rgb, step(0.5, c.a));
    gl_FragColor = applyFog(shade(rgb, emissive), vWorld);
  }
`;

const CROSS_FRAGMENT = /* glsl */ `
  ${COMMON}
  void main() {
    float emissive;
    vec4 c = blockColor(emissive);
    if (c.a < 0.5) discard;
    gl_FragColor = applyFog(shade(c.rgb, emissive), vWorld);
  }
`;

// Water: the block texture tinted blue and lit like the blocks, plus a reflection of the sky with small moving waves,
// Fresnel (more reflective at grazing angles), a sharp sun highlight that blooms, and glints on the highs.
const WATER_FRAGMENT = /* glsl */ `
  ${COMMON}
  uniform float uSparkle;
  void main() {
    clipFar();
    float emissive;
    vec4 c = blockColor(emissive);
    vec3 base = c.rgb * vec3(0.12, 0.26, 0.75) * lighting(vInfo.z, vBlockLight, vec3(0.0, 1.0, 0.0), 1.0);
    vec3 view = normalize(vWorld - cameraPosition);
    vec2 p = vWorld.xz;
    vec2 slope = vec2(cos(p.x * 0.9 + uTime * 1.3) + 0.6 * cos(p.x * 2.3 - p.y * 1.1 + uTime * 2.1),
                      cos(p.y * 0.8 + uTime * 1.1) + 0.6 * cos(p.y * 2.1 + p.x * 1.4 + uTime * 1.7)) * 0.035;
    vec3 n = normalize(vec3(slope.x, 1.0, slope.y));
    vec3 r = reflect(view, n);
    r.y = abs(r.y);
    float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(-view, n), 0.0, 1.0), 5.0);
    float open = smoothstep(12.0, 15.0, vInfo.z);
    vec3 refl = skyBase(r) * (0.3 + 0.7 * brightness(vInfo.z));
    vec3 spec = uSunColor * pow(max(dot(r, uSunDir), 0.0), 600.0) * 40.0 * open;
    vec3 rgb = mix(base, refl, fres) + spec;
    // Glints on the highs: quarter-block points, each with its own phase, that fade in and out smoothly (a hard per-block
    // on/off re-rolled every frame step read as whole blocks flickering blue/white).
    vec2 cell = floor(vWorld.xz * 4.0);
    vec3 q = fract(vec3(cell.xy, cell.x + cell.y) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    float pick = fract((q.x + q.y) * q.z);
    float phase = fract((q.x + q.z) * q.y);
    // The set of glinting points is fixed; each one swells and fades over several seconds. The (smoothed) highs only
    // scale how bright they get, so the music never makes points pop in or out.
    float pulse = pow(0.5 - 0.5 * cos(uTime * 0.5 + phase * 6.2832), 4.0);
    float glint = step(0.95, pick) * pulse * uSparkle;
    rgb += uSunColor * 1.2 * open * glint * (1.0 - smoothstep(30.0, 120.0, length(vWorld - cameraPosition)));
    gl_FragColor = vec4(applyFog(rgb, vWorld).rgb, mix(0.72, 0.95, fres));
  }
`;

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Sky dome: the shared sky colour (skyBase), square sun and moon (block textures, HDR so they bloom), night stars.
// Alpha 0: everything here lies behind the clouds.
const SKY_FRAGMENT = /* glsl */ `
  precision highp float;
  ${ATLAS_GLSL}
  ${SKY_GLSL}
  uniform float uDay;
  uniform float uSalt;
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
    vec3 col = skyBase(d);
    if (uNether < 0.5) {
      vec3 cell = floor(d * 220.0);
      float h = hash3(cell);
      float star = step(0.9965, h) * smoothstep(0.02, 0.25, d.y) * (1.0 - uDay) * (0.6 + 0.4 * sin(h * 80.0));
      col += vec3(star) * 0.6;
      // The sun and moon textures are bright shapes on an opaque black background (with a soft glow): they are added
      // to the sky, as the game does, so the black square disappears and only the light remains.
      vec4 sun = body(d, uSunDir, 0.085, L_SUN);
      vec3 sunTint = mix(vec3(1.0, 0.55, 0.3), vec3(1.0), smoothstep(0.0, 0.3, uSunDir.y));
      col += pow(sun.rgb, vec3(2.2)) * sun.a * sunTint * 9.0;
      vec4 moon = body(d, -uSunDir, 0.07, L_MOON);
      col += pow(moon.rgb, vec3(2.2)) * moon.a * 1.6 * (1.0 - uDay);
    }
    gl_FragColor = vec4(col, 0.0);
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
  ${SKY_GLSL}
  uniform float uCubeGlow;
  uniform vec2 uFog;
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform vec3 uAmbUp;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying float vHash;

  void main() {
    vec3 n = normalize(vNormal);
    float k = fract(vHash);
    // One block per cube: amethyst, crying obsidian or glowstone.
    float id = k < 0.45 ? L_AMETHYST : (k < 0.8 ? L_CRYING_OBSIDIAN : L_GLOWSTONE);
    vec3 a = abs(vLocal) * 2.0;
    vec2 uv = (a.x > 0.999 ? vLocal.zy : (a.y > 0.999 ? vLocal.xz : vLocal.xy)) + 0.5;
    vec3 base = pow(atlas(uv, id, dFdx(uv), dFdy(uv)).rgb, vec3(2.2));
    vec3 color = base * (uAmbUp * (0.6 + 0.4 * n.y) + uLightColor * max(dot(n, uLightDir), 0.0));
    if (k >= 0.8) color = base * 2.6; // glowstone is a light source
    vec3 e = 0.5 - abs(vLocal);
    float edge = a.x > 0.999 ? min(e.y, e.z) : (a.y > 0.999 ? min(e.x, e.z) : min(e.x, e.y));
    float line = 1.0 - smoothstep(0.0, max(0.06, fwidth(edge) * 1.5), edge);
    vec3 glow = mix(vec3(0.3, 1.0, 0.9), vec3(0.8, 0.4, 1.0), step(0.5, fract(vHash * 5.3))) * line * uCubeGlow;
    vec3 toFrag = vWorld - cameraPosition;
    float dist = length(toFrag);
    float f = smoothstep(uFog.y * 1.2, uFog.y * 2.6, dist);
    gl_FragColor = vec4(mix(color + glow * 2.0, skyBase(toFrag / dist), f), 1.0 - f);
  }
`;

/** Half-length (m) of the flash along the road around a portal: about 0.6 s at cruise speed. */
const FLASH_HALF = 10;

interface SegmentMeshes {
  /** Overworld meshes (shown while the camera is in the overworld) and Nether meshes (shown inside the Nether). */
  meshes: THREE.Mesh[];
  nether: THREE.Mesh[];
  mood: [number, number];
  hour: [number, number];
  nether0: number;
  portals: number[];
  cavePulse: CavePulse;
  /** Nether rail deck layers (offsets) of rows start - 1 .. start + length (VoxelSegment.rails). */
  rails: Int16Array | null;
  start: number;
}

const setRGB = (c: THREE.Color, v: RGB) => c.setRGB(v[0], v[1], v[2]);

export class VoxelScene implements ScenarioScene {
  readonly scene = new THREE.Scene();
  readonly background = new THREE.Color(0, 0, 0);

  private readonly segments = new Map<number, SegmentMeshes>();
  private readonly farSegments = new Map<number, THREE.Mesh[]>();
  /** Uniforms shared by every material and by the post pipeline (atmosphere: linear values). */
  private readonly shared = {
    uTime: { value: 0 },
    uDay: { value: 1 },
    uFog: { value: new THREE.Vector2(...FOG_RANGE) },
    uNearClip: { value: new THREE.Vector4(0, 0, 0, 0) },
    uEnergy: { value: 0.5 },
    uPulseBass: { value: 0 },
    uPulseMid: { value: 0 },
    uCaveBreath: { value: 0.5 },
    uNether: { value: 0 },
    uSalt: { value: 1 },
    uAtlas: { value: null as THREE.DataArrayTexture | null },
    uHorizon: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uSunset: { value: 0 },
    uLightDir: { value: new THREE.Vector3(0, 1, 0) },
    uLightColor: { value: new THREE.Color() },
    uAmbUp: { value: new THREE.Color() },
    uAmbDown: { value: new THREE.Color() },
  };
  private readonly solidMaterial: THREE.ShaderMaterial;
  private readonly crossMaterial: THREE.ShaderMaterial;
  private readonly waterMaterial: THREE.ShaderMaterial;
  private readonly farSolidMaterial: THREE.ShaderMaterial;
  private readonly farWaterMaterial: THREE.ShaderMaterial;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly atlas = new VoxelAtlas();
  private readonly post: VoxelPost;
  private readonly sky: THREE.Mesh;
  private readonly cubes: THREE.Mesh;
  private readonly cubeMaterial: THREE.ShaderMaterial;
  private readonly cart: THREE.Mesh;
  private readonly cartMaterial: THREE.ShaderMaterial;
  private cartTexture!: THREE.Texture;
  /** Resolves once the minecart texture is loaded (or failed), so the first Nether frame never shows a cart without it. */
  private readonly cartLoaded: Promise<void>;
  /** The minecart has a scene of its own, drawn over the world with a close near plane (see render). */
  private readonly cartScene = new THREE.Scene();
  private readonly cartCamera = new THREE.PerspectiveCamera();
  private inNether = false;
  private energy = 0.5;
  private cloudGlow = 0.5;
  private sparkle = 0.5;
  private lastLightT = 0;
  private caveBreath = 0.5;
  private cavePulseNow: CavePulse | null = null;
  private readonly pulseNow = { bass: 0, mid: 0 };
  private flash = 0;
  private mood = 0.5;
  private hour = 6.5;

  constructor() {
    this.shared.uAtlas.value = this.atlas.texture;
    const make = (fragmentShader: string, extra: Record<string, THREE.IUniform> = {}, options: THREE.ShaderMaterialParameters = {}) =>
      new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader, uniforms: { ...this.shared, ...extra }, ...options });
    this.solidMaterial = make(SOLID_FRAGMENT);
    this.crossMaterial = make(CROSS_FRAGMENT, {}, { side: THREE.DoubleSide });
    // Water blends its colour over what is behind it but keeps that pixel's alpha (the ground below is not fogged more
    // than the water), so the clouds do not show through a lake.
    const waterOptions: THREE.ShaderMaterialParameters = {
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    };
    const sparkle = { value: 0.5 };
    this.waterMaterial = make(WATER_FRAGMENT, { uSparkle: sparkle }, waterOptions);
    // The far field: the same shading, clipped where the detailed segments are.
    this.farSolidMaterial = make(SOLID_FRAGMENT, {}, { defines: { FAR_LAYER: 1 } });
    this.farWaterMaterial = make(WATER_FRAGMENT, { uSparkle: sparkle }, { ...waterOptions, defines: { FAR_LAYER: 1 } });

    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: { ...this.shared },
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), this.skyMaterial);
    this.sky.renderOrder = -2;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this.post = new VoxelPost(this.shared);

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

    this.cartLoaded = new Promise<void>((resolve) => {
      this.cartTexture = new THREE.TextureLoader().load(minecartUrl, () => resolve(), undefined, () => resolve());
    });
    this.cartTexture.magFilter = THREE.NearestFilter;
    this.cartTexture.minFilter = THREE.NearestFilter;
    this.cartTexture.colorSpace = THREE.NoColorSpace;
    this.cartMaterial = new THREE.ShaderMaterial({
      vertexShader: CART_VERTEX,
      fragmentShader: CART_FRAGMENT,
      side: THREE.DoubleSide,
      uniforms: { tCart: { value: this.cartTexture }, uAmbDown: this.shared.uAmbDown },
    });
    this.cart = new THREE.Mesh(minecartGeometry(), this.cartMaterial);
    this.cart.frustumCulled = false;
    this.cart.visible = false;
    this.cart.rotation.order = 'YXZ';
    this.cartScene.add(this.cart);
  }

  ready(): Promise<void> {
    return Promise.all([this.atlas.loaded, this.cartLoaded]).then(() => undefined);
  }

  private meshOf(data: MeshArrays, startDistance: number, material: THREE.ShaderMaterial, order: number): THREE.Mesh | null {
    if (data.indices.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    const buffer = new THREE.InterleavedBuffer(data.vertices, 7);
    geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute('aTex', new THREE.InterleavedBufferAttribute(buffer, 4, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 30, -(startDistance + SEGMENT_LENGTH / 2)), TERRAIN.halfWidth + SEGMENT_LENGTH);
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
    const nether = seg.nether
      ? [this.netherMeshOf(seg.nether.solid, this.solidMaterial, 0), this.netherMeshOf(seg.nether.cross, this.crossMaterial, 1)].filter((m): m is THREE.Mesh => m !== null)
      : [];
    for (const mesh of [...meshes, ...nether]) this.scene.add(mesh);
    this.segments.set(index, { meshes, nether, mood: seg.mood, hour: seg.hour, nether0: seg.nether0, portals: seg.portals, cavePulse: seg.cavePulse, rails: seg.rails, start: Math.round(startDistance) });
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

  addFarSegment(index: number, descriptor: unknown): void {
    const seg = descriptor as FarSegment;
    const meshes: THREE.Mesh[] = [];
    for (const [data, material, order] of [[seg.solid, this.farSolidMaterial, 0], [seg.water, this.farWaterMaterial, 2]] as const) {
      if (data.indices.length === 0) continue;
      const geometry = new THREE.BufferGeometry();
      const buffer = new THREE.InterleavedBuffer(data.vertices, 7);
      geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
      geometry.setAttribute('aTex', new THREE.InterleavedBufferAttribute(buffer, 4, 3));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.x = -0.5; // same block grid as the detailed meshes
      mesh.renderOrder = order;
      mesh.visible = !this.inNether;
      this.scene.add(mesh);
      meshes.push(mesh);
    }
    this.farSegments.set(index, meshes);
  }

  removeFarSegment(index: number): void {
    for (const mesh of this.farSegments.get(index) ?? []) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.farSegments.delete(index);
  }

  /**
   * Area covered by the detailed segments: the run of loaded segments around the camera (a segment still loading leaves
   * the far field visible there, so no hole opens). Pure function of the loaded set and the distance.
   */
  private updateNearClip(distance: number): void {
    const c = Math.floor(distance / SEGMENT_LENGTH);
    const clip = this.shared.uNearClip.value;
    if (!this.segments.has(c)) { clip.set(0, 0, 0, 0); return; }
    let lo = c, hi = c;
    while (this.segments.has(lo - 1)) lo--;
    while (this.segments.has(hi + 1)) hi++;
    // Block columns -H..H of the detailed volume, shifted by -0.5 like the meshes.
    clip.set(-TERRAIN.halfWidth - 0.5, TERRAIN.halfWidth + 0.5, lo * SEGMENT_LENGTH, (hi + 1) * SEGMENT_LENGTH);
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

  /** Deck layer (absolute) of the Nether rails at row bd from the loaded segments, or null. */
  private readonly railLayerAt = (bd: number): number | null => {
    const seg = this.segments.get(Math.floor(bd / SEGMENT_LENGTH));
    const v = seg?.rails?.[bd - seg.start + 1];
    return v === undefined || v === RAILS_NONE ? null : ROAD.layer + v;
  };

  /**
   * Minecart under the camera, tilted as the rail blocks below it are, as in the block game: level on the flat rails and
   * 45 degrees on the ramps, the change rounded over 0.6 m (rails.ts). A pure function of the camera position and the
   * loaded segments.
   */
  private poseCart(cameraPosition: THREE.Vector3): void {
    const distance = -cameraPosition.z;
    const slope = this.inNether ? smoothRailSlopeAt(this.railLayerAt, distance) : null;
    this.cart.visible = slope !== null;
    if (slope === null) return;
    // Under the camera, which rides the smooth grade (path.ts), at the seated eye height: the rail point is RAILS.eyeAbove
    // under the eye. Climbing toward -z (the travel direction) is a positive rotation about x; the pivot sits CART_PIVOT
    // over that point along the rail's normal.
    const pitch = Math.atan(slope);
    const y = cameraPosition.y - RAILS.eyeAbove;
    this.cart.rotation.set(pitch, 0, 0);
    this.cart.position.set(0, y + CART_PIVOT * Math.cos(pitch), -distance + CART_PIVOT * Math.sin(pitch));
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
    for (const meshes of this.farSegments.values()) for (const m of meshes) m.visible = !this.inNether;
    this.updateNearClip(distance);
    this.shared.uNether.value = this.inNether ? 1 : 0;
    this.cubes.visible = !this.inNether;
    this.cubeMaterial.uniforms.uKick!.value = p.cubeKick;
    this.cubeMaterial.uniforms.uCubeGlow!.value = p.cubeGlow;
    this.flash = this.flashAt(distance);
    this.poseCart(cameraPosition);
    this.mood = this.bakedAt(distance, (s) => s.mood, this.mood);
    this.hour = this.bakedAt(distance, (s) => s.hour, this.hour);

    // Atmosphere: one pure function of the hour feeds the sky, the clouds, the fog and the block lighting.
    const atm = atmosphereAt(this.hour);
    const u = this.shared;
    u.uTime.value = trackTime;
    u.uDay.value = atm.day;
    u.uSalt.value = p.worldSalt;
    u.uSunset.value = atm.sunset;
    u.uSunDir.value.set(...atm.sunDir);
    u.uLightDir.value.set(...atm.lightDir);
    setRGB(u.uSunColor.value, atm.sunColor);
    if (this.inNether) {
      setRGB(u.uHorizon.value, NETHER_FOG_LINEAR);
      setRGB(u.uZenith.value, NETHER_FOG_LINEAR);
      u.uLightColor.value.setRGB(0, 0, 0);
      u.uSunColor.value.setRGB(0, 0, 0);
      setRGB(u.uAmbUp.value, NETHER_AMBIENT_UP);
      setRGB(u.uAmbDown.value, NETHER_AMBIENT_DOWN);
    } else {
      setRGB(u.uHorizon.value, atm.horizon);
      setRGB(u.uZenith.value, atm.zenith);
      setRGB(u.uLightColor.value, atm.lightColor);
      setRGB(u.uAmbUp.value, atm.ambientUp);
      setRGB(u.uAmbDown.value, atm.ambientDown);
    }

    // Slow drivers are smoothed: the raw features change every frame and, on large surfaces, read as flicker. Portals
    // and amethyst follow the energy in about 0.25 s, the clouds (a large, bright area) the mids in about 0.6 s.
    // Block light and light sources are static.
    const dt = Math.max(0, Math.min(0.1, trackTime - this.lastLightT));
    this.lastLightT = trackTime;
    this.energy += (p.energy - this.energy) * (1 - Math.exp(-dt / ENERGY_SMOOTH_S));
    this.cloudGlow += (p.cloudGlow - this.cloudGlow) * (1 - Math.exp(-dt / CLOUD_SMOOTH_S));
    u.uEnergy.value = this.energy;
    this.updateCavePulse(p, distance, trackTime, dt);
    this.sparkle += (p.sparkle - this.sparkle) * (1 - Math.exp(-dt / SPARKLE_SMOOTH_S));
    this.waterMaterial.uniforms.uSparkle!.value = this.sparkle;
    this.sky.position.copy(cameraPosition);
  }

  /**
   * Pulse uniforms: the band pulses of the segment under the camera at this track time (read every frame, like the
   * Synthwave mountains) and the breathing (energy smoothed over CAVE_BREATH_S).
   */
  private updateCavePulse(p: VoxelParams, distance: number, trackTime: number, dt: number): void {
    const u = this.shared;
    this.caveBreath += (p.caveEnergy - this.caveBreath) * (1 - Math.exp(-dt / CAVE_BREATH_S));
    u.uCaveBreath.value = this.caveBreath;
    const seg = this.segments.get(Math.floor(distance / SEGMENT_LENGTH));
    if (seg) this.cavePulseNow = seg.cavePulse;
    const now = this.pulseNow;
    if (this.cavePulseNow) pulseAt(this.cavePulseNow, trackTime, now);
    else { now.bass = 0; now.mid = 0; }
    u.uPulseBass.value = now.bass;
    u.uPulseMid.value = now.mid;
  }

  /** Draws the frame through the HDR post pipeline (clouds, light shafts, bloom, tone map) to the canvas. */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    const day = this.shared.uDay.value;
    this.post.render(renderer, this.scene, camera, {
      coverage: CLOUD_COVERAGE[0] + (CLOUD_COVERAGE[1] - CLOUD_COVERAGE[0]) * this.mood,
      cloudGlow: this.cloudGlow,
      // The eye adapts fast as the sun rises: full day exposure from a quarter of the day factor on.
      exposure: this.inNether ? EXPOSURE.nether : EXPOSURE.night + (EXPOSURE.day - EXPOSURE.night) * THREE.MathUtils.smoothstep(day, 0, 0.3),
      flash: this.flash,
      overlay: this.cart.visible ? { scene: this.cartScene, camera: this.cartCameraFor(camera) } : undefined,
    });
  }

  /** The world camera with a near plane of 2 cm: the cart, under the eye, is never cut by the world's 0.5 m near plane. */
  private cartCameraFor(camera: THREE.PerspectiveCamera): THREE.PerspectiveCamera {
    const c = this.cartCamera;
    c.copy(camera, false);
    c.near = 0.02;
    c.far = 10;
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    return c;
  }

  dispose(): void {
    for (const index of [...this.segments.keys()]) this.removeSegment(index);
    for (const index of [...this.farSegments.keys()]) this.removeFarSegment(index);
    this.cartScene.remove(this.cart);
    for (const mesh of [this.sky, this.cubes, this.cart]) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    for (const material of [this.solidMaterial, this.crossMaterial, this.waterMaterial, this.farSolidMaterial, this.farWaterMaterial, this.skyMaterial, this.cubeMaterial, this.cartMaterial]) material.dispose();
    this.cartTexture.dispose();
    this.post.dispose();
    this.atlas.dispose();
  }
}

// The Nether overrides (fog colour) are applied by the dimension code; kept here so the constant has one home.
export { NETHER_FOG };
