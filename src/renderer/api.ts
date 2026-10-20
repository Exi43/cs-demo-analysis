import type { MatchData, MatchSummary } from '../shared/model'

export interface MapMeta {
  pos_x: number
  pos_y: number
  scale: number
  verticalsections?: Record<string, { AltitudeMax: string; AltitudeMin: string }>
  image?: string
  lowerImage?: string
}

interface Api {
  listMatches(): Promise<MatchSummary[]>
  pickDemos(): Promise<string[]>
  importDemo(file: string): Promise<MatchSummary>
  loadMatch(id: string): Promise<MatchData>
  deleteMatch(id: string): Promise<void>
  getMap(map: string): Promise<MapMeta | undefined>
  pathForFile(f: File): string
  onProgress(cb: (p: { file: string; pct: number; msg: string }) => void): () => void
  onOpened(cb: (id: string) => void, onError: (msg: string) => void): () => void
}

export const api = (window as any).api as Api
