// Handgebautes AntiStrat aus methodik/beispiel-dust2.md (Spike proanalyse): Derdummbadss auf Dust2, user-demo.dem.
// Ziel-Ausgabe fuer Text-Export und UI, solange buildAntiStrat noch keine echten Daten liefert. Hit-Sekunden aus erkennung/proto-dust2.txt.
import type { Ref } from './rounds.ts'
import type { AntiStrat, IconToken, Line, Tag } from './types.ts'
import { tagOf } from './util.ts'

export const DUST2_MATCH = '4699fdaf49070d28'
// freezeEndTick R1–R21 aus erkennung/cache/dust2.json
const FREEZE = [5563, 9930, 14503, 19359, 26376, 34984, 42220, 49716, 61860, 73242, 80002, 88503, 97423, 105401, 110501, 118339, 128120, 135263, 141292, 147619, 152243]
const R = (...rounds: number[]): Ref[] => rounds.map(round => ({ matchId: DUST2_MATCH, round, tick: FREEZE[round - 1] }))
const L = (icon: IconToken | undefined, text: string, refs: Ref[] = [], tag?: Tag, extra?: Pick<Line, 'stat' | 'counter'>): Line => ({ icon, text, refs, tag, ...extra })
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

const ID = {
  tyrannus00: '76561198254277069', Derdummbadss: '76561198189827773', Kugel666: '76561199466380131', stakson: '76561197989308244', sk1nnex: '76561198854956010',
  DiiiDiii: '76561198317764598', C3M0: '76561198857175507', Criminal_Boy: '76561198331041994', Exi: '76561199217769102', SymboIe: '76561199378438903',
}

