// Team-Seite: reine Logik ohne React (Rechte, Abstimmung, Unterschiede eines Änderungsvorschlags, Lern-Status, Win-Rate aus Demos)
import { BUILTIN_ROLES, type Member, type Progress, type ProgressStatus, type Strat, type StratKind, type TeamState, type Vote } from '../../shared/team'
import type { MatchSummary } from '../../shared/model'

export const KINDS: { id: StratKind; label: string }[] = [
  { id: 'default', label: 'Default' }, { id: 'execute', label: 'Execute' }, { id: 'fake', label: 'Fake' }, { id: 'pistol', label: 'Pistol' },
  { id: 'antieco', label: 'Anti-eco' }, { id: 'retake', label: 'Retake' }, { id: 'setup', label: 'CT setup' }, { id: 'other', label: 'Other' },
]
export const kindLabel = (k: StratKind) => KINDS.find(x => x.id === k)?.label ?? k
export const roleLabel = (id: string) => BUILTIN_ROLES.find(r => r.id === id)?.label ?? id
/** Farbe je Slot (Taktik-Board, Startposition, Slot-Karte) */
export const SLOT_COLORS = ['#ffb21e', '#6fb3ff', '#7bcc6c', '#ff6b9d', '#b28cff']
export const PROGRESS: { id: ProgressStatus; label: string }[] = [{ id: 'learning', label: 'Learning' }, { id: 'unsure', label: 'Unsure' }, { id: 'ready', label: 'Ready' }]

export const isAdmin = (s: Pick<TeamState, 'me'>) => s.me?.perm === 'admin'
/** im Stratbook: freigegeben, kein offener/erledigter Änderungsvorschlag, nicht gelöscht */
export const inBook = (s: Strat) => s.status === 'approved' && !s.baseId && !s.deleted
export const isOpen = (s: Strat) => s.status === 'proposed' && !s.deleted

/** Darf `me` diese Strat so speichern? Spieler: nur Vorschläge (eigene oder neue), Admin: alles. Gleiche Regel wie der Server (RLS) */
export function canSaveStrat(me: Member | undefined, s: Strat, old?: Strat) {
  if (!me) return false
  if (me.perm === 'admin') return true
  return s.status === 'proposed' && s.author === me.id && (!old || (old.author === me.id && old.status === 'proposed'))
}
/** Spieler: nur eigener Name/SteamID (Rechte und Rollen bleiben); Admin: alle, aber nie der letzte Admin weg */
export function canSaveMember(me: Member | undefined, m: Member, old: Member | undefined, members: Member[]) {
  if (!me || !old) return false
  if (me.perm !== 'admin') return m.id === me.id && m.perm === old.perm && m.roles.join() === old.roles.join()
  return !(old.perm === 'admin' && m.perm !== 'admin' && members.filter(x => x.perm === 'admin').length <= 1)
}

/** Abstimmung: Daumen hoch/runter, meine Stimme, Kommentare (neueste zuerst) */
export function tally(votes: Vote[], stratId: string, meId?: string) {
  const v = votes.filter(x => x.stratId === stratId)
  return {
    up: v.filter(x => x.value === 1).length,
    down: v.filter(x => x.value === -1).length,
    mine: v.find(x => x.memberId === meId)?.value,
    comments: v.filter(x => x.comment?.trim()).sort((a, b) => b.updatedAt - a.updatedAt),
  }
}

