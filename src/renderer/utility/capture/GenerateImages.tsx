// „Generate images“ (Editor-Details, Detailseite): Aim- und Positions-Bild aus der 3D-Map (capture.ts, erst beim Klick geladen). Vorhandene
// Bilder ersetzt es nur nach Rückfrage; Fortschritt (Map-Bau beim ersten Mal, Laden, Rendern) steht im Knopf selbst.
import { useState } from 'react'
import type { Lineup } from '../../../shared/utility'
import { Icon } from '../../icons'
import { useUtil } from '../ui'
import type { CaptureStatus } from './capture'

type Src = Pick<Lineup, 'map' | 'technique' | 'images' | 'aim'> & { stand?: Lineup['stand'] }
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** tile = Kachel neben den Bildern (Editor), button = auffällig (noch keine Bilder), corner = klein oben rechts auf dem Bild; null ohne Stand/Blick */
export function GenerateImages({ l, onImages, variant }: { l: Src; onImages: (hashes: string[]) => void; variant: 'tile' | 'button' | 'corner' }) {
  const { notify } = useUtil()
  const [st, setSt] = useState<CaptureStatus>()
  const { map, stand, aim, technique, images } = l
  if (!map || !stand || !aim) return null
  const go = async () => {
    const n = images.length
    if (n && !confirm(`Replace ${n === 1 ? 'the image' : `the ${n} images`} of this lineup with an aim and a position image from the 3D map?`)) return
    setSt({ msg: 'Loading map', pct: 0 })
    try {
      const { captureLineup } = await import('./capture')
      onImages(await captureLineup({ map, stand, aim, technique }, setSt))
    } catch (e) { notify(`Could not generate images: ${errText(e)}`, true) } finally { setSt(undefined) }
  }
  return (
    <button type="button" className={`ut-gen ${variant} ${st ? 'busy' : ''}`} onClick={go} disabled={!!st} aria-busy={!!st}
      title="Render where to stand and where to aim from the 3D map (the first time the map is built from your CS2 installation)">
      {st
        ? <><span className="ut-gen-bar"><i style={{ width: `${Math.max(4, Math.min(100, st.pct))}%` }} /></span><small>{st.msg}</small></>
        : <><Icon name="camera" size={variant === 'tile' ? 22 : 15} /><span>Generate images</span></>}
    </button>
  )
}
