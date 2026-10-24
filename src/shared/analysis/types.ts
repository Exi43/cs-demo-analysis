// Kontrakt der Pro-Analyse (Anti-Strat pro Gegner + Map). Gemeinsame Typen fuer analysis/**, Text-Export und ReportView.
// Kommentar [id] = Gliederungs-ID aus methodik/gliederung-textbausteine.json (Spike proanalyse), die das Feld fuellt.
import type { Side } from '../model.ts'
import type { Ref } from './rounds.ts'

/** Icon-Token im Text als :name: (UI ersetzt durch Icon/Weapon; warn = neues Care-Icon) */
export type IconToken = 'smoke' | 'flash' | 'molly' | 'he' | 'awp' | 'deagle' | 'c4' | 'kit' | 'knife' | 'target' | 'arrow' | 'shuffle' | 'layers' | 'clock' | 'bolt' | 'star' | 'check' | 'x' | 'warn'
export type TagKind = 'HABIT' | 'PATTERN' | 'ONCE'
/** n von N passenden Runden (HABIT n >= 3, PATTERN n = 2, ONCE n = 1) */
export interface Tag { kind: TagKind; n: number; N: number }
/** Eine Aussage: Text mit **fett** und :icon:-Tokens; refs = Beleg-Runden; stat = Siegquote im Muster (fuer Keys-Ranking).
 *  Reine Runden-Listen stehen nur in refs, das Tag nur in tag, der Konter nur in counter (UI/Markdown setzen sie dazu). */
export interface Line { icon?: IconToken; text: string; tag?: Tag; refs: Ref[]; stat?: { won: number; total: number }; counter?: string }
export type BuyClass = 'pistol' | 'second' | 'eco' | 'deagle' | 'smg' | 'light' | 'full'
export type PlayKind = 'default' | 'execute' | 'rush' | 'split' | 'fake' | 'hit'
/** [t.plays] ein Spielzug ueber mehrere Runden. buys parallel zu refs; hitSecs = Sekunden ab Freeze-Ende (nur Runden mit Hit) */
export interface Play {
  id: string; name: string; site: 'A' | 'B'; kinds: PlayKind[]; won: number; total: number; tag: Tag; refs: Ref[]; buys: BuyClass[]; hitSecs: number[]
  timeline: Line; roles: Line[]; read?: Line; care?: Line; counter?: Line
}
/** [t.heatmap] Spalten = 15-s-Buckets als Uhr ('1:30–1:15'); play = Zeilen-Label wie im Text ('T1 Xbox → short A'); cells[i] = Runden in Bucket i */
export interface Heatmap { buckets: string[]; rows: { play: string; cells: Ref[][] }[] }
/** [ct.utilSignature] eine Zeile der Util-Tabelle; fromSec/toSec ab Freeze-Ende; nade = Typen der ersten Wuerfe nach Haeufigkeit; throwers = Anzeigenamen oder Rolle ('B player') */
export interface UtilRow { fromSec: number; toSec: number; nade: IconToken[];target: string; throwers: string[]; tag: Tag; refs: Ref[] }
/** [ct.pushes] push = in der T-Haelfte, forward = frueh auf umkaempftem Callout; players = Anzeigenamen */
export interface PushRow { level: 'push' | 'forward'; place: string; players: string[]; refs: Ref[]; kills: number; deaths: number }
/** [roster] t/ct = Rolle bzw. Spot als Kurztext mit :icon:-Tokens; watch = eine Gewohnheit */
export interface RosterRow { steamid: string; name: string; rating: number; kills: number; deaths: number; adr: number; t: string; ct: string; watch?: Line }
/** [roundList] Sicht des analysierten Teams: side/buyThem/won = sie, buyUs = wir; plant = 'A 1:11' */
export interface RoundRow { ref: Ref; side: Side; buyThem: BuyClass; buyUs: BuyClass; play: string; plant?: string; won: boolean }
/** Abschnitt mit Titel (Pistol, 2. Runde, Forces); Konter haengen als counter an den Zeilen */
export interface Block { title: string; lines: Line[]; refs: Ref[] }

