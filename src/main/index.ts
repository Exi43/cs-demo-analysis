import { app, BrowserWindow, dialog, ipcMain, utilityProcess } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import type { MatchData, MatchSummary } from '../shared/model.ts'

const dataDir = join(app.getPath('userData'), 'matches')
const indexFile = join(dataDir, 'index.json')
const mapsDir = app.isPackaged ? join(process.resourcesPath, 'maps') : join(app.getAppPath(), 'resources', 'maps')
mkdirSync(dataDir, { recursive: true })

const readIndex = (): MatchSummary[] => (existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : [])
const writeIndex = (list: MatchSummary[]) => writeFileSync(indexFile, JSON.stringify(list))

let win: BrowserWindow

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 950, backgroundColor: '#0f1115', autoHideMenuBar: true,
    title: 'CS Demo Analysis',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false },
  })
  const hash = process.env.CSDA_VIEW ?? ''
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

// Demos nacheinander parsen (jede braucht viel RAM)
let queue = Promise.resolve()
function importDemo(file: string): Promise<MatchSummary> {
  const job = queue.then(() => new Promise<MatchSummary>((resolve, reject) => {
    const child = utilityProcess.fork(join(__dirname, 'parser.js'))
    child.postMessage({ file, outDir: dataDir })
    child.on('message', (msg: any) => {
      if (msg.type === 'progress') win.webContents.send('import:progress', { file, pct: msg.pct, msg: msg.msg })
      if (msg.type === 'done') {
        writeIndex([...readIndex().filter(s => s.id !== msg.summary.id), msg.summary])
        resolve(msg.summary); child.kill()
      }
      if (msg.type === 'error') { reject(new Error(msg.message)); child.kill() }
    })
    child.on('exit', code => { if (code) reject(new Error(`Parser crashed (code ${code})`)) })
  }))
  queue = job.then(() => undefined, () => undefined)
  return job
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
ipcMain.handle('match:load', (_e, id: string): MatchData =>
  JSON.parse(gunzipSync(readFileSync(join(dataDir, `${id}.json.gz`))).toString('utf8')))
ipcMain.handle('match:delete', (_e, id: string) => {
  rmSync(join(dataDir, `${id}.json.gz`), { force: true })
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
ipcMain.handle('maps:available', () => readdirSync(mapsDir).filter(f => f.endsWith('.png')).map(f => f.slice(0, -4)))

// Doppelklick auf eine .dem: Datei kommt als Argument (erster Start oder zweite Instanz)
function openFromArgs(argv: string[]) {
  for (const f of argv.slice(1).filter(a => /\.(dem|zip|gz|zst)$/i.test(a) && existsSync(a))) {
    win.webContents.send('import:progress', { file: f, pct: 0, msg: 'Starting' })
    importDemo(f).then(s => win.webContents.send('demo:opened', s.id), e => win.webContents.send('demo:error', String(e?.message ?? e)))
  }
}

// Nur eine Instanz: ein zweiter Start (z. B. Doppelklick auf Demo) geht an das offene Fenster
if (!process.env.CSDA_SHOT && !app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', (_e, argv) => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus(); openFromArgs(argv)
})

app.whenReady().then(async () => {
  // Selbsttest (nur Entwicklung): CSDA_SHOT=<png> CSDA_DEMO=<demo> CSDA_VIEW=auto/<tab>/<runde>/<sek>
  const shot = process.env.CSDA_SHOT
  if (!shot) {
    createWindow()
    win.webContents.once('did-finish-load', () => openFromArgs(process.argv))
    return
  }
  if (shot && process.env.CSDA_DEMO) {
    win = { webContents: { send() {} } } as any // Fortschritt ins Leere
    await importDemo(process.env.CSDA_DEMO).catch(e => console.error('import failed', e))
  }
  createWindow()
  await new Promise(r => setTimeout(r, Number(process.env.CSDA_WAIT ?? 6000)))
  if (process.env.CSDA_SCROLL) { await win.webContents.executeJavaScript(`document.querySelector('main').scrollTop = ${Number(process.env.CSDA_SCROLL)}`); await new Promise(r => setTimeout(r, 300)) }
  writeFileSync(shot, (await win.webContents.capturePage()).toPNG())
  app.quit()
})
app.on('window-all-closed', () => app.quit())
