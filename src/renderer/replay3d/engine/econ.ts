// Aufkleber und Anhänger an Waffen (Daten: Skin3D.stickers/charm aus main/econ.ts, Assets: EconAssets aus main/assets3d/econ.ts).
// Aufkleber wie csgo_weapon.vfx F_STICKERS im Waffen-Material (kein Extra-Draw-Call): Sticker-Raum uv2 = affine Seitenprojektion der
// Position (Ebenen je Modell), q = Drehung((uv2 − 0,5 − Versatz) · Skala) + 0,5, Deckung = Alpha · 12,75 · Maske, Wear über Kratzer-Textur,
// Kavität und Papier-Rücken (Formeln aus der Shader-VPK, nachgebaut). Ein Programm für alle Waffen mit Aufklebern (Anzahl als Uniform).
// shortcut: Holo/Glitter/Folie, Normal-/Rauheits-Textur und PBR-Farbanpassung der Aufkleber fehlen (flach wie Papier); bei Bedarf aus dem Aufkleber-vmat
// Anhänger: GLB an x/y/z (Bone weapon_offset, Zoll), hängt senkrecht (nur Gierung der Waffe), starr.
import * as THREE from 'three'
import type { EconAssets, StickerSpace } from '../../../shared/assets3d'
import type { Charm3D, Sticker3D } from '../../../shared/cs3d'

export const MAX_STICKERS = 5
/** Aufkleber eines Items: Array (n × 256²) + je Aufkleber p0 = (Versatz x, y, Skala, Drehung in Umdrehungen), p1 = (Wear, Wear-Bias x, y, ±Kratzer; + = Papier) */
export interface StickerSet { tex: THREE.Texture; n: number; p0: THREE.Vector4[]; p1: THREE.Vector4[]; mask: THREE.Texture; scr: THREE.Texture; space: StickerSpace }
/** Anhänger eines Items: Vorlage (geteilt) + Ort im glTF-Wurzelraum der Waffe (m) */
export interface CharmSet { tpl: THREE.Object3D; pos: THREE.Vector3 }

/** Platz eines Aufklebers: mit eigenem Versatz/Schema relativ zu StickerMarkup[schema], sonst StickerMarkup[slot]; Drehung Grad → Umdrehungen */
export function stickerParams(x: Sticker3D, space: StickerSpace, wb: [number, number], ws: number, paper: boolean): [THREE.Vector4, THREE.Vector4] {
  const free = x.x !== undefined || x.y !== undefined || x.schema !== undefined
  const m = space.slots[free ? x.schema ?? x.slot : x.slot] ?? space.slots[0]
  // shortcut: Attribut scale ohne Beispiel in den Demos → als Faktor auf die Größe gedeutet
  return [new THREE.Vector4(m.x + (x.x ?? 0), m.y + (x.y ?? 0), m.scale / (x.scale || 1), m.rot + (x.rot ?? 0) / 360), new THREE.Vector4(x.wear ?? 0, wb[0], wb[1], paper ? ws : -ws)]
}

/** Charm-Ort: Bone weapon_offset (Source-Zoll, am Modell = Modellraum) → glTF-Wurzelraum (m): (y, z, x) · 0,0254 (am AK-Markup geprüft) */
export const charmPos = (c: Charm3D) => (c.x === undefined || c.y === undefined || c.z === undefined ? null : new THREE.Vector3(c.y, c.z, c.x).multiplyScalar(0.0254))

/** Kopie in eine Array-Schicht ohne Vormultiplizieren (Aufkleber-Alpha ist codiert: 0..20/255 = Deckung, darüber Wear-Reihenfolge) */
export const COPY = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3, uniforms: { tSrc: { value: null } },
  vertexShader: 'in vec3 position; in vec2 uv; out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0 - 1.0, 0.0, 1.0); }',
  fragmentShader: 'precision highp float; uniform sampler2D tSrc; in vec2 vUv; out vec4 o; void main() { o = texture(tSrc, vUv); }',
})

