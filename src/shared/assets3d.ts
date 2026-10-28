// Asset-Pipeline des 3D-Replays: alles stammt aus der lokalen CS2-Installation (nichts wird mitgeliefert) und wird
// einmal pro Rechner, CS2-Patch und Map nach <userData>/assets3d/<patch>/ gebaut (src/main/assets3d, utilityProcess, VRF --threads 1).
// CS2 finden: HKCU\Software\Valve\Steam SteamPath + steamapps\libraryfolders.vdf → …\game\csgo; patch = steam.inf ClientVersion.
// Source2Viewer-CLI (VRF 20.1): bei Bedarf von GitHub laden (cli-windows-x64.zip, 52.8 MB, SHA-256 geprüft) nach <userData>/tools/vrf/.
//
// Renderer lädt alles per cs3d://assets3d/<patch>/<pfad> (rel = host + pathname = Pfad unter <userData>; fester Host 'assets3d',
// weil der Browser den Host klein schreibt und reine Zahlen als IPv4 deutet). Handler + IPC: src/main/assets3d/index.ts
// (handleCs3d: 403 außerhalb von assets3d, prepareForMatch mit Schlange + Hintergrund-Vorbereitung). Schema-Privilegien inkl. corsEnabled, sonst scheitert fetch.
// Ablage (<pfad>):
//   maps/<map>/<profile>/<map>.gltf + .bin + tex/<i>.ktx2|webp | <map>_lm.webp | <map>_sky.webp | floor.bin | probes.bin | map.json
//   agents/clips_min2.glb + clips_meta2.json (CLIP_LIST + CLIP_LIST2), agents/<ordner>/<modell>.glb (z. B. agents/ctm_sas/ctm_sas.glb)
//   arms/<ordner>/<modell>.glb                            Ego-Arme je Agent
//   weapons/<vmdl-name>.glb                               (z. B. weapons/weapon_rif_ak47.glb)
//   viewmodel/<vmdl-name>.glb, vm_<variation>.glb|.json, table3.json  Ego-Waffen mit Skelett, Clips + Dauer, Clip-Tabelle
//   world/<klasse>.glb|.json, world/table.json            Oberkörper-Aktionsclips der Spielermodelle je Waffe (WeaponAsset.world)
//   weapons|viewmodel/<vmdl-name>.legacy.glb              Mesh body_legacy (nur Modelle mit hd + legacy, wenn ein Legacy-Skin vorkommt)
//   gloves/<modell>.glb                                   Handschuhe mit Skelett, Meshes viewmodel + worldmodel
//   skins/kits/<paint>.json, skins/inputs/<vmat>.json, skins/models.json, skins/tex/<VRF-Pfad>.webp|.exr  Skin-Eingaben
//   sounds/<datei>.wav|.mp3, sounds/sounds2.json         (WAV PCM16 mono bzw. MP3 wie im Spiel, Name mit Endung in SoundDef.files)
// Cache: Ordner gilt, solange PIPELINE_VERSION und VRF-Version gleich sind (neuer CS2-Patch: alter Ordner wird umbenannt),
// Map solange die Map-VPK gleich ist, items.json solange pak01_dir.vpk (Größe+mtime) gleich ist; sonst neu bauen.

import type { CS3DHeader } from './cs3d.ts'

export const PIPELINE_VERSION = 1
export const assetUrl = (rel: string) => `cs3d://${rel}`

/**
 * high: native CS2-Farbe 2048 / Normalen 1024 / Lightmap 4096 (Dust2: 0.65 GB Textur-VRAM), low: 1024 / 512 / 2048.
 * Die App baut nur noch 'high' (worker.ts): Low quality ist eine Render-Option ohne eigene Assets (sofort umschaltbar).
 */
export type AssetProfile = 'high' | 'low'
export interface PrepareProgress {
  stage: 'locate' | 'vrf' | 'map' | 'agents' | 'weapons' | 'skins' | 'sounds' | 'done'
  /** 0..100 über alles */
  pct: number
  /** englischer UI-Text */
  msg: string
}

/**
 * Werte aus map.json (main/assets3d/map.ts mapSettings: Entities + .vpost der Map). Neuere Felder sind optional, alte map.json bleiben gültig.
 * Distanzen/Höhen in glTF-Metern (Höhe = Source-z · 0,0254 = three-y), Farben linear. Nebel, Himmel und Bloom laufen wie in CS2 vor bzw. in
 * derselben Post-Kette wie die Szene (licht-shader Befunde 8, 11, 12).
 */
