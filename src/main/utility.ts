// Utility-Dashboard (Main): Bibliothek <userData>/utility/library.json (atomar geschrieben), Bilder images/<sha1>.webp (sharp, ≤ 1280 px,
// Ziel 50–100 KB), lokale Videos videos/<sha1>.<ext> (nur auf diesem PC), Export/Import (.csutil = JSON, Bilder als base64) und das
// Protokoll csutil:// (img/<sha1>.webp, radar/<map>.png) für das Fenster. Abgleich und Prüfung: shared/utility-lib.ts.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { UtilityLibrary } from '../shared/utility.ts'
import { EXPORT_FORMAT, HASH_RE, VIDEO_RE, emptyLibrary, isWebUrl, parseExport, parseLibrary, type UtilityExport } from '../shared/utility-lib.ts'
import { writeAtomic } from './assets3d/cs2.ts'

/** sharp erst bei Bedarf laden: beim App-Start kostete es ~65 ms vor dem ersten Fenster */
const loadSharp = async () => (await import('sharp')).default
/** Import-Datei höchstens (fremde Eingabe; JSON.parse braucht ein Mehrfaches an RAM) */
export const MAX_IMPORT = 256 * 2 ** 20
export const MAX_VIDEO = 50 * 2 ** 20
const MAX_IMAGE_IN = 40 * 2 ** 20
const MAX_IMAGE_STORED = 2 * 2 ** 20
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.tif', '.tiff']
const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest('hex')
const b64Len = (n: number) => Math.ceil(n / 3) * 4

export interface Pending { images: Map<string, Buffer>; videos: Map<string, Buffer> }

/** library.json lesen; fehlt → leer; kaputt → als library.broken-<zeit>.json behalten (nichts geht verloren) und leer starten */
export function loadLibrary(dir: string): { lib: UtilityLibrary; warning?: string } {
  const f = join(dir, 'library.json')
  if (!existsSync(f)) return { lib: emptyLibrary() }
  try {
    return { lib: parseLibrary(JSON.parse(readFileSync(f, 'utf8'))) }
  } catch (e) {
    const bak = join(dir, `library.broken-${Date.now()}.json`)
    renameSync(f, bak)
    console.warn(`Utility library unreadable, kept as ${bak}: ${e instanceof Error ? e.message : e}`)
    return { lib: emptyLibrary(), warning: `Your utility library could not be read and was kept as ${basename(bak)}. Starting with an empty library.` }
  }
}

export function saveLibrary(dir: string, lib: unknown) {
  mkdirSync(dir, { recursive: true })
  writeAtomic(join(dir, 'library.json'), JSON.stringify(parseLibrary(lib), null, 1))
}

/** Bild → WebP (längste Seite ≤ 1280, EXIF gedreht), so lange gröber, bis ≤ 100 KB; Ablage nach Inhalts-Hash (gleiches Bild = eine Datei) */
export async function storeImage(dir: string, input: Buffer): Promise<string> {
  if (input.length > MAX_IMAGE_IN) throw new Error('Image is larger than 40 MB')
  let out = Buffer.alloc(0)
  const sharp = await loadSharp()
  for (const [px, q] of [[1280, 80], [1280, 68], [1280, 56], [1024, 56], [800, 50]]) {
    out = await sharp(input, { limitInputPixels: 1e8 }).rotate().resize(px, px, { fit: 'inside', withoutEnlargement: true }).webp({ quality: q, effort: 5 }).toBuffer()
    if (out.length <= 100_000) break
  }
  const hash = sha1(out), f = join(dir, 'images', `${hash}.webp`)
  mkdirSync(join(dir, 'images'), { recursive: true })
  if (!existsSync(f)) writeAtomic(f, out)
  return hash
}

/** lokales Video (mp4/webm ≤ 50 MB) in den Utility-Ordner kopieren → Dateiname <sha1>.<ext> */
export function storeVideo(dir: string, file: string): string {
  const ext = extname(file).toLowerCase()
  if (ext !== '.mp4' && ext !== '.webm') throw new Error('Only .mp4 and .webm videos are supported')
  if (statSync(file).size > MAX_VIDEO) throw new Error('Video is larger than 50 MB')
  const data = readFileSync(file), name = `${sha1(data)}${ext}`, f = join(dir, 'videos', name)
  mkdirSync(join(dir, 'videos'), { recursive: true })
  if (!existsSync(f)) writeAtomic(f, data)
  return name
}

