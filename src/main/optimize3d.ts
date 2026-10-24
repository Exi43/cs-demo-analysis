// Exportierte CS2-Map (glTF von Source 2 Viewer) für den 3D-Viewer verkleinern.
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, flatten, instance, join, meshopt, prune, textureCompress, weld } from '@gltf-transform/functions'
import { MeshoptEncoder } from 'meshoptimizer'
import sharp from 'sharp'

export async function optimizeGltf(input: string, output: string, log: (msg: string) => void = () => {}) {
  await MeshoptEncoder.ready
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
  log('Reading export')
  const doc = await io.read(input)
  log('Merging geometry')
  await doc.transform(dedup(), instance({ min: 4 }), flatten(), join(), weld(), prune())
  log('Compressing textures')
  // Farbe darf schärfer bleiben, Normal-/ORM-Maps fallen auf 512 px
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /baseColor|emissive/, resize: [1024, 1024], quality: 82 }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /normal|occlusion|metallicRoughness/, resize: [512, 512], quality: 80 }),
  )
  log('Compressing meshes')
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }), prune())
  log('Writing file')
  await io.write(output, doc)
}