export interface MapSettings {
  sun: { toSunGltf: [number, number, number]; colorSRGB: [number, number, number]; threeIntensity: number }
  lightmap: { range: number; threeIntensity: number }
  /**
   * CS2 tonemappt mit der Hable-Kurve der .vpost (CToneMappingLayer) und hartem Clamp am Weißpunkt, nicht wie three Neutral
   * (licht-shader Befund 9). 'Hable' + curve ab MAP_VERSION 4; 'Neutral' (Belichtung expo/W · 1,25) steht nur in alten map.json,
   * 'Linear' = Rückfall ohne .vpost.
   */
  toneMapping: {
    type: 'Neutral' | 'Linear' | 'Hable'
    /** Belichtung k; bei Hable k = 1,26 · (minexposure + maxexposure) / 2 der post_processing_volume, ohne enableexposure 1,26 (empirisch, Ladebilder) */
    exposure: number
    /**
     * Hable-Kurve je Kanal (wie licht-vergleich/tools/wt/light-page.ts), c = lineare Szenenfarbe, danach sRGB:
     *   out = clamp(H(k·c) / H(W), 0, 1),  k = exposure, W = whitePoint
     *   H(x) = (x·(A·x + C·B) + D·E) / (x·(A·x + B) + D·F) − E/F
     *   A = shoulder, B = linearStrength, C = linearAngle, D = toeStrength, E = toeNum, F = toeDenom
     * Dust2/Mirage: A 0, B = C ≈ 0,001, D = E = F = 1, W 1,65 bzw. 1,5 → fast c·k/W; Inferno/Ancient/Anubis: A 0,15, B 0,5, C 0,1, D 0,2, E 0,02, F 0,3, W 4.
     */
    curve?: { toeStrength: number; toeNum: number; toeDenom: number; shoulder: number; linearStrength: number; linearAngle: number; whitePoint: number }
  }
  /** yawDeg = env_sky angles[1] (Grad, Drehung um Source-z = three-y), fehlt → 0. Renderer: backgroundRotation.y = (yawDeg + 90)·π/180 (an Ladebildern bestätigt) */
  sky: { backgroundIntensity: number; yawDeg?: number }
  /**
   * env_cubemap_fog: Menge = saturate(pow(Distanz-Rampe, exponent)) · saturate(pow(Höhen-Rampe, heightExponent)) · maxOpacity, erst ab startM;
   * Farbe = Himmel in Blickrichtung, Mip-LOD aus lodBias. Höhenwerte fehlen → ohne Höhenterm.
   */
  fog?: { startM: number; endM: number; maxOpacity: number; exponent: number; heightStartM?: number; heightEndM?: number; heightExponent?: number; lodBias?: number }
  /**
   * env_gradient_fog (7 von 9 Maps): f = Rampe 0..1 zwischen start und end (Distanz bzw. Höhe; Belegung der Höhenterme gefolgert:
   * unten dichter), Menge = pow(f.dist, exponent) · pow(f.höhe, heightExponent) · maxOpacity, Farbe colorLinear. Fehlt → kein Gradient-Nebel.
   */
  gradientFog?: { startM: number; endM: number; exponent: number; maxOpacity: number; heightStartM: number; heightEndM: number; heightExponent: number; colorLinear: [number, number, number] }
  /**
   * .vpost CBloomLayer, nur High. mode 'screen' (fehlt = screen, alte map.json: strength = m_flScreenBloomStrength):
   * s = saturate(1,035 · b / (b + 0,187)) · strength, out = c + s − c·s im sRGB-Raum; 'add': mix(c, b, strength) vor dem Tonemapping
   * (CS2: c·(1−s₁) + b·s₂·E + b·s₃ mit unbekannten CPU-Werten; mix passt auf Ancient besser als c + b·s).
   * width = m_flBloomThresholdWidth, threshold = m_flBloomThreshold.
   */
  bloom?: { strength: number; threshold: number; width?: number; mode?: 'screen' | 'add' }
  /** ab MAP_VERSION 6: stationäre Lichter (directlight 3); dls = Datei neben der Lightmap (RGB = Sichtbarkeit Kanal 0..2) */
  stationary?: { dls: string; lights: StationaryLight[] }
  /** ab MAP_VERSION 6: post_processing_volume min/maxexposure (sortiert; Nuke hat min > max), fehlt ohne enableexposure → Auto-Belichtung relativ zu k₀ (engine/post.ts) */
  exposureRange?: [number, number]
}

/**
 * stationäres Licht (MapSettings.stationary.lights, Renderer engine/lighting.ts). Barn-Form aus den Entity-Werten gefolgert (CPU-Code von CS2 unbekannt):
 * Querschnitt in Tiefe t (entlang fwd) = Rechteck/Ellipse mit halber Größe size/2 + spread·t um shear·t (links/oben), Ränder weich (soft).
 * spread 0 = paralleles Fensterlicht (Nuke-Hallenfenster: size 15 × 1,5 m, shear = Sonnenrichtung).
 */