/** Exportdatei bauen: Bilder (und gewählte Videos) als base64; fehlende Dateien bleiben einfach weg */
export function buildExport(dir: string, lib: unknown, withVideos: boolean): UtilityExport {
  const sub = parseLibrary(lib), images: Record<string, string> = {}, videos: Record<string, string> = {}
  for (const l of sub.lineups) {
    for (const h of l.images) { const f = join(dir, 'images', `${h}.webp`); if (!images[h] && existsSync(f)) images[h] = readFileSync(f).toString('base64') }
    const v = l.video?.local, vf = v && join(dir, 'videos', v)
    if (withVideos && v && vf && !videos[v] && existsSync(vf)) videos[v] = readFileSync(vf).toString('base64')
  }
  return { format: EXPORT_FORMAT, version: 1, exportedAt: Date.now(), library: sub, images, ...(withVideos ? { videos } : {}) }
}

/** geschätzte Dateigröße ohne / mit lokalen Videos (für die Anzeige vor dem Export) */
export function exportSize(dir: string, lib: unknown) {
  const sub = parseLibrary(lib), seen = new Set<string>()
  let base = JSON.stringify(sub).length + 200, videos = 0, imageCount = 0, videoCount = 0
  const size = (f: string) => (existsSync(f) ? statSync(f).size : 0)
  for (const l of sub.lineups) {
    for (const h of l.images) if (!seen.has(h)) { seen.add(h); const s = size(join(dir, 'images', `${h}.webp`)); if (s) { base += b64Len(s) + 50; imageCount++ } }
    const v = l.video?.local
    if (v && !seen.has(v)) { seen.add(v); const s = size(join(dir, 'videos', v)); if (s) { videos += b64Len(s) + 60; videoCount++ } }
  }
  return { base, videos, imageCount, videoCount }
}

/**
 * Import-Datei lesen (fremde Eingabe): Größe begrenzen, Schema prüfen (parseExport), Bilder/Videos dekodieren und gegen ihren
 * sha1-Namen prüfen, Bilder müssen WebP ≤ 4096 px sein. Verweise auf Medien, die weder in der Datei noch lokal liegen, fallen weg.
 * Geschrieben wird erst mit commitImport (nach der Vorschau).
 */
export async function readImport(dir: string, file: string): Promise<{ library: UtilityLibrary; pending: Pending }> {
  if (statSync(file).size > MAX_IMPORT) throw new Error(`File is larger than ${MAX_IMPORT / 2 ** 20} MB`)
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error('Not a CS Demo Analysis utility file (no valid JSON)') }
  const { library, images, videos } = parseExport(raw, b64Len(MAX_IMAGE_STORED), b64Len(MAX_VIDEO))
  const pending: Pending = { images: new Map(), videos: new Map() }
  const sharp = await loadSharp()
  for (const [h, b64] of Object.entries(images)) {
    const buf = Buffer.from(b64, 'base64')
    if (sha1(buf) !== h) throw new Error(`Image ${h} is damaged (checksum mismatch)`)
    const m = await sharp(buf).metadata().catch(() => undefined)
    if (m?.format !== 'webp' || !m.width || !m.height || m.width > 4096 || m.height > 4096) throw new Error(`Image ${h} is not a valid WebP image`)
    pending.images.set(h, buf)
  }
  for (const [name, b64] of Object.entries(videos)) {
    const buf = Buffer.from(b64, 'base64')
    if (`${sha1(buf)}${extname(name)}` !== name) throw new Error(`Video ${name} is damaged (checksum mismatch)`)
    pending.videos.set(name, buf)
  }
  const local = (sub: string, name: string) => existsSync(join(dir, sub, name))
  for (const l of library.lineups) {
    l.images = l.images.filter(h => pending.images.has(h) || local('images', `${h}.webp`))
    const v = l.video?.local
    if (v && !pending.videos.has(v) && !local('videos', v)) l.video = l.video?.url ? { url: l.video.url } : undefined
  }
  return { library, pending }
}

export function commitImport(dir: string, p: Pending) {
  for (const [sub, m, ext] of [['images', p.images, '.webp'], ['videos', p.videos, '']] as const) {
    if (!m.size) continue
    mkdirSync(join(dir, sub), { recursive: true })
    for (const [name, buf] of m) { const f = join(dir, sub, name + ext); if (!existsSync(f)) writeAtomic(f, buf) }
  }
}

const file = async (f: string, type: string) => {
  try { return new Response(await readFile(f), { headers: { 'content-type': type, 'cache-control': 'max-age=31536000, immutable' } }) } catch { return new Response(null, { status: 404 }) }
}

