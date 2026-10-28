// Schnittstellen des 3D-Replays im Renderer. Alle Absprachen zwischen den Bauteilen stehen hier als Kommentare.
//
// Ablauf beim Öffnen des Tabs "3D" (vorher wird nichts davon geladen):
//   1. Replay3DView lädt per dynamischem import() (three & Co. nie statisch aus App.tsx importieren)
//   2. api.load3d(id) → decode3d → CS3D;  api.prepare3d(id) → Assets3D (Fortschritt über onPrepareStatus);
//      dazu api.loadHud(id) (HudTrack oder null), api.avatars(steamids), api.hudAssets()
//   3. engine = await createEngine(canvas, assets, data); audio = await createAudio(data, assets)
//   4. Bildtakt (frameloop.ts) im View (besitzt die Uhr: Play/Pause/Tempo/Sprung über das ganze Match):
//        engine.setTime(tick) → audio.update({ tick, playing, speed, at }, engine.listener());
//        HUD höchstens 15×/s: hudView(...) (hud/state.ts, Typen in hud/types.ts) → engine.setOverlay(Schilder)
//      In der Pause nur zeichnen bei Sprung, Optionswechsel, Resize oder engine.dirty(), sonst schläft der Takt (engine.onDirty weckt ihn).
//   5. Tab verlassen: audio.dispose(), engine.dispose() (gibt GPU-Speicher frei, entfernt Listener)
//
// OPTIONEN kommen aus options.ts (Store: getOptions/onOptions), Tastenbelegung aus hotkeys.ts. Es gibt KEINE setOptions-Methoden
// an Engine, Effects oder Audio: jedes Bauteil liest den Store selbst; eine Option, die aus ist, kostet 0 Arbeit.
//
// Bauteile in GETRENNTEN Dateien (je ein Agent):
//   main:     src/main/parse3d.ts (CS3DInput aus der Demo, in parser-process.ts) + src/main/voice.ts (seq = section_number)
//   main:     src/main/assets3d/*.ts (CS2 finden, VRF, Map/Agenten/Waffen/Sounds bauen, Api3D-Handler, cs3d://)
//   renderer: replay3d/engine/     → createEngine (Map, Agenten + Waffen, Kamera, Raycast, Schilder, X-Ray, ruft createEffects)
//   renderer: replay3d/effects/    → createEffects (Smoke, Molly, Flash, HE, Mündungsfeuer, Tracer, Granatenflug, C4, Flugbahn, Impacts)
//   renderer: replay3d/audio/      → createAudio (Voice + SFX, EIN AudioContext)
//   renderer: replay3d/actions.ts  → actionsOf (Aktions-Zeitleiste für Viewmodel, Spielermodelle und Sounds)
//   renderer: replay3d/hud/*       → HUD-Modell und -Komponenten; Replay3DView.tsx + Hud.tsx verdrahten
//   Integrate: preload/api.ts (Api3D), App.tsx (Tab), main/index.ts (IPC, cs3d://), package.json.
//
// Einheiten: CS3D/Listener/Events in Source-Units (Z oben); three-Szene in glTF-Metern (worldToGltf).
// Spieler: in Hot-Paths Index in data.d.header.players, nach außen (Kamera, Mute/Solo, HUD, Schilder) steamid.
// UI-Texte englisch.
import type { PerspectiveCamera, PointLight, Scene, Texture, Vector3 } from 'three'
import type { MatchData } from '../../shared/model'
import type { CS3D } from '../../shared/cs3d'
import type { Assets3D, PrepareProgress, WeaponAssets } from '../../shared/assets3d'

export const HU = 0.0254 // m pro Source-Unit (Map und Agenten, VRF-Export)
/** Source (x,y,z) → glTF/three (y,z,x)·0.0254 */
export const worldToGltf = (x: number, y: number, z: number, out: Vector3) => out.set(y * HU, z * HU, x * HU)
/** Augenhöhe (u): Z + 64 − 18·duck (data-Spike, gegen m_flDuckViewOffset gemessen) */
export const eyeZ = (z: number, duck: number) => z + 64 - 18 * duck
/** vertikales FOV wie CS2 (fov 90 bei 4:3, Hor+). Kamera: camera.rotation.set(-pitch·D, yaw·D + PI, 0, 'YXZ'), near 0.05, far 1000 */
export const CS2_VFOV = 73.7398

/** v1-Match (HUD: HP, Geld, Inventar, Killfeed, Runden-Zeiten) + CS3D (Bewegung, Winkel, Tasten, Schüsse, Granaten, Voice) */
export interface Replay3DData { match: MatchData; d: CS3D }

