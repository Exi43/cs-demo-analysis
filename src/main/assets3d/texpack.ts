// tex.pack: alle Map-Texturen (json.images der .gltf, in dieser Reihenfolge) als EIN Stream für den Renderer (engine/texstream.ts).
// Format [u32 n][u32 len × n][Dateien]. Grund: cs3d:// kostet je Request ~1.6 ms im Main-Prozess, 630 Dateien 0.8–1.1 s,
// ein Pack 0.18–0.28 s (gemessen, perf/load netbench). Kein neues Asset-Format: wird beim Abruf aus tex/ zusammengesetzt.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export function texPackResponse(dir: string): Response {
  let files: string[], head: Uint32Array, total: number
  try { // Map nicht (fertig) gebaut → 404
    const gltf = readdirSync(dir).find(f => f.endsWith('.gltf'))
    if (!gltf) return new Response(null, { status: 404 })
    files = (JSON.parse(readFileSync(join(dir, gltf), 'utf8')).images ?? []).map((im: { uri: string }) => resolve(dir, decodeURIComponent(im.uri)))
    if (files.some(f => !f.startsWith(dir + sep))) return new Response(null, { status: 403 })
    head = new Uint32Array(files.length + 1)
    head[0] = files.length
    total = head.byteLength
    // fehlende Datei (Bau abgebrochen, Virenscanner): Länge 0 statt ganzes Pack 404, die Map lädt ohne diese eine Textur
    files.forEach((f, i) => { total += (head[i + 1] = statSync(f, { throwIfNoEntry: false })?.size ?? 0) })
  } catch { return new Response(null, { status: 404 }) }
  // 8 Dateien voraus lesen (nacheinander: 0.5 s für Dust2, Dateisystem-Latenz je Datei)
  const reads: Promise<Buffer>[] = []
  let next = 0, sent = false
  // Lesefehler → Nullen in der angekündigten Länge, sonst verrutscht der Stream für alle folgenden Dateien
  const fill = () => { while (reads.length < 8 && next < files.length) { const len = head[next + 1]; reads.push(readFile(files[next++]).catch(() => Buffer.alloc(len))) } }
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (!sent) { sent = true; fill(); return c.enqueue(new Uint8Array(head.buffer)) }
      if (!reads.length) return c.close()
      const b = await reads.shift()!
      fill()
      c.enqueue(b)
    },
  })
  return new Response(body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(total) } })
}
