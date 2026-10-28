import type { MatchData } from '../../shared/model'
import { winType, type WinType } from '../../shared/analysis/glance'
import { Icon } from '../icons'

const BUY_ICON: Record<string, string> = { pistol: 'P', eco: 'E', force: 'F', full: '' }
export const WIN: Record<WinType, [string, string]> = { elim: ['xhair', 'Elimination'], bomb: ['bolt', 'Bomb exploded'], defuse: ['check', 'Defused'], time: ['clock', 'Time ran out'] }

/** Rundenleiste: Farbe = Gewinner-Seite, Buchstabe = Buy-Typ des Gewinners. Mit us (Report): oben = unser Sieg, Symbol = Siegart */
export function RoundStrip({ match, current, onPick, selected, us }: {
  match: MatchData; current?: number; onPick: (i: number) => void; selected?: Set<number>; us?: string
}) {
  const teamA = us ?? match.teams[0]
  return (
    <div className="round-strip">
      {match.rounds.map((r, i) => {
        const winnerTeam = r.teamOnSide[r.winner]
        const halfStart = i > 0 && match.rounds[i - 1].teamOnSide.CT !== r.teamOnSide.CT
        const win = WIN[winType(r.reason)]
        return (
          <button key={r.num}
            className={`rs ${r.winner} ${winnerTeam === teamA ? 'top' : 'bottom'} ${current === i ? 'cur' : ''} ${selected?.has(i) ? 'sel' : ''} ${halfStart ? 'half' : ''}`}
            title={`Round ${r.num}: ${winnerTeam} (${r.winner}) · ${us ? win[1] : r.reason.replace(/_/g, ' ')}\nCT ${r.buy.CT} vs T ${r.buy.T}`}
            onClick={() => onPick(i)}>
            <span className="rs-num">{r.num}</span>
            {us ? <span className="rs-buy"><Icon name={win[0]} size={10} /></span> : <span className="rs-buy">{BUY_ICON[r.buy[r.winner === 'CT' ? 'T' : 'CT']]}</span>}
          </button>
        )
      })}
    </div>
  )
}
