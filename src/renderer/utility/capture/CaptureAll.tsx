// Startpaket-Bilder (scripts/starter-pack.ts images, Selbsttest #utility/capture): Datei aus CSDA_UTIL_IMPORT einlesen, für jedes Lineup mit
// Stand und Blick die zwei Bilder rendern (je Map ein Engine-Lauf), Bibliothek speichern (library.json, das Skript bettet die Bilder ein)
// und fertig melden: data-h3-ready beendet die Wartezeit von CSDA_READY, data-h3-stats steht in der „3d:“-Zeile des Selbsttests.
import { useEffect, useState } from 'react'
import type { Lineup } from '../../../shared/utility'
import { api } from '../../api'
import { openMap, type Shot } from './capture'

const ready = (l: Lineup): l is Lineup & Shot => !!l.aim && !l.deleted

async function run(say: (s: string) => void): Promise<string> {
  const r = await api.utilityImportOpen()
  if (!r) throw new Error('No file (CSDA_UTIL_IMPORT)')
  await api.utilityImportCommit()
  const lib = r.library, todo = lib.lineups.filter(ready), maps = [...new Set(todo.map(l => l.map))].sort(), t0 = performance.now(), failed: string[] = []
  let n = 0
  for (const map of maps) {
    const ls = todo.filter(l => l.map === map)
    try {
      const m = await openMap(map, ls[0], s => say(`${map}: ${s.msg} ${Math.round(s.pct)}%`))
      try {
        for (const l of ls) {
          say(`${map}: ${++n}/${todo.length} ${l.title}`)
          try { l.images = await m.shoot(l) } catch (e) { failed.push(`${l.title}: ${e instanceof Error ? e.message : e}`) }
        }
      } finally { m.dispose() }
    } catch (e) { failed.push(`${map}: ${e instanceof Error ? e.message : e}`) }
  }
  await api.utilitySave(lib)
  for (const f of failed) console.error(`capture failed: ${f}`)
  return `capture ${todo.length - failed.length}/${todo.length} lineups, ${maps.length} maps in ${((performance.now() - t0) / 1000).toFixed(0)} s${failed.length ? `, ${failed.length} failed` : ''}`
}

export function CaptureAll() {
  const [msg, setMsg] = useState('Starting…')
  const [done, setDone] = useState<string>()
  useEffect(() => { run(setMsg).then(setDone, e => setDone(`capture error: ${e instanceof Error ? e.message : e}`)) }, [])
  return (
    <div className="ut">
      <div className="ut-empty pad" {...(done ? { 'data-h3-ready': '', 'data-h3-stats': done } : {})}>{done ?? msg}</div>
    </div>
  )
}
