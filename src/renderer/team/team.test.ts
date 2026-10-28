// Team-Seite: Rechte (Test-Implementierung wie Server), Abstimmung, Unterschiede eines Änderungsvorschlags, Lern-Status, Win-Rate
import { describe, expect, it } from 'vitest'
import type { Strat } from '../../shared/team'
import type { MatchSummary } from '../../shared/model'
import { diffStrat, inBook, learnSummary, tally, winRates } from './logic'
import { MOCK_CODE, createMockTeam } from './mock'

const proposal = (author: string, p: Partial<Strat> = {}): Strat => ({
  id: crypto.randomUUID(), teamId: 't1', map: 'de_ancient', side: 'T', kind: 'execute', title: 'New', slots: [], board: [], tags: [], status: 'proposed', author, createdAt: 1, updatedAt: 1, ...p,
})

describe('Rechte (mock)', () => {
  it('Spieler: nur Vorschläge, keine Freigabe, keine Rollen, kein Team bearbeiten', async () => {
    const t = createMockTeam('player'), me = t.state().me!
    await t.saveStrat(proposal(me.id))
    await expect(t.saveStrat(proposal(me.id, { status: 'approved' }))).rejects.toThrow(/suggest/)
    const s1 = t.state().strats.find(s => s.id === 's1')!
    await expect(t.saveStrat({ ...s1, title: 'Changed' })).rejects.toThrow()
    await t.saveStrat(proposal(me.id, { baseId: 's1', title: 'Changed' })) // Änderungsvorschlag geht
    await expect(t.decide('p1', true)).rejects.toThrow(/admins/)
    await expect(t.saveMember({ ...me, roles: ['awp'] })).rejects.toThrow(/admins/)
    await t.saveMember({ ...me, name: 'Neu' })
    expect(t.state().me!.name).toBe('Neu')
    await expect(t.saveTeam({ ...t.state().team!, focus: 'x' })).rejects.toThrow(/admins/)
    expect(t.state().team!.inviteCode).toBeUndefined()
    await expect(t.setProgress({ memberId: 'm1', ref: { strat: 's1' }, status: 'ready', updatedAt: 0 })).rejects.toThrow()
  })

  it('Admin: freigeben ersetzt das Original (ID bleibt), Ablehnen lässt es stehen', async () => {
    const t = createMockTeam('admin')
    await t.decide('p2', true)
    const s5 = t.state().strats.find(s => s.id === 's5')!
    expect(s5.slots[0].timing).toBe('until 0:40')
    expect(s5.status).toBe('approved')
    expect(t.state().strats.filter(s => inBook(s) && s.title === '2-1-2 standard')).toHaveLength(1)
    await t.decide('p1', false)
    expect(t.state().strats.find(s => s.id === 'p1')!.status).toBe('rejected')
    expect(t.state().strats.some(s => s.id === 'p1' && inBook(s))).toBe(false)
    await expect(t.decide('p1', true)).rejects.toThrow(/decided/)
  })

  it('Admin: der letzte Admin bleibt, eigene Entfernung nur über Verlassen', async () => {
    const t = createMockTeam('admin'), s = t.state()
    await t.saveMember({ ...s.members.find(m => m.id === 'm2')!, perm: 'player' })
    await expect(t.saveMember({ ...t.state().me!, perm: 'player' })).rejects.toThrow(/at least one admin/)
    await expect(t.removeMember('m1')).rejects.toThrow()
    await t.removeMember('m6')
    expect(t.state().members.some(m => m.id === 'm6')).toBe(false)
  })

  it('Beitreten nur mit gültigem Code, danach als Spieler', async () => {
    const t = createMockTeam('new')
    await expect(t.join('WRONG', 'Ali')).rejects.toThrow()
    await t.join(MOCK_CODE.toLowerCase(), 'Ali')
    expect(t.state().me).toMatchObject({ name: 'Ali', perm: 'player' })
    await t.leave()
    expect(t.state().team).toBeUndefined()
  })
})

describe('Abstimmung', () => {
  it('eine Stimme je Mitglied, änderbar, Kommentare neueste zuerst', async () => {
    const t = createMockTeam('admin')
    expect(tally(t.state().votes, 'p1', 'm1')).toMatchObject({ up: 2, down: 1, mine: 1 })
    await t.vote('p1', -1, '  ')
    const r = tally(t.state().votes, 'p1', 'm1')
    expect(r).toMatchObject({ up: 1, down: 2, mine: -1 })
    expect(r.comments.map(c => c.memberId)).toEqual(['m5'])
    await expect(t.vote('s1', 1)).rejects.toThrow(/closed/)
  })
})

describe('Unterschiede', () => {
  it('zeigt geänderte Felder und Slots kurz an', () => {
    const t = createMockTeam('admin').state(), base = t.strats.find(s => s.id === 's5')!, prop = t.strats.find(s => s.id === 'p2')!
    const d = diffStrat(base, prop, id => t.members.find(m => m.id === id)?.name ?? '–')
    expect(d).toEqual(['Player 1: task, timing whole round → until 0:40, start position', 'Board drawings changed'])
    expect(diffStrat(base, base)).toEqual([])
    expect(diffStrat(base, { ...base, title: 'X', slots: base.slots.slice(0, 2), side: 'T' })).toEqual(['Title: 2-1-2 standard → X', 'Side: CT → T', 'Player 3 removed'])
  })
})

describe('Lern-Status und Win-Rate', () => {
  it('zählt je Mitglied über Stratbook und Team-Lineups', () => {
    const s = createMockTeam('admin').state()
    const r = learnSummary(s, 'm1')
    expect(r.total).toBe(s.strats.filter(inBook).length + s.lineups.length)
    expect(r).toMatchObject({ ready: 4, unsure: 1 })
    expect(r.ready + r.unsure + r.learning + r.none).toBe(r.total)
  })
  it('Win-Rate aus Sicht des Teams des Mitglieds', () => {
    const m = (map: string, a: number, b: number, team = 'us'): MatchSummary => ({ id: map + a, fileName: '', map, parsedAt: '', teams: [team, 'them'], finalScore: { [team]: a, them: b }, rounds: a + b, players: [{ steamid: '7', name: 'x', team }] })
    expect(winRates([m('de_nuke', 13, 9), m('de_nuke', 5, 13), m('de_ancient', 13, 2, 'team_x'), m('de_inferno', 13, 0)], ['7'])).toEqual({
      de_nuke: { won: 1, played: 2 }, de_ancient: { won: 1, played: 1 }, de_inferno: { won: 1, played: 1 },
    })
    expect(winRates([m('de_nuke', 13, 9)], ['8'])).toEqual({})
  })
})
