// Voxel Dreamscape: HDR post-processing, in the style of the shader packs players install for block games (the
// techniques, written from scratch; no code from any pack). The scene is drawn into a linear HDR target, then:
//   1. clouds    (half resolution) volumetric clouds, ray marched through a 3D noise volume, lit by the sun or moon
//                 with a light march, a two-lobe phase function (silver lining) and sky ambient;
//   2. composite  scene + clouds. The layer is above everything in the world, so geometry always hides it, except
//                 as far as the geometry is lost in the distance fog: every scene material writes its visibility
//                 (1 - fog) to alpha (the sky dome writes 0) and the clouds show through by 1 - alpha. No depth needed;
//   3. shafts     (quarter resolution) light shafts: a radial blur toward the sun of what is open sky and not cloud;
//   4. bloom      a mip chain (threshold, 6 downsamples, tent upsamples);
//   5. final      exposure, filmic tone map, saturation, vignette, display encoding, portal flash, dither.
// Every input is a uniform set from the track time, the camera and the baked hour: no history buffers, so a frame is
// a pure function of its inputs (no temporal accumulation).
import * as THREE from 'three';
import { buildCloudNoise, CLOUD_NOISE_SIZE } from './cloudNoise.ts';
import { SKY_GLSL } from './skyGlsl.ts';

/** Cloud layer (world metres): base and top altitude, shape and detail noise scale, wind (m/s), farthest march. */
export const CLOUDS = {
  base: 250,
  top: 430,
  shapeScale: 1 / 2200,
  detailScale: 1 / 420,
  weatherScale: 1 / 16000,
  wind: 9,
  maxDistance: 9000,
  steps: 40,
  lightSteps: 5,
} as const;