export const DUST2_FIXTURE: AntiStrat = {
  team: 'Derdummbadss', map: 'de_dust2', demos: 1, rounds: 21,
  results: [{ opponent: 'tyrannus00', us: 8, them: 13 }],
  sides: { CT: { won: 3, total: 12 }, T: { won: 5, total: 9 } },

  keys: [
    L('target', '**CT: no round won after losing the first duel**: 0/7. All 3 CT wins had a push that paid off (R4 tunnels early, R11 catwalk early, R7 late flank through long).',
      R(2, 3, 5, 8, 9, 10, 12), tagOf(7, 7), { stat: { won: 0, total: 7 }, counter: 'Hold their push spots, win the opening duel, trade it.' }),
    L('kit', '**Retakes 2/8.** Both wins: **DiiiDiii** last alive, kills + defuse (R4, R11).',
      R(2, 4, 5, 6, 8, 9, 10, 11), tagOf(6, 8), { stat: { won: 2, total: 8 }, counter: 'Plant, play post-plant, find DiiiDiii before the defuse.' }),
    L('awp', '**T: AWP on top mid → mid doors at 1:49** (R17 Kugel666 dead, R21 tyrannus00 dead). In R16 we smoked top mid at 1:50 and nobody died there. 4/4 AWP rounds on top mid.',
      R(16, 17, 18, 21), tagOf(2, 4), { stat: { won: 2, total: 4 }, counter: 'Never cross mid doors without a smoke or flash.' }),
  ],

  roster: [
    { steamid: ID.sk1nnex, name: 'sk1nnex', rating: 1.25, kills: 23, deaths: 16, adr: 102, t: 'flex, clutch (1v3 B, R13)', ct: 'short/catwalk, B', watch: L('arrow', 'catwalk push R11 = 3 kills', R(11)) },
    { steamid: ID.DiiiDiii, name: 'DiiiDiii', rating: 1.16, kills: 13, deaths: 14, adr: 78, t: ':awp: top mid [3/3 AWP rounds] · :c4: A (R15, R17)', ct: ':awp: long A · retaker', watch: L('kit', 'retake wins R4, R11', R(4, 11)) },
    { steamid: ID.stakson, name: 'stakson', rating: 0.84, kills: 14, deaths: 17, adr: 75, t: 'tunnels · :c4: B (R16, R21)', ct: 'B or short · upper tunnel util', watch: L('arrow', 'lower → mid doors (R20: 4 kills)', R(20)) },
    { steamid: ID.Derdummbadss, name: 'Derdummbadss', rating: 0.66, kills: 13, deaths: 19, adr: 88, t: 'mid [7/9]', ct: 'long/short · :awp: R5, R11', watch: L(undefined, 'most deaths (19)') },
    { steamid: ID.Criminal_Boy, name: 'Criminal_Boy', rating: 0.62, kills: 10, deaths: 16, adr: 57, t: 'support: most util (12 :flash: 10 :smoke:)', ct: 'mid doors [6/12], SSG on forces', watch: L(undefined, 'opening deaths at mid doors (R3, R5)', R(3, 5)) },
  ],

  t: {
    overview: [
      L('c4', 'Plants **A 3 · B 3**. A planter **DiiiDiii** [2/3], B planter **stakson** [2/3].', R(13, 14, 15, 16, 17, 21)),
      L('clock', 'First contact in mid (top mid, mid, mid doors, catwalk), between 1:49 and 1:25.', [], tagOf(7, 9)),
      L('clock', 'Hit 1:23–0:48, plant 1:16–0:30 (median ~0:52).', R(13, 14, 15, 16, 17, 21)),
      L('knife', 'No fixed lurker. One player goes **lower tunnel → mid doors**.', R(14, 19, 20), tagOf(3, 9)),
    ],
    heatmap: {
      buckets: ['1:30–1:15', '1:15–1:00', '1:00–0:45'],
      rows: [
        { play: 'T1 Xbox → short A', cells: [R(14), R(20), []] },
        { play: 'T2 Long A', cells: [R(17), R(15), []] },
        { play: 'T3 B', cells: [R(21), [], R(13, 16)] },
        { play: 'Lower → mid doors', cells: [[], [], R(19)] },
      ],
    },
    plays: [
      {
        id: 'T1', name: 'Xbox → short A', site: 'A', kinds: ['execute'], won: 2, total: 3, tag: tagOf(3, 9), refs: R(14, 18, 20), buys: ['second', 'full', 'light'], hitSecs: [31, 45],
        timeline: L('clock', 'Xbox :smoke: 1:52 → catwalk 1:40 → short 1:35 → hit 1:23 (R14) / 1:10 (R20) · :c4: 1:16 (R14)', R(14, 18, 20)),
        roles: [
          L(undefined, '**Criminal_Boy** :smoke: Xbox? from T spawn 1:52 (R14, R20) → mid → short. :c4: plants A (R14)', R(14, 20)),
          L(undefined, '**Derdummbadss** :smoke: Xbox? 1:52 (R18) · :he: mid 1:49 (R14) · :flash: catwalk 1:45 · :molly: short stairs 1:34 (R18)', R(14, 18)),
          L(undefined, '**stakson** :molly: mid 1:51 → catwalk → short (R14). Opening kill on catwalk 1:44 (R14)', R(14)),
          L(undefined, '**sk1nnex** :flash: mid 1:49 (R18) / 1:47 (R20) → catwalk/short. R20: second mid :smoke: 1:42', R(18, 20)),
          L(undefined, '**DiiiDiii** R14 :knife: lower → mid doors (MAC-10, kill 1:14) · R18 :awp: top mid → catwalk', R(14, 18)),
          L(undefined, 'Mid doors :smoke: comes after: 1:37 (R18 Criminal_Boy), 1:25 (R20 stakson, from lower)', R(18, 20)),
        ],
        read: L('target', 'Xbox smoke at 1:52 means short A is coming.', R(14, 18, 20), tagOf(3, 3)),
        care: L('warn', 'Lower tunnel → mid doors at the same time (R14, R20).', R(14, 20)),
        counter: L(undefined, ":molly:/:he: catwalk–short stairs at 1:40–1:35. AWP top mid/catwalk early. In R18 Exi's :awp: kill on top mid at 1:47 won us the round.", R(18)),
      },
      {
        id: 'T2', name: 'Long A take', site: 'A', kinds: ['execute'], won: 1, total: 2, tag: tagOf(2, 9), refs: R(15, 17), buys: ['full', 'full'], hitSecs: [52, 36],
        timeline: L('clock', ':flash: long doors 1:48–1:43 → long control → :smoke: ×2 1:27–1:13 → :molly: 1:18–1:08 → :c4: 1:11 (R17) / 0:53 (R15)', R(15, 17)),
        roles: [
          L(undefined, '**Criminal_Boy** :flash: long doors 1:48 / 1:44 → :smoke: long doors 1:41 (R15) or top-mid cross :smoke:? 1:41 (R17) → :molly: A site 1:08 (R15) / extended A 1:17 (R17)', R(15, 17)),
          L(undefined, '**DiiiDiii** R17 first :awp: mid doors 1:49, then long. :smoke: long → A cross? 1:23 (R17) / 1:13 (R15) → :molly: extended A 1:18 → :c4: A (both)', R(15, 17)),
          L(undefined, '**stakson** R17 :smoke: long → A cross? 1:27 → :molly: short stairs 1:13 from A ramp · R15 dies at long doors 1:45', R(15, 17)),
          L(undefined, '**Derdummbadss** R15 :molly: mid 1:51 → :flash: long 1:43 → :smoke: long A 1:16 → dies long 1:03', R(15)),
          L(undefined, '**sk1nnex** R15 dies at long doors 1:44 · R17 goes B with Derdummbadss (:flash: B 1:45, kills on B 1:34 and 1:28) → :knife: mid doors', R(15, 17)),
        ],
        counter: L(undefined, 'Our long doors :molly:/:he: at 1:47 plus tyrannus00 on long killed 2 in R15 (stakson, sk1nnex; one by the molly). Keep it. 4 flashes over long by 1:43 = 5-man long (R15, **ONCE**) → rotate 1 early to A, keep retake util for the 2 long smokes.', R(15)),
      },
      {
        id: 'T3', name: 'B (late, after mid)', site: 'B', kinds: ['default'], won: 2, total: 3, tag: tagOf(3, 9), refs: R(13, 16, 21), buys: ['pistol', 'full', 'full'], hitSecs: [64, 62, 38],
        timeline: L('clock', 'mid/long fights first → B hit 0:53–0:51 (R13, R16) or 1:17 (R21) → :c4: 0:40 · 0:30 · 0:50', R(13, 16, 21)),
        roles: [
          L(undefined, '**stakson** tunnels every time (R13 lower, R16 lower, R21 upper) → :c4: plants B (R16, R21)', R(13, 16, 21)),
          L(undefined, '**stakson** R16 :smoke: mid doors 1:04 from mid → then B. R21 :smoke: B window/hole? 1:36', R(16, 21)),
          L(undefined, '**Criminal_Boy** :smoke: B doors 1:07 (R16), 1:39 (R21) · :molly: B 1:44 (R21)', R(16, 21)),
          L(undefined, '**DiiiDiii** R16 :awp: top mid until ~1:25 → upper → :molly: B 0:55 → :smoke: B doors 0:49', R(16)),
          L(undefined, '**sk1nnex** R13 1v3 clutch on B with Glock (0:31–0:17) · R21 :awp: mid doors pick 1:49', R(13, 21)),
        ],
        counter: L(undefined, "Don't stack A after early mid kills. Their B comes at 0:53–0:50 [2/3]. Keep 1 :molly: for the plant behind the B doors smoke.", R(13, 16)),
      },
    ],
    reads: [
      L('target', '4 flashes over long by 1:43 means a 5-man long take.', R(15), tagOf(1, 9)),
      L('target', 'A lower tunnel player on a force round means a mid doors push.', R(14, 19, 20), tagOf(3, 3)),
    ],
    awp: [
      L('awp', '**DiiiDiii** holds top mid → mid doors from 1:49.', R(16, 17, 18), tagOf(3, 3)),
      L('awp', '**sk1nnex** mid doors pick at 1:49.', R(21), tagOf(1, 4)),
      L('target', 'AWP kills on the mid doors cross: R17 Kugel666, R21 tyrannus00. In R16 our top mid smoke at 1:50 stopped it.', R(16, 17, 21), tagOf(2, 4)),
    ],
    pistol: [{
      title: 'Pistol T · R13 :check:', refs: R(13),
      lines: [
        L(undefined, '**0 grenades bought.**', R(13)),
        L(undefined, "**Derdummbadss + Criminal_Boy** go mid → both die there (1:40, 1:28) to C3M0's USP. Same pair pushed mid on CT pistol (R1).", R(1, 13), tagOf(2, 2), { counter: 'USP on the mid pair works.' }),
        L(undefined, '**stakson** lower tunnel → catwalk (kill 1:09, dies 1:08)', R(13)),
        L(undefined, '**DiiiDiii** long → back through T spawn → upper. **sk1nnex** late tunnels → B hit 0:51 → :c4: 0:40 (sk1nnex) → clutch 1v3.', R(13), undefined, { counter: 'B anchor must stay alive until 0:50.' }),
      ],
    }],
    second: { title: '2nd round T · R14 :check:', refs: R(14), lines: [L(undefined, 'Galils vs our eco → **T1** Xbox → short A, :c4: 1:16.', R(14))] },
    force: [{
      title: 'Force T · 2/3', refs: R(14, 19, 20),
      lines: [
        L('deagle', 'After a lost round they force (R19, R20: Galil, SSG, Deagles).', R(19, 20)),
        L(undefined, 'R19: 4 lower tunnel → :smoke: mid doors 1:23 (sk1nnex) + :molly: short stairs 1:26 (Criminal_Boy) → fight at mid doors/CT. Exi: 4 kills (3 :awp:, 1 :he:).', R(19)),
        L(undefined, 'R20: stakson alone lower → mid doors 1:35 → :smoke: mid doors 1:25 → 4 kills.', R(20)),
        L('warn', 'Mid doors from lower tunnel on their force rounds.', R(14, 19, 20), tagOf(3, 3)),
      ],
    }],
  },

  ct: {
    overview: [
      L('target', 'Opening duel won 5/12 → round won 3/5. Opening lost → **0/7** :x:', R(2, 3, 5, 8, 9, 10, 12), tagOf(7, 7), { stat: { won: 0, total: 7 } }),
      L('arrow', 'At least one early push in **10/12** rounds.', R(1, 2, 3, 4, 5, 6, 7, 9, 11, 12), tagOf(10, 12), {
        counter: 'Flash or molly catwalk at 1:45 before walking out (they arrive 1:45–1:40). After their long doors HE at 1:47, expect a long doors peek. Check behind long doors late (R7 flank).',
      }),
    ],
    utilSignature: [
      { fromSec: 7, toSec: 10, nade: ['molly', 'smoke'], target: 'upper tunnel', throwers: ['B player'], tag: tagOf(8, 12), refs: R(1, 5, 7, 8, 9, 10, 11, 12) },
      { fromSec: 8, toSec: 9, nade: ['he', 'molly'], target: 'long doors', throwers: ['long player'], tag: tagOf(7, 12), refs: R(3, 5, 7, 8, 9, 10, 12) },
      { fromSec: 11, toSec: 29, nade: ['smoke'], target: 'long doors (after the HE)', throwers: ['long player'], tag: tagOf(4, 12), refs: R(3, 5, 7, 8) },
    ],
    setups: [L('layers', 'At 1:40 always **1–2 on B**, never 3. Rest on A/mid.', R(...range(1, 12)), tagOf(12, 12))],
    spots: [L(undefined, 'No fixed spots: the B player changes (stakson 4×, sk1nnex 3×, DiiiDiii 3×, Criminal_Boy 3×, Derdummbadss 2×). Read them from their utility instead.', R(...range(1, 12)), undefined, {
      counter: 'Stay out of upper tunnel and long doors until 1:45, then take control.',
    })],
    awp: [
      L('awp', 'AWP only on full buys.', R(5, 7, 8, 11, 12), tagOf(5, 5)),
      L('awp', 'Long A: R8 DiiiDiii, R11 Derdummbadss, R12 DiiiDiii.', R(8, 11, 12), tagOf(3, 5)),
      L('awp', 'Mid doors: R5 Derdummbadss (2 kills in mid), R7 DiiiDiii.', R(5, 7), tagOf(2, 5)),
    ],
    pushes: [
      { level: 'forward', place: 'catwalk / top mid', players: ['Derdummbadss', 'stakson', 'sk1nnex', 'Criminal_Boy'], refs: R(1, 3, 11, 12), kills: 3, deaths: 3 },
      { level: 'forward', place: 'long doors / pit', players: ['stakson', 'DiiiDiii', 'Criminal_Boy'], refs: R(2, 5, 6, 7, 9), kills: 2, deaths: 0 },
      { level: 'push', place: 'tunnels → T spawn', players: ['DiiiDiii', 'Criminal_Boy'], refs: R(4), kills: 1, deaths: 0 },
    ],
    rotations: [L('shuffle', 'R5: B rotation through hole, 3 died one by one (0:54, 0:48, 0:37).', R(5), tagOf(1, 12))],
    retakes: [
      L('kit', 'Retakes **2/8** (A 2/6, B 0/2). Retakers come one at a time: deaths 3–14 s apart (R8, R9, R10).', R(2, 4, 5, 6, 8, 9, 10, 11), undefined, { stat: { won: 2, total: 8 } }),
      L('kit', 'Wins R4 and R11 both by **DiiiDiii** (kill on A + defuse).', R(4, 11), tagOf(2, 2)),
    ],
    pistol: [{
      title: 'Pistol CT · R1 :x:', refs: R(1),
      lines: [
        L(undefined, '**Derdummbadss + Criminal_Boy** push top mid at 1:46 → outside long. Derdummbadss USP kill 1:45 (C3M0). Criminal_Boy dies at long doors 1:31.', R(1), undefined, {
          counter: 'Our long take won it (:flash: long doors 1:48, :smoke: long → A cross 1:42). Expect the top-mid push at 1:46.',
        }),
        L(undefined, '**stakson** :molly: upper tunnel 1:47 → B.', R(1)),
      ],
    }],
    second: {
      title: '2nd / 3rd round CT', refs: R(2, 3),
      lines: [
        L(undefined, 'R2 eco: Deagles + SSG. 2 on B die at 1:38 (HE + Galil). Criminal_Boy SSG mid doors: 2 kills.', R(2)),
        L(undefined, 'R3 light buy (3 M4, MP9, SSG): Derdummbadss + stakson push catwalk at 1:40 → both die (C3M0). sk1nnex MP9 on long: 3 kills.', R(3)),
      ],
    },
    forces: [{
      title: 'Deagle forces · 1/3', refs: R(4, 6, 10),
      lines: [
        L('deagle', 'After a lost round they buy Deagles, not a full save.', R(4, 6, 10), tagOf(3, 3)),
        L(undefined, 'R4: 2 Deagles on long A → trades at long doors (1:44–1:40). R10: DiiiDiii dies on long 1:45. Derdummbadss: 2 Deagle kills + 2 AK kills on A.', R(4, 10), undefined, {
          counter: "Don't dry-peek long against Deagles. Flash first.",
        }),
      ],
    }],
  },

  economy: [
    L(undefined, 'CT: no full save in 12 rounds. After losses: eco (R2), light rifle buy (R3, R9) or Deagles (R4, R6, R10). Full buys 2/5, everything else 1/7.', R(2, 3, 4, 6, 9, 10)),
    L(undefined, 'T: full buy 2/5 · light buy 0/1 · Deagle force 1/1 · 2nd round 1/1 · pistol 1/1', R(...range(13, 21))),
  ],
  worked: [
    L('c4', 'A plants 6, won 4 (R6 R8 R9 R10). B plants 2, won 2 (R2 R5).', R(2, 5, 6, 8, 9, 10)),
    L('kit', 'Lost plants (R4, R11) were both retaken by DiiiDiii.', R(4, 11)),
    L('target', 'Picks on the mid doors cross: Criminal_Boy at 1:40 (R3, Exi) and 1:51 (R5, SymboIe :awp:).', R(3, 5)),
    L(undefined, 'Long doors util at 1:47 on CT, then 2 kills at long doors (R15).', R(15)),
  ],
  gameplan: {
    ourT: [
      L(undefined, 'Pistol: 2 hold mid for the top-mid push at 1:46, 3 take long (won R1).', R(1)),
      L(undefined, 'Gun rounds: wait out long doors :he:/:molly: and upper tunnel :molly: (1:48–1:45), then take long or catwalk with a flash. Trade the pusher.'),
      L(undefined, ':awp: on the mid doors cross 1:51–1:40 (Criminal_Boy).', R(3, 5)),
      L(undefined, 'Hit A, plant, post-plant. Find DiiiDiii.', R(4, 11)),
      L(undefined, 'Their Deagle round after a loss: flash long, no dry peeks.', R(4, 6, 10)),
    ],
    ourCT: [
      L(undefined, '1:50: smoke top mid before anyone crosses mid doors.', R(16, 17, 21)),
      L(undefined, 'Xbox smoke at 1:52 → :molly: catwalk/short 1:40 → :awp: short.', R(14, 18, 20)),
      L(undefined, '3+ flashes over long by 1:43 → long take: long doors util at 1:47, rotate 1 early.', R(15)),
      L(undefined, 'No info by 1:00 → B anchor holds until 0:50 (stakson plants B).', R(13, 16)),
      L(undefined, 'Force round: watch lower tunnel → mid doors.', R(14, 19, 20)),
      L(undefined, 'Take the 1v1s: they trade only **6 %** of their deaths (5/82). We trade 25 % (18/73).'),
    ],
  },
  roundList: ([
    [1, 'CT', 'pistol', 'pistol', 'top-mid push ×2 · A1 M3 B1', undefined, false],
    [2, 'CT', 'second', 'second', 'A1 M2 B2 · SSG mid doors', 'B 1:26', false],
    [3, 'CT', 'light', 'full', 'catwalk push ×2', undefined, false],
    [4, 'CT', 'deagle', 'full', 'long Deagles · tunnel push', 'A 1:11', true],
    [5, 'CT', 'full', 'full', ':awp: mid doors · long doors push', 'B 0:43', false],
    [6, 'CT', 'deagle', 'full', '2 short · long doors push', 'A 0:34', false],
    [7, 'CT', 'full', 'full', ':awp: mid doors · long flank', undefined, true],
    [8, 'CT', 'full', 'deagle', ':awp: long', 'A 0:22', false],
    [9, 'CT', 'light', 'full', 'Pit all round · A4', 'A 0:31', false],
    [10, 'CT', 'deagle', 'full', '3 A side', 'A 0:57', false],
    [11, 'CT', 'full', 'full', ':awp: long · catwalk push ×2', 'A 0:25', true],
    [12, 'CT', 'full', 'light', ':awp: long · catwalk push', undefined, false],
    [13, 'T', 'pistol', 'pistol', '**T3** late B · mid pair dies', 'B 0:40', true],
    [14, 'T', 'second', 'second', '**T1** Xbox → short A', 'A 1:16', true],
    [15, 'T', 'full', 'light', '**T2** long A ×5', 'A 0:53', false],
    [16, 'T', 'full', 'full', '**T3** mid → late B', 'B 0:30', true],
    [17, 'T', 'full', 'eco', '**T2** long A + 2 B', 'A 1:11', true],
    [18, 'T', 'full', 'full', '**T1** Xbox → short (no hit)', undefined, false],
    [19, 'T', 'light', 'full', '4 lower → mid doors', undefined, false],
    [20, 'T', 'deagle', 'full', '**T1** + stakson lower → mid doors', undefined, true],
    [21, 'T', 'full', 'light', '**T3** 2 B early + :awp: mid', 'B 0:50', false],
  ] as const).map(([n, side, buyThem, buyUs, play, plant, won]) => ({ ref: R(n)[0], side, buyThem, buyUs, play, plant, won })),
  limits: [
    '**1 demo.** Every tag means "seen in this match", not a long-term habit. A FACEIT pug team changes plays more than a pro team.',
    "Positions are the demo's callout names (`last_place_name`). Grenade names with `?` come from the landing zone only.",
    '"Traded" = the killer died within 5 s (parser rule).',
    'Our tool calls R3 and R9 "force" (team value under $20 000). By weapons they are light rifle buys (3 M4 or 2 M4 + FAMAS). R4, R6 and R10 are Deagle forces.',
  ],
  names: Object.fromEntries(Object.entries(ID).map(([name, id]) => [id, name])),
}
