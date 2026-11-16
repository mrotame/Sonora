// Synthwave Dimension: Three.js side (main thread). Turns segment descriptors
// into meshes and applies the interpreted parameters to shared materials.
// Shaders are GLSL ES 3.00 (three.js adds the version header and the
// varying/gl_FragColor compatibility defines for ShaderMaterial).
import * as THREE from 'three';
import type { ScenarioScene } from '../types.ts';
import { FAR_TERRAIN, TERRAIN, synthwaveLogic, type SynthwaveParams, type SynthwaveSegment } from './logic.ts';

// Two terrain layers: detailed near segments and a coarse far field (FAR_TERRAIN) that reaches kilometres ahead.
// Both ranges come from the streaming windows, so the hand-over and the fog always stay inside loaded terrain.
const NEAR_AHEAD = synthwaveLogic.config.segmentsAhead * synthwaveLogic.config.segmentLength; // always loaded ahead
const FAR_AHEAD = FAR_TERRAIN.segmentsAhead * FAR_TERRAIN.segmentLength;
/** Detailed layer fades out ahead over [x, y] and sideways over [z, w] (|x|), inside what is always loaded. */
const NEAR_REACH = [0.75 * NEAR_AHEAD, 0.9 * NEAR_AHEAD, TERRAIN.halfWidth - 80, TERRAIN.halfWidth - 10] as const;
/** Fog starts at x and is complete at y, just before the end of the far field. */
const FOG_RANGE = [0.15 * FAR_AHEAD, 0.95 * FAR_AHEAD] as const;
// Mountains reach their final size GROW_DONE units ahead of the camera and are at their start size from GROW_START on.
// The eased curve keeps the strongest rise near GROW_DONE. It used to be 25..175: at the 280 km/h cruise (about
// 78 units/s) the strong rise came about 0.3 s before the camera passed, at the edge of the view. At 150..600 the
// mountain still starts small and rises harder and harder, but the strong rise ends about 2 s ahead, in plain view.
const GROW_DONE = 150;
const GROW_START = 600;
const HORIZON = new THREE.Color(0.1, 0.02, 0.2);
/** Terrain fog never goes above this, so the far plain stays readable as ground below the horizon ring. */
const FOG_CAP = 0.85;

// Horizon ring: a camera-centred backdrop (plain, city, ridge) anchored in height to the road ahead, so the city
// stands on the ground from any altitude instead of floating on the mathematical horizon.
// Ground (road elevation) sampled every GROUND_STEP units from GROUND_BEHIND behind the camera to 5000 ahead, read from
// the loaded far segments, which always cover that range.
const GROUND_STEP = 125;
const GROUND_BEHIND = 500;
const GROUND_SAMPLES = (GROUND_BEHIND + 5000) / GROUND_STEP + 1;
/** Far mountains flatten to the road level over this radius from the camera, so the terrain ends on the plain. */
const FLATTEN = [3300, 3900] as const;
/**
 * Plain under and beyond the terrain (radii from the camera). It sinks `drop` below the ground: deep where it is
 * hidden under the terrain (`dropInner`), shallow at the flattened terrain edge. Over `fade` it dissolves into the haze.
 */
const PLAIN = { inner: 800, outer: 6800, rings: 64, sectors: 256, dropInner: 80, drop: 20, fade: [6000, 6800] } as const;
/**
 * Buildings in `rows` concentric rows starting at `radius`, `perRow` slots per row around the circle. Slots are packed
 * toward straight ahead (under the sun): there the slot spacing is `core` times an even spread, so the centre is about
 * 1/core times denser than an even ring. `coreWidth` (radians) is the half-width of the tall central cluster.
 */
const CITY = { radius: 4700, rowGap: 280, rows: 3, perRow: 250, core: 0.5, coreWidth: 0.45 } as const;
const RIDGE = { radius: 6200, steps: 720 } as const;
/** Haze on tall parts of the city and ridge; their base dissolves into the ground haze (FOG_CAP) like a low mist. */
const RING_FOG = 0.3;

/** Steady (non-pulsing) grid glow on the flat ground and the plain. */
const GROUND_GLOW = 0.6;

const EMBER_COUNT = 900;
// Embers live in a box around the camera: [width, height, depth].
const EMBER_BOX = [120, 30, 200] as const;
/** Part of the ember box behind the camera (world units); the rest is ahead. */
const EMBER_BEHIND = 10;
/** Road elevation under the ember box, sampled every EMBER_ROAD_STEP units from EMBER_BEHIND behind the camera. */
const EMBER_ROAD_STEP = 10;
const EMBER_ROAD_SAMPLES = Math.ceil(EMBER_BOX[2] / EMBER_ROAD_STEP) + 1;
/** Ember diameter in world units, for perspective-correct point size. */
const EMBER_SIZE = 0.2;

