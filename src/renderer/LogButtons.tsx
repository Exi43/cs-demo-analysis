import { useState } from 'react'
import { api } from './api'
import { Icon } from './icons'

/** Seitenleiste unten: App-Protokoll (main/log.ts) für Fehlerberichte kopieren (z. B. in Discord einfügen) oder im Explorer zeigen */
export function LogButtons() {
  const [copied, setCopied] = useState<'ok' | 'fail'>()
  const copy = () => api.copyLog().then(() => setCopied('ok'), () => setCopied('fail')).finally(() => setTimeout(() => setCopied(undefined), 2500))
  return (
    <div className="side-foot">
      <button className={`nav ${copied ?? ''}`} onClick={copy} title="Copies system info and the recent app log, e.g. to paste into Discord when something goes wrong">
        <Icon name={copied === 'ok' ? 'check' : copied === 'fail' ? 'x' : 'clipboard'} /> {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy failed' : 'Copy log'}
      </button>
      <button className="nav" onClick={() => api.showLog()} title="Shows app.log in Explorer"><Icon name="folder" /> Log folder</button>
    </div>
  )
}
