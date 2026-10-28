// Läuft als eigener Prozess (utilityProcess, gestartet von index.ts), damit das Fenster beim Asset-Bau nicht einfriert.
// PC schonen: immer niedrige Priorität (VRF erbt sie), libvips 1 Thread je Bild, kein Bild-Cache. Hintergrund (bg) wie früher nacheinander;
// wartet die 3D-Ansicht (bg = false oder später 'boost'): Teile gleichzeitig (cs2.ts lane/slots/images), zusammen etwa Kerne − 2 Threads.
// Liest den Header von <id>.3d.bin.gz selbst ([u32 headerLen][Header-JSON]…; v2-Header ohne skins), damit der Main-Prozess nicht entpacken muss.
import { readFileSync } from 'node:fs'
import { availableParallelism, setPriority, constants } from 'node:os'
import { gunzipSync } from 'node:zlib'
import sharp from 'sharp'
import { prepareInput } from '../../shared/assets3d.ts'
import type { CS3DHeader } from '../../shared/cs3d.ts'
import { boost, images, MAX_SLOTS, slots } from './cs2.ts'
import { prepare3d } from './prepare.ts'

try { setPriority(constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
sharp.concurrency(1)
sharp.cache(false)
// Vordergrund: Skin-Stapel (je ~1 Kern VRF + Umwandlung) und Bildaufträge (≤ libuv-Threads aus index.ts) nach Kernen
const cores = Math.max(2, availableParallelism() - 2), uv = Number(process.env.UV_THREADPOOL_SIZE) || 2
const goFast = () => { boost(); slots.set(Math.min(MAX_SLOTS, Math.max(1, Math.floor(cores / 3)))); images.set(Math.min(uv, Math.max(2, Math.floor(cores / 2)))) }

const port = (process as any).parentPort
// file3d = Match; map = nur die Map (Utility-Vorschau eines Lineups ohne Demo)
port.on('message', async (e: { data: ({ file3d: string } | { map: string }) & { root: string; bg?: boolean } | { boost: true } }) => {
  if ('boost' in e.data) return goFast()
  if (!e.data.bg) goFast()
  try {
    const progress = (p: unknown) => port.postMessage({ type: 'progress', p })
    let assets
    if ('map' in e.data) assets = await prepare3d({ root: e.data.root, map: e.data.map, agents: [], weapons: [], profile: 'high', mapOnly: true }, progress)
    else {
      const raw = gunzipSync(readFileSync(e.data.file3d))
      const h: CS3DHeader = JSON.parse(raw.toString('utf8', 4, 4 + raw.readUInt32LE(0)))
      h.skins ??= []
      // ein Asset-Profil: Low quality ist nur noch eine Render-Option (engine/index.ts), braucht keinen eigenen Bau
      assets = await prepare3d({ root: e.data.root, ...prepareInput(h), profile: 'high' }, progress)
    }
    port.postMessage({ type: 'done', assets })
  } catch (err: any) {
    port.postMessage({ type: 'error', message: String(err?.message ?? err) })
  }
})
