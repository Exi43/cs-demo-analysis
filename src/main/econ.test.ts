import { describe, expect, it } from 'vitest'
import { Document } from '@gltf-transform/core'
import { econOf, quantized } from './econ'
import { fitSpace, stickerMarkup } from './assets3d/econ'

const bits = (f: number) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, f, true); return d.getUint32(0, true) }

describe('econ', () => {
  it('quantisierte Floats wie demoparser2 (Flags, Bitzahl)', () => {
    // QuantalizedFloat::new-Tests aus demoparser2 decoder.rs: [bits, flags, low, high] → [bits, flags]
    const cases: [number, number, number, number, number, number][] = [
      [15, 1, 0, 1024, 15, 0], [8, 5, -4, 12, 8, 0], [8, 0, 0, 1, 8, 0], [15, -8, 0, 1, 15, 4294967288], [10, 1, 0, 1024, 10, 0],
      [18, 4, -4096, 4096, 18, 4], [10, 4, -64, 64, 10, 4], [20, 4, 0, 128, 20, 0], [8, -8, 0, 1, 8, 4294967288], [10, 2, -25, 25, 10, 0],
      [10, 2, 0, 102.300003, 10, 2], [8, 2, 0, 60, 8, 2], [6, 2, 0, 64, 6, 0], [7, 1, 0, 360, 7, 0], [17, 4, -4096, 4096, 17, 4],
    ]
    for (const [b, f, lo, hi, nb, nf] of cases) expect([b, f, lo, hi, quantized(b, f, lo, hi)]).toEqual([b, f, lo, hi, { k: expect.any(Number), n: nb, fl: nf }])
  })

  it('Attributliste → Aufkleber und Anhänger', () => {
    // Glock aus user-demo (EOM: Aufkleber 4516 auf Platz 3, StatTrak 2853) + Anhänger mit Ort
    const attrs: [number, number][] = [[6, bits(694)], [7, bits(426)], [8, bits(0.285)], [80, 2853], [81, 0], [125, 4516], [126, bits(0.5)], [128, bits(-27)],
      [282, bits(-0.1)], [283, bits(0.02)], [293, 2], [299, 41], [300, bits(19.15)], [301, bits(0.2474)], [302, bits(7.352)], [306, 48163]]
    expect(econOf(attrs)).toEqual({
      stickers: [{ slot: 3, id: 4516, wear: 0.5, rot: -27, schema: 2 }],
      charm: { id: 41, x: 19.15, y: 0.2474, z: 7.352, seed: 48163 },
    })
    expect(econOf([[6, bits(694)], [7, bits(426)], [8, bits(0.285)]])).toBeUndefined()
    expect(econOf([[113, 6696], [278, bits(-0.1838)], [279, bits(-0.006086)], [290, 3]])?.stickers).toEqual([{ slot: 0, id: 6696, x: -0.1838, y: -0.0061, schema: 3 }])
  })

  it('StickerMarkup und Sticker-Raum', () => {
    const txt = `StickerMarkup =\n[\n{\nIndex = 1\nMesh = "body_hd"\nUICameraRotation = [ 0.0, 0.0 ]\nOffset = [ 0.061, -0.434 ]\nScale = 14.100022\nRotation = 0.0\n}\n{\nIndex = 0\nMesh = "body_hd"\nOffset = [ 0.148, -0.434 ]\nScale = 14.1\nRotation = 0.029\n}\n]`
    expect(stickerMarkup(txt)).toEqual({ body_hd: [{ x: 0.148, y: -0.434, scale: 14.1, rot: 0.029 }, { x: 0.061, y: -0.434, scale: 14.100022, rot: 0 }] })
    // Seitenprojektion wie die AK: uv2 = (−1,0357·z + 0,69, −1,0357·y + 0,13) auf der +x-Seite, andere Seite uv2.x = −1,5
    const doc = new Document(), P: number[] = [], N: number[] = [], U: number[] = []
    for (let i = 0; i < 60; i++) {
      const x = i % 2 ? 0.02 : -0.02, y = Math.sin(i) * 0.1, z = Math.cos(i * 1.7) * 0.4
      P.push(x, y, z); N.push(Math.sign(x), 0, 0); U.push(x > 0 ? -1.0357 * z + 0.6918 : -1.5, -1.0357 * y + 0.129)
    }
    const acc = (a: number[], t: 'VEC3' | 'VEC2') => doc.createAccessor().setType(t).setArray(new Float32Array(a))
    const prim = doc.createPrimitive().setAttribute('POSITION', acc(P, 'VEC3')).setAttribute('NORMAL', acc(N, 'VEC3')).setAttribute('TEXCOORD_1', acc(U, 'VEC2'))
    const f = fitSpace(prim)!
    expect(f.u.map(v => +v.toFixed(3))).toEqual([0, 0, -1.036, 0.692])
    expect(f.v.map(v => +v.toFixed(3))).toEqual([0, -1.036, 0, 0.129])
    expect(f.s.map(v => Math.round(v) + 0)).toEqual([1, 0, 0])
  })
})
