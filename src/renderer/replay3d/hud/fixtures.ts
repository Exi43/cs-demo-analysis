// Vorschau-Fixtures des Übertragungs-HUDs: Runde 15 der user-demo (Dust2) wie Entwurf v2 (spike/ui/assets-mockup/data-v2.js).
// ERZEUGT von ../Daten/downloads/spike/ui/_tools/mkfixtures.mjs, nicht von Hand ändern. Regeln wie hud/state.ts (Bombe 41 s,
// X VS Y ab dem ersten Tod, Slots CT 1–5 / T 6–10). Avatare null: die Vorschau setzt sie über api.avatars (sonst Initialen).
// Komponenten zeigen sich in der Vorschau (#hudpreview/<name>) über  export function preview(fx: HudFixture): ReactNode.
import type { Side } from '../../../shared/model'
import type { HudView, TimelineEvent } from './types'

export type FixtureName = 'start' | 'schaden' | 'normal' | 'defuse' | 'menu'
export interface HudFixture {
  name: FixtureName
  /** englische Kurzbeschreibung */
  label: string
  view: HudView
  /** Fokus-Spieler (Panel, Demo-Leiste, eigener Kill im Killfeed) */
  focus: string
  /** Demo-Leiste: alle Runden des Matches (Abschnitte) */
  rounds: { num: number; startTick: number; endTick: number; winner: Side }[]
  /** Ereignisse über das ganze Match aus Sicht von focus (= timeline(match, d, focus)) */
  timeline: TimelineEvent[]
  tickrate: number
  /** Zahnrad-Menü offen (Entwurf: v2-wasd-menu.png, mockup-normal-menu.png) */
  menu: boolean
  /** Tasten-Anzeige an (Option showKeys, Standard aus) */
  keys: boolean
}

/** Callback für preview(fx): schreibt Aufrufe ins Konsolen-Log, z. B. onPick={log('onPick')} */
export const log = (name: string) => (...args: unknown[]) => console.log('[hudpreview]', name, ...args)

const ROUNDS: HudFixture['rounds'] = [
  {"num":1,"startTick":3867,"endTick":8202,"winner":"T"},
  {"num":2,"startTick":8650,"endTick":12775,"winner":"T"},
  {"num":3,"startTick":13223,"endTick":17631,"winner":"T"},
  {"num":4,"startTick":18079,"endTick":24648,"winner":"CT"},
  {"num":5,"startTick":25096,"endTick":31336,"winner":"T"},
  {"num":6,"startTick":31784,"endTick":40492,"winner":"T"},
  {"num":7,"startTick":40940,"endTick":47988,"winner":"CT"},
  {"num":8,"startTick":48436,"endTick":57530,"winner":"T"},
  {"num":9,"startTick":57978,"endTick":68335,"winner":"T"},
  {"num":10,"startTick":68783,"endTick":78274,"winner":"T"},
  {"num":11,"startTick":78722,"endTick":86775,"winner":"CT"},
  {"num":12,"startTick":87223,"endTick":95183,"winner":"T"},
  {"num":13,"startTick":95727,"endTick":103673,"winner":"T"},
  {"num":14,"startTick":104121,"endTick":108773,"winner":"T"},
  {"num":15,"startTick":109221,"endTick":116611,"winner":"CT"},
  {"num":16,"startTick":117059,"endTick":126392,"winner":"T"},
  {"num":17,"startTick":126840,"endTick":133535,"winner":"T"},
  {"num":18,"startTick":133983,"endTick":139564,"winner":"CT"},
  {"num":19,"startTick":140012,"endTick":145891,"winner":"CT"},
  {"num":20,"startTick":146339,"endTick":150515,"winner":"T"},
  {"num":21,"startTick":150963,"endTick":157832,"winner":"CT"},
]

