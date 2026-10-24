// Läuft als eigener Prozess (utilityProcess, gestartet von index.ts), damit das Fenster beim Asset-Bau nicht einfriert.
// PC schonen: niedrige Priorität (VRF erbt sie), libvips 1 Thread, kein Bild-Cache. Liest den Header von <id>.3d.bin.gz selbst
// ([u32 headerLen][Header-JSON]…; v2-Header ohne skins), damit der Main-Prozess nicht entpacken muss.
import { readFileSync } from 'node:fs'
import { setPriority, constants } from 'node:os'
import { gunzipSync } from 'node:zlib'
import sharp from 'sharp'
import { prepareInput } from '../../shared/assets3d.ts'
import type { CS3DHeader } from '../../shared/cs3d.ts'
import { prepare3d } from './prepare.ts'

try { setPriority(constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
sharp.concurrency(1)
sharp.cache(false)

const port = (process as any).parentPort
port.on('message', async (e: { data: { file3d: string; root: string } }) => {
  try {
    const raw = gunzipSync(readFileSync(e.data.file3d))
    const h: CS3DHeader = JSON.parse(raw.toString('utf8', 4, 4 + raw.readUInt32LE(0)))
    h.skins ??= []
    // ein Asset-Profil: Low quality ist nur noch eine Render-Option (engine/index.ts), braucht keinen eigenen Bau
    const assets = await prepare3d({ root: e.data.root, ...prepareInput(h), profile: 'high' }, p => port.postMessage({ type: 'progress', p }))
    port.postMessage({ type: 'done', assets })
  } catch (err: any) {
    port.postMessage({ type: 'error', message: String(err?.message ?? err) })
  }
})
