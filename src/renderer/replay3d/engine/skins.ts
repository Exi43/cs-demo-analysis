// Skins (Port von spike/fp/skins compositor.mjs): CS2 setzt Farbe/Metalness eines Skins zur Laufzeit zusammen
// (csgo_customweapon.vfx, Formeln aus der lokalen Shader-VPK abgeleitet, neu geschrieben; Belege build-light-skins/S/formeln.md).
// Hier ein WebGL2-Pass im UV-Raum: Waffe → map (sRGB-Albedo) + orm (G Rauheit, B Metall wie glTF, A Lack-/Perl-Maske), Handschuh
// → map/orm/normal über GloveCompositor (gloves.ts). Seed rollt Muster/Wear/Grunge (+ Case-Hardening-Zusatzwürfe) über Valves UniformRandomStream, Wear = Demo-Float.
// Kit-Daten: paint.vars (roh wie im vmat; Ausdrücke wie sRGB→linear, 1−Haltbarkeit wendet buildWeapon an) vor den alten Feldern,
// paint.tex (Overlay, CH-Rampe, eigene Wear/Grunge, Metall, Perl-Maske, AO-Override), rolls in Würfel-Reihenfolge; fehlt → alter Weg.
// Ebenen im Shader: Overlay (F_OVERLAY_TEXTURE), Halftone (F_SPRAYPAINT_HALFTONE, Stil 2), Case Hardening (F_CASE_HARDENING, auch
// trilinear), Metall-Textur, Perl-Maske. Laufzeit-Effekte (Perlglanz, Iridescence, Glitter, AO-Override) → SkinTex.finish + applyFinish.
// SkinCache: erst beim Sichtbarwerden, einer nach dem anderen außerhalb des Bildes (40–150 ms je Skin), bis dahin Vanilla; Ego-Waffe/-Handschuh
// zuerst (Größe egoSize, Ego-Anfrage baut einen kleineren Skin einmal größer nach), sonst der zuletzt angefragte;
// LRU weich ab 24 Einträgen, verdrängt nur nach 10 s ohne Nutzung (1024² ×2 + Mips ≈ 11 MB VRAM je Waffen-Skin, 2048² ≈ 44 MB).
// Ein Programm je Feature-Kombination (bleibt im Cache, Uniforms je Skin); Eingabe-Texturen nur für den Pass auf der GPU.
import * as THREE from 'three'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'
import type { Assets3D, GloveSkin, GloveSkin2, RollVar, WeaponSkin } from '../../../shared/assets3d'
import type { Paint3D, Player3D, Skin3D } from '../../../shared/cs3d'
import type { Side } from '../../../shared/model'
import { GloveCompositor } from './gloves'

const SIZE = 1024, CAP = 24

// ---------------------------------------------------------------- Seed → Zufallswerte (Valve CUniformRandomStream)
export class UniformRandomStream {
  private idum: number; private iy = 0; private readonly iv = new Int32Array(32)
  constructor(seed: number) { this.idum = seed < 0 ? seed : -seed }
  next() {
    const IA = 16807, IM = 2147483647, IQ = 127773, IR = 2836, NTAB = 32, NDIV = 1 + Math.floor((IM - 1) / NTAB)
    let j: number, k: number
    if (this.idum <= 0 || !this.iy) {
      this.idum = -this.idum < 1 ? 1 : -this.idum
      for (j = NTAB + 7; j >= 0; j--) {
        k = Math.trunc(this.idum / IQ); this.idum = IA * (this.idum - k * IQ) - IR * k
        if (this.idum < 0) this.idum += IM
        if (j < NTAB) this.iv[j] = this.idum
      }
      this.iy = this.iv[0]
    }
    k = Math.trunc(this.idum / IQ); this.idum = IA * (this.idum - k * IQ) - IR * k
    if (this.idum < 0) this.idum += IM
    j = Math.trunc(this.iy / NDIV); if (j >= NTAB || j < 0) j = (j % NTAB) & 0x7fffffff
    this.iy = this.iv[j]; this.iv[j] = this.idum
    return this.iy
  }
  float(lo: number, hi: number) { let f = Math.fround((1 / 2147483647) * this.next()); if (f > 1 - 1.2e-7) f = 1 - 1.2e-7; return Math.fround(f * (hi - lo) + lo) }
}
/** fehlende Variable verbraucht trotzdem einen Wurf; ohne Grenzen fester Wert */
const roll = (rng: UniformRandomStream, v: RollVar | null, axis: 'x' | 'y', fb: number) => {
  const base = (axis === 'x' ? v?.x : v?.y) ?? fb
  return rng.float((axis === 'x' ? v?.xmin : v?.ymin) ?? base, (axis === 'x' ? v?.xmax : v?.ymax) ?? base)
}
const two = (v: RollVar | null, x: number, y: number): RollVar => ({ x, y, ...v })
const one = (v: RollVar | null, x: number): RollVar => { const r = { x, ...v }; delete r.y; delete r.ymin; delete r.ymax; return r }
/**
 * Würfe des vcompmat: ws.rolls in Reihenfolge (econ_instance bzw. exposed_params, dazu Case-Hardening-Zusatzwürfe), je Variable x und –
 * wenn die Liste eine y-Achse nennt – y. Ohne rolls die feste Reihenfolge von _shared_paint_generic: Muster-Versatz x/y, Muster-Drehung,
 * Wear-Skala, Wear-Versatz x/y, Wear-Drehung, Grunge-Skala, Grunge-Versatz x/y, Grunge-Drehung. rolled = gewürfelte Werte je Variable.
 */
export function rollSeed(ws: WeaponSkin, seed: number) {
  const P = ws.paint, R = ws.roll, rng = new UniformRandomStream(seed), rolled: Record<string, number[]> = {}
  const list: [string, RollVar][] = ws.rolls ?? [
    ['g_vPatternTexCoordOffset', two(R.patternOffset, P.patternOffset[0], P.patternOffset[1])], ['g_flPatternTexCoordRotation', one(R.patternRotation, P.patternRotation)],
    ['g_flWearTexCoordScale', one(R.wearScale, P.wearScale)], ['g_vWearTexCoordOffset', two(R.wearOffset, 0, 0)], ['g_flWearTexCoordRotation', one(R.wearRotation, 0)],
    ['g_flGrungeTexCoordScale', one(R.grungeScale, P.grungeScale)], ['g_vGrungeTexCoordOffset', two(R.grungeOffset, 0, 0)], ['g_flGrungeTexCoordRotation', one(R.grungeRotation, 0)],
  ]
  for (const [name, v] of list) {
    const x = roll(rng, v, 'x', 0)
    rolled[name] = v.y !== undefined || v.ymin !== undefined || v.ymax !== undefined ? [x, roll(rng, v, 'y', 0)] : [x]
  }
  const g = (k: string, i: number, fb: number) => rolled[k]?.[i] ?? P.vars?.[k]?.[i] ?? fb
  return {
    patternOffset: [g('g_vPatternTexCoordOffset', 0, P.patternOffset[0]), g('g_vPatternTexCoordOffset', 1, P.patternOffset[1])],
    patternRotation: g('g_flPatternTexCoordRotation', 0, P.patternRotation),
    wearScale: g('g_flWearTexCoordScale', 0, P.wearScale), wearOffset: [g('g_vWearTexCoordOffset', 0, 0), g('g_vWearTexCoordOffset', 1, 0)], wearRotation: g('g_flWearTexCoordRotation', 0, 0),
    grungeScale: g('g_flGrungeTexCoordScale', 0, P.grungeScale), grungeOffset: [g('g_vGrungeTexCoordOffset', 0, 0), g('g_vGrungeTexCoordOffset', 1, 0)], grungeRotation: g('g_flGrungeTexCoordRotation', 0, 0),
    rolled,
  }
}
/** g_v*TexCoordXform0/1 aus csgo_customweapon.vfx (Werte auf 0.01 gerundet wie das Materialsystem) */
export function texXform(rotDeg: number, scale: number, sizeScale: number, offX: number, offY: number): [THREE.Vector4, THREE.Vector4] {
  const q = (v: number) => Math.floor((v + 0.005) * 100) / 100
  const r = (q(rotDeg) * Math.PI) / 180, s = q(scale * sizeScale), c = Math.cos(r), sn = Math.sin(r)
  const v6 = 0.5 / (s !== 0 ? s : 1), v7 = Math.cos(-r), v8 = Math.sin(-r)
  const v9 = v6 * v7 - v6 * v8, v10 = v9 * v8 + v6 * v7
  return [new THREE.Vector4(c * s, -sn * s, 0, s * c * v9 + s * -sn * v10 + (q(offX) - 0.5)), new THREE.Vector4(sn * s, c * s, 0, s * sn * v9 + s * c * v10 + (q(offY) - 0.5))]
}

