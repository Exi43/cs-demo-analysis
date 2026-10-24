// X-Ray (Bild 5) und Schadens-Rot (Bild 3) der Spielermodelle: je Hülle eines Agenten (agents.ts, userData.hull: alle Primitive in einer
// Geometrie; ohne Hülle je SkinnedMesh) Zwillinge mit gleicher Geometrie, gleichem Skelett (three rechnet die Knochen einmal je Bild und
// Skelett) und gleicher Kugel fürs Frustum-Culling, auf Layer 1 (die Granaten-Kamera sieht nur Layer 0).
// Zwei Durchgänge über den Stencil des HDR-Ziels (post.ts):
//   1. opak direkt nach der Map (Tiefenpuffer = nur Map), ohne Farbe: Silhouette → Bit 1, von der Welt verdeckte Teile → Bit 2.
//   2. nach allen durchsichtigen Effekten (Rauch, Feuer, Funken), ohne Tiefentest, nur per Stencil: dunkle Füllung (Bild 5) auf Bit 2,
//      dünner Umriss um die ganze Silhouette wie CS2 (heller Kern UMRISS_PX + schwacher Saum SAUM_PX, Hülle entlang der Normalen im
//      Clip-Space verbreitert, ab NEAR_M mit der Entfernung schmaler, nie unter 1 Bildpixel), Schadens-Rot.
// So bleiben Umrisse, Füllung und Schaden wie in CS2 durch Smokes und Molotovs sichtbar. Jedes Pixel wird je Teil nur einmal gemischt
// (Stencil-Bit nach dem Zeichnen gesetzt bzw. gelöscht): keine Doppel-Ränder an Überlappungen, keine dicken Klumpen auf Distanz.
// Schaden (an X-Ray gekoppelt): unlit Rot 220/0/0 (CS2 PlayerHealthGlow) von den Füßen bis zur Höhe der fehlenden HP, blinkt DAMAGE_S
// lang nach jedem Treffer (damagePulse), Engine schaltet ihn bei Tod aus.
// Aus = unsichtbar (0 Draw-Calls). Die Programme entstehen im compileAsync des ersten Bildes (bis zum ersten update sichtbar).
import * as THREE from 'three'
import { EV, upperBound, type CS3D } from '../../../shared/cs3d'
import type { Side } from '../../../shared/model'

/** Sekunden, die das Schadens-Rot nach einem Treffer blinkt */
export const DAMAGE_S = 3
/** Blink-Periode (s) und Ausblenden am Ende (s) */
const BLINK_S = 0.4, FADE_S = 0.6
/**
 * Zeichenreihenfolge: Map MAP_ORDER (setzt die Engine), dann Durchgang 1 (opak, vor Agenten und Waffen = 0); Durchgang 2 im
 * durchsichtigen Teil nach allen Effekten (Rauch 10, Treffer 25, Flugbahnen 30): Füllung, Kern, Saum, Schaden. Schilder danach (LABEL_ORDER).
 */
export const MAP_ORDER = -2, LABEL_ORDER = 60
const MASK_ORDER = -1, HIDDEN_ORDER = -0.9, FILL_ORDER = 50, CORE_ORDER = 51, HALO_ORDER = 52, DAMAGE_ORDER = 53
/** Umriss in px bei 1080 Zeilen (skaliert mit der Bildhöhe): heller Kern und Saum; ab NEAR_M Entfernung schmaler (bis MIN_K) */
const UMRISS_PX = 1.1, SAUM_PX = 2.4, NEAR_M = 6, MIN_K = 0.45
/** Stencil-Bits: Silhouette, von der Welt verdeckt, Schaden schon gezeichnet */
const BODY = 1, HIDDEN = 2, DMG = 4
/** Umriss- und Fülltönung je Team (Entwurf v2: CT blau, T orange) */
const TEAM: Record<Side, number> = { CT: 0x6ab8ff, T: 0xffa53a }

