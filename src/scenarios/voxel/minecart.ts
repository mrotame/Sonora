// Voxel Dreamscape: the minecart the camera rides in the Nether (Three.js, main thread). The block game's conventions,
// not its code: five boxes 2 px thick in model pixels (16 px = 1 m) with the standard box texture layout on the entity
// texture (64 x 32 model texels; the Faithful file is 128 x 64), shaded per face with the game's two fixed entity lights.
// It is drawn in its own pass with a close near plane (scene.ts / post.ts), so it is never cut at the bottom of the screen.
import * as THREE from 'three';

/** One part: a box (min corner and size, model pixels), its texture offset, and its pose (offset in pixels, rotation). */
interface Part { box: [number, number, number, number, number, number]; tex: [number, number]; offset: [number, number, number]; rot: [number, number, number] }

const H = Math.PI / 2;
/** The cart: a 20 x 16 floor and four walls 8 px tall, 10 px in all; the long side along the model's x. */
const PARTS: Part[] = [
  { box: [-10, -8, -1, 20, 16, 2], tex: [0, 10], offset: [0, 4, 0], rot: [H, 0, 0] }, // floor
  { box: [-8, -9, -1, 16, 8, 2], tex: [0, 0], offset: [-9, 4, 0], rot: [0, 3 * H, 0] }, // front
  { box: [-8, -9, -1, 16, 8, 2], tex: [0, 0], offset: [9, 4, 0], rot: [0, H, 0] }, // back
  { box: [-8, -9, -1, 16, 8, 2], tex: [0, 0], offset: [0, 4, -7], rot: [0, 2 * H, 0] }, // left
  { box: [-8, -9, -1, 16, 8, 2], tex: [0, 0], offset: [0, 4, 7], rot: [0, 0, 0] }, // right
];
const TEX_W = 64, TEX_H = 32;
/**
 * Height (m) of the rotation pivot over the cart's rail point: the model is drawn around it, y down in model space
 * (the entity renderer's scale(-1, -1, 1)), so the floor's underside sits 1/16 over the rail point and the rim 0.6875.
 */
export const CART_PIVOT = 0.375;

/**
 * The cart geometry around its pivot, long side along z (the travel axis), with position, uv and normal: 6 faces per
 * box, each face mapped like the game's box layout (top and bottom strips over the side strips).
 */
export function minecartGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], nrm: number[] = [], idx: number[] = [];
  // Model to cart space: pixels to metres, the renderer's flip (x and y), and a quarter turn so the long side runs along z.
  const toCart = new THREE.Matrix4().makeRotationY(H).multiply(new THREE.Matrix4().makeScale(-1 / 16, -1 / 16, 1 / 16));
  const v = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const p of PARTS) {
    const m = toCart.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(...p.offset), new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rot[0], p.rot[1], p.rot[2], 'ZYX')), new THREE.Vector3(1, 1, 1)));
    const [x0, y0, z0, w, h, d] = p.box, x1 = x0 + w, y1 = y0 + h, z1 = z0 + d;
    const [u, t] = p.tex;
    const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] as const;
    // Faces as the game's box: corners and their texture rectangle (the first corner gets (ua, va), then (ub, va), (ub, vb), (ua, vb)).
    const faces: [readonly number[], number, number, number, number][] = [
      [[5, 4, 0, 1], u + d + w, t, u + d, t + d], // y0
      [[2, 3, 7, 6], u + d + w + w, t + d, u + d + w, t], // y1
      [[0, 4, 7, 3], u + d, t + d, u, t + d + h], // x0
      [[1, 0, 3, 2], u + d + w, t + d, u + d, t + d + h], // z0
      [[5, 1, 2, 6], u + d + w + d, t + d, u + d + w, t + d + h], // x1
      [[4, 5, 6, 7], u + d + w + d + w, t + d, u + d + w + d, t + d + h], // z1
    ];
    const centre = new THREE.Vector3(x0 + w / 2, y0 + h / 2, z0 + d / 2).applyMatrix4(m);
    for (const [corners, ua, va, ub, vb] of faces) {
      const base = pos.length / 3;
      c.set(0, 0, 0);
      const uvs = [[ua, va], [ub, va], [ub, vb], [ua, vb]];
      corners.forEach((k, i) => {
        v.set(...(P[k] as [number, number, number])).applyMatrix4(m);
        c.add(v);
        pos.push(v.x, v.y, v.z);
        uv.push(uvs[i]![0]! / TEX_W, 1 - uvs[i]![1]! / TEX_H);
      });
      // Outward normal: from the box centre to the face centre (independent of the corner winding; drawn double sided).
      n.copy(c.multiplyScalar(0.25)).sub(centre).normalize();
      for (let i = 0; i < 4; i++) nrm.push(n.x, n.y, n.z);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

// The entity texture, linear, shaded like the game's entities (two fixed lights from above, 0.4 ambient + 0.6 diffuse,
// so the rim and the floor read brighter than the walls and the faces facing away darker), then lit by the lava.
export const CART_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
export const CART_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tCart;
  uniform vec3 uAmbDown;
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    vec4 t = texture2D(tCart, vUv);
    if (t.a < 0.5) discard;
    vec3 n = normalize(vNormal);
    float shade = min(1.0, 0.4 + 0.6 * (max(0.0, dot(n, normalize(vec3(0.2, 1.0, -0.7)))) + max(0.0, dot(n, normalize(vec3(-0.2, 1.0, 0.7))))));
    gl_FragColor = vec4(pow(t.rgb * vec3(0.6, 0.6, 0.66) * shade, vec3(2.2)) * (uAmbDown * 2.5 + 0.08), 1.0);
  }
`;
