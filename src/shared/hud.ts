// HUD-Zusatzdaten des 3D-Replays (Übertragungs-HUD): was v1 (MatchData) und CS3D nicht haben.
// Datei <matchId>.hud.json.gz neben <matchId>.3d.bin.gz; Parser-Prozess schreibt sie beim Import (src/main/parsehud.ts),
// main liest sie per IPC 'match:loadHud' (gunzip + JSON, fehlt → null = alter Import, HUD nutzt dann Ersatzwerte).
// Listen speichern nur Änderungen, aufsteigend nach Tick (Abtastung alle 16 Ticks in den Rundenfenstern). Reines TS, kein DOM.

export const HUD_VERSION = 1

/** Spieler einer Runde (Schlüssel steamid in HudRound.players) */
export interface HudRoundPlayer {
  /** inventory_as_ids; Granaten-Duplikate bleiben (43, 43 = 2 Flashbangs) */
  inv: [tick: number, defs: number[]][]
  helmet: [tick: number, on: 0 | 1][]
  kit: [tick: number, on: 0 | 1][]
  buyzone: [tick: number, on: 0 | 1][]
  /** total_ammo_left je Waffe (def); Startwert 0 der Demo ist schon durch das vdata-Maximum ersetzt */
  reserve: [tick: number, def: number, n: number][]
}
export interface HudRound {
  /** v1 Round.num */
  num: number
  /** buytime_ended; −1 = Event fehlt (HUD: Freeze-Ende + 20 s) */
  buyEndTick: number
  players: Record<string, HudRoundPlayer>
}
/** player_hurt; health = HP danach (dmg_health ist ungenau → HP-Verlust = HP davor − health) */
export interface HudHurt { tick: number; victim: string; attacker: string | null; dmg: number; health: number }

export interface HudTrack {
  version: number
  /** steamid → user_id (Controller-Slot 0–9) für die Slot-Nummern 1–5 / 6–0 */
  slots: Record<string, number>
  rounds: HudRound[]
  /** nach tick sortiert */
  hurt: HudHurt[]
}

/** letzter Eintrag mit Tick ≤ tick (Binärsuche über [tick, …]-Listen), undefined = noch keiner */
export function at<T extends readonly [number, ...unknown[]]>(list: readonly T[], tick: number): T | undefined {
  let lo = 0, hi = list.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m][0] <= tick) lo = m + 1; else hi = m }
  return list[lo - 1]
}

/** steamid → Bild-URL (cs3d://assets3d/avatars/<id>.jpg?v=…) oder null (Bot, offline, Fehler → Initialen) */
export type Avatars = Record<string, string | null>

/**
 * IPC 'hud:assets': CS2-Icons und Stratum2-Schriften aus der lokalen Installation (userData/assets3d/hud/<patch>/, nie im Repo).
 * icons: Name wie im Panorama-Ordner mit Präfix, z. B. 'eq/ak47', 'ui/kill', 'hud/deathnotice/icon_headshot' → URL.
 */
export interface HudAssetManifest {
  patch: string
  icons: Record<string, string>
  fonts: { family: string; weight: number; style: string; url: string }[]
}
