// glTF-Erweiterung "CSDA_materials_cs2": CS2-Materialdaten, die glTF nicht kennt (Laufzeit: prepareCS2Map in der Engine).
//   layer2Texture   (sRGB)   zweite Albedo-Ebene für 2-Layer-Blend (csgo_lightmappedgeneric F_LAYERS=1)
//   blendModTexture (linear) Blend-Modulation (G-Kanal), Kantenschärfe über "blendSoftness"
//   tintMaskTexture (linear) Tint-Maske (R-Kanal): Farbe = albedo * mix(1, baseColorFactor, mask)
//   layer3Texture (sRGB), height1..3Texture (linear, R Höhe, G Tint-Maske), blend = CSDABlend (shared/assets3d.ts): Mehr-Layer-Blend
//   flags: "overlay" | "additive" | "blend" | "unlit" | "fresnel:<exp>" | "water" | "glass" | "mod2x" | "anim:<Zellen>:<fps>"
//   water           CSDAWater (shared/assets3d.ts) für Wasser/Glas, normalTexture darin als glTF-Texturverweis
// Texturen hängen als echte glTF-Texturen an, damit prune/dedup/textureCompress sie mitverarbeiten.
import {
  Extension, ExtensionProperty, PropertyType, TextureChannel, TextureInfo,
  type IProperty, type Nullable, type ReaderContext, type Texture, type WriterContext,
} from '@gltf-transform/core'
import type { CSDABlend, CSDAWater } from '../../shared/assets3d.ts'

export const CSDA = 'CSDA_materials_cs2'
const { R, G, B, A } = TextureChannel

/** Textur-Slot → Kanäle (für prune/textureCompress) und ob Farbe (sRGB) */
const SLOTS = {
  layer2BaseColorTexture: { channels: R | G | B, isColor: true }, layer3BaseColorTexture: { channels: R | G | B, isColor: true },
  blendModulationTexture: { channels: R | G | B | A }, tintMaskTexture: { channels: R }, waterNormalTexture: { channels: R | G | B },
  height1Texture: { channels: R | G }, height2Texture: { channels: R | G }, height3Texture: { channels: R | G },
} as const
type TexKey = keyof typeof SLOTS
type Water = Omit<CSDAWater, 'normalTexture'>
type Blend = Omit<CSDABlend, never> // abgebildeter Typ: gltf-transform nimmt nur Literal-artige Werte
type ICS2Material = IProperty & { [K in TexKey]: Texture } & { [K in TexKey as `${K}Info`]: TextureInfo } & {
  blendSoftness: number; flags: string[]; water: Water | null; blend: Blend | null
}

export class CS2Material extends ExtensionProperty<ICS2Material> {
  static EXTENSION_NAME = CSDA
  declare extensionName: typeof CSDA
  declare propertyType: 'CS2Material'
  declare parentTypes: [PropertyType.MATERIAL]
  protected init() {
    this.extensionName = CSDA
    this.propertyType = 'CS2Material'
    this.parentTypes = [PropertyType.MATERIAL]
  }
  protected getDefaults(): Nullable<ICS2Material> {
    const tex = Object.fromEntries(Object.keys(SLOTS).flatMap(k => [[k, null], [k + 'Info', new TextureInfo(this.graph, k + 'Info')]]))
    return Object.assign(super.getDefaults() as IProperty, tex, { blendSoftness: 0.1, flags: [], water: null, blend: null }) as unknown as Nullable<ICS2Material>
  }
  getLayer2() { return this.getRef('layer2BaseColorTexture') }
  setLayer2(t: Texture | null) { return this.setTex('layer2BaseColorTexture', t) }
  getBlendMod() { return this.getRef('blendModulationTexture') }
  setBlendMod(t: Texture | null) { return this.setTex('blendModulationTexture', t) }
  getTintMask() { return this.getRef('tintMaskTexture') }
  setTintMask(t: Texture | null) { return this.setTex('tintMaskTexture', t) }
  getBlend() { return this.get('blend') }
  setBlend(v: CSDABlend | null) { return this.set('blend', v as Blend | null) }
  getBlendSoftness() { return this.get('blendSoftness') }
  setBlendSoftness(v: number) { return this.set('blendSoftness', v) }
  getFlags() { return this.get('flags') }
  setFlags(v: string[]) { return this.set('flags', v) }
  getWater() { return this.get('water') }
  setWater(v: Water | null) { return this.set('water', v) }
  getWaterNormal() { return this.getRef('waterNormalTexture') }
  setWaterNormal(t: Texture | null) { return this.setTex('waterNormalTexture', t) }
  getTex(k: TexKey) { return this.getRef(k) as Texture | null }
  getInfo(k: TexKey) { return this.getRef(`${k}Info` as `${TexKey}Info`) as TextureInfo }
  setTex(k: TexKey, t: Texture | null) { return this.setRef(k, t as any, SLOTS[k]) }
}

