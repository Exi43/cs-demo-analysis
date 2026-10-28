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
  // Utility-Seite (Typen in renderer/api.ts + shared/utility.ts)
  prepareMap: (map: string, background?: boolean) => ipcRenderer.invoke('assets3d:prepareMap', map, background),
  utilityThrows: (map?: string) => ipcRenderer.invoke('utility:throws', map),
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
  onWindowShown: (cb: (shown: boolean) => void) => {
    const h = (_: unknown, v: boolean) => cb(v)
    ipcRenderer.on('window:shown', h)
    return () => ipcRenderer.off('window:shown', h)
  },
  // Utility-Dashboard (main/utility.ts, Typen in shared/utility-api.ts)
  utilityLoad: () => ipcRenderer.invoke('utility:load'),
  utilitySave: (lib: unknown) => ipcRenderer.invoke('utility:save', lib),
  utilityMaps: () => ipcRenderer.invoke('utility:maps'),
  utilityAddImages: (paths?: string[]) => ipcRenderer.invoke('utility:addImages', paths),
  utilityAddImageData: (data: Uint8Array) => ipcRenderer.invoke('utility:addImageData', data),
  utilityAddVideo: (path?: string) => ipcRenderer.invoke('utility:addVideo', path),
  utilityOpen: (target: { url?: string; local?: string }) => ipcRenderer.invoke('utility:open', target),
  utilityExportSize: (lib: unknown) => ipcRenderer.invoke('utility:exportSize', lib),
  utilityExport: (lib: unknown, withVideos: boolean, name: string) => ipcRenderer.invoke('utility:export', lib, withVideos, name),
  utilityImportOpen: () => ipcRenderer.invoke('utility:importOpen'),
  utilityImportCommit: () => ipcRenderer.invoke('utility:importCommit'),
  utilityImportCancel: () => ipcRenderer.invoke('utility:importCancel'),
  // Team-Sync (main/team.ts, Typen in renderer/api.ts)
  teamSession: () => ipcRenderer.invoke('team:session'),
  teamSetSession: (s: string | null) => ipcRenderer.invoke('team:setSession', s),
  teamLoadCache: () => ipcRenderer.invoke('team:loadCache'),
  teamSaveCache: (s: string) => ipcRenderer.invoke('team:saveCache', s),
  teamClipGet: (name: string) => ipcRenderer.invoke('team:clipGet', name),
  teamClipPut: (name: string, data: Uint8Array) => ipcRenderer.invoke('team:clipPut', name, data),
  teamImageGet: (hash: string) => ipcRenderer.invoke('team:imageGet', hash),
  teamImagePut: (hash: string, data: Uint8Array) => ipcRenderer.invoke('team:imagePut', hash, data),
  // App-Protokoll (main/log.ts): unbehandelte Fehler des Fensters, Seitenleiste „Copy log“ / „Log folder“
  logError: (msg: string) => ipcRenderer.send('log:error', msg),
  copyLog: () => ipcRenderer.invoke('log:copy'),
  showLog: () => ipcRenderer.invoke('log:show'),
}
contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