/** free: Tasten aus hotkeys.ts (camForward … camFast) + Maus im Canvas, die Engine verarbeitet die Eingaben selbst; ego: Augen von steamid */
export type CameraMode = 'free' | 'ego'

/**
 * Hörer in Source-Units (Augenpunkt der Kamera), yaw in Grad wie CS2. ego = Spieler-Index in Ego-Sicht (hört seine nur-lokalen
 * Viewmodel-Geräusche, SoundDef.local), fehlt/−1 = Free-Cam
 */
export interface Listener { x: number; y: number; z: number; yaw: number; ego?: number }

export interface EngineStats {
  fps: number; frameMs: number
  /** renderer.info */
  calls: number; triangles: number; geometries: number; textures: number
  /** create bis erstes Bild */
  loadMs: number
  /** CPU-Zeit von setTime im Mittel (ms) */
  cpuMs: number
  /** Draw-Calls des letzten Bildes je Pass: world (inkl. Schattenpass), viewmodel, nadecam, post; Summe = calls. Fehlt → nur calls. */
  callsBy?: Record<string, number>
}

/**
 * Überkopf-Schild (Bild 2): Icons + Name in Teamfarbe + HP %, Defuse-Symbol unter der HP. weapon/utility = Schlüssel in
 * OverlayState.icons (= Namen aus HudAssetManifest.icons, z. B. 'eq/ak47', 'eq/flashbang'), '' = keine Waffe.
 */
export interface LabelInfo { weapon: string; utility: string[]; bomb: boolean; defusing: boolean }
/** labels: steamid → Schild (fehlt → Schild wie bisher nur mit Name/HP); icons: fertig dekodierte Bilder (HB iconBitmaps) */
export interface OverlayState { labels: Record<string, LabelInfo>; icons?: Map<string, CanvasImageSource> }
/** Utility-Vorschau: Flugbahn und Ziel (Boden) in Source-Units */
export interface LineupMarks { path: [number, number, number][]; target: [number, number, number] }
/** Utility-Vorschau: Kamera hinter Granate nade (Index in d.nade) bzw. fest auf pos mit Blick auf look (Source-Units) */
export type LineupView = { nade: number } | { pos: [number, number, number]; look: [number, number, number] }
  /**
   * Kreisfahrt um center (Abstand dist, mind. elev Grad über der Waagerechten, ab Winkel yaw0 Grad, eine Runde in turnS Sekunden Demo-Zeit ab
   * Tick t0); ist der Kreis verbaut (Dach, Wände), schwenkt die Kamera stattdessen in der freiesten Richtung hin und her
   */
  | { orbit: { center: [number, number, number]; dist: number; elev: number; yaw0: number; turnS: number; t0: number } }

export interface Engine {
  /** Szene auf Tick stellen (gebrochen erlaubt, Sprünge erlaubt), effects.update(tick), EIN Bild rendern. Zwischen Runden letzten Frame halten. */
  setTime(tick: number): void
  /** ego braucht steamid; free startet an der aktuellen Kameraposition */
  setCamera(mode: CameraMode, steamid?: string): void
  /** Überkopf-Schilder; höchstens 15×/s und nur bei Änderung aufrufen. Sichtbar nur bei shown('labels') (options.ts). */
  setOverlay(o: OverlayState): void
  /** Ziel-Markierung + Flugbahn (immer sichtbar, auch durch Wände), null = entfernen */
  setMarks?(m: LineupMarks | null): void
  /** Blickfeld der Grundkamera (setCamera) durch k teilen = Zoom auf die Bildmitte; 1 = aus */
  setZoom?(k: number): void
  /**
   * Kamera übersteuern (Granate folgen wie die Granaten-Kamera, Außenansicht), weich über blendS Sekunden Demo-Zeit ab Tick t0 (Standard:
   * letztes Bild) aus der Kamera davor; null = zurück zu setCamera. Solange aktiv: kein Viewmodel, der Fokus-Spieler ist sichtbar.
   */
  setView?(v: LineupView | null, blendS?: number, t0?: number): void
  /**
   * Was bei tick nachgeladen wird (Viewmodel des Fokus-Spielers, Welt-Clips), jetzt laden und übersetzen; zeichnet dabei. Utility-Vorschau:
   * Hände ab dem ersten Bild, ohne Ruckler beim ersten Zeigen.
   */
  warm?(tick: number): Promise<void>
  /**
   * true = das nächste Bild muss gezeichnet werden, auch in der Pause: Free-Cam-Taste oder Maus aktiv, Asset nachgeladen
   * (Viewmodel, Welt-Clip, Textur), nach setOverlay oder Optionswechsel. Der Bildtakt fragt das je rAF ab, solange er wach ist (billig halten).
   */
  dirty(): boolean
  /** vom View gesetzt: die Engine ruft es, wenn dirty() ohne Bild true wird (Maus, Taste, Nachgeladenes, Overlay); weckt den schlafenden Takt */
  onDirty?: () => void
  /** CSS-Pixel; Pixel-Ratio höchstens 1 (Critic P1-5) */
  resize(width: number, height: number): void
  listener(): Listener
  /** Utility-Bilder (utility/capture): freier Weg von a nach b (Source-Units) bis zur Map; Infinity = bis b frei */
  raycast?(a: [number, number, number], b: [number, number, number]): number
  stats(): EngineStats
  dispose(): void
}
/**
 * Regeln: Agent pro Spieler = assets.agents.models[player.agent[side]] ?? AGENT_DEFAULT; Waffe nach WeaponAsset.root an Bone 'wpn';
 * Agenten-Licht aus probes.bin (Critic P0-2); Lichtanzahl nach dem ersten Bild NIE ändern (Shader-Neukompilierung 243–705 ms).
 */