/** Post settings: bloom strength, light shafts strength, vignette, saturation. */
export const POST = {
  bloom: 0.11,
  shafts: 0.55,
  vignette: 0.32,
  saturation: 1.12,
  bloomLevels: 6,
} as const;

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Interleaved gradient noise: a fixed per-pixel dither (it does not change over time, so it never flickers).
const IGN = /* glsl */ `
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

const CLOUD_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  ${SKY_GLSL}
  ${IGN}
  uniform sampler3D tNoise;
  uniform sampler2D tScene;
  uniform vec2 uSceneTexel;
  uniform mat4 uProjInv;
  uniform mat4 uCamWorld;
  uniform vec3 uCam;
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform vec3 uAmbUp;
  uniform float uTime;
  uniform float uCoverage;
  uniform float uGlow;
  uniform float uSalt;
  varying vec2 vUv;

  const float BASE = ${CLOUDS.base.toFixed(1)};
  const float TOP = ${CLOUDS.top.toFixed(1)};
  const float PI = 3.14159265;

  vec3 worldDir(vec2 uv) {
    vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
    return normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  }

  float hg(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * c, 1.5));
  }

  // Cloud density at a world point: a cumulus height profile, a coverage map that varies over kilometres (clear and
  // cloudy areas), the billowy shape noise and, unless "cheap", the detail noise eroding the edges.
  float density(vec3 p, bool cheap) {
    vec3 q = p + vec3(uTime * ${CLOUDS.wind.toFixed(1)} + uSalt * 731.0, 0.0, uSalt * 413.0);
    float h = clamp((p.y - BASE) / (TOP - BASE), 0.0, 1.0);
    float weather = texture(tNoise, vec3(q.xz * ${CLOUDS.weatherScale}, 0.37)).r;
    float cov = clamp(uCoverage + (weather - 0.5) * 0.7, 0.05, 0.95);
    // Flat-ish bottoms, rounded tops; thicker clouds where the coverage is high.
    float profile = smoothstep(0.0, 0.1, h) * smoothstep(1.0, mix(0.35, 0.7, cov), h);
    float shape = texture(tNoise, q * ${CLOUDS.shapeScale}).r;
    float base = clamp((shape * profile - (1.0 - cov)) / cov, 0.0, 1.0);
    if (cheap || base <= 0.0) return base;
    float detail = texture(tNoise, q * ${CLOUDS.detailScale} + vec3(0.0, uTime * 0.004, 0.0)).g;
    float erode = mix(detail, 1.0 - detail, clamp(h * 3.0, 0.0, 1.0)) * 0.42;
    return clamp((base - erode) / (1.0 - erode), 0.0, 1.0);
  }

  void main() {
    // Behind unfogged geometry the clouds can never show: skip the march (4 taps, so silhouettes keep their clouds).
    vec2 o = uSceneTexel * 1.5;
    float covered = min(min(texture(tScene, vUv + vec2(o.x, o.y)).a, texture(tScene, vUv - vec2(o.x, o.y)).a),
                        min(texture(tScene, vUv + vec2(o.x, -o.y)).a, texture(tScene, vUv + vec2(-o.x, o.y)).a));
    if (covered > 0.999) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec3 dir = worldDir(vUv);
    // The camera is always below the layer: only rays that climb reach it; near the horizon they fade out.
    if (uNether > 0.5 || dir.y < 0.004) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float t0 = (BASE - uCam.y) / dir.y;
    float t1 = min((TOP - uCam.y) / dir.y, ${CLOUDS.maxDistance.toFixed(1)});
    if (t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float stepLen = (t1 - t0) / ${CLOUDS.steps.toFixed(1)};
    float jitter = ign(gl_FragCoord.xy);
    float cosA = dot(dir, uLightDir);
    // Two lobes: strong forward scattering (bright rims toward the sun), some back scattering (lit side away from it).
    float phase = mix(hg(cosA, 0.62), hg(cosA, -0.2), 0.3) * 4.0 * PI;
    float T = 1.0;
    vec3 S = vec3(0.0);
    float depthSum = 0.0, weightSum = 0.0;
    for (int i = 0; i < ${CLOUDS.steps}; i++) {
      float t = t0 + (float(i) + jitter) * stepLen;
      vec3 p = uCam + dir * t;
      float d = density(p, false);
      if (d > 0.004) {
        // Light march toward the sun (or moon) with growing steps: optical depth of the cloud above this point.
        float od = 0.0, ls = 18.0;
        vec3 lp = p;
        for (int j = 0; j < ${CLOUDS.lightSteps}; j++) {
          lp += uLightDir * ls;
          od += density(lp, true) * ls;
          ls *= 1.7;
        }
        float h = clamp((p.y - BASE) / (TOP - BASE), 0.0, 1.0);
        float beer = exp(-od * 0.022);
        // "Powder": the dark edges of a cloud seen against the light (less in-scattering where the cloud is thin).
        float powder = 1.0 - exp(-d * 6.0);
        vec3 direct = uLightColor * beer * mix(1.0, powder, 0.6) * phase * (0.85 + 0.3 * uGlow);
        vec3 ambient = (uAmbUp * mix(0.45, 1.15, h) + uHorizon * 0.18) * 0.85;
        vec3 scatter = (direct * 1.35 + ambient);
        float sigma = d * 0.045;
        float sT = exp(-sigma * stepLen);
        S += T * scatter * (1.0 - sT);
        depthSum += T * (1.0 - sT) * t;
        weightSum += T * (1.0 - sT);
        T *= sT;
        if (T < 0.02) break;
      }
    }
    // Aerial perspective: far clouds dissolve into the sky colour; at the horizon they fade out completely.
    float dist = weightSum > 0.0 ? depthSum / weightSum : t0;
    float air = exp(-dist / 5200.0);
    float horizonFade = smoothstep(0.004, 0.09, dir.y);
    float alpha = (1.0 - T) * horizonFade;
    vec3 sky = skyBase(dir);
    S = mix(sky * (1.0 - T), S, air) * horizonFade;
    gl_FragColor = vec4(S, 1.0 - alpha);
  }
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tScene;
  uniform sampler2D tClouds;
  varying vec2 vUv;

  void main() {
    vec4 scene = texture(tScene, vUv);
    vec4 clouds = texture(tClouds, vUv); // premultiplied colour, transmittance
    // Squared: a half-fogged ridge still hides the clouds behind it; they appear only where the ground is almost gone.
    float w = 1.0 - clamp(scene.a, 0.0, 1.0);
    w *= w;
    gl_FragColor = vec4(scene.rgb * mix(1.0, clouds.a, w) + clouds.rgb * w, 1.0);
  }
`;

