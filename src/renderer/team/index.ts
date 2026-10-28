// Team-Zugriff des Fensters: echte Daten über den Sync (store.ts, Supabase), im Selbsttest die lokale Test-Implementierung (mock.ts).
// Selbsttest-Hash: #team[/<seite>…];mock=admin|player|new (CSDA_VIEW=team/strats;mock=player), Routen in TeamView.tsx
import type { TeamApi } from '../../shared/team'
import { api } from '../api'
import { createMockTeam, type MockAs } from './mock'
import { createSupabaseTeam } from './store'

export const MOCK = /;mock=(admin|player|new)/.exec(location.hash)?.[1] as MockAs | undefined

function make(): TeamApi {
  if (!MOCK) return createSupabaseTeam()
  const t = createMockTeam(MOCK)
  // Testdaten: Mitglieder spielen in den importierten Demos mit (je Match der erste Spieler), damit die Win-Rate etwas zeigt
  api.listMatches().then(ms => {
    const s = t.state(), ids = ms.map(m => m.players[0]?.steamid).filter(Boolean)
    const at = (i: number) => (s.me && i === 0 ? s.me.id : s.members.filter(m => m.id !== s.me?.id)[i - 1]?.id)
    const members = s.members.map(m => { const i = ids.findIndex((_, k) => at(k) === m.id); return i >= 0 ? { ...m, steamid: ids[i] } : m })
    t.seed({ members, me: members.find(m => m.id === s.me?.id) })
  }, () => {})
  return t
}

export const team: TeamApi = make()
