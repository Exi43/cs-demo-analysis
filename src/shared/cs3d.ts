// CS3D v7: kompakte 3D-Replay-Daten eines Matches, eigene Datei <matchId>.3d.bin.gz neben <matchId>.json.gz.
// v3 = v2 + Kanal skin, header.skins, Player3D.crosshair/vm/knife/glove, FLAG.lefthand, FLAG.reloading wirklich gefüllt.
// v4 = v3 + Rückstoß aimP/aimY/viewP/viewY (32 Hz). decode3d liest v2/v3 weiter (fehlende Kanäle = 0, skins = [], Spieler-Extras fehlen).
// v5 = v4 + Event player_footstep (Format gleich, nur eine neue Event-Art). decode3d liest v2–v4 weiter.
// v6 = v5 + liegende Waffen (Sektionen drop.*, Drop3D) + FLAG.defuser. decode3d liest v2–v5 weiter (drop leer).
// v7 = v6 + Aufkleber/Anhänger (Skin3D.stickers/charm, main/econ.ts; Format gleich). Ältere Matches liest main/index.ts im Hintergrund neu.
// Schreiben: Parser-Prozess beim Import, writeFileSync(..., gzipSync(encode3d(m))).
// Lesen: erst im 3D-Tab; main gunzipSync → IPC 'match:load3d' (Uint8Array) → Renderer decode3d (≈40 ms).
// Reines TS (kein Buffer/DOM, keine enums) → läuft in Main, Renderer und `node scripts/cs3d-selftest.ts`.
//
// Datei (entpackt) = [u32 headerLen][Header-JSON utf8][pad→4][Sektionen …]. Sektionen nach Elementgröße sortiert
// (4 → 2 → 1 Byte), daher als TypedArray-View ohne Kopie lesbar; Offsets/Längen stehen im Header.
// Koordinaten: Source-Units wie die Demo (Z oben, Origin = Füße). Positionen 0.5 u (Int16 → max ±16383 u),
// Winkel 0.0055° (Int16). Spuren: Delta je Track, yaw ergibt dekodiert eine stetige ("unwrapped") Kurve.
// Takt: Kanäle 16 Hz (FRAME_STEP 4 wie v1), pitch/yaw 32 Hz (ANGLE_STEP 2; 2. parseTicks-Lauf auf Ticks ≡ 2 mod 4).
// Gemessen v4 (user-demo, 21 Runden, 10 Spieler, 99 Skins): 1.77 MB gz (v3: 1.64 MB) inkl. 294 KB Voice (v2: 1.5 MB), encode 72 ms, gunzip 20 ms, decode 41 ms,
// Roundtrip-Fehler höchstens 0.25 u / 0.0027°; 86 400 sampleTrack-Abfragen 32 ms.
import { FRAME_STEP, type PlayerInfo, type Side } from './model.ts'
import type { Crosshair } from './crosshair.ts'

export const CS3D_VERSION = 7
export const ANGLE_STEP = 2
const POS = 2
const ANG = 65536 / 360
/** Positionssprung (u) zwischen zwei Frames, der nicht interpoliert wird (Respawn/Teleport) */
export const TELEPORT = 100

/** Bitnummern in usercmd_buttonstate_1 (64 bit, gespeichert als btnLo/btnHi). Geprüft im data-Spike (64 Hz). */
export const BTN = {
  ATTACK: 0, JUMP: 1, DUCK: 2, FORWARD: 3, BACK: 4, USE: 5, MOVELEFT: 9, MOVERIGHT: 10,
  ATTACK2: 11, RELOAD: 13, WALK: 16, SCORE: 33, ZOOM: 34, INSPECT: 35,
} as const
export type ButtonName = keyof typeof BTN
/** demoparser2 liefert usercmd_buttonstate_1 als Dezimal-String (u64) → [lo, hi] */
export function splitButtons(v: string | number | bigint | null | undefined): [number, number] {
  if (v == null || v === '') return [0, 0]
  const b = BigInt(v)
  return [Number(b & 0xffffffffn), Number((b >> 32n) & 0xffffffffn)]
}
export const isDown = (lo: number, hi: number, bit: number) => ((bit < 32 ? lo >>> bit : hi >>> (bit - 32)) & 1) === 1

/**
 * flags (u16) pro Frame. planting = item_def_idx 49 && Weapon.m_bStartedArming (kein is_planting-Prop).
 * reloading = is_in_reload (v2 las 'm_bInReload' → Spalte fehlte, Bit immer 0). lefthand = CCSPlayerPawn.m_bLeftHanded (ab v3).
 * defuser = has_defuser (Entschärfer-Set dabei, ab v6).
 */
export const FLAG = { alive: 1, scoped: 2, walking: 4, airborne: 8, defusing: 16, spotted: 32, silencer: 64, reloading: 128, planting: 256, lefthand: 512, defuser: 1024 } as const

/** Granaten-Typ (molotov vs. incgrenade: letztes weapon_fire des Werfers vor inferno_startburn) */
export const NADE = { smoke: 0, flash: 1, he: 2, molotov: 3, incgrenade: 4, decoy: 5 } as const

/**
 * Event-Typen (tick-genau aus parseEvents). arg je Typ:
 *  weapon_fire, item_pickup   → Index in header.strings (Klassen-/Itemname, z. B. 'weapon_ak47'); beim Encode als string übergeben
 *  player_blind               → round(blind_duration * 100)  (player = Geblendeter; Overlay über flashAt())
 *  player_hurt                → min(255, dmg_health) | 256 bei hitgroup 'head' | 512 bei armor > 0  (player = Opfer)
 *  player_death               → Angreifer-Index (255 = Welt/keiner) | 256 bei Headshot  (player = Opfer)
 *  bomb_begindefuse           → 1 mit Kit
 *  sonst 0. player = Index in header.players, 255 = unbekannt.
 * Killfeed, Schaden-Statistik und Bomben-Site kommen weiter aus v1 (MatchData); hier nur, was 3D/Sound tick-genau braucht.
 */
