// Team-Seite: lokale Test-Implementierung von TeamApi (Selbsttest per Hash ;mock=admin|player|new, Tests). Hält alles im Speicher,
// prüft die Rechte wie der Server (Spieler: nur Vorschläge, eigene Daten; Admin: alles) und bringt eigene Beispieldaten mit.
import type { Lineup, NadeType } from '../../shared/utility'
import type { BoardItem, Member, Note, Progress, Strat, StratSlot, Team, TeamApi, TeamState, Vote } from '../../shared/team'
import { canSaveMember, canSaveStrat } from './logic'

export type MockAs = 'admin' | 'player' | 'new'
export const MOCK_CODE = 'NIGHT-4821'

// Radar-Pixel → Welt (Werte aus resources/maps/map_data.json), damit die Beispiele auf dem Radar an der richtigen Stelle liegen
const META: Record<string, [number, number, number]> = { de_ancient: [-2953, 2164, 5], de_inferno: [-2087, 3870, 4.9], de_nuke: [-3453, 2887, 7], de_dust2: [-2476, 3239, 4.4] }
const w = (map: string, px: number, py: number) => { const [x, y, s] = META[map]; return { x: Math.round(px * s + x), y: Math.round(y - py * s) } }

function sample(as: 'admin' | 'player', now: number): TeamState {
  const H = 3600e3, D = 24 * H, T = 't1'
  const team: Team = {
    id: T, name: 'Night Shift', inviteCode: MOCK_CODE, updatedAt: now - 2 * D,
    focus: 'Ancient: take mid control every T round. Trade the entry within 2 seconds.',
    mapPool: [
      { map: 'de_ancient', status: 'main', note: 'Strongest map' }, { map: 'de_anubis', status: 'main' }, { map: 'de_cache', status: 'off' },
      { map: 'de_dust2', status: 'practice' }, { map: 'de_inferno', status: 'main' }, { map: 'de_mirage', status: 'permaban' }, { map: 'de_nuke', status: 'practice' },
    ],
  }
  const mem = (id: string, name: string, perm: Member['perm'], roles: string[], days: number): Member => ({ id, teamId: T, name, perm, roles, joinedAt: now - days * D, updatedAt: now - days * D })
  const members = [
    mem('m1', 'Kaan', 'admin', ['igl', 'support'], 60), mem('m2', 'Jonas', 'admin', ['igl2', 'awp'], 58), mem('m3', 'Deniz', 'player', ['entry'], 40),
    mem('m4', 'Luca', 'player', ['lurker', 'anchor'], 35), mem('m5', 'Mert', 'player', ['rotator', 'support'], 20), mem('m6', 'Tim', 'player', ['coach'], 9),
  ]
  const lu = (id: string, map: string, type: NadeType, side: Lineup['side'], title: string, stand: [number, number], target: [number, number], technique: string[], steps: string[], author: string, days: number, description?: string): Lineup => ({
    id, map, type, side, title, description, stand: w(map, ...stand), target: w(map, ...target), technique, steps, images: [], tags: [], owner: { team: T }, author, createdAt: now - days * D, updatedAt: now - days * D,
  })
  const lineups = [
    lu('l1', 'de_ancient', 'smoke', 'T', 'CT smoke for A', [228, 520], [300, 215], ['jumpthrow'], ['Stand in the corner of A main', 'Aim at the top of the pillar', 'Jumpthrow'], 'Kaan', 30, 'Cuts the CT rotation into A'),
    lu('l2', 'de_ancient', 'flash', 'T', 'A main pop flash', [200, 540], [255, 360], ['stand'], ['Aim above the door frame', 'Left click'], 'Deniz', 26, 'Entry flash, blinds the A site defender'),
    lu('l3', 'de_ancient', 'smoke', 'T', 'Top mid smoke', [490, 720], [490, 330], ['jumpthrow'], ['Stand on the stairs', 'Jumpthrow'], 'Jonas', 24, 'Blocks the AWP from CT'),
    lu('l4', 'de_ancient', 'molotov', 'T', 'A default molly', [220, 420], [310, 268], ['run'], ['Run forward and throw'], 'Mert', 18),
    lu('l5', 'de_ancient', 'smoke', 'T', 'B long smoke', [800, 690], [770, 470], ['stand'], ['Aim at the left antenna'], 'Luca', 12, 'Blocks the long angle from B site'),
    lu('l6', 'de_ancient', 'smoke', 'CT', 'Mid smoke for CT', [515, 260], [490, 560], ['jumpthrow'], ['Stand behind the box', 'Jumpthrow'], 'Jonas', 8),
    lu('l7', 'de_inferno', 'smoke', 'T', 'Coffins smoke', [480, 820], [495, 230], ['jumpthrow'], ['Stand in the corner', 'Jumpthrow'], 'Kaan', 14),
  ]
  const A = 'de_ancient', slot = (role: string, memberId: string | undefined, start: [number, number], lineupIds: string[], task: string, timing?: string, map = A): StratSlot =>
    ({ role, memberId, start: w(map, ...start), lineupIds, task, timing })
  const path = (slotI: number, kind: BoardItem['kind'], pts: [number, number][], label?: string, map = A): BoardItem => ({ kind, slot: slotI < 0 ? undefined : slotI, pts: pts.map(p => w(map, ...p)), label })
  const st = (id: string, p: Partial<Strat> & Pick<Strat, 'title' | 'side' | 'kind'>, days: number, author = 'm1'): Strat => ({
    id, teamId: T, map: A, slots: [], board: [], tags: [], status: 'approved', author, createdAt: now - days * D, updatedAt: now - days * D, ...p,
  })
  const strats: Strat[] = [
    st('s1', {
      title: 'Mid split A', side: 'T', kind: 'execute', description: 'Take mid, then hit A from main and donut at the same time', tags: ['gun round'],
      notes: 'Call it after we hold mid for 20 seconds. If the AWP is on mid, switch to the B fake.',
      slots: [
        slot('entry', 'm3', [470, 870], ['l2'], 'Entry A through main after the pop flash', '1:15'),
        slot('support', 'm1', [500, 880], ['l1', 'l2'], 'Smoke CT, then flash for Deniz', '1:20'),
        slot('awp', 'm2', [520, 860], ['l3'], 'Smoke top mid, hold mid, cut donut', '1:25'),
        slot('lurker', 'm4', [540, 875], [], 'Hold B ramp, rotate through cave at 1:00'),
        slot('rotator', 'm5', [490, 860], ['l4'], 'Molly default, plant for the team', 'after the entry'),
      ],
      board: [
        path(0, 'path', [[470, 870], [300, 720], [215, 590], [205, 470], [255, 340]]),
        path(2, 'arrow', [[520, 860], [495, 600], [470, 470]]),
        path(1, 'arrow', [[500, 880], [380, 640], [320, 470]]),
        path(-1, 'zone', [[270, 240], [350, 240], [350, 295], [270, 295]]),
        path(-1, 'text', [[312, 228]], 'Plant default'),
        path(3, 'pos', [[795, 650]]),
      ],
    }, 6),
    st('s2', {
      title: 'Default: mid control', side: 'T', kind: 'default', description: 'Spread out, take mid with two players, wait for info',
      slots: [slot('awp', 'm2', [500, 860], ['l3'], 'Smoke top mid'), slot('entry', 'm3', [470, 870], [], 'Push mid with the AWP'), slot('lurker', 'm4', [540, 875], [], 'B ramp, listen for rotations')],
      board: [path(0, 'arrow', [[500, 860], [490, 560]]), path(1, 'arrow', [[470, 870], [460, 560]]), path(2, 'pos', [[795, 650]])],
    }, 12),
    st('s3', { title: 'B fake, hit A', side: 'T', kind: 'fake', description: 'Show B with utility, then the whole team goes A', slots: [slot('lurker', 'm4', [540, 875], ['l5'], 'Smoke B long, make noise'), slot('entry', 'm3', [470, 870], ['l2'], 'Wait at A main')] }, 15, 'm2'),
    st('s4', { title: 'Pistol: B rush', side: 'T', kind: 'pistol', description: 'All five B, two flashes, plant for long', slots: [slot('entry', 'm3', [540, 875], [], 'First into site')] }, 20),
    st('s5', {
      title: '2-1-2 standard', side: 'CT', kind: 'setup', description: 'Two A, one mid, two B',
      slots: [
        slot('anchor', 'm4', [760, 420], [], 'Anchor B, fall back to CT on a hit', 'whole round'),
        slot('awp', 'm2', [515, 260], ['l6'], 'Smoke mid, hold the gap'),
        slot('support', 'm1', [300, 265], [], 'A site, help mid if it gets taken'),
      ],
      board: [path(0, 'pos', [[760, 420]]), path(1, 'pos', [[515, 300]]), path(2, 'pos', [[300, 265]]), path(-1, 'zone', [[440, 380], [540, 380], [540, 470], [440, 470]])],
    }, 10, 'm2'),
    st('s6', { title: 'B retake from CT', side: 'CT', kind: 'retake', description: 'Flash over the wall, swing together', slots: [slot('rotator', 'm5', [600, 300], [], 'Flash over the wall')] }, 4),
    st('s7', { map: 'de_inferno', title: 'Banana control', side: 'T', kind: 'default', description: 'Take banana with molly and smoke', slots: [slot('entry', 'm3', [480, 820], ['l7'], 'Take banana', undefined, 'de_inferno')] }, 16),
    st('s8', { map: 'de_nuke', title: 'Outside smokes, hit B ramp', side: 'T', kind: 'execute', slots: [] }, 25, 'm2'),
    // Vorschläge: neue Strat, Änderung an s5, erledigte
    st('p1', {
      title: 'A ramp fast with double flash', side: 'T', kind: 'execute', description: 'Fast A hit when they stack B', status: 'proposed',
      slots: [slot('entry', 'm3', [470, 870], ['l2'], 'Entry first, wide swing', '1:40'), slot('support', 'm5', [500, 880], ['l2', 'l4'], 'Second flash, then molly default', '1:38')],
      board: [path(0, 'path', [[470, 870], [300, 720], [215, 590], [255, 340]]), path(1, 'arrow', [[500, 880], [230, 520]])],
    }, 1, 'm3'),
    { ...st('p2', { title: '2-1-2 standard', side: 'CT', kind: 'setup', status: 'proposed', baseId: 's5', description: 'Two A, one mid, two B' }, 0.2, 'm4'),
      slots: [
        { role: 'anchor', memberId: 'm4', start: w(A, 790, 440), lineupIds: [], task: 'Anchor B from the back, fall back to CT on a hit', timing: 'until 0:40' },
        { role: 'awp', memberId: 'm2', start: w(A, 515, 260), lineupIds: ['l6'], task: 'Smoke mid, hold the gap' },
        { role: 'support', memberId: 'm1', start: w(A, 300, 265), lineupIds: [], task: 'A site, help mid if it gets taken' },
      ],
      board: [path(0, 'pos', [[790, 440]]), path(1, 'pos', [[515, 300]]), path(2, 'pos', [[300, 265]]), path(-1, 'zone', [[440, 380], [540, 380], [540, 470], [440, 470]])],
    },
    st('p3', { title: 'Triple stack A', side: 'CT', kind: 'setup', status: 'rejected', decidedBy: 'm1' }, 5, 'm5'),
  ]
  const vote = (stratId: string, memberId: string, value: 1 | -1, comment: string | undefined, h: number): Vote => ({ stratId, memberId, value, comment, updatedAt: now - h * H })
  const votes = [
    vote('p1', 'm1', 1, 'Good vs. B stacks. Try it in the next scrim.', 3), vote('p1', 'm4', 1, undefined, 5),
    vote('p1', 'm5', -1, 'Second flash comes too late from my spot.', 2), vote('p2', 'm2', 1, 'Back position is safer vs. the B rush.', 1),
  ]
  const pr = (memberId: string, ref: Progress['ref'], status: Progress['status']): Progress => ({ memberId, ref, status, updatedAt: now - D })
  const progress = [
    pr('m1', { strat: 's1' }, 'ready'), pr('m1', { strat: 's2' }, 'ready'), pr('m1', { strat: 's5' }, 'ready'), pr('m1', { lineup: 'l1' }, 'ready'), pr('m1', { strat: 's3' }, 'unsure'),
    pr('m3', { strat: 's1' }, 'unsure'), pr('m3', { lineup: 'l2' }, 'ready'), pr('m3', { strat: 's4' }, 'ready'), pr('m3', { strat: 's2' }, 'learning'),
    pr('m2', { strat: 's1' }, 'ready'), pr('m2', { lineup: 'l3' }, 'ready'), pr('m2', { lineup: 'l6' }, 'ready'), pr('m4', { strat: 's5' }, 'learning'), pr('m5', { lineup: 'l4' }, 'unsure'),
  ]
  // Lesezeichen auf die Test-Matches im Profil (demoKey = Match-ID): Ancient (FACEIT) und Dust2
  const bm = (demoKey: string, demoName: string, round: number, tick: number, label: string) => ({ demoKey, demoName, round, tick, label })
  const notes: Note[] = [
    { id: 'n1', teamId: T, kind: 'scrim', title: 'Scrim vs. Orbit', date: now - 2 * D, map: 'de_ancient', opponent: 'Orbit', result: '13:9', author: 'm1', updatedAt: now - 2 * D,
      text: 'Mid control worked every round. We lost three rounds to the same B rush: anchor needs help faster.\n\nNext: practice the 2-1-2 with the new anchor position.',
      bookmarks: [bm('6089f0895f607036', 'Ancient FACEIT', 3, 0, 'Mid split A, clean'), bm('6089f0895f607036', 'Ancient FACEIT', 7, 0, 'B rush, anchor alone'), bm('6089f0895f607036', 'Ancient FACEIT', 12, 0, 'Late rotation')] },
    { id: 'n2', teamId: T, kind: 'review', title: 'Pistol rounds to review', date: now - 4 * D, map: 'de_dust2', author: 'm2', updatedAt: now - 4 * D,
      text: 'Watch both pistols before Thursday.', bookmarks: [bm('4699fdaf49070d28', 'user-demo.dem', 1, 0, 'First pistol'), bm('4699fdaf49070d28', 'user-demo.dem', 13, 0, 'Second pistol'), bm('0000000000000000', 'Scrim from Monday', 4, 0, 'Not on this PC')] },
    { id: 'n3', teamId: T, kind: 'match', title: 'League match week 3', date: now - 9 * D, map: 'de_inferno', opponent: 'Red Fox', result: '10:13', text: 'Banana control was too slow.', bookmarks: [], author: 'm1', updatedAt: now - 9 * D },
  ]
  const me = members.find(m => m.id === (as === 'admin' ? 'm1' : 'm3'))!
  return { me, team: me.perm === 'admin' ? team : { ...team, inviteCode: undefined }, members, strats, votes, progress, notes, lineups, clips: {}, online: true, syncing: false }
}