/** JSON-Schlüssel der Extension → Slot */
const INFO = {
  layer2Texture: 'layer2BaseColorTexture', layer3Texture: 'layer3BaseColorTexture', blendModTexture: 'blendModulationTexture', tintMaskTexture: 'tintMaskTexture',
  height1Texture: 'height1Texture', height2Texture: 'height2Texture', height3Texture: 'height3Texture',
} as const

export class CSDAMaterialsCS2 extends Extension {
  static EXTENSION_NAME = CSDA
  extensionName = CSDA
  prereadTypes = [PropertyType.MESH]
  prewriteTypes = [PropertyType.MESH]
  create() { return new CS2Material(this.document.getGraph()) }
  read() { return this }
  write() { return this }
  preread(context: ReaderContext) {
    const json = context.jsonDoc.json
    json.materials?.forEach((md, i) => {
      const d = md.extensions?.[CSDA] as any
      if (!d) return
      const p = this.create()
      context.materials[i].setExtension(CSDA, p)
      if (d.blendSoftness !== undefined) p.setBlendSoftness(d.blendSoftness)
      if (d.flags) p.setFlags(d.flags)
      if (d.blend) p.setBlend(d.blend)
      if (d.water) {
        const { normalTexture, ...w } = d.water
        p.setWater(w)
        if (normalTexture) { p.setWaterNormal(context.textures[json.textures![normalTexture.index].source!]); context.setTextureInfo(p.getInfo('waterNormalTexture')!, normalTexture) }
      }
      for (const [key, ref] of Object.entries(INFO)) {
        const def = d[key]
        if (!def) continue
        p.setTex(ref, context.textures[json.textures![def.index].source!])
        context.setTextureInfo(p.getInfo(ref)!, def)
      }
    })
    return this
  }
  prewrite(context: WriterContext) {
    const json = context.jsonDoc.json
    for (const mat of this.document.getRoot().listMaterials()) {
      const p = mat.getExtension<CS2Material>(CSDA)
      if (!p) continue
      const md = json.materials![context.materialIndexMap.get(mat)!]
      const d: any = context.createPropertyDef(p)
      if (p.getFlags().length) d.flags = p.getFlags()
      for (const [key, ref] of Object.entries(INFO)) {
        const t = p.getTex(ref)
        if (t) d[key] = context.createTextureInfoDef(t, p.getInfo(ref)!)
      }
      if (p.getBlendMod()) d.blendSoftness = p.getBlendSoftness()
      if (p.getBlend()) d.blend = p.getBlend()
      const w = p.getWater(), wn = p.getWaterNormal()
      if (w) d.water = { ...w, ...wn && { normalTexture: context.createTextureInfoDef(wn, p.getInfo('waterNormalTexture')!) } }
      md.extensions = md.extensions || {}
      md.extensions[CSDA] = d
    }
    return this
  }
}
