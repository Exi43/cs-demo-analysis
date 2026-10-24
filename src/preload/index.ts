import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  listMatches: () => ipcRenderer.invoke('library:list'),
  pickDemos: (): Promise<string[]> => ipcRenderer.invoke('demo:pick'),
  importDemo: (file: string) => ipcRenderer.invoke('demo:import', file),
  loadMatch: (id: string) => ipcRenderer.invoke('match:load', id),
  deleteMatch: (id: string) => ipcRenderer.invoke('match:delete', id),
  getMap: (map: string) => ipcRenderer.invoke('map:get', map),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  /** Demo per Doppelklick geöffnet: Import fertig (id) oder Fehler */
  onOpened: (cb: (id: string) => void, onError: (msg: string) => void) => {
    const h = (_: unknown, id: string) => cb(id), he = (_: unknown, m: string) => onError(m)
    ipcRenderer.on('demo:opened', h); ipcRenderer.on('demo:error', he)
    return () => { ipcRenderer.off('demo:opened', h); ipcRenderer.off('demo:error', he) }
  },
  // 3D-Replay (Api3D in shared/assets3d.ts)
  load3d: (id: string) => ipcRenderer.invoke('match:load3d', id),
  prepare3d: (id: string) => ipcRenderer.invoke('assets3d:prepare', id),
  onPrepareStatus: (cb: (s: unknown) => void) => {
    const h = (_: unknown, s: unknown) => cb(s)
    ipcRenderer.on('assets3d:status', h)
    return () => ipcRenderer.off('assets3d:status', h)
  },
  prepareStatus: () => ipcRenderer.invoke('assets3d:statusAll'),
  cs2Status: () => ipcRenderer.invoke('cs2:status'),
  // HUD des 3D-Replays (Typen in renderer/api.ts + shared/hud.ts)
  hudAssets: () => ipcRenderer.invoke('hud:assets'),
  avatars: (steamids: string[]) => ipcRenderer.invoke('avatars:get', steamids),
  loadHud: (id: string) => ipcRenderer.invoke('match:loadHud', id),
  onProgress: (cb: (p: { file: string; pct: number; msg: string }) => void) => {
    const h = (_: unknown, p: any) => cb(p)
    ipcRenderer.on('import:progress', h)
    return () => ipcRenderer.off('import:progress', h)
  },
}
contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
