// Handschuh-Skins (Port csgo_customglove.vfx, statisch aus der Shader-VPK dekompiliert, Formeln neu geschrieben; Belege G/shader/*.glsl).
// CS2 rendert je Handschuh 5 Ausgaben (F_OUTPUT_MODE 0 Farbe, 1 Normale+Rauheit, 2 Metall/Stoff, 3 AO, 4 Aniso-Rauheit) im UV-Raum; hier
// drei: map (sRGB), orm (R AO, G Rauheit, B Metall wie glTF), normal (Tangentenraum, wie die Normal-Map des Modells).
// Alt (GloveSkin): 4 Material-Layer über g_tLayerMask (Kette mix(mix(mix(1,2,r),3,g),4,b)), Detail/Grunge je Layer, 8 Tints über Tint-ID
// (Masken-Alpha · 8, 3×3-Blur), Muster ersetzt eine Tint-ID durch die Palette, Wear = Kavität·Krümmung·Grunge gegen g_vDamageLevels.
// Neu (GloveSkin2, glove_compositor): 4 Layer über g_tLayerId (normiert), je Layer Surface über Substrate, Damage-Höhe legt Substrate frei,
// Tint-ID-Farben (g_tTintId) färben über Luminanz-Erhalt, Muster als Tint-Ersatz oder Lack-Schicht (Puffy = Prägung), Grime/Burnishing.
// Kein Programm je Kit: drei feste Programme (Mischpass, Alt, Neu), alles andere sind Uniforms. Layer-Texturen werden je Layer-UV in
// Zwischenbilder gemischt (WebGL hat 16 Textur-Einheiten, der Shader braucht 21 bzw. 38) — die vfx summiert dieselben gewichteten Proben.
import * as THREE from 'three'
import { colorAdjust } from '../../../shared/coloradjust'
import type { GloveSkin, GloveSkin2, RollVar } from '../../../shared/assets3d'
import type { Paint3D } from '../../../shared/cs3d'
import { texXform, UniformRandomStream } from './skins'

/** fertiger Handschuh; targets gehören dem Aufrufer (dispose). orm.a = Stoff-Maske, sheen = g_flSheenScale der vmat (CS2 nutzt beides im Handschuh-Material für Stoff-Glanz) */
export interface GloveTex { map: THREE.Texture; orm: THREE.Texture; normal: THREE.Texture; sheen: number; targets: THREE.WebGLRenderTarget[] }

const VS = /* glsl */ `in vec3 position; in vec2 uv; out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); }`

// Mischpass: Σ w_i · (Textur_i(uv·Zeile_i) · mul_i + add_i); w aus Layer-Maske (0 = Kette alt, 1 = LayerId neu). out: 0 = A, 1 = (A.xy, B.xy), 2 = (B.rgb, A.x)
const BLEND = /* glsl */ `precision highp float;
uniform sampler2D tW, tA0, tA1, tA2, tA3, tB0, tB1, tB2, tB3;
uniform int uWMode, uOut;
uniform vec4 uA0[4], uA1[4], uB0[4], uB1[4], uMul[4], uAdd[4];
in vec2 vUv; out vec4 o;
vec2 X(vec4 r0, vec4 r1) { return vec2(dot(vUv, r0.xy) + r0.w, dot(vUv, r1.xy) + r1.w); }
void main() {
  vec4 l = texture(tW, vUv), w;
  if (uWMode == 0) w = vec4((1.0 - l.x) * (1.0 - l.y) * (1.0 - l.z), l.x * (1.0 - l.y) * (1.0 - l.z), l.y * (1.0 - l.z), l.z);
  else { float s = l.x + l.y + l.z, r = max(0.0, 1.0 - s); w = vec4(l.xyz, r) / max(s + r, 1e-5); }
  vec4 a = w.x * (texture(tA0, X(uA0[0], uA1[0])) * uMul[0] + uAdd[0]) + w.y * (texture(tA1, X(uA0[1], uA1[1])) * uMul[1] + uAdd[1])
         + w.z * (texture(tA2, X(uA0[2], uA1[2])) * uMul[2] + uAdd[2]) + w.w * (texture(tA3, X(uA0[3], uA1[3])) * uMul[3] + uAdd[3]);
  if (uOut == 0) { o = a; return; }
  vec4 b = w.x * texture(tB0, X(uB0[0], uB1[0])) + w.y * texture(tB1, X(uB0[1], uB1[1])) + w.z * texture(tB2, X(uB0[2], uB1[2])) + w.w * texture(tB3, X(uB0[3], uB1[3]));
  o = uOut == 1 ? vec4(a.xy, b.xy) : vec4(b.rgb, a.x);
}`

const COMMON = /* glsl */ `precision highp float;
const vec3 LUM = vec3(0.2125, 0.7154, 0.0721);
uniform int uMode; // 0 Farbe, 1 Normale, 2 ORM
in vec2 vUv; out vec4 outColor;
vec3 octN(vec2 e) { float x = e.x + e.y - 1.00392, y = e.x - e.y; return normalize(vec3(x, y, 1.0 - abs(x) - abs(y))); }
vec3 lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
// Sättigung/Farbton verschieben bei gleicher Luminanz lumT (s < 0: entsättigen)
vec3 hueShift(vec3 c, float lumT, vec3 ref, float s) {
  if (s <= 0.0) return mix(c, vec3(lumT), -s);
  vec3 d = normalize(ref * dot(ref, LUM) + 1e-6) - 0.577, h = clamp(normalize(d + 1e-6) * 2.0 + 1.0, 0.0, 1.0);
  return mix(c, h * (lumT / max(dot(h, LUM), 1e-4)), clamp(s * pow(abs(dot(d, vec3(0.577))), 0.2), 0.0, 1.0));
}
void emit(vec3 col, vec3 n, float ao, float rough, float metal, float cloth) {
  if (uMode == 0) outColor = vec4(col, 1.0);                                   // linear → SRGB8_ALPHA8
  else if (uMode == 1) outColor = vec4(normalize(n) * 0.5 + 0.5, 1.0);
  else outColor = vec4(ao, rough, metal, cloth);                               // cloth = Stoff-Maske der vfx (Ausgabe 2 .z) für Sheen
}
`