const TIMELINE: TimelineEvent[] = [
  {"tick":7523,"round":1,"kind":"kill","text":"Exi killed DiiiDiii (Glock)"},
  {"tick":11741,"round":2,"kind":"plant","text":"Bomb planted at B by Exi"},
  {"tick":15453,"round":3,"kind":"kill","text":"Exi killed Criminal_Boy (AK-47)"},
  {"tick":16339,"round":3,"kind":"death","text":"Exi killed by sk1nnex (MP9)"},
  {"tick":20018,"round":4,"kind":"death","text":"Exi killed by Derdummbadss (Deagle)"},
  {"tick":22135,"round":4,"kind":"plant","text":"Bomb planted at A by Kugel666"},
  {"tick":24648,"round":4,"kind":"defuse","text":"Bomb defused by DiiiDiii"},
  {"tick":28398,"round":5,"kind":"death","text":"Exi killed by Derdummbadss (AWP)"},
  {"tick":30925,"round":5,"kind":"plant","text":"Bomb planted at B by tyrannus00"},
  {"tick":38767,"round":6,"kind":"kill","text":"Exi killed stakson (AK-47)"},
  {"tick":38852,"round":6,"kind":"kill","text":"Exi killed DiiiDiii (AK-47)"},
  {"tick":40167,"round":6,"kind":"plant","text":"Bomb planted at A by Exi"},
  {"tick":47424,"round":7,"kind":"death","text":"Exi killed by Criminal_Boy (M4A1-S)"},
  {"tick":54932,"round":8,"kind":"kill","text":"Exi killed DiiiDiii (AK-47)"},
  {"tick":55615,"round":8,"kind":"plant","text":"Bomb planted at A by Kugel666"},
  {"tick":56650,"round":8,"kind":"kill","text":"Exi killed Criminal_Boy (AWP)"},
  {"tick":56994,"round":8,"kind":"death","text":"Exi killed by sk1nnex (AK-47)"},
  {"tick":66400,"round":9,"kind":"kill","text":"Exi killed DiiiDiii (AK-47)"},
  {"tick":67239,"round":9,"kind":"plant","text":"Bomb planted at A by C3M0"},
  {"tick":68335,"round":9,"kind":"kill","text":"Exi killed stakson (AK-47)"},
  {"tick":74584,"round":10,"kind":"death","text":"Exi killed by Derdummbadss (Deagle)"},
  {"tick":76908,"round":10,"kind":"plant","text":"Bomb planted at A by C3M0"},
  {"tick":82468,"round":11,"kind":"kill","text":"Exi killed Criminal_Boy (AK-47)"},
  {"tick":85761,"round":11,"kind":"plant","text":"Bomb planted at A by Exi"},
  {"tick":86010,"round":11,"kind":"death","text":"Exi killed by DiiiDiii (M4A1-S)"},
  {"tick":86775,"round":11,"kind":"defuse","text":"Bomb defused by DiiiDiii"},
  {"tick":90993,"round":12,"kind":"death","text":"Exi killed by Criminal_Boy (M4A1-S)"},
  {"tick":101385,"round":13,"kind":"death","text":"Exi killed by DiiiDiii (Glock)"},
  {"tick":102225,"round":13,"kind":"plant","text":"Bomb planted at B by sk1nnex"},
  {"tick":106053,"round":14,"kind":"death","text":"Exi killed by stakson (Galil)"},
  {"tick":107899,"round":14,"kind":"plant","text":"Bomb planted at A by Criminal_Boy"},
  {"tick":113779,"round":15,"kind":"kill","text":"Exi killed Derdummbadss (M4A1-S)"},
  {"tick":114438,"round":15,"kind":"plant","text":"Bomb planted at A by DiiiDiii"},
  {"tick":115138,"round":15,"kind":"kill","text":"Exi killed DiiiDiii (USP-S)"},
  {"tick":115893,"round":15,"kind":"kill","text":"Exi killed Criminal_Boy (M4A1-S)"},
  {"tick":116611,"round":15,"kind":"defuse","text":"Bomb defused by Exi"},
  {"tick":119593,"round":16,"kind":"death","text":"Exi killed by stakson (AK-47)"},
  {"tick":119614,"round":16,"kind":"kill","text":"Exi killed Derdummbadss (HE)"},
  {"tick":123768,"round":16,"kind":"plant","text":"Bomb planted at B by stakson"},
  {"tick":126392,"round":16,"kind":"explode","text":"Bomb exploded"},
  {"tick":129815,"round":17,"kind":"death","text":"Exi killed by sk1nnex (AK-47)"},
  {"tick":130911,"round":17,"kind":"plant","text":"Bomb planted at A by DiiiDiii"},
  {"tick":133535,"round":17,"kind":"explode","text":"Bomb exploded"},
  {"tick":135778,"round":18,"kind":"kill","text":"Exi killed sk1nnex (AWP)"},
  {"tick":137765,"round":18,"kind":"kill","text":"Exi killed Criminal_Boy (AWP)"},
  {"tick":144713,"round":19,"kind":"kill","text":"Exi killed Derdummbadss (AWP)"},
  {"tick":144900,"round":19,"kind":"kill","text":"Exi killed Criminal_Boy (AWP)"},
  {"tick":145461,"round":19,"kind":"kill","text":"Exi killed stakson (HE)"},
  {"tick":145891,"round":19,"kind":"kill","text":"Exi killed DiiiDiii (AWP)"},
  {"tick":149874,"round":20,"kind":"death","text":"Exi killed by stakson (M4A4)"},
  {"tick":156373,"round":21,"kind":"plant","text":"Bomb planted at B by stakson"},
  {"tick":157832,"round":21,"kind":"defuse","text":"Bomb defused by C3M0"},
  {"tick":157948,"round":21,"kind":"death","text":"Exi died"},
]

