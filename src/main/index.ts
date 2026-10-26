import { app, BrowserWindow, dialog, ipcMain, protocol, screen, utilityProcess } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { release, totalmem } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import type { MatchData, MatchSummary } from '../shared/model.ts'
import { forgetPrepare, handleCs3d, onPrepareStatus, prepareForMatch, prepareStatus, serial } from './assets3d/index.ts'
import { findCS2 } from './assets3d/cs2.ts'
import { getAvatars } from './avatars.ts'
import { hudAssets } from './hudassets.ts'

// Selbsttest CSDA_FPS=1: ohne vsync messen (und Replay abspielen, siehe unten)
// unsichtbarer Selbsttest: Chromium hält Fenster außerhalb der Monitore sonst für verdeckt und rendert nicht mehr
if (process.env.CSDA_SHOT && !process.env.CSDA_SHOW) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
if (process.env.CSDA_FPS) { app.commandLine.appendSwitch('disable-frame-rate-limit'); app.commandLine.appendSwitch('disable-gpu-vsync') }

// 3D-Assets per cs3d://assets3d/<patch>/<pfad>; corsEnabled, sonst scheitert fetch/Textur-Laden von der file://-Seite
protocol.registerSchemesAsPrivileged([{ scheme: 'cs3d', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])

const userData = app.getPath('userData')
const dataDir = join(userData, 'matches')
const indexFile = join(dataDir, 'index.json')
const mapsDir = app.isPackaged ? join(process.resourcesPath, 'maps') : join(app.getAppPath(), 'resources', 'maps')
mkdirSync(dataDir, { recursive: true })

// crash.log: Absturzgründe ohne Konsole nachlesen (installierte App auf fremden PCs); über 1 MB → neu anfangen
const logFile = join(userData, 'crash.log')
if (existsSync(logFile) && statSync(logFile).size > 1e6) rmSync(logFile)
const log = (msg: string) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`) } catch {} }

const readIndex = (): MatchSummary[] => (existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : [])
const writeIndex = (list: MatchSummary[]) => writeFileSync(indexFile, JSON.stringify(list))
const file3d = (id: string) => join(dataDir, `${id}.3d.bin.gz`)
/**
 * 3D-Assets im Hintergrund vorbereiten (nach Import, beim App-Start, beim Öffnen eines Matches): 3D öffnen braucht danach ~nichts mehr.
 * Nur wenn 3D schon einmal gebaut wurde (Source 2 Viewer da): der erste Bau lädt eine exe herunter, braucht ~20 min und bis 3.5 GB RAM
 * und startet deshalb erst, wenn jemand das 3D-Replay öffnet (nicht ungefragt beim App-Start auf fremden PCs).
 */
const prepare3dLater = (id: string) => {
  if (existsSync(join(userData, 'tools', 'vrf', 'version.txt')) && existsSync(file3d(id))) prepareForMatch(id, file3d(id), true).catch(() => {}) // Fehler zeigt der Status
}
/** beim App-Start so viele der neuesten Demos vorbereiten (bei vorhandenem Cache je < 1 s, niedrige Priorität) */
const START_PREPARE = 3

let win: BrowserWindow

function createWindow() {
  const shot = !!process.env.CSDA_SHOT // Selbsttest: klein, ohne Fokus zu stehlen, rAF läuft auch verdeckt
  // Tests (Selbsttest oder CSDA_SECOND_SCREEN=1) auf dem zweiten Monitor öffnen, damit Berat am ersten weiterarbeiten kann
  const second = (shot || process.env.CSDA_SECOND_SCREEN) && screen.getAllDisplays().find(d => d.id !== screen.getPrimaryDisplay().id)
  const [w, h] = (process.env.CSDA_SIZE ?? '').split('x').map(Number) // Selbsttest-Größe, z. B. 1920x1080 (Vergleich mit dem Entwurf)
  // Selbsttest unsichtbar (Berat spielt): angezeigt, aber links neben allen Monitoren und ohne Taskleiste; CSDA_SHOW=1 = wie früher auf Monitor 2
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x))
  const hidden = shot && !process.env.CSDA_SHOW && { x: left - (w || 1280) - 200, y: 0 }
  win = new BrowserWindow({
    width: w || (shot ? 1280 : 1600), height: h || (shot ? 720 : 950), useContentSize: !!w, backgroundColor: '#0f1115', autoHideMenuBar: true,
    ...(hidden ? { x: hidden.x, y: hidden.y, skipTaskbar: true } : second ? { x: second.workArea.x + 20, y: second.workArea.y + 20 } : {}),
    title: 'CS Demo Analysis', show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, backgroundThrottling: !shot },
  })
  // Selbsttest/zweiter Monitor ohne Fokus-Klau anzeigen; Selbsttest nie verborgen: capturePage liefert sonst ein altes Bild (geprüft)
  if (second || shot) win.showInactive(); else win.show()
  if (shot) win.webContents.on('console-message', e => { if (e.level === 'warning' || e.level === 'error') console.log(`renderer ${e.level}: ${e.message}`) })
  const hash = process.env.CSDA_VIEW ?? ''
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

// Demos nacheinander parsen (jede braucht viel RAM); danach 3D im Hintergrund vorbereiten (eigene Schlange, assets3d/index.ts)
function importDemo(file: string): Promise<MatchSummary> {
  return serial(() => new Promise<MatchSummary>((resolve, reject) => {
    const child = utilityProcess.fork(join(__dirname, 'parser.js'))
    child.postMessage({ file, outDir: dataDir })
    child.on('message', (msg: any) => {
      if (msg.type === 'progress') win.webContents.send('import:progress', { file, pct: msg.pct, msg: msg.msg })
      if (msg.type === 'done') {
        writeIndex([...readIndex().filter(s => s.id !== msg.summary.id), msg.summary])
        resolve(msg.summary); child.kill()
        prepare3dLater(msg.summary.id)
      }
      if (msg.type === 'error') { reject(new Error(msg.message)); child.kill() }
    })
    child.on('exit', code => { if (code) reject(new Error(`Parser crashed (code ${code})`)) })
  }))
}

ipcMain.handle('library:list', () => readIndex())
ipcMain.handle('demo:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'CS2 Demo', extensions: ['dem', 'gz', 'zst', 'zip'] }],
  })
  return r.canceled ? [] : r.filePaths
})
ipcMain.handle('demo:import', (_e, file: string) => importDemo(file))
ipcMain.handle('match:load', (_e, id: string): MatchData => {
  prepare3dLater(id) // Match geöffnet: 3D vorbereiten, bis Berat '3D replay' wählt
  return JSON.parse(gunzipSync(readFileSync(join(dataDir, `${id}.json.gz`))).toString('utf8'))
})
ipcMain.handle('match:delete', (_e, id: string) => {
  rmSync(join(dataDir, `${id}.json.gz`), { force: true })
  rmSync(file3d(id), { force: true })
  rmSync(join(dataDir, `${id}.hud.json.gz`), { force: true })
  writeIndex(readIndex().filter(s => s.id !== id))
})
ipcMain.handle('map:get', (_e, map: string) => {
  const meta = JSON.parse(readFileSync(join(mapsDir, 'map_data.json'), 'utf8'))[map]
  const img = (name: string) => {
    const p = join(mapsDir, `${name}.png`)
    return existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString('base64')}` : undefined
  }
  return meta ? { ...meta, image: img(map), lowerImage: img(`${map}_lower`) } : undefined
})
// 3D-Replay: CS3D-Daten (null = alter Import ohne 3D), Asset-Bau (Status aller Matches an das Fenster), CS2-Installation
ipcMain.handle('match:load3d', (_e, id: string) => {
  const f = file3d(id)
  return existsSync(f) ? gunzipSync(readFileSync(f)) : null
})
ipcMain.handle('assets3d:prepare', (_e, id: string) => prepareForMatch(id, file3d(id)))
ipcMain.handle('assets3d:statusAll', () => prepareStatus())
onPrepareStatus(s => {
  if (s.state === 'error') log(`3D ${s.id}: ${s.msg}`)
  const w = win?.webContents; if (w && !w.isDestroyed?.()) w.send('assets3d:status', s)
})
ipcMain.handle('cs2:status', () => {
  try { const c = findCS2(); return { csgo: c.csgo, patch: c.patch } } catch (err: any) { return { error: String(err?.message ?? err) } }
})
// HUD des 3D-Replays: Zusatzdaten (null = alter Import), CS2-Icons/Schriften, Steam-Profilbilder
ipcMain.handle('match:loadHud', (_e, id: string) => {
  try { return JSON.parse(gunzipSync(readFileSync(join(dataDir, `${id}.hud.json.gz`))).toString('utf8')) } catch { return null } // fehlt/kaputt → Ersatzwerte
})
ipcMain.handle('hud:assets', () => hudAssets(app.getPath('userData')))
ipcMain.handle('avatars:get', (_e, ids: unknown) => getAvatars(Array.isArray(ids) ? ids : [], join(app.getPath('userData'), 'assets3d', 'avatars')))
ipcMain.handle('maps:available', () => readdirSync(mapsDir).filter(f => f.endsWith('.png')).map(f => f.slice(0, -4)))

