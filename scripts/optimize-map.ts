// node scripts/optimize-map.ts <export.gltf> <out.glb>
import { statSync } from 'node:fs'
import { optimizeGltf } from '../src/main/optimize3d.ts'

const t0 = Date.now()
await optimizeGltf(process.argv[2], process.argv[3], m => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${m}`))
console.log(`fertig in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${(statSync(process.argv[3]).size / 1e6).toFixed(1)} MB`)