export const EV = {
  weapon_fire: 0, weapon_reload: 1, weapon_zoom: 2, item_pickup: 3, player_blind: 4, player_hurt: 5, player_death: 6,
  bomb_pickup: 7, bomb_dropped: 8, bomb_beginplant: 9, bomb_planted: 10, bomb_begindefuse: 11, bomb_defused: 12, bomb_exploded: 13,
  /** ab v5, arg 0. Die Demo meldet KEINE Bodenschritte, nur Absprünge und harte Landungen (ab ca. 340 u/s Fallgeschwindigkeit) */
  player_footstep: 14,
} as const

/** Lackierung eines Items: def = item_def_idx, paint = Paint-Kit-ID, seed = Muster-Seed (ganzzahlig), wear = Float 0..1 */
export interface Paint3D { def: number; paint: number; seed: number; wear: number }
/**
 * Aufkleber der Waffe (Attribute 113–136, 278–295): slot = Attribut-Platz 0–5, id = sticker_kits-ID, wear 0..1, rot in Grad.
 * x/y = Versatz im Sticker-Raum (uv2) relativ zu StickerMarkup[schema] des Modells; ohne x/y/schema sitzt er auf StickerMarkup[slot]. scale fehlt = Markup-Skala
 */
export interface Sticker3D { slot: number; id: number; wear?: number; scale?: number; rot?: number; x?: number; y?: number; schema?: number }
/** Anhänger (Attribute 299–306/314/321): id = keychain_definitions-ID, x/y/z = Ort am Waffenmodell (Bone weapon_offset, Zoll), seed = Muster, sticker = Sticker-Anhänger */
export interface Charm3D { id: number; x?: number; y?: number; z?: number; seed?: number; highlight?: number; sticker?: number }
/**
 * header.skins[i] ⇔ Kanalwert skin = i + 1. Gehört zur Waffen-Entity: aufgehobene Waffe trägt den Skin des Vorbesitzers. name = Nametag, stattrak = Qualität 9.
 * stickers/charm (fehlen in älteren Dateien) aus main/econ.ts; paint 0 = Vanilla-Waffe mit Aufklebern/Anhänger
 */
export interface Skin3D extends Paint3D { name?: string; stattrak?: true; stickers?: Sticker3D[]; charm?: Charm3D }

/**
 * Agent pro Spieler und Seite aus CCSPlayerController.m_nPawnCharacterDefIndex (Freeze-End-Ticks); 0 = unbekannt → AGENT_DEFAULT.
 * Ab v3, alle optional (fehlen in v2-Dateien, bei Bots/Coaches oder wenn die Demo den Prop nicht hat), gelesen 1 s nach Freeze-Ende jeder Runde:
 *  crosshair  m_szCrosshairCodes dekodiert (shared/crosshair.ts; Renderer: toRender(p.crosshair)), letzter gültiger Code
 *  vm         viewmodel_fov / viewmodel_offset_x/y/z (CCSPlayerPawn.m_flViewmodelFOV/OffsetX/Y/Z), letzter Wert; Linkshand je Frame: FLAG.lefthand.
 *             viewmodel_presetpos steht nicht in der Demo (setzt nur diese vier Werte).
 *  knife      Messer-def pro Seite aus inventory_as_ids (42/59 Standard, 500+ Spezialmesser); Skin über Kanal skin, solange es aktiv ist
 *  glove      Handschuh pro Seite (glove_item_idx/paint_id/seed/float); fehlt = Standard-Handschuh des Agenten
 */
export interface Player3D extends PlayerInfo {
  agent: { T: number; CT: number }
  crosshair?: Crosshair
  vm?: { fov: number; x: number; y: number; z: number }
  knife?: Partial<Record<Side, number>>
  glove?: Partial<Record<Side, Paint3D>>
}
export const AGENT_DEFAULT = { T: 5036, CT: 5037 } as const // tm_phoenix / ctm_sas

// ---------------------------------------------------------------- Eingabe (Builder in main)

/** Kanäle eines Spielers in einer Runde. 16 Hz: Länge nFrames, Frame i = Tick firstTick + 4i. 32 Hz: Länge 2·nFrames−1, Index j = Tick firstTick + 2j. Lücken vorher mit Vorwert füllen (NaN wirft). */
export interface Track3DIn {
  player: number
  x: number[]; y: number[]; z: number[]
  duck: number[] // 0..1
  btnLo: number[]; btnHi: number[] // splitButtons(usercmd_buttonstate_1)
  flags: number[] // FLAG-Bits
  weapon: number[] // item_def_idx der aktiven Waffe, 0 = keine
  fov: number[] // m_iFOV, 0 = Standard (90)
  ammo: number[] // Clip
  skin: number[] // Skin der aktiven Waffe: 0 = Vanilla, sonst Index in skins + 1
  pitch: number[]; yaw: number[] // 32 Hz, Grad
  /** 32 Hz, Grad, schon abgeklungen (parse3d punchAt): Aim-Punch (Kugeln = Blick + 2·aim) und View-Punch (nur Kamera) */
  aimP: number[]; aimY: number[]; viewP: number[]; viewY: number[]
}
/**
 * Runden wie v1: num = Round.num, firstTick = Round.frameTicks[0], nFrames = frameTicks.length → CS3D-Frame i ⇔ v1-Frame i
 * (HP/Geld/Waffenname direkt per Index). Nicht startTick − startTick % 4: der liegt vor Rundenstart (build3d-Spike: Frame 0 = Lücke).
 */
