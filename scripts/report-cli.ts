// Test: node scripts/report-cli.ts <demo|MatchData.json> [weitere …] [team] → Anti-Strat als Markdown je Team
import { readFileSync } from 'node:fs'
import { parseDemo } from '../src/main/parse.ts'
import type { MatchData } from '../src/shared/model.ts'
import { buildAntiStrat } from '../src/shared/analysis/antistrat.ts'
import { toMarkdown } from '../src/shared/analysis/antistrat-text.ts'

const args = process.argv.slice(2)
const files = args.filter(a => /\.(dem|gz|zst|zip|json)$/i.test(a)), team = args.find(a => !files.includes(a))
// .json = schon geparste MatchData (Cache), spart 5–9 s pro Demo
const ms: MatchData[] = files.map(f => (/\.json$/i.test(f) ? JSON.parse(readFileSync(f, 'utf8')) : parseDemo(readFileSync(f), f)))
for (const t of team ? [team] : ms[0].teams) {
  const entries = ms.filter(m => m.teams.includes(t)).map(match => ({ match, team: t }))
  if (!entries.length) { console.error(`Team ${t} not in the demos (${ms.flatMap(m => m.teams).join(', ')})`); process.exitCode = 1; continue }
  const t0 = performance.now(), a = buildAntiStrat(entries)
  console.error(`buildAntiStrat ${t}: ${(performance.now() - t0).toFixed(0)} ms`)
  console.log(toMarkdown(a))
}