// Sky color for a view direction. Shared by the sky dome and the terrain fog, so distant terrain dissolves
// into exactly the sky behind it and the far end of the loaded segments has no visible edge.
const SKY_COLOR = /* glsl */ `
  uniform vec3 uHorizon;
  uniform float uSunScale;
  uniform float uSunGlow;
  uniform vec3 uStars; // x: bass-lit stars, y: mid-lit stars, z: high-lit stars
  uniform float uFlash;
  uniform float uSalt;

  float hash(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  const vec3 SUN_DIR = vec3(0.0, 0.19612, -0.98058); // normalize(0, 0.2, -1)

  // The atmosphere alone: gradient, horizon haze bands and the broad sun glow, without the sun disc, stars or
  // horizon ring. Distant terrain fades into this, so it hides what lies behind it (the sun no longer shows through).
  vec3 skyHaze(vec3 dir) {
    float elev = dir.y;
    vec3 top = vec3(0.02, 0.0, 0.10);
    vec3 col = mix(uHorizon, top, smoothstep(0.0, 0.75, elev));

    // Horizon haze: two soft bands just above the horizon.
    col += vec3(0.55, 0.10, 0.45) * exp(-abs(elev - 0.02) * 28.0) * 0.35;
    col += vec3(0.15, 0.35, 0.70) * exp(-abs(elev - 0.075) * 40.0) * 0.12;

    float ang = acos(clamp(dot(dir, SUN_DIR), -1.0, 1.0));
    col += vec3(1.0, 0.25, 0.5) * exp(-ang * 4.5) * (0.25 + 0.75 * uSunGlow);
    col += vec3(1.0, 0.3, 0.7) * uFlash * 0.12 * (1.0 - smoothstep(0.0, 0.5, elev));
    return col;
  }

  vec3 skyColor(vec3 dir) {
    float elev = dir.y;
    vec3 col = skyHaze(dir);

    vec3 sunDir = SUN_DIR;
    float ang = acos(clamp(dot(dir, sunDir), -1.0, 1.0));
    float r = 0.14 * uSunScale;
    float rel = (dir.y - sunDir.y) / r;
    float thick = clamp(1.0 + rel * 1.1, 0.0, 1.0);
    float mask = rel > 0.0 ? 1.0 : step(fract(rel * 8.0), thick);
    float disc = smoothstep(r, r - 0.004, ang) * mask;
    vec3 sunColor = mix(vec3(1.0, 0.88, 0.30), vec3(1.0, 0.18, 0.55), smoothstep(0.2, -0.9, rel));
    // Thin halo ring around the sun.
    col += vec3(1.0, 0.45, 0.75) * exp(-abs(ang - r * 1.35) * 90.0) * 0.35 * (0.4 + 0.6 * uSunGlow);
    col = mix(col, sunColor, disc);

    // Stars in three populations: bass (40%), mid (45%), high (15%); each twinkles on its own band.
    vec3 cell = floor(dir * 220.0);
    float h = hash(cell);
    float star = step(0.9975, h) * smoothstep(0.08, 0.35, elev);
    float pick = hash(cell + 7.7);
    float band = pick < 0.40 ? uStars.x : (pick < 0.85 ? uStars.y : uStars.z);
    vec3 starTint = pick < 0.40 ? vec3(1.0, 0.65, 0.9) : (pick < 0.85 ? vec3(0.8, 0.9, 1.0) : vec3(0.6, 1.0, 1.0));
    col += starTint * star * band;
    // The distant skyline is real geometry now (horizon ring: plain, city and ridge), so it sits on the ground.
    return col;
  }
`;

// Ground height under the horizon ring as a function of the distance ahead of the camera: piecewise linear through
// the uGround samples (beyond the sampled range it holds the last value). Shared by the plain, the city and the
// ridge, so all of them stand on the same ground as the road.
const GROUND_GLSL = /* glsl */ `
  uniform float uGround[${GROUND_SAMPLES}];
  float groundAt(float ahead) {
    float f = clamp((ahead + ${GROUND_BEHIND.toFixed(1)}) / ${GROUND_STEP.toFixed(1)}, 0.0, ${(GROUND_SAMPLES - 1).toFixed(1)} - 0.001);
    int i = int(f);
    return mix(uGround[i], uGround[i + 1], f - float(i));
  }
`;

// Neon grid in three scales (4, 40 and 400 units), each fading out once its cells get smaller than a few pixels so
// distant ground does not turn into a solid neon wall. Shared by the terrain and the plain so they match.
const GRID_GLSL = /* glsl */ `
  float gridLine(vec2 xz, float cell) {
    vec2 c = xz / cell;
    vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
    return 1.0 - min(min(g.x, g.y), 1.0);
  }
  float gridFade(vec2 xz, float cell) {
    vec2 w = fwidth(xz / cell);
    return 1.0 - smoothstep(0.25, 0.7, max(w.x, w.y));
  }
  float neonGrid(vec2 xz) {
    float f1 = gridFade(xz, 4.0), f2 = gridFade(xz, 40.0), f3 = gridFade(xz, 400.0);
    return gridLine(xz, 4.0) * f1
      + gridLine(xz, 40.0) * f2 * (1.0 - f1) * 0.7
      + gridLine(xz, 400.0) * f3 * (1.0 - f2) * 0.5;
  }
`;

// Plain: a flat polar ring around the camera (local x/z in `position`), lifted to the ground ahead.
const PLAIN_VERTEX = /* glsl */ `
  ${GROUND_GLSL}
  varying vec3 vWorld;
  varying float vRadius;
  void main() {
    vRadius = length(position.xz);
    float drop = mix(${PLAIN.dropInner.toFixed(1)}, ${PLAIN.drop.toFixed(1)}, smoothstep(${FLATTEN[0].toFixed(1)}, ${FLATTEN[1].toFixed(1)}, vRadius));
    vWorld = vec3(cameraPosition.x + position.x, groundAt(-position.z) - drop, cameraPosition.z + position.z);
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const PLAIN_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vWorld;
  varying float vRadius;
  uniform float uGlow;
  uniform vec2 uFog;
  ${SKY_COLOR}
  ${GRID_GLSL}
  void main() {
    // Same shading as flat terrain away from the road (base color plus the sun term for an upward normal).
    // Flat ground: steady glow (the beat pulse is reserved for the mountain peaks).
    vec3 cyan = vec3(0.10, 0.90, 1.00);
    float line = neonGrid(vWorld.xz);
    vec3 color = vec3(0.03, 0.01, 0.09) + 0.2425 * vec3(0.30, 0.07, 0.26);
    color += cyan * line * ${GROUND_GLOW.toFixed(2)};
    vec3 toFrag = vWorld - cameraPosition;
    float dist = length(toFrag);
    float fog = smoothstep(uFog.x, uFog.y, dist);
    fog = max(min(fog * fog, ${FOG_CAP.toFixed(2)}), smoothstep(${PLAIN.fade[0].toFixed(1)}, ${PLAIN.fade[1].toFixed(1)}, vRadius));
    gl_FragColor = vec4(mix(color, skyHaze(toFrag / dist), fog), 1.0);
  }
`;