export interface StationaryLight {
  /** DLS-Kanal 0..2 = bakedshadowindex 1..3 (direct_light_shadows G/B/A) */
  ch: number
  /** 0 light_omni2 (Reichweite = Abstand, optional Kegel), 1 light_barn (Reichweite = Tiefe entlang fwd), 2 light_rect (nur vorn) */
  kind: 0 | 1 | 2
  /** Position (glTF-Meter) und Achsen (glTF, Einheitsvektoren): fwd = Abstrahlrichtung, left/up = Barn-Querschnitt */
  pos: [number, number, number]
  fwd: [number, number, number]
  left: [number, number, number]
  up: [number, number, number]
  /** lineare Farbe × brightness × brightnessscale (CS2-Einheiten wie die Sonne) */
  color: [number, number, number]
  rangeM: number
  /** Barn: Breite/Höhe an der Lampe (m), Aufweitung je Meter Tiefe (size_params.z), Scherung je Meter Tiefe (shear/range), soft_x/y, Ellipse */
  size?: [number, number]; spread?: number; shear?: [number, number]; soft?: [number, number]; ellipse?: boolean
  /** light_omni2: Kegel outer/inner (Grad, halber Öffnungswinkel) */
  cone?: [number, number]
}

export interface MapAssetManifest {
  map: string
  profile: AssetProfile
  /** .gltf mit .bin und Texturdateien; meshopt (GLTFLoader.setMeshoptDecoder); Extension CSDA_materials_cs2, Attribute _PROBE/_BLEND → prepareCS2Map (mapopt/final/three/cs2map.mjs) */
  glb: string
  /**
   * RGBA-WebP: RGB = sRGB(irradiance/4), A = Sonnen-Sichtbarkeit = max(1, 255 − direct_light_shadows.R) ab MAP_VERSION 4 (255 = Sonne frei).
   * Caches bis MAP_VERSION 3 haben A = direct_light_shadows.R (= Schattenstärke, Polarität verkehrt, licht-shader Befund 2).
   * ImageBitmapLoader {premultiplyAlpha:'none', colorSpaceConversion:'none'}, flipY false, channel 1
   */
  lightmap: string
  /** equirect WebP; fehlt → Hintergrundfarbe */
  sky?: string
  /** Himmel als Radiance-.hdr (RGBE, linear, equirect, ohne Clamp) für three HDRLoader; fehlt → sky */
  skyHdr?: string
  /**
   * Farb-LUT der .vpost (CColorLookupColorCorrectionLayer): lut.bin = 32³ × RGB8 ohne Kopf, r schnellste Achse, dann g, dann b
   * (Byte ((b·32 + g)·32 + r)·3). Ein- und Ausgang sRGB, nach dem Tonemapping abtasten bei c·31/32 + 1/64 (Data3DTexture, linear). Fehlt → keine LUT.
   */
  lut?: string
  /**
   * 3D-Skybox: Map-Position = (Skybox-Position − origin) · scale, origin = sky_camera in Source-u; fehlt → nur Himmel. lightmap = ihre gebackene
   * Lightmap (Format wie lightmap, Sonden als _PROBE in der .gltf); fehlt (Cache vor MAP_VERSION 7) → Himmelslicht. ownFog = die Skybox-Welt hat
   * eigene Nebel-Entities: Nebel in Skybox-Abständen (÷ scale), sonst der Map-Nebel in echten Abständen (engine/map.ts patchMaterial)
   */
  skybox?: { glb: string; scale: number; origin: [number, number, number]; lightmap?: string; ownFog?: boolean }
  /** FloorGrid-Datei (Untergrund für Schritte, Lagen für Sonden) */
  floor: string
  /** Agenten-Licht (Critic P0-2), Format bei parseFloorGrid */
  probes: string
  settings: MapSettings
}

/**
 * Wasser/Glas in der Map-.gltf, Vertrag main/assets3d/csda-ext.ts → engine/map.ts: Material-Extension CSDA_materials_cs2 mit
 * flags 'water' (csgo_water_fancy, csgo_water*) bzw. 'glass' (csgo_glass) und optional ext.water = CSDAWater (bei Glas: Fresnel + Farbe).
 * Fehlt ext.water → Fresnel-Exponent 5, Reflectance 0,025. Alte Caches kennen beide Flags nicht (Glas = 'blend', Wasser = opak).
 */
export interface CSDAWater {
  /** g_flFresnelExponent */
  fresnelExp: number
  /** g_flReflectance (Spiegelung bei senkrechtem Blick) */
  reflectance: number
  /** Wasser- bzw. Glasfarbe, linear */
  colorLinear: [number, number, number]
  /** Wasser-Nebel (Tiefenfärbung) bis fogEndM, linear */
  fogColorLinear?: [number, number, number]
  fogEndM?: number
  /** Normal-Map als glTF-Textur (wie layer2Texture der Extension) */
  normalTexture?: { index: number }
  normalScale?: number
  /** Normalen-Verschiebung in UV/s */
  scroll?: [number, number]
}