const OLD = COMMON + /* glsl */ `
uniform sampler2D tMask, tSurf, tNormal, tNoise, tPattern, tDetail, tDN, tGrunge;
uniform vec4 uDetMet, uDmgLo, uDmgHi, uDmgSat, uEdgeW, uDetGr, uGrimeSat, uCurvPow, uDRC, uDRB, uCWB, uWB, uDB, uGrimeBr, uDmgBr, uGrMax, uDmgMet, uEdgeMet,
  uDetCloth, uDmgCloth, uGrRB, uDmgRC, uDmgRB, uEdgeR, uDNC, uPat0, uPat1, uPatR0, uPatR1, uGrR0, uGrR1;
uniform mat2 uGrToUv;
uniform vec3 uTint[8];
uniform ivec4 uPal;
uniform float uWear, uFlip, uBlur, uPatDetail, uThick, uDur, uShadowPow, uPatMet, uPatRB, uBP1, uComp1;
uniform int uPattern, uPatMode, uReplace;
const vec3 K[9] = vec3[](vec3(0., 0., .3197279), vec3(-1., -1., .0510204), vec3(-1., 0., .1190476), vec3(-1., 1., .0510204), vec3(0., -1., .1190476),
  vec3(0., 1., .1190476), vec3(1., -1., .0510204), vec3(1., 0., .1190476), vec3(1., 1., .0510204));
const vec2 Q[4] = vec2[](vec2(-1.0), vec2(-1.0, 1.0), vec2(1.0), vec2(1.0, -1.0));
vec3 M;
float L(vec4 p) { return mix(mix(mix(p.x, p.y, M.x), p.z, M.y), p.w, M.z); }
void main() {
  vec2 uv = vUv;
  M = texture(tMask, uv).xyz;
  vec4 surf = texture(tSurf, uv);                                   // x Krümmung, y AO, z Bleich-Maske, w Kavität
  float curv = pow(surf.x, L(uCurvPow));
  vec4 det = texture(tDetail, uv);                                  // Mischpass: xy je Layer Schwarzpunkt-korrigiert
  vec2 d2 = uBP1 + det.xy * uComp1;                                 // vfx korrigiert die Mischung nochmal mit Layer 1
  float dZ = det.z, r1 = 1.0 - det.w;
  vec2 pUv = vec2(uv.x * uFlip, uv.y);
  vec2 patUv = vec2(dot(pUv, uPat0.xy) + uPat0.w, dot(pUv, uPat1.xy) + uPat1.w) + vec2((d2.y * 2.0 - 1.0) / 1024.0 * uPatDetail);
  float detRough = clamp((L(uDRC) * (r1 * r1 * 0.85 - 0.35) + 0.5) * L(uDRB), 0.0, 1.0);
  vec4 gr = texture(tGrunge, uv);
  float grL = dot(gr.rgb, LUM);
  vec4 noise = texture(tNoise, uv * 2.0);
  vec3 nObj = octN(texture(tNormal, uv).xy);
  vec4 dn = texture(tDN, uv);
  vec3 nDet = octN(dn.xy), nDmg = octN(dn.zw);
  // Tint-IDs: Masken-Alpha · 8 im 3×3-Fenster (Punktproben)
  float tw[8] = float[](0., 0., 0., 0., 0., 0., 0., 0.);
  vec2 ms = vec2(textureSize(tMask, 0));
  for (int k = 0; k < 9; k++) {
    vec2 p = uv + K[k].xy / 1024.0 * uBlur;
    int id = int(floor(texelFetch(tMask, clamp(ivec2(p * ms), ivec2(0), ivec2(ms) - 1), 0).w * 8.0));
    for (int i = 0; i < 8; i++) if (i == id) tw[i] += K[k].z;
  }
  float metal0 = L(uDetMet), cav = surf.w, patSel = 1.0, patThick = 1.0, patShadow = 1.0, dY = d2.y, rough0 = detRough;
  vec3 nD = nDet, patCol = vec3(0.0);
  if (uPattern != 0) {
    patSel = (uPatMode == 1 || uPatMode == 3) ? 1.0 : tw[uReplace];
    vec4 p = texture(tPattern, patUv);
    if (uPatMode < 2) {
      float sum = p.x + p.y + p.z;
      if (uThick > 0.0) {
        vec4 pb = texture(tPattern, patUv, 0.5 + 0.1 * uThick);
        patShadow = pow(mix(1.0, mix(pow(1.0 - pb.x, uShadowPow), 1.0, p.x) * mix(pow(1.0 - pb.y, uShadowPow), 1.0, p.y) * mix(pow(1.0 - pb.z, uShadowPow), 1.0, p.z), patSel), 0.2);
      }
      float paint = clamp(sum, 0.0, 1.0) * patSel * clamp(uThick - dZ * pow(uWear, 4.0), 0.0, 1.0), paintT = paint * min(1.0, uThick);
      cav -= paintT * uDur;
      dY = mix(d2.y, 0.5, paint);
      nD = mix(nDet, vec3(0.0, 0.0, 1.0), paintT);
      patThick = sum * uThick;
      patCol = mix(mix(mix(uTint[uPal.x - 1], uTint[uPal.y - 1], p.x), uTint[uPal.z - 1], p.y), uTint[uPal.w - 1], p.z);
      rough0 = detRough * mix(1.0, uPatRB, paintT);
    } else patCol = p.xyz;
    metal0 = mix(metal0, uPatMet, patSel);
  }
  vec3 tintSum = vec3(0.0);
  for (int i = 0; i < 8; i++) tintSum += uTint[i] * tw[i];
  vec3 base = lin(tintSum);
  // Wear: Kavität · Krümmung · Grunge.a gegen die Damage-Level
  float cw = curv * cav, boost = L(uCWB) * curv;
  float dmgIn = clamp(cw * gr.w + boost, 0.0, 1.0), lo = L(uDmgLo), hi = L(uDmgHi);
  float dmg = smoothstep(lo, hi, dmgIn * uWear), keep = 1.0 - dmg;
  float dmgAll = clamp(dmg + clamp(smoothstep(lo, hi, dmgIn * uWear * 4.0), 0.0, 1.0) * keep * dZ, 0.0, 1.0);
  vec3 col = uPattern != 0 ? mix(base, mix(lin(patCol), base, dmgAll), patSel) : base;
  float colL = dot(col, LUM);
  // Kanten-Glanz aus Detail-Höhe (Bildschirm-Ableitungen wie die vfx)
  float hA = dY * curv, hB = d2.x * curv, hS = surf.x + surf.y + surf.z;
  float edge = mix((1.0 - abs(dFdx(hA))) * (1.0 - abs(dFdy(hA))) * clamp(abs(dFdx(hA)) + abs(dFdy(hA)), 0.0, 1.0),
                   (1.0 - abs(dFdx(hB))) * (1.0 - abs(dFdy(hB))) * clamp(abs(dFdx(hB)) + abs(dFdy(hB)), 0.0, 1.0), dmg)
               * (1.0 - clamp(abs(dFdx(hS)), 0.0, 1.0)) * (1.0 - clamp(abs(dFdy(hS)), 0.0, 1.0));
  vec3 lifted = max(col, col * (1.0 + curv * 0.5));
  float detH = min(1.0, mix(dY, d2.x, dmgAll) + edge), detHL = detH;
  vec3 ln = normalize(max(lifted, vec3(0.001)));
  vec3 detCol = clamp(ln * min(detHL / dot(ln, LUM), 3.0 * detHL * max(lifted.x, max(lifted.y, lifted.z))), 0.0, 1.0);
  float bleach = mix(uWear * surf.z * L(uWB) * mix(dZ, 0.0, clamp(patThick - 1.0, 0.0, 1.0)), L(uDB), dmg);
  float dg = L(uDetGr);
  vec3 grime = hueShift(gr.rgb, grL, gr.rgb, L(uGrimeSat));
  vec3 grDet = detCol * gr.rgb * 2.0;
  vec3 c1 = mix(mix(detCol, grDet, dg * (1.0 + uWear * dg) * keep), grime * (1.0 + L(uGrimeBr)) * detH, bleach);
  vec3 c2 = mix(c1, hueShift(c1, dot(c1, LUM), col, L(uDmgSat)) * (1.0 + L(uDmgBr)), dmg);
  vec3 c3 = mix(c2, gr.rgb * c2, smoothstep(0.45, 0.75, (1.0 - surf.x * surf.y * surf.y) * uWear) * (1.0 - colL * 0.5) * L(uGrMax));
  // Farbrauschen (Faser-Variation)
  float lumH = dot(c3, LUM) * 0.5;
  vec3 hA3 = vec3(0.6, 1.0, 0.0), hB3 = vec3(0.2, 0.6, 1.0);
  if (c3.x > c3.y && c3.x > c3.z) { hA3 += c3.zxy; hB3 += c3.zyx; }
  else if (c3.y > c3.x && c3.y > c3.z) { hA3 += c3.zxy; hB3 += c3.yzx; }
  float ns = pow(1.0 - colL, 3.5) * 0.3 + length(c3 - vec3(lumH)) * 0.15 + 0.05, ao8 = pow(surf.y, 8.0);
  vec3 cn = clamp(mix(mix(hueShift(c3, lumH, hB3, ns), hueShift(c3, lumH, hA3, ns), clamp(ao8 * noise.x, 0.0, 1.0)), c3, clamp(noise.z * (0.5 + ao8 * 0.5), 0.0, 1.0)), 0.0, 1.0);
  // Damage-Kanten im Grunge (4 Proben)
  vec2 g = vec2(0.0); float ga = 0.0, ew = L(uEdgeW);
  for (int i = 0; i < 4; i++) {
    float gw = texture(tGrunge, uv + uGrToUv * (Q[i] / 1024.0 * ew * (1.0 + patThick))).w;
    float dd = dmg - smoothstep(lo, hi, clamp(gw * cw + boost, 0.0, 1.0) * uWear);
    g -= Q[i] * dd; ga += abs(dd);
  }
  float edgeAmt = ga * 0.25;
  vec2 gEdge = g * (ew * 0.25);
  // Lack-Kante des Musters als Normalen-Versatz (4 Proben, um die Muster-Drehung zurückgedreht)
  vec2 pe = vec2(0.0);
  if (uPatMode < 2) {
    float st = uThick * (1.0 - edgeAmt) / 1024.0;
    vec2 acc = vec2(0.0);
    for (int i = 0; i < 4; i++) {
      vec4 q = texture(tPattern, patUv + Q[i] * st * 2.0);
      acc -= Q[i] * (patThick - (q.x + q.y + q.z) * uThick) * (clamp(keep, 0.0, 1.0) * patSel) * (1.0 - min(min(q.x, q.z - min(q.x, q.y)), q.y - q.x)) * 0.5;
    }
    pe = vec2(-dot(acc, uPatR0.xy) * uFlip, dot(acc, uPatR1.xy));
  }
  vec3 nMix = mix(nD, nDmg, dmg);
  vec2 nd = nMix.xy * L(uDNC);
  vec3 n = normalize(vec3(nObj.xy + nd - vec2(-dot(gEdge, uGrR0.xy), dot(gEdge, uGrR1.xy)) + pe, nObj.z));
  float metal = mix(mix(metal0, L(uDmgMet), dmg), L(uEdgeMet), edgeAmt);
  float rough = mix(mix(mix(min(1.0, rough0), (1.0 - grL) + L(uGrRB), bleach), clamp((L(uDmgRC) * ((1.0 - d2.x) * (1.0 - d2.x) * 0.85 - 0.35) + 0.5) * L(uDmgRB), 0.0, 1.0), dmg), L(uEdgeR), edgeAmt);
  vec3 lv = mix(vec3(0.045, -1.4427 * log(0.4), 1.0), vec3(0.08, -1.4427 * log(0.4), 0.92), metal); // g_v(Metallic)TextileAlbedoLevels
  vec3 cl = normalize(max(vec3(3e-4), cn));
  vec3 albedo = mix(cn, cl * mix(min(lv.x, dot(mix(detCol, grDet, dg), LUM)), lv.z, clamp(pow(max(cn.x, max(cn.y, cn.z)), lv.y), 0.0, 1.0)) / max(cl.x, max(cl.y, cl.z)), uWear);
  float ao = surf.y * pow(max(nMix.z, 0.0), 0.2) * (1.0 - ga * 0.05) * mix(patShadow, 1.0, dmg);
  emit(albedo, n, ao, rough, metal, mix(L(uDetCloth), L(uDmgCloth), max(dmgAll, edgeAmt)) * (1.0 - metal));
}`