const SHAFT_FRAGMENT = /* glsl */ `
  precision highp float;
  ${IGN}
  uniform sampler2D tScene;
  uniform sampler2D tClouds;
  uniform vec2 uSunUv;
  uniform float uAspect;
  varying vec2 vUv;

  void main() {
    const int N = 36;
    vec2 delta = (uSunUv - vUv) / float(N) * 0.92;
    vec2 uv = vUv + delta * ign(gl_FragCoord.xy);
    float sum = 0.0, weight = 1.0, total = 0.0;
    for (int i = 0; i < N; i++) {
      // Open sky (no geometry) and not hidden by a cloud: light reaches the eye along this line.
      float open = (1.0 - clamp(texture(tScene, uv).a, 0.0, 1.0)) * texture(tClouds, uv).a;
      sum += open * weight;
      total += weight;
      weight *= 0.97;
      uv += delta;
    }
    // Only near the sun: falls off with the screen distance to it.
    vec2 off = (vUv - uSunUv) * vec2(uAspect, 1.0);
    float falloff = exp(-dot(off, off) * 2.2);
    gl_FragColor = vec4(vec3(sum / total * falloff), 1.0);
  }
`;

const DOWN_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tSource;
  uniform vec2 uTexel;
  uniform float uPrefilter;
  varying vec2 vUv;

  vec3 prefilter(vec3 c) {
    // Soft threshold on luminance; clamped so a few very bright pixels (the sun disc) do not flash the whole screen.
    c = min(c, vec3(24.0));
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return c * smoothstep(0.75, 2.2, l);
  }

  void main() {
    vec3 a = texture(tSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    vec3 b = texture(tSource, vUv + uTexel * vec2(1.0, -1.0)).rgb;
    vec3 c = texture(tSource, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
    vec3 d = texture(tSource, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    vec3 e = texture(tSource, vUv).rgb;
    if (uPrefilter > 0.5) { a = prefilter(a); b = prefilter(b); c = prefilter(c); d = prefilter(d); e = prefilter(e); }
    gl_FragColor = vec4((a + b + c + d) * 0.125 + e * 0.5, 1.0);
  }
`;

const UP_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tSource; // the smaller, already accumulated level
  uniform sampler2D tBase;   // this level of the down chain
  uniform vec2 uTexel;       // of tSource
  varying vec2 vUv;
  void main() {
    vec3 s = texture(tSource, vUv).rgb * 4.0;
    s += (texture(tSource, vUv + vec2(uTexel.x, 0.0)).rgb + texture(tSource, vUv - vec2(uTexel.x, 0.0)).rgb
        + texture(tSource, vUv + vec2(0.0, uTexel.y)).rgb + texture(tSource, vUv - vec2(0.0, uTexel.y)).rgb) * 2.0;
    s += texture(tSource, vUv + uTexel).rgb + texture(tSource, vUv - uTexel).rgb
       + texture(tSource, vUv + vec2(uTexel.x, -uTexel.y)).rgb + texture(tSource, vUv + vec2(-uTexel.x, uTexel.y)).rgb;
    gl_FragColor = vec4(texture(tBase, vUv).rgb + s / 16.0, 1.0);
  }
`;

const FINAL_FRAGMENT = /* glsl */ `
  precision highp float;
  ${IGN}
  uniform sampler2D tColor;
  uniform sampler2D tBloom;
  uniform sampler2D tShafts;
  uniform vec3 uShaftColor;
  uniform float uBloom;
  uniform float uExposure;
  uniform float uSaturation;
  uniform float uVignette;
  uniform float uFlash;
  varying vec2 vUv;

  // Filmic curve (ACES fitted): soft shoulder for the bright sky and sun, a gentle toe for the shadows.
  vec3 tonemap(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  void main() {
    vec3 c = texture(tColor, vUv).rgb;
    c += texture(tBloom, vUv).rgb * uBloom;
    c += texture(tShafts, vUv).r * uShaftColor;
    c = tonemap(c * uExposure);
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = max(mix(vec3(l), c, uSaturation), 0.0);
    vec2 v = vUv - 0.5;
    c *= 1.0 - uVignette * smoothstep(0.2, 0.85, dot(v, v) * 2.0);
    c = pow(c, vec3(1.0 / 2.2));
    // Portal flash: a purple veil (like the game's portal nausea) hiding the switch of dimension.
    c = mix(c, vec3(0.5, 0.12, 0.85), 0.92 * uFlash);
    c += (ign(gl_FragCoord.xy) - 0.5) / 255.0;
    gl_FragColor = vec4(c, 1.0);
  }
`;

/** Uniforms the post pipeline shares with the scene (same objects, so one update serves both). */
export interface PostShared {
  uTime: THREE.IUniform<number>;
  uFog: THREE.IUniform<THREE.Vector2>;
  uNether: THREE.IUniform<number>;
  uSalt: THREE.IUniform<number>;
  uHorizon: THREE.IUniform<THREE.Color>;
  uZenith: THREE.IUniform<THREE.Color>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunset: THREE.IUniform<number>;
  uLightDir: THREE.IUniform<THREE.Vector3>;
  uLightColor: THREE.IUniform<THREE.Color>;
  uAmbUp: THREE.IUniform<THREE.Color>;
}

/** Per-frame inputs that are not shared with the scene. */
export interface PostFrame {
  /** Base cloud coverage 0..1 (slow, baked mood) and the smoothed cloud glow (mids). */
  coverage: number;
  cloudGlow: number;
  exposure: number;
  flash: number;
}

function target(type: THREE.TextureDataType, options: THREE.RenderTargetOptions = {}): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(1, 1, { type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false, ...options });
}

export class VoxelPost {
  private readonly quad: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly noise: THREE.Data3DTexture;
  private type: THREE.TextureDataType = THREE.HalfFloatType;
  private sceneTarget: THREE.WebGLRenderTarget | null = null;
  private readonly clouds: THREE.WebGLRenderTarget;
  private readonly composite: THREE.WebGLRenderTarget;
  private readonly shafts: THREE.WebGLRenderTarget;
  private readonly down: THREE.WebGLRenderTarget[] = [];
  private readonly up: THREE.WebGLRenderTarget[] = [];
  private readonly cloudMaterial: THREE.ShaderMaterial;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly shaftMaterial: THREE.ShaderMaterial;
  private readonly downMaterial: THREE.ShaderMaterial;
  private readonly upMaterial: THREE.ShaderMaterial;
  private readonly finalMaterial: THREE.ShaderMaterial;
  private readonly size = new THREE.Vector2();
  private width = 0;
  private height = 0;
  private readonly sunPoint = new THREE.Vector3();

  constructor(private readonly shared: PostShared) {
    const data = buildCloudNoise();
    this.noise = new THREE.Data3DTexture(data, CLOUD_NOISE_SIZE, CLOUD_NOISE_SIZE, CLOUD_NOISE_SIZE);
    this.noise.format = THREE.RGFormat;
    this.noise.type = THREE.UnsignedByteType;
    this.noise.minFilter = this.noise.magFilter = THREE.LinearFilter;
    this.noise.wrapS = this.noise.wrapT = this.noise.wrapR = THREE.RepeatWrapping;
    this.noise.unpackAlignment = 1;
    this.noise.needsUpdate = true;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(geometry);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    const pass = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false });
    this.clouds = target(this.type);
    this.composite = target(this.type);
    this.shafts = target(THREE.UnsignedByteType);
    for (let i = 0; i < POST.bloomLevels; i++) {
      this.down.push(target(this.type));
      this.up.push(target(this.type));
    }
    this.cloudMaterial = pass(CLOUD_FRAGMENT, {
      ...shared,
      tNoise: { value: this.noise },
      tScene: { value: null },
      uSceneTexel: { value: new THREE.Vector2() },
      uProjInv: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCam: { value: new THREE.Vector3() },
      uCoverage: { value: 0.5 },
      uGlow: { value: 0.5 },
    });
    this.compositeMaterial = pass(COMPOSITE_FRAGMENT, {
      tScene: { value: null },
      tClouds: { value: this.clouds.texture },
    });
    this.shaftMaterial = pass(SHAFT_FRAGMENT, {
      tScene: { value: null },
      tClouds: { value: this.clouds.texture },
      uSunUv: { value: new THREE.Vector2() },
      uAspect: { value: 1 },
    });
    this.downMaterial = pass(DOWN_FRAGMENT, { tSource: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 } });
    this.upMaterial = pass(UP_FRAGMENT, { tSource: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.finalMaterial = pass(FINAL_FRAGMENT, {
      tColor: { value: this.composite.texture },
      tBloom: { value: this.up[0]!.texture },
      tShafts: { value: this.shafts.texture },
      uShaftColor: { value: new THREE.Color() },
      uBloom: { value: POST.bloom },
      uExposure: { value: 1 },
      uSaturation: { value: POST.saturation },
      uVignette: { value: POST.vignette },
      uFlash: { value: 0 },
    });
  }

  /** (Re)creates the size-dependent targets when the drawing buffer changes. */
  private resize(renderer: THREE.WebGLRenderer): void {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x)), h = Math.max(1, Math.floor(this.size.y));
    if (w === this.width && h === this.height && this.sceneTarget) return;
    this.width = w;
    this.height = h;
    if (!this.sceneTarget) {
      // Half float colour needs EXT_color_buffer_float (or _half_float) on WebGL 2; without it, fall back to 8 bits.
      const ext = renderer.extensions;
      if (!ext.has('EXT_color_buffer_float') && !ext.has('EXT_color_buffer_half_float')) {
        this.type = THREE.UnsignedByteType;
        for (const t of [this.clouds, this.composite, ...this.down, ...this.up]) t.texture.type = this.type;
      }
      this.sceneTarget = target(this.type, { depthBuffer: true, samples: 4 });
    }
    this.sceneTarget.setSize(w, h);
    this.composite.setSize(w, h);
    this.clouds.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    this.shafts.setSize(Math.ceil(w / 4), Math.ceil(h / 4));
    for (let i = 0; i < POST.bloomLevels; i++) {
      const s = 2 ** (i + 1);
      this.down[i]!.setSize(Math.max(1, Math.ceil(w / s)), Math.max(1, Math.ceil(h / s)));
      this.up[i]!.setSize(Math.max(1, Math.ceil(w / s)), Math.max(1, Math.ceil(h / s)));
    }
    this.compositeMaterial.uniforms.tScene!.value = this.sceneTarget.texture;
    this.shaftMaterial.uniforms.tScene!.value = this.sceneTarget.texture;
    this.cloudMaterial.uniforms.tScene!.value = this.sceneTarget.texture;
    this.cloudMaterial.uniforms.uSceneTexel!.value.set(1 / w, 1 / h);
  }

  private draw(renderer: THREE.WebGLRenderer, material: THREE.ShaderMaterial, out: THREE.WebGLRenderTarget | null): void {
    this.quad.material = material;
    renderer.setRenderTarget(out);
    renderer.render(this.quadScene, this.quadCamera);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, frame: PostFrame): void {
    this.resize(renderer);
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.sceneTarget);
    renderer.render(scene, camera);

    const cu = this.cloudMaterial.uniforms;
    cu.uProjInv!.value.copy(camera.projectionMatrixInverse);
    cu.uCamWorld!.value.copy(camera.matrixWorld);
    cu.uCam!.value.copy(camera.position);
    cu.uCoverage!.value = frame.coverage;
    cu.uGlow!.value = frame.cloudGlow;
    this.draw(renderer, this.cloudMaterial, this.clouds);
    this.draw(renderer, this.compositeMaterial, this.composite);

    // Light shafts: only while the sun is up and in front of the camera; fades as it leaves the screen.
    const sun = this.shared.uSunDir.value;
    this.sunPoint.copy(sun).multiplyScalar(1000).add(camera.position).project(camera);
    const facing = camera.getWorldDirection(new THREE.Vector3()).dot(sun);
    const onScreen = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(this.sunPoint.x), Math.abs(this.sunPoint.y)), 1.0, 1.8);
    const shaftK = this.shared.uNether.value > 0.5 || facing <= 0 ? 0 : POST.shafts * onScreen * THREE.MathUtils.smoothstep(facing, 0, 0.5);
    const shaftColor = this.finalMaterial.uniforms.uShaftColor!.value as THREE.Color;
    shaftColor.copy(this.shared.uSunColor.value).multiplyScalar(shaftK * (0.35 + 0.65 * this.shared.uSunset.value));
    if (shaftK > 0) {
      this.shaftMaterial.uniforms.uSunUv!.value.set(this.sunPoint.x * 0.5 + 0.5, this.sunPoint.y * 0.5 + 0.5);
      this.shaftMaterial.uniforms.uAspect!.value = this.width / this.height;
      this.draw(renderer, this.shaftMaterial, this.shafts);
    }

    // Bloom: downsample chain (the first step thresholds), then accumulate back up.
    const du = this.downMaterial.uniforms, uu = this.upMaterial.uniforms;
    let source: THREE.WebGLRenderTarget = this.composite;
    for (let i = 0; i < POST.bloomLevels; i++) {
      du.tSource!.value = source.texture;
      du.uTexel!.value.set(1 / source.width, 1 / source.height);
      du.uPrefilter!.value = i === 0 ? 1 : 0;
      this.draw(renderer, this.downMaterial, this.down[i]!);
      source = this.down[i]!;
    }
    let acc = this.down[POST.bloomLevels - 1]!;
    for (let i = POST.bloomLevels - 2; i >= 0; i--) {
      uu.tSource!.value = acc.texture;
      uu.tBase!.value = this.down[i]!.texture;
      uu.uTexel!.value.set(1 / acc.width, 1 / acc.height);
      this.draw(renderer, this.upMaterial, this.up[i]!);
      acc = this.up[i]!;
    }

    const fu = this.finalMaterial.uniforms;
    fu.uExposure!.value = frame.exposure;
    fu.uFlash!.value = frame.flash;
    fu.tShafts!.value = this.shafts.texture;
    if (shaftK <= 0) shaftColor.setRGB(0, 0, 0);
    this.draw(renderer, this.finalMaterial, previous);
  }

  dispose(): void {
    for (const t of [this.sceneTarget, this.clouds, this.composite, this.shafts, ...this.down, ...this.up]) t?.dispose();
    for (const m of [this.cloudMaterial, this.compositeMaterial, this.shaftMaterial, this.downMaterial, this.upMaterial, this.finalMaterial]) m.dispose();
    this.quad.geometry.dispose();
    this.noise.dispose();
  }
}
