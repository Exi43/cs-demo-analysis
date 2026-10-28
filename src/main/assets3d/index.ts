// Main-Seite der Asset-Pipeline: prepare3d im utilityProcess (out/main/assets3d.js) starten und das Protokoll cs3d:// bedienen.
// Eingebunden in main/index.ts (Schema-Privilegien inkl. corsEnabled, protocol.handle, IPC assets3d:prepare, Hintergrund-Vorbereitung).
// Immer EIN Asset-Bau zur Zeit (prepare3d teilt tmp/ und die Ausgabeordner), Vordergrund (3D-Ansicht/Vorschau wartet) vor Hintergrund
// (nach Import, beim App-Start, beim Öffnen eines Matches, Map-Vorbau). Ein laufender Bau wird nicht abgebrochen, nur beim Beenden der
// App (killTree) und im Hintergrund, wenn ein Spiel startet (game.ts) oder jemand auf etwas anderes wartet: dann zurück in die Schlange,
// fertige Teile liegen im Cache. Ergebnisse bleiben je Match/Map im Speicher: 3D öffnen danach braucht keinen utilityProcess mehr.
import { app, net, utilityProcess, type UtilityProcess } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Assets3D, Prepare3DStatus, PreviewAssets } from '../../shared/assets3d.ts'
import { gameRunning } from '../game.ts'
import { log } from '../log.ts'
import { ensureVrf, findCS2 } from './cs2.ts'
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

/** laufender Bau: wartet die 3D-Ansicht (auf ihn oder auf einen Bau dahinter), schaltet 'boost' ihn hoch (worker.ts) */
let active: UtilityProcess | undefined
/** libuv-Threads = gleichzeitige sharp-Aufträge (Kerne − 2, halb für VRF); wie viele genutzt werden, setzt worker.ts (Hintergrund 2) */
const UV_THREADS = String(Math.min(6, Math.max(2, Math.floor((availableParallelism() - 2) / 2))))

/** Ablehnungsgrund eines Hintergrund-Baus, der anhält (Spiel läuft, jemand wartet auf etwas anderes): zurück in die Schlange */
const PAUSED = new Error('paused')
const GAME = 'a game is running'

/**
 * Source2Viewer-CLI über EIN Promise je App-Lauf, nur im Main: HUD-Icons (hudassets.ts) und jeder Asset-Bau warten auf denselben
 * Download, der Worker startet erst danach. Vorher luden Main und Worker gleichzeitig und löschten sich den Ordner (ENOTEMPTY, HUD-VRF 0x80008085).
 */
let vrfP: Promise<string> | undefined
const vrfPct = new Set<(f: number) => void>()
export function vrfReady(onPct?: (f: number) => void): Promise<string> {
  if (onPct) vrfPct.add(onPct)
  const p = (vrfP ??= ensureVrf(join(app.getPath('userData'), 'tools', 'vrf'), f => { for (const cb of vrfPct) cb(f) })
    .catch(e => { vrfP = undefined; throw e })) // Fehler nicht merken: der nächste Versuch lädt neu
  return onPct ? p.finally(() => vrfPct.delete(onPct)) : p
}