export type CreateEngine = (canvas: HTMLCanvasElement, assets: Assets3D, data: Replay3DData, onProgress?: (p: PrepareProgress) => void, opts?: EngineOpts) => Promise<Engine>
/**
 * lazyRay: erstes Bild ohne auf das Kollisionsgitter der Map zu warten (Dust2/Ancient 0,5–1,2 s); bis es da ist, füllen die Effekte keinen
 * Rauch/kein Feuer (rayReady). Nur, wenn am Anfang nichts den Raycast braucht (Lineup-Vorschau ohne Demo: erst Sekunden später ein Wurf).
 */
export interface EngineOpts { lazyRay?: boolean }

/** Von der Engine an die Effekte; gültig ab dem ersten setTime, Agenten sind beim effects.update schon aktualisiert. */
export interface EffectsContext {
  scene: Scene
  camera: PerspectiveCamera
  data: Replay3DData
  assets: Assets3D
  /** fester Pool (4 Stück) schon in der Szene, intensity 0 = frei. Keine Lichter hinzufügen/entfernen. */
  lights: PointLight[]
  /** Mündung der Waffe in der Hand von Spieler-Index p (three-Welt) → true; false wenn tot/kein Modell */
  muzzle(p: number, out: Vector3): boolean
  /** Abstand (m) entlang dir (three-Welt, normiert) bis zur Map, Infinity = kein Treffer bis far. Für Tracer-Enden, Smoke-Füllung, Impacts. */
  raycast(origin: Vector3, dir: Vector3, far: number): number
  /** false = Kollisionsgitter lädt noch (EngineOpts.lazyRay), raycast trifft nichts: nichts Gemerktes daraus rechnen. Fehlt → immer bereit */
  rayReady?(): boolean
  /**
   * Flash-Nachbild: Kopie des zuletzt gezeigten Bildes NACH Tonemapping (sRGB, Größe der Zeichenfläche). Die Engine kopiert nur auf
   * Anfrage nach dem Endpass, der Inhalt ist also ab dem nächsten Bild gültig; null = (noch) keine Kopie. Fehlt → kein Nachbild.
   */
  captureFrame?(): Texture | null
}
/** update(tick) ist eine Funktion des Ticks (Vor-/Zurückspringen ohne Altlasten); Sound macht AudioEngine, nicht die Effekte. */
export interface EffectsSystem {
  /** Blend-Weiß des Ego-Spielers: nach Welt und Viewmodel zeichnen, wenn visible */
  readonly post: Scene
  update(tick: number): void; dispose(): void
  /** true = Arbeit offen (Smoke-/Feuer-Füllung, Impact-Strahlen): in der Pause weiter Bilder zeichnen, bis fertig */
  pending(): boolean
}
export type CreateEffects = (ctx: EffectsContext) => EffectsSystem

/** = voice-engine PlayState; at = rAF-Zeitstempel (performance.now-Basis) */
export interface PlayState { tick: number; playing: boolean; speed: number; at?: number }