/** IPC 'utility:*' und das Protokoll csutil:// (handle nach app ready); win = Elternfenster der Dialoge */
export function registerUtility(mapsDir: string, win: () => BrowserWindow | undefined) {
  const dir = join(app.getPath('userData'), 'utility')
  let pending: Pending | undefined
  const parent = () => { const w = win(); return w && !w.isDestroyed() ? w : undefined }
  const open = (o: Electron.OpenDialogOptions) => { const w = parent(); return w ? dialog.showOpenDialog(w, o) : dialog.showOpenDialog(o) }

  ipcMain.handle('utility:load', () => loadLibrary(dir))
  ipcMain.handle('utility:save', (_e, lib: unknown) => saveLibrary(dir, lib))
  ipcMain.handle('utility:maps', () => ({
    meta: JSON.parse(readFileSync(join(mapsDir, 'map_data.json'), 'utf8')),
    radars: readdirSync(mapsDir).filter(f => f.endsWith('.png')).map(f => f.slice(0, -4)),
  }))
  // Bilder: Pfade (Ziehen aus dem Explorer) oder Dateidialog; Fehler je Datei, die anderen gehen trotzdem
  ipcMain.handle('utility:addImages', async (_e, paths: unknown) => {
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string')
      : (await open({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: IMAGE_EXT.map(e => e.slice(1)) }] })).filePaths
    const hashes: string[] = [], errors: string[] = []
    for (const p of list) {
      try {
        if (!IMAGE_EXT.includes(extname(p).toLowerCase())) throw new Error('not an image')
        if (statSync(p).size > MAX_IMAGE_IN) throw new Error('larger than 40 MB')
        hashes.push(await storeImage(dir, readFileSync(p)))
      } catch (e) { errors.push(`${basename(p)}: ${e instanceof Error ? e.message : e}`) }
    }
    return { hashes, errors }
  })
  // eingefügtes Bild (Zwischenablage, keine Datei)
  ipcMain.handle('utility:addImageData', (_e, data: unknown) => {
    if (!(data instanceof Uint8Array)) throw new Error('No image data')
    return storeImage(dir, Buffer.from(data))
  })
  ipcMain.handle('utility:addVideo', async (_e, path: unknown) => {
    const f = typeof path === 'string' ? path : (await open({ properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'webm'] }] })).filePaths[0]
    return f ? storeVideo(dir, f) : null
  })
  // Link im Browser (nur http/https) oder lokales Video im Standard-Player; nie eingebettet
  ipcMain.handle('utility:open', async (_e, t: unknown) => {
    const o = (t && typeof t === 'object' ? t : {}) as { url?: unknown; local?: unknown }
    if (typeof o.url === 'string') { if (!isWebUrl(o.url)) throw new Error('Only http and https links can be opened'); return shell.openExternal(o.url) }
    if (typeof o.local === 'string' && VIDEO_RE.test(o.local)) {
      const f = join(dir, 'videos', o.local)
      if (!existsSync(f)) throw new Error('This video is not on this PC')
      const err = await shell.openPath(f)
      if (err) throw new Error(err)
    }
  })
  ipcMain.handle('utility:exportSize', (_e, lib: unknown) => exportSize(dir, lib))
  ipcMain.handle('utility:export', async (_e, lib: unknown, withVideos: unknown, name: unknown) => {
    const data = JSON.stringify(buildExport(dir, lib, withVideos === true))
    if (data.length > MAX_IMPORT) throw new Error(`Export would be larger than ${MAX_IMPORT / 2 ** 20} MB (too big to import). Leave out local videos or export fewer lineups.`)
    const o: Electron.SaveDialogOptions = { defaultPath: join(app.getPath('documents'), `${String(name || 'utility').replace(/[^\w .-]+/g, '_')}.csutil`), filters: [{ name: 'CS utility library', extensions: ['csutil'] }] }
    const w = parent(), r = w ? await dialog.showSaveDialog(w, o) : await dialog.showSaveDialog(o)
    if (r.canceled || !r.filePath) return null
    writeAtomic(r.filePath, data)
    return r.filePath
  })
  // Import in zwei Schritten: lesen + prüfen (Vorschau im Fenster), nach der Bestätigung Medien schreiben; Bibliothek speichert das Fenster
  ipcMain.handle('utility:importOpen', async () => {
    const f = (process.env.CSDA_SHOT && process.env.CSDA_UTIL_IMPORT) // Selbsttest: Datei statt Dialog
      || (await open({ properties: ['openFile'], filters: [{ name: 'CS utility library', extensions: ['csutil', 'json'] }] })).filePaths[0]
    if (!f) return null
    const r = await readImport(dir, f)
    pending = r.pending
    return { library: r.library, file: basename(f), images: r.pending.images.size, videos: r.pending.videos.size }
  })
  ipcMain.handle('utility:importCommit', () => { if (pending) commitImport(dir, pending); pending = undefined })
  ipcMain.handle('utility:importCancel', () => { pending = undefined })

  return (req: Request): Promise<Response> | Response => {
    const u = new URL(req.url), name = decodeURIComponent(u.pathname.slice(1))
    if (u.host === 'img' && HASH_RE.test(name.replace(/\.webp$/, '')) && name.endsWith('.webp')) return file(join(dir, 'images', name), 'image/webp')
    if (u.host === 'radar' && /^[a-z0-9_]+\.png$/.test(name)) return file(join(mapsDir, name), 'image/png')
    return new Response(null, { status: 404 })
  }
}