const START: HudView = {
  tick: 110693,
  round: 15,
  score: {"CT":9,"T":5},
  teams: {"CT":{"name":"tyrannus00","captain":{"name":"tyrannus00","steamid":"76561198254277069","avatar":null}},"T":{"name":"Derdummbadss","captain":{"name":"Derdummbadss","steamid":"76561198189827773","avatar":null}}},
  phase: "live",
  clock: 112,
  bomb: {"planted":false,"left":0,"total":0},
  players: [
    {"slot":1,"steamid":"76561198254277069","name":"tyrannus00","side":"CT","alive":true,"hp":100,"armor":100,"helmet":true,"kit":true,"money":50,"kills":10,"deaths":10,"roundKills":0,"weapon":"Butterfly Knife","primary":"FAMAS","utility":["Incendiary Grenade"],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":2,"steamid":"76561199466380131","name":"Kugel666","side":"CT","alive":true,"hp":100,"armor":100,"helmet":true,"kit":false,"money":50,"kills":15,"deaths":11,"roundKills":0,"weapon":"knife","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":3,"steamid":"76561198857175507","name":"C3M0","side":"CT","alive":true,"hp":100,"armor":100,"helmet":true,"kit":false,"money":0,"kills":10,"deaths":13,"roundKills":0,"weapon":"M9 Bayonet","primary":"M4A1-S","utility":["Flashbang"],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":4,"steamid":"76561199217769102","name":"Exi","side":"CT","alive":true,"hp":100,"armor":100,"helmet":true,"kit":false,"money":50,"kills":9,"deaths":10,"roundKills":0,"weapon":"Talon Knife","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":5,"steamid":"76561199378438903","name":"SymboIe","side":"CT","alive":true,"hp":100,"armor":100,"helmet":true,"kit":false,"money":1600,"kills":15,"deaths":9,"roundKills":0,"weapon":"Butterfly Knife","primary":"MP9","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":6,"steamid":"76561198189827773","name":"Derdummbadss","side":"T","alive":true,"hp":100,"armor":100,"helmet":true,"kit":false,"money":1850,"kills":11,"deaths":13,"roundKills":0,"weapon":"Molotov","primary":"Galil AR","utility":["Smoke Grenade","High Explosive Grenade","Molotov","Flashbang"],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":7,"steamid":"76561197989308244","name":"stakson","side":"T","alive":true,"hp":100,"armor":100,"helmet":true,"kit":false,"money":3150,"kills":8,"deaths":13,"roundKills":0,"weapon":"knife_t","primary":"Galil AR","utility":["Smoke Grenade","Flashbang","Molotov","High Explosive Grenade"],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":8,"steamid":"76561198854956010","name":"sk1nnex","side":"T","alive":true,"hp":100,"armor":100,"helmet":true,"kit":false,"money":3100,"kills":17,"deaths":11,"roundKills":0,"weapon":"Flashbang","primary":"AK-47","utility":["Smoke Grenade","Flashbang","Flashbang","Molotov"],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":9,"steamid":"76561198317764598","name":"DiiiDiii","side":"T","alive":true,"hp":100,"armor":100,"helmet":true,"kit":false,"money":4300,"kills":9,"deaths":10,"roundKills":0,"weapon":"Molotov","primary":"MAC-10","utility":["Smoke Grenade","High Explosive Grenade","Molotov","Flashbang"],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":10,"steamid":"76561198331041994","name":"Criminal_Boy","side":"T","alive":true,"hp":100,"armor":100,"helmet":true,"kit":false,"money":2350,"kills":8,"deaths":12,"roundKills":0,"weapon":"knife_t","primary":"Galil AR","utility":["High Explosive Grenade","Molotov","Smoke Grenade","Flashbang"],"bomb":true,"speaking":false,"flash":0,"avatar":null},
  ],
  panel: {"steamid":"76561199217769102","hp":100,"hpLost":0,"mag":null,"reserve":null,"weapon":"Talon Knife","buy":true,"money":50,"voice":false},
  killfeed: [],
  focus: {"steamid":"76561199217769102","keys":["MOVERIGHT"],"scoped":false,"fov":90,"flash":0},
}