export interface Round3DIn { num: number; firstTick: number; nFrames: number; tracks: Track3DIn[] }
export interface Event3D { tick: number; type: number; player: number; arg: number | string }
/** aus fire_bullets (Augenposition origin_x/y/z, angles_x = pitch, angles_y = yaw, item_def_index, recoil_index) */
export interface Shot3D { tick: number; player: number; weapon: number; silenced: boolean; x: number; y: number; z: number; pitch: number; yaw: number; recoil: number }
/** x/y/z = Detonation (smoke/flash/he/decoy) bzw. inferno_startburn; path = Flug [tick,x,y,z] bis detTick (wie v1 Nade.path) */
export interface Nade3D { type: number; player: number; throwTick: number; detTick: number; endTick: number; x: number; y: number; z: number; path: [number, number, number, number][] }
/** = src/main/voice.ts VoicePacket + seq (CMsgVoiceAudio.section_number, fehlt = lückenlos legen). Unbekannte Sprecher hängt encode3d an players an. */
export interface VoicePacket3D { tick: number; steamid: string; opus: Uint8Array; seq?: number }
/**
 * Liegende Waffe (ab v6): fällt bei tick aus der Hand (Fallenlassen, Tausch beim Aufheben, Tod; C4 per bomb_dropped), liegt bis end
 * (Aufheben; 0 = bis Rundenende). def = item_def_idx (55 = Entschärfer-Set), skin wie Kanal skin. x/y/z = Abwurfpunkt (Hand),
 * vx/vy/vz = Abwurf-Geschwindigkeit (u/s); Flug und Liegeplatz rechnet der Renderer gegen die Map (engine/drops.ts).
 * shortcut: demoparser2 0.42 liefert keine Waffen-Entities ohne Besitzer (collect_projectiles überspringt sie) → Abwurf aus Inventar-Diff,
 * Lage geschätzt; exakte Lage/Drehung erst mit gepatchtem Parser (Berat entscheidet über den Fork)
 */
export interface Drop3D {
  tick: number; end: number; def: number; skin: number; x: number; y: number; z: number; vx: number; vy: number; vz: number
  /** erster Bodenkontakt aus dem Aufprall-Sound der Demo (weapon.*.Impact, defuser.Impact): Tick, Ort i*, Liegeplatz r* = letzter Abpraller; 0 = unbekannt */
  land: number; ix: number; iy: number; iz: number; rx: number; ry: number; rz: number
}
/**
 * Server-Sound der Demo (GE_SosStartSoundEvent, ab v6), den ein Spieler auslöst: Schritte (<Seite>_<Untergrund>.StepLeft), Landungen
 * (Land_<Untergrund>.StepLeft), Sprung … CS2-Server mit mp_footsteps_serverside schicken jeden hörbaren Schritt (MM + FACEIT geprüft).
 * hash = soundHash(Event-Name); Ort = Spur von player (Füße) bei tick.
 */
export interface Sound3D { tick: number; hash: number; player: number }
/** Soundevent-Hash wie Source 2 (MurmurHash2 32 bit, Seed 0x53524332, Name klein, ASCII) */
export function soundHash(name: string): number {
  const s = name.toLowerCase(), m = 0x5bd1e995
  let h = (0x53524332 ^ s.length) >>> 0, i = 0, l = s.length
  const c = (k: number) => s.charCodeAt(k) & 255
  for (; l >= 4; i += 4, l -= 4) {
    let x = c(i) | (c(i + 1) << 8) | (c(i + 2) << 16) | (c(i + 3) << 24)
    x = Math.imul(x, m); x ^= x >>> 24; x = Math.imul(x, m)
    h = Math.imul(h, m) ^ x
  }
  if (l === 3) h ^= c(i + 2) << 16
  if (l >= 2) h ^= c(i + 1) << 8
  if (l >= 1) { h ^= c(i); h = Math.imul(h, m) }
  h ^= h >>> 13; h = Math.imul(h, m); h ^= h >>> 15
  return h >>> 0
}

export interface CS3DInput {
  matchId: string; map: string; tickrate: number
  players: Player3D[]
  skins: Skin3D[]
  rounds: Round3DIn[]
  events: Event3D[]; shots: Shot3D[]; nades: Nade3D[]; voice: VoicePacket3D[]
  /** ab v6; fehlt = keine */
  drops?: Drop3D[]; sounds?: Sound3D[]
}

// ---------------------------------------------------------------- Dekodiert (Renderer)

export interface CS3DHeader {
  magic: 'CS3D'; version: number; matchId: string; map: string; tickrate: number; frameStep: number; angleStep: number
  players: Player3D[]
  /** alle vorkommenden item_def_idx (Waffenmodelle vorladen) */
  weapons: number[]
  /** Kanal skin = Index + 1 (v2: leer) */
  skins: Skin3D[]
  strings: string[]
  /** ab v6: soundHash je Server-Sound-Art, snd.ev = Index hierein (fehlt = keine) */
  sounds?: number[]
  rounds: { num: number; firstTick: number; nFrames: number; tracks: number[] }[]
  sections: { name: string; type: SecType; offset: number; length: number }[]
}
/**
 * Kanäle kanal-major über alle Runden: Track k (Spieler header.rounds[r].tracks[k]) von Runde r liegt bei
 * frameBase[r] + k·nFrames (16 Hz) bzw. angleBase[r] + k·(2·nFrames−1) (32 Hz). Bequemer: sampleTrack().
 */
