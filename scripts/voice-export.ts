// node scripts/voice-export.ts <demo> → demos/voice/<Spieler>.ogg
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as dp from '@laihoe/demoparser2'
import { readDemoBuffer } from '../src/main/parse.ts'
import { extractVoice, toOggOpus } from '../src/main/voice.ts'

const buf = readDemoBuffer(readFileSync(process.argv[2]))
const t0 = Date.now()
const packets = extractVoice(buf)
console.log(`${packets.length} Voice-Pakete in ${Date.now() - t0} ms`)
const names = Object.fromEntries((dp.parsePlayerInfo(buf) as any[]).map(p => [p.steamid, p.name]))
mkdirSync('demos/voice', { recursive: true })
const by = new Map<string, typeof packets>()
for (const p of packets) (by.get(p.steamid) ?? by.set(p.steamid, []).get(p.steamid)!).push(p)
for (const [s, ps] of by) {
  const file = `demos/voice/${(names[s] ?? s).replace(/[^\w-]/g, '_')}.ogg`
  writeFileSync(file, toOggOpus(ps))
  console.log(file, ps.length, 'Pakete')
}