// City: instanced buildings around the camera; each instance's place, size and shape are a hash of its slot and the
// world salt, so the skyline differs per world without rebuilding geometry and there is no per-frame state.
// Each instance is four unit boxes (aPart): the body, an optional setback tier, a roof (flat, pyramid spire, slanted
// wedge or tapered crown, made by moving the box's top vertices) and an optional antenna. Unused parts collapse to
// zero size and draw nothing.
const CITY_VERTEX = /* glsl */ `
  ${GROUND_GLSL}
  uniform float uSalt;
  attribute vec2 aSlot; // x: slot around the row, y: row
  attribute float aPart; // 0: body, 1: setback tier, 2: roof, 3: antenna
  varying vec3 vWorld;
  varying vec2 vFace; // position on the facade: along the face (x) and height above the ground (y), world units
  varying vec3 vPart; // x: part, y: its base height, z: its top height (above the ground)
  varying float vSide; // 1 on vertical faces, 0 on top and bottom faces
  varying float vId;
  varying float vRow;

  float h11(float n) { return fract(sin(n * 127.1 + uSalt * 311.7) * 43758.5453); }

  void main() {
    float id = aSlot.x + aSlot.y * 1000.0;
    vId = id;
    vRow = aSlot.y;
    // Even slot position v in [-1, 1], warped so the slots crowd around v = 0 (a = 0 is straight ahead, -z).
    // Rows are staggered by half a slot, so back buildings show in the gaps between the front ones; the small jitter
    // keeps neighbours from touching.
    float v = 2.0 * (aSlot.x + 0.5 + 0.5 * mod(aSlot.y, 2.0) + (h11(id) - 0.5) * 0.3) / ${CITY.perRow.toFixed(1)} - 1.0;
    float a = 3.14159265 * v * (${CITY.core.toFixed(2)} + ${(1 - CITY.core).toFixed(2)} * v * v);
    float c1 = a / ${CITY.coreWidth.toFixed(2)}, c2 = a / 1.2;
    float core = exp(-c1 * c1);
    float env = 0.75 * core + 0.25 * exp(-c2 * c2); // massive in the centre, lower and lower toward the sides
    float radius = ${CITY.radius.toFixed(1)} + aSlot.y * ${CITY.rowGap.toFixed(1)} + (h11(id + 0.1) - 0.5) * 120.0;
    float hb = h11(id + 0.4);
    // Height envelope steeper than the presence one: the tallest buildings stay in the centre, the sides stay low.
    float tall = 0.9 * core + 0.1 * exp(-c2 * c2);
    float height = (20.0 + 60.0 * hb) * (0.6 + 0.4 * core) + tall * (160.0 + 1150.0 * pow(hb, 1.3));
    height *= (0.8 + 0.12 * aSlot.y) * (0.95 + 0.1 * h11(id + 0.45)); // back rows stand taller behind the front
    float present = step(0.08 + 0.35 * (1.0 - env), h11(id + 0.5)); // gaps grow toward the sides
    // Close to the slot spacing (about 59 units in the centre, more toward the sides): neighbours in a row may touch,
    // but the staggered rows stand at different radii, so the blocks read as a dense, solid skyline, not as sticks.
    float width = mix(70.0 + 80.0 * h11(id + 0.2), 48.0 + 30.0 * h11(id + 0.2), core);
    float depth = 55.0 + 55.0 * h11(id + 0.3);

    // Setback tier on some tall buildings.
    float tier = step(0.5, h11(id + 0.6)) * step(260.0, height);
    float bodyH = height * mix(1.0, 0.62 + 0.18 * h11(id + 0.61), tier);
    float tierS = 0.55 + 0.25 * h11(id + 0.62);
    vec2 topSize = vec2(width, depth) * mix(1.0, tierS, tier);
    // Roof: 0 flat, 1 pyramid spire, 2 slanted wedge, 3 tapered crown. Low buildings stay flat.
    float rt = h11(id + 0.7);
    float roof = height < 120.0 ? 0.0 : (rt < 0.3 ? 0.0 : (rt < 0.5 ? 1.0 : (rt < 0.75 ? 2.0 : 3.0)));
    float tw = max(topSize.x, topSize.y);
    float rh = h11(id + 0.71);
    float roofH = roof == 1.0 ? tw * (0.5 + 1.2 * rh) : (roof == 2.0 ? tw * (0.35 + 0.5 * rh) : (roof == 3.0 ? 12.0 + 0.25 * tw : 0.0));
    float taper = roof == 1.0 ? 0.04 : (roof == 3.0 ? 0.55 : 1.0);
    // Antenna on some tall buildings, rising from the roof (inside a spire, mid-slope on a wedge).
    float antenna = step(0.5, h11(id + 0.8)) * step(320.0, height);
    float antBase = height + roofH * (roof == 1.0 ? 0.85 : (roof == 2.0 ? 0.5 : 1.0));
    float antH = 50.0 + 0.25 * height * h11(id + 0.81);

    float base, top;
    vec2 size;
    vec3 local = position;
    if (aPart < 0.5) {
      base = -40.0; top = bodyH; size = vec2(width, depth); // the base sinks under the ground
    } else if (aPart < 1.5) {
      base = bodyH; top = height; size = vec2(width, depth) * tierS * tier;
    } else if (aPart < 2.5) {
      base = height; top = height + roofH; size = topSize * step(0.5, roofH);
      local.xz *= mix(1.0, taper, local.y);
      if (roof == 2.0 && local.x < 0.0) local.y = 0.0; // the low side of the slanted cut
    } else {
      base = antBase; top = antBase + antH; size = vec2(12.0) * antenna;
    }
    size *= present;
    vPart = vec3(aPart, base, top);
    vSide = 1.0 - abs(normal.y);

    vec2 radial = vec2(sin(a), -cos(a));
    vec2 tangent = vec2(cos(a), sin(a));
    vec2 center = radial * radius;
    vec2 xz = center + tangent * local.x * size.x + radial * local.z * size.y;
    float y = mix(base, top, local.y);
    vFace = vec2(abs(normal.x) > 0.5 ? local.z * size.y : local.x * size.x, y);
    float ground = groundAt(-center.y); // one ground height per building, so all its parts line up
    vWorld = vec3(cameraPosition.x + xz.x, ground + y, cameraPosition.z + xz.y);
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const CITY_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vWorld;
  varying vec2 vFace;
  varying vec3 vPart;
  varying float vSide;
  varying float vId;
  varying float vRow;
  ${SKY_COLOR}

  float h11(float n) { return fract(sin(n * 127.1 + uSalt * 311.7) * 43758.5453); }

  // Anti-aliased box: 1 inside [lo, hi], edges softened over w.
  float aaBox(float x, float lo, float hi, float w) {
    return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
  }

  void main() {
    float y = vFace.y;
    float part = vPart.x;
    // Each building gets its own facade shade, so neighbours read as separate masses.
    vec3 color = mix(vec3(0.05, 0.0, 0.12), uHorizon, clamp(y / 1400.0, 0.0, 1.0) * 0.6) * (0.75 + 0.5 * h11(vId + 0.9));
    vec3 tint = mix(vec3(0.1, 0.9, 1.0), vec3(1.0, 0.2, 0.75), h11(vId + 0.7));
    vec3 light = vec3(0.0);

    // Lit windows on the body and tier facades: a fixed share of the cells, chosen by a hash of the window and the
    // world salt, so each window is either always on or always off, at a constant brightness (no blinking or pulse).
    // Large cells (about 5 x 5 px at 1080p from the city's distance) keep single windows legible; once a cell shrinks
    // to a few pixels the windows blend into their average glow instead of shimmering.
    vec2 g = vec2(vFace.x / 40.0, y / 34.0);
    vec2 cell = floor(g), inCell = fract(g);
    vec2 fw = fwidth(g);
    float wid = cell.x * 17.0 + cell.y * 131.0 + vId * 7.3;
    float r = h11(wid);
    float on = step(h11(wid + 1.618), 0.24);
    float sharp = on * aaBox(inCell.x, 0.2, 0.8, fw.x * 0.5) * aaBox(inCell.y, 0.3, 0.7, fw.y * 0.5) * (0.7 + 0.3 * fract(r * 13.7));
    float tiny = smoothstep(0.2, 0.4, max(fw.x, fw.y)); // cell under about 3 to 5 px
    float window = mix(sharp, 0.24 * 0.24 * 0.85, tiny); // lit share x window area x mean brightness
    float lit = window * step(part, 1.5) * step(0.5, vSide)
      * step(vPart.y + 10.0, y) * step(y, vPart.z - 10.0) * step(10.0, y);
    light += tint * lit * 1.4;

    // Neon rim along the top edge of the body, the setback and some crowns of the taller buildings, steady.
    float rimW = max(10.0, fwidth(y) * 1.5);
    float rim = (1.0 - smoothstep(0.0, rimW, vPart.z - y)) * step(part, 2.5) * step(0.5, vSide)
      * step(220.0, vPart.z) * (part > 1.5 ? step(0.5, h11(vId + 0.72)) : 1.0);
    light += tint * rim * 0.55;

    // Steady beacon at the tip of each antenna.
    float beacon = step(2.5, part) * step(vPart.z - 20.0, y);
    light += vec3(1.0, 0.15, 0.35) * beacon * 0.65;

    vec3 toFrag = vWorld - cameraPosition;
    // Back rows sit deeper in the haze, so the rows separate in depth instead of merging into one wall.
    float fog = mix(${FOG_CAP.toFixed(2)}, ${RING_FOG.toFixed(2)} + 0.12 * vRow, smoothstep(0.0, 120.0, y));
    // Lights cut through the haze more than the dark facades do.
    gl_FragColor = vec4(mix(color, skyHaze(normalize(toFrag)), fog) + light * (1.0 - 0.6 * fog), 1.0);
  }
`;

