// Text der Analyse zerlegen: **fett**, `code` und :icon:-Tokens (nur bekannte Namen, damit Uhrzeiten wie 1:52 Text bleiben)
import type { IconToken } from '../../../shared/analysis/types'

export const ICON_TOKENS: IconToken[] = ['smoke', 'flash', 'molly', 'he', 'awp', 'deagle', 'c4', 'kit', 'knife', 'target', 'arrow', 'shuffle', 'layers', 'clock', 'bolt', 'star', 'check', 'x', 'warn']
export type Part = { k: 'text' | 'b' | 'code'; s: string } | { k: 'icon'; s: IconToken }

const RE = new RegExp(`(\\*\\*.+?\\*\\*|\`[^\`]+\`|:(?:${ICON_TOKENS.join('|')}):)`, 'g')

export function splitTokens(text: string): Part[] {
  return text.split(RE).filter(Boolean).map((s): Part =>
    s.length > 4 && s.startsWith('**') && s.endsWith('**') ? { k: 'b', s: s.slice(2, -2) }
      : s.length > 2 && s[0] === '`' && s.endsWith('`') ? { k: 'code', s: s.slice(1, -1) }
        : s.length > 2 && s[0] === ':' && s.endsWith(':') && ICON_TOKENS.includes(s.slice(1, -1) as IconToken) ? { k: 'icon', s: s.slice(1, -1) as IconToken }
          : { k: 'text', s })
}
