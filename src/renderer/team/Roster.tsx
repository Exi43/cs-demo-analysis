// Roster: Mitglieder mit Rollen (Mehrfachauswahl) und Admin-Schalter (nur Admins), Einladungscode, eigenes Profil (Name, SteamID),
// Lern-Übersicht je Spieler (nur Admins), Team verlassen
import { useState } from 'react'
import { BUILTIN_ROLES, type Member } from '../../shared/team'
import { Icon } from '../icons'
import { team } from '.'
import { isAdmin, learnSummary } from './logic'
import { AdminBadge, Avatar, Section, TI, useTeam } from './tui'

export function Roster() {
  const { s, matches, run, notify } = useTeam()
  const admin = isAdmin(s), me = s.me!
  const [name, setName] = useState(me.name), [steam, setSteam] = useState(me.steamid ?? '')
  const players = [...new Map(matches.flatMap(m => m.players).map(p => [p.steamid, p])).values()].sort((a, b) => a.name.localeCompare(b.name))
  const members = [...s.members].sort((a, b) => (a.perm === b.perm ? a.joinedAt - b.joinedAt : a.perm === 'admin' ? -1 : 1))
  const save = (m: Member, ok?: string) => run(team.saveMember(m), ok)

  return (
    <div className="tm-page tm-roster">
      <div className="tm-page-head"><h1>Roster</h1><p className="muted">{s.members.length} member{s.members.length === 1 ? '' : 's'}. Roles are fixed per player. Admins approve proposals and manage roles.</p></div>
      <div className="tm-roster-top">
        <div className="tm-card tm-invite">
          <span className="tm-onboard-ico"><TI name="key" size={22} /></span>
          {admin && s.team?.inviteCode ? <>
            <div><span className="muted small">Invite code</span><b className="tm-code-big">{s.team.inviteCode}</b></div>
            <button className="ut-btn" onClick={() => navigator.clipboard.writeText(s.team!.inviteCode!).then(() => notify('Invite code copied'), () => notify('Could not copy', true))}><TI name="copy" size={15} /> Copy</button>
            <button className="ut-btn ghost" onClick={() => confirm('Create a new code? The old one stops working.') && run(team.newInviteCode(), 'New invite code created')}><Icon name="again" size={15} /> New code</button>
          </> : <div><b>Invite a player</b><p className="muted small">Ask an admin for the invite code.</p></div>}
        </div>
        <form className="tm-card tm-profile" onSubmit={e => { e.preventDefault(); save({ ...me, name: name.trim() || me.name, steamid: steam.trim() || undefined }, 'Profile saved') }}>
          <label className="tm-field"><span>Your name</span><input className="ut-input" value={name} onChange={e => setName(e.target.value)} maxLength={24} /></label>
          <label className="tm-field"><span>Your SteamID (for win rates from your demos)</span>
            <input className="ut-input" list="tm-players" value={steam} onChange={e => setSteam(e.target.value.replace(/\D/g, ''))} placeholder="7656119…" maxLength={17} /></label>
          <datalist id="tm-players">{players.map(p => <option key={p.steamid} value={p.steamid}>{p.name}</option>)}</datalist>
          <button className="ut-btn primary" disabled={name.trim() === me.name && steam === (me.steamid ?? '')}>Save</button>
        </form>
      </div>

      <div className="tm-members">
        {members.map(m => (
          <article key={m.id} className={`tm-member ${m.id === me.id ? 'me' : ''}`}>
            <div className="tm-member-head">
              <Avatar m={m} size={44} />
              <div><b>{m.name}{m.id === me.id && <span className="muted"> (you)</span>}</b>{m.perm === 'admin' ? <AdminBadge /> : <span className="muted small">Player</span>}</div>
              {admin && (
                <label className="tm-switch" title="Admins approve proposals and manage roles">
                  <input type="checkbox" checked={m.perm === 'admin'} onChange={e => save({ ...m, perm: e.target.checked ? 'admin' : 'player' }, e.target.checked ? `${m.name} is now an admin` : `${m.name} is now a player`)} />
                  <i />Admin
                </label>
              )}
            </div>
            <div className="ut-chips tm-roles">
              {(admin ? BUILTIN_ROLES : BUILTIN_ROLES.filter(r => m.roles.includes(r.id))).map(r => (
                <button key={r.id} className={`ut-chip ${m.roles.includes(r.id) ? 'on' : ''}`} disabled={!admin}
                  onClick={() => save({ ...m, roles: m.roles.includes(r.id) ? m.roles.filter(x => x !== r.id) : [...m.roles, r.id] })}>{r.label}</button>
              ))}
              {!admin && !m.roles.length && <span className="muted small">No role yet</span>}
            </div>
            {admin && m.id !== me.id && <button className="ut-link danger small" onClick={() => confirm(`Remove ${m.name} from the team?`) && run(team.removeMember(m.id), `${m.name} removed`)}>Remove from team</button>}
          </article>
        ))}
      </div>

      {admin && (
        <Section icon="book" title="Learning status per player">
          <div className="tm-learnmap">
            {members.map(m => {
              const r = learnSummary(s, m.id), pct = (n: number) => `${(n / Math.max(1, r.total)) * 100}%`
              return (
                <div key={m.id} className="tm-learnrow">
                  <span className="tm-learnrow-who"><Avatar m={m} size={24} />{m.name}</span>
                  <span className="tm-bar" title={`${r.ready} ready, ${r.unsure} unsure, ${r.learning} learning, ${r.none} not started`}>
                    <i className="ready" style={{ width: pct(r.ready) }} /><i className="unsure" style={{ width: pct(r.unsure) }} /><i className="learning" style={{ width: pct(r.learning) }} />
                  </span>
                  <span className="tm-learnrow-n"><b>{r.ready}</b>/{r.total} ready</span>
                  <span className="muted small">{r.unsure} unsure, {r.learning} learning</span>
                </div>
              )
            })}
          </div>
        </Section>
      )}

      <button className="ut-btn ghost danger tm-leave" onClick={() => confirm(`Leave ${s.team?.name}?`) && run(team.leave(), 'You left the team')}><TI name="leave" size={15} /> Leave team</button>
    </div>
  )
}
