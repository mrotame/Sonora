// Voxel Dreamscape: the sky colour as a GLSL function, shared by the sky dome, the distance fog (fogged geometry takes
// the exact colour of the sky behind it, so it melts into the sky with no seam), the water reflections and the clouds'
// aerial perspective. Linear HDR values; no sun disc, stars or clouds (those are drawn by the dome and the cloud pass).
export const SKY_GLSL = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uSunset;
  uniform float uNether;

  vec3 skyBase(vec3 d) {
    if (uNether > 0.5) return uHorizon;
    float e = d.y;
    float up = pow(smoothstep(0.0, 0.62, e), 0.75);
    vec3 col = mix(uHorizon, uZenith, up);
    col *= mix(1.0, 0.78, smoothstep(0.0, -0.35, e));
    float cosS = dot(d, uSunDir);
    float toward = max(cosS, 0.0);
    // Sunset band: a warm glow along the horizon, strongest toward the sun.
    float band = exp(-abs(e) * 7.0) * uSunset * (0.25 + 0.75 * pow(cosS * 0.5 + 0.5, 3.0));
    col = mix(col, vec3(1.0, 0.3, 0.08) * (0.55 + 0.45 * uSunset), clamp(band, 0.0, 0.85));
    // Glare around the sun (forward scattering): a wide haze and a tight halo.
    col += uSunColor * (pow(toward, 6.0) * (0.08 + 0.2 * uSunset) + pow(toward, 90.0) * 0.6) * smoothstep(-0.25, 0.05, e);
    return col;
  }
`;