// Albedo-Level (vfx Expression float3(-x, -1.4427*log(max(.0001,1-y)), 2-z))
const lv = (x: number, y: number, z: number) => new THREE.Vector3(-x, -1.4427 * Math.log(Math.max(0.0001, 1 - y)), 2 - z)
const PAINT_LEVELS = lv(-0.045, 0.6, 1), METALLIC_PAINT_LEVELS = lv(-0.08, 0.6, 1), ALBEDO_LEVELS = lv(-0.045, 0.4, 1.15)
const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
/** g_nPatternTexture*Sampling → Wrap */
const WRAP = [THREE.RepeatWrapping, THREE.MirroredRepeatWrapping, THREE.ClampToEdgeWrapping, THREE.ClampToEdgeWrapping, THREE.MirroredRepeatWrapping]
const ID0 = new THREE.Vector4(1, 0, 0, 0), ID1 = new THREE.Vector4(0, 1, 0, 0)

const VS = /* glsl */ `
in vec3 position; in vec2 uv;
uniform vec4 uPat0, uPat1, uWear0, uWear1, uGr0, uGr1, uOv0, uOv1;
out vec2 vUv; out vec2 vPat; out vec2 vWear; out vec2 vGrunge; out vec2 vOv;
void main() {
  vUv = uv;
  vPat = vec2(dot(uv, uPat0.xy) + uPat0.w, dot(uv, uPat1.xy) + uPat1.w);
  vWear = vec2(dot(uv, uWear0.xy) + uWear0.w, dot(uv, uWear1.xy) + uWear1.w);
  vGrunge = vec2(dot(uv, uGr0.xy) + uGr0.w, dot(uv, uGr1.xy) + uGr1.w);
  vOv = vec2(dot(uv, uOv0.xy) + uOv0.w, dot(uv, uOv1.xy) + uOv1.w);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`