/**
 * EIN AudioContext für Voice und SFX (Critic P1-7). Graph: Quellen → bus.voice / bus.sfx → bus.master → DynamicsCompressor → destination.
 * Anker Demo-Zeit ↔ ctx-Zeit über getOutputTimestamp, gemeinsam für Voice und SFX: when = anchor.ctx + (t − anchor.demo)/speed.
 * update() setzt den Anker selbst neu bei Play/Pause, Sprung (> 0.12 s Abweichung) und Tempowechsel; Pause = alles stoppen.
 * SFX: AudioBufferSource → Gain → StereoPanner mit CS2-Kurven (SoundDef.curve), kein PannerNode/THREE.PositionalAudio; Cap 48 Stimmen.
 * Schritte/Landungen: ab CS3D v6 die Server-Sounds der Demo (d.snd), sonst sfx.ts stepCues (ab 0.55 × Waffen-Maxtempo, Takt 0.3/0.4 s,
 * erster Schritt nach 0.27 s; Untergrund aus floor.bin) und Sprung/Landung aus player_footstep bzw. ActionIndex.jumps.
 * Nachladen und Clip-Sounds (Ziehen, Bolzen, Inspect, Pin) an den Aktionen (actionsOf), Zeiten aus WeaponAsset.vm.snd, nichts nach action.end;
 * SoundDef.local (CS2 localplayeronly) nur für Listener.ego.
 */
export interface AudioEngine {
  readonly ctx: AudioContext
  readonly bus: { master: GainNode; voice: GainNode; sfx: GainNode }
  /** jedes Bild nach engine.setTime */
  update(s: PlayState, l: Listener): void
  /** Mute/Solo betreffen nur Voice */
  setMuted(steamid: string, muted: boolean): void
  setSolo(steamid: string, solo: boolean): void
  setVolume(bus: 'master' | 'voice' | 'sfx', v: number): void
  /** steamids, die bei tick sprechen (auch bei 4x/8x und vor dem Dekodieren) */
  speaking(tick: number): string[]
  dispose(): void
}
export type CreateAudio = (data: Replay3DData, assets: Assets3D) => Promise<AudioEngine>

// ---------------------------------------------------------------- Aktionen (actions.ts → Viewmodel, Spielermodelle, Sounds)

/**
 * Viewmodel spielt die VmRole gleichen Namens (throw → 'shoot', plant → C4 'shoot'; fehlende Rolle → nächstbeste, z. B. hit → light),
 * Spielermodell die WorldRole (light/light2 → swing, heavy → stab, …). Quellen: Waffenwechsel (draw), FLAG.reloading-Flanke
 * (reload, reload_empty bei ammo 0), weapon_fire (shoot/shoot_last, Elites shoot/shoot_right, Messer light/light2/heavy),
 * player_hurt nahe am Messer (hit/heavy_hit/backstab), BTN.INSPECT-Flanke (inspect), ATTACK|ATTACK2 mit Granate (pullpin,
 * throw / throw_under), FLAG.planting (plant), FLAG.silencer-Wechsel (silencer_on/off).
 */
export type ActionKind =
  | 'draw' | 'shoot' | 'shoot_last' | 'shoot_right' | 'reload' | 'reload_empty' | 'inspect'
  | 'light' | 'light2' | 'heavy' | 'hit' | 'heavy_hit' | 'backstab'
  | 'pullpin' | 'throw' | 'throw_under' | 'plant' | 'silencer_on' | 'silencer_off'
/** t0/end in Ticks; end = Start der nächsten Aktion, Tod oder Rundenende; def = item_def_idx; n = Patronen beim Schrotflinten-Nachladen */
export interface Action { kind: ActionKind; def: number; t0: number; end: number; n?: number }
/**
 * Ticks; aus EV.player_footstep (ab CS3D v5), sonst aus FLAG.airborne-Flanken; vz = Fallgeschwindigkeit (u/s, negativ) vor der Landung.
 * Sturz von einer Kante ohne Absprung (ab 72 u Fallhöhe): takeoff = land.
 */
export interface Jump { takeoff: number; land: number; vz: number }
/** p = Spieler-Index in header.players; Listen nach t0 bzw. takeoff sortiert */
export interface ActionIndex {
  /** Aktion, die bei tick läuft (t0 ≤ tick < end), sonst null; Binärsuche, keine Allokation */
  at(p: number, tick: number): Action | null
  list(p: number): readonly Action[]
  jumps(p: number): readonly Jump[]
}
/** einmal je CS3D gebaut und gecacht (WeakMap); weapons für Clip-Fenster (vm.win) und Waffenklassen */
export type ActionsOf = (d: CS3D, weapons: WeaponAssets) => ActionIndex
