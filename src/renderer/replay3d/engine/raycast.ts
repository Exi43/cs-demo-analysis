// Strahltest gegen die Map ohne Zusatzpaket: gleichmäßiges 3D-Gitter über alle Dreiecke (Welt, glTF-Meter) + 3D-DDA.
// shortcut: Zellen über Dreiecks-AABB (nicht exakt), reicht für Tracer/Kamera; bei Bedarf three-mesh-bvh (package.json)
import { Matrix4, type BufferAttribute, type InstancedMesh, type InterleavedBufferAttribute, type Mesh, type Vector3 } from 'three'

export type Raycast = (origin: Vector3, dir: Vector3, far: number) => number

/** Eingabe des Gitterbaus je Mesh: Positionen roh (ggf. interleaved/quantisiert), Index, Weltmatrix je Instanz */
interface Part { a: ArrayLike<number>; stride: number; off: number; norm: boolean; count: number; idx: ArrayLike<number> | null; mats: Float32Array }
export interface Grid { P: Float32Array; T: Uint32Array; offs: Uint32Array; list: Uint32Array; N: number[]; mn: number[]; mx: number[]; cell: number; nt: number }

// InstancedMesh (Props): jede Instanz mit eigener Matrix eintragen, sonst sickern Smoke/Feuer dort durch
function parts(meshes: Mesh[]): Part[] {
  const M = new Matrix4()
  return meshes.map(m => {
    const pos = m.geometry.attributes.position as BufferAttribute | InterleavedBufferAttribute, il = (pos as InterleavedBufferAttribute).isInterleavedBufferAttribute
    const im = (m as InstancedMesh).isInstancedMesh ? (m as InstancedMesh) : null, k = im ? im.count : 1, mats = new Float32Array(16 * k)
    for (let i = 0; i < k; i++) (im ? im.getMatrixAt(i, M).premultiply(m.matrixWorld) : M.copy(m.matrixWorld)).toArray(mats, i * 16)
    return {
      a: il ? (pos as InterleavedBufferAttribute).data.array : (pos as BufferAttribute).array, stride: il ? (pos as InterleavedBufferAttribute).data.stride : pos.itemSize,
      off: il ? (pos as InterleavedBufferAttribute).offset : 0, norm: pos.normalized, count: pos.count, idx: m.geometry.index?.array ?? null, mats,
    }
  })
}

/** Gitterbau (rein, ohne Imports): läuft im Worker per toString(), daher alles lokal */
function gridOf(ps: Part[], cell: number): Grid {
  // glTF-Quantisierung (KHR_mesh_quantization): normalisierte Ganzzahlen wie BufferAttribute.getX
  const den = (a: ArrayLike<number>) => a instanceof Int8Array ? (v: number) => Math.max(v / 127, -1) : a instanceof Uint8Array ? (v: number) => v / 255
    : a instanceof Int16Array ? (v: number) => Math.max(v / 32767, -1) : a instanceof Uint16Array ? (v: number) => v / 65535 : (v: number) => v
  let nv = 0, nt = 0
  for (const p of ps) { const k = p.mats.length / 16; nv += p.count * k; nt += ((p.idx ? p.idx.length : p.count) / 3) * k }
  const P = new Float32Array(nv * 3), T = new Uint32Array(nt * 3)
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  let v0 = 0, t = 0
  for (const p of ps) for (let inst = 0; inst < p.mats.length / 16; inst++) {
    const e = p.mats.subarray(inst * 16, inst * 16 + 16), d = p.norm ? den(p.a) : (v: number) => v
    for (let i = 0; i < p.count; i++) {
      const b = i * p.stride + p.off, x = d(p.a[b]), y = d(p.a[b + 1]), z = d(p.a[b + 2]), o = (v0 + i) * 3
      for (let r = 0; r < 3; r++) {
        const v = e[r] * x + e[4 + r] * y + e[8 + r] * z + e[12 + r]
        P[o + r] = v; if (v < mn[r]) mn[r] = v; if (v > mx[r]) mx[r] = v
      }
    }
    const n = p.idx ? p.idx.length : p.count
    for (let i = 0; i < n; i++) T[t++] = v0 + (p.idx ? p.idx[i] : i)
    v0 += p.count
  }
  const N = [0, 1, 2].map(r => Math.max(1, Math.ceil((mx[r] - mn[r]) / cell)))
  const [Nx, Ny, Nz] = N, inv = 1 / cell
  const offs = new Uint32Array(Nx * Ny * Nz + 1)
  let list = new Uint32Array(0), fill = offs
  // zwei Durchläufe: Zellen zählen, dann füllen (heiße Schleife ohne Allokationen)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < nt; i++) {
      const a = T[i * 3] * 3, b = T[i * 3 + 1] * 3, c = T[i * 3 + 2] * 3
      const x0 = Math.floor((Math.min(P[a], P[b], P[c]) - mn[0]) * inv), x1 = Math.min(Nx - 1, Math.floor((Math.max(P[a], P[b], P[c]) - mn[0]) * inv))
      const y0 = Math.floor((Math.min(P[a + 1], P[b + 1], P[c + 1]) - mn[1]) * inv), y1 = Math.min(Ny - 1, Math.floor((Math.max(P[a + 1], P[b + 1], P[c + 1]) - mn[1]) * inv))
      const z0 = Math.floor((Math.min(P[a + 2], P[b + 2], P[c + 2]) - mn[2]) * inv), z1 = Math.min(Nz - 1, Math.floor((Math.max(P[a + 2], P[b + 2], P[c + 2]) - mn[2]) * inv))
      for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0, k = (z * Ny + y) * Nx + x0; x <= x1; x++, k++) {
        if (pass === 0) offs[k + 1]++
        else list[fill[k]++] = i
      }
    }
    if (pass === 0) {
      for (let c = 1; c < offs.length; c++) offs[c] += offs[c - 1]
      list = new Uint32Array(offs[offs.length - 1]); fill = offs.slice(0, -1)
    }
  }
  return { P, T, offs, list, N, mn, mx, cell, nt }
}

