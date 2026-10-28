import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      // three mitbündeln: electron-builder lässt node_modules/*/examples weg (EXRLoader fehlte im Installer, 3D-Bau stürzte ab)
      externalizeDeps: { exclude: ['three'] },
      rollupOptions: {
        // import() → require(): sharp lädt erst bei Bedarf (utility.ts), wie ein statisches Paket aus app.asar
        output: { dynamicImportInCjs: false },
        input: {
          index: resolve('src/main/index.ts'),
          parser: resolve('src/main/parser-process.ts'),
          assets3d: resolve('src/main/assets3d/worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } },
  },
})
