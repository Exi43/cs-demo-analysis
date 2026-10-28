// Utility-Dashboard: Änderungen an der Bibliothek als reine Funktionen (neue Objekte, nie in place). Löschen ist weich (deleted).
import type { Lineup, Playbook, Tag, UtilityLibrary } from '../../shared/utility'
import { BUILTIN_TECHNIQUES } from '../../shared/utility-lib'

export const uid = () => crypto.randomUUID()
const now = () => Date.now()

/** leeres Lineup für „Add lineup“ (Vorgabe: Smoke, T, im Stehen mit Linksklick) */
export const newDraft = (map = '') => ({
  id: uid(), map, type: 'smoke' as const, side: 'T' as const, title: '', technique: ['stand', 'left'], steps: [], images: [], tags: [],
  owner: 'local' as const, createdAt: now(), updatedAt: now(),
})

export function saveLineup(lib: UtilityLibrary, l: Lineup): UtilityLibrary {
  const i = lib.lineups.findIndex(x => x.id === l.id), next = { ...l, updatedAt: now() }
  return { ...lib, lineups: i >= 0 ? lib.lineups.map(x => (x.id === l.id ? next : x)) : [...lib.lineups, next] }
}
export const patchLineup = (lib: UtilityLibrary, id: string, p: Partial<Lineup>): UtilityLibrary =>
  ({ ...lib, lineups: lib.lineups.map(x => (x.id === id ? { ...x, ...p, updatedAt: now() } : x)) })
export const deleteLineup = (lib: UtilityLibrary, id: string) => patchLineup(lib, id, { deleted: true })

/** Kopie direkt hinter dem Original, Titel mit „(copy)“ */
export function duplicateLineup(lib: UtilityLibrary, id: string): { lib: UtilityLibrary; id: string } {
  const src = lib.lineups.find(l => l.id === id)
  if (!src) return { lib, id }
  const copy: Lineup = { ...src, id: uid(), title: `${src.title} (copy)`, favorite: false, demo: src.demo, createdAt: now(), updatedAt: now() }
  const i = lib.lineups.indexOf(src)
  return { lib: { ...lib, lineups: [...lib.lineups.slice(0, i + 1), copy, ...lib.lineups.slice(i + 1)] }, id: copy.id }
}

/** eigene Reihenfolge = Reihenfolge in lib.lineups: id vor beforeId schieben (ohne beforeId ans Ende) */
export function moveLineup(lib: UtilityLibrary, id: string, beforeId?: string): UtilityLibrary {
  const l = lib.lineups.find(x => x.id === id)
  if (!l || id === beforeId) return lib
  const rest = lib.lineups.filter(x => x.id !== id), i = beforeId ? rest.findIndex(x => x.id === beforeId) : -1
  return { ...lib, lineups: i < 0 ? [...rest, l] : [...rest.slice(0, i), l, ...rest.slice(i)] }
}

export function saveTag(lib: UtilityLibrary, t: Omit<Tag, 'updatedAt'>): UtilityLibrary {
  const next = { ...t, updatedAt: now() }
  return { ...lib, tags: lib.tags.some(x => x.id === t.id) ? lib.tags.map(x => (x.id === t.id ? next : x)) : [...lib.tags, next] }
}
export const deleteTag = (lib: UtilityLibrary, id: string): UtilityLibrary =>
  ({ ...lib, tags: lib.tags.map(t => (t.id === id ? { ...t, deleted: true, updatedAt: now() } : t)) })

export function savePlaybook(lib: UtilityLibrary, p: Omit<Playbook, 'updatedAt'>): UtilityLibrary {
  const next = { ...p, updatedAt: now() }
  return { ...lib, playbooks: lib.playbooks.some(x => x.id === p.id) ? lib.playbooks.map(x => (x.id === p.id ? next : x)) : [...lib.playbooks, next] }
}
export const deletePlaybook = (lib: UtilityLibrary, id: string): UtilityLibrary =>
  ({ ...lib, playbooks: lib.playbooks.map(p => (p.id === id ? { ...p, deleted: true, updatedAt: now() } : p)) })
/** Lineup in Playbook: einfügen (am Ende), herausnehmen oder vor beforeId schieben */
export function playbookItems(lib: UtilityLibrary, pid: string, f: (ids: string[]) => string[]): UtilityLibrary {
  return { ...lib, playbooks: lib.playbooks.map(p => (p.id === pid ? { ...p, lineupIds: f(p.lineupIds), updatedAt: now() } : p)) }
}
export const moveId = (ids: string[], id: string, beforeId?: string) => {
  const rest = ids.filter(x => x !== id), i = beforeId ? rest.indexOf(beforeId) : -1
  return i < 0 ? [...rest, id] : [...rest.slice(0, i), id, ...rest.slice(i)]
}

export function addTechnique(lib: UtilityLibrary, label: string): { lib: UtilityLibrary; id: string } {
  const builtin = BUILTIN_TECHNIQUES.find(t => t.label.toLowerCase() === label.trim().toLowerCase()) // „w + jumpthrow“ = eingebaut
  if (builtin) return { lib, id: builtin.id }
  const id = `custom-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'technique'}`
  return lib.techniques.some(t => t.id === id) ? { lib, id } : { lib: { ...lib, techniques: [...lib.techniques, { id, label: label.trim().slice(0, 40) }] }, id }
}