const NEW = COMMON + /* glsl */ `
uniform sampler2D tNormal, tObj, tLayer, tTint, tPat, tPatP, tSurf, tSurfP, tSurfN, tSub, tSubP, tSubN, tDG;
uniform mat4 uMS[4], uMB[4], uMD[4], uMSB[4], uMBB[4];                   // g_m{Surface,Substrate,Damage,SurfaceBurnishing,SubstrateBurnishing}ColorAdjust je Layer
uniform vec4 uSubCT, uDmgMin, uDmgMax, uSoft, uBevSoft, uBevEmb, uBevRB, uBevAniso, uBevMet, uBevCloth, uBevToSub, uBevUseTint,
  uBurnNS, uBurnMet, uBurnCloth, uBurnGrime, uSurfBRB, uSubBRB, uSurfBMin, uSurfBMax, uSubBMin, uSubBMax, uSurfGMin, uSurfGMax, uSubGMin, uSubGMax, uGrimeT, uGrimeRB;
uniform vec4 uIdC[8];
uniform float uIdPat[8];
uniform vec4 uPat0, uPat1, uPRCB;
uniform vec2 uPatDist;
uniform float uWear, uFlip, uPatThr, uPatEmb, uPatCloth, uRespect;
uniform int uTintId, uPattern, uPaintLayer, uPuffy;
vec4 W;
float L(vec4 p) { return dot(W, p); }
// vfx-Eigenheit: diese Werte nimmt sie nur vom letzten Layer mit Gewicht > 0 (mal dessen Gewicht), nicht als Summe
float last(vec4 p) { return W.w > 0.0 ? p.w * W.w : W.z > 0.0 ? p.z * W.z : W.y > 0.0 ? p.y * W.y : p.x * W.x; }
float lastOn(vec4 p) { return W.w > 0.0 ? p.w : W.z > 0.0 ? p.z : W.y > 0.0 ? p.y : W.x > 0.0 ? p.x : 0.0; }
// Farbanpassung wie die vfx: Layer-Matrizen nach Gewicht mischen, dann (rgb, 1) transformieren (Matrizen: colorAdjust unten)
vec3 adjust(vec3 c, mat4 m[4]) { return ((W.x * m[0] + W.y * m[1] + W.z * m[2] + W.w * m[3]) * vec4(c, 1.0)).xyz; }
// Tint färbt c (schon angepasst) bei erhaltener Luminanz; metal verschiebt die Helligkeitsgrenzen
vec3 colorize(vec3 c, vec4 t, float amt, float metal) {
  float lum = dot(t.rgb, LUM);
  if (lum <= 0.0) return c;
  float mx = max(t.r, max(t.g, t.b)), sat = mx > 0.0 ? (mx - min(t.r, min(t.g, t.b))) / mx : 0.0;
  float l = max(dot(c, vec3(0.3, 0.59, 0.11)), 0.001);
  vec3 sc = c * mix(1.0, min(max(1.0 + 4.0 * (lum - 0.5), mix(0.03, 0.134, metal) / l), mix(0.9, 0.98, metal) / l), amt);
  vec3 d = normalize(t.rgb + 1e-6) - 0.577, h = clamp(normalize(d + 1e-6) * 2.0 + 1.0, 0.0, 1.0);
  return mix(sc, h * (lum / max(dot(h, LUM), 1e-4)), clamp(sat * pow(abs(dot(d, vec3(0.577))), 0.2), 0.0, 1.0) * amt);
}
void main() {
  vec2 uv = vUv;
  vec4 lid = texture(tLayer, uv);
  float s = lid.x + lid.y + lid.z, r4 = max(0.0, 1.0 - s);
  W = vec4(lid.xyz, r4) / max(s + r4, 1e-5);
  // Tint-ID (x · 7, aufgerundet): Mitte, dann Kreuz, sonst gewichtetes 3×3
  float patMask = 1.0;
  vec4 T = vec4(1.0, 1.0, 1.0, 0.0);
  if (uTintId != 0) {
    vec2 ts = vec2(textureSize(tTint, 0));
    int id[9];
    for (int k = 0; k < 9; k++) { ivec2 o = ivec2(k % 3 - 1, k / 3 - 1); id[k] = int(ceil(texelFetch(tTint, clamp(ivec2(uv * ts) + o, ivec2(0), ivec2(ts) - 1), 0).x * 7.0)); }
    patMask = 0.0; vec4 acc = vec4(0.0);
    for (int i = 0; i < 8; i++) {
      float e[9];
      for (int k = 0; k < 9; k++) e[k] = float(id[k] == i);
      float v = (e[4] == e[1] && e[4] == e[7]) || (e[4] == e[3] && e[4] == e[5]) ? e[4] : 0.03125 * (e[0] + e[2] + e[6] + e[8]) + 0.09375 * (e[2] + e[3] + e[5] + e[7]) + 0.5 * e[4];
      patMask += uIdPat[i] * v; acc += vec4(uIdC[i].rgb * uIdC[i].a, uIdC[i].a) * v;
    }
    T = acc.a > 0.0 ? vec4(acc.rgb / acc.a, acc.a) : vec4(1.0, 1.0, 1.0, acc.a);
  }
  vec4 sn = texture(tSurfN, uv), bn = texture(tSubN, uv);       // x/z Rauheit, w/y Normale (Hemi-Oct)
  vec3 nSurf = octN(sn.wy), nSub = octN(bn.wy);
  vec4 surf = texture(tSurf, uv), sp = texture(tSurfP, uv), sub = texture(tSub, uv), bp = texture(tSubP, uv), dg = texture(tDG, uv);
  // Muster
  vec2 pu = vec2(uv.x * uFlip, uv.y), pc = vec2(dot(pu, uPat0.xy) + uPat0.w, dot(pu, uPat1.xy) + uPat1.w);
  vec4 pat = texture(tPat, pc - uPatDist * nSurf.xy), patP = texture(tPatP, pc - uPatDist * nSurf.xy), patS = texture(tPat, pc - uPatDist * nSub.xy);
  float patH = pat.a;
  if (uPuffy != 0) { patH = clamp(pat.a * (1.0 + uPatThr) - uPatThr, 0.0, 1.0); pat.a = smoothstep(uPatThr, uPatThr + 0.04, pat.a); }
  bool tintPat = uPattern != 0 && uPaintLayer == 0, paintPat = uPattern != 0 && uPaintLayer != 0;
  float pm = tintPat ? patMask * pat.a : 0.0;
  vec4 subTint = T, surfTint = T;
  if (tintPat) {
    float none = float(T.a == 0.0), ratio = T.a > 0.0 ? clamp(pat.a / T.a, 0.0, 1.0) : none;
    subTint = vec4(mix(T.rgb, patS.rgb, max(none, patS.a) * pm), max(T.a, patS.a * pm));
    surfTint = vec4(mix(T.rgb, pat.rgb, ratio * pm), max(T.a, pat.a * pm));
  }
  float maskSurf = uRespect != 0.0 ? surf.a : max(surf.a, pm), maskSub = uRespect != 0.0 ? sub.a : max(sub.a, pm);
  float subAmt = subTint.a * L(uSubCT);
  vec3 surfC = mix(surf.rgb, colorize(adjust(surf.rgb, uMS), surfTint, surfTint.a, sp.y), maskSurf);
  vec3 subC = mix(sub.rgb, colorize(adjust(sub.rgb, uMB), subTint, subAmt, bp.y), maskSub);
  vec3 bevC = mix(surfC, colorize(adjust(surf.rgb, uMD), subTint, subAmt, L(uBevMet)), lastOn(uBevUseTint) != 0.0 ? maskSurf : 1.0);
  vec3 surfBurn = adjust(surf.rgb, uMSB), subBurn = adjust(sub.rgb, uMBB);
  float surfMet = sp.y, surfCloth = sp.z * (1.0 - sp.y), surfH = sp.w, soft = L(uSoft), bevSoft = L(uBevSoft), bevEmb = L(uBevEmb);
  vec2 surfRough = mix(sn.xz, clamp((sn.xz - 0.5 + uPRCB.y) * uPRCB.x + 0.5, 0.0, 1.0), pm * maskSurf);
  vec2 bevRough = sn.xz * L(uBevRB); bevRough.y = mix(bevRough.x, bevRough.y, L(uBevAniso));
  if (paintPat) {
    float pa = patMask * pat.a * (uRespect != 0.0 ? surf.a : 1.0);
    surfC = mix(surfC, pat.rgb, pa);
    if (uPuffy != 0) {
      float emb = clamp(patH - uPatThr, 0.0, 1.0) * pa;
      surfH += uPatEmb < 0.0 ? 0.0 : emb; soft = mix(soft, 0.0, emb); bevSoft = mix(bevSoft, 0.01, emb); bevEmb = mix(bevEmb, max(0.0, uPatEmb), emb);
      bevC = mix(surfC, pat.rgb, pa);
    }
    surfMet = mix(surfMet, patP.x, pa); surfCloth = mix(surfCloth, uPatCloth, pa); surfRough = mix(sn.xz, vec2(patP.y), pa);
  }
  // Wear: Damage-Höhe legt das Substrate frei, Kante dazwischen = Bevel
  vec4 obj = texture(tObj, uv);                                     // x AO, y Krümmung, z High-Touch
  float dh = surfH - bp.w;
  float t = 2.0 - (uWear * (L(uDmgMax) - L(uDmgMin)) + L(uDmgMin)) - dg.a - obj.y - surfH + dh;
  float reveal = smoothstep(-soft, soft, t * dh / max(soft, 1e-4));
  float h = max(min(surfH, clamp(t, 0.0, 1.0)), bp.w);
  float tb = t / bevSoft, bevel = smoothstep(1.0 + bevSoft, 1.0 - bevSoft, tb), tbs = clamp(tb, 0.0, 1.0);
  float burnA = clamp(uWear - 1.0 + obj.z, 0.0, 1.0) * (h + uWear), burn = clamp(burnA, 0.0, 1.0);
  float subBurnF = smoothstep(L(uSubBMin), L(uSubBMax), burnA), surfBurnF = smoothstep(L(uSurfBMin), L(uSurfBMax), burnA);
  float ao = obj.x * mix(mix(bp.x, sp.x, reveal) * clamp(1.0 - clamp((h + 0.01) / soft, 0.0, 1.0) * (1.0 - clamp((h - 0.01) / soft, 0.0, 1.0)) * reveal * surfH * 0.75, 0.0, 1.0), 1.0, subBurnF);
  vec3 subF = mix(subC, subBurn, subBurnF);
  // Normale: Objekt + Layer-Detail, Bevel-Prägung über Bildschirm-Ableitungen der Höhe
  vec3 nObj = octN(texture(tNormal, uv).xy);
  float ns = mix(1.0, last(uBurnNS), burn);
  vec3 n = normalize(vec3(nObj.xy + mix(nSub.xy, nSurf.xy, reveal) * ns, nObj.z));
  vec3 P = vec3(uv.x, 1.0 - uv.y, tb);
  float texel = (1.0 / 2048.0) / max(max(dFdx(uv.x), dFdy(uv.y)), 1e-6);
  n = normalize(mix(n, n + normalize(cross(dFdy(P), dFdx(P)) + 1e-6), smoothstep(-bevSoft, bevSoft, tb) * bevel * ns * bevEmb * texel * dh));
  vec2 rough = mix(bn.xz, mix(surfRough, bevRough, bevel), reveal) * mix(1.0, mix(last(uSubBRB), last(uSurfBRB), tbs), burn);
  float g0 = h * ao * uWear * 2.0;
  float gm = mix(smoothstep(L(uSubGMin), L(uSubGMax), g0), smoothstep(L(uSurfGMin), L(uSurfGMax), g0), mix(reveal, 1.0 - bevel, L(uBevToSub))) * (1.0 - min(rough.x, rough.y));
  float grime = mix(gm, max(gm, L(uBurnGrime)), burn) * L(uGrimeT);
  rough = mix(rough, rough.xx * L(uGrimeRB), grime);
  float metal = mix(mix(bp.y, mix(surfMet, L(uBevMet), bevel), reveal), L(uBurnMet), burn) * (1.0 - grime);
  vec3 bevBurn = adjust(bevC, uMSB);
  vec3 top = mix(mix(surfC, surfBurn, surfBurnF), mix(mix(bevC, bevBurn, surfBurnF), subF, L(uBevToSub) * (1.0 - tbs)), bevel);
  vec3 col = mix(mix(subF, top, reveal), dg.rgb, grime);
  float cloth = mix(mix(bp.z * (1.0 - bp.y), mix(surfCloth, L(uBevCloth), bevel), reveal), L(uBurnCloth), burn) * (1.0 - metal);
  emit(col, n, ao, 0.5 * (rough.x + rough.y), metal, cloth);
}`