/** kurze Liste der Unterschiede Vorschlag ↔ Original (eine Zeile je Änderung) */
export function diffStrat(base: Strat, next: Strat, nameOf: (memberId?: string) => string = id => id ?? '–'): string[] {
  const out: string[] = []
  const field = (label: string, a?: string, b?: string) => { if ((a ?? '') !== (b ?? '')) out.push(a && b ? `${label}: ${a} → ${b}` : b ? `${label} added` : `${label} removed`) }
  field('Title', base.title, next.title)
  field('Description', base.description, next.description)
  if (base.side !== next.side) out.push(`Side: ${base.side} → ${next.side}`)
  if (base.kind !== next.kind) out.push(`Type: ${kindLabel(base.kind)} → ${kindLabel(next.kind)}`)
  if ((base.notes ?? '') !== (next.notes ?? '')) out.push('Notes changed')
  if (base.tags.join() !== next.tags.join()) out.push(`Tags: ${next.tags.join(', ') || 'none'}`)
  for (let i = 0; i < Math.max(base.slots.length, next.slots.length); i++) {
    const a = base.slots[i], b = next.slots[i], n = `Player ${i + 1}`
    if (!a) { out.push(`${n} added (${roleLabel(b.role)})`); continue }
    if (!b) { out.push(`${n} removed`); continue }
    const ch: string[] = []
    if (a.role !== b.role) ch.push(`role ${roleLabel(a.role)} → ${roleLabel(b.role)}`)
    if (a.memberId !== b.memberId) ch.push(`player ${nameOf(a.memberId)} → ${nameOf(b.memberId)}`)
    if (a.task !== b.task) ch.push('task')
    if ((a.timing ?? '') !== (b.timing ?? '')) ch.push(`timing ${a.timing || '–'} → ${b.timing || '–'}`)
    if (a.lineupIds.join() !== b.lineupIds.join()) ch.push(`utility ${a.lineupIds.length} → ${b.lineupIds.length}`)
    if (Math.round(a.start?.x ?? 0) !== Math.round(b.start?.x ?? 0) || Math.round(a.start?.y ?? 0) !== Math.round(b.start?.y ?? 0)) ch.push('start position')
    if (ch.length) out.push(`${n}: ${ch.join(', ')}`)
  }
  if (JSON.stringify(base.board) !== JSON.stringify(next.board)) out.push(base.board.length === next.board.length ? 'Board drawings changed' : `Board: ${base.board.length} → ${next.board.length} drawings`)
  return out
}

/** Lern-Status eines Mitglieds zu einer Strat oder einem Lineup */
export const progressOf = (ps: Progress[], memberId: string | undefined, ref: { strat: string } | { lineup: string }) =>
  ps.find(p => p.memberId === memberId && ('strat' in ref ? 'strat' in p.ref && p.ref.strat === ref.strat : 'lineup' in p.ref && p.ref.lineup === ref.lineup))?.status

/** Übersicht je Mitglied: wie viele Strats/Lineups ready, unsure, learning, noch nicht angesehen */
export function learnSummary(s: Pick<TeamState, 'strats' | 'lineups' | 'progress'>, memberId: string) {
  const refs = [...s.strats.filter(inBook).map(x => ({ strat: x.id })), ...s.lineups.filter(l => !l.deleted).map(l => ({ lineup: l.id }))]
  const r = { ready: 0, unsure: 0, learning: 0, none: 0, total: refs.length }
  for (const ref of refs) r[progressOf(s.progress, memberId, ref) ?? 'none']++
  return r
}

/**
 * Win-Rate je Map aus den importierten Demos: zählt Matches, in denen ein Team-Mitglied (SteamID) mitspielt, aus Sicht seines Teams.
 * Ohne SteamIDs im Team bleibt die Liste leer.
 */
export function winRates(matches: MatchSummary[], steamids: string[]) {
  const ids = new Set(steamids.filter(Boolean)), out: Record<string, { won: number; played: number }> = {}
  for (const m of matches) {
    const team = m.players.find(p => ids.has(p.steamid))?.team
    if (!team || !(team in m.finalScore)) continue
    const other = m.teams.find(t => t !== team)
    const r = (out[m.map] ??= { won: 0, played: 0 })
    r.played++
    if (other != null && m.finalScore[team] > m.finalScore[other]) r.won++
  }
  return out
}

/** Bookmark-Zeit: demoKey = Match-ID (main/parse.ts demoId: sha1 über die entpackte Demo, auf allen PCs gleich, auch .dem.gz/.zst) */
export const matchForKey = (matches: MatchSummary[], demoKey: string) => matches.find(m => m.id === demoKey)

export const uid = () => crypto.randomUUID()
export const ago = (t: number, now = Date.now()) => {
  const d = Math.max(0, now - t) / 1000
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`
}