/** input: Match (Header von <id>.3d.bin.gz) bzw. Map + Vorschau-Kit (Utility-Vorschau ohne Demo, worker.ts) */
type Input = { file3d: string } | { map: string }
async function runPrepare3d<T>(input: Input, bg: boolean, onProgress: (p: { pct: number; msg: string }) => void, pause: AbortSignal): Promise<T> {
  await vrfReady(f => onProgress({ pct: Math.round(2 + 6 * f), msg: 'Downloading Source 2 Viewer' }))
  if (pause.aborted) throw PAUSED
  return new Promise<T>((res, rej) => {
    const child = utilityProcess.fork(join(__dirname, 'assets3d.js'), [], {
      execArgv: ['--max-old-space-size=4096'], env: { ...process.env, UV_THREADPOOL_SIZE: UV_THREADS }, serviceName: 'CS Demo Analysis 3D assets',
      // beide als Pipe: 'inherit' neben 'pipe' reicht GetStdHandle() des Hauptprozesses weiter, das beim Start per Doppelklick NULL ist →
      // PCHECK in base::LaunchProcess beendet die ganze App (Electron 44, v1.1.1/v1.1.2 beim Kollegen)
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(d))
    // Absturzgrund (z. B. fehlendes Modul im Installer) in die Fehlermeldung, sonst sieht ein Nutzer nur „code 1“. gltf-transform meldet
    // je Map ~80× „quantize: Skipping …“ und „reorder: No qualifying …“ (harmlos): nicht mitnehmen, sonst schiebt es den Absturzgrund aus dem Rest
    const noise = (l: string) => /quantize: Skipping|reorder: No qualifying/.test(l)
    let errTail = '', line = ''
    child.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(d)
      const ls = (line + d).split('\n'); line = ls.pop()!
      errTail = (errTail + ls.filter(l => !noise(l)).map(l => l + '\n').join('')).slice(-4000) // 2000 schnitt bei MODULE_NOT_FOUND die Fehlerzeile ab
    })
    running.add(child); active = child
    let done = false, timer: NodeJS.Timeout | undefined
    const finish = (err?: Error, assets?: T, tree = false) => {
      if (done) return
      done = true; clearTimeout(timer); running.delete(child)
      if (active === child) active = undefined
      if (tree) killTree(child); else child.kill()
      err ? rej(err) : res(assets!)
    }
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('3D preparation stopped responding (no progress for 10 minutes).'), undefined, true), STALL_MS) }
    alive()
    pause.addEventListener('abort', () => finish(PAUSED, undefined, true))
    child.on('message', (msg: any) => {
      alive()
      if (msg.type === 'progress') onProgress(msg.p)
      else finish(msg.type === 'done' ? undefined : new Error(msg.message), msg.assets)
    })
    child.on('exit', code => setTimeout(() => { // stderr kann nach 'exit' noch ankommen
      if (!noise(line)) errTail += line
      if (errTail.trim()) log.warn(`3D worker stderr:\n${errTail.trim()}`) // Warnungen („skins skipped“) und Absturzgrund ins App-Protokoll
      const why = /^\w*Error\b.*$/m.exec(errTail)?.[0] ?? errTail.trim().split('\n').pop()
      finish(new Error(`3D asset builder crashed (code ${code}).${why ? ' ' + why.trim() : ''}`))
    }, 300))
    child.postMessage({ ...input, root: app.getPath('userData'), bg })
  })
}

// ---------------------------------------------------------------- Schlange + Status je Match
/** stop = laufenden Hintergrund-Bau anhalten (zurück in die Schlange), why fürs Protokoll */
interface Job { key: string; bg: boolean; run(): void; stop?(why: string): void }
const jobs: Job[] = []
let busy = false, running3d: Job | undefined, checking = false, noGameAt = -Infinity
function pump() {
  if (busy || !jobs.length) return
  let i = jobs.findIndex(j => !j.bg)
  if (i < 0) {
    // nur Hintergrund: erst, wenn kein Spiel läuft (Prüfung höchstens 30 s alt); die 3D-Ansicht (Vordergrund) wartet nie darauf
    if (checking) return
    if (Date.now() - noGameAt > 30e3) {
      checking = true
      void gameRunning().then(g => { checking = false; if (!g) noGameAt = Date.now(); setTimeout(pump, g ? 30e3 : 0) })
      return
    }
    i = 0
  }
  const [j] = jobs.splice(i, 1)
  busy = true; running3d = j
  j.run()
}
/**
 * Ergebnis je <id>.3d.bin.gz + mtime (Re-Import = neuer Schlüssel). Gilt, bis eine Asset-Datei fehlt (cs3d:// 404 → forgetPrepare).
 * shortcut: ein CS2-Update während die App läuft macht die URLs ungültig (neuer Patch-Ordner); dann scheitert das Laden einmal, Retry baut neu.
 */
const results = new Map<string, Promise<unknown>>()
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
  return enqueue(id, `${file3d}:${statSync(file3d).mtimeMs}`, { file3d }, background)
}
/**
 * Map + Vorschau-Kit (Utility-Vorschau eines Lineups ohne Demo; Kit = Hände, Granaten, Agent, fehlt bei einem Kit-Fehler): dieselbe
 * Schlange und Statusmeldungen (id 'map:<name>'), Cache wie beim Match. background = schonend (Vorbau), sonst wartet die Vorschau: volle Kraft.
 */