export function buildRaycast(meshes: Mesh[], cell = 2): Raycast {
  return query(gridOf(parts(meshes), cell))
}

/**
 * Wie buildRaycast, Gitterbau aber in einem Worker (Dust2: 300 ms Hauptthread-Block → nur Kopieren der Positionen).
 * Die Engine wartet vor dem ersten Bild auf das Gitter (await rayP), danach trifft der Raycast immer.
 */
export function buildRaycastAsync(meshes: Mesh[], cell = 2): Promise<Raycast> {
  const src = `const gridOf = ${gridOf.toString()};
onmessage = e => { const g = gridOf(e.data.ps, e.data.cell); postMessage(g, [g.P.buffer, g.T.buffer, g.offs.buffer, g.list.buffer]) }`
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
  const w = new Worker(url)
  return new Promise<Raycast>((res, rej) => {
    w.onmessage = e => res(query(e.data as Grid))
    w.onerror = e => rej(new Error(`raycast worker: ${e.message}`))
    w.postMessage({ ps: parts(meshes), cell })
  }).finally(() => { w.terminate(); URL.revokeObjectURL(url) })
}

function query({ P, T, offs, list, N, mn, mx, cell, nt }: Grid): Raycast {
  const stamp = new Uint32Array(nt)
  let ray = 0

  // Möller–Trumbore, beidseitig; Abstand oder −1
  const hitTri = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tri: number) => {
    const a = T[tri * 3] * 3, b = T[tri * 3 + 1] * 3, c = T[tri * 3 + 2] * 3
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2]
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2]
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (det > -1e-12 && det < 1e-12) return -1
    const inv = 1 / det, sx = ox - P[a], sy = oy - P[a + 1], sz = oz - P[a + 2]
    const u = (sx * px + sy * py + sz * pz) * inv
    if (u < 0 || u > 1) return -1
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x
    const v = (dx * qx + dy * qy + dz * qz) * inv
    if (v < 0 || u + v > 1) return -1
    return (e2x * qx + e2y * qy + e2z * qz) * inv
  }

  return (origin, dir, far) => {
    const o = [origin.x, origin.y, origin.z], d = [dir.x, dir.y, dir.z]
    // Strahl auf das Gitter-AABB beschneiden
    let t0 = 0, t1 = far
    for (let r = 0; r < 3; r++) {
      if (Math.abs(d[r]) < 1e-12) { if (o[r] < mn[r] || o[r] > mx[r]) return Infinity; continue }
      let a = (mn[r] - o[r]) / d[r], b = (mx[r] - o[r]) / d[r]
      if (a > b) [a, b] = [b, a]
      t0 = Math.max(t0, a); t1 = Math.min(t1, b)
    }
    if (t0 > t1) return Infinity
    const ix = [0, 0, 0], step = [0, 0, 0], tMax = [0, 0, 0], tDelta = [0, 0, 0]
    for (let r = 0; r < 3; r++) {
      ix[r] = Math.min(N[r] - 1, Math.max(0, Math.floor((o[r] + d[r] * t0 - mn[r]) / cell)))
      if (d[r] > 0) { step[r] = 1; tMax[r] = (mn[r] + (ix[r] + 1) * cell - o[r]) / d[r]; tDelta[r] = cell / d[r] }
      else if (d[r] < 0) { step[r] = -1; tMax[r] = (mn[r] + ix[r] * cell - o[r]) / d[r]; tDelta[r] = -cell / d[r] }
      else { tMax[r] = Infinity; tDelta[r] = Infinity }
    }
    ray = (ray + 1) >>> 0 || 1
    let best = Infinity
    for (;;) {
      const c = (ix[2] * N[1] + ix[1]) * N[0] + ix[0]
      for (let i = offs[c]; i < offs[c + 1]; i++) {
        const tri = list[i]
        if (stamp[tri] === ray) continue
        stamp[tri] = ray
        const h = hitTri(o[0], o[1], o[2], d[0], d[1], d[2], tri)
        if (h >= 0 && h < best) best = h
      }
      const r = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2)
      if (best <= tMax[r] || tMax[r] > t1) break
      ix[r] += step[r]
      if (ix[r] < 0 || ix[r] >= N[r]) break
      tMax[r] += tDelta[r]
    }
    return best <= far ? best : Infinity
  }
}