const PARS_V = /* glsl */ `
uniform vec4 csdaStU, csdaStV; uniform vec3 csdaStS; varying vec3 vCsdaSt;`
const MAIN_V = /* glsl */ `
vCsdaSt = vec3( dot( csdaStU, vec4( position, 1.0 ) ), dot( csdaStV, vec4( position, 1.0 ) ), dot( normal, csdaStS ) );`
const PARS_F = /* glsl */ `
uniform highp sampler2DArray csdaStTex; uniform sampler2D csdaStMask, csdaStScr; uniform int csdaStN;
uniform vec4 csdaStP0[ ${MAX_STICKERS} ], csdaStP1[ ${MAX_STICKERS} ]; varying vec3 vCsdaSt;`
const MAIN_F = /* glsl */ `
#ifdef USE_MAP
{
  vec2 mk = texture2D( csdaStMask, vMapUv ).rg; // r = erlaubt, g = Kavität
  if ( mk.r > 0.0 && vCsdaSt.z > 0.0 ) for ( int i = 0; i < ${MAX_STICKERS}; i ++ ) {
    if ( i >= csdaStN ) break;
    vec4 p0 = csdaStP0[ i ], p1 = csdaStP1[ i ];
    vec2 q = ( vCsdaSt.xy - 0.5 - p0.xy ) * p0.z;
    float an = p0.w * 6.2831853, c = cos( an ), s = sin( an );
    q = vec2( q.x * c - q.y * s, q.x * s + q.y * c ) + 0.5;
    if ( q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0 ) continue;
    vec4 t = texture( csdaStTex, vec3( q, float( i ) ) );
    float al = clamp( t.a * 12.75, 0.0, 1.0 ) * mk.r, rough = 0.6;
    vec3 col = sRGBTransferEOTF( vec4( t.rgb, 1.0 ) ).rgb;
    if ( p1.x > 0.0 ) {
      bool paper = p1.w > 0.0;
      float w0 = p1.x, sc = 1.0 - min( abs( p1.w ), texture2D( csdaStScr, q ).r ), s2 = mix( sc, sc * 0.5, w0 );
      float w = clamp( mix( w0, w0 + 2.0 * ( mk.g - 0.5 ) * smoothstep( 1.0, 0.85, w0 ), w0 ), 0.0, 1.0 );
      float b = paper ? 0.5 : ( p1.z * ( p1.z > 0.0 ? 0.5 : 0.25 ) + 0.5 ) * 0.5;
      float tt = clamp( w - pow( clamp( ( t.a - 0.078431 ) * 1.085106, 0.0, 1.0 ), p1.y * p1.y ), 0.0, 1.0 );
      if ( paper ) { float e = clamp( tt * 2.0, 0.0, 1.0 ) + p1.z * w; col = mix( vec3( mix( 0.7, 0.2 + 0.4 * s2, w ) ), col, smoothstep( e, e + 0.1, s2 ) ); }
      float t2 = clamp( tt * ( 1.0 + b ) - b, 0.0, 1.0 );
      col = mix( col, col * s2, w * 0.3 );
      al *= smoothstep( t2, t2 + 0.1, s2 );
      rough = mix( rough, 0.8, step( s2, smoothstep( 0.0, 0.35, w ) ) );
    }
    diffuseColor.rgb = mix( diffuseColor.rgb, col, al );
    metalnessFactor = mix( metalnessFactor, 0.0, al );
    roughnessFactor = mix( roughnessFactor, rough, al );
  }
}
#endif`

/**
 * Aufkleber auf ein Waffen-Material legen (nach Agenten-Patch und applyFinish, einmal je Material). toRoot = lokale Mesh-Ecke → glTF-Wurzelraum
 * in Ruhelage (SkinSlot), daraus die Ebenen im lokalen Raum (position/normal vor dem Skinning). Programm-Schlüssel + '-st' → ein Programm
 */
export function applyStickers(mat: THREE.Material, st: StickerSet, toRoot: THREE.Matrix4) {
  const e = toRoot.elements, row = (a: number[]) => new THREE.Vector4(
    a[0] * e[0] + a[1] * e[1] + a[2] * e[2] + a[3] * e[3], a[0] * e[4] + a[1] * e[5] + a[2] * e[6] + a[3] * e[7],
    a[0] * e[8] + a[1] * e[9] + a[2] * e[10] + a[3] * e[11], a[0] * e[12] + a[1] * e[13] + a[2] * e[14] + a[3] * e[15])
  const s = st.space.s, side = row([s[0], s[1], s[2], 0])
  const u = {
    csdaStU: { value: row(st.space.u) }, csdaStV: { value: row(st.space.v) }, csdaStS: { value: new THREE.Vector3(side.x, side.y, side.z) },
    csdaStTex: { value: st.tex }, csdaStMask: { value: st.mask }, csdaStScr: { value: st.scr }, csdaStN: { value: st.n }, csdaStP0: { value: st.p0 }, csdaStP1: { value: st.p1 },
  }
  const key = mat.customProgramCacheKey.bind(mat), before = mat.onBeforeCompile.bind(mat)
  mat.customProgramCacheKey = () => `${key()}-st`
  mat.onBeforeCompile = (sh, r) => {
    before(sh, r)
    Object.assign(sh.uniforms, u)
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${PARS_V}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${MAIN_V}`)
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${PARS_F}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${MAIN_F}`)
  }
}

const _q = new THREE.Quaternion(), _w = new THREE.Quaternion(), _v = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0)
/**
 * Anhänger an den Träger hängen (Wurzel der Waffe bzw. Bone weapon_offset): anchor.matrix = (Träger in Ruhelage relativ zur Wurzel)⁻¹ · T(pos).
 * Vor dem Zeichnen hängt er senkrecht (Welt +y = oben), Gierung = Lauf der Waffe (glTF +z)
 */
export function hangCharm(carrier: THREE.Object3D, carrierToRoot: THREE.Matrix4, c: CharmSet): THREE.Object3D {
  const anchor = new THREE.Group(), hang = c.tpl.clone()
  anchor.matrixAutoUpdate = false
  anchor.matrix.copy(carrierToRoot).invert().multiply(new THREE.Matrix4().makeTranslation(c.pos))
  anchor.add(hang); carrier.add(anchor)
  let first: THREE.Object3D | null = null
  hang.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.frustumCulled = false; first ??= o } })
  if (first) (first as THREE.Object3D).onBeforeRender = () => {
    anchor.getWorldQuaternion(_q)
    _v.set(0, 0, 1).applyQuaternion(_q)
    _w.setFromAxisAngle(UP, Math.atan2(_v.x, _v.z))
    hang.quaternion.copy(_q.invert()).multiply(_w)
    hang.updateMatrixWorld(true)
  }
  return anchor
}

/** Anhänger-Vorlage (geteilt): Texturen sRGB wie im GLB, Schatten wie die Waffe */
export function charmTemplate(scene: THREE.Object3D) {
  scene.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true })
  return scene
}

export type { EconAssets }
