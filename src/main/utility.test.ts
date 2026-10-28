// Utility-Speicher (utility.ts): atomar speichern, kaputte Datei behalten, Bilder → WebP nach Hash, Export → Import mit Prüfung
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Lineup, UtilityLibrary } from '../shared/utility.ts'
import { emptyLibrary } from '../shared/utility-lib.ts'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, dialog: {}, ipcMain: {}, shell: {} }))
const { buildExport, commitImport, exportSize, loadLibrary, readImport, saveLibrary, storeImage } = await import('./utility.ts')

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'csda-util-')); dirs.push(d); return d }
const L = (id: string, o: Partial<Lineup> = {}): Lineup => ({
  id, map: 'de_mirage', type: 'smoke', side: 'T', title: 'Window', stand: { x: 1, y: 2 }, target: { x: 3, y: 4 },
  technique: ['jumpthrow'], steps: ['Stand in the corner'], images: [], tags: [], owner: 'local', createdAt: 1, updatedAt: 2, ...o,
})
const lib = (lineups: Lineup[]): UtilityLibrary => ({ ...emptyLibrary(), lineups })
// Bild mit Verlauf und Formen (komprimiert wie ein Screenshot, nicht wie Rauschen)
const picture = (w: number, h: number) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="g"><stop offset="0" stop-color="#c9a36b"/><stop offset="1" stop-color="#5a7fa8"/></linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>${Array.from({ length: 40 }, (_, i) => `<circle cx="${(i * 97) % w}" cy="${(i * 61) % h}" r="${20 + (i % 7) * 9}" fill="#${(i * 2654435).toString(16).slice(-6).padStart(6, '3')}"/>`).join('')}
</svg>`)).png().toBuffer()

describe('Bibliothek', () => {
  it('speichert atomar und liest wieder; ungültige Daten überschreiben nichts', () => {
    const d = tmp(), l = lib([L('a')])
    saveLibrary(d, l)
    expect(readdirSync(d)).toEqual(['library.json'])
    expect(loadLibrary(d)).toEqual({ lib: l })
    expect(() => saveLibrary(d, lib([L('a', { type: 'nuke' as never })]))).toThrow('type')
    expect(loadLibrary(d).lib).toEqual(l)
  })
  it('behält eine kaputte Datei und startet leer', () => {
    const d = tmp()
    writeFileSync(join(d, 'library.json'), '{"version":1,"lineups":[{"id":')
    const r = loadLibrary(d)
    expect(r.lib).toEqual(emptyLibrary())
    expect(r.warning).toMatch(/kept as library\.broken-\d+\.json/)
    expect(readdirSync(d)[0]).toMatch(/^library\.broken-\d+\.json$/)
  })
  it('fehlende Datei = leere Bibliothek', () => expect(loadLibrary(tmp())).toEqual({ lib: emptyLibrary() }))
})

describe('Bilder', () => {
  it('WebP, längste Seite 1280, ≤ 100 KB, gleiches Bild = gleiche Datei', async () => {
    const d = tmp(), png = await picture(2560, 1440)
    const h = await storeImage(d, png)
    expect(h).toMatch(/^[0-9a-f]{40}$/)
    const f = join(d, 'images', `${h}.webp`), m = await sharp(readFileSync(f)).metadata() // Puffer: Pfad hielte die Datei offen (libvips-Cache)
    expect([m.format, m.width, m.height]).toEqual(['webp', 1280, 720])
    expect(readFileSync(f).length).toBeLessThanOrEqual(100_000)
    expect(await storeImage(d, png)).toBe(h)
    expect(readdirSync(join(d, 'images'))).toEqual([`${h}.webp`])
  })
})

describe('Export und Import', () => {
  it('Rundreise mit Bild; Größe vorher bekannt', async () => {
    const a = tmp(), b = tmp(), h = await storeImage(a, await picture(800, 600))
    const src = lib([L('a', { images: [h] })])
    const size = exportSize(a, src), file = join(a, 'out.csutil'), data = JSON.stringify(buildExport(a, src, false))
    writeFileSync(file, data)
    expect(Math.abs(size.base - data.length)).toBeLessThan(400)
    expect(size.imageCount).toBe(1)
    const r = await readImport(b, file)
    expect(r.library.lineups).toEqual(src.lineups)
    expect([...r.pending.images.keys()]).toEqual([h])
    expect(existsSync(join(b, 'images'))).toBe(false) // erst nach der Bestätigung
    commitImport(b, r.pending)
    expect(readdirSync(join(b, 'images'))).toEqual([`${h}.webp`])
  })
  it('lehnt beschädigte oder fremde Bilder ab, lässt fehlende Verweise weg', async () => {
    const a = tmp(), h = await storeImage(a, await picture(400, 300))
    const exp = buildExport(a, lib([L('a', { images: [h] })]), false), file = join(a, 'x.csutil')
    const write = (o: object) => writeFileSync(file, JSON.stringify(o))
    write({ ...exp, images: { [h]: Buffer.from('not the image').toString('base64') } })
    await expect(readImport(tmp(), file)).rejects.toThrow('checksum mismatch')
    const png = await picture(40, 30), { createHash } = await import('node:crypto'), ph = createHash('sha1').update(png).digest('hex')
    write({ ...exp, library: lib([L('a', { images: [ph] })]), images: { [ph]: png.toString('base64') } })
    await expect(readImport(tmp(), file)).rejects.toThrow('not a valid WebP image')
    write({ ...exp, images: {} })
    expect((await readImport(tmp(), file)).library.lineups[0].images).toEqual([])
    writeFileSync(file, 'MZ\x90\x00 not json')
    await expect(readImport(tmp(), file)).rejects.toThrow('no valid JSON')
  })
})