const DEF_NEW: Record<string, number[]> = { // Shader-Defaults (≠ 0) aus der VCS; '#' = Layer 1–4
  'g_vUvScale#': [4, 4], g_vPatternTexCoordCenter: [0.5, 0.5], g_vPatternTexCoordScale: [1, 1], 'g_fDamageUvScale#': [4], 'g_fGrimeUvScale#': [4],
  'g_fSubstrateCompositeColorTranslucency#': [0.5], 'g_fDamageHeightBlendSoftness#': [0.01], 'g_vDamageMinMax#': [0, 1], 'g_fDamageBevelBlendSoftness#': [0.5],
  'g_fDamageBevelEmboss#': [1], 'g_fDamageBevelRoughnessBrightness#': [1], 'g_fBurnishingNormalScale#': [1], 'g_fSurfaceBurnishingRoughnessBrightness#': [1],
  'g_fSubstrateBurnishingRoughnessBrightness#': [1], 'g_vSurfaceBurnishingMinMax#': [0, 1], 'g_vSubstrateBurnishingMinMax#': [0, 1], 'g_fGrimeTranslucency#': [0.5],
  'g_fGrimeRoughnessBrightness#': [1], 'g_vSurfaceGrimeMinMax#': [0, 1], 'g_vSubstrateGrimeMinMax#': [0, 1], 'g_fBurnishingGrime#': [0.5],
  'g_vId#Color': [1, 1, 1, 1], g_fPatternTranslucencyThreshold: [0.01], g_fPatternEmboss: [0.5], g_vPatternRoughnessContrastBrightness: [1, 0],
  'g_f%ColorBrightness#': [1], 'g_f%ColorContrast#': [1], 'g_f%ColorSaturation#': [1], 'g_v%ColorTint#': [1, 1, 1],
}
const DEF_OLD: Record<string, number[]> = {
  'g_fDetailBlackPoint#': [0.047], 'g_fDetailScale#': [4], 'g_fDetailRoughnessBrightness#': [1], 'g_fDetailNormalContrast#': [1], 'g_vDamageLevels#': [0, 1],
  'g_fDamageRoughnessBrightness#': [1], 'g_fCurvaturePower#': [1], 'g_fDamageNormalEdgeWidth#': [1], 'g_fDamageEdgeRoughness#': [0.8], 'g_fGrungeMax#': [1],
  'g_fGrungeRoughnessBrightness#': [0.8], 'g_fWearBleaching#': [0.25], g_fColorMaskBlur: [2], g_fPatternRoughnessBrightness: [1], g_fPaintThickness: [1],
  g_fPaintDurability: [0.5], g_fWearExponent: [1], g_fGrungeTexCoordScale: [2.5], g_fPatternTexCoordScale: [2.5], g_flSheenScale: [0.667],
  g_vColorTint1: [0.15, 0.11, 0.08], g_vColorTint2: [0.23, 0.16, 0.26], g_vColorTint3: [0.16, 0.16, 0.28], g_vColorTint4: [0.2, 0.3, 0.3],
  g_vColorTint5: [0.09, 0.16, 0.1], g_vColorTint6: [0.29, 0.26, 0.11], g_vColorTint7: [0.32, 0.22, 0.12], g_vColorTint8: [0.21, 0.12, 0.09],
}
/** Parameter mit Shader-Default; Layer-Ziffer am Ende (oder vor 'Color') wird im Default-Namen zu '#', Surface/Substrate/… zu '%' */
const param = (vars: Record<string, number[]> | undefined, def: Record<string, number[]>) => (k: string): number[] => {
  if (vars?.[k]) return vars[k]
  const g = k.replace(/(\d)(Color)?$/, (_m, _d, c) => '#' + (c ?? '')).replace(/^g_(f|v)(Surface|Substrate|DamageBevel|Burnishing)(Color)/, 'g_$1%$3')
  return def[k] ?? def[g] ?? [0, 0, 0, 0]
}
const sRGB = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const v4 = (a: number[]) => new THREE.Vector4(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0)
const lay = (get: (k: string) => number[], name: string, c = 0) => new THREE.Vector4(...[1, 2, 3, 4].map(i => get(name.replace('#', String(i)))[c] ?? 0))
/** Wurf wie RANDOM_ROLL: jede Komponente ein Zug, ohne Grenzen fester Wert */
const roll = (rng: UniformRandomStream, v: RollVar | null | undefined, c: 'x' | 'y') => {
  const b = (c === 'x' ? v?.x : v?.y) ?? 0
  return rng.float((c === 'x' ? v?.xmin : v?.ymin) ?? b, (c === 'x' ? v?.xmax : v?.ymax) ?? b)
}
/** Zeilen einer UV-Transformation (uv' = (dot(uv, r0.xy) + r0.w, dot(uv, r1.xy) + r1.w)) */
const rows = (a: number, b: number, c: number, d: number, tx: number, ty: number): [THREE.Vector4, THREE.Vector4] => [new THREE.Vector4(a, b, 0, tx), new THREE.Vector4(c, d, 0, ty)]
/** Damage/Grime-Transformation der neuen vfx (Drehung um 0,5) */
const rot5 = (deg: number, ox: number, oy: number) => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r)
  return rows(c, -s, s, c, 0.5 + ox + s * 0.5 - c * 0.5, 0.5 + oy - (s * 0.5 + c * 0.5))
}
const OBJECT_SIZE = 1024

