// demoKey der Team-Lesezeichen = Match-ID (demoId über die entpackte Demo): gleiche Demo → gleicher Schlüssel, auch gepackt
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { demoId, readDemoBuffer } from './parse.ts'

describe('demoKey', () => {
  it('ist für .dem und .dem.gz gleich und hängt am Inhalt', () => {
    const dem = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7919) % 251))
    expect(demoId(readDemoBuffer(gzipSync(dem)))).toBe(demoId(readDemoBuffer(dem)))
    const other = Buffer.from(dem); other[5] ^= 1
    expect(demoId(other)).not.toBe(demoId(dem))
    expect(demoId(dem)).toMatch(/^[0-9a-f]{16}$/)
  })
})