export function prepareMap(map: string, background = false): Promise<PreviewAssets> {
  if (!/^[a-z0-9_]+$/.test(map)) return Promise.reject(new Error(`Invalid map name: ${map}`))
  return enqueue(`map:${map}`, `map:${map}`, { map }, background)
}

/** Map-Pool der Utility-Seite (wie renderer/utility/maps.ts POOL): Vorbau im Hintergrund */
export const POOL_MAPS = ['de_ancient', 'de_anubis', 'de_cache', 'de_dust2', 'de_inferno', 'de_mirage', 'de_nuke']
let prePatch = ''
/**
 * Pool-Maps samt Vorschau-Kit im Hintergrund vorbauen bzw. prüfen (App-Start, dann regelmäßig), nur wenn CS2 da ist: die Lineup-Vorschau
 * öffnet danach ohne Bau und ohne Worker. Neuer CS2-Patch bei laufender App: Merk-Plätze leeren, neu prüfen (geänderte Maps bauen neu).
 */
export function prebuildMaps() {
  let patch: string
  try { patch = findCS2().patch } catch { return }
  if (prePatch && patch !== prePatch) forgetPrepare()
  prePatch = patch
  for (const m of POOL_MAPS) prepareMap(m, true).catch(() => {}) // Fehler zeigt der Status
}

function enqueue<T>(id: string, key: string, input: Input, background: boolean): Promise<T> {
  if (!background && status.get(id)?.state !== 'ready') {
    // 3D-Ansicht/Vorschau wartet: ein Hintergrund-Bau von etwas anderem hält an (zurück in die Schlange, fertige Teile bleiben im Cache),
    // sonst läuft der laufende Bau (dieser oder ein Vordergrund-Bau davor) mit voller Kraft
    if (running3d?.bg && running3d.key !== key) running3d.stop?.('someone is waiting for another 3D preparation')
    else active?.postMessage({ boost: true })
  }
  const hit = results.get(key) as Promise<T> | undefined
  if (hit) {
    if (!background) {
      for (const j of [...jobs, running3d]) if (j?.key === key && j.bg) { j.bg = false; log.info(`3D ${id}: now in the foreground (someone is waiting)`) }
      pump()
    }
    return hit
  }
  const set = (s: Omit<Prepare3DStatus, 'id'>) => { const v = { id, ...s }; status.set(id, v); notify(v) }
  const p = new Promise<T>((res, rej) => {
    const job: Job = {
      key, bg: background,
      run: () => {
        set({ state: 'building', pct: 0, msg: 'Starting' })
        // Hintergrund-Bau: startet ein Spiel oder wartet jemand auf etwas anderes, anhalten und später weiterbauen; wartet inzwischen
        // jemand auf ihn selbst (bg = false), nicht
        const ac = new AbortController(), watch = setInterval(() => { if (job.bg) void gameRunning().then(g => { if (g && job.bg) ac.abort(GAME) }) }, 30e3)
        job.stop = why => { if (job.bg) ac.abort(why) }
        runPrepare3d<T>(input, job.bg, pr => set({ state: 'building', pct: pr.pct, msg: pr.msg }), ac.signal).then(res, e => {
          if (e !== PAUSED) return rej(e)
          log.info(`3D ${id}: build paused, ${ac.signal.reason}`)
          noGameAt = -Infinity; jobs.unshift(job); set({ state: 'queued', pct: 0, msg: ac.signal.reason === GAME ? 'Paused while a game is running' : 'Waiting for another 3D preparation to finish' })
        }).finally(() => { clearInterval(watch); job.stop = undefined; busy = false; running3d = undefined; pump() })
      },
    }
    jobs.push(job)
    set({ state: 'queued', pct: 0, msg: 'Waiting for another 3D preparation to finish' })
    pump()
  })
  results.set(key, p)
  for (const k of [...results.keys()].slice(0, -24)) results.delete(k) // nur die letzten 24 (Matches + 7 Pool-Maps)
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
