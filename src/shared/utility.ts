// Utility-Dashboard: gemeinsamer Vertrag zwischen Bibliothek (Seite, Speicher, Import/Export) und 3D-Vorschau.
// Unverändert nach src/shared/utility.ts kopieren; Erweiterungen in eigene Dateien, damit beide Zweige ohne Konflikt zusammengehen.

export type NadeType = 'smoke' | 'flash' | 'molotov' | 'he' | 'decoy'
export type Side = 'T' | 'CT' | 'both'
export interface Vec3 { x: number; y: number; z: number }

/** Ein Lineup. Weltkoordinaten in CS2-Einheiten (wie in den Demo-/3D-Daten), Radar-Umrechnung über resources/maps/map_data.json */
export interface Lineup {
  /** UUID (crypto.randomUUID) */
  id: string
  /** z. B. 'de_mirage' */
  map: string
  type: NadeType
  side: Side
  title: string
  /** kurze Beschreibung in einer Zeile: wofür das Lineup ist (z. B. „blockt die Sicht aus dem Fenster“) */
  description?: string
  /** Standposition (Füße). z optional bei Einträgen nur vom Radar */
  stand: { x: number; y: number; z?: number }
  /** Landepunkt der Granate. z optional wie oben */
  target: { x: number; y: number; z?: number }
  /** Blickwinkel beim Wurf in Grad (CS2: pitch + = nach unten, yaw wie m_angEyeAngles) */
  aim?: { pitch: number; yaw: number }
  /** Wurftechnik als IDs, eingebaut: 'stand' | 'walk' | 'run' | 'crouch' | 'jump' | 'left' | 'right' | 'both' | 'jumpthrow' | 'wjumpthrow'; eigene IDs erlaubt */
  technique: string[]
  /** Anleitung in Schritten */
  steps: string[]
  /** Bilder als Inhalts-Hash (sha1 der WebP-Datei im Utility-Ordner) */
  images: string[]
  /** url = externer Link (nur http/https); local = Dateiname im Utility-Ordner, nur auf diesem PC (nie ins Team hochladen) */
  video?: { url?: string; local?: string }
  /** Link auf eine fremde Seite (nur Verweis, kein kopierter Inhalt) */
  sourceUrl?: string
  /** Tag-IDs */
  tags: string[]
  /** freie Zusatzfelder Name → Wert */
  fields?: Record<string, string>
  favorite?: boolean
  /** gesetzt, wenn das Lineup aus einer Demo stammt: dann zeigt die 3D-Vorschau die echte Stelle */
  demo?: { matchId: string; tick: number; steamid: string; player?: string; round?: number }
  /** Anzeigename des Erstellers */
  author?: string
  owner: 'local' | { team: string }
  createdAt: number
  updatedAt: number
  /** weiches Löschen (Team-Sync) */
  deleted?: boolean
}

export interface Tag { id: string; name: string; color: string; updatedAt: number; deleted?: boolean }
/** Playbook = geordnete Folge von Lineups (z. B. „A-Execute Mirage“) */
export interface Playbook { id: string; name: string; map?: string; lineupIds: string[]; notes?: string; updatedAt: number; deleted?: boolean }
export interface UtilityLibrary { version: 1; lineups: Lineup[]; tags: Tag[]; playbooks: Playbook[]; techniques: { id: string; label: string }[] }

/** Granatenwurf aus einer importierten Demo, Vorschlag für „Aus Demo übernehmen“ (geliefert von der Vorschau-Seite, api.utilityThrows) */
export interface ThrowCandidate {
  matchId: string
  tick: number
  steamid: string
  player: string
  round: number
  map: string
  type: NadeType
  side: 'T' | 'CT'
  /** fertig ausgefülltes Lineup ohne id/owner/Zeiten */
  lineup: Omit<Lineup, 'id' | 'owner' | 'createdAt' | 'updatedAt'>
  /** Anzahl ähnlicher Würfe (gleiche Map/Typ, Stand und Ziel je < 64 Einheiten) über alle Demos, für „häufig“ */
  similar: number
}

// IPC-Verträge (preload/api.ts):
//   api.utilityThrows(map?: string): Promise<ThrowCandidate[]>        – Vorschau-Zweig baut es
//   Komponente src/renderer/utility/preview/LineupPreview3D.tsx:
//     export function LineupPreview3D(p: { lineup: Lineup; onClose: () => void }): JSX.Element  – Vorschau-Zweig baut sie,
//     der Bibliothek-Zweig legt nur einen Platzhalter mit genau dieser Signatur an (wird beim Zusammenführen ersetzt)
