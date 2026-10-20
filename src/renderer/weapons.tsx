// CS2-Waffen-Icons (aus den Spieldateien, panorama/images/icons/equipment)
const files = import.meta.glob('./assets/weapons/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const ICONS: Record<string, string> = {}
for (const [path, url] of Object.entries(files)) ICONS[path.split('/').pop()!.replace('.svg', '')] = url

// Anzeigename (aus der Demo) → Icon-Datei
const BY_NAME: Record<string, string> = {
  'AK-47': 'ak47', 'M4A4': 'm4a1', 'M4A1-S': 'm4a1_silencer', 'AWP': 'awp', 'SSG 08': 'ssg08', 'Desert Eagle': 'deagle',
  'USP-S': 'usp_silencer', 'Glock-18': 'glock', 'P2000': 'hkp2000', 'P250': 'p250', 'Tec-9': 'tec9', 'Five-SeveN': 'fiveseven',
  'CZ75-Auto': 'cz75a', 'Dual Berettas': 'elite', 'R8 Revolver': 'revolver', 'Galil AR': 'galilar', 'FAMAS': 'famas',
  'SG 553': 'sg556', 'AUG': 'aug', 'MAC-10': 'mac10', 'MP9': 'mp9', 'MP7': 'mp7', 'MP5-SD': 'mp5sd', 'UMP-45': 'ump45',
  'P90': 'p90', 'PP-Bizon': 'bizon', 'Nova': 'nova', 'XM1014': 'xm1014', 'MAG-7': 'mag7', 'Sawed-Off': 'sawedoff',
  'Negev': 'negev', 'M249': 'm249', 'G3SG1': 'g3sg1', 'SCAR-20': 'scar20', 'Zeus x27': 'taser', 'C4 Explosive': 'c4',
  'High Explosive Grenade': 'hegrenade', 'Flashbang': 'flashbang', 'Smoke Grenade': 'smokegrenade', 'Molotov': 'molotov',
  'Incendiary Grenade': 'incgrenade', 'Decoy Grenade': 'decoy',
  // Messer
  'Bayonet': 'bayonet', 'Bowie Knife': 'knife_survival_bowie', 'Butterfly Knife': 'knife_butterfly', 'Falchion Knife': 'knife_falchion',
  'Flip Knife': 'knife_flip', 'Gut Knife': 'knife_gut', 'Huntsman Knife': 'knife_tactical', 'Karambit': 'knife_karambit',
  'M9 Bayonet': 'knife_m9_bayonet', 'Navaja Knife': 'knife_gypsy_jackknife', 'Shadow Daggers': 'knife_push',
  'Stiletto Knife': 'knife_stiletto', 'Talon Knife': 'knife_widowmaker', 'Ursus Knife': 'knife_ursus', 'Classic Knife': 'knife_css',
  'Paracord Knife': 'knife_cord', 'Survival Knife': 'knife_canis', 'Nomad Knife': 'knife_outdoor', 'Skeleton Knife': 'knife_skeleton',
  'Kukri Knife': 'knife_kukri',
  // Event-Namen, die nicht 1:1 einer Datei entsprechen
  hkp2000: 'hkp2000', incgrenade: 'incgrenade', inferno: 'inferno', smoke: 'smokegrenade', flash: 'flashbang', he: 'hegrenade',
}

export function weaponIcon(name: string): string | undefined {
  if (!name) return undefined
  const key = BY_NAME[name] ?? name.replace(/^weapon_/, '').toLowerCase()
  return ICONS[key] ?? (/knife|bayonet|karambit|dagger/i.test(name) ? ICONS.knife : undefined)
}

export const isGrenade = (w: string) => /grenade|flashbang|molotov|decoy/i.test(w)
export const isKnife = (w: string) => /knife|bayonet|karambit|dagger/i.test(w)
const PISTOLS = /glock|usp|p2000|p250|tec-9|five-seven|cz75|dual berettas|desert eagle|r8/i

/** Hauptwaffe aus Inventar: Primär > Pistole > Messer */
export function mainWeapon(inv: string[]): string | undefined {
  const guns = inv.filter(w => !isGrenade(w) && !isKnife(w) && !/c4|zeus/i.test(w))
  return guns.find(w => !PISTOLS.test(w)) ?? guns[0]
}

export function Weapon({ name, h = 16, dim = false }: { name: string; h?: number; dim?: boolean }) {
  const src = weaponIcon(name)
  if (!src) return <span className="wpn-txt">{name}</span>
  return <img className="wpn" src={src} alt={name} title={name} style={{ height: h, opacity: dim ? 0.45 : 1 }} />
}