// STYLE 0 solid, 1 hydrographic, 2 spraypaint, 3 anodized, 4 anodized multi, 5 anodized airbrushed, 6 custom, 7 patina, 8 gunsmith.
// OVERLAY/HALFTONE/ALL_MASKS/METAL_TEX/PEARL_MASK 0|1, CH 0 aus, 1 Muster-UV, 2 trilinear (Position wie Spray)
const FS = /* glsl */ `
precision highp float;
uniform sampler2D tAO, tMasks, tWear, tGrunge, tPattern, tColor, tRough, tMetal, tSurface, tPos, tPaintRough;
uniform sampler2D tOverlay, tOverlayMask, tNormal, tRamp, tPaintMetal, tPearlMask;
uniform vec3 uC0, uC1, uC2, uC3, uPaintLevels, uMetalPaintLevels, uAlbedoLevels, uSprayBiasBlend, uHtLevels;
uniform vec4 uDur, uPR4, uPM4, uPat0, uPat1, uHtA0, uHtA1, uHtB0, uHtB1, uHtC0, uHtC1, uCH;
uniform vec2 uHtThr;
uniform float uWearSoft, uWearAmount, uBright, uPaintRough, uPaintMetal, uHtCut, uChPI, uChGI, uChOff;
uniform float uOvStrength, uOvBright, uOvDur, uOvMatStrength, uOvMetal, uOvRough, uOvPearl;
uniform int uColorAdj, uRoughPerColor, uPearlMetalOnly, uRoughTex, uRoughPatUV, uMetalPatUV, uOvMask, uOvBlend, uHtInCav;
in vec2 vUv; in vec2 vPat; in vec2 vWear; in vec2 vGrunge; in vec2 vOv;
out vec4 outColor;
const vec3 LUM = vec3(0.2125, 0.7154, 0.0721);
const vec2 K[17] = vec2[](vec2(-0.00107234, -0.00400203), vec2(0.00195312, -0.00338291), vec2(0.00400203, -0.00107234), vec2(-0.000714896, -0.00266802),
  vec2(0.000976565, -0.00169146), vec2(0.00266802, -0.000714896), vec2(-0.00338291, -0.00195312), vec2(-0.00169146, -0.000976565), vec2(0.0),
  vec2(0.00169146, 0.000976565), vec2(0.00338291, 0.00195312), vec2(-0.00266802, 0.000714896), vec2(-0.000976565, 0.00169146), vec2(0.000714896, 0.00266802),
  vec2(-0.00400203, 0.00107234), vec2(-0.00195312, 0.00338291), vec2(0.00107234, 0.00400202));
vec3 C[4]; // Farbkette g_vColor0..3 (mit Case-Hardening-Rampe)
float luma(vec3 c) { return dot(c, LUM); }
float band(float a) { return smoothstep(0.5, 0.6, a) * smoothstep(1.0, 0.9, a); }
vec3 levels(vec3 c, vec3 lumSrc, vec3 L) {
  vec3 n = normalize(max(vec3(3e-4), c));
  return n * mix(min(L.x, dot(lumSrc, LUM)), L.z, clamp(pow(max(c.x, max(c.y, c.z)), L.y), 0.0, 1.0)) / max(n.x, max(n.y, n.z));
}
vec3 finish(vec3 c, vec3 lumSrc, vec3 L, vec3 base, float removed) { return mix(mix(c, levels(c, lumSrc, L), uWearAmount), base, removed); }
float chain3(vec4 v, vec3 w) { return mix(mix(mix(v.x, v.y, w.x), v.z, w.y), v.w, w.z); }
vec3 chain3c(vec3 w) { return mix(mix(mix(C[0], C[1], w.x), C[2], w.y), C[3], w.z); }
float paintMetal(float x) {
#if METAL_TEX
  return texture(tPaintMetal, uMetalPatUV != 0 ? vPat : vUv).x; // F_METALNESS_TEXTURE statt g_vPaintMetalness
#else
  return x;
#endif
}
float paintRough(float x) { return uRoughTex != 0 ? texture(tPaintRough, uRoughPatUV != 0 ? vPat : vUv).x : x; }
#if STYLE == 2 || STYLE == 5 || CH == 2
vec4 P4; vec3 SN; // weichgezeichnete Objekt-Position ·2, Flächennormale
void triInit() {
  vec4 p = vec4(0.0);
  for (int i = 0; i < 17; i++) p += texture(tPos, vUv + K[i] * 0.2) * (1.0 / 17.0);
  P4 = p * 2.0;
#if HALFTONE
  P4.z = -P4.z;
#endif
  vec3 s = texture(tSurface, vUv).xyz;
  if (uSprayBiasBlend.x > 0.5) s = mix(s * 12.92, pow(s, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, s)); // g_bBiasSpray: linear → sRGB
  SN = normalize(s * 2.0 - 1.0);
}
vec4 tri(vec4 X0, vec4 X1, vec2 d) { // Muster dreifach projiziert (yz, xz, yx), nach Flächennormale gemischt
  vec4 a = texture(tPattern, vec2(dot(P4.yz, X0.xy) + X0.w, dot(P4.yz, X1.xy) + X1.w) + d);
  vec4 b = texture(tPattern, vec2(dot(P4.xz, X0.xy) + X0.w, dot(P4.xz, X1.xy) + X1.w) + d);
  vec4 c = texture(tPattern, vec2(dot(P4.yx, X0.xy) + X0.w, dot(P4.yx, X1.xy) + X1.w) + d);
  return mix(mix(a, b, uSprayBiasBlend.y * pow(abs(SN.y), 7.0)), c, uSprayBiasBlend.z * pow(abs(SN.z), 7.0));
}
#endif
#if HALFTONE
vec3 halftone(vec3 p, float c, float g) { // Kavitäts-Stufe, dann Raster aus drei gedrehten Projektionen (Alpha)
  float h = smoothstep(uHtLevels.x, uHtLevels.z, pow((uHtInCav != 0 ? min(c, uHtCut) : c) * g * 2.0, uHtLevels.y));
  p *= (uHtInCav != 0) == (uHtThr.x > uHtThr.y) ? h : 1.0 - h;
  vec3 r = vec3(tri(uHtA0, uHtA1, vec2(0.0)).w, tri(uHtB0, uHtB1, vec2(0.0)).w, tri(uHtC0, uHtC1, vec2(0.0)).w);
  return smoothstep(vec3(uHtThr.x), vec3(uHtThr.y), p * r);
}
#endif
#if CH
vec4 chPat(vec2 d) {
#if CH == 2
  return tri(uPat0, uPat1, d);
#else
  return texture(tPattern, vPat + d);
#endif
}
vec4 caseRamp(float c, float g) { // Rampe über Muster × Geometrie (Kanten aus der Lack-Normal-Map), Mittel aus 5 Proben (s1440/s1448)
  vec4 n = texture(tNormal, vUv), e = smoothstep(vec4(0.85), vec4(0.2), min(n, 1.0 - n));
  float geo = mix(0.5, pow(c, 0.85), uChGI) * mix(1.0, g * min(e.x, e.y) * 2.0, uChGI);
  vec4 p = chPat(vec2(0.0));
  float v = max(p.y * uChPI, (1.0 - g) * 0.2 * uChGI) + uChOff;
  const float D = 1.0 / 2048.0;
  vec4 r = texture(tRamp, vec2(mix(2.0 * geo, geo + p.x, uChPI), v));
#if STYLE == 7
  return r; // Patina-Combo: eine Probe (s1447)
#endif
  r += texture(tRamp, vec2(mix(2.0 * geo, geo + chPat(vec2(D)).x, uChPI), v));
  r += texture(tRamp, vec2(mix(2.0 * geo, geo + chPat(vec2(-D)).x, uChPI), v));
  r += texture(tRamp, vec2(mix(2.0 * geo, geo + chPat(vec2(-D, D)).x, uChPI), v));
  r += texture(tRamp, vec2(mix(2.0 * geo, geo + chPat(vec2(D, -D)).x, uChPI), v));
  return r * 0.2;
}
#endif
#if OVERLAY
vec4 OV; float OM; // Overlay: rgb·Helligkeit, a = Stärke·Maske; OM = Alpha nach Maske (für die Haltbarkeit)
void ovInit(vec4 m) {
  vec4 o = texture(tOverlay, vOv);
  float mx = max(m.x, max(m.y, m.z));
  if (uOvMask == 1) o.w *= 1.0 - mx;
  else if (uOvMask == 2) o.w *= m.x * (1.0 - max(m.y, m.z));
  else if (uOvMask == 3) o.w *= m.y * (1.0 - m.z);
  else if (uOvMask == 4) o.w *= m.z;
  else if (uOvMask == 5) o.w *= mx;
  else if (uOvMask == 8) o.w *= texture(tOverlayMask, vUv).x;
  OM = o.w; OV = vec4(o.rgb * uOvBright, o.w * uOvStrength);
}
float ovRemoved(float removed, float rO) { return uOvMask == 0 ? max(0.0, mix(removed, min(removed, rO), OV.w)) : removed; }
float ovAlpha(float rO) { return uOvBlend == 4 ? OV.w * clamp(1.0 - rO, 0.0, 1.0) : OV.w; }
vec3 ovLevels(vec3 X, vec3 B, float k) { // Helligkeit auf g_vAlbedoLevels (Blend Color/Multiply/Add)
  vec3 L = uAlbedoLevels, n = normalize(max(vec3(3e-4), X)) * 1.06;
  vec3 r = max(n * (L.x * 1.732 / length(n) / luma(n)), n * mix(L.x, L.z, clamp(pow(max(B.x, max(B.y, B.z)) * k, L.y), 0.0, 1.0)));
  float t = luma(clamp(B * k, 0.0, 1.0));
  if (k > 1.5) r = mix(r, min(vec3(L.z), r + t * 2.0), 1.0 / 63.0);
  return mix(vec3(L.x), r, pow(smoothstep(3e-4, L.x, t), 0.5));
}
vec3 ovBlend(vec3 P, float a) {
  vec3 O = OV.rgb;
  if (uOvBlend == 1) return mix(P, ovLevels(O * P, P, 1.0), a);
  if (uOvBlend == 2) return mix(P, ovLevels(P * O, P * O, 1.0), a);
  if (uOvBlend == 3) return mix(P, ovLevels(P + O, P + O, 2.0), a);
  return mix(P, O, a); // 0 Normal, 4 Layer
}
#endif
void main() {
  vec4 ao = texture(tAO, vUv);           // R Cavity, G AO, A ohne Lack
#if SEPARATE
  float cavRaw = pow(ao.x, 1.5), cav = cavRaw * 0.96, aoG = ao.y;
#else
  float cavRaw = ao.x, cav = ao.x, aoG = ao.y;
#endif
  vec4 m = texture(tMasks, vUv);
  float w = texture(tWear, vWear).x;
  vec4 graw = texture(tGrunge, vGrunge);
  vec4 g = mix(vec4(1.0), graw, pow(1.0 - cav, 4.0) * 0.25 + 0.75 * uWearAmount);
  vec2 metal = vec2(texture(tRough, vUv).x, texture(tMetal, vUv).x);   // Rauheit/Metall der unlackierten Waffe
  vec3 base = texture(tColor, vUv).rgb;
  float wA = uWearAmount, wear6 = wA * 6.0 + 1.0;
#if SEPARATE
  float wt = w * mix(smoothstep(0.0, 0.72, pow(cav, 1.3)), smoothstep(0.0, 0.4, cav), pow(wA, 1.2));
  const float RLO = 0.56, RHI = 0.74;
#else
  float wt = w * cav;
  const float RLO = 0.58, RHI = 0.68;
#endif
  C[0] = uC0; C[1] = uC1; C[2] = uC2; C[3] = uC3;
#if STYLE == 2 || STYLE == 5 || CH == 2
  triInit();
#endif
#if CH
  vec4 ramp = caseRamp(cav, aoG);
  #if STYLE != 7 && STYLE != 8
  C[0] = mix(uC0, ramp.rgb, uCH.x); C[1] = mix(uC1, ramp.rgb, uCH.y); C[2] = mix(uC2, ramp.rgb, uCH.z); C[3] = mix(uC3, ramp.rgb, uCH.w);
  #endif
#endif
#if OVERLAY
  ovInit(m);
  float oDur = mix(1.0, uOvDur, OM), rO = 0.0, oa = 0.0, ok = 0.0;
#else
  const float oDur = 1.0;
#endif
  float rough, met, removed, paintMask = 1.0;
  vec3 col = vec3(0.0);
#if STYLE == 0
  float dur = chain3(uDur, m.xyz), soft = uWearSoft * dur;
  removed = smoothstep(RLO - soft, RHI + soft, (ao.w + wt) * wear6 * oDur * dur);
  float pm = paintMetal(chain3(uPM4, m.xyz)), pmL = pm;
  float pr = paintRough(uRoughPerColor != 0 ? chain3(uPR4, m.xyz) : uPaintRough);
  vec3 pc = chain3c(m.xyz);
  #if OVERLAY
  rO = smoothstep(RLO - soft, RHI + soft, wt * wear6 * uOvDur); removed = ovRemoved(removed, rO); oa = ovAlpha(rO); ok = (1.0 - rO) * oa * uOvMatStrength;
  pm = mix(pm, uOvMetal, ok); pr = mix(pr, uOvRough, ok); pc = ovBlend(pc, oa);
  #endif
  rough = mix(min(1.0, pr + (1.0 - g.w) * wA * wA * 0.5), metal.x, removed); met = mix(pm, metal.y, removed);
  vec3 c = pc * g.rgb;
  col = finish(c, pc, mix(uPaintLevels, uMetalPaintLevels, pmL), base, removed);
  paintMask = 1.0 - removed;
#elif STYLE == 1 || STYLE == 2
  #if STYLE == 1
  vec4 pat = texture(tPattern, vPat);
  float b = band(pat.w);
  float dur = mix(mix(chain3(uDur, pat.xyz), uDur.z, m.y), uDur.w, m.z), wtX = wt;
  float val = ((ao.w + wt) * wear6 + b) * oDur * max(clamp(m.y + m.z, 0.0, 1.0), smoothstep(0.0, 0.5, pat.w)) * dur;
  #else
  vec4 pat = tri(uPat0, uPat1, vec2(0.0));
    #if HALFTONE
  pat.rgb = halftone(pat.rgb, cav, aoG);
    #endif
  float b = band(pat.w);
    #if ALL_MASKS
  float dur = mix(mix(chain3(uDur, pat.xyz), uDur.z, m.y), uDur.w, m.z);
    #else
  float dur = chain3(uDur, pat.xyz);
    #endif
    #if SEPARATE
  float wtX = w * mix(smoothstep(0.0, 0.68, pow(cav, 1.1)), smoothstep(0.0, 0.51, pow(cav, 0.8)), pow(wA, 0.3));
    #else
  float wtX = wt;
    #endif
  float val = (ao.w + wtX) * wear6 * oDur * dur;
  #endif
  float soft = uWearSoft * dur, t1 = 0.56 - 0.06 * wA, t2 = 0.54 - 0.12 * wA;
  vec3 L = pat.xyz * vec3(smoothstep(0.58 + soft, t1 - soft, val), smoothstep(t1 + soft, t2 - soft, val), smoothstep(t2 + soft, 0.52 - 0.18 * wA - soft, val));
  removed = smoothstep(RLO - soft, RHI + soft, val);
  #if STYLE == 1 || ALL_MASKS // Masken G/B setzen Farbe 2/3 (Hydro immer, Spray mit F_USE_ALL_MASKS, s308)
  float pm = paintMetal(mix(mix(chain3(uPM4, L), uPM4.z, m.y), uPM4.w, m.z));
  float pr = paintRough(uRoughPerColor != 0 ? mix(mix(chain3(uPR4, L), uPR4.z, m.y), uPR4.w, m.z) : uPaintRough);
  vec3 pc = mix(mix(chain3c(L), C[2], m.y), C[3], m.z);
  #else
  float pm = paintMetal(chain3(uPM4, L));
  float pr = paintRough(uRoughPerColor != 0 ? chain3(uPR4, L) : uPaintRough);
  vec3 pc = chain3c(L);
  #endif
  float pmL = pm;
  #if OVERLAY
  rO = smoothstep(RLO - soft, RHI + soft, wtX * wear6 * uOvDur); removed = ovRemoved(removed, rO); oa = ovAlpha(rO); ok = (1.0 - rO) * oa * uOvMatStrength;
  pm = mix(pm, uOvMetal, ok); pr = mix(pr, uOvRough, ok); pc = ovBlend(pc, oa);
  #endif
  #if STYLE == 2 && SEPARATE
  float lit = smoothstep(0.53 - soft, 0.72 + soft, val);
  #else
  float lit = smoothstep(0.0, 0.01, removed);
  #endif
  pc = clamp(pc * mix(uBright, 1.0, lit * (1.0 - b)), 0.0, 1.0);
  rough = mix(min(1.0, pr + (1.0 - g.w) * wA * wA * 0.5), metal.x, removed); met = mix(pm, metal.y, removed);
  vec3 c = pc * g.rgb;
  col = finish(c, pc, mix(uPaintLevels, uMetalPaintLevels, pmL), base, removed);
  paintMask = 1.0 - removed;
#elif STYLE == 3 || STYLE == 4 || STYLE == 5
  #if STYLE == 3
  vec4 pat = vec4(0.0, 0.0, 0.0, 1.0); float b = 0.0, dur = 1.0;
  #elif STYLE == 4
  vec4 pat = texture(tPattern, vPat); float b = band(pat.w);
  float dur = mix(mix(chain3(uDur, pat.xyz), uDur.z, m.y), uDur.w, m.z);
  #else
  vec4 pat = tri(uPat0, uPat1, vec2(0.0)); float b = band(pat.w);
  float dur = mix(mix(chain3(uDur, pat.xyz), uDur.z, m.y), uDur.w, m.z);
  #endif
  float soft = uWearSoft * dur;
  #if STYLE == 5
  removed = smoothstep(RLO - soft, RHI + soft, (ao.w + wt) * wear6 * dur);
  #else
  removed = smoothstep(RLO - soft, RHI + soft, ((ao.w + wt) * wear6 + b) * dur);
  #endif
  float bare = max(1.0 - m.x, removed);
  float exposed = smoothstep(0.0, 0.01, removed) * (1.0 - b) * m.x;
  #if STYLE == 4
  float t = 1.0 - min(1.0, pat.w * 2.0);
  float pr = mix(mix(t * t * 0.85 + 0.15, uPaintRough, float(pat.w >= 0.5)), uPaintRough, max(max(m.y, m.z), bare));
  #else
  float pr = uPaintRough;
  #endif
  rough = mix(metal.x, min(1.0, mix(pr, 0.35, exposed) + (1.0 - dot(g.rgb, LUM)) * 0.2), max(0.0, 1.0 - bare));
  met = mix(m.x, metal.y, bare);
  #if STYLE == 3
  vec3 paintC = C[0];
  #elif STYLE == 4
  vec3 paintC = mix(mix(chain3c(pat.xyz * m.x), C[2], m.y), C[3], m.z);
  #else
  vec3 paintC = mix(mix(chain3c(pat.xyz), C[2], m.y), C[3], m.z);
  #endif
  float br = mix(uBright, 1.0, exposed);
  vec3 pc = clamp(clamp(mix(mix(base, paintC, m.x), vec3(0.38, 0.37, 0.35), exposed) * br, 0.0, 1.0) * br, 0.0, 1.0);
  vec3 c = pc * mix(g.rgb, vec3(1.0), exposed);
  col = finish(c, pc, uMetalPaintLevels, base, bare);
  paintMask = 1.0 - bare;
#elif STYLE == 6
  vec4 pat = texture(tPattern, vPat);
  float dur = max(0.0, smoothstep(0.0, 0.5, pat.w)), soft = uWearSoft * dur;
  removed = smoothstep(RLO - soft, RHI + soft, ((ao.w + wt) * wear6 + band(pat.w)) * oDur * dur);
  float pm = paintMetal(uPaintMetal), pmL = pm, pr = paintRough(uPaintRough);
  vec3 pc = pat.rgb;
  #if OVERLAY
  rO = smoothstep(RLO - soft, RHI + soft, wt * wear6 * uOvDur); removed = ovRemoved(removed, rO); oa = ovAlpha(rO); ok = (1.0 - rO) * oa * uOvMatStrength;
  pm = mix(pm, uOvMetal, ok); pr = mix(pr, uOvRough, ok); pc = ovBlend(pc, oa);
  #endif
  rough = mix(min(1.0, pr + (1.0 - g.w) * wA * wA * 0.5), metal.x, removed); met = mix(pm, metal.y, removed);
  pc = clamp(pc * uBright, 0.0, 1.0);
  vec3 c = pc * g.rgb;
  col = finish(c, pc, mix(uPaintLevels, uMetalPaintLevels, pmL), base, removed);
  paintMask = 1.0 - removed;
#elif STYLE == 7 || STYLE == 8
  vec4 pat = texture(tPattern, vPat);
  float chA = 1.0; // Metall-Gewicht aus Rampe.a
  #if CH && STYLE == 7
  pat = ramp; chA = ramp.a; // Patina: Rampe ersetzt das Muster ganz (s1447)
  #elif CH
  pat = mix(pat, ramp, m.y); chA = mix(1.0, ramp.a, m.y); // Gunsmith: nur in Maske G (s1448)
  #endif
#if SEPARATE
  float edge = smoothstep(0.2, 0.6, (w * aoG) * (w * smoothstep(0.2, 0.3, cav)) * wA);
  float cavMask = 1.0 - smoothstep(0.5 * wA, 0.0, clamp(cavRaw * 11.52 * aoG - wA * clamp(graw.x * graw.y * graw.z, 0.0, 1.0) * 2.0, 0.0, 1.0)) * wA;
  g = max(g, vec4(clamp(edge * 2.0, 0.0, 1.0)));
#else
  float edge = smoothstep(0.1, 0.2, (w * aoG) * (cav * cav) * wA);
  float cavMask = smoothstep(0.0, 0.15, (clamp(cav * aoG - wA * 0.1, 0.0, 1.0) - clamp(graw.x * graw.y * graw.z, 0.0, 1.0) * 0.23) + 0.08);
#endif
  float lum = dot(g.rgb, LUM), gwear = (1.0 - g.w) * wA;
  float metalV = mix(chA * mix(1.0, pow(cavMask * g.w * lum, 0.5), wA), 1.0, edge);
  float pr = paintRough(uPaintRough);
  #if CH && STYLE == 7
  pr *= 1.0 - 0.25 * dot(pat.rgb, LUM);
  #elif CH
  pr = mix(pr, pr * (1.0 - 0.25 * dot(pat.rgb, LUM)), m.y);
  #endif
  vec3 pc = mix(pat.rgb, pat.rgb * uBright, max(m.x, float(uColorAdj)));
  vec3 tint = mix(mix(mix(uC1, uC3, sqrt(wA)), mix(uC1, uC2, wA), cavMask) * pc, uC0 * dot(pc, LUM), edge);
  #if STYLE == 7
  float r = clamp(pr * mix(1.0, 0.9, edge) + (1.0 - lum) * wA * 0.05 + (1.0 - cavMask) * 0.15 * wA + gwear * 0.15, 0.0, 1.0);
  rough = mix(metal.x, mix(min(1.0, r + gwear * wA * 0.5), r, m.x), step(ao.w, 0.996) * m.x);
  met = mix(metal.y, metalV, m.x);
  removed = 1.0 - m.x;
  vec3 c = tint * g.rgb;
  col = finish(c, pc * uC1, CH != 0 ? mix(uPaintLevels, uMetalPaintLevels, chA) : uMetalPaintLevels, base, removed);
  paintMask = 1.0 - ao.w;
  #else
  float mR = m.x, inv = 1.0 - mR, a = pat.w, dur = max(0.0, smoothstep(0.0, 0.5, a)), soft = uWearSoft * dur;
  float val = ((min(ao.w, inv) + wt) * wear6 + band(a)) * oDur * dur;
  bool isMetal = mR > 0.99;
  removed = mix(smoothstep(0.58 - soft, 0.68 + soft, val), val, float(isMetal));
  float pm = paintMetal(uPaintMetal);
    #if OVERLAY
  rO = smoothstep(RLO - soft, RHI + soft, wt * wear6 * uOvDur); removed = ovRemoved(removed, rO); oa = ovAlpha(rO); ok = (1.0 - rO) * oa * uOvMatStrength;
  pr = mix(pr, uOvRough, ok); pc = ovBlend(pc, oa);
    #endif
  float t = 1.0 - min(1.0, a * 2.0);
  float r = clamp(mix(pr, mix(t * t * 0.85 + 0.15, pr, float(a >= 0.5)), mR) * mix(1.0, 0.9, edge) + (1.0 - lum) * wA * 0.05 + (1.0 - cavMask) * 0.15 * wA + gwear * 0.15, 0.0, 1.0);
  rough = mix(metal.x, mix(min(1.0, r + gwear * wA * 0.5), r, mR), isMetal ? 1.0 : max(0.0, 1.0 - removed));
  met = mix(mix(pm, metal.y, removed), metalV, mR);
    #if OVERLAY
  met = mix(met, uOvMetal, ok);
    #endif
  vec3 c = mix(pc, tint, mR) * g.rgb;
  col = finish(c, mix(pc, pc * uC1, mR), mix(uPaintLevels, uMetalPaintLevels, mix(pm, chA, mR)), base, removed * inv);
  paintMask = (1.0 - removed) * (uPearlMetalOnly != 0 ? mR : 1.0);
  #endif
#endif
#if OVERLAY && STYLE != 3 && STYLE != 4 && STYLE != 5 && STYLE != 7
  paintMask = mix(paintMask, uOvPearl - removed, ok);
#endif
#if PEARL_MASK
  paintMask *= texture(tPearlMask, vUv).x;
#endif
#if ROUGH_PASS
  outColor = vec4(1.0, rough, met, clamp(paintMask, 0.0, 1.0));   // wie glTF/three: G Rauheit, B Metall; A Perl-/Effekt-Maske
#else
  outColor = vec4(col, 1.0);                     // linear; Ziel ist SRGB8_ALPHA8
#endif
}`

