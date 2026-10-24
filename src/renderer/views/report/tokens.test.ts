import { describe, expect, it } from 'vitest'
import { splitTokens } from './tokens'

describe('splitTokens', () => {
  it('splits bold, code and icon tokens, keeps clock times as text', () => {
    expect(splitTokens('**stakson** :molly: mid 1:51 → :c4: B')).toEqual([
      { k: 'b', s: 'stakson' }, { k: 'text', s: ' ' }, { k: 'icon', s: 'molly' }, { k: 'text', s: ' mid 1:51 → ' }, { k: 'icon', s: 'c4' }, { k: 'text', s: ' B' },
    ])
  })
  it('handles adjacent tokens, unknown names and code', () => {
    expect(splitTokens(':molly:/:he: :foo: `last_place_name`')).toEqual([
      { k: 'icon', s: 'molly' }, { k: 'text', s: '/' }, { k: 'icon', s: 'he' }, { k: 'text', s: ' :foo: ' }, { k: 'code', s: 'last_place_name' },
    ])
  })
  it('plain text stays one part', () => {
    expect(splitTokens('Hit 1:23–0:48')).toEqual([{ k: 'text', s: 'Hit 1:23–0:48' }])
  })
})