/**
 * Mehr-Layer-Blend einer Map-Materials (ext.blend, Vertrag csda-ext.ts → engine/map.ts). Vertex-Attribut _BLEND (VEC4, normiert):
 * x = Layer 2, y = Layer 3, w = Weichheit (Vertex-Malerei, Formeln: Reverse-Engineering.md „Map-Blend“).
 * 'mod': csgo_lightmappedgeneric F_LAYERS / csgo_simple_2way_blend, Gewicht = smoothstep(m ± s, x) mit Maske m = dot(Blend-Modulation, ch),
 *        s = soft[0] + soft[1]·Modulation.r + soft[2]·w. 'height': csgo_environment_blend, Höhen-Blend über g_tHeight1..3 (R Höhe, G Tint-Maske).
 */
export interface CSDABlend {
  kind: 'mod' | 'height'
  /** UV-Skala Layer 2 (u, v) und Layer 3 (u, v) relativ zur Basis-UV */
  uv: [number, number, number, number]
  ch?: [number, number, number, number]
  soft?: [number, number, number]
  /** Tint-Maske nur auf Layer 1 (simple_2way_blend: Layer B ungetönt) */
  tintA?: boolean
  /** height: Skala/Nullpunkt der Höhen (s1, z1, s2, z2, s3, z3) */
  h?: [number, number, number, number, number, number]
  /** Ausrichtungs-Maske Layer 2 bzw. 3: [min, max, dx, dy, dz] (smoothstep über dot(Richtung, Normale)·0,5+0,5, Richtung in glTF-Achsen) */
  face2?: [number, number, number, number, number]
  face3?: [number, number, number, number, number]
  /** Farbkorrektur je Layer 1..3 (affin, 3 Zeilen × 4, linear; wirkt mit der Tint-Maske = Höhen-Textur G), null = neutral */
  adj?: (number[] | null)[]
  /** height: Tint-Maske je Layer (Kontrast, Helligkeit) × 3; Modell-Tönung (Colorize mit der Material-/Vertex-Farbe) je Layer 0|1 und Stärke */
  tm?: [number, number, number, number, number, number]; mt?: [number, number, number]; mta?: number
}

/**
 * Himmels-Effekte der 3D-Skybox (ext.fx, Vertrag csda-ext.ts → engine/map.ts; Formeln aus csgo_effects_ps/csgo_unlitgeneric_ps, VRF-SPIR-V):
 * uv = uv0 · uv[0..1] + uv[2..3] · t; Farbe = Basis(uv) [· color2(uv0 · uv2)] · boost; Alpha = Basis.a · opacity · Maske1..3(uv · Skala + Schwenk · t).r
 * [· Fresnel · Abstand]. Ohne Maske (Standardmaske) = 1. Wolken-Kuppeln (Dust2), Wolken-/Dunst-Karten, Sonnenscheiben.
 */
export interface CSDAFx {
  uv: [number, number, number, number]
  uv2?: [number, number]
  boost: number
  opacity: number
  /** je Maske 1..3: Skala u, v, Schwenk u, v (UV/s) */
  masks?: [number, number, number, number][]
  /** g_flFresnelExponent, Falloff, Min, Max: Alpha · mix(Min, Max, saturate(pow(N·V, Exponent) · Falloff)) */
  fresnel?: [number, number, number, number]
  /** g_flFadeDistance (m), Falloff, Min, Max: Alpha · pow(mix(Min, Max, saturate(d / Distanz)), Falloff) */
  fade?: [number, number, number, number]
}

export interface AgentAssets {
  /** EINE Clip-GLB für alle Modelle (86 gemeinsame Kern-Bones, Bindung über Node-Namen); Clip-Name = Blattname, z. B. run_n_rifle */
  clips: string
  clipMeta: Record<string, { dur: number; additive: boolean }>
  /** m_nPawnCharacterDefIndex → Modell-GLB; enthält immer AGENT_DEFAULT.T/CT (cs3d.ts) als Ersatz für unbekannte Defs */
  models: Record<number, string>
  /** wie models: Ego-Arme (Meshes firstperson_default_gloves_arms + firstperson_sleeves, Bones wie das Modell); fehlt → keine Arme */
  arms: Record<number, string>
}

/**
 * Viewmodel-Rollen; light/light2/heavy = Messer (hit/heavy_hit/backstab = Treffer), shoot = auch Granatenwurf (überhand),
 * inspect = lookat01 bzw. Messer-Inspect, pullpin = Pin ziehen (letzter Frame hält bis zum Wurf), shoot_right = Elites rechts.
 */
export type VmRole = 'idle' | 'draw' | 'shoot' | 'shoot_last' | 'idle_empty' | 'reload' | 'reload_empty' | 'light' | 'light2' | 'heavy'
  | 'inspect' | 'pullpin' | 'throw_under' | 'hit' | 'heavy_hit' | 'backstab' | 'shoot_right' | 'silencer_on' | 'silencer_off'

/** Oberkörper-Aktionen der Spielermodelle (worldmodel_*-Untergraphen), _crouch = geduckt */
type WorldBase = 'draw' | 'reload' | 'reload_empty' | 'shoot' | 'pullpin' | 'throw' | 'throw_under' | 'swing' | 'stab' | 'backstab' | 'silencer_on' | 'silencer_off'
export type WorldRole = WorldBase | `${WorldBase}_crouch`

