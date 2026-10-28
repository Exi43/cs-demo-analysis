// Team-Funktionen: gemeinsamer Vertrag zwischen Team-Oberfläche (Zweig UI) und Team-Sync/Supabase (Zweig SYNC).
// Unverändert nach src/shared/team.ts kopieren; Erweiterungen in eigene Dateien, damit beide Zweige ohne Konflikt zusammengehen.
// Koordinaten wie im Utility-Dashboard: Weltkoordinaten in CS2-Einheiten (Radar-Umrechnung über resources/maps/map_data.json).
import type { Lineup } from './utility.ts'

/** admin = darf freigeben, Rollen/Rechte vergeben, Team bearbeiten (mehrere möglich: IGL + Secondary-IGL); player = alles lesen, Lineups hinzufügen, Strats vorschlagen, abstimmen */
export type Perm = 'admin' | 'player'
/** eingebaute Rollen (fest pro Spieler, nicht pro Map); eigene Rollen-IDs erlaubt */
export const BUILTIN_ROLES = [
  { id: 'igl', label: 'IGL' }, { id: 'igl2', label: 'Secondary IGL' }, { id: 'entry', label: 'Entry' }, { id: 'awp', label: 'AWP' },
  { id: 'support', label: 'Support' }, { id: 'lurker', label: 'Lurker' }, { id: 'anchor', label: 'Anchor' }, { id: 'rotator', label: 'Rotator' },
  { id: 'coach', label: 'Coach' },
] as const

export type MapStatus = 'main' | 'practice' | 'permaban' | 'off'
export interface MapPoolEntry { map: string; status: MapStatus; note?: string }

export interface Team {
  id: string
  name: string
  /** Einladungscode (nur Admins bekommen ihn) */
  inviteCode?: string
  mapPool: MapPoolEntry[]
  /** „Fokus der Woche“ fürs Dashboard */
  focus?: string
  updatedAt: number
}

export interface Member {
  /** = Supabase-Auth-User-ID (anonyme Anmeldung, je PC) */
  id: string
  teamId: string
  name: string
  steamid?: string
  perm: Perm
  /** Rollen-IDs (BUILTIN_ROLES oder eigene) */
  roles: string[]
  joinedAt: number
  updatedAt: number
}

export type StratKind = 'default' | 'execute' | 'fake' | 'pistol' | 'antieco' | 'retake' | 'setup' | 'other'
/** proposed = Vorschlag (Abstimmung läuft), approved = im Stratbook, rejected = abgelehnt, archived = aussortiert */
export type StratStatus = 'proposed' | 'approved' | 'rejected' | 'archived'

/** Aufgabe eines Spielers in einer Strat („wer macht was“) */
export interface StratSlot {
  role: string
  memberId?: string
  /** Startposition */
  start?: { x: number; y: number }
  /** Team-Lineups in Wurf-Reihenfolge */
  lineupIds: string[]
  /** z. B. „1:45“ oder „nach der Flash“ */
  timing?: string
  task: string
}

/** Taktik-Board auf dem Radar: Punkte in Weltkoordinaten */
export interface BoardItem {
  kind: 'pos' | 'arrow' | 'path' | 'zone' | 'text'
  pts: { x: number; y: number }[]
  color?: string
  label?: string
  /** gehört zu slots[slot] (Farbe/Name des Spielers) */
  slot?: number
}

export interface Strat {
  id: string
  teamId: string
  map: string
  side: 'T' | 'CT'
  kind: StratKind
  title: string
  /** kurze Beschreibung in einer Zeile */
  description?: string
  notes?: string
  /** höchstens 5 */
  slots: StratSlot[]
  board: BoardItem[]
  tags: string[]
  status: StratStatus
  /** Änderungsvorschlag zu einer bestehenden Strat: bei Freigabe ersetzt er das Original (Original-ID bleibt) */
  baseId?: string
  /** Member-ID des Erstellers */
  author: string
  /** Member-ID des Admins, der freigegeben/abgelehnt hat */
  decidedBy?: string
  createdAt: number
  updatedAt: number
  deleted?: boolean
}