export interface CS3D {
  header: CS3DHeader
  x: Float32Array; y: Float32Array; z: Float32Array; duck: Float32Array
  btnLo: Uint32Array; btnHi: Uint32Array; flags: Uint16Array; weapon: Uint16Array; fov: Uint8Array; ammo: Uint8Array; skin: Uint16Array
  pitch: Float32Array; yaw: Float32Array; aimP: Float32Array; aimY: Float32Array; viewP: Float32Array; viewY: Float32Array
  frameBase: number[]; angleBase: number[]
  /** nach tick sortiert */
  evt: { tick: Uint32Array; type: Uint8Array; player: Uint8Array; arg: Uint16Array }
  shot: { tick: Uint32Array; player: Uint8Array; weapon: Uint16Array; silenced: Uint8Array; recoil: Uint8Array; x: Float32Array; y: Float32Array; z: Float32Array; pitch: Float32Array; yaw: Float32Array }
  /** nach throwTick sortiert; Flugbahn von Granate i = path[pathStart[i] .. pathStart[i+1]) */
  nade: { type: Uint8Array; player: Uint8Array; throwTick: Uint32Array; detTick: Uint32Array; endTick: Uint32Array; x: Float32Array; y: Float32Array; z: Float32Array; pathStart: Uint32Array }
  path: { tick: Uint32Array; x: Float32Array; y: Float32Array; z: Float32Array }
  /** Opus-Paket i = data[start[i] .. start[i+1]); seq −1 = unbekannt. Für voice-engine: voicePackets() */
  voice: { tick: Uint32Array; seq: Int32Array; player: Uint8Array; start: Uint32Array; data: Uint8Array }
  /** liegende Waffen (Drop3D) nach tick sortiert; vor v6 leer */
  drop: {
    tick: Uint32Array; end: Uint32Array; def: Uint16Array; skin: Uint16Array; x: Float32Array; y: Float32Array; z: Float32Array; vx: Float32Array; vy: Float32Array; vz: Float32Array
    land: Uint32Array; ix: Float32Array; iy: Float32Array; iz: Float32Array; rx: Float32Array; ry: Float32Array; rz: Float32Array
  }
  /** Server-Sounds der Spieler (Sound3D) nach tick; ev = Index in header.sounds; vor v6 leer */
  snd: { tick: Uint32Array; ev: Uint16Array; player: Uint8Array }
}

// ---------------------------------------------------------------- Codec

type SecType = 'u32' | 'i32' | 'i16' | 'u16' | 'u8'
const ARR = { u32: Uint32Array, i32: Int32Array, i16: Int16Array, u16: Uint16Array, u8: Uint8Array } as const
const align4 = (n: number) => (n + 3) & ~3
const d16 = (v: number) => (v << 16) >> 16 // Delta mit Int16-Überlauf (yaw-Wrap)
const u8c = (v: number) => Math.min(255, Math.max(0, Math.round(v) || 0))
function q(v: number, s: number) {
  const n = Math.round(v * s)
  if (!Number.isFinite(n)) throw new Error(`CS3D: ungültiger Wert ${v}`)
  return n
}
// shortcut: Int16 ±16383 u reicht für alle Source-2-Maps; größere Welten bräuchten Int32-Positionen
const q16 = (v: number, s: number) => Math.max(-32768, Math.min(32767, q(v, s)))
const TRACK_KEYS = ['x', 'y', 'z', 'duck', 'btnLo', 'btnHi', 'flags', 'weapon', 'fov', 'ammo', 'skin'] as const
const ANGLE_KEYS = ['pitch', 'yaw', 'aimP', 'aimY', 'viewP', 'viewY'] as const

