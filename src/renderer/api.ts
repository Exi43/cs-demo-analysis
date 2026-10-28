import type { MatchData, MatchSummary } from '../shared/model'
import type { Api3D, PreviewAssets } from '../shared/assets3d'
import type { Avatars, HudAssetManifest, HudTrack } from '../shared/hud'
import type { UtilityApi } from '../shared/utility-api'
import type { ThrowCandidate } from '../shared/utility'

export interface MapMeta {
  pos_x: number
  pos_y: number
  scale: number
  verticalsections?: Record<string, { AltitudeMax: string; AltitudeMin: string }>
  image?: string
  lowerImage?: string
}

interface Api extends Api3D, UtilityApi {
  listMatches(): Promise<MatchSummary[]>
  pickDemos(): Promise<string[]>
  importDemo(file: string): Promise<MatchSummary>
  loadMatch(id: string): Promise<MatchData>
  deleteMatch(id: string): Promise<void>
  getMap(map: string): Promise<MapMeta | undefined>
  pathForFile(f: File): string
  onProgress(cb: (p: { file: string; pct: number; msg: string }) => void): () => void
  onOpened(cb: (id: string) => void, onError: (msg: string) => void): () => void
  /** 'window:shown': Fenster minimiert (false) / wiederhergestellt (true) */
  onWindowShown(cb: (shown: boolean) => void): () => void
  /** gefundene CS2-Installation (Quelle der 3D-Assets) oder englischer Fehlertext */
  cs2Status(): Promise<{ csgo: string; patch: string } | { error: string }>
  /** 'hud:assets': HUD-Icons + Schriften aus CS2 (einmal je Patch gebaut) oder englischer Fehlertext */
  hudAssets(): Promise<HudAssetManifest | { error: string }>
  /** 'avatars:get': Steam-Profilbilder (Cache im Main-Prozess, offline null) */
  avatars(steamids: string[]): Promise<Avatars>
  /** 'match:loadHud': <id>.hud.json.gz; null = alter Import ohne HUD-Daten */
  loadHud(id: string): Promise<HudTrack | null>
  /** App-Protokoll (main/log.ts): unbehandelter Fehler des Fensters, mit Stack */
  logError(msg: string): void
  /** 'log:copy': Systeminfo + letzte 300 Zeilen von app.log in die Zwischenablage; Rückgabe = Zeilen */
  copyLog(): Promise<number>
  /** 'log:show': app.log im Explorer zeigen */
  showLog(): Promise<void>
  /**
   * 'assets3d:prepareMap': Map + Vorschau-Kit bauen bzw. aus dem Cache (Vorschau eines Lineups ohne Demo), Fortschritt über onPrepareStatus
   * (id 'map:<name>'); background = schonend, sonst volle Kraft (Dialog wartet)
   */
  prepareMap(map: string, background?: boolean): Promise<PreviewAssets>
  /** 'utility:throws': Granatenwürfe aller importierten Matches (map: nur diese) als Lineup-Vorschläge */
  utilityThrows(map?: string): Promise<ThrowCandidate[]>
  // Team-Sync (main/team.ts): Sitzung verschlüsselt, Cache des Team-Stands, Clip-Cache, Bilder der Team-Lineups
  teamSession(): Promise<string | null>
  teamSetSession(s: string | null): Promise<void>
  teamLoadCache(): Promise<string | null>
  teamSaveCache(s: string): Promise<void>
  teamClipGet(name: string): Promise<Uint8Array | null>
  teamClipPut(name: string, data: Uint8Array): Promise<void>
  teamImageGet(hash: string): Promise<Uint8Array | null>
  teamImagePut(hash: string, data: Uint8Array): Promise<void>
}

const raw = (window as any).api
/** 'match:load' liefert <id>.json.gz (main/index.ts): hier entpacken und parsen ist viel schneller als ein Objekt über IPC */
const loadMatch = async (id: string): Promise<MatchData> =>
  new Response(new Blob([await raw.loadMatch(id)]).stream().pipeThrough(new DecompressionStream('gzip'))).json()
export const api = { ...raw, loadMatch } as Api