/** Clip-Klasse; Granaten, C4 und Medi-Shot laufen mit knife-Clips, Zeus mit pistol (agents-Spike) */
export type WeaponAnim = 'rifle' | 'pistol' | 'knife'
/**
 * Anhängen (Critic P0-1): g = new Group(); g.quaternion.set(0.5,0.5,0.5,0.5); model.position.set(-root[0],-root[1],-root[2]);
 * g.add(model); bones.wpn.add(g). Ohne root sitzt die Waffe bis 56 cm neben der Hand.
 */
export interface WeaponAsset {
  /** Anzeigename wie v1 (z. B. 'AK-47') */
  name: string
  /** weapon_fire-Klasse (z. B. 'weapon_ak47'), Schlüssel in SoundMap */
  className: string
  anim: WeaponAnim
  /** fehlt → kein Modell */
  glb?: string
  /** Root-Bone 'weapon' im Mesh-Frame, glTF-Meter */
  root: [number, number, number]
  /** Mündung im Root-Frame (= Koordinaten in g), glTF-Meter */
  muzzle?: [number, number, number]
  /** Mündung mit Schalldämpfer (USP-S, M4A1-S) */
  muzzleSilenced?: [number, number, number]
  /** Mesh body_legacy statt body_hd (Skin mit WeaponSkin.legacy); fehlt → glb */
  legacyGlb?: string
  /**
   * Ego-Sicht: glb = dasselbe Modell mit Skelett (Bones weapon/bolt/clip/… per Name), clips = Viewmodel-Clips der Variation
   * (Arm-Spuren + flache Waffen-Spuren), roles = Rolle → Clip-Name, dur = Clip → Dauer (s). Fehlt → keine Ego-Waffe.
   * legacyGlb wie oben, mit Skelett.
   * snd = Clip → [Sekunde, Soundevent][] (CNmSoundEvent, z. B. [0.367, 'Weapon_AK47.Clipout']), Defs in SoundMap.map.clip.
   * win = Clip → Fenster in Sekunden (CNmIDEvent): block = kein Inspect (WPN_BLOCK_INSPECT), loop = bei Reload-Clips die Schrotflinten-Ladeschleife (WPN_RELOAD_LOOP), bei lookat-Clips das Inspect-Loop-Fenster (WPN_INSPECT_LOOP).
   */
  vm?: {
    glb: string; clips: string; roles: Partial<Record<VmRole, string>>; dur: Record<string, number>; legacyGlb?: string
    snd?: Record<string, [t: number, ev: string][]>
    win?: Record<string, { block?: [number, number][]; loop?: [number, number] }>
  }
  /** Spielermodell: glb mit Oberkörper-Clips (world/<klasse>.glb), roles = Rolle → Clip-Name, dur = Clip → Dauer (s). Fehlt → nur Fortbewegung. */
  world?: { clips: string; roles: Partial<Record<WorldRole, string>>; dur: Record<string, number> }
  /**
   * weapons.vdata m_nTracerFrequency: jede n-te Kugel einer Salve zieht einen Tracer, 0 = nie; Paar = [ohne, mit Schalldämpfer]
   * (M4A1-S [3, 0], USP-S [1, 0]). Fehlt → Tabelle in effects (Gewehre/SMGs 3, Pistolen/Sniper 1, mit Schalldämpfer 0).
   */
  tracerFreq?: number | [number, number]
}
/**
 * item_def_idx → Waffe; deckt header.weapons des Matches und immer 43–49 ab: Granaten-Projektil = dasselbe Modell wie in der Hand
 * (NADE → Def: flash 43, he 44, smoke 45, molotov 46, decoy 47, incgrenade 48), C4 49 auch gelegt.
 */
export type WeaponAssets = Record<number, WeaponAsset>

/** curve: [Distanz in Source-Units, Gain] linear; gain = mixgroupVol[mix] · vol · curve(|Quelle + z − Ohr|) */
export interface SoundDef {
  ev: string; vol: number; mix: string; files: string[]; curve: [number, number][]
  z?: number; pitch?: number; pr?: [number, number]; delay?: number; limit?: number
  /** CS2-Soundevent mit metadata localplayeronly: hört nur der Spieler selbst (3D-Replay: nur der beobachtete Spieler in Ego-Sicht) */
  local?: true
}
/**
 * Schlüssel: weapon_fire / weapon_fire_silenced / reload / zoom → className; detonate → Event-Name, Brand: 'inferno_startburn:T'
 * (molotov) bzw. ':CT' (incgrenade), 'inferno_loop', 'grenade_bounce:<typ>'; bomb → bomb_*, beep, beep_last10s;
 * player → player_hurt_body|armor|head, player_death, land; footsteps → surfToStep[`${surface}:${side}`] (surface klein wie in
 * floor.bin, side 'CT'|'T'), dazu 'Gear.CT'/'Gear.T'. Fehlt ein Schlüssel (CS2-Update), still überspringen.
 * Optional (neuere Bauten): clip → Soundevent-Name aus WeaponAsset.vm.snd (z. B. 'Weapon_AK47.Clipout'),
 * land → Oberfläche (klein wie floor.bin) → Land_<Oberfläche>.StepLeft.
 */
