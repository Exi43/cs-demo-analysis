// Datenformat einer eingelesenen Demo. Wird im Parser erzeugt und im UI gelesen.

export type Side = 'T' | 'CT'
export type BuyType = 'pistol' | 'eco' | 'force' | 'full'
export type NadeType = 'smoke' | 'flash' | 'he' | 'molotov' | 'decoy'

export interface PlayerInfo {
  steamid: string
  name: string
  /** Teamname aus der Demo (FACEIT: "team_<name>") */
  team: string
}

export interface Kill {
  tick: number
  attacker?: string // steamid; fehlt bei Weltschaden/Selbstmord
  victim: string
  assister?: string
  flashAssist: boolean
  weapon: string
  headshot: boolean
  wallbang: boolean
  throughSmoke: boolean
  attackerBlind: boolean
  noscope: boolean
  attackerPos?: [number, number, number]
  victimPos: [number, number, number]
  victimPlace: string
  attackerPlace?: string
  /** Wurde der Tod innerhalb von 5 s vom Team gerächt? (im Parser berechnet) */
  traded: boolean
  /** Ist dieser Kill eine Rache für einen Teamkollegen? */
  isTrade: boolean
}

export interface Damage {
  tick: number
  attacker?: string
  victim: string
  dmg: number // tatsächlicher HP-Schaden, auf verbleibende HP gekappt
  weapon: string
  utility: boolean
}

export interface Blind {
  tick: number
  attacker: string
  victim: string
  duration: number
  team: boolean // Teamflash
}

export interface Nade {
  id: number
  type: NadeType
  thrower: string
  throwTick: number
  /** Detonation (Smoke/Molly: Start der Wirkung) */
  detTick: number
  /** Ende der Wirkung (Smoke weg, Feuer aus) */
  endTick: number
  /** Flugbahn: [tick, x, y, z] */
  path: [number, number, number, number][]
  throwPlace: string
  landPlace: string
}

export interface BombEvent {
  tick: number
  player: string
  site?: 'A' | 'B'
  pos: [number, number, number]
}

/** Position aller Spieler in einem Frame, struct-of-arrays pro Spieler */
export interface PlayerTrack {
  steamid: string
  side: Side
  x: number[]
  y: number[]
  z: number[]
  yaw: number[]
  hp: number[]
  armor: number[]
  /** Index in Round.weapons */
  weapon: number[]
  /** Index in Round.places */
  place: number[]
  flash: number[] // verbleibende Blendung in s*10
  money: number[]
  defuser: boolean
  helmet: boolean
  /** Equipment-Wert bei Freezetime-Ende */
  equipValue: number
  /** Inventar bei Freezetime-Ende */
  inventory: string[]
}

export interface Round {
  num: number // 1-basiert
  startTick: number
  freezeEndTick: number
  endTick: number
  winner: Side
  reason: string
  /** Teamname der jeweiligen Seite in dieser Runde */
  teamOnSide: Record<Side, string>
  buy: Record<Side, BuyType>
  equipValue: Record<Side, number>
  scoreBefore: Record<Side, number>
  plant?: BombEvent
  defuse?: BombEvent
  exploded?: number
  /** Ticks der Frames (alle FRAME_STEP Ticks) */
  frameTicks: number[]
  tracks: PlayerTrack[]
  weapons: string[]
  places: string[]
  kills: Kill[]
  damages: Damage[]
  blinds: Blind[]
  nades: Nade[]
}

export interface MatchData {
  version: number
  id: string
  fileName: string
  map: string
  parsedAt: string
  tickrate: number
  serverName: string
  players: PlayerInfo[]
  teams: string[] // genau 2
  finalScore: Record<string, number>
  rounds: Round[]
}

export interface MatchSummary {
  id: string
  fileName: string
  map: string
  parsedAt: string
  teams: string[]
  finalScore: Record<string, number>
  rounds: number
  players: PlayerInfo[]
}

export const DATA_VERSION = 1
export const FRAME_STEP = 4 // 64 Tick / 4 = 16 Frames pro Sekunde
