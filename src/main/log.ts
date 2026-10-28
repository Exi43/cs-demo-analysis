// App-Protokoll <userData>\app.log für die Fehlersuche auf fremden PCs (installierte App ohne Konsole). Kollegen schicken es über
// die Seitenleiste: „Copy log“ (Systeminfo + letzte 300 Zeilen in die Zwischenablage, für Discord) oder „Log folder“ (Explorer).
// Synchron angehängt (übersteht harte Abstürze), ab 2 MB → app.old.log, gleiche Meldung höchstens 1×/min (Rest gezählt),
// Benutzerordner in Pfaden → %USERPROFILE%. Ersetzt crash.log (bis v1.1.3). Nichts pro Bild, keine großen Objekte.
import { app, clipboard, dialog, ipcMain, screen, shell, type UtilityProcess } from 'electron'
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { cpus, freemem, homedir, release, totalmem, version } from 'node:os'
import { basename, join } from 'node:path'
import { inspect } from 'node:util'
import type { Prepare3DStatus } from '../shared/assets3d.ts'
import type { MatchSummary } from '../shared/model.ts'
import { findCS2 } from './assets3d/cs2.ts'

type Level = 'INFO' | 'WARN' | 'ERROR'
const p2 = (n: number) => String(n).padStart(2, '0')
const clock = (t: number) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` }
const stamp = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${clock(t)}.${String(d.getMilliseconds()).padStart(3, '0')}` }
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const gb = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Fehler als Text: Programmierfehler (TypeError …) mit Stack, gewollte Fehler (new Error) nur mit Meldung */
const errText = (e: unknown) => e instanceof Error ? (e.constructor === Error ? e.message : e.stack ?? String(e)) : String(e)

/** Protokolldatei: ab max Bytes → *.old.log, gleiche Meldung höchstens 1×/min, home in Pfaden → %USERPROFILE% (Test: log.test.ts) */
export function createLog(file: string, home = homedir(), max = 2e6, now = Date.now) {
  // jede Schreibweise (\ oder /, groß/klein, %20 in file://-URLs), aber nicht C:\Users\<name>2; ohne Benutzerordner nichts ersetzen
  const parts = home.split(/[\\/]+/).filter(Boolean)
  const homeRe = new RegExp(parts.map(s => `(?:${[...new Set([s, encodeURI(s)])].map(esc).join('|')})`).join('[\\\\/]+') + '(?![\\w.$~-])', 'gi')
  const anon = (s: string) => (parts.length > 1 ? s.replace(homeRe, '%USERPROFILE%') : s)
  const old = file.replace(/\.log$/, '.old.log')
  let size = existsSync(file) ? statSync(file).size : 0
  const append = (level: Level, text: string) => {
    let line = `${stamp(now())} ${level.padEnd(5)} ${text.replace(/\n/g, '\n    ')}\n`
    try {
      if (size && size + Buffer.byteLength(line) > max) {
        try { renameSync(file, old) } catch {} // gesperrt (Editor): weiter in dieselbe Datei
        line = `${stamp(now())} INFO  Log continues, older lines in ${basename(old)}\n${line}`
        size = 0
      }
      appendFileSync(file, line)
      size += Buffer.byteLength(line)
    } catch {} // Protokoll darf die App nie stören (Platte voll, keine Rechte)
  }
  // gleiche Meldung (Stufe + Text) höchstens 1×/min; Wiederholungen zählen, mit der nächsten Ausgabe bzw. flush() melden
  const seen = new Map<string, { level: Level; text: string; t: number; n: number; last: number }>()
  const flush = () => { for (const s of seen.values()) if (s.n) { append(s.level, `(+${s.n} more until ${clock(s.last)}) ${s.text.split('\n')[0]}`); s.n = 0 } }
  const write = (level: Level, msg: string) => {
    const text = anon(msg.length > 5000 ? `${msg.slice(0, 5000)} … (+${msg.length - 5000} chars)` : msg), t = now(), key = level + text
    const s = seen.get(key)
    if (s && t - s.t < 60e3) { s.n++; s.last = t; return }
    if (seen.size > 200) { flush(); seen.clear() }
    seen.set(key, { level, text, t, n: 0, last: t })
    append(level, s?.n ? `(+${s.n} more until ${clock(s.last)}) ${text}` : text)
  }
  return { file, anon, flush, info: (m: string) => write('INFO', m), warn: (m: string) => write('WARN', m), error: (m: string) => write('ERROR', m) }
}

export const log = createLog(join(app.getPath('userData'), 'app.log'))
/** Startblock (Systeminfo), auch am Anfang von „Copy log“ */
const sys: string[] = []
export function logSystem(line: string) { sys.push(line); log.info(line) }