export type SoundGroup = 'weapon_fire' | 'weapon_fire_silenced' | 'detonate' | 'bomb' | 'footsteps' | 'player' | 'reload' | 'zoom'
export interface SoundMap {
  mixgroupVol: Record<string, number>
  surfToStep: Record<string, string>
  map: Record<SoundGroup, Record<string, SoundDef[]>> & Partial<Record<'clip' | 'land', Record<string, SoundDef[]>>>
}
export interface SoundAssets {
  /** Datei-URL = base + file (file enthält die Endung .wav oder .mp3; kein Opus, siehe src/main/assets3d/sounds.ts) */
  base: string
  map: SoundMap
}

// ---------------------------------------------------------------- Skins (Eingaben für den Compositor, spike/fp/skins compositor.mjs)
// CS2 setzt Farbe/Metalness eines Skins zur Laufzeit zusammen (csgo_customweapon.vfx); der Renderer macht das per WebGL2-Pass nach.
// Texturen: WebP lossless ≤ 1024 (Muster bei Stil 6–9 ≤ 2048), pos = EXR float (Zeilen beim Laden flippen). Farben linear.

/** Grenzen einer Roll-Variable aus dem vcompmat (UniformRandomStream: x/y zwischen min und max, ohne Grenzen fester Wert) */
export interface RollVar { x?: number; xmin?: number; xmax?: number; y?: number; ymin?: number; ymax?: number }
/** composite_inputs der Waffe (je Mesh): separate = F_SEPARATE_CHANNEL_INPUTS (body_hd), sonst gepackte Legacy-Kanäle */
export interface SkinInputs {
  separate: boolean; weaponLength: number; uvScale: number
  /** R Cavity, G AO, A NoPaint (sRGB laden) */
  ao?: string; masks?: string; surface?: string; color?: string; rough?: string; metal?: string; pos?: string
  /** Legacy-Grundfarbe u. a.: Zahlen-Parameter der composite_inputs (Name wie im vmat); fehlt → heutiges Verhalten */
  vars?: Record<string, number[]>
  /** Zusatz-Texturen der composite_inputs (Name wie im vmat → skins/tex/…) */
  tex?: Record<string, string>
}
/** Lack-Parameter aus der Paint-vmat (Legacy) bzw. Vorlage + exposed_params (Community); Namen wie compositor.mjs */
export interface SkinPaint {
  style: number; roughnessTexture: boolean; roughnessPerColor: boolean; halftone: boolean; useAllMasks: boolean; ignoreWeaponSizeScale: boolean
  colors: [number, number, number][]; colorBrightness: number; colorAdjustmentMode: number
  paintRoughness: number; paintRoughness4: number[]; paintMetalness: number; paintMetalness4: number[]; durability: number[]
  wearSoftness: number; pearlescent: number; pearlescentOnMetallicOnly: boolean; sprayBiasBlend: number[]
  patternScale: number; patternRotation: number; patternOffset: number[]; wearScale: number; grungeScale: number
  samplingU: number; samplingV: number; roughnessUsesPatternUVs: boolean
  /** normal ersetzt die Waffen-Normal-Map, masks die composite_inputs-Masken */
  textures: { pattern?: string; wear?: string; grunge?: string; paintRough?: string; normal?: string; masks?: string }
  /**
   * alle Zahlen-Parameter der Paint-vmat bzw. Vorlage + exposed_params (Name wie im vmat, z. B. Overlay, Halftone, Case Hardening,
   * Perlglanz); Skalar = [x]. Die Felder oben bleiben gefüllt. Fehlt → heutiges Verhalten.
   */
  vars?: Record<string, number[]>
  /** Zusatz-Texturen (Name wie im vmat → skins/tex/…): Overlay, CH-Rampe, eigene Wear/Grunge, AO-Override, Metall */
  tex?: Record<string, string>
}
export type SkinRoll = Record<'patternOffset' | 'patternRotation' | 'wearScale' | 'wearOffset' | 'wearRotation' | 'grungeScale' | 'grungeOffset' | 'grungeRotation', RollVar | null>
/**
 * legacy = Mesh body_legacy zeigen (WeaponAsset.legacyGlb / vm.legacyGlb).
 * rolls = alle Würfe des vcompmat in Würfel-Reihenfolge (econ_instance, sonst exposed_params, dazu Case-Hardening-Zusatzwürfe und
 * grunge_wear), name = Ziel-Variable wie in paint.vars; fehlt → roll in der festen Reihenfolge von rollSeed.
 */
