// Texturen schnell und speicherarm laden (Perf-Spike perf/load):
//  - Map-Texturen aus EINEM gestreamten tex.pack statt 630 Einzel-Requests (cs3d:// kostet ~1.6 ms je Request: 630 Dateien 0.8–1.1 s,
//    ein Pack 0.18–0.28 s, gemessen netbench). Format: [u32 n][u32 len × n][Dateien in json.images-Reihenfolge], erzeugt vom
//    Protokoll-Handler aus tex/ (kein neues Asset-Format).
//  - jede Textur sofort nach dem Eintreffen auf die GPU und die CPU-Kopie weg (statt alle bis uploadAndFree zu halten:
//    Renderer-Peak 1.6 GB). Farbraum/Anisotropie müssen dafür VOR dem Hochladen stehen → aus dem glTF-JSON vorab bestimmt.
import * as THREE from 'three'
import type { GLTFLoaderPlugin, GLTFParser } from 'three/addons/loaders/GLTFLoader.js'
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'

const CSDA = 'CSDA_materials_cs2'

/**
 * Textur-Index → sRGB / Anisotropie, wie GLTFLoader.assignTexture + loadMap sie später setzen würden. Rückgabe false = nicht früh
 * hochladen: GLTFLoader klont die Textur noch (Bild von mehreren Texturen genutzt, texCoord > 0, KHR_texture_transform), ein Klon
 * lädt aus den schon freigegebenen Daten neu (schwarz). Die übernimmt uploadAndFree am Ende.
 */
export function plan(json: any, anisotropy: number) {
  const srgb = new Set<number>(), aniso = new Set<number>(), late = new Set<number>()
  const walk = (o: any) => { // textureInfo irgendwo im Material: { index, texCoord?, extensions? }
    if (!o || typeof o !== 'object') return
    if (typeof o.index === 'number' && (o.texCoord > 0 || o.extensions?.KHR_texture_transform)) late.add(o.index)
    for (const v of Object.values(o)) walk(v)
  }
  for (const m of json.materials ?? []) {
    const base = m.pbrMetallicRoughness?.baseColorTexture?.index
    if (base !== undefined) { srgb.add(base); aniso.add(base) }
    for (const i of [m.emissiveTexture?.index, m.extensions?.[CSDA]?.layer2Texture?.index]) if (i !== undefined) srgb.add(i)
    walk(m)
  }
  const users = new Map<number, number[]>() // Bild → Texturen
  ;(json.textures ?? []).forEach((t: any, i: number) => {
    for (const s of new Set([t.source, ...Object.values(t.extensions ?? {}).map((e: any) => e?.source)])) if (s !== undefined) users.set(s, [...(users.get(s) ?? []), i])
  })
  for (const ts of users.values()) if (ts.length > 1) for (const i of ts) late.add(i)
  return (t: THREE.Texture, i: number) => {
    if (srgb.has(i)) t.colorSpace = THREE.SRGBColorSpace
    if (aniso.has(i)) t.anisotropy = anisotropy
    return !late.has(i)
  }
}

/** hochladen und CPU-Kopie freigeben (Daten werden nie wieder gebraucht, siehe uploadAndFree) */
export function uploadNow(renderer: THREE.WebGLRenderer, t: THREE.Texture) {
  renderer.initTexture(t)
  if (typeof ImageBitmap !== 'undefined' && t.image instanceof ImageBitmap) t.image.close()
  if ((t as THREE.CompressedTexture).isCompressedTexture) (t as THREE.CompressedTexture).mipmaps = []
}

/** GLTFLoader-Plugin für GLBs (Agenten, Waffen): jede Textur hochladen, sobald sie da ist */
export function uploadPlugin(renderer: THREE.WebGLRenderer) {
  return (parser: GLTFParser): GLTFLoaderPlugin => {
    const apply = plan(parser.json, 1), load = parser.loadTextureImage.bind(parser)
    parser.loadTextureImage = (i: number, src: number, loader: any) => load(i, src, loader).then(t => { if (t && apply(t, i)) uploadNow(renderer, t); return t })
    return { name: 'csda_upload' }
  }
}

/** Liest tex.pack gestreamt; get(i) = Bytes von json.images[i] als eigener ArrayBuffer (für KTX2Loader.parse) */
export class TexPack {
  private readonly waits = new Map<number, (b: ArrayBuffer) => void>()
  private readonly ready = new Map<number, ArrayBuffer>()
  private failed: Error | null = null
  private readonly fails: ((e: Error) => void)[] = []

