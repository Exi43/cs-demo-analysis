// Team-Sync, reine Logik ohne Netz/DOM: Server-Stand (Snapshot) + Warteschlange eigener Änderungen = angezeigter State (optimistisch).
// Abgelehnte Änderung (Rechte) fällt aus der Schlange → die Anzeige springt von selbst auf den Server-Stand zurück.
import type { Clip, Member, Note, Progress, Strat, Team, TeamState, Vote } from '../../../shared/team'
import type { Lineup } from '../../../shared/utility'
import { parseLibrary } from '../../../shared/utility-lib'

export type SMember = Member & { deleted?: boolean }
export type SClip = Clip & { lineupId: string; updatedAt: number; deleted?: boolean }

/** letzter bekannter Server-Stand */
export interface Snapshot {
  /** eigene Auth-User-ID (= Member.id) */
  me?: string
  team?: Team
  members: SMember[]
  strats: Strat[]
  votes: Vote[]
  progress: Progress[]
  notes: Note[]
  lineups: Lineup[]
  clips: Record<string, SClip>
  /** Ersteller je Team-Lineup (für „eigene ändern“) */
  lineupOwner: Record<string, string>
}

/** eigene Änderung, die noch zum Server muss (wird gespeichert, überlebt Neustart/Offline) */
export type Op =
  | { t: 'lineup'; v: Lineup }
  | { t: 'strat'; v: Strat }
  | { t: 'note'; v: Note }
  | { t: 'vote'; v: Vote }
  | { t: 'progress'; v: Progress }
  | { t: 'member'; v: SMember }
  | { t: 'team'; v: Team }

/** Antwort der RPC sync(since) (supabase/team.sql) */
export interface Delta {
  now: string
  team: Team | null
  invite?: string | null
  members?: SMember[]
  strats?: Strat[]
  votes?: Vote[]
  progress?: Progress[]
  notes?: Note[]
  lineups?: (Lineup & { createdBy?: string })[]
  clips?: SClip[]
}

export const emptySnapshot = (me?: string): Snapshot => ({ me, members: [], strats: [], votes: [], progress: [], notes: [], lineups: [], clips: {}, lineupOwner: {} })

const refKey = (p: Progress) => ('strat' in p.ref ? `s:${p.ref.strat}` : `l:${p.ref.lineup}`)
export function opKey(op: Op): string {
  switch (op.t) {
    case 'vote': return `vote:${op.v.stratId}:${op.v.memberId}`
    case 'progress': return `progress:${op.v.memberId}:${refKey(op.v)}`
    case 'team': return 'team'
    default: return `${op.t}:${op.v.id}`
  }
}

/** in die Schlange; eine noch nicht gesendete Änderung am selben Objekt wird ersetzt (nicht die gerade gesendete) */
export function enqueue(queue: Op[], op: Op, inflight?: Op): Op[] {
  const k = opKey(op), i = queue.findIndex(x => x !== inflight && opKey(x) === k)
  return i >= 0 ? queue.map((x, j) => (j === i ? op : x)) : [...queue, op]
}

const upsert = <T>(list: T[], v: T, same: (a: T) => boolean) => {
  const i = list.findIndex(same)
  return i >= 0 ? list.map((x, j) => (j === i ? v : x)) : [...list, v]
}

/** eine Änderung auf den Stand anwenden (optimistisch bzw. nach erfolgreichem Senden) */
export function apply(s: Snapshot, op: Op): Snapshot {
  switch (op.t) {
    case 'lineup': return { ...s, lineups: upsert(s.lineups, op.v, x => x.id === op.v.id), lineupOwner: s.lineupOwner[op.v.id] || !s.me ? s.lineupOwner : { ...s.lineupOwner, [op.v.id]: s.me } }
    case 'strat': return { ...s, strats: upsert(s.strats, op.v, x => x.id === op.v.id) }
    case 'note': return { ...s, notes: upsert(s.notes, op.v, x => x.id === op.v.id) }
    case 'vote': return { ...s, votes: upsert(s.votes, op.v, x => x.stratId === op.v.stratId && x.memberId === op.v.memberId) }
    case 'progress': return { ...s, progress: upsert(s.progress, op.v, x => x.memberId === op.v.memberId && refKey(x) === refKey(op.v)) }
    case 'member': return { ...s, members: upsert(s.members, op.v, x => x.id === op.v.id) }
    case 'team': return { ...s, team: { ...op.v, inviteCode: s.team?.inviteCode } }
  }
}

// ---------------------------------------------------------------- Server-Daten prüfen (kommen von anderen Mitgliedern)

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
/** Team-Lineup wie eine Import-Datei prüfen (unbekannte Felder fallen weg); lokale Videos gibt es im Team nicht */
export function cleanLineup(v: unknown): Lineup | undefined {
  try {
    const l = parseLibrary({ version: 1, lineups: [v], tags: [], playbooks: [] }).lineups[0]
    if (l.owner === 'local') return undefined
    if (l.video?.local) l.video = l.video.url ? { url: l.video.url } : undefined
    return l
  } catch { return undefined }
}
const cleanStrat = (v: Strat): Strat => ({ ...v, slots: arr<Strat['slots'][number]>(v.slots).map(x => ({ ...x, lineupIds: arr<string>(obj(x)?.lineupIds) })), board: arr(v.board), tags: arr(v.tags) })
const cleanNote = (v: Note): Note => ({ ...v, bookmarks: arr(v.bookmarks), text: typeof v.text === 'string' ? v.text : '' })