/** Höhe des Render-Ziels in Pixeln (Engine setzt sie bei jeder Größenänderung): Umriss nie schmaler als 1 Bildpixel */
const uRes = { value: 1080 }
export const setXrayHeight = (h: number) => { uRes.value = Math.max(1, h) }

const VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
varying vec3 vN;
varying vec3 vV;
varying float vY;
#ifdef OUTLINE
uniform float uPx;
uniform float uRes;
#endif
void main() {
  #include <skinbase_vertex>
  #include <beginnormal_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vN = normalize(normalMatrix * objectNormal);
  vV = -mvPosition.xyz;
  vY = (modelMatrix * vec4(transformed, 1.0)).y;
  #ifdef OUTLINE
  // Bildschirm-Richtung der Normale (xy der View-Normale) um px nach außen: NDC-y 2/H je px, x durch das Seitenverhältnis
  float px = max(uPx * clamp(${NEAR_M.toFixed(1)} / max(-mvPosition.z, 0.01), ${MIN_K}, 1.0) * uRes / 1080.0, 1.0);
  vec2 n = normalize(vN.xy + vec2(1e-6, 0.0));
  gl_Position.xy += vec2(n.x * projectionMatrix[0][0] / projectionMatrix[1][1], n.y) * (2.0 * px / uRes) * gl_Position.w;
  #endif
}`
const FILL = /* glsl */ `
uniform vec3 uColor;
varying vec3 vN;
varying vec3 vV;
void main() {
  float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  rim = rim * rim * rim;
  gl_FragColor = vec4(mix(uColor * 0.035, uColor, 0.5 * rim), 0.7 + 0.25 * rim);
  #include <colorspace_fragment>
}`
const FLAT = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
void main() {
  gl_FragColor = vec4(uColor, uAlpha);
  #include <colorspace_fragment>
}`
const DAMAGE = /* glsl */ `
uniform vec3 uColor;
uniform float uTop;
uniform float uAlpha;
varying float vY;
void main() {
  if (vY > uTop) discard;
  gl_FragColor = vec4(uColor, uAlpha);
  #include <colorspace_fragment>
}`

/** Stencil: Test (Bit ref gesetzt bzw. nicht), danach op auf dieses Bit */
const stencil = (bit: number, func: THREE.StencilFunc, op: THREE.StencilOp, ref = bit) =>
  ({ stencilWrite: true, stencilRef: ref, stencilFuncMask: bit, stencilWriteMask: bit, stencilFunc: func, stencilZPass: op } as const)
/** Durchgang 2: im durchsichtigen Teil, ohne Tiefe */
const over = { transparent: true, depthTest: false, depthWrite: false } as const

/** Zwillinge eines Agenten; Materialien je Agent (eigene Uniforms), Programme geteilt */
export class XrayTwins {
  private src: THREE.SkinnedMesh[] = []
  private readonly xray: THREE.SkinnedMesh[] = []
  private readonly dm: THREE.SkinnedMesh[] = []
  private readonly dmat: THREE.ShaderMaterial
  private on = true // bis zum ersten update sichtbar → compileAsync übersetzt alle Programme

