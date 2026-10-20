const WEAPONS: Record<string, string> = {
  ak47: 'AK-47', m4a1: 'M4A4', m4a1_silencer: 'M4A1-S', awp: 'AWP', ssg08: 'Scout', deagle: 'Deagle',
  usp_silencer: 'USP-S', glock: 'Glock', hkp2000: 'P2000', p250: 'P250', tec9: 'Tec-9', fiveseven: 'Five-SeveN',
  cz75a: 'CZ75', elite: 'Dualies', revolver: 'R8', galilar: 'Galil', famas: 'FAMAS', sg556: 'SG 553', aug: 'AUG',
  mac10: 'MAC-10', mp9: 'MP9', mp7: 'MP7', mp5sd: 'MP5', ump45: 'UMP', p90: 'P90', bizon: 'Bizon',
  nova: 'Nova', xm1014: 'XM1014', mag7: 'MAG-7', sawedoff: 'Sawed-Off', negev: 'Negev', m249: 'M249',
  hegrenade: 'HE', inferno: 'Molly', molotov: 'Molly', incgrenade: 'Inc', flashbang: 'Flash', smokegrenade: 'Smoke',
  decoy: 'Decoy', taser: 'Zeus', world: 'World', planted_c4: 'C4',
  'C4 Explosive': 'C4', 'High Explosive Grenade': 'HE', 'Incendiary Grenade': 'Inc', 'Molotov': 'Molly',
  'Smoke Grenade': 'Smoke', 'Flashbang': 'Flash', 'Decoy Grenade': 'Decoy', 'Zeus x27': 'Zeus',
}

export function weaponLabel(w: string): string {
  if (!w) return ''
  if (WEAPONS[w]) return WEAPONS[w]
  if (/knife|bayonet|karambit|dagger/i.test(w)) return 'Knife'
  return w
}

export const BUY_LABEL: Record<string, string> = { pistol: 'Pistol', eco: 'Eco', force: 'Force', full: 'Full Buy' }

export const mapLabel = (m: string) => m.replace(/^de_/, '').replace(/^\w/, c => c.toUpperCase())