/**
 * Laufzeit-Effekte des Waffen-Materials (csgo_weapon, Werte final.* aus dem Kit), Maske = orm.a: pearl = g_flPearlescentScale,
 * irid = [Stärke, Skala, Farbton-Versatz], glitter = [Intensität, UV-Skala, Rainbow-Balance, Rainbow-Spread], ao = AO-Override (R, Mesh-UV)
 */
export interface SkinFinish { pearl: number; irid: [number, number, number] | null; glitter: [number, number, number, number] | null; ao: THREE.Texture | null }
/** fertiger Skin; dead = vom LRU freigegeben (Materialien damit verwerfen). legacy = Mesh body_legacy zeigen */
export interface SkinTex { map: THREE.Texture; orm?: THREE.Texture; normal?: THREE.Texture; finish?: SkinFinish; legacy: boolean; dead: boolean }
interface Owner { tex: SkinTex | null; own: { dispose(): void }[] }
/** size = gebaute Kantenlänge (0 = noch nicht), auch bei Fehlschlag gesetzt (kein zweiter Versuch in derselben Größe) */
interface Entry extends Owner { last: number; ego: number; size: number }

export class SkinCache {
  private readonly entries = new Map<number, Entry>()
  private readonly queue = new Set<number>()
  /** Kanal skin − 1 → Rezept (passt Modell nicht oder fehlt das Kit: undefined = Vanilla) */
  private readonly wk: (WeaponSkin | undefined)[]
  /** Handschuhe: p·2 + (CT ? 1 : 0) → Schlüssel −(i+1) in gl */
  private readonly gk = new Map<number, number>()
  private readonly gl: [GloveSkin | GloveSkin2, Paint3D][] = []
  private readonly gc: GloveCompositor
  private readonly quad = new THREE.Mesh(new THREE.BufferGeometry())
  private readonly scene = new THREE.Scene()
  private readonly cam = new THREE.Camera()
  private readonly white = solid(255)
  private readonly black = solid(0)
  private readonly flat = solid(128, 255) // Lack-Normal-Map-Vorgabe (0,5; 0,5; 1)
  /** Compositing-Programme je Feature-Kombination (Uniform-Werte je Skin) */
  private readonly progs = new Map<string, THREE.RawShaderMaterial>()
  private readonly shared: { wear?: string; grunge?: string }
  private busy = false
  private disposed = false

