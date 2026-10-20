// Test: node scripts/report-cli.ts <demo> [team] → Report als Text
import { readFileSync } from 'node:fs'
import { parseDemo } from '../src/main/parse.ts'
import { analyzeTeam } from '../src/shared/analysis/report.ts'
const m = parseDemo(readFileSync(process.argv[2]), 'x')
for (const team of process.argv[3] ? [process.argv[3]] : m.teams) {
  const rep = analyzeTeam([{ match: m, team }])
  console.log(`\n######## ${team} ########`)
  for (const s of rep.sections) {
    console.log(`\n## ${s.title}`)
    for (const f of s.findings) console.log(`[${f.tone}] ${f.text}${f.refs.length ? `  {${f.refs.map(r => 'R' + r.round).join(',')}}` : ''}`)
  }
}