export function encode3d(m: CS3DInput): Uint8Array {
  const players = m.players.slice()
  const pIdx = new Map(players.map((p, i) => [p.steamid, i]))
  const speaker = (s: string) => {
    let i = pIdx.get(s)
    if (i === undefined) { i = players.length; players.push({ steamid: s, name: s, team: '', agent: { T: 0, CT: 0 } }); pIdx.set(s, i) }
    return i
  }
  const strings: string[] = [], sIdx = new Map<string, number>()
  const str = (v: string) => { let i = sIdx.get(v); if (i === undefined) { i = strings.length; strings.push(v); sIdx.set(v, i) } return i }
  const weapons = new Set<number>()

  // Spuren
  let nF = 0, nA = 0
  for (const R of m.rounds) { nF += R.nFrames * R.tracks.length; nA += (2 * R.nFrames - 1) * R.tracks.length }
  const X = new Int16Array(nF), Y = new Int16Array(nF), Z = new Int16Array(nF), DU = new Uint8Array(nF)
  const BL = new Uint32Array(nF), BH = new Uint32Array(nF), FL = new Uint16Array(nF), WP = new Uint16Array(nF), FV = new Uint8Array(nF), AM = new Uint8Array(nF), SK = new Uint16Array(nF)
  const AN = ANGLE_KEYS.map(() => new Int16Array(nA))
  let o = 0, a = 0
  for (const R of m.rounds) {
    const nAng = 2 * R.nFrames - 1
    for (const t of R.tracks) {
      for (const k of TRACK_KEYS) if (t[k].length !== R.nFrames) throw new Error(`CS3D: Runde ${R.num}, Spieler ${t.player}: ${k} hat ${t[k].length} statt ${R.nFrames} Frames`)
      for (const k of ANGLE_KEYS) if (t[k].length !== nAng) throw new Error(`CS3D: Runde ${R.num}, Spieler ${t.player}: ${k} braucht ${nAng} Werte`)
      let px = 0, py = 0, pz = 0, pd = 0
      for (let i = 0; i < R.nFrames; i++, o++) {
        const qx = q(t.x[i], POS), qy = q(t.y[i], POS), qz = q(t.z[i], POS), qd = q(t.duck[i], 255)
        X[o] = d16(qx - px); Y[o] = d16(qy - py); Z[o] = d16(qz - pz); DU[o] = (qd - pd) & 255
        px = qx; py = qy; pz = qz; pd = qd
        BL[o] = t.btnLo[i]; BH[o] = t.btnHi[i]; FL[o] = t.flags[i]; WP[o] = t.weapon[i]; FV[o] = u8c(t.fov[i]); AM[o] = u8c(t.ammo[i])
        if (t.skin[i] > m.skins.length) throw new Error(`CS3D: Runde ${R.num}, Spieler ${t.player}: skin ${t.skin[i]} ohne Eintrag in skins`)
        SK[o] = t.skin[i]
        if (t.weapon[i]) weapons.add(t.weapon[i])
      }
      ANGLE_KEYS.forEach((k, c) => {
        let pv = 0
        for (let i = 0; i < nAng; i++) { const qv = q(t[k][i], ANG); AN[c][a + i] = d16(qv - pv); pv = qv }
      })
      a += nAng
    }
  }

  const ev = [...m.events].sort((p, r) => p.tick - r.tick)
  const sh = [...m.shots].sort((p, r) => p.tick - r.tick)
  const nd = [...m.nades].sort((p, r) => p.throwTick - r.throwTick)
  const pts = nd.flatMap(n => n.path)
  const vo = [...m.voice].sort((p, r) => p.tick - r.tick)
  const vdata = new Uint8Array(vo.reduce((s, p) => s + p.opus.length, 0))
  vo.reduce((off, p) => (vdata.set(p.opus, off), off + p.opus.length), 0)
  const dr = [...m.drops ?? []].sort((p, r) => p.tick - r.tick)
  const sn = [...m.sounds ?? []].sort((p, r) => p.tick - r.tick), sounds: number[] = [], sndIdx = new Map<number, number>()
  const sndOf = (h: number) => { let i = sndIdx.get(h); if (i === undefined) { sndIdx.set(h, (i = sounds.length)); sounds.push(h) } return i }
  for (const s of sh) weapons.add(s.weapon)
  for (const x of dr) weapons.add(x.def) // Weltmodell auch für nie gehaltene Waffen (Tod mit Primärwaffe im Rucksack)
  const col = <T>(list: T[], type: SecType, f: (v: T) => number) => { const c = new ARR[type](list.length); list.forEach((v, i) => (c[i] = f(v))); return c }

  const parts: [string, SecType, ArrayBufferView][] = [
    ['x', 'i16', X], ['y', 'i16', Y], ['z', 'i16', Z], ['duck', 'u8', DU],
    ['btnLo', 'u32', BL], ['btnHi', 'u32', BH], ['flags', 'u16', FL], ['weapon', 'u16', WP], ['fov', 'u8', FV], ['ammo', 'u8', AM], ['skin', 'u16', SK],
    ...ANGLE_KEYS.map((k, c) => [k, 'i16', AN[c]] as [string, SecType, ArrayBufferView]),
    ['evt.tick', 'u32', col(ev, 'u32', e => e.tick)], ['evt.type', 'u8', col(ev, 'u8', e => e.type)],
    ['evt.player', 'u8', col(ev, 'u8', e => e.player)],
    ['evt.arg', 'u16', col(ev, 'u16', e => typeof e.arg === 'string' ? str(e.arg) : e.arg)],
    ['shot.tick', 'u32', col(sh, 'u32', s => s.tick)], ['shot.player', 'u8', col(sh, 'u8', s => s.player)],
    ['shot.weapon', 'u16', col(sh, 'u16', s => s.weapon)], ['shot.silenced', 'u8', col(sh, 'u8', s => +s.silenced)],
    ['shot.recoil', 'u8', col(sh, 'u8', s => u8c(s.recoil))],
    ['shot.x', 'i16', col(sh, 'i16', s => q16(s.x, POS))], ['shot.y', 'i16', col(sh, 'i16', s => q16(s.y, POS))], ['shot.z', 'i16', col(sh, 'i16', s => q16(s.z, POS))],
    ['shot.pitch', 'i16', col(sh, 'i16', s => d16(q(s.pitch, ANG)))], ['shot.yaw', 'i16', col(sh, 'i16', s => d16(q(s.yaw, ANG)))],
    ['nade.type', 'u8', col(nd, 'u8', n => n.type)], ['nade.player', 'u8', col(nd, 'u8', n => n.player)],
    ['nade.throwTick', 'u32', col(nd, 'u32', n => n.throwTick)], ['nade.detTick', 'u32', col(nd, 'u32', n => n.detTick)], ['nade.endTick', 'u32', col(nd, 'u32', n => n.endTick)],
    ['nade.x', 'i16', col(nd, 'i16', n => q16(n.x, POS))], ['nade.y', 'i16', col(nd, 'i16', n => q16(n.y, POS))], ['nade.z', 'i16', col(nd, 'i16', n => q16(n.z, POS))],
    ['nade.pathLen', 'u32', col(nd, 'u32', n => n.path.length)],
    ['path.tick', 'u32', col(pts, 'u32', p => p[0])],
    ['path.x', 'i16', col(pts, 'i16', p => q16(p[1], POS))], ['path.y', 'i16', col(pts, 'i16', p => q16(p[2], POS))], ['path.z', 'i16', col(pts, 'i16', p => q16(p[3], POS))],
    ['voice.tick', 'u32', col(vo, 'u32', p => p.tick)], ['voice.seq', 'i32', col(vo, 'i32', p => p.seq ?? -1)],
    ['voice.player', 'u8', col(vo, 'u8', p => speaker(p.steamid))], ['voice.len', 'u32', col(vo, 'u32', p => p.opus.length)],
    ['voice.data', 'u8', vdata],
    ['drop.tick', 'u32', col(dr, 'u32', x => x.tick)], ['drop.end', 'u32', col(dr, 'u32', x => x.end)],
    ['drop.def', 'u16', col(dr, 'u16', x => x.def)], ['drop.skin', 'u16', col(dr, 'u16', x => x.skin)],
    ['drop.x', 'i16', col(dr, 'i16', x => q16(x.x, POS))], ['drop.y', 'i16', col(dr, 'i16', x => q16(x.y, POS))], ['drop.z', 'i16', col(dr, 'i16', x => q16(x.z, POS))],
    ['drop.vx', 'i16', col(dr, 'i16', x => q16(x.vx, 1))], ['drop.vy', 'i16', col(dr, 'i16', x => q16(x.vy, 1))], ['drop.vz', 'i16', col(dr, 'i16', x => q16(x.vz, 1))],
    ['drop.land', 'u32', col(dr, 'u32', x => x.land)],
    ...(['ix', 'iy', 'iz', 'rx', 'ry', 'rz'] as const).map(k => [`drop.${k}`, 'i16', col(dr, 'i16', x => q16(x[k], POS))] as [string, SecType, ArrayBufferView]),
    ['snd.tick', 'u32', col(sn, 'u32', s => s.tick)], ['snd.ev', 'u16', col(sn, 'u16', s => sndOf(s.hash))], ['snd.player', 'u8', col(sn, 'u8', s => s.player)],
  ]
  parts.sort((p, r) => ARR[r[1]].BYTES_PER_ELEMENT - ARR[p[1]].BYTES_PER_ELEMENT) // stabil
  const sections: CS3DHeader['sections'] = []
  let off = 0
  for (const [name, type, arr] of parts) { sections.push({ name, type, offset: off, length: arr.byteLength / ARR[type].BYTES_PER_ELEMENT }); off += arr.byteLength }
  const header: CS3DHeader = {
    magic: 'CS3D', version: CS3D_VERSION, matchId: m.matchId, map: m.map, tickrate: m.tickrate, frameStep: FRAME_STEP, angleStep: ANGLE_STEP,
    players, weapons: [...weapons].filter(w => w > 0).sort((p, r) => p - r), skins: m.skins, strings, sounds,
    rounds: m.rounds.map(R => ({ num: R.num, firstTick: R.firstTick, nFrames: R.nFrames, tracks: R.tracks.map(t => t.player) })),
    sections,
  }
  const hj = new TextEncoder().encode(JSON.stringify(header))
  const base = align4(4 + hj.length)
  const out = new Uint8Array(base + off)
  new DataView(out.buffer).setUint32(0, hj.length, true)
  out.set(hj, 4)
  for (let i = 0; i < parts.length; i++) {
    const arr = parts[i][2]
    out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), base + sections[i].offset)
  }
  return out
}