  /** onReady: ein Skin ist fertig (Engine zeichnet dann auch in der Pause neu). egoSize: Kantenlänge für die Ego-Sicht (High 2048, Low 1024) */
  constructor(private readonly renderer: THREE.WebGLRenderer, assets: Assets3D, private readonly skins: Skin3D[], players: Player3D[], private readonly onReady = () => {}, private readonly egoSize = SIZE) {
    const all = assets.skins ?? {}
    this.gc = new GloveCompositor(renderer)
    this.wk = skins.map(s => { const x = all[`${s.def}_${s.paint}`]; return x?.kind === 'weapon' ? x : undefined })
    // Kits vor Paket S (ohne Standard-Wear/Grunge im JSON): die gemeinsamen paint_wear/gun_grunge aus einem anderen Kit des Matches
    const sh = Object.values(all).find((x): x is WeaponSkin => x.kind === 'weapon' && !!x.paint.textures.wear && !!x.paint.textures.grunge)?.paint.textures
    this.shared = { wear: sh?.wear, grunge: sh?.grunge }
    const same = new Map<string, number>() // gleicher Handschuh (beide Seiten, mehrere Spieler) nur einmal zusammensetzen
    players.forEach((p, i) => (['T', 'CT'] as Side[]).forEach((side, c) => {
      const g = p.glove?.[side], x = g && all[`${g.def}_${g.paint}`]
      if (!g || (x?.kind !== 'glove' && x?.kind !== 'glove2') || !assets.gloves?.[g.def]) return
      const id = `${g.def}_${g.paint}_${g.seed}_${g.wear}`
      if (!same.has(id)) { this.gl.push([x, g]); same.set(id, -this.gl.length) }
      this.gk.set(i * 2 + c, same.get(id)!)
    }))
    // ein großes Dreieck über UV 0..1
    this.quad.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 2, 0], 3))
    this.quad.geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2))
    this.quad.frustumCulled = false; this.scene.add(this.quad)
  }

  /** Skin der Waffe in der Hand (Kanal skin, 0 = Vanilla); null = Vanilla oder noch nicht fertig. ego = Ego-Sicht (zuerst bauen) */
  weapon(si: number, def: number, ego = false): SkinTex | null {
    return si > 0 && this.wk[si - 1] && this.skins[si - 1].def === def ? this.get(si, ego) : null
  }
  /** Handschuh-Skin von Spieler-Index p auf side; null = Standard-Handschuh des Agenten */
  glove(p: number, side: Side, ego = false): SkinTex | null {
    const k = this.gk.get(p * 2 + (side === 'CT' ? 1 : 0))
    return k === undefined ? null : this.get(k, ego)
  }

  private get(key: number, ego: boolean): SkinTex | null {
    let e = this.entries.get(key)
    // Start erst nach dem Bild (Microtask): bis dahin sind alle Anfragen des Bildes samt Ego-Markierung in der Schlange
    if (!e) { this.entries.set(key, (e = { tex: null, last: 0, ego: 0, size: 0, own: [] })); this.queue.add(key); queueMicrotask(() => void this.pump()) }
    e.last = performance.now()
    if (ego) {
      e.ego = e.last
      // shortcut: einmal größer nachgebaut bleibt groß, bis der LRU ihn verdrängt (je Ego-Skin +33 MB VRAM); kleiner bauen erst bei Bedarf
      if (e.size && e.size < this.egoSize && !this.queue.has(key)) { this.queue.add(key); queueMicrotask(() => void this.pump()) }
    }
    return e.tex
  }
  /** nächster Bau: zuletzt von der Ego-Sicht angefragt, sonst zuletzt angefragt */
  private next(): number | undefined {
    let best: number | undefined, score = -Infinity
    for (const k of this.queue) { const e = this.entries.get(k)!, sc = e.last + (e.ego === e.last ? 1e9 : 0); if (sc > score) { score = sc; best = k } }
    if (best !== undefined) this.queue.delete(best)
    return best
  }
  private async pump() {
    if (this.busy) return
    this.busy = true
    try {
      for (let key = this.next(); key !== undefined && !this.disposed; key = this.next()) {
        const e = this.entries.get(key)!, b: Owner = { tex: null, own: [] }
        e.size = e.ego ? this.egoSize : SIZE
        try {
          const tex = key > 0 ? await this.buildWeapon(this.wk[key - 1]!, this.skins[key - 1], b, e.size) : await this.buildGlove(...this.gl[-key - 1], b, e.size)
          free(e); e.tex = tex; e.own = b.own // alter (kleinerer) Skin wird erst jetzt ersetzt
        } catch (err) { free(b); console.warn('skin', key, err) } // bisheriger Stand bleibt (Vanilla bzw. kleinerer Skin)
        if (this.disposed) { free(e); return }
        this.evict(); this.onReady()
      }
    } finally { this.busy = false }
  }
  /** über CAP: am längsten nicht gezeigten Skin freigeben, nur wenn 10 s ungenutzt (Arbeitssatz einer Runde: 19–30 Skins) */
  private evict() {
    let n = 0, old: [number, Entry] | null = null
    const cut = performance.now() - 10_000
    for (const kv of this.entries) if (kv[1].tex) { n++; if (kv[1].last < cut && (!old || kv[1].last < old[1].last)) old = kv }
    if (n <= CAP || !old) return
    free(old[1]); this.entries.delete(old[0])
  }

  private async load(e: Owner, url: string | undefined, srgb: boolean, wrap: THREE.Wrapping = THREE.ClampToEdgeWrapping): Promise<THREE.Texture | null> {
    if (!url) return null
    let t: THREE.Texture
    if (url.endsWith('.exr')) {
      t = await new EXRLoader().setDataType(THREE.HalfFloatType).loadAsync(url)
      // EXR liegt unten-nach-oben, composite_inputs oben-nach-unten (glTF-UV): Zeilen einmal tauschen (Spike: corr 0.997)
      const { data, width, height } = t.image as { data: Uint16Array; width: number; height: number }, row = data.length / height, tmp = data.slice(0, row)
      for (let y = 0; y < height >> 1; y++) { const a = y * row, b = (height - 1 - y) * row; tmp.set(data.subarray(a, a + row)); data.copyWithin(a, b, b + row); data.set(tmp, b) }
    } else {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`${url} (${r.status})`)
      // premultiplyAlpha none: RGB unter A = 0 sind Daten (AO-Datei: A = ohne Lack)
      t = new THREE.Texture(await createImageBitmap(await r.blob(), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
    }
    t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    t.wrapS = t.wrapT = wrap; t.anisotropy = 4; t.needsUpdate = true
    e.own.push(t)
    return t
  }
  /** Pass in ein neues Render-Target; Programm beim ersten Mal parallel übersetzen (kein Ruckler beim Abspielen) */
  private async pass(mat: THREE.RawShaderMaterial, srgb: boolean, e: Owner, size: number) {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, depthBuffer: false,
    })
    rt.texture.anisotropy = 8; rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping // Legacy-UVs reichen über 0..1 hinaus (AK −4..3.4)
    e.own.push(rt)
    this.quad.material = mat
    await this.renderer.compileAsync(this.scene, this.cam)
    if (this.disposed) throw new Error('disposed')
    const prev = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(rt); this.renderer.render(this.scene, this.cam); this.renderer.setRenderTarget(prev)
    return rt.texture
  }
  /** Eingaben nach dem Pass freigeben; nur Render-Targets, Lack-Normal-Map und AO-Override bleiben */
  private keep(e: Owner, keep: (THREE.Texture | null)[]) {
    e.own = e.own.filter(x => { const k = x instanceof THREE.WebGLRenderTarget || keep.includes(x as THREE.Texture); if (!k) disposeTex(x as THREE.Texture); return k })
  }
  /** Compositing-Material je Feature-Kombination einmal; Uniform-Werte setzt jeder Bau neu */
  private prog(defines: Record<string, number>, u: Record<string, unknown>) {
    const key = JSON.stringify(defines)
    let m = this.progs.get(key)
    if (!m) this.progs.set(key, (m = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, defines, uniforms: Object.fromEntries(Object.keys(u).map(k => [k, { value: null }])) })))
    for (const k in u) m.uniforms[k].value = u[k]
    return m
  }

  private async buildWeapon(ws: WeaponSkin, s: Skin3D, e: Owner, size: number): Promise<SkinTex> {
    const P = ws.paint, I = ws.inputs, T = P.tex ?? {}, R = THREE.RepeatWrapping, L = (u: string | undefined, srgb = false, w?: THREE.Wrapping) => this.load(e, u, srgb, w)
    const o = rollSeed(ws, s.seed)
    // Kit-Wert (gewürfelt, sonst roh aus vars), sonst Feld der alten Kit-Daten
    const vec = (k: string) => o.rolled[k] ?? P.vars?.[k], n = (k: string, fb: number) => vec(k)?.[0] ?? fb, on = (k: string, fb = 0) => n(k, fb) === 1
    const style = P.style
    const overlay = on('F_OVERLAY_TEXTURE') && !!T.g_tOverlay
    const halftone = style === 2 && on('F_SPRAYPAINT_HALFTONE', +P.halftone)
    const ch = on('F_CASE_HARDENING') && T.g_tCaseHardeningColorRamp ? (on('F_CASE_HARDENING_TRILINEAR') ? 2 : 1) : 0
    const metalTex = on('F_METALNESS_TEXTURE') && !!T.g_tPaintMetalness, pearlMask = on('F_PEARLESCENCE_MASK') && !!T.g_tPearlescenceMask
    const roughUrl = on('F_ROUGHNESS_TEXTURE', +P.roughnessTexture) ? P.textures.paintRough ?? T.g_tPaintRoughness : undefined
    const tri = style === 2 || style === 5 || ch === 2
    const posUrl = ch === 2 && on('b_OverridePositionMap') && T.g_tPositionOverride ? T.g_tPositionOverride : I.pos
    const samplingU = n('g_nPatternTextureHorizontalSampling', P.samplingU), samplingV = n('g_nPatternTextureVerticalSampling', P.samplingV)
    const aoUrl = T['final.g_tAmbientOcclusion']
    // eigene Masken an, aber keine exportiert = Platzhalter default_black_mask (4 Kits, z. B. 412): schwarz statt composite_inputs
    const blackMasks = on('g_bOverrideDefaultMasks') && !P.textures.masks
    const [ao, masks, surface, pos, color, rough, metal, pattern, wear, grunge, paintRough, normal, ovl, ovlMask, chNormal, ramp, paintMetal, pearl, aoFinal] = await Promise.all([
      L(I.ao, true), blackMasks ? null : L(P.textures.masks ?? I.masks), L(I.surface), tri ? L(posUrl) : null, L(I.color, true), L(I.rough), L(I.metal),
      // Custom-Paint/Patina/Gunsmith-Muster ist sRGB-Bildinhalt
      L(P.textures.pattern, style >= 6, WRAP[samplingU] ?? R), L(P.textures.wear ?? T.g_tWear ?? this.shared.wear, false, R), L(P.textures.grunge ?? T.g_tGrunge ?? this.shared.grunge, true, R),
      roughUrl ? L(roughUrl, false, R) : null, L(P.textures.normal, false, R),
      overlay ? L(T.g_tOverlay, true, R) : null, overlay && n('F_OVERLAY_MASK', 0) === 8 ? L(T.g_tOverlayMask, true, R) : null,
      ch ? L(T.g_tNormal ?? P.textures.normal, false, R) : null, ch ? L(T.g_tCaseHardeningColorRamp, true) : null,
      metalTex ? L(T.g_tPaintMetalness, false, R) : null, pearlMask ? L(T.g_tPearlescenceMask, false, R) : null, aoUrl ? L(aoUrl) : null,
    ])
    if (!ao || !color || !wear || !grunge) throw new Error('skin inputs missing')
    if (pattern) pattern.wrapT = WRAP[samplingV] ?? R
    const sizeScale = on('g_bIgnoreWeaponSizeScale', +P.ignoreWeaponSizeScale) ? 1 : I.separate ? I.uvScale : I.weaponLength / 36
    const patScale = n('g_flPatternTexCoordScale', P.patternScale), [po0, po1] = o.patternOffset
    const [pat0, pat1] = texXform(o.patternRotation, patScale, sizeScale, po0, po1)
    const [w0, w1] = texXform(o.wearRotation, o.wearScale, sizeScale, o.wearOffset[0], o.wearOffset[1])
    const [g0, g1] = texXform(o.grungeRotation, o.grungeScale, sizeScale, o.grungeOffset[0], o.grungeOffset[1])
    const ht = (k: string, d: number) => texXform(o.patternRotation + n(k, d), patScale, sizeScale, po0, po1)
    const [htA0, htA1] = ht('g_flHalftoneRotationOffsetA', 0), [htB0, htB1] = ht('g_flHalftoneRotationOffsetB', 4), [htC0, htC1] = ht('g_flHalftoneRotationOffsetC', -4)
    const ovOff = vec('g_vOverlayTexCoordOffset') ?? [0, 0]
    const [ov0, ov1] = on('g_bOverlayUsesUniqueUVs') ? texXform(n('g_flOverlayTexCoordRotation', 0), n('g_flOverlayTexCoordScale', 1), sizeScale, ovOff[0], ovOff[1] ?? 0)
      : on('g_bOverlayUsesPatternUVs') ? [pat0, pat1] : [ID0, ID1]
    const v3 = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]), v4 = (a: number[]) => new THREE.Vector4(a[0], a[1], a[2], a[3])
    const color3 = (i: number) => { const c = vec(`g_vColor${i}`); return c ? v3(c.map(srgbToLin)) : v3(P.colors[i]) }
    const d = vec('g_vPaintDurability'), hl = vec('g_vHalftonePatternLevels') ?? [0, 0.5, 1], sb = vec('g_vSprayBlend')
    const W = this.white, u = {
      tAO: ao, tMasks: masks ?? (blackMasks ? this.black : W), tWear: wear, tGrunge: grunge, tPattern: pattern ?? W, tColor: color, tRough: rough ?? W, tMetal: metal ?? this.black,
      tSurface: surface ?? W, tPos: pos ?? W, tPaintRough: paintRough ?? W, tOverlay: ovl ?? W, tOverlayMask: ovlMask ?? W, tNormal: chNormal ?? this.flat,
      tRamp: ramp ?? W, tPaintMetal: paintMetal ?? this.black, tPearlMask: pearl ?? W,
      uC0: color3(0), uC1: color3(1), uC2: color3(2), uC3: color3(3),
      uPaintLevels: PAINT_LEVELS, uMetalPaintLevels: METALLIC_PAINT_LEVELS, uAlbedoLevels: ALBEDO_LEVELS,
      uSprayBiasBlend: new THREE.Vector3(n('g_bBiasSpray', P.sprayBiasBlend[0]), sb?.[0] ?? P.sprayBiasBlend[1], sb?.[1] ?? P.sprayBiasBlend[2]),
      uHtLevels: lv(hl[0], hl[1], hl[2]),
      uDur: d ? v4([0, 1, 2, 3].map(i => 1 - (d[i] ?? 0))) : v4(P.durability), // Expression(1-this)
      uPR4: v4(vec('g_vPaintRoughness') ?? P.paintRoughness4), uPM4: v4(vec('g_vPaintMetalness') ?? P.paintMetalness4),
      uPat0: pat0, uPat1: pat1, uWear0: w0, uWear1: w1, uGr0: g0, uGr1: g1, uOv0: ov0, uOv1: ov1,
      uHtA0: htA0, uHtA1: htA1, uHtB0: htB0, uHtB1: htB1, uHtC0: htC0, uHtC1: htC1, uCH: v4(vec('g_vCaseHardening') ?? [0, 1, 0, 0]),
      uHtThr: new THREE.Vector2(...(vec('g_vHalftoneThresholds') ?? [0, 1]) as [number, number]),
      uWearSoft: n('g_fWearSoftness', P.wearSoftness), uWearAmount: s.wear, uBright: n('g_flColorBrightness', P.colorBrightness),
      uPaintRough: n('g_flPaintRoughness', P.paintRoughness), uPaintMetal: n('g_flPaintMetalness', P.paintMetalness),
      uHtCut: n('g_fHalftoneCavityCutoff', 1), uChPI: n('g_flCaseHardeningPatternInfluence', 0.5), uChGI: n('g_flCaseHardeningGeometricInfluence', 1), uChOff: n('g_flCaseHardeningRampOffset', 0),
      uOvStrength: n('g_fOverlayStrength', 1), uOvBright: n('g_fOverlayBrightness', 1), uOvDur: 1 - n('g_fOverlayDurability', 0), // Expression(1-this)
      uOvMatStrength: n('g_fOverlayMaterialStrength', 1), uOvMetal: n('g_fOverlayMetalness', 0), uOvRough: n('g_fOverlayRoughness', 0), uOvPearl: n('g_fOverlayPearlescentMask', 0),
      uColorAdj: n('g_nColorAdjustmentMode', P.colorAdjustmentMode), uRoughPerColor: n('F_ROUGHNESS_PER_COLOR', +P.roughnessPerColor),
      uPearlMetalOnly: n('g_bPearlescentOnMetallicOnly', +P.pearlescentOnMetallicOnly), uRoughTex: +!!paintRough,
      uRoughPatUV: n('g_bRoughnessUsesPatternUVs', +P.roughnessUsesPatternUVs), uMetalPatUV: n('g_bMetalnessUsesPatternUVs', 0),
      uOvMask: n('F_OVERLAY_MASK', 0), uOvBlend: n('F_OVERLAY_BLEND_MODE', 0), uHtInCav: n('g_bHalftoneInCavity', 0),
    }
    const defs = { STYLE: style, SEPARATE: I.separate ? 1 : 0, ALL_MASKS: +(style === 2 && on('F_USE_ALL_MASKS', +P.useAllMasks)), OVERLAY: +overlay, HALFTONE: +halftone, CH: ch, METAL_TEX: +metalTex, PEARL_MASK: +pearlMask }
    const map = await this.pass(this.prog({ ...defs, ROUGH_PASS: 0 }, u), true, e, size), orm = await this.pass(this.prog({ ...defs, ROUGH_PASS: 1 }, u), false, e, size)
    this.keep(e, [normal, aoFinal])
    // Laufzeit-Effekte (final.* = Kopie ins csgo_weapon-Material; alte Kits: Feld pearlescent)
    const irid = n('final.g_flIridescentStrength', 0), glit = n('final.g_fGlitterIntensity', 0)
    const fin: SkinFinish = {
      pearl: n('final.g_flPearlescentScale', P.pearlescent),
      irid: irid > 0 ? [irid, n('final.g_flIridescentScale', 2), n('final.g_flIridescentHueShift', 0.5)] : null,
      glitter: glit > 0 ? [glit, 1.75 * n('final.g_fGlitterScale', 25) * I.uvScale, n('final.g_fGlitterRainbowBalance', 0.25), n('final.g_fGlitterRainbowSpread', 1)] : null,
      ao: aoFinal,
    }
    return { map, orm, normal: normal ?? undefined, finish: fin.pearl || fin.irid || fin.glitter || fin.ao ? fin : undefined, legacy: ws.legacy, dead: false }
  }

  /** Handschuh alt + neu (engine/gloves.ts); Render-Targets gehören dem Eintrag (free) */
  private async buildGlove(g: GloveSkin | GloveSkin2, p: Paint3D, e: Owner, size: number): Promise<SkinTex> {
    const t = await this.gc.build(g, p, size)
    e.own.push(...t.targets)
    return { map: t.map, orm: t.orm, normal: t.normal, legacy: false, dead: false }
  }

  dispose() {
    this.disposed = true
    for (const e of this.entries.values()) free(e)
    this.entries.clear(); this.queue.clear()
    for (const m of this.progs.values()) m.dispose()
    this.progs.clear()
    this.gc.dispose()
    this.quad.geometry.dispose(); this.white.dispose(); this.black.dispose(); this.flat.dispose()
  }
}