/** Änderungen vom Server einarbeiten (gleicher Schlüssel → Server-Version); team null = nicht (mehr) im Team → leer */
export function merge(s: Snapshot, d: Delta): Snapshot {
  if (!d.team) return emptySnapshot(s.me)
  const fresh = s.team?.id === d.team.id ? s : emptySnapshot(s.me)
  const by = <T>(list: T[], inc: T[] | undefined, key: (x: T) => string) => {
    if (!inc?.length) return list
    const m = new Map(list.map(x => [key(x), x]))
    for (const x of inc) m.set(key(x), x)
    return [...m.values()]
  }
  const owner = { ...fresh.lineupOwner }, lineups: Lineup[] = []
  for (const raw of d.lineups ?? []) {
    const l = cleanLineup(raw)
    if (!l) continue
    lineups.push(l)
    if (raw.createdBy) owner[l.id] = raw.createdBy
  }
  const clips = { ...fresh.clips }
  for (const c of d.clips ?? []) { if (c.deleted) delete clips[c.lineupId]; else clips[c.lineupId] = c }
  const members = by(fresh.members, d.members?.map(m => ({ ...m, roles: arr<string>(m.roles) })), m => m.id)
  const me = members.find(m => m.id === s.me) // nach dem Einarbeiten: wer gerade kein Admin mehr ist, sieht den Code nicht mehr
  return {
    ...fresh,
    // Einladungscode nur für Admins; kommt nur, wenn er sich geändert hat
    team: { ...d.team, mapPool: arr(d.team.mapPool), inviteCode: d.invite ?? (me?.perm === 'admin' ? fresh.team?.inviteCode : undefined) },
    members,
    strats: by(fresh.strats, d.strats?.map(cleanStrat), x => x.id),
    votes: by(fresh.votes, d.votes, x => `${x.stratId}:${x.memberId}`),
    progress: by(fresh.progress, d.progress, x => `${x.memberId}:${refKey(x)}`),
    notes: by(fresh.notes, d.notes?.map(cleanNote), x => x.id),
    lineups: by(fresh.lineups, lineups, x => x.id),
    clips,
    lineupOwner: owner,
  }
}

/** angezeigter State: Server-Stand + Schlange; gelöschte Mitglieder/Clips raus (gelöschte Strats/Notizen/Lineups behalten deleted) */
export function view(s: Snapshot, queue: Op[]): Omit<TeamState, 'online' | 'syncing' | 'error'> {
  const v = queue.reduce(apply, s)
  const members = v.members.filter(m => !m.deleted)
  const me = members.find(m => m.id === v.me)
  if (!me || !v.team) return { members: [], strats: [], votes: [], progress: [], notes: [], lineups: [], clips: {} }
  const clips: Record<string, Clip> = {}
  for (const [k, c] of Object.entries(v.clips)) clips[k] = { path: c.path, bytes: c.bytes, durationS: c.durationS }
  return { me, team: v.team, members, strats: v.strats, votes: v.votes, progress: v.progress, notes: v.notes, lineups: v.lineups, clips }
}

/** darf ich dieses Team-Lineup ändern/löschen? (gleiche Regel wie der Server) */
export const canEditLineup = (s: Snapshot, queue: Op[], id: string) => {
  const me = s.members.find(m => m.id === s.me && !m.deleted)
  if (!me) return false
  if (me.perm === 'admin') return true
  const owner = s.lineupOwner[id]
  return owner ? owner === me.id : queue.some(o => o.t === 'lineup' && o.v.id === id) // noch nicht gesendet = eigenes neues
}

// ---------------------------------------------------------------- Änderung → PostgREST-Anfrage

export interface Req { method: 'POST' | 'PATCH'; path: string; body: unknown }
/** Zeilen wie in supabase/team.sql; Ersteller/Autor setzt der Server (auth.uid()), updated_at auch */
export function toRequest(op: Op, teamId: string): Req {
  const up = (table: string, conflict: string, body: unknown): Req => ({ method: 'POST', path: `${table}?on_conflict=${conflict}`, body })
  switch (op.t) {
    case 'lineup': {
      const { id, owner: _o, updatedAt: _u, deleted, ...data } = op.v
      return up('lineups', 'id', { id, team_id: teamId, data, deleted: !!deleted })
    }
    case 'strat': {
      const { id, teamId: _t, author: _a, status, baseId, decidedBy: _d, createdAt: _c, updatedAt: _u, deleted, ...data } = op.v
      return up('strats', 'id', { id, team_id: teamId, status, base_id: baseId ?? null, data, deleted: !!deleted })
    }
    case 'note': {
      const { id, teamId: _t, author: _a, updatedAt: _u, deleted, ...data } = op.v
      return up('notes', 'id', { id, team_id: teamId, data, deleted: !!deleted })
    }
    case 'vote': return up('votes', 'strat_id,member_id', { strat_id: op.v.stratId, team_id: teamId, value: op.v.value, comment: op.v.comment ?? null })
    case 'progress': {
      const [ref_kind, ref_id] = 'strat' in op.v.ref ? ['strat', op.v.ref.strat] : ['lineup', op.v.ref.lineup]
      return up('progress', 'member_id,ref_kind,ref_id', { team_id: teamId, ref_kind, ref_id, status: op.v.status })
    }
    case 'member': {
      const m = op.v
      return { method: 'PATCH', path: `members?team_id=eq.${teamId}&user_id=eq.${m.id}`, body: { name: m.name, steamid: m.steamid ?? null, perm: m.perm, roles: m.roles, deleted: !!m.deleted } }
    }
    case 'team': return { method: 'PATCH', path: `teams?id=eq.${teamId}`, body: { name: op.v.name, map_pool: op.v.mapPool, focus: op.v.focus ?? null } }
  }
}
