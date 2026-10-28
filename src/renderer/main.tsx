import { createRoot } from 'react-dom/client'
import { App } from './App'
import { api } from './api'
import './styles.css'

// unbehandelte Fehler mit Stack ins App-Protokoll (main/log.ts); die Konsole meldet sie nur ohne Stack
addEventListener('error', e => api.logError(e.error?.stack ?? `${e.message} (${e.filename}:${e.lineno})`))
addEventListener('unhandledrejection', e => api.logError(`Unhandled rejection: ${e.reason?.stack ?? e.reason}`))

createRoot(document.getElementById('root')!).render(<App />)
