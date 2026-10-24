// Main-Seite der Asset-Pipeline: prepare3d im utilityProcess (out/main/assets3d.js) starten und das Protokoll cs3d:// bedienen.
// Eingebunden in main/index.ts (Schema-Privilegien inkl. corsEnabled, protocol.handle, IPC assets3d:prepare, Hintergrund-Vorbereitung).
// Immer EIN Asset-Bau zur Zeit (prepare3d teilt tmp/ und die Ausgabeordner), Vordergrund (3D-Ansicht wartet) vor Hintergrund (nach
// Import, beim App-Start, beim Öffnen eines Matches). Ein laufender Bau wird nicht abgebrochen, nur beim Beenden der App (killTree).
// Ergebnisse bleiben je Match im Speicher: 3D öffnen nach der Vorbereitung braucht keinen utilityProcess mehr.
import { app, net, utilityProcess, type UtilityProcess } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Assets3D, Prepare3DStatus } from '../../shared/assets3d.ts'
import { texPackResponse } from './texpack.ts'

// Demo-Importe nacheinander (jeder Parser braucht viel RAM). Der Asset-Bau hat eine eigene Schlange (unten) und läuft parallel mit
// niedriger Priorität (worker.ts), damit ein langer Map-Bau keinen Import aufhält.
let queue: Promise<unknown> = Promise.resolve()
export function serial<T>(job: () => Promise<T>): Promise<T> {
  const p = queue.then(job)
  queue = p.catch(() => undefined)
  return p
}

/** Ohne Fortschrittsmeldung so lange → Bau gilt als hängend (Fehler statt endlosem Laden). Längster VRF-Schritt (Map-Export) ~3 min */
const STALL_MS = 10 * 60e3
const running = new Set<UtilityProcess>()
/** utilityProcess samt VRF-Kindern beenden (Windows beendet Kinder nicht mit) */
function killTree(child: UtilityProcess) {
  if (child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  child.kill()
}
app.on('before-quit', () => { for (const c of running) killTree(c) })

function runPrepare3d(file3d: string, onProgress: (p: { pct: number; msg: string }) => void): Promise<Assets3D> {
  return new Promise<Assets3D>((res, rej) => {
    const child = utilityProcess.fork(join(__dirname, 'assets3d.js'), [], {
      execArgv: ['--max-old-space-size=4096'], env: { ...process.env, UV_THREADPOOL_SIZE: '2' }, serviceName: 'CS Demo Analysis 3D assets',
    })
    running.add(child)
    let done = false, timer: NodeJS.Timeout | undefined
    const finish = (err?: Error, assets?: Assets3D, tree = false) => {
      if (done) return
      done = true; clearTimeout(timer); running.delete(child)
      if (tree) killTree(child); else child.kill()
      err ? rej(err) : res(assets!)
    }
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('3D preparation stopped responding (no progress for 10 minutes).'), undefined, true), STALL_MS) }
    alive()
    child.on('message', (msg: any) => {
      alive()
      if (msg.type === 'progress') onProgress(msg.p)
      else finish(msg.type === 'done' ? undefined : new Error(msg.message), msg.assets)
    })
    child.on('exit', code => finish(new Error(`3D asset builder crashed (code ${code}).`)))
    child.postMessage({ file3d, root: app.getPath('userData') })
  })
}

// ---------------------------------------------------------------- Schlange + Status je Match
interface Job { key: string; bg: boolean; run(): void }
const jobs: Job[] = []
let busy = false
function pump() {
  if (busy) return
  const i = jobs.findIndex(j => !j.bg), [j] = jobs.splice(Math.max(0, i), 1)
  if (!j) return
  busy = true
  j.run()
}
/**
 * Ergebnis je <id>.3d.bin.gz + mtime (Re-Import = neuer Schlüssel). Gilt, bis eine Asset-Datei fehlt (cs3d:// 404 → forgetPrepare).
 * shortcut: ein CS2-Update während die App läuft macht die URLs ungültig (neuer Patch-Ordner); dann scheitert das Laden einmal, Retry baut neu.
 */
const results = new Map<string, Promise<Assets3D>>()
const status = new Map<string, Prepare3DStatus>()
let notify: (s: Prepare3DStatus) => void = () => {}
/** Statusmeldungen an das Fenster (Bibliothek-Symbol, Ladebildschirm der 3D-Ansicht) */
export function onPrepareStatus(cb: (s: Prepare3DStatus) => void) { notify = cb }
export const prepareStatus = () => [...status.values()]

/**
 * Map, Agenten, Waffen und Skins für ein Match bauen bzw. aus dem Cache prüfen (Header von <id>.3d.bin.gz liest der Worker).
 * background = true: hinter allen Vordergrund-Aufträgen; ein späterer Vordergrund-Aufruf für dasselbe Match zieht ihn vor.
 */
export function prepareForMatch(id: string, file3d: string, background = false): Promise<Assets3D> {
  if (!existsSync(file3d)) return Promise.reject(new Error('This match has no 3D data. Re-import the demo for 3D.'))
  const key = `${file3d}:${statSync(file3d).mtimeMs}`
  const hit = results.get(key)
  if (hit) {
    if (!background) for (const j of jobs) if (j.key === key) j.bg = false
    return hit
  }
  const set = (s: Omit<Prepare3DStatus, 'id'>) => { const v = { id, ...s }; status.set(id, v); notify(v) }
  const p = new Promise<Assets3D>((res, rej) => {
    jobs.push({
      key, bg: background,
      run: () => {
        set({ state: 'building', pct: 0, msg: 'Starting' })
        runPrepare3d(file3d, pr => set({ state: 'building', pct: pr.pct, msg: pr.msg })).then(res, rej).finally(() => { busy = false; pump() })
      },
    })
    set({ state: 'queued', pct: 0, msg: 'Waiting for another 3D preparation to finish' })
    pump()
  })
  results.set(key, p)
  for (const k of [...results.keys()].slice(0, -16)) results.delete(k) // nur die letzten 16 Matches
  p.then(() => set({ state: 'ready', pct: 100, msg: 'Ready' }), e => {
    if (results.get(key) === p) results.delete(key) // Fehler nicht merken: Retry baut neu
    set({ state: 'error', pct: 0, msg: String(e?.message ?? e) })
  })
  return p
}

/** Merk-Plätze leeren: eine Asset-Datei fehlt (cs3d:// 404), der nächste prepare3d-Aufruf prüft und baut neu */
export function forgetPrepare() { results.clear() }

/** cs3d://assets3d/<patch>/<pfad> → Datei unter <userData>/assets3d; alles außerhalb 403 */
export function handleCs3d(req: Request): Promise<Response> | Response {
  const u = new URL(req.url)
  const dir = join(app.getPath('userData'), 'assets3d')
  const file = resolve(app.getPath('userData'), decodeURIComponent(u.host + u.pathname).replace(/^\/+/, ''))
  if (!file.startsWith(dir + sep)) return new Response(null, { status: 403 })
  if (basename(file) === 'tex.pack' && !existsSync(file)) return texPackResponse(dirname(file)) // Map-Texturen als ein Stream
  if (!existsSync(file)) return new Response(null, { status: 404 })
  return net.fetch(pathToFileURL(file).toString())
}
