import type { MatchData, MatchSummary } from '../shared/model'
import type { Api3D } from '../shared/assets3d'
import type { Avatars, HudAssetManifest, HudTrack } from '../shared/hud'

export interface MapMeta {
  pos_x: number
  pos_y: number
  scale: number
  verticalsections?: Record<string, { AltitudeMax: string; AltitudeMin: string }>
  image?: string
  lowerImage?: string
}

interface Api extends Api3D {
  listMatches(): Promise<MatchSummary[]>
  pickDemos(): Promise<string[]>
  importDemo(file: string): Promise<MatchSummary>
  loadMatch(id: string): Promise<MatchData>
  deleteMatch(id: string): Promise<void>
  getMap(map: string): Promise<MapMeta | undefined>
  pathForFile(f: File): string
  onProgress(cb: (p: { file: string; pct: number; msg: string }) => void): () => void
  onOpened(cb: (id: string) => void, onError: (msg: string) => void): () => void
  /** gefundene CS2-Installation (Quelle der 3D-Assets) oder englischer Fehlertext */
  cs2Status(): Promise<{ csgo: string; patch: string } | { error: string }>
  /** 'hud:assets': HUD-Icons + Schriften aus CS2 (einmal je Patch gebaut) oder englischer Fehlertext */
  hudAssets(): Promise<HudAssetManifest | { error: string }>
  /** 'avatars:get': Steam-Profilbilder (Cache im Main-Prozess, offline null) */
  avatars(steamids: string[]): Promise<Avatars>
  /** 'match:loadHud': <id>.hud.json.gz; null = alter Import ohne HUD-Daten */
  loadHud(id: string): Promise<HudTrack | null>
}

export const api = (window as any).api as Api