export class GloveCompositor {
  private readonly quad = new THREE.Mesh(new THREE.BufferGeometry())
  private readonly scene = new THREE.Scene()
  private readonly cam = new THREE.Camera()
  private readonly white = solid([255, 255, 255, 255])
  private readonly flat = solid([128, 128, 128, 128]) // Hemi-Oct-Normale (0,5; 0,5) = flach
  private readonly mats: Record<'blend' | 'old' | 'new', THREE.RawShaderMaterial>
  private compiled = new Set<string>()

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.quad.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 2, 0], 3))
    this.quad.geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2))
    this.quad.frustumCulled = false; this.scene.add(this.quad)
    const m = (fs: string) => new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: fs, uniforms: {} })
    this.mats = { blend: m(BLEND), old: m(OLD), new: m(NEW) }
  }

  /**
   * Handschuh zusammensetzen: map size² (Ego 2048 in High, sonst 1024), orm/normal ≤ 1024 (2048: 16 + 2·5,3 MiB mit Mips = 32 MiB).
   * left = Off-Hand-Material (alt: g_bFlipFixup umgekehrt; neu: vcompmat setzt es links auf false). Zwischenbilder werden danach freigegeben.
   */
  async build(kit: GloveSkin | GloveSkin2, p: Paint3D, size = 1024, left = false, base = ''): Promise<GloveTex> {
    const own: THREE.Texture[] = [], loaded = new Map<string, Promise<THREE.Texture | null>>(), tmp: THREE.WebGLRenderTarget[] = []
    const load = (url: string | undefined, srgb = false) => {
      if (!url) return Promise.resolve(null)
      const k = url + srgb
      if (!loaded.has(k)) loaded.set(k, this.load(base + url, srgb).then(t => (t && own.push(t), t)))
      return loaded.get(k)!
    }
    const out: THREE.WebGLRenderTarget[] = []
    try {
      const S = size, S2 = Math.min(size, OBJECT_SIZE)
      const rt = (n: number, srgb: boolean, mips: boolean) => {
        const r = new THREE.WebGLRenderTarget(n, n, { colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace, generateMipmaps: mips, depthBuffer: false,
          minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, magFilter: THREE.LinearFilter })
        r.texture.wrapS = r.texture.wrapT = THREE.RepeatWrapping; r.texture.anisotropy = 8
        return r
      }
      const inter = (srgb: boolean) => { const r = rt(S, srgb, S > S2); tmp.push(r); return r }
      let mat: THREE.RawShaderMaterial
      if (kit.kind === 'glove2') mat = await this.setupNew(kit, p, left, load, inter)
      else mat = await this.setupOld(kit, p, left, load, inter)
      const map = rt(S, true, true), normal = rt(S2, false, true), orm = rt(S2, false, true)
      out.push(map, normal, orm)
      await this.draw(mat, map, 0); await this.draw(mat, normal, 1); await this.draw(mat, orm, 2)
      return { map: map.texture, orm: orm.texture, normal: normal.texture, sheen: kit.vars?.g_flSheenScale?.[0] ?? 0.667, targets: out }
    } catch (e) { for (const r of out) r.dispose(); throw e }
    finally {
      for (const r of tmp) r.dispose()
      for (const t of own) { t.dispose(); if (typeof ImageBitmap !== 'undefined' && t.image instanceof ImageBitmap) t.image.close() }
    }
  }

  /** Mischpass in ein Zwischenbild: A (und B) je Layer mit eigener UV-Zeile */
  private async blend(target: THREE.WebGLRenderTarget, w: THREE.Texture, wMode: number, outMode: number,
    A: (THREE.Texture | null)[], aRows: [THREE.Vector4, THREE.Vector4][], B: (THREE.Texture | null)[] = [], bRows = aRows,
    mul = [1, 1, 1, 1].map(() => new THREE.Vector4(1, 1, 1, 1)), add = [1, 1, 1, 1].map(() => new THREE.Vector4(0, 0, 0, 0))) { // Vector4() hätte w = 1
    const u: Record<string, THREE.IUniform> = { tW: { value: w }, uWMode: { value: wMode }, uOut: { value: outMode },
      uA0: { value: aRows.map(r => r[0]) }, uA1: { value: aRows.map(r => r[1]) }, uB0: { value: bRows.map(r => r[0]) }, uB1: { value: bRows.map(r => r[1]) }, uMul: { value: mul }, uAdd: { value: add } }
    for (let i = 0; i < 4; i++) { u['tA' + i] = { value: A[i] ?? this.white }; u['tB' + i] = { value: B[i] ?? this.white } }
    Object.assign(this.mats.blend.uniforms, u) // gleiches Objekt: three merkt sich die Uniform-Liste beim ersten Übersetzen
    await this.draw(this.mats.blend, target, -1)
  }

  private async setupOld(k: GloveSkin, p: Paint3D, left: boolean, load: (u?: string, s?: boolean) => Promise<THREE.Texture | null>,
    inter: (srgb: boolean) => THREE.WebGLRenderTarget) {
    const get = param(k.vars, DEF_OLD), x = (n: string) => get(n)[0] ?? 0, t = k.tex ?? {}
    const L = (n: string, c = 0) => lay(get, n, c)
    const [mask, surf, normal, noise, pattern, ...lt] = await Promise.all([t.g_tLayerMask ?? k.mask, t.g_tSurface ?? k.surface, t.g_tNormal, t.g_tNoise, t.g_tPattern ?? k.pattern,
      ...[1, 2, 3, 4].flatMap(i => [t[`g_tDetail${i}`], t[`g_tDetailNormal${i}`], t[`g_tDamageNormal${i}`], t[`g_tGrunge${i}`]])].map(u => load(u)))
    if (!mask) throw new Error('glove mask missing')
    const flip = (x('g_bFlipFixup') !== 0) !== left
    // Würfe: _shared_paint_generic (Muster-Versatz xy, Muster-Drehung, Grunge-Versatz xy, Grunge-Drehung)
    const rng = new UniformRandomStream(p.seed)
    const ox = roll(rng, k.roll.patternOffset, 'x'), oy = roll(rng, k.roll.patternOffset, 'y'), rot = roll(rng, k.roll.patternRotation, 'x')
    const gx = roll(rng, { x: 0, xmin: 0, xmax: 1 }, 'x'), gy = roll(rng, { x: 0, xmin: 0, xmax: 1 }, 'x'), grot = roll(rng, { x: 0, xmin: 0, xmax: 360 }, 'x')
    const [pat0, pat1] = texXform(flip ? -rot : rot, x('g_fPatternTexCoordScale'), 1, ox, oy)
    const [patR0, patR1] = texXform(flip ? rot : -rot, 1, 1, 0, 0)
    const [gr0, gr1] = texXform(grot, x('g_fGrungeTexCoordScale'), 1, gx, gy)
    const [grR0, grR1] = texXform(-grot, 1, 1, 0, 0)
    const det = (i: number) => lt[i * 4], dn = (i: number) => lt[i * 4 + 1], dm = (i: number) => lt[i * 4 + 2], gu = (i: number) => lt[i * 4 + 3]
    const scale = [1, 2, 3, 4].map(i => x(`g_fDetailScale${i}`)), dRows = scale.map(s => rows(s, 0, 0, s, 0, 0))
    const iDet = inter(false), iN = inter(false), iGr = inter(false)
    const bp = [1, 2, 3, 4].map(i => x(`g_fDetailBlackPoint${i}`))
    await this.blend(iDet, mask, 0, 0, [0, 1, 2, 3].map(det), dRows, [], dRows, bp.map(b => new THREE.Vector4(1 - b, 1 - b, 1, 1)), bp.map(b => new THREE.Vector4(b, b, 0, 0)))
    await this.blend(iN, mask, 0, 1, [0, 1, 2, 3].map(dn), dRows, [0, 1, 2, 3].map(dm), dRows)
    await this.blend(iGr, mask, 0, 0, [0, 1, 2, 3].map(gu), [0, 1, 2, 3].map(() => [gr0, gr1] as [THREE.Vector4, THREE.Vector4]))
    const a = gr0.x, b = gr0.y, c = gr1.x, d = gr1.y, det2 = a * d - b * c || 1 // Versatz im Grunge-Raum → UV: Inverse des linearen Teils
    const tint = [1, 2, 3, 4, 5, 6, 7, 8].map(i => new THREE.Vector3(...get(`g_vColorTint${i}`).slice(0, 3)))
    const wear = Math.pow(Math.max(0, p.wear), x('g_fWearExponent'))
    const m = this.mats.old
    Object.assign(m.uniforms, {
      uMode: { value: 0 }, tMask: { value: mask }, tSurf: { value: surf ?? this.white }, tNormal: { value: normal ?? this.flat }, tNoise: { value: noise ?? this.flat },
      tPattern: { value: pattern ?? this.white }, tDetail: { value: iDet.texture }, tDN: { value: iN.texture }, tGrunge: { value: iGr.texture },
      uDetMet: { value: L('g_fDetailMetalness#') }, uDmgLo: { value: L('g_vDamageLevels#', 0) }, uDmgHi: { value: L('g_vDamageLevels#', 1) }, uDmgSat: { value: L('g_fDamageSaturation#') },
      uEdgeW: { value: L('g_fDamageNormalEdgeWidth#') }, uDetGr: { value: L('g_fDetailGrunge#') }, uGrimeSat: { value: L('g_fGrimeSaturation#') }, uCurvPow: { value: L('g_fCurvaturePower#') },
      uDRC: { value: L('g_fDetailRoughnessContrast#') }, uDRB: { value: L('g_fDetailRoughnessBrightness#') }, uCWB: { value: L('g_fCurvatureWearBoost#') }, uWB: { value: L('g_fWearBleaching#') },
      uDB: { value: L('g_fDamageBleaching#') }, uGrimeBr: { value: L('g_fGrimeBrightness#') }, uDmgBr: { value: L('g_fDamageBrightness#') }, uGrMax: { value: L('g_fGrungeMax#') },
      uDmgMet: { value: L('g_fDamageMetalness#') }, uEdgeMet: { value: L('g_fDamageEdgeMetalness#') }, uDetCloth: { value: L('g_fDetailCloth#') }, uDmgCloth: { value: L('g_fDamageCloth#') },
      uGrRB: { value: L('g_fGrungeRoughnessBrightness#') }, uDmgRC: { value: L('g_fDamageRoughnessContrast#') }, uDmgRB: { value: L('g_fDamageRoughnessBrightness#') },
      uEdgeR: { value: L('g_fDamageEdgeRoughness#') }, uDNC: { value: L('g_fDetailNormalContrast#') },
      uPat0: { value: pat0 }, uPat1: { value: pat1 }, uPatR0: { value: patR0 }, uPatR1: { value: patR1 }, uGrR0: { value: grR0 }, uGrR1: { value: grR1 },
      uGrToUv: { value: new THREE.Matrix2().set(d / det2, -b / det2, -c / det2, a / det2) },
      uTint: { value: tint }, uPal: { value: (get('g_vPatternPaletteIndices').length ? get('g_vPatternPaletteIndices') : k.palette).slice(0, 4).map(v => Math.max(1, Math.min(8, Math.round(v || 1)))) },
      uWear: { value: wear }, uFlip: { value: flip ? -1 : 1 }, uBlur: { value: x('g_fColorMaskBlur') }, uPatDetail: { value: x('g_fPatternDetailInfluence') },
      uThick: { value: x('g_fPaintThickness') }, uDur: { value: x('g_fPaintDurability') }, uShadowPow: { value: Math.max(0.01, x('g_fPaintThickness') * 0.15) },
      uPatMet: { value: x('g_fPatternMetalness') }, uPatRB: { value: x('g_fPatternRoughnessBrightness') }, uBP1: { value: bp[0] }, uComp1: { value: 1 - bp[0] },
      uPattern: { value: (k.usePattern || x('F_PATTERN') === 1) && pattern ? 1 : 0 }, uPatMode: { value: x('g_nPatternMode') }, uReplace: { value: Math.max(0, Math.min(7, (k.replaceIndex ?? x('g_nPatternReplaceIndex')) - 1)) },
    })
    return m
  }

  private async setupNew(k: GloveSkin2, p: Paint3D, left: boolean, load: (u?: string, s?: boolean) => Promise<THREE.Texture | null>,
    inter: (srgb: boolean) => THREE.WebGLRenderTarget) {
    // Würfe in vcompmat-Reihenfolge, Ergebnis überschreibt die vmat-Werte
    const rolled: Record<string, number[]> = {}, rng = new UniformRandomStream(p.seed)
    for (const [name, v] of k.rolls) rolled[name] = v.y !== undefined || v.ymin !== undefined ? [roll(rng, v, 'x'), roll(rng, v, 'y')] : [roll(rng, v, 'x')]
    const get = param({ ...k.vars, ...rolled }, DEF_NEW), x = (n: string) => get(n)[0] ?? 0, t = k.tex
    const L = (n: string, c = 0) => lay(get, n, c)
    const per = (n: string) => [1, 2, 3, 4].map(i => t[`g_t${n}${i}`])
    const [normal, obj, layer, tintId, pat, patP] = await Promise.all([t.g_tNormal, t.g_tObjectProperties, t.g_tLayerId, t.g_tTintId, t.g_tPattern, t.g_tPatternProperties].map((u, i) => load(u, i === 4)))
    const [surf, surfP, surfN, sub, subP, subN, dmg, grime] = await Promise.all(['Surface', 'SurfaceProperties', 'SurfaceNormal', 'Substrate', 'SubstrateProperties', 'SubstrateNormal', 'Damage', 'Grime']
      .map(n => Promise.all(per(n).map(u => load(u, n === 'Surface' || n === 'Substrate' || n === 'Grime')))))
    if (!layer) throw new Error('glove layer id missing')
    const lRows = [1, 2, 3, 4].map(i => { const s = get(`g_vUvScale${i}`), o = get(`g_vUvOffset${i}`); return rows(s[0], 0, 0, s[1] ?? s[0], o[0] ?? 0, o[1] ?? 0) })
    const scaled = (r: [THREE.Vector4, THREE.Vector4], s: number) => r.map(v => v.clone().multiplyScalar(s)) as [THREE.Vector4, THREE.Vector4]
    const dOff = get('g_vDamageTexCoordOffset'), gOff = get('g_vGrimeTexCoordOffset')
    const dRot = rot5(x('g_fDamageTexCoordRotation'), dOff[0] ?? 0, dOff[1] ?? 0), gRot = rot5(x('g_fGrimeTexCoordRotation'), gOff[0] ?? 0, gOff[1] ?? 0)
    const dRows = [1, 2, 3, 4].map(i => scaled(dRot, x(`g_fDamageUvScale${i}`))), gRows = [1, 2, 3, 4].map(i => scaled(gRot, x(`g_fGrimeUvScale${i}`)))
    const I = { surf: inter(true), surfP: inter(false), surfN: inter(false), sub: inter(true), subP: inter(false), subN: inter(false), dg: inter(true) }
    await this.blend(I.surf, layer, 1, 0, surf, lRows)
    await this.blend(I.surfP, layer, 1, 0, surfP, lRows)
    await this.blend(I.surfN, layer, 1, 0, surfN.map(v => v ?? this.flat), lRows)
    await this.blend(I.sub, layer, 1, 0, sub, lRows)
    await this.blend(I.subP, layer, 1, 0, subP, lRows)
    await this.blend(I.subN, layer, 1, 0, subN.map(v => v ?? this.flat), lRows)
    await this.blend(I.dg, layer, 1, 2, dmg, dRows, grime, gRows)
    // Muster (VS der vfx): um das Zentrum gedreht, Skala je Achse, Versatz gewürfelt; Off-Hand spiegelt u (g_bFlipFixup)
    const r = (x('g_fPatternTexCoordRotation') * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r), sc = get('g_vPatternTexCoordScale'), ce = get('g_vPatternTexCoordCenter'), po = get('g_vPatternTexCoordOffset')
    const [pat0, pat1] = rows(cs * sc[0], -sn * (sc[1] ?? sc[0]), sn * sc[0], cs * (sc[1] ?? sc[0]), ce[0] + (po[0] ?? 0) + sn * ce[1] - cs * ce[0], ce[1] + (po[1] ?? 0) - (sn * ce[0] + cs * ce[1]))
    const flip = x('g_bFlipFixup') !== 0 && !left // vcompmat setzt g_bFlipFixup links auf false
    const id = [1, 2, 3, 4, 5, 6, 7, 8].map(i => { const c = get(`g_vId${i}Color`); return new THREE.Vector4(sRGB(c[0]), sRGB(c[1]), sRGB(c[2]), c[3] ?? 1) })
    // g_m*ColorAdjust: Tint/Kontrast/Sättigung/Helligkeit des Layers, Mittelwert der Layer-Textur (Kit-JSON, main textureAverage)
    const adj = (n: string, t: 'Surface' | 'Substrate') => [1, 2, 3, 4].map(i => new THREE.Matrix4().fromArray(colorAdjust(get(`g_v${n}ColorTint${i}`),
      x(`g_f${n}ColorContrast${i}`), x(`g_f${n}ColorSaturation${i}`), x(`g_f${n}ColorBrightness${i}`), k.vars[`TextureAverageColor(g_t${t}${i})`] ?? [0.5, 0.5, 0.5])).transpose()) // fromArray liest spaltenweise
    const soft = L('g_fDamageHeightBlendSoftness#'), bev = L('g_fDamageBevelBlendSoftness#')
    const m = this.mats.new
    Object.assign(m.uniforms, {
      uMode: { value: 0 }, tNormal: { value: normal ?? this.flat }, tObj: { value: obj ?? this.white }, tLayer: { value: layer }, tTint: { value: tintId ?? this.white },
      tPat: { value: pat ?? this.white }, tPatP: { value: patP ?? this.white },
      tSurf: { value: I.surf.texture }, tSurfP: { value: I.surfP.texture }, tSurfN: { value: I.surfN.texture }, tSub: { value: I.sub.texture }, tSubP: { value: I.subP.texture },
      tSubN: { value: I.subN.texture }, tDG: { value: I.dg.texture },
      uMS: { value: adj('Surface', 'Surface') }, uMB: { value: adj('Substrate', 'Substrate') }, uMD: { value: adj('DamageBevel', 'Surface') },
      uMSB: { value: adj('Burnishing', 'Surface') }, uMBB: { value: adj('Burnishing', 'Substrate') },
      uSubCT: { value: L('g_fSubstrateCompositeColorTranslucency#') }, uDmgMin: { value: L('g_vDamageMinMax#', 0) }, uDmgMax: { value: L('g_vDamageMinMax#', 1) },
      uSoft: { value: new THREE.Vector4(...soft.toArray().map(v => Math.max(v, 0.001))) }, uBevSoft: { value: new THREE.Vector4(...bev.toArray().map((v, i) => Math.max(v + soft.getComponent(i), 0.001))) },
      uBevEmb: { value: L('g_fDamageBevelEmboss#') }, uBevRB: { value: L('g_fDamageBevelRoughnessBrightness#') }, uBevAniso: { value: L('g_fDamageBevelAnisotropy#') },
      uBevMet: { value: L('g_fDamageBevelMetalness#') }, uBevCloth: { value: L('g_fDamageBevelCloth#') }, uBevToSub: { value: L('g_bDamageBevelBlendToSubstrate#') },
      uBevUseTint: { value: L('g_bDamageBevelUseTintMask#') }, uBurnNS: { value: L('g_fBurnishingNormalScale#') }, uBurnMet: { value: L('g_fBurnishingMetalness#') },
      uBurnCloth: { value: L('g_fBurnishingCloth#') }, uBurnGrime: { value: L('g_fBurnishingGrime#') }, uSurfBRB: { value: L('g_fSurfaceBurnishingRoughnessBrightness#') },
      uSubBRB: { value: L('g_fSubstrateBurnishingRoughnessBrightness#') }, uSurfBMin: { value: L('g_vSurfaceBurnishingMinMax#', 0) }, uSurfBMax: { value: L('g_vSurfaceBurnishingMinMax#', 1) },
      uSubBMin: { value: L('g_vSubstrateBurnishingMinMax#', 0) }, uSubBMax: { value: L('g_vSubstrateBurnishingMinMax#', 1) }, uSurfGMin: { value: L('g_vSurfaceGrimeMinMax#', 0) },
      uSurfGMax: { value: L('g_vSurfaceGrimeMinMax#', 1) }, uSubGMin: { value: L('g_vSubstrateGrimeMinMax#', 0) }, uSubGMax: { value: L('g_vSubstrateGrimeMinMax#', 1) },
      uGrimeT: { value: L('g_fGrimeTranslucency#') }, uGrimeRB: { value: L('g_fGrimeRoughnessBrightness#') },
      uIdC: { value: id }, uIdPat: { value: [1, 2, 3, 4, 5, 6, 7, 8].map(i => x(`g_bId${i}Pattern`)) },
      uPat0: { value: pat0 }, uPat1: { value: pat1 }, uPRCB: { value: v4(get('g_vPatternRoughnessContrastBrightness')) },
      uPatDist: { value: new THREE.Vector2(x('g_fPatternNormalDistortion') * 0.1 * sc[0], x('g_fPatternNormalDistortion') * 0.1 * (sc[1] ?? sc[0])) },
      // g_fWearProgress = SrgbLinearToGamma(Wear) (VCS-Ausdruck des neuen Zweigs)
      uWear: { value: p.wear <= 0.0031308 ? p.wear * 12.92 : 1.055 * Math.pow(p.wear, 1 / 2.4) - 0.055 }, uFlip: { value: flip ? -1 : 1 },
      uPatThr: { value: x('g_fPatternTranslucencyThreshold') }, uPatEmb: { value: x('g_fPatternEmboss') }, uPatCloth: { value: x('g_fPatternCloth') },
      uRespect: { value: x('g_fPatternPaintRespectsTintMask') }, uTintId: { value: x('F_TINT_ID') && tintId ? 1 : 0 },
      uPattern: { value: x('F_PATTERN') && pat ? 1 : 0 }, uPaintLayer: { value: x('F_PATTERN_PAINT') }, uPuffy: { value: x('F_PUFFY_PAINT') },
    })
    return m
  }

  private async draw(mat: THREE.RawShaderMaterial, target: THREE.WebGLRenderTarget, mode: number) {
    if (mode >= 0) mat.uniforms.uMode.value = mode
    this.quad.material = mat
    const key = mat.fragmentShader.length + ':' + mat.uuid
    if (!this.compiled.has(key)) { await this.renderer.compileAsync(this.scene, this.cam); this.compiled.add(key) } // einmal parallel übersetzen
    const prev = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(target); this.renderer.render(this.scene, this.cam); this.renderer.setRenderTarget(prev)
  }

  private async load(url: string, srgb: boolean): Promise<THREE.Texture | null> {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`${url} (${r.status})`)
    // premultiplyAlpha none: RGB unter A = 0 sind Daten (Tint-Maske im Alpha)
    const t = new THREE.Texture(await createImageBitmap(await r.blob(), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
    t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; t.needsUpdate = true
    return t
  }

  dispose() {
    for (const m of Object.values(this.mats)) m.dispose()
    this.quad.geometry.dispose(); this.white.dispose(); this.flat.dispose()
  }
}

const solid = (v: number[]) => { const t = new THREE.DataTexture(new Uint8Array(v), 1, 1); t.needsUpdate = true; return t }