/** Abstimmung über einen Vorschlag (je Mitglied eine Stimme, änderbar) */
export interface Vote { stratId: string; memberId: string; value: 1 | -1; comment?: string; updatedAt: number }

export type ProgressStatus = 'learning' | 'unsure' | 'ready'
/** Lern-Status eines Spielers zu einer Strat oder einem Lineup */
export interface Progress { memberId: string; ref: { strat: string } | { lineup: string }; status: ProgressStatus; updatedAt: number }

/** Lesezeichen in einer Demo. demoKey ist auf allen PCs gleich (gleiche .dem-Datei), die Demo selbst bleibt lokal */
export interface Bookmark { demoKey: string; demoName: string; round: number; tick: number; label: string }

/** Scrim-/Match-Notiz oder Review-Playlist */
export interface Note {
  id: string
  teamId: string
  kind: 'scrim' | 'match' | 'review'
  title: string
  date: number
  map?: string
  opponent?: string
  /** z. B. „13:9“ */
  result?: string
  text: string
  bookmarks: Bookmark[]
  author: string
  updatedAt: number
  deleted?: boolean
}

/** Videoclip eines Team-Lineups (in der App verkleinert, im Supabase-Storage) */
export interface Clip { path: string; bytes: number; durationS: number }

export interface TeamState {
  /** ohne Team: me/team leer, die Team-Seite zeigt „Team erstellen / beitreten“ */
  me?: Member
  team?: Team
  members: Member[]
  strats: Strat[]
  votes: Vote[]
  progress: Progress[]
  notes: Note[]
  /** Team-Lineups (owner = { team }), zusätzlich zu den lokalen im Utility-Dashboard */
  lineups: Lineup[]
  /** Clip je Team-Lineup-ID */
  clips: Record<string, Clip>
  online: boolean
  syncing: boolean
  error?: string
}

/**
 * Team-Zugriff im Fenster (src/renderer/team/index.ts exportiert `team: TeamApi`). Rechte prüft der Server (RLS); die Oberfläche blendet
 * nur aus, was nicht erlaubt ist. Alle Schreib-Methoden aktualisieren den State sofort (optimistisch) und synchronisieren im Hintergrund.
 */
export interface TeamApi {
  state(): TeamState
  subscribe(cb: (s: TeamState) => void): () => void
  create(teamName: string, myName: string): Promise<void>
  join(inviteCode: string, myName: string): Promise<void>
  leave(): Promise<void>
  /** Admin: Team-Name, Map-Pool, Fokus; neuer Einladungscode */
  saveTeam(t: Team): Promise<void>
  newInviteCode(): Promise<string>
  /** eigener Name/SteamID; Admin: auch perm und roles anderer */
  saveMember(m: Member): Promise<void>
  removeMember(id: string): Promise<void>
  /** Spieler: nur status 'proposed' (neu oder Änderungsvorschlag mit baseId); Admin: alles */
  saveStrat(s: Strat): Promise<void>
  /** Admin: Vorschlag freigeben (ok) oder ablehnen */
  decide(stratId: string, ok: boolean): Promise<void>
  vote(stratId: string, value: 1 | -1, comment?: string): Promise<void>
  setProgress(p: Progress): Promise<void>
  saveNote(n: Note): Promise<void>
  /** jeder darf Team-Lineups anlegen; ändern/löschen: eigene oder Admin */
  saveLineup(l: Lineup): Promise<void>
  /** lokale Lineups ins Team kopieren (neue IDs, owner = team) */
  shareLineups(ls: Lineup[]): Promise<void>
  /** Clip zu einem Team-Lineup hochladen (schon verkleinert, ersetzt einen alten); danach in state().clips[lineupId] */
  uploadClip(lineupId: string, data: Blob, durationS: number): Promise<Clip>
  /** abspielbare URL (lokaler Cache, einmal heruntergeladen) */
  clipUrl(c: Clip): Promise<string>
  storage(): Promise<{ bytes: number; limit: number }>
}