// Doppelklick auf eine .dem: Datei kommt als Argument (erster Start oder zweite Instanz)
function openFromArgs(argv: string[]) {
  for (const f of argv.slice(1).filter(a => /\.(dem|zip|gz|zst)$/i.test(a) && existsSync(a))) {
    win.webContents.send('import:progress', { file: f, pct: 0, msg: 'Starting' })
    importDemo(f).then(s => win.webContents.send('demo:opened', s.id), e => win.webContents.send('demo:error', String(e?.message ?? e)))
  }
}

// Grafik-Notbetrieb: stürzt der GPU-Prozess beim Start immer wieder ab (Treiber, Virenscanner), beendet Chromium die ganze App ohne
// Meldung. Endete der letzte Lauf so (Merker 'running' blieb liegen und enthält 'gpu' = GPU-Absturz in den ersten 30 s), läuft diese
// Version ab jetzt ohne Grafikbeschleunigung und ohne eigenen GPU-Prozess; 2D geht, das 3D-Replay nicht. Neue Version → neuer Versuch.
function guardStart() {
  const runFile = join(userData, 'running'), safeFile = join(userData, 'gpu-safe-mode')
  if (existsSync(runFile) && readFileSync(runFile, 'utf8').includes('gpu')) writeFileSync(safeFile, app.getVersion())
  const gpuSafe = existsSync(safeFile) && readFileSync(safeFile, 'utf8') === app.getVersion()
  if (gpuSafe) { app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu') }
  writeFileSync(runFile, '')
  log(`start ${app.getVersion()}, Windows ${release()}, ${Math.round(totalmem() / 2 ** 30)} GB RAM${gpuSafe ? ', GPU safe mode' : ''}`)
  let quitting = false
  app.on('before-quit', () => { quitting = true })
  app.on('child-process-gone', (_e, d) => {
    log(`${d.type} process gone: ${d.reason}, code ${d.exitCode}${d.serviceName ? `, ${d.serviceName}` : ''}`)
    if (d.type === 'GPU' && d.reason !== 'clean-exit' && !quitting && process.uptime() < 30) try { appendFileSync(runFile, 'gpu') } catch {}
  })
  app.on('render-process-gone', (_e, _wc, d) => log(`window process gone: ${d.reason}, code ${d.exitCode}`))
  app.on('will-quit', () => { rmSync(runFile, { force: true }); log('quit') })
}

// Nur eine Instanz: ein zweiter Start (z. B. Doppelklick auf Demo) geht an das offene Fenster
if (!process.env.CSDA_SHOT && !app.requestSingleInstanceLock()) app.quit()
else if (!process.env.CSDA_SHOT) guardStart()
app.on('second-instance', (_e, argv) => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus(); openFromArgs(argv)
})