// ---------------------------------------------------------------- Laufzeit-Effekte im Waffen-Material (Patch auf MeshStandardMaterial)

const FIN_PARS = /* glsl */ `
uniform float csdaPearl; uniform vec3 csdaIrid; uniform vec4 csdaGlitter;
float csdaLum(vec3 c) { return dot(c, vec3(0.2125, 0.7154, 0.0721)); }
float csdaHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`
// vor lights_physical_fragment: Perlglanz dreht die Albedo um die Grau-Achse, Winkel ~ Blickwinkel · Maske (orm.a)
const FIN_PEARL = /* glsl */ `
#if defined( USE_METALNESSMAP )
float csdaMask = texelMetalness.a; vec2 csdaUv = vMetalnessMapUv;
#elif defined( USE_MAP )
float csdaMask = 1.0; vec2 csdaUv = vMapUv;
#else
float csdaMask = 1.0; vec2 csdaUv = vec2( 0.0 );
#endif
vec3 csdaV = normalize( vViewPosition );
#ifdef CSDA_PEARL
{
  float th = csdaPearl * ( 1.0 - dot( csdaV, normal ) ) * csdaMask, ct = cos( th );
  vec3 c = diffuseColor.rgb, k = vec3( 0.57735 );
  float mx = max( c.r, max( c.g, c.b ) ), sat = mx > 0.0 ? ( mx - min( c.r, min( c.g, c.b ) ) ) / mx : 0.0;
  diffuseColor.rgb = mix( vec3( csdaLum( c ) ), c * ct + cross( k, c ) * sin( th ) + k * dot( k, c ) * ( 1.0 - ct ), pow( sat, 0.125 ) );
}
#endif
`
// nach lights_physical_fragment: Iridescence färbt F0 (Regenbogen nach Blick-/Lichtwinkel), Glitter funkelt als Emission
const FIN_SPEC = /* glsl */ `
#ifdef CSDA_IRID
{
  #if NUM_DIR_LIGHTS > 0
  vec3 csdaL = directionalLights[ 0 ].direction;
  #else
  vec3 csdaL = vec3( 0.0, 1.0, 0.0 );
  #endif
  float h = fract( ( dot( csdaV, nonPerturbedNormal ) + dot( csdaV, csdaL ) ) * csdaIrid.y + csdaIrid.z ) * 6.0, s = floor( h ), f = h - s;
  vec3 rgb = s == 0.0 ? vec3( 1.0, f, 0.0 ) : s == 1.0 ? vec3( 1.0 - f, 1.0, 0.0 ) : s == 2.0 ? vec3( 0.0, 1.0, f ) : s == 3.0 ? vec3( 0.0, 1.0 - f, 1.0 ) : s == 4.0 ? vec3( f, 0.0, 1.0 ) : vec3( 1.0, 0.0, 1.0 - f );
  vec3 f0 = material.specularColorBlended, nh = normalize( max( rgb, vec3( 0.001 ) ) );
  float l = csdaLum( f0 );
  material.specularColorBlended = clamp( mix( f0, nh * min( l / csdaLum( nh ), 3.0 * l * max( rgb.r, max( rgb.g, rgb.b ) ) ), csdaIrid.x * csdaMask ), 0.0, 1.0 );
}
#endif
#ifdef CSDA_GLITTER
{ // shortcut: g_tGlitterNormal (squares_glitter) ist ein Platzhalter des Materialsystems und fehlt im Export → Zufallsnormale je Zelle (64 je UV-Wiederholung)
  float gi = csdaMask * min( 1.0, csdaGlitter.x );
  vec2 cell = floor( csdaUv * csdaGlitter.y * 64.0 );
  vec2 rn = vec2( csdaHash( cell ), csdaHash( cell + 17.0 ) ) * 2.0 - 1.0;
  vec3 gn = normalize( normal + vec3( rn * 0.6, 0.0 ) );
  float spread = csdaGlitter.w, thr = mix( 0.99, 0.8, spread );
  vec3 sp = sin( reflect( - csdaV, gn ) * mix( 12.0, 5.6, spread ) );
  vec3 sparkle = max( vec3( 0.0 ), sp - thr ) / ( 1.0 - thr ) * 4.0 * max( 0.0, 1.0 - csdaGlitter.z ) + pow( csdaLum( clamp( - sp, 0.0, 1.0 ) ), 4.0 ) * max( 0.0, csdaGlitter.z );
  totalEmissiveRadiance += ( sparkle * 0.05 + sparkle * normalize( max( diffuseColor.rgb, vec3( 3e-4 ) ) ) * 1.06 * 0.95 ) * max( 0.0, dot( csdaV, normal ) ) * csdaGlitter.x * gi;
}
#endif
`
/**
 * Laufzeit-Effekte eines Skins auf ein Waffen-Material legen (nach dem Agenten-Patch aufrufen, einmal je Material): AO-Override als aoMap,
 * Perlglanz/Iridescence/Glitter als Shader-Patch. Programm-Schlüssel = vorheriger Schlüssel + Effekt-Art → kein neues Programm je Skin.
 */