const empty = (): TeamState => ({ members: [], strats: [], votes: [], progress: [], notes: [], lineups: [], clips: {}, online: true, syncing: false })
const code = () => `TEAM-${Math.floor(1000 + Math.random() * 9000)}`

/** seed = Testdaten nachträglich ändern (z. B. SteamIDs aus den lokalen Demos für die Win-Rate) */
export function createMockTeam(as: MockAs = 'admin', now = Date.now()): TeamApi & { seed(n: Partial<TeamState>): void } {
  let s: TeamState = as === 'new' ? empty() : sample(as, now)
  const subs = new Set<(s: TeamState) => void>()
  const reset = (n: TeamState) => { s = n; subs.forEach(f => f(s)) }
  const set = (n: Partial<TeamState>) => reset({ ...s, ...n })
  const me = () => { if (!s.me || !s.team) throw new Error('You are not in a team'); return s.me }
  const admin = (what: string) => { if (me().perm !== 'admin') throw new Error(`Only admins can ${what}`); return s.me! }
  const upsert = <T extends { id: string }>(list: T[], x: T) => (list.some(y => y.id === x.id) ? list.map(y => (y.id === x.id ? x : y)) : [...list, x])

  return {
    state: () => s,
    subscribe: cb => { subs.add(cb); return () => { subs.delete(cb) } },
    async create(teamName, myName) {
      if (s.me) throw new Error('Leave your team first')
      if (!teamName.trim() || !myName.trim()) throw new Error('Enter a team name and your name')
      const t: Team = { id: crypto.randomUUID(), name: teamName.trim(), inviteCode: code(), mapPool: [], updatedAt: Date.now() }
      const m: Member = { id: crypto.randomUUID(), teamId: t.id, name: myName.trim(), perm: 'admin', roles: [], joinedAt: Date.now(), updatedAt: Date.now() }
      reset({ ...empty(), team: t, me: m, members: [m] })
    },
    async join(inviteCode, myName) {
      if (s.me) throw new Error('Leave your team first')
      if (inviteCode.trim().toUpperCase() !== MOCK_CODE) throw new Error('No team with this invite code')
      const base = sample('player', now), m: Member = { id: crypto.randomUUID(), teamId: base.team!.id, name: myName.trim() || 'Player', perm: 'player', roles: [], joinedAt: Date.now(), updatedAt: Date.now() }
      reset({ ...base, me: m, members: [...base.members, m] })
    },
    async leave() { me(); reset(empty()) },
    async saveTeam(t) { admin('edit the team'); set({ team: { ...t, updatedAt: Date.now() } }) },
    async newInviteCode() { admin('create invite codes'); const c = code(); set({ team: { ...s.team!, inviteCode: c } }); return c },
    async saveMember(m) {
      const old = s.members.find(x => x.id === m.id)
      if (!canSaveMember(me(), m, old, s.members)) throw new Error(s.me!.perm === 'admin' ? 'The team needs at least one admin' : 'Only admins can change roles and rights')
      const n = { ...m, updatedAt: Date.now() }
      set({ members: upsert(s.members, n), me: n.id === s.me!.id ? n : s.me })
    },
    async removeMember(id) { if (admin('remove players').id === id) throw new Error('Use “Leave team” to remove yourself'); set({ members: s.members.filter(m => m.id !== id) }) },
    async saveStrat(x) {
      if (x.slots.length > 5) throw new Error('A strat has at most 5 players')
      if (!canSaveStrat(me(), x, s.strats.find(y => y.id === x.id))) throw new Error('Players can only suggest strats. An admin approves them.')
      set({ strats: upsert(s.strats, { ...x, updatedAt: Date.now() }) })
    },
    async decide(id, yes) {
      const a = admin('approve proposals'), p = s.strats.find(x => x.id === id)
      if (!p || p.status !== 'proposed') throw new Error('This proposal is already decided')
      const t = Date.now(), done = { ...p, status: yes ? 'approved' : 'rejected', decidedBy: a.id, updatedAt: t } as Strat
      let strats = upsert(s.strats, done)
      const base = p.baseId && strats.find(x => x.id === p.baseId)
      // Änderungsvorschlag: Inhalt ersetzt das Original, die Original-ID bleibt (Links, Lern-Status)
      if (yes && base) strats = upsert(strats, { ...p, id: base.id, baseId: undefined, status: 'approved', author: base.author, createdAt: base.createdAt, decidedBy: base.decidedBy, updatedAt: t })
      set({ strats })
    },
    async vote(stratId, value, comment) {
      const m = me()
      if (!s.strats.some(x => x.id === stratId && x.status === 'proposed')) throw new Error('Voting is closed for this proposal')
      const v: Vote = { stratId, memberId: m.id, value, comment: comment?.trim() || undefined, updatedAt: Date.now() }
      set({ votes: [...s.votes.filter(x => !(x.stratId === stratId && x.memberId === m.id)), v] })
    },
    async setProgress(p) {
      if (p.memberId !== me().id) throw new Error('You can only set your own learning status')
      const same = (q: Progress) => q.memberId === p.memberId && JSON.stringify(q.ref) === JSON.stringify(p.ref)
      set({ progress: [...s.progress.filter(q => !same(q)), { ...p, updatedAt: Date.now() }] })
    },
    async saveNote(n) {
      const m = me(), old = s.notes.find(x => x.id === n.id)
      if (old && old.author !== m.id && m.perm !== 'admin') throw new Error('Only the author or an admin can change this note')
      set({ notes: upsert(s.notes, { ...n, updatedAt: Date.now() }) })
    },
    async saveLineup(l) {
      const m = me(), old = s.lineups.find(x => x.id === l.id)
      if (old && old.author !== m.name && m.perm !== 'admin') throw new Error('Only the author or an admin can change this lineup')
      set({ lineups: upsert(s.lineups, { ...l, owner: { team: s.team!.id }, updatedAt: Date.now() }) })
    },
    async shareLineups(ls) {
      const m = me(), t = Date.now()
      set({ lineups: [...s.lineups, ...ls.map(l => ({ ...l, id: crypto.randomUUID(), owner: { team: s.team!.id }, author: l.author ?? m.name, video: l.video?.url ? { url: l.video.url } : undefined, favorite: undefined, createdAt: t, updatedAt: t }))] })
    },
    uploadClip: async () => { throw new Error('Clips are not part of the test data') },
    clipUrl: async () => { throw new Error('Clips are not part of the test data') },
    storage: async () => ({ bytes: 0, limit: 1e9 }),
    seed: set,
  }
}