/** buf = entpackte Datei. Ein Uint8Array mit krummem byteOffset (Node-Buffer-Pool) wird einmal kopiert. */
export function decode3d(buf: ArrayBuffer | Uint8Array): CS3D {
  let u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (u8.byteOffset % 4) u8 = u8.slice()
  const ab = u8.buffer as ArrayBuffer, at = u8.byteOffset
  const hl = new DataView(ab, at).getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, at + 4, hl))) as CS3DHeader
  if (header.magic !== 'CS3D' || ![2, 3, 4, 5, 6, CS3D_VERSION].includes(header.version)) throw new Error(`CS3D: unbekanntes Format (${header.magic} v${header.version})`)
  header.skins ??= [] // v2
  header.sounds ??= [] // vor v6
  const base = at + align4(4 + hl)
  const S: Record<string, any> = {}
  for (const s of header.sections) S[s.name] = new ARR[s.type](ab, base + s.offset, s.length)

  const frameBase: number[] = [], angleBase: number[] = []
  let nF = 0, nA = 0
  for (const R of header.rounds) { frameBase.push(nF); angleBase.push(nA); nF += R.nFrames * R.tracks.length; nA += (2 * R.nFrames - 1) * R.tracks.length }
  const x = new Float32Array(nF), y = new Float32Array(nF), z = new Float32Array(nF), duck = new Float32Array(nF)
  const [pitch, yaw, aimP, aimY, viewP, viewY] = ANGLE_KEYS.map(() => new Float32Array(nA))
  let o = 0, a = 0
  for (const R of header.rounds) for (let k = 0; k < R.tracks.length; k++) {
    let qx = 0, qy = 0, qz = 0, qd = 0
    for (let i = 0; i < R.nFrames; i++, o++) {
      qx += S.x[o]; qy += S.y[o]; qz += S.z[o]; qd = (qd + S.duck[o]) & 255
      x[o] = qx / POS; y[o] = qy / POS; z[o] = qz / POS; duck[o] = qd / 255
    }
    const nAng = 2 * R.nFrames - 1
    ;[pitch, yaw, aimP, aimY, viewP, viewY].forEach((out, c) => {
      const src = S[ANGLE_KEYS[c]] // v2/v3: kein Punch → 0
      for (let i = 0, qv = 0; src && i < nAng; i++) { qv += src[a + i]; out[a + i] = qv / ANG }
    })
    a += nAng
  }
  const f32 = (v: Int16Array = new Int16Array(0), s: number) => Float32Array.from(v, n => n / s)
  const prefix = (len: Uint32Array) => { const p = new Uint32Array(len.length + 1); for (let i = 0; i < len.length; i++) p[i + 1] = p[i] + len[i]; return p }
  return {
    header, x, y, z, duck, pitch, yaw, aimP, aimY, viewP, viewY, frameBase, angleBase,
    btnLo: S.btnLo, btnHi: S.btnHi, flags: S.flags, weapon: S.weapon, fov: S.fov, ammo: S.ammo, skin: S.skin ?? new Uint16Array(nF),
    evt: { tick: S['evt.tick'], type: S['evt.type'], player: S['evt.player'], arg: S['evt.arg'] },
    shot: {
      tick: S['shot.tick'], player: S['shot.player'], weapon: S['shot.weapon'], silenced: S['shot.silenced'], recoil: S['shot.recoil'],
      x: f32(S['shot.x'], POS), y: f32(S['shot.y'], POS), z: f32(S['shot.z'], POS), pitch: f32(S['shot.pitch'], ANG), yaw: f32(S['shot.yaw'], ANG),
    },
    nade: {
      type: S['nade.type'], player: S['nade.player'], throwTick: S['nade.throwTick'], detTick: S['nade.detTick'], endTick: S['nade.endTick'],
      x: f32(S['nade.x'], POS), y: f32(S['nade.y'], POS), z: f32(S['nade.z'], POS), pathStart: prefix(S['nade.pathLen']),
    },
    path: { tick: S['path.tick'], x: f32(S['path.x'], POS), y: f32(S['path.y'], POS), z: f32(S['path.z'], POS) },
    voice: { tick: S['voice.tick'], seq: S['voice.seq'], player: S['voice.player'], start: prefix(S['voice.len']), data: S['voice.data'] },
    drop: {
      tick: S['drop.tick'] ?? new Uint32Array(0), end: S['drop.end'] ?? new Uint32Array(0), def: S['drop.def'] ?? new Uint16Array(0), skin: S['drop.skin'] ?? new Uint16Array(0),
      x: f32(S['drop.x'], POS), y: f32(S['drop.y'], POS), z: f32(S['drop.z'], POS), vx: f32(S['drop.vx'], 1), vy: f32(S['drop.vy'], 1), vz: f32(S['drop.vz'], 1),
      land: S['drop.land'] ?? new Uint32Array(0), ix: f32(S['drop.ix'], POS), iy: f32(S['drop.iy'], POS), iz: f32(S['drop.iz'], POS),
      rx: f32(S['drop.rx'], POS), ry: f32(S['drop.ry'], POS), rz: f32(S['drop.rz'], POS),
    },
    snd: { tick: S['snd.tick'] ?? new Uint32Array(0), ev: S['snd.ev'] ?? new Uint16Array(0), player: S['snd.player'] ?? new Uint8Array(0) },
  }
}