const SCHADEN: HudView = {
  tick: 114629,
  round: 15,
  score: {"CT":9,"T":5},
  teams: {"CT":{"name":"tyrannus00","captain":{"name":"tyrannus00","steamid":"76561198254277069","avatar":null}},"T":{"name":"Derdummbadss","captain":{"name":"Derdummbadss","steamid":"76561198189827773","avatar":null}}},
  phase: "planted",
  clock: 38,
  bomb: {"planted":true,"site":"A","left":38,"total":41},
  vs: {"ct":3,"t":2},
  players: [
    {"slot":1,"steamid":"76561198254277069","name":"tyrannus00","side":"CT","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":650,"kills":12,"deaths":11,"roundKills":2,"weapon":"","primary":"FAMAS","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":2,"steamid":"76561199466380131","name":"Kugel666","side":"CT","alive":true,"hp":100,"armor":100,"helmet":true,"kit":false,"money":50,"kills":15,"deaths":11,"roundKills":0,"weapon":"M4A1-S","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":3,"steamid":"76561198857175507","name":"C3M0","side":"CT","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":0,"kills":10,"deaths":14,"roundKills":0,"weapon":"","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":4,"steamid":"76561199217769102","name":"Exi","side":"CT","alive":true,"hp":66,"armor":95,"helmet":true,"kit":false,"money":350,"kills":10,"deaths":10,"roundKills":1,"weapon":"USP-S","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":5,"steamid":"76561199378438903","name":"SymboIe","side":"CT","alive":true,"hp":100,"armor":100,"helmet":true,"kit":false,"money":1600,"kills":15,"deaths":9,"roundKills":0,"weapon":"MP9","primary":"MP9","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":6,"steamid":"76561198189827773","name":"Derdummbadss","side":"T","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":2150,"kills":12,"deaths":14,"roundKills":1,"weapon":"","primary":"AK-47","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":7,"steamid":"76561197989308244","name":"stakson","side":"T","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":3150,"kills":8,"deaths":14,"roundKills":0,"weapon":"","primary":"Galil AR","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":8,"steamid":"76561198854956010","name":"sk1nnex","side":"T","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":3400,"kills":18,"deaths":12,"roundKills":1,"weapon":"","primary":"AK-47","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":9,"steamid":"76561198317764598","name":"DiiiDiii","side":"T","alive":true,"hp":28,"armor":80,"helmet":true,"kit":false,"money":4600,"kills":9,"deaths":10,"roundKills":0,"weapon":"AK-47","primary":"AK-47","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":10,"steamid":"76561198331041994","name":"Criminal_Boy","side":"T","alive":true,"hp":62,"armor":88,"helmet":true,"kit":false,"money":2350,"kills":8,"deaths":12,"roundKills":0,"weapon":"Galil AR","primary":"Galil AR","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
  ],
  panel: {"steamid":"76561199217769102","hp":66,"hpLost":34,"mag":11,"reserve":null,"weapon":"USP-S","buy":false,"money":350,"voice":false},
  killfeed: [],
  focus: {"steamid":"76561199217769102","keys":["MOVERIGHT","ATTACK"],"scoped":false,"fov":90,"flash":0},
}

const NORMAL: HudView = {
  tick: 115135,
  round: 15,
  score: {"CT":9,"T":5},
  teams: {"CT":{"name":"tyrannus00","captain":{"name":"tyrannus00","steamid":"76561198254277069","avatar":null}},"T":{"name":"Derdummbadss","captain":{"name":"Derdummbadss","steamid":"76561198189827773","avatar":null}}},
  phase: "planted",
  clock: 30.1,
  bomb: {"planted":true,"site":"A","left":30.1,"total":41},
  vs: {"ct":1,"t":2},
  players: [
    {"slot":1,"steamid":"76561198254277069","name":"tyrannus00","side":"CT","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":650,"kills":12,"deaths":11,"roundKills":2,"weapon":"","primary":"FAMAS","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":2,"steamid":"76561199466380131","name":"Kugel666","side":"CT","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":50,"kills":15,"deaths":12,"roundKills":0,"weapon":"","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":3,"steamid":"76561198857175507","name":"C3M0","side":"CT","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":0,"kills":10,"deaths":14,"roundKills":0,"weapon":"","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":4,"steamid":"76561199217769102","name":"Exi","side":"CT","alive":true,"hp":38,"armor":91,"helmet":true,"kit":false,"money":350,"kills":10,"deaths":10,"roundKills":1,"weapon":"USP-S","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":5,"steamid":"76561199378438903","name":"SymboIe","side":"CT","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":1600,"kills":15,"deaths":10,"roundKills":0,"weapon":"","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":6,"steamid":"76561198189827773","name":"Derdummbadss","side":"T","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":2150,"kills":12,"deaths":14,"roundKills":1,"weapon":"","primary":"AK-47","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":7,"steamid":"76561197989308244","name":"stakson","side":"T","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":3150,"kills":8,"deaths":14,"roundKills":0,"weapon":"","primary":"Galil AR","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":8,"steamid":"76561198854956010","name":"sk1nnex","side":"T","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":3400,"kills":18,"deaths":12,"roundKills":1,"weapon":"","primary":"AK-47","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":9,"steamid":"76561198317764598","name":"DiiiDiii","side":"T","alive":true,"hp":11,"armor":72,"helmet":true,"kit":false,"money":5200,"kills":11,"deaths":10,"roundKills":2,"weapon":"AK-47","primary":"AK-47","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":10,"steamid":"76561198331041994","name":"Criminal_Boy","side":"T","alive":true,"hp":18,"armor":80,"helmet":true,"kit":false,"money":2350,"kills":8,"deaths":12,"roundKills":0,"weapon":"Desert Eagle","primary":"Galil AR","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
  ],
  panel: {"steamid":"76561199217769102","hp":38,"hpLost":0,"mag":12,"reserve":null,"weapon":"USP-S","buy":false,"money":350,"voice":false},
  killfeed: [
    {"tick":114905,"attacker":"DiiiDiii","attackerSide":"T","victim":"Kugel666","victimSide":"CT","assister":"Criminal_Boy","assisterSide":"T","flashAssist":false,"weapon":"ak47","hs":true,"wallbang":false,"smoke":false,"blind":false,"noscope":false,"ago":3.6,"own":false},
    {"tick":115071,"attacker":"DiiiDiii","attackerSide":"T","victim":"SymboIe","victimSide":"CT","flashAssist":false,"weapon":"ak47","hs":true,"wallbang":false,"smoke":false,"blind":false,"noscope":false,"ago":1,"own":false},
  ],
  focus: {"steamid":"76561199217769102","keys":["JUMP","MOVELEFT"],"scoped":false,"fov":90,"flash":0},
}

const DEFUSE: HudView = {
  tick: 116293,
  round: 15,
  score: {"CT":9,"T":5},
  teams: {"CT":{"name":"tyrannus00","captain":{"name":"tyrannus00","steamid":"76561198254277069","avatar":null}},"T":{"name":"Derdummbadss","captain":{"name":"Derdummbadss","steamid":"76561198189827773","avatar":null}}},
  phase: "planted",
  clock: 12,
  bomb: {"planted":true,"site":"A","left":12,"total":41},
  defuse: {"steamid":"76561199217769102","kit":false,"progress":0.503,"left":5},
  vs: {"ct":1,"t":0},
  players: [
    {"slot":1,"steamid":"76561198254277069","name":"tyrannus00","side":"CT","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":650,"kills":12,"deaths":11,"roundKills":2,"weapon":"","primary":"FAMAS","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":2,"steamid":"76561199466380131","name":"Kugel666","side":"CT","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":50,"kills":15,"deaths":12,"roundKills":0,"weapon":"","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":3,"steamid":"76561198857175507","name":"C3M0","side":"CT","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":0,"kills":10,"deaths":14,"roundKills":0,"weapon":"","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":4,"steamid":"76561199217769102","name":"Exi","side":"CT","alive":true,"hp":38,"armor":91,"helmet":true,"kit":false,"money":950,"kills":12,"deaths":10,"roundKills":3,"weapon":"Talon Knife","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":5,"steamid":"76561199378438903","name":"SymboIe","side":"CT","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":1600,"kills":15,"deaths":10,"roundKills":0,"weapon":"","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":6,"steamid":"76561198189827773","name":"Derdummbadss","side":"T","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":2150,"kills":12,"deaths":14,"roundKills":1,"weapon":"","primary":"AK-47","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":7,"steamid":"76561197989308244","name":"stakson","side":"T","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":3150,"kills":8,"deaths":14,"roundKills":0,"weapon":"","primary":"Galil AR","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":8,"steamid":"76561198854956010","name":"sk1nnex","side":"T","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":3400,"kills":18,"deaths":12,"roundKills":1,"weapon":"","primary":"AK-47","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":9,"steamid":"76561198317764598","name":"DiiiDiii","side":"T","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":5200,"kills":11,"deaths":11,"roundKills":2,"weapon":"","primary":"AK-47","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
    {"slot":10,"steamid":"76561198331041994","name":"Criminal_Boy","side":"T","alive":false,"hp":0,"armor":0,"helmet":false,"kit":false,"money":2350,"kills":8,"deaths":13,"roundKills":0,"weapon":"","primary":"M4A1-S","utility":[],"bomb":false,"speaking":false,"flash":0,"avatar":null},
  ],
  panel: {"steamid":"76561199217769102","hp":38,"hpLost":0,"mag":null,"reserve":null,"weapon":"Talon Knife","buy":false,"money":950,"voice":false},
  killfeed: [],
  focus: {"steamid":"76561199217769102","keys":["USE"],"scoped":false,"fov":90,"flash":0},
}

const fx = (name: FixtureName, label: string, view: HudView, menu = false, keys = false): HudFixture =>
  ({ name, label, view, focus: '76561199217769102', rounds: ROUNDS, timeline: TIMELINE, tickrate: 64, menu, keys })

export const FIXTURES: Record<FixtureName, HudFixture> = {
  start: fx('start', 'Round start 3.0 s: full utility, buy time', START),
  schaden: fx('schaden', 'Damage 64.5 s: Exi −34 HP', SCHADEN),
  normal: fx('normal', 'Clutch 72.4 s: 1 VS 2, bomb planted', NORMAL),
  defuse: fx('defuse', 'Defuse 90.5 s: Exi without kit, 50 %', DEFUSE),
  menu: fx('menu', 'Like normal + settings menu open + key overlay', NORMAL, true, true),
}