export interface WeaponSkin { kind: 'weapon'; legacy: boolean; inputs: SkinInputs; paint: SkinPaint; roll: SkinRoll; rolls?: [name: string, v: RollVar][] }
/**
 * Handschuh (csgo_customglove.vfx, Renderer engine/gloves.ts liest vor allem vars/tex): Tint-ID = floor(mask.a·8), tints sRGB, pattern
 * ersetzt Tint replaceIndex durch palette (1-basiert), details[i] moduliert Material-Layer i. Neue Kits (glove_compositor): GloveSkin2.
 */
export interface GloveSkin {
  kind: 'glove'; mask?: string; pattern?: string; surface?: string; details: (string | null)[]
  tints: [number, number, number][]; palette: number[]; replaceIndex: number; usePattern: boolean
  patternScale: number; patternRotation: number; detailScale: number[]; roll: { patternOffset: RollVar | null; patternRotation: RollVar | null }
  /** alle Zahlen-Parameter der Handschuh-vmat (Name wie im vmat: Wear, Sheen, Flip …); fehlt → heutiges Verhalten */
  vars?: Record<string, number[]>
  /** Zusatz-Texturen (Name wie im vmat → skins/tex/…) */
  tex?: Record<string, string>
}
/**
 * Neuer Handschuh (glove_compositor, Container paint_compositor, 22 Kits): vars = Zahlen-Parameter (4 Material-Layer, Muster,
 * handedness …, Name wie im vcompmat), tex = Texturen (Name → skins/tex/…), rolls = instance_params-Würfe (UvOffset1–4, Damage,
 * Grime) in Würfel-Reihenfolge. Renderer: engine/gloves.ts.
 */
export interface GloveSkin2 { kind: 'glove2'; vars: Record<string, number[]>; tex: Record<string, string>; rolls: [name: string, v: RollVar][] }
/** Schlüssel `${def}_${paint}` (header.skins bzw. Player3D.glove); Seed und Wear kommen pro Instanz aus der Demo */
export type SkinAssets = Record<string, WeaponSkin | GloveSkin | GloveSkin2>

/**
 * Sticker-Raum einer Mesh-Variante (main/assets3d/econ.ts): uv2 = (u·p, v·p) mit p = (x, y, z, 1) im glTF-Wurzelraum des Waffen-GLB,
 * gültig nur auf der Seite s (dot(Normale, s) > 0) und wo mask.r > 0 (mask: R erlaubt, G Kavität, UV0). slots = StickerMarkup (Versatz im
 * uv2 um 0.5, Skala, Drehung) je Platz
 */
export interface StickerSpace { u: number[]; v: number[]; s: number[]; mask: string; slots: { x: number; y: number; scale: number; rot: number }[] }
/**
 * Aufkleber/Anhänger des Matches: stickers sticker_kits-ID → Textur (256², sRGB + Alpha) + Wear-Parameter des Aufkleber-Materials
 * (g_vWearBiasSticker0, g_fWearScratchesSticker0, paper = g_bPaperBackingSticker0, fehlt = ja); charms keychain_definitions-ID → GLB (Ursprung = Öse, hängt nach −y);
 * weapons Waffen-def → Sticker-Raum je Mesh (hd/legacy); scratches = Kratzer-Textur für Wear
 */
export interface EconAssets {
  stickers: Record<number, { tex: string; wb: [number, number]; ws: number; paper?: boolean }>
  charms: Record<number, string>
  weapons: Record<number, { hd?: StickerSpace; legacy?: StickerSpace }>
  scratches?: string
}

/** gloves: Handschuh-def (5027–5035) → GLB; skins fehlt/leer → Vanilla (alter Bau, Fehler beim Skin-Export); econ fehlt → ohne Aufkleber/Anhänger */
export interface Assets3D { map: MapAssetManifest; agents: AgentAssets; weapons: WeaponAssets; sounds: SoundAssets; gloves?: Record<number, string>; skins?: SkinAssets; econ?: EconAssets }
/** Utility-Vorschau ohne Demo (IPC assets3d:prepareMap): Map + Vorschau-Kit (Standard-Agenten T/CT mit Ego-Armen, Granaten 43–48); Kit fehlt nach einem Kit-Fehler */
export type PreviewAssets = Pick<Assets3D, 'map'> & Partial<Pick<Assets3D, 'agents' | 'weapons'>>

/** Was prepare3d aus dem CS3D-Header braucht: Agenten, Waffen (+ Messer pro Seite), Lackierungen von Waffen und Handschuhen, Aufkleber/Anhänger */
export function prepareInput(h: CS3DHeader) {
  return {
    map: h.map, agents: h.players.flatMap(p => [p.agent.T, p.agent.CT]),
    weapons: [...h.weapons, ...h.players.flatMap(p => Object.values(p.knife ?? {}))],
    skins: [...h.skins, ...h.players.flatMap(p => Object.values(p.glove ?? {}))].map(({ def, paint }) => ({ def, paint })),
    econ: {
      stickers: [...new Set(h.skins.flatMap(s => s.stickers?.map(x => x.id) ?? []))],
      charms: [...new Set(h.skins.flatMap(s => (s.charm ? [s.charm.id] : [])))],
      defs: [...new Set(h.skins.filter(s => s.stickers?.length).map(s => s.def))],
    },
  }
}