// ---------------------------------------------------------------- Abfragen (gemeinsam für Engine, Effekte, Audio, HUD)

/** erster Index mit arr[i] > v (arr aufsteigend), z. B. Events bis zum aktuellen Tick */
export function upperBound(arr: ArrayLike<number>, v: number): number {
  let lo = 0, hi = arr.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m }
  return lo
}

/** Runden-Index mit Daten für tick, −1 zwischen den Runden */
export function roundAt(d: CS3D, tick: number): number {
  const R = d.header.rounds
  for (let r = R.length - 1; r >= 0; r--) if (tick >= R[r].firstTick) return tick <= R[r].firstTick + (R[r].nFrames - 1) * d.header.frameStep ? r : -1
  return -1
}

/**
 * Granate für die Granaten-Kamera: im Flug oder höchstens holdS nach der Detonation, die jüngste von Spieler-Index focus,
 * sonst die jüngste (höchstens lookS zurück); −1 = keine. Engine (nadecam.ts) und HUD-Rahmen nutzen dieselbe Wahl.
 */
export function nadeInFlight(d: CS3D, tick: number, focus = -1, holdS = 1, lookS = 20): number {
  const r = roundAt(d, tick), N = d.nade, rate = d.header.tickrate
  if (r < 0) return -1
  const from = Math.max(d.header.rounds[r].firstTick, tick - lookS * rate)
  let best = -1
  for (let i = upperBound(N.throwTick, tick) - 1; i >= 0 && N.throwTick[i] >= from; i--) {
    if (tick > N.detTick[i] + holdS * rate || N.pathStart[i + 1] - N.pathStart[i] < 2) continue
    if (N.player[i] === focus) return i
    if (best < 0) best = i
  }
  return best
}

/** uniform Catmull-Rom */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}
/** Kanalwert bei gebrochenem Tick; base/n = Track-Start/Anzahl, step = 4 (16 Hz) oder 2 (32 Hz); Sprung > teleport wird nicht interpoliert */
export function sampleCR(arr: Float32Array, base: number, n: number, firstTick: number, step: number, tick: number, teleport = Infinity): number {
  const f = (tick - firstTick) / step
  const i1 = Math.max(0, Math.min(n - 1, Math.floor(f))), i2 = Math.min(n - 1, i1 + 1)
  const t = i1 === i2 ? 0 : Math.max(0, Math.min(1, f - i1)) // nach dem letzten Frame halten (Catmull-Rom mit p1 = p2 schwingt sonst über)
  const v1 = arr[base + i1], v2 = arr[base + i2]
  if (Math.abs(v2 - v1) > teleport) return t < 0.5 ? v1 : v2
  let v0 = arr[base + Math.max(0, i1 - 1)], v3 = arr[base + Math.min(n - 1, i2 + 1)]
  // Nachbar hinter einem Sprung → linear fortsetzen (sonst überschwingt das Segment davor/danach um ~6 % des Sprungs)
  if (Math.abs(v1 - v0) > teleport) v0 = 2 * v1 - v2
  if (Math.abs(v3 - v2) > teleport) v3 = 2 * v2 - v1
  return catmullRom(v0, v1, v2, v3, t)
}