/** Startblock, Fehler aus Main, Fenster und IPC, Beenden; „Copy log“/„Log folder“. Nur in der ersten Instanz, vor app ready. */
export function startLog() {
  const ud = app.getPath('userData'), crash = join(ud, 'crash.log'), old = join(ud, 'app.old.log')
  try { if (existsSync(crash) && !existsSync(old)) renameSync(crash, old) } catch {} // crash.log bis v1.1.3 bleibt als app.old.log lesbar
  const kind = !app.isPackaged ? 'dev' : process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installed'
  const off = -new Date().getTimezoneOffset()
  logSystem(`==== ${app.getName()} ${app.getVersion()} (${kind}), time zone ${Intl.DateTimeFormat().resolvedOptions().timeZone} UTC${off < 0 ? '-' : '+'}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)} ====`)
  logSystem(`Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, Node ${process.versions.node}`)
  logSystem(`${version()} (${release()}), ${process.arch}; CPU ${cpus()[0]?.model.trim()}, ${cpus().length} logical cores; RAM ${gb(totalmem())}, ${gb(freemem())} free`)
  logSystem(`Command line: ${process.argv.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`)
  logSystem(`User data: ${ud}`)

  // eigener Handler schaltet Electrons Fehlerdialog ab: einmal je Lauf selbst zeigen, die App läuft weiter (wie bei Electron)
  let shown = false
  process.on('uncaughtException', e => {
    log.error(`Uncaught exception in the main process: ${e?.stack ?? e}`)
    process.stderr.write(`${e?.stack ?? e}\n`)
    if (shown || process.env.CSDA_SHOT) return // Selbsttest: kein Dialog (unsichtbar, Monitor 1)
    shown = true
    dialog.showErrorBox(`${app.getName()}: unexpected error`, `${e?.stack ?? e}\n\nDetails are in app.log (sidebar: Copy log).`)
  })
  process.on('unhandledRejection', r => log.error(`Unhandled rejection in the main process: ${r instanceof Error ? r.stack : r}`)) // nur Protokoll, kein Dialog
  // console.warn/error des Main-Prozesses mitschreiben (z. B. cs3d 404). Fehler in IPC-Handlern meldet Electron so als
  // „Error occurred in handler for '<Kanal>': <Fehler>“ (geprüft mit Electron 44): damit landen alle IPC-Fehler mit Kanal hier
  for (const k of ['warn', 'error'] as const) {
    const orig = console[k]
    console[k] = (...a: unknown[]) => {
      orig.apply(console, a)
      log[k](a.map(x => (typeof x === 'string' ? x : x instanceof Error ? errText(x) : inspect(x, { breakLength: Infinity }))).join(' '))
    }
  }

  // Fenster: unbehandelte Fehler mit Stack per IPC (main.tsx); die gleichen „Uncaught …“-Konsolenzeilen (ohne Stack) dann weglassen
  let viaIpc = false
  ipcMain.on('log:error', (_e, msg: unknown) => { viaIpc = true; log.error(`Window: ${String(msg)}`) })
  ipcMain.handle('log:copy', () => {
    log.flush()
    const lines = readFileSync(log.file, 'utf8').trimEnd().split(/\r?\n/).slice(-300)
    clipboard.writeText(log.anon([`${app.getName()} log, copied ${stamp(Date.now())}`, ...sys, '', `---- last ${lines.length} lines of app.log ----`, ...lines].join('\n')))
    return lines.length
  })
  ipcMain.handle('log:show', () => shell.showItemInFolder(log.file))
  let first = true
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', e => {
      if (e.level === 'warning' || e.level === 'error') {
        // IPC-Fehler stehen schon da (Electron: „Error occurred in handler for …“)
        const dup = (viaIpc && e.message.startsWith('Uncaught')) || e.message.includes('Error invoking remote method')
        if (!dup) log[e.level === 'error' ? 'error' : 'warn'](`Window: ${e.message}${e.sourceId ? ` (${basename(e.sourceId)}:${e.lineNumber})` : ''}`)
      } else if (e.message.startsWith('THREE.WebGLRenderer: Context Lost')) {
        log.warn('WebGL context lost in the 3D view (GPU reset or driver problem)') // three meldet das nur bei lebendem Renderer, nicht beim Freigeben
      }
    })
    wc.on('did-fail-load', (_e, code, desc, url, main) => { if (main && code !== -3) log.error(`Window failed to load ${url}: ${desc} (${code})`) }) // -3 = abgebrochen
    wc.on('unresponsive', () => log.warn('Window not responding'))
    wc.on('responsive', () => log.info('Window responding again'))
    wc.on('render-process-gone', (_e, d) => log.error(`Window process gone: ${d.reason}, code ${d.exitCode}`))
    if (first) { first = false; wc.once('did-finish-load', () => setTimeout(logLater, 3000)) }
  })
  app.on('will-quit', () => {
    for (const [id, b] of builds) log.warn(`3D ${id}: quit during the build, at '${b.step}' (${b.pct} %) after ${sec(Date.now() - b.t0)}`)
    log.flush()
    log.info(`Quit after ${(process.uptime() / 60).toFixed(1)} min`)
  })
}