// Ridge: a band of low mountains behind the city, one strip around the camera (position.x = azimuth, y = 0 or 1).
const RIDGE_VERTEX = /* glsl */ `
  ${GROUND_GLSL}
  uniform float uSalt;
  varying vec3 vWorld;
  varying float vTop;
  void main() {
    float a = position.x;
    float h = 160.0 + 90.0 * sin(a * 7.0 + uSalt * 2.0) + 60.0 * sin(a * 19.0 + uSalt) + 30.0 * sin(a * 41.0 + uSalt * 3.0);
    vTop = position.y;
    vec2 xz = vec2(sin(a), -cos(a)) * ${RIDGE.radius.toFixed(1)};
    vWorld = vec3(cameraPosition.x + xz.x, groundAt(-xz.y) + mix(-60.0, h, position.y), cameraPosition.z + xz.y);
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const RIDGE_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vWorld;
  varying float vTop;
  uniform float uGlow;
  ${SKY_COLOR}
  void main() {
    vec3 color = mix(vec3(0.04, 0.0, 0.10), uHorizon, vTop * 0.4);
    // Thin neon crest line along the top.
    float crest = 1.0 - smoothstep(0.0, fwidth(vTop) * 1.5, 1.0 - vTop);
    color += vec3(1.0, 0.15, 0.75) * crest * (0.25 + 0.35 * uGlow);
    vec3 toFrag = vWorld - cameraPosition;
    float fog = mix(0.9, ${(RING_FOG + 0.25).toFixed(2)}, vTop);
    gl_FragColor = vec4(mix(color, skyHaze(normalize(toFrag)), fog), 1.0);
  }
`;

