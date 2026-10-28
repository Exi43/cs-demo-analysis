// DynamicParams der Himmels-Materialien (Dust2-Wolken nuke_clouds_002: Skala 3,5, Schwenk 0,002/s; statische Werte davor ignorieren)
import { describe, expect, it } from 'vitest'
import { vmatDynamic } from './map.ts'

const VMAT = `"Layer0"
{
	"shader"	"csgo_unlitgeneric.vfx"
	"g_vTexCoordOffset"	"[0.000000 0.000000 0.000000 0.000000]"
	"g_vTexCoordScale"	"[1.000000 1.000000 0.000000 0.000000]"
	"DynamicParams"
	{
		"g_vTexCoordOffset"	"return frac(float2(0,.002)*time());"
		"g_vTexCoordScale"	"return float2(3.5,3.5);"
	}
}`

describe('vmatDynamic', () => {
  it('liest float2 und Zeit-Ausdrücke nur aus DynamicParams', () => {
    expect(vmatDynamic(VMAT, 'g_vTexCoordScale')).toEqual({ v: [3.5, 3.5], time: false })
    expect(vmatDynamic(VMAT, 'g_vTexCoordOffset')).toEqual({ v: [0, 0.002], time: true })
    expect(vmatDynamic(VMAT, 'g_vTex2CoordScale')).toBeUndefined()
    expect(vmatDynamic('"g_vTexCoordScale"	"[2 2 0 0]"', 'g_vTexCoordScale')).toBeUndefined()
  })
})