/** nach dem ersten Laden (GPU-Prozess läuft, Funktionsstatus stimmt erst dann): Bildschirme, CS2, Grafik */
function logLater() {
  const ds = screen.getAllDisplays(), primary = screen.getPrimaryDisplay().id
  logSystem(`Displays ${ds.length}: ${ds.map(d => `${Math.round(d.size.width * d.scaleFactor)}x${Math.round(d.size.height * d.scaleFactor)} ${Math.round(d.scaleFactor * 100)} % ${Math.round(d.displayFrequency)} Hz${d.id === primary ? ' (primary)' : ''}`).join(', ')}`)
  try { const c = findCS2(); logSystem(`CS2 ${c.csgo}, patch ${c.patch}`) } catch (e) { logSystem(`CS2 not found: ${errText(e)}`) }
  const f = app.getGPUFeatureStatus() as unknown as Record<string, string>
  app.getGPUInfo('basic').then(g => {
    const devs = (g as { gpuDevice?: { deviceString?: string; vendorId: number; deviceId: number; driverVersion?: string }[] }).gpuDevice ?? []
    logSystem(`GPU ${devs.map(d => `${d.deviceString ?? `${d.vendorId}:${d.deviceId}`} (driver ${d.driverVersion ?? '?'})`).join(', ')}; webgl ${f.webgl}, compositing ${f.gpu_compositing}`)
  }, e => log.warn(`GPU info unavailable: ${errText(e)}`))
}

/** stdout/stderr eines utilityProcess (stdio 'pipe') für Entwickler durchreichen; stderr-Rest nach dem Ende ins Protokoll */
export function logOutput(child: UtilityProcess, label: string) {
  let tail = ''
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(d))
  child.stderr?.on('data', (d: Buffer) => { process.stderr.write(d); tail = (tail + d).slice(-4000) })
  child.on('exit', () => setTimeout(() => { if (tail.trim()) log.warn(`${label} stderr:\n${tail.trim()}`) }, 300)) // stderr kann nach 'exit' noch ankommen
}

/** Demo-Import: Datei, Größe, Dauer, Ergebnis bzw. Fehler */
export async function logImport(file: string, run: () => Promise<MatchSummary>) {
  const t0 = Date.now()
  let size = ''
  try { size = ` (${(statSync(file).size / 1e6).toFixed(1)} MB)` } catch {}
  log.info(`Import ${file}${size}`)
  try {
    const s = await run()
    log.info(`Import done after ${sec(Date.now() - t0)}: ${s.id} ${s.map}, ${s.rounds} rounds${s.error3d ? `, without 3D data: ${s.error3d}` : ''}`)
    return s
  } catch (e) {
    log.error(`Import failed after ${sec(Date.now() - t0)}: ${basename(file)}: ${errText(e)}`)
    throw e
  }
}

// 3D-Asset-Bau je Match (Status aus assets3d/index.ts): Start, Schritte ab 1 s Dauer, Ende mit Gesamtdauer bzw. Fehler mit letztem Schritt
const builds = new Map<string, { t0: number; step: string; ts: number; pct: number; first: boolean; work: boolean }>()
const ready = new Set<string>(), views = new Set<string>()
/** 3D-Replay geöffnet (IPC assets3d:prepare) = Bau im Vordergrund; schon fertig = Assets aus dem Speicher (Cache-Treffer) */
export function log3dView(id: string) {
  const hit = ready.has(id) && !builds.has(id)
  if (!hit) views.add(id)
  log.info(`3D replay opened: ${id}${hit ? ' (assets cached)' : ''}`)
}
export function log3d(s: Prepare3DStatus) {
  const t = Date.now(), b = builds.get(s.id)
  if (s.state === 'building') {
    if (!b) {
      builds.set(s.id, { t0: t, step: s.msg, ts: t, pct: s.pct, first: true, work: false })
      return log.info(`3D ${s.id}: build start (${views.has(s.id) ? 'foreground' : 'background'})`) // vor dem Prozessstart: stirbt die App dabei, steht es hier
    }
    if (s.msg !== b.step) {
      // erster Schritt = Start des Bau-Prozesses, kein Bau
      if (!b.first && t - b.ts >= 1000) { b.work = true; log.info(`3D ${s.id}: '${b.step}' took ${sec(t - b.ts)}`) }
      Object.assign(b, { step: s.msg, ts: t, first: false })
    }
    b.pct = s.pct
  } else if (s.state === 'ready' || s.state === 'error') {
    builds.delete(s.id); views.delete(s.id)
    const took = sec(t - (b?.t0 ?? t))
    if (s.state === 'ready') { ready.add(s.id); log.info(`3D ${s.id}: ready after ${took}${b?.work ? '' : ' (all cached)'}`) }
    else { ready.delete(s.id); log.error(`3D ${s.id}: failed after ${took}${b ? ` at '${b.step}' (${b.pct} %)` : ''}: ${s.msg}`) }
  }
}
