import type { MatchData } from '../../shared/model'

const BUY_ICON: Record<string, string> = { pistol: 'P', eco: 'E', force: 'F', full: '' }

/** Rundenleiste: Farbe = Gewinner-Seite, Buchstabe = Buy-Typ des Gewinners */
export function RoundStrip({ match, current, onPick, selected }: {
  match: MatchData; current?: number; onPick: (i: number) => void; selected?: Set<number>
}) {
  const teamA = match.teams[0]
  return (
    <div className="round-strip">
      {match.rounds.map((r, i) => {
        const winnerTeam = r.teamOnSide[r.winner]
        const halfStart = i > 0 && match.rounds[i - 1].teamOnSide.CT !== r.teamOnSide.CT
        return (
          <button key={r.num}
            className={`rs ${r.winner} ${winnerTeam === teamA ? 'top' : 'bottom'} ${current === i ? 'cur' : ''} ${selected?.has(i) ? 'sel' : ''} ${halfStart ? 'half' : ''}`}
            title={`Round ${r.num}: ${winnerTeam} (${r.winner}) · ${r.reason.replace(/_/g, ' ')}\nCT ${r.buy.CT} vs T ${r.buy.T}`}
            onClick={() => onPick(i)}>
            <span className="rs-num">{r.num}</span>
            <span className="rs-buy">{BUY_ICON[r.buy[r.winner === 'CT' ? 'T' : 'CT']]}</span>
          </button>
        )
      })}
    </div>
  )
}