export interface TrackSample {
  x: number; y: number; z: number; duck: number
  /** Grad; yaw stetig (nicht auf ±180 gefaltet) → direkt als Rotation nutzbar */
  pitch: number; yaw: number
  /** Rückstoß in Grad (Track3DIn.aimP …) */
  aimP: number; aimY: number; viewP: number; viewY: number
  /** u/s aus Positionsdifferenz (velocity-Props sind bei 16 Hz unbrauchbar) */
  vx: number; vy: number; vz: number
  btnLo: number; btnHi: number; flags: number; weapon: number; fov: number; ammo: number; skin: number
}
export const newSample = (): TrackSample => ({ x: 0, y: 0, z: 0, duck: 0, pitch: 0, yaw: 0, aimP: 0, aimY: 0, viewP: 0, viewY: 0, vx: 0, vy: 0, vz: 0, btnLo: 0, btnHi: 0, flags: 0, weapon: 0, fov: 0, ammo: 0, skin: 0 })

/** Zustand von Track k in Runde r bei gebrochenem Tick: Position/Winkel Catmull-Rom, duck/Geschwindigkeit linear, Rest = Frame floor(f). Schreibt in out. */
export function sampleTrack(d: CS3D, r: number, k: number, tick: number, out: TrackSample): TrackSample {
  const R = d.header.rounds[r], n = R.nFrames, step = d.header.frameStep
  const fb = d.frameBase[r] + k * n, ab = d.angleBase[r] + k * (2 * n - 1)
  out.x = sampleCR(d.x, fb, n, R.firstTick, step, tick, TELEPORT)
  out.y = sampleCR(d.y, fb, n, R.firstTick, step, tick, TELEPORT)
  out.z = sampleCR(d.z, fb, n, R.firstTick, step, tick, TELEPORT)
  out.pitch = sampleCR(d.pitch, ab, 2 * n - 1, R.firstTick, d.header.angleStep, tick)
  out.yaw = sampleCR(d.yaw, ab, 2 * n - 1, R.firstTick, d.header.angleStep, tick)
  out.aimP = sampleCR(d.aimP, ab, 2 * n - 1, R.firstTick, d.header.angleStep, tick)
  out.aimY = sampleCR(d.aimY, ab, 2 * n - 1, R.firstTick, d.header.angleStep, tick)
  out.viewP = sampleCR(d.viewP, ab, 2 * n - 1, R.firstTick, d.header.angleStep, tick)
  out.viewY = sampleCR(d.viewY, ab, 2 * n - 1, R.firstTick, d.header.angleStep, tick)
  const f = Math.max(0, Math.min(n - 1, (tick - R.firstTick) / step)), i1 = Math.floor(f), i2 = Math.min(n - 1, i1 + 1), t = f - i1
  const i = fb + i1
  out.duck = d.duck[i] + (d.duck[fb + i2] - d.duck[i]) * t
  const vel = (arr: Float32Array, j: number) => {
    const p = Math.max(0, j - 1), q2 = Math.min(n - 1, j + 1), dv = arr[fb + q2] - arr[fb + p]
    return q2 === p || Math.abs(dv) > TELEPORT ? 0 : (dv * d.header.tickrate) / ((q2 - p) * step)
  }
  out.vx = vel(d.x, i1) + (vel(d.x, i2) - vel(d.x, i1)) * t
  out.vy = vel(d.y, i1) + (vel(d.y, i2) - vel(d.y, i1)) * t
  out.vz = vel(d.z, i1) + (vel(d.z, i2) - vel(d.z, i1)) * t
  out.btnLo = d.btnLo[i]; out.btnHi = d.btnHi[i]; out.flags = d.flags[i]; out.weapon = d.weapon[i]; out.fov = d.fov[i]; out.ammo = d.ammo[i]; out.skin = d.skin[i]
  return out
}

/** Rest der Blendung in s: blind_duration des letzten player_blind des Spielers (10-s-Fenster) minus vergangene Zeit, 0 = keine */
export function flashLeft(d: CS3D, player: number, tick: number): number {
  const T = d.evt.tick, rate = d.header.tickrate
  for (let i = upperBound(T, tick) - 1; i >= 0 && tick - T[i] < 10 * rate; i--)
    if (d.evt.type[i] === EV.player_blind && d.evt.player[i] === player) return Math.max(0, d.evt.arg[i] / 100 - (tick - T[i]) / rate)
  return 0
}

/** Blend-Stärke 0..1 eines Spielers (CS:GO-Formel: voll = ganz weiß bis 3 s Rest, dann linear aus — für CS2 nicht verifiziert) */
export function flashAt(d: CS3D, player: number, tick: number): number {
  const rest = flashLeft(d, player, tick)
  return rest > 3 ? 1 : rest / 3
}

/** Voice-Pakete im Format von voice-engine.layoutVoice (Opus als Sicht, keine Kopie) */
export function voicePackets(d: CS3D): VoicePacket3D[] {
  const V = d.voice, P = d.header.players
  return Array.from(V.tick, (tick, i) => ({ tick, steamid: P[V.player[i]].steamid, opus: V.data.subarray(V.start[i], V.start[i + 1]), seq: V.seq[i] >= 0 ? V.seq[i] : undefined }))
}