app.whenReady().then(async () => {
  protocol.handle('cs3d', async req => {
    const res = await handleCs3d(req)
    if (!res.ok) { console.warn(`cs3d ${res.status}: ${req.url} (next prepare3d rebuilds)`); forgetPrepare() } // fehlende Assets sichtbar machen
    return res
  })
  // Selbsttest (nur Entwicklung): CSDA_SHOT=<png> CSDA_DEMO=<demo> CSDA_VIEW=auto/<tab>/<runde>/<sek>[/<kamera>/<spielerindex>]
  const shot = process.env.CSDA_SHOT
  if (!shot) {
    createWindow()
    win.webContents.once('did-finish-load', () => {
      openFromArgs(process.argv)
      // neueste Demos nach dem Start vorbereiten (nicht während das Fenster noch lädt)
      setTimeout(() => {
        try { readIndex().sort((a, b) => b.parsedAt.localeCompare(a.parsedAt)).slice(0, START_PREPARE).forEach(s => prepare3dLater(s.id)) } catch (e) { console.warn('prepare3d at start', e) }
      }, 3000)
    })
    return
  }
  if (shot && process.env.CSDA_DEMO) {
    win = { webContents: { send() {} } } as any // Fortschritt ins Leere
    await importDemo(process.env.CSDA_DEMO).catch(e => console.error('import failed', e))
  }
  createWindow()
  // CSDA_READY=<ms>: erst warten, bis das 3D-Replay läuft (oder einen Fehler zeigt), dann CSDA_WAIT
  for (const end = Date.now() + Number(process.env.CSDA_READY ?? 0); Date.now() < end;) {
    if (await win.webContents.executeJavaScript(`!!document.querySelector('[data-h3-ready], .h3-fps, .h3-load .error')`)) break
    await new Promise(r => setTimeout(r, 500))
  }
  if (process.env.CSDA_FPS) await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))`)
  await new Promise(r => setTimeout(r, Number(process.env.CSDA_WAIT ?? 6000)))
  // 3D: Bildrate und Ladefehler für das Protokoll
  console.log('3d:', await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-h3-stats], .h3-fps, .h3-load')].map(e => [e.getAttribute('data-h3-stats'), e.textContent, e.title].filter(Boolean).join(' ')).join(' | ')`))
  if (process.env.CSDA_SCROLL) { await win.webContents.executeJavaScript(`document.querySelector('main').scrollTop = ${Number(process.env.CSDA_SCROLL)}`); await new Promise(r => setTimeout(r, 300)) }
  writeFileSync(shot, (await win.webContents.capturePage()).toPNG())
  app.quit()
})
app.on('window-all-closed', () => app.quit())
