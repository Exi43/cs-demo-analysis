// „From demo“-Liste (MapPage.tsx): die IPC api.utilityThrows baut der 3D-Vorschau-Zweig, hier nur die Darstellung der Vorschläge
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ThrowCandidate } from '../../shared/utility'
import { emptyLibrary } from '../../shared/utility-lib'

;(globalThis as { window?: unknown }).window = { api: {} } // renderer/api.ts liest window.api beim Laden
const { FromDemo } = await import('./MapPage')
const { UtilCtx } = await import('./ui')

const C = (title: string, round: number, similar: number, map = 'de_dust2'): ThrowCandidate => ({
  matchId: 'm1', tick: round * 1000, steamid: `s${round}`, player: `P${round}`, round, map, type: 'smoke', side: 'CT', similar,
  lineup: { map, type: 'smoke', side: 'CT', title, stand: { x: 0, y: 0 }, target: { x: 9, y: 9 }, technique: ['stand'], steps: [], images: [], tags: [] },
})

describe('FromDemo', () => {
  it('zeigt die Würfe der Map, häufige zuerst, bereits übernommene als „Added“', () => {
    const lib = { ...emptyLibrary(), lineups: [{ ...C('Old', 3, 1).lineup, id: 'x', owner: 'local' as const, createdAt: 1, updatedAt: 1, demo: { matchId: 'm1', tick: 3000, steamid: 's3' } }] }
    const ctx = { lib, update() {}, maps: { meta: {}, radars: [] }, go() {}, route: { page: 'home' as const }, notify() {}, preview() {}, openExport() {},
      team: { store: { canEdit: () => false } as never, state: { members: [], strats: [], votes: [], progress: [], notes: [], lineups: [], clips: {}, online: true, syncing: false } }, share() {} }
    const html = renderToStaticMarkup(
      <UtilCtx.Provider value={ctx}><FromDemo map="de_dust2" list={[C('Rare', 1, 1), C('Common', 2, 5), C('Old', 3, 1), C('Other map', 4, 9, 'de_nuke')]} onClose={() => {}} /></UtilCtx.Provider>,
    )
    const titles = [...html.matchAll(/<b title="([^"]+)"/g)].map(m => m[1])
    expect(titles).toEqual(['Common', 'Rare', 'Old'])
    expect(html).toContain('5×')
    expect(html.match(/>Add</g)).toHaveLength(2)
    expect(html).toContain('Added')
  })
})