const TERRAIN_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  varying float vRoad;
  attribute float aStart; // fraction of the final height while the mountain is far away
  attribute float aRoad; // elevation of the whole cross-section from the music-driven road path
  uniform float uPulse;
  uniform vec2 uGrow; // distance ahead of the camera where growth ends (x) and starts (y)
  void main() {
    vWorld = position;
    // A pure function of the distance to the camera: mountains rise as you approach.
    float ahead = cameraPosition.z - position.z; // the camera travels toward -z
    // 0 = near, 1 = far. Ease it so mountains barely grow while far and shoot up close to the camera.
    float far = smoothstep(uGrow.x, uGrow.y, ahead);
    far = 1.0 - pow(1.0 - far, 2.0);
    float grow = mix(1.0, aStart, far);
    // Far away the mountains settle to the road level, so the terrain ends flat on the horizon ring's plain.
    float flatten = 1.0 - smoothstep(${FLATTEN[0].toFixed(1)}, ${FLATTEN[1].toFixed(1)}, length(position.xz - cameraPosition.xz));
    vWorld.y *= grow * (1.0 + uPulse) * flatten; // the road is at y = 0, so only the mountains grow and breathe
    vWorld.y += aRoad; // then the whole cross-section rides the road elevation (not scaled by the growth)
    vRoad = aRoad;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const TERRAIN_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vWorld;
  varying float vRoad;
  uniform float uGlow;
  uniform vec2 uFog; // distance where the fog starts (x) and where it is complete (y)
  uniform float uRoadHalf;
  uniform vec4 uNearReach; // detailed-layer coverage: fade ahead from x to y, sideways from z to w (|x|)
  ${SKY_COLOR}
  ${GRID_GLSL}

  // Weight of the detailed layer at this point: 1 where the near segments are always loaded, 0 outside them.
  float nearWeight(vec3 p) {
    float ahead = cameraPosition.z - p.z;
    return smoothstep(-70.0, -40.0, ahead)
      * (1.0 - smoothstep(uNearReach.x, uNearReach.y, ahead))
      * (1.0 - smoothstep(uNearReach.z, uNearReach.w, abs(p.x)));
  }

  void main() {
    // Complementary screen-space dither between the two layers: every pixel is drawn by exactly one of them,
    // so the hand-over has no seam, no pop and no z-fighting where both meshes overlap.
    float w = nearWeight(vWorld);
    float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
#ifdef FAR_LAYER
    if (noise < w) discard;
#else
    if (noise >= w) discard;
#endif

    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    float h = vWorld.y - vRoad; // height above the road level, so colors do not change with the elevation
    float ax = abs(vWorld.x);

    vec3 sunDir = normalize(vec3(0.0, 0.25, -1.0));
    float lit = max(dot(n, sunDir), 0.0);
    vec3 base = mix(vec3(0.03, 0.01, 0.09), vec3(0.17, 0.04, 0.24), clamp(h / 16.0, 0.0, 1.0));
    base += lit * vec3(0.30, 0.07, 0.26) * step(uRoadHalf + 3.0, ax);

    float line = neonGrid(vWorld.xz);

    vec3 cyan = vec3(0.10, 0.90, 1.00);
    vec3 magenta = vec3(1.00, 0.15, 0.75);
    float peak = smoothstep(0.0, 12.0, h); // 0 on the flat ground, 1 on the (magenta) mountain peaks
    vec3 lineColor = mix(cyan, magenta, peak);
    float onRoad = 1.0 - step(uRoadHalf, ax);
    lineColor = mix(lineColor, magenta, onRoad);

    float edge = 1.0 - smoothstep(0.0, 0.5, abs(ax - uRoadHalf));
    // Centre dashes: 12 units long with 20-unit gaps (32-unit period), so they read as separate dashes from afar.
    float dash = onRoad * (1.0 - smoothstep(0.0, 0.25, ax)) * step(fract(vWorld.z / 32.0), 0.375);

    vec3 color = base;
    // Only the peaks pulse with the beat (uGlow, flash); the flat ground and the road keep a steady glow.
    float glow = mix(${GROUND_GLOW.toFixed(2)}, 0.35 + 0.9 * uGlow, peak);
    color += lineColor * line * glow * (1.0 - 0.5 * onRoad);
    color += magenta * edge * 0.6;
    color += vec3(1.0, 0.85, 0.4) * dash * 0.9;
    color += lineColor * uFlash * 0.25 * (line + 0.2) * peak;

    // Aerial perspective: fade into the haze of the sky in this direction (not the sun disc or stars). It stops at
    // FOG_CAP, the same as the plain beyond, so far ground still reads as ground under the horizon ring.
    vec3 toFrag = vWorld - cameraPosition;
    float dist = length(toFrag);
    float fog = smoothstep(uFog.x, uFog.y, dist);
    fog = min(fog * fog, ${FOG_CAP.toFixed(2)}); // gentle at mid range, so a descent reveals a large landscape
    if (fog > 0.0) color = mix(color, skyHaze(toFrag / dist), fog);
    gl_FragColor = vec4(color, 1.0);
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
  varying vec3 vDir;
  ${SKY_COLOR}
  void main() {
    gl_FragColor = vec4(skyColor(normalize(vDir)), 1.0);
  }
`;


// Embers: positions are a pure function of the seed attributes, the track time and the camera position, so there
// is no per-frame state. Each ember has a fixed world position (plus a slow fall and sway on track time) that wraps
// inside a box kept around the camera, so the camera flies through them with real parallax. The box sits mostly
// ahead of the camera, where it can be seen.
const EMBER_VERTEX = /* glsl */ `
  attribute vec4 aRand;
  uniform float uDensity;
  uniform float uSalt;
  uniform vec3 uBox;
  // Road elevation along the box, from EMBER_BEHIND behind the camera forward. Each ember stands on the road at its
  // own z, so on a climb the embers ahead are already up the slope instead of rising out of it with the camera.
  uniform float uRoad[${EMBER_ROAD_SAMPLES}];
  uniform float uTime; // track time (s)
  uniform float uViewport; // drawing buffer height in device pixels
  varying float vAlpha;
  varying vec3 vColor;

  // World coordinate congruent to 'seed' (mod size) inside [lo, lo + size): fixed in the world until it wraps.
  float wrapInto(float seed, float lo, float size) {
    return lo + fract((seed - lo) / size) * size;
  }

  float roadAt(float ahead) {
    float f = clamp((ahead + ${EMBER_BEHIND.toFixed(1)}) / ${EMBER_ROAD_STEP.toFixed(1)}, 0.0, ${(EMBER_ROAD_SAMPLES - 1).toFixed(1)} - 0.001);
    int i = int(f);
    return mix(uRoad[i], uRoad[i + 1], f - float(i));
  }

  void main() {
    vec4 r = fract(aRand + uSalt * 0.6180339);
    float fall = 0.6 + 0.9 * fract(r.z * 3.71); // world units per second, own speed per ember
    float fy = fract(r.y - uTime * fall / uBox.y); // 1 at the top of the box, wraps from the bottom to the top
    vec3 p;
    float sway = sin(uTime * (0.3 + 0.3 * r.y) + r.w * 6.2831) * 1.5;
    p.x = wrapInto(r.x * uBox.x, cameraPosition.x - 0.5 * uBox.x, uBox.x) + sway;
    // The camera travels toward -z: keep ${EMBER_BEHIND} units of the box behind it and the rest ahead.
    p.z = wrapInto(r.z * uBox.z, cameraPosition.z + ${EMBER_BEHIND.toFixed(1)} - uBox.z, uBox.z);
    p.y = roadAt(cameraPosition.z - p.z) + 1.0 + fy * (uBox.y - 2.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // Soft density threshold, so a change in density fades embers in and out instead of popping them.
    float visible = smoothstep(r.w - 0.12, r.w, uDensity);
    float d = max(-mv.z, 0.001);
    // Colour hash of the seed attributes, independent of the density threshold r.w.
    float c = fract(r.y * 5.71 + r.x * 2.39 + r.w * 4.13);
    // Perspective-correct size: an ember is a sphere of ${EMBER_SIZE} world units, whatever the resolution or FOV.
    float size = ${EMBER_SIZE.toFixed(2)} * uViewport * projectionMatrix[1][1] * 0.5 / d;
    gl_PointSize = clamp(size, 1.5, 32.0);
    float far = uBox.z - ${EMBER_BEHIND.toFixed(1)};
    vAlpha = visible * smoothstep(far, far * 0.45, d) * smoothstep(1.5, 6.0, d)
      * smoothstep(0.5 * uBox.x, 0.35 * uBox.x, abs(p.x - cameraPosition.x)) // no pop when wrapping sideways
      * min(size / 1.5, 1.0) // sub-pixel embers dim instead of shrinking below the clamp
      * smoothstep(0.0, 0.15, fy) * smoothstep(1.0, 0.85, fy); // fade in at the top, out near the ground
    vColor = c < 0.22 ? vec3(0.1, 0.9, 1.0)
      : c < 0.44 ? vec3(1.0, 0.2, 0.75)
      : c < 0.60 ? vec3(1.0, 0.85, 0.4)
      : c < 0.76 ? vec3(0.6, 0.3, 1.0)
      : c < 0.90 ? vec3(1.0, 0.45, 0.15)
      : vec3(0.3, 1.0, 0.6);
  }
`;

const EMBER_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uGlow;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float halo = 1.0 - smoothstep(0.0, 1.0, d);
    float core = 1.0 - smoothstep(0.0, 0.35, d);
    vec3 col = vColor * (halo * 1.8 + core * 1.2) + vec3(1.0) * core * 0.5; // hot, slightly white centre
    gl_FragColor = vec4(col * uGlow, halo * vAlpha);
  }
`;

export class SynthwaveScene implements ScenarioScene {
  readonly scene = new THREE.Scene();
  readonly background = HORIZON;

  private readonly meshes = new Map<number, THREE.Mesh>();
  private readonly farMeshes = new Map<number, THREE.Mesh>();
  // Index data is shared on the CPU side; each geometry wraps it in its own attribute,
  // because disposing a geometry frees the GPU buffer of its attributes.
  private readonly indexCache = new Map<string, Uint16Array>();
  private readonly terrainMaterial: THREE.ShaderMaterial;
  private readonly farMaterial: THREE.ShaderMaterial;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly sky: THREE.Mesh;
  private readonly emberMaterial: THREE.ShaderMaterial;
  private readonly embers: THREE.Points;
  private readonly ringMaterials: THREE.ShaderMaterial[];
  private readonly ring: THREE.Mesh[];
  /** Road elevation per loaded far segment (its rows), the source of the horizon ring's ground samples. */
  private readonly farRoad = new Map<number, { start: number; step: number; roadY: Float32Array }>();
  private readonly ground = new Float32Array(GROUND_SAMPLES);
  /** Road elevation under the ember box (uRoad). */
  private readonly emberRoad = new Float32Array(EMBER_ROAD_SAMPLES);

  constructor() {
    // The same uniform objects feed the sky dome and the terrain fog (SKY_COLOR), so both always see the same sky.
    const skyUniforms = {
      uHorizon: { value: HORIZON },
      uSunScale: { value: 1 },
      uSunGlow: { value: 0.5 },
      uStars: { value: new THREE.Vector3(0.4, 0.4, 0.4) },
      uFlash: { value: 0 },
      uSalt: { value: 1 },
    };
    const terrainUniforms = {
      ...skyUniforms,
      uPulse: { value: 0 },
      uGrow: { value: new THREE.Vector2(GROW_DONE, GROW_START) },
      uGlow: { value: 0.5 },
      uFog: { value: new THREE.Vector2(...FOG_RANGE) },
      uRoadHalf: { value: TERRAIN.roadHalf },
      uNearReach: { value: new THREE.Vector4(...NEAR_REACH) },
    };
    this.terrainMaterial = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VERTEX,
      fragmentShader: TERRAIN_FRAGMENT,
      side: THREE.DoubleSide,
      uniforms: terrainUniforms,
    });
    // Same shader and the same uniform objects; FAR_LAYER only flips which side of the dither it draws.
    this.farMaterial = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VERTEX,
      fragmentShader: TERRAIN_FRAGMENT,
      side: THREE.DoubleSide,
      defines: { FAR_LAYER: '' },
      uniforms: terrainUniforms,
    });
    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: skyUniforms,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), this.skyMaterial);
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // Horizon ring: plain, city and ridge share the sky uniforms (fog colour), the grid glow and the ground samples.
    const ringUniforms = {
      ...skyUniforms,
      uGlow: terrainUniforms.uGlow,
      uFog: terrainUniforms.uFog,
      uGround: { value: this.ground },
    };
    this.ringMaterials = [
      new THREE.ShaderMaterial({ vertexShader: PLAIN_VERTEX, fragmentShader: PLAIN_FRAGMENT, side: THREE.DoubleSide, uniforms: ringUniforms }),
      new THREE.ShaderMaterial({
        vertexShader: CITY_VERTEX,
        fragmentShader: CITY_FRAGMENT,
        side: THREE.DoubleSide,
        uniforms: ringUniforms,
      }),
      new THREE.ShaderMaterial({ vertexShader: RIDGE_VERTEX, fragmentShader: RIDGE_FRAGMENT, side: THREE.DoubleSide, uniforms: ringUniforms }),
    ];
    const ringGeometries = [plainGeometry(), cityGeometry(), ridgeGeometry()];
    this.ring = ringGeometries.map((geometry, i) => {
      const mesh = new THREE.Mesh(geometry, this.ringMaterials[i]);
      mesh.frustumCulled = false; // the vertex shaders place it around the camera
      this.scene.add(mesh);
      return mesh;
    });

    // Ember attributes come from a fixed hash of the index (no Math.random), so they are identical in every run.
    const rand4 = new Float32Array(EMBER_COUNT * 4);
    for (let i = 0; i < rand4.length; i++) {
      const x = Math.sin((i + 1) * 12.9898) * 43758.5453;
      rand4[i] = x - Math.floor(x);
    }
    const emberGeometry = new THREE.BufferGeometry();
    emberGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(EMBER_COUNT * 3), 3));
    emberGeometry.setAttribute('aRand', new THREE.BufferAttribute(rand4, 4));
    this.emberMaterial = new THREE.ShaderMaterial({
      vertexShader: EMBER_VERTEX,
      fragmentShader: EMBER_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uDensity: { value: 0.5 },
        uGlow: { value: 1 },
        uSalt: { value: 1 },
        uBox: { value: new THREE.Vector3(...EMBER_BOX) },
        uRoad: { value: this.emberRoad },
        uTime: { value: 0 },
        uViewport: { value: 1 },
      },
    });
    this.embers = new THREE.Points(emberGeometry, this.emberMaterial);
    this.embers.frustumCulled = false;
    // Point sizes are in device pixels, so the shader needs the drawing buffer height (resolution and DPR).
    const bufferSize = new THREE.Vector2();
    this.embers.onBeforeRender = (renderer) => {
      this.emberMaterial.uniforms.uViewport!.value = renderer.getDrawingBufferSize(bufferSize).y;
    };
    this.scene.add(this.embers);
  }

  private indicesFor(rows: number, cols: number): Uint16Array {
    const key = `${rows}x${cols}`;
    let idx = this.indexCache.get(key);
    if (!idx) {
      idx = new Uint16Array(rows * cols * 6);
      let o = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const a = r * (cols + 1) + c, b = a + 1, d = a + cols + 1, e = d + 1;
          idx[o++] = a; idx[o++] = d; idx[o++] = b;
          idx[o++] = b; idx[o++] = d; idx[o++] = e;
        }
      }
      this.indexCache.set(key, idx);
    }
    return idx;
  }

  addSegment(index: number, descriptor: unknown, startDistance: number): void {
    const mesh = this.buildMesh(descriptor as SynthwaveSegment, startDistance, this.terrainMaterial);
    this.meshes.set(index, mesh);
    this.scene.add(mesh);
  }

  removeSegment(index: number): void {
    this.dropMesh(this.meshes, index);
  }

  addFarSegment(index: number, descriptor: unknown, startDistance: number): void {
    const seg = descriptor as SynthwaveSegment;
    const mesh = this.buildMesh(seg, startDistance, this.farMaterial);
    this.farMeshes.set(index, mesh);
    this.farRoad.set(index, { start: startDistance, step: seg.rowStep, roadY: seg.roadY });
    this.scene.add(mesh);
  }

  removeFarSegment(index: number): void {
    this.dropMesh(this.farMeshes, index);
    this.farRoad.delete(index);
  }

  /** Road elevation at distance d from the loaded far segments, or undefined if that stretch is not loaded. */
  private roadAt(d: number): number | undefined {
    const seg = this.farRoad.get(Math.floor(d / FAR_TERRAIN.segmentLength));
    if (!seg) return undefined;
    const f = Math.min(Math.max((d - seg.start) / seg.step, 0), seg.roadY.length - 1);
    const i = Math.min(Math.floor(f), seg.roadY.length - 2);
    return seg.roadY[i]! + (seg.roadY[i + 1]! - seg.roadY[i]!) * (f - i);
  }

  /** Fills the ground samples around the camera; gaps (segments still loading) hold the previous known height. */
  private updateGround(cameraPosition: THREE.Vector3): void {
    const distance = -cameraPosition.z;
    let last = cameraPosition.y - synthwaveLogic.config.eyeHeight; // road height under the camera
    for (let k = 0; k < GROUND_SAMPLES; k++) {
      const h = this.roadAt(distance - GROUND_BEHIND + k * GROUND_STEP);
      if (h !== undefined) last = h;
      this.ground[k] = last;
    }
  }

  /** Fills the road samples under the ember box; gaps (segments still loading) hold the previous known height. */
  private updateEmberRoad(cameraPosition: THREE.Vector3): void {
    const distance = -cameraPosition.z;
    let last = cameraPosition.y - synthwaveLogic.config.eyeHeight; // road height under the camera
    for (let k = 0; k < EMBER_ROAD_SAMPLES; k++) {
      const h = this.roadAt(distance - EMBER_BEHIND + k * EMBER_ROAD_STEP);
      if (h !== undefined) last = h;
      this.emberRoad[k] = last;
    }
  }

  private buildMesh(seg: SynthwaveSegment, startDistance: number, material: THREE.ShaderMaterial): THREE.Mesh {
    const cols1 = seg.cols + 1;
    const positions = new Float32Array((seg.rows + 1) * cols1 * 3);
    const cell = (2 * seg.halfWidth) / seg.cols;
    for (let r = 0; r <= seg.rows; r++) {
      const z = -(startDistance + r * seg.rowStep); // the camera travels toward -z
      for (let c = 0; c < cols1; c++) {
        const o = (r * cols1 + c) * 3;
        positions[o] = -seg.halfWidth + c * cell;
        positions[o + 1] = seg.heights[r * cols1 + c]!;
        positions[o + 2] = z;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aStart', new THREE.BufferAttribute(seg.startRatio, 1));
    const road = new Float32Array((seg.rows + 1) * cols1); // one elevation per row, repeated across the columns
    for (let r = 0; r <= seg.rows; r++) road.fill(seg.roadY[r]!, r * cols1, (r + 1) * cols1);
    geometry.setAttribute('aRoad', new THREE.BufferAttribute(road, 1));
    geometry.setIndex(new THREE.BufferAttribute(this.indicesFor(seg.rows, seg.cols), 1));
    const mesh = new THREE.Mesh(geometry, material);
    // The vertex shader lifts the whole cross-section by aRoad (up to hundreds of units), so a bounding sphere built
    // from the raw positions would sit far below the camera and the mesh would be wrongly frustum-culled.
    mesh.frustumCulled = false;
    return mesh;
  }

  private dropMesh(meshes: Map<number, THREE.Mesh>, index: number): void {
    const mesh = meshes.get(index);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose(); // the shared materials and index buffers stay alive
    meshes.delete(index);
  }

  update(params: unknown, cameraPosition: THREE.Vector3, trackTime: number): void {
    const p = params as SynthwaveParams;
    this.terrainMaterial.uniforms.uPulse!.value = p.mountainPulse;
    this.terrainMaterial.uniforms.uGlow!.value = p.gridGlow;
    this.terrainMaterial.uniforms.uFlash!.value = p.flash;
    const sky = this.skyMaterial.uniforms;
    sky.uSunScale!.value = p.sunScale;
    sky.uSunGlow!.value = p.sunGlow;
    (sky.uStars!.value as THREE.Vector3).set(p.starBass, p.starMid, p.starHigh);
    sky.uFlash!.value = p.flash;
    sky.uSalt!.value = p.worldSalt;
    const ember = this.emberMaterial.uniforms;
    ember.uDensity!.value = p.emberDensity;
    ember.uGlow!.value = p.emberGlow;
    ember.uSalt!.value = p.worldSalt;
    ember.uTime!.value = trackTime;
    this.sky.position.copy(cameraPosition);
    this.updateGround(cameraPosition);
    this.updateEmberRoad(cameraPosition);
  }

  dispose(): void {
    for (const index of [...this.meshes.keys()]) this.removeSegment(index);
    for (const index of [...this.farMeshes.keys()]) this.removeFarSegment(index);
    this.farMaterial.dispose();
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
    this.embers.geometry.dispose();
    this.emberMaterial.dispose();
    this.terrainMaterial.dispose();
    for (const mesh of this.ring) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    for (const material of this.ringMaterials) material.dispose();
    this.indexCache.clear();
  }
}

/** Flat polar ring (local x/z around the camera), rings x sectors quads. */
function plainGeometry(): THREE.BufferGeometry {
  const { inner, outer, rings, sectors } = PLAIN;
  const positions = new Float32Array((rings + 1) * (sectors + 1) * 3);
  for (let r = 0; r <= rings; r++) {
    // Denser rings near the inner edge, where the plain is closest to the camera.
    const radius = inner + (outer - inner) * Math.pow(r / rings, 1.5);
    for (let s = 0; s <= sectors; s++) {
      const a = (s / sectors) * Math.PI * 2;
      const o = (r * (sectors + 1) + s) * 3;
      positions[o] = Math.sin(a) * radius;
      positions[o + 2] = -Math.cos(a) * radius;
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < sectors; s++) {
      const a = r * (sectors + 1) + s, b = a + 1, d = a + sectors + 1, e = d + 1;
      index.push(a, d, b, b, d, e);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
}

/**
 * Four unit boxes (x and z in [-0.5, 0.5], y in [0, 1]) tagged by aPart (body, tier, roof, antenna), instanced once per
 * city slot; the vertex shader sizes, shapes and places each part.
 */
function cityGeometry(): THREE.InstancedBufferGeometry {
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const boxPos = box.getAttribute('position').array as Float32Array;
  const boxNormal = box.getAttribute('normal').array as Float32Array;
  const boxIndex = box.index!.array;
  const parts = 4;
  const verts = boxPos.length / 3;
  const position = new Float32Array(boxPos.length * parts);
  const normal = new Float32Array(boxNormal.length * parts);
  const part = new Float32Array(verts * parts);
  const index: number[] = [];
  for (let k = 0; k < parts; k++) {
    position.set(boxPos, k * boxPos.length);
    normal.set(boxNormal, k * boxNormal.length);
    part.fill(k, k * verts, (k + 1) * verts);
    for (let i = 0; i < boxIndex.length; i++) index.push(boxIndex[i]! + k * verts);
  }
  box.dispose();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(index);
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  const count = CITY.rows * CITY.perRow;
  const slots = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    slots[i * 2] = i % CITY.perRow;
    slots[i * 2 + 1] = Math.floor(i / CITY.perRow);
  }
  geometry.setAttribute('aSlot', new THREE.InstancedBufferAttribute(slots, 2));
  geometry.instanceCount = count;
  return geometry;
}

/** Vertical strip around the camera: position.x is the azimuth, position.y is 0 at the base and 1 at the crest. */
function ridgeGeometry(): THREE.BufferGeometry {
  const n = RIDGE.steps;
  const positions = new Float32Array((n + 1) * 2 * 3);
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI;
    positions.set([a, 0, 0, a, 1, 0], i * 6);
  }
  const index: number[] = [];
  for (let i = 0; i < n; i++) index.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
}
