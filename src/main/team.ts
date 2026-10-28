// Team-Sync (Main): Anmeldung (Refresh-Token mit safeStorage verschlüsselt), letzter Team-Stand für den Offline-Start, Clip-Cache und
// Bilder der Team-Lineups. Alles unter <userData>/team, Bilder im Utility-Ordner (gleiche sha1-Namen wie lokale Lineups).
import { app, ipcMain, safeStorage } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { HASH_RE } from '../shared/utility-lib.ts'
import { writeAtomic } from './assets3d/cs2.ts'

export const CLIP_RE = /^[0-9a-f-]{36}\.webm$/
const MAX_CLIP = 16 * 2 ** 20
const MAX_CACHE = 64 * 2 ** 20

const read = (f: string) => (existsSync(f) ? readFileSync(f) : null)

export function registerTeam() {
  const dir = join(app.getPath('userData'), 'team'), images = join(app.getPath('userData'), 'utility', 'images')
  const put = (f: string, data: Uint8Array) => { mkdirSync(join(f, '..'), { recursive: true }); writeAtomic(f, Buffer.from(data)) }

  // Sitzung (JSON mit Refresh-Token): verschlüsselt, wenn das System es kann (Windows: DPAPI, immer)
  // Selbsttest: unverschlüsselte Test-Anmeldung session.json; ein erneuerter Token muss auch dorthin (Supabase tauscht ihn aus)
  const testSession = () => !!process.env.CSDA_SHOT && existsSync(join(dir, 'session.json'))
  ipcMain.handle('team:session', () => {
    if (testSession()) return readFileSync(join(dir, 'session.json'), 'utf8')
    const b = read(join(dir, 'session.bin'))
    if (!b) return null
    try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString('utf8') } catch { return null }
  })
  ipcMain.handle('team:setSession', (_e, s: unknown) => {
    const test = testSession(), f = join(dir, test ? 'session.json' : 'session.bin')
    if (s == null) { rmSync(f, { force: true }); return }
    if (typeof s !== 'string' || s.length > 20000) throw new Error('Invalid session')
    put(f, test ? Buffer.from(s) : safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s) : Buffer.from(s))
  })
  // letzter Team-Stand + Warteschlange (App startet offline damit)
  ipcMain.handle('team:loadCache', () => read(join(dir, 'cache.json'))?.toString('utf8') ?? null)
  ipcMain.handle('team:saveCache', (_e, s: unknown) => {
    if (typeof s !== 'string' || s.length > MAX_CACHE) throw new Error('Invalid team cache')
    put(join(dir, 'cache.json'), Buffer.from(s))
  })
  // Clips: einmal heruntergeladen, danach immer lokal
  // shortcut: ersetzte Clips bleiben im Cache liegen (je ≤ 8 MB), aufräumen erst, wenn es jemanden stört
  ipcMain.handle('team:clipGet', (_e, name: unknown) => (typeof name === 'string' && CLIP_RE.test(name) ? read(join(dir, 'clips', name)) : null))
  ipcMain.handle('team:clipPut', (_e, name: unknown, data: unknown) => {
    if (typeof name !== 'string' || !CLIP_RE.test(name) || !(data instanceof Uint8Array) || data.length > MAX_CLIP) throw new Error('Invalid clip')
    put(join(dir, 'clips', name), data)
  })
  // Bilder der Team-Lineups: lokal lesen (Hochladen) bzw. heruntergeladene ablegen, nur wenn der Inhalt zum sha1-Namen passt
  ipcMain.handle('team:imageGet', (_e, hash: unknown) => (typeof hash === 'string' && HASH_RE.test(hash) ? read(join(images, `${hash}.webp`)) : null))
  ipcMain.handle('team:imagePut', (_e, hash: unknown, data: unknown) => {
    if (typeof hash !== 'string' || !HASH_RE.test(hash) || !(data instanceof Uint8Array) || data.length > 4 * 2 ** 20) throw new Error('Invalid image')
    if (createHash('sha1').update(data).digest('hex') !== hash) throw new Error('Image checksum mismatch')
    // WebP-Kennung (RIFF….WEBP); das Fenster zeigt es nur als <img>
    if (Buffer.from(data.subarray(0, 4)).toString('latin1') !== 'RIFF' || Buffer.from(data.subarray(8, 12)).toString('latin1') !== 'WEBP') throw new Error('Not a WebP image')
    const f = join(images, `${hash}.webp`)
    if (!existsSync(f)) put(f, data)
  })
}