  constructor(url: string) {
    this.read(url).catch(e => { this.failed = e; for (const f of this.fails) f(e) })
  }
  get(i: number): Promise<ArrayBuffer> {
    const b = this.ready.get(i)
    if (b) { this.ready.delete(i); return Promise.resolve(b) } // nur einmal abholen: danach hält nur noch die Textur die Daten
    if (this.failed) return Promise.reject(this.failed)
    return new Promise((res, rej) => { this.waits.set(i, res); this.fails.push(rej) })
  }
  private async read(url: string) {
    const r = await fetch(url)
    if (!r.ok || !r.body) throw new Error(`Could not load ${url} (${r.status})`)
    const rd = r.body.getReader()
    let head = new Uint8Array(0), lens: Uint32Array | null = null
    let i = 0, cur: Uint8Array<ArrayBuffer> | null = null, at = 0
    const finish = () => {
      const b = cur!.buffer, w = this.waits.get(i)
      if (w) { this.waits.delete(i); w(b) } else this.ready.set(i, b)
      i++; cur = null; at = 0
    }
    for (;;) {
      const { done, value } = await rd.read()
      if (done) break
      let v: Uint8Array = value
      if (!lens) { // Kopf sammeln: [n][len × n]
        const h = new Uint8Array(head.length + v.length); h.set(head); h.set(v, head.length); head = h
        if (head.length < 4) continue
        const n = new DataView(head.buffer).getUint32(0, true)
        if (head.length < 4 + 4 * n) continue
        lens = new Uint32Array(head.slice(4, 4 + 4 * n).buffer)
        v = head.subarray(4 + 4 * n); head = new Uint8Array(0)
      }
      while (v.length && i < lens.length) {
        cur ??= new Uint8Array(lens[i])
        const k = Math.min(v.length, cur.length - at)
        cur.set(v.subarray(0, k), at); at += k; v = v.subarray(k)
        if (at === cur.length) finish()
      }
      while (i < lens.length && lens[i] === 0) { cur = new Uint8Array(0); finish() }
    }
    if (!lens || i < lens.length) throw new Error(`${url} is incomplete (${i}/${lens?.length ?? '?'} images)`)
  }
}

/**
 * Plugins für die Map: ersetzen die eingebauten KHR_texture_basisu/EXT_texture_webp (gleicher Name überschreibt) und holen die
 * Bilder aus dem Pack; Sampler/flipY setzt weiter parser.loadTextureImage, danach sofort hochladen.
 */
export function packPlugins(pack: TexPack, ktx2: KTX2Loader, renderer: THREE.WebGLRenderer, anisotropy: number) {
  const make = (name: string, bitmap: boolean) => (parser: GLTFParser): GLTFLoaderPlugin => {
    const json = parser.json, apply = plan(json, anisotropy)
    const opts = { ...((parser as any).textureLoader?.options ?? { premultiplyAlpha: 'none' }), colorSpaceConversion: 'none' }
    const byUrl = new Map<string, number>(json.images.map((im: any, i: number) => [im.uri, i]))
    // Ersatz-Loader für loadImageSource: URL → Bildindex → Bytes aus dem Pack
    const loader = {
      isImageBitmapLoader: bitmap,
      load(url: string, onLoad: (x: any) => void, _p: unknown, onError: (e: unknown) => void) {
        const i = byUrl.get(decodeURI(url.slice(url.lastIndexOf('/tex/') + 1)))
        if (i === undefined) return onError(new Error(`image not in pack: ${url}`))
        pack.get(i).then(b => bitmap
          ? createImageBitmap(new Blob([b], { type: json.images[i].mimeType }), opts as ImageBitmapOptions)
          : new Promise((res, rej) => ktx2.parse(b, res, rej))).then(onLoad, onError)
      },
    }
    return {
      name,
      loadTexture(ti: number) {
        const ext = json.textures[ti].extensions?.[name]
        if (!ext) return null
        return parser.loadTextureImage(ti, ext.source, loader as any).then(t => { if (t && apply(t, ti)) uploadNow(renderer, t); return t })
      },
    } as GLTFLoaderPlugin
  }
  return [make('KHR_texture_basisu', false), make('EXT_texture_webp', true)]
}