export function applyFinish(mat: THREE.Material, f: SkinFinish | undefined) {
  if (!f) return
  const m = mat as THREE.MeshStandardMaterial
  if (f.ao) { m.aoMap = f.ao; m.aoMapIntensity = 1 }
  const kind = (f.pearl ? 'p' : '') + (f.irid ? 'i' : '') + (f.glitter ? 'g' : '')
  if (kind) {
    const key = mat.customProgramCacheKey.bind(mat), before = mat.onBeforeCompile.bind(mat)
    const u = { csdaPearl: { value: f.pearl }, csdaIrid: { value: new THREE.Vector3(...(f.irid ?? [0, 0, 0] as const)) }, csdaGlitter: { value: new THREE.Vector4(...(f.glitter ?? [0, 0, 0, 0] as const)) } }
    mat.customProgramCacheKey = () => `${key()}-fin-${kind}`
    mat.onBeforeCompile = (sh, r) => {
      before(sh, r)
      sh.defines = { ...sh.defines, ...(f.pearl ? { CSDA_PEARL: '' } : {}), ...(f.irid ? { CSDA_IRID: '' } : {}), ...(f.glitter ? { CSDA_GLITTER: '' } : {}) }
      Object.assign(sh.uniforms, u)
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${FIN_PARS}`)
        .replace('#include <lights_physical_fragment>', `${FIN_PEARL}\n#include <lights_physical_fragment>\n${FIN_SPEC}`)
    }
  }
  mat.needsUpdate = true
}

const solid = (v: number, b = v) => { const t = new THREE.DataTexture(new Uint8Array([v, v, b, 255]), 1, 1); t.needsUpdate = true; return t }
function disposeTex(t: THREE.Texture) {
  t.dispose()
  if (typeof ImageBitmap !== 'undefined' && t.image instanceof ImageBitmap) t.image.close()
}
function free(e: Owner) {
  if (e.tex) e.tex.dead = true
  for (const x of e.own) x instanceof THREE.WebGLRenderTarget ? x.dispose() : disposeTex(x as THREE.Texture)
  e.own = []; e.tex = null
}
