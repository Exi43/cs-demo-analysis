// Ansicht des Übertragungs-HUDs (Entwurf v2, mockup-v2.html + data-v2.js): hud/state.ts baut sie als reine Funktion aus v1 + CS3D +
// HudTrack (hudView, höchstens 15×/s), die Komponenten zeigen sie nur an. Feldnamen wie data-v2.js.
// Waffen und Utility als v1-Anzeigenamen ('AK-47', 'Flashbang'); Icons über weapons.tsx bzw. <HudIcon>. Sichtbarkeit: options.ts shown(el).
import type { Side } from '../../../shared/model'
import type { ButtonName } from '../../../shared/cs3d'
export type { Avatars } from '../../../shared/hud'

/** Captain = Spieler, dessen Name dem Teamnamen ohne 'team_' entspricht (Groß/Klein egal); avatar null → Initialen */
export interface Captain { steamid: string; name: string; avatar: string | null }
export interface HudTeam { name: string; captain: Captain | null }

export interface HudPlayerView {
  /** 1–10 wie im Spiel (CT 1–5 links, T 6–10 rechts; 10 wird als '0' angezeigt) */
  slot: number
  steamid: string; name: string; side: Side; alive: boolean
  hp: number; armor: number; helmet: boolean; kit: boolean; money: number
  /** bis zum Tick über das ganze Match */
  kills: number; deaths: number
  /** Kills in dieser Runde (Sterne) */
  roundKills: number
  /** aktive Waffe, '' = keine */
  weapon: string
  /** Hauptwaffe aus dem Live-Inventar, '' = keine */
  primary: string
  /** je Granate ein Eintrag (2 Flashbangs = 2 Einträge) */
  utility: string[]
  bomb: boolean
  speaking: boolean
  /** Blend-Stärke 0..1 */
  flash: number
  avatar: string | null
}

/** Panel des Fokus-Spielers unten (Bild 4 + 8); Name, Avatar und Utility aus HudPlayerView mit derselben steamid */
export interface HudPanel {
  steamid: string
  hp: number
  /** HP-Verlust der letzten 1,5 s (roter Anteil), 0 = keiner */
  hpLost: number
  /** Magazin; null = keine Schusswaffe (Messer, Granate, C4) */
  mag: number | null
  /** Reserve; null = unbekannt (alter Import ohne HudTrack) */
  reserve: number | null
  weapon: string
  /** Kauf-Symbol aktiv: in der Kaufzone und vor buytime_ended */
  buy: boolean
  money: number
  /** spricht gerade */
  voice: boolean
}

export interface KillView {
  tick: number
  /** Anzeigenamen; attacker '' = Welt/Selbstmord */
  attacker: string; attackerSide?: Side
  victim: string; victimSide: Side
  assister?: string; assisterSide?: Side
  flashAssist: boolean
  weapon: string
  hs: boolean; wallbang: boolean; smoke: boolean; blind: boolean; noscope: boolean
  /** Sekunden seit dem Kill (sichtbar 5 s) */
  ago: number
  /** Angreifer ist der Fokus-Spieler (roter Rand) */
  own: boolean
}

/** Fokus-Spieler: Tasten aus btnLo/btnHi bzw. Events (für InputsOverlay, nur bei showKeys), Scope, FOV, Blendung */
export interface HudFocus { steamid: string; keys: ButtonName[]; scoped: boolean; fov: number; flash: number }

export interface HudView {
  tick: number
  /** v1 Round.num */
  round: number
  score: Record<Side, number>
  teams: Record<Side, HudTeam>
  phase: 'freeze' | 'live' | 'planted' | 'over'
  /** Sekunden: Freeze-Rest, Rundenzeit (115 s) oder Bomben-Rest */
  clock: number
  /** left/total in s (Explosion 41,0 s nach dem Legen); nicht gelegt: left = total = 0 */
  bomb: { planted: boolean; site?: 'A' | 'B'; left: number; total: number }
  /** progress 0..1, left in s (5 s mit Kit, 10 s ohne); Abbruch über FLAG.defusing */
  defuse?: { steamid: string; kit: boolean; progress: number; left: number }
  /** "X VS Y": Lebende je Seite, ab dem ersten Tod der Runde */
  vs?: { ct: number; t: number }
  /** CT zuerst, je Seite nach slot */
  players: HudPlayerView[]
  /** null = kein Fokus-Spieler */
  panel: HudPanel | null
  /** neueste zuletzt */
  killfeed: KillView[]
  focus?: HudFocus
}

/** Ereignis-Icon auf der Zeitleiste der Demo-Leiste; kill/death aus Sicht des Fokus-Spielers */
export interface TimelineEvent {
  tick: number
  /** v1 Round.num */
  round: number
  kind: 'kill' | 'death' | 'plant' | 'defuse' | 'explode'
  /** englischer Tooltip, z. B. 'Exi killed DiiiDiii (AK-47)' */
  text: string
}