/**
 * Stand der 3D-Vorbereitung eines Matches (main/assets3d/index.ts → Bibliothek-Symbol und Ladebildschirm): queued = wartet auf einen
 * anderen Bau, building (pct/msg wie PrepareProgress), ready, error (msg = englischer Fehlertext). Kein Eintrag = noch nicht geprüft.
 */
export interface Prepare3DStatus { id: string; state: 'queued' | 'building' | 'ready' | 'error'; pct: number; msg: string }

/** IPC des 3D-Tabs (preload/api.ts) */
export interface Api3D {
  /** 'match:load3d': entpackte <id>.3d.bin.gz; null = alter Import ohne 3D-Daten (UI: "Re-import the demo for 3D") */
  load3d(matchId: string): Promise<Uint8Array | null>
  /**
   * 'assets3d:prepare': baut fehlende Assets für Map, Agenten und Waffen des Matches (erstes Mal Minuten), sonst Cache; nach der
   * Hintergrund-Vorbereitung (Import, App-Start, Match geöffnet) sofort. Fehler mit englischem Text.
   */
  prepare3d(matchId: string): Promise<Assets3D>
  /** 'assets3d:status': Statuswechsel aller Matches */
  onPrepareStatus(cb: (s: Prepare3DStatus) => void): () => void
  /** 'assets3d:statusAll': bekannte Stände (seit App-Start) */
  prepareStatus(): Promise<Prepare3DStatus[]>
}

// ---------------------------------------------------------------- Boden-Raster (floor.bin + probes.bin)

/**
 * floor.bin = [u32 headerLen][JSON {v:1, cell, minX, minY, W, H, n, surfaces}][pad→4][Uint32 offs[W·H+1]][Int16 z[n]][Uint8 sid[n]]
 *   (= surfgrid_32 aus dem sounds-Spike, aber mit 4-Byte-Padding und ungezippt). Zelle = (floor((x−minX)/cell), floor((y−minY)/cell)),
 *   Index cy·W+cx; Lagen offs[c] … offs[c+1]−1 mit Bodenhöhe z (u) und Oberfläche surfaces[sid].
 * probes.bin = n × 19 B in derselben Lagen-Reihenfolge, gemessen an (Zellmitte, z+40): 6 × RGB8 für die Flächen
 *   Source +X,−X,+Y,−Y,+Z,−Z (Wert = (b/255)²·4, Lightmap-Einheiten) + 1 B Sonnen-Sichtbarkeit (b/255, 1 = frei).
 *   Bis MAP_VERSION 3: Flächen aus dem CS2-Atlas (+X,+Y,+Z,−X,−Y,−Z) falsch zugeordnet und Sonne verkehrt (= dlshd.R, licht-shader Befunde 2, 5).
 *   Agent: Ambient-Cube irradiance += Σ n_i²·C[face(sign n_i)], Sonnenlicht × Sonne, über 0.1 s glätten.
 */
export interface FloorGrid {
  cell: number; minX: number; minY: number; W: number; H: number; surfaces: string[]
  offs: Uint32Array; z: Int16Array; sid: Uint8Array
  probes?: Uint8Array
}
export function parseFloorGrid(floor: ArrayBuffer, probes?: ArrayBuffer): FloorGrid {
  const hl = new DataView(floor).getUint32(0, true)
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(floor, 4, hl)))
  let o = (4 + hl + 3) & ~3
  const offs = new Uint32Array(floor, o, h.W * h.H + 1); o += offs.byteLength
  const z = new Int16Array(floor, o, h.n); o += z.byteLength
  const sid = new Uint8Array(floor, o, h.n)
  if (probes && probes.byteLength !== h.n * 19) throw new Error('probes.bin passt nicht zu floor.bin')
  return { cell: h.cell, minX: h.minX, minY: h.minY, W: h.W, H: h.H, surfaces: h.surfaces, offs, z, sid, probes: probes && new Uint8Array(probes) }
}
/** Lage unter (x,y,z): höchste mit Boden ≤ z+12 und z−Boden < maxDrop; −1 = keine (Schritte: 'concrete', Sonden: letzter Wert) */
export function floorLayer(g: FloorGrid, x: number, y: number, z: number, maxDrop = 40): number {
  const cx = Math.floor((x - g.minX) / g.cell), cy = Math.floor((y - g.minY) / g.cell)
  if (cx < 0 || cy < 0 || cx >= g.W || cy >= g.H) return -1
  const c = cy * g.W + cx
  let best = -1
  for (let l = g.offs[c]; l < g.offs[c + 1]; l++) if (g.z[l] <= z + 12 && z - g.z[l] < maxDrop && (best < 0 || g.z[l] > g.z[best])) best = l
  return best
}