  constructor(root: THREE.Object3D, side: Side) {
    root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) this.src.push(o as THREE.SkinnedMesh) })
    if (this.src.some(s => s.userData.hull)) this.src = this.src.filter(s => s.userData.hull)
    const team = new THREE.Color(TEAM[side]), uColor = { value: team }
    const flat = (color: THREE.Color, alpha: number, px: number) => new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FLAT, defines: { OUTLINE: '' },
      uniforms: { uColor: { value: color }, uAlpha: { value: alpha }, uPx: { value: px }, uRes },
      side: THREE.DoubleSide, ...over, ...stencil(BODY, THREE.NotEqualStencilFunc, THREE.ReplaceStencilOp), // beide Seiten: gedehnte Dreiecke an der Silhouette kippen
    })
    const mats: [THREE.Material, number][] = [
      // 1: Silhouette und verdeckte Teile ins Stencil (opak einsortiert: nach der Map, vor Agenten → Tiefe = nur Map)
      [new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, ...stencil(BODY, THREE.AlwaysStencilFunc, THREE.ReplaceStencilOp) }), MASK_ORDER],
      [new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthFunc: THREE.GreaterDepth, ...stencil(HIDDEN, THREE.AlwaysStencilFunc, THREE.ReplaceStencilOp) }), HIDDEN_ORDER],
      // 2: Füllung nur auf verdeckten Teilen (Bit danach löschen: einmal je Pixel), Kern und Saum nur außerhalb aller Silhouetten
      [new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FILL, uniforms: { uColor }, ...over, ...stencil(HIDDEN, THREE.EqualStencilFunc, THREE.ZeroStencilOp) }), FILL_ORDER],
      [flat(team.clone().lerp(new THREE.Color(1, 1, 1), 0.55), 1, UMRISS_PX), CORE_ORDER],
      [flat(team, 0.4, SAUM_PX), HALO_ORDER],
    ]
    this.dmat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: DAMAGE,
      uniforms: { uColor: { value: new THREE.Color().setRGB(220 / 255, 0, 0, THREE.SRGBColorSpace) }, uTop: { value: 0 }, uAlpha: { value: 0 } },
      side: THREE.DoubleSide, ...over, ...stencil(DMG, THREE.NotEqualStencilFunc, THREE.ReplaceStencilOp),
    })
    for (const s of this.src) {
      for (const [m, order] of mats) this.xray.push(twin(s, m, order))
      this.dm.push(twin(s, this.dmat, DAMAGE_ORDER))
    }
  }

  /** je Bild für sichtbare Agenten: xray an/aus, Schaden bis top (three-Welt-y, −Infinity = aus) mit Deckkraft alpha */
  update(xray: boolean, top: number, alpha: number) {
    const dmg = top > -Infinity && alpha > 0
    if (!xray && !dmg && !this.on) return
    this.on = xray || dmg
    this.dmat.uniforms.uTop.value = top; this.dmat.uniforms.uAlpha.value = alpha
    const per = this.xray.length / Math.max(1, this.src.length)
    for (let i = 0; i < this.src.length; i++) {
      const v = this.src[i].visible
      for (let k = 0; k < per; k++) this.xray[i * per + k].visible = xray && v
      this.dm[i].visible = dmg && v
    }
  }
}

function twin(s: THREE.SkinnedMesh, mat: THREE.Material, order: number) {
  const t = new THREE.SkinnedMesh(s.geometry, mat)
  t.bind(s.skeleton, s.bindMatrix); t.bindMode = s.bindMode
  t.position.copy(s.position); t.quaternion.copy(s.quaternion); t.scale.copy(s.scale)
  t.frustumCulled = s.frustumCulled; t.boundingSphere = s.boundingSphere // feste Kugel um das Becken (agents.ts CULL)
  t.renderOrder = order; t.layers.set(1)
  s.parent!.add(t)
  return t
}

/** Sekunden seit dem jüngsten Treffer (player_hurt mit HP-Schaden, Opfer p) bis tick; −1 = keiner in den letzten DAMAGE_S */
export function hitAge(d: CS3D, p: number, tick: number) {
  const E = d.evt, rate = d.header.tickrate
  for (let i = upperBound(E.tick, tick) - 1; i >= 0 && E.tick[i] > tick - DAMAGE_S * rate; i--)
    if (E.type[i] === EV.player_hurt && E.player[i] === p && (E.arg[i] & 255) > 0) return (tick - E.tick[i]) / rate
  return -1
}
/** Deckkraft des Schadens-Rots age s nach dem Treffer: blinkt (Periode BLINK_S, voll beim Treffer), am Ende ausgeblendet */
export const damagePulse = (age: number) =>
  age < 0 || age >= DAMAGE_S ? 0 : 0.9 * (0.55 + 0.45 * Math.cos((2 * Math.PI * age) / BLINK_S)) * Math.min(1, (DAMAGE_S - age) / FADE_S)