/** [t] ihre T-Seite */
export interface TSide {
  overview: Line[] // [t.overview] Plants/Planter, erster Kontakt, Hit-/Plant-Zeiten, Lurk
  heatmap: Heatmap // [t.heatmap]
  plays: Play[] // [t.plays]
  reads: Line[] // [t.plays] Read-Zeilen (Indikator → Folge) ausserhalb eines Spielzugs, z. B. Runden ohne Hit
  awp: Line[] // [t.awp]
  pistol: Block[] // [t.pistol]
  second?: Block // [t.second]
  force: Block[] // [t.force]
}
/** [ct] ihre CT-Seite */
export interface CTSide {
  overview: Line[] // [ct.overview] Opening → Rundensieg, Push-Quote
  utilSignature: UtilRow[] // [ct.utilSignature]
  setups: Line[] // [ct.overview] Setup-Zahlen A-Mid-B bei 1:40
  spots: Line[] // [ct.spots]
  awp: Line[] // [ct.awp]
  pushes: PushRow[] // [ct.pushes]
  rotations: Line[] // [ct.rotations]
  retakes: Line[] // [ct.overview] Retakes W/L pro Site, gestaffelt, Retake-Held
  pistol: Block[] // [ct.pistol]
  second?: Block // [ct.secondThird]
  forces: Block[] // [ct.forces]
}
export interface AntiStrat {
  team: string; map: string; demos: number; rounds: number // [header]
  /** [header] wie TeamReport: us = analysiertes Team, them = Gegner in der Demo */
  results: { opponent: string; us: number; them: number }[]
  sides: Record<Side, { won: number; total: number }> // [header] Seiten-Bilanz
  keys: Line[] // [keys] genau 3, gerankt
  roster: RosterRow[] // [roster]
  t: TSide; ct: CTSide // [t] [ct]
  economy: Line[] // [economy]
  worked: Line[] // [opponentView] was fuer uns funktioniert hat
  gameplan: { ourT: Line[]; ourCT: Line[] } // [gameplan]
  roundList: RoundRow[] // [roundList]
  limits: string[] // [limits]
  names: Record<string, string> // steamid → Name (Hilfsfeld, keine Gliederungs-ID)
}

/** Zusatzfelder fuer TRound/CTRound (aus erkennung proto.ts TPlay/CTPlay), P3 implementiert: TRound extends TRoundPro */
export interface Util { thrower: string; side: Side; type: 'smoke' | 'flash' | 'he' | 'molotov'; sec: number; from: string; to: string; lane: string; name: string; named: boolean; land: [number, number, number] }
export interface TRoundPro {
  tags: string[]; label: string; entries: { id: string; sec: number; lane: string }[]; entry?: string; lurkersPro: string[]; support: string[]; awp: string[]
  lanes20: Record<string, string[]>; util: Util[]; execUtil: Util[]; fakeUtil: Util[]
  firstContact?: { sec: number; place: string; lane: string; tDealt: boolean }; midT?: number
  plantInfo?: { sec: number; site?: 'A' | 'B'; player: string; tAlive: number; ctAlive: number; postPlant: string; retake: 'won-defuse' | 'won-kills' | 'lost' | 'save' | 'no-ct'; retakers: string[] }
  sig: string[]
}
export interface CTRoundPro {
  pos15: Record<string, string>; pos25: Record<string, string>; setup15: string; awpSpot: { id: string; place: string }[]
  aggression: { id: string; place: string; sec: number; level: 'push' | 'forward'; kills: number; died: boolean }[]
  rotations: { id: string; from: string; startSec: number; arriveSec?: number; vsHit: number; lastHold: number }[]
  util: Util[]
}
