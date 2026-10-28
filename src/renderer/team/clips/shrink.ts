// Clip verkleinern ohne Paket: <video> spielt den Ausschnitt stumm ab, jedes Bild auf ein Canvas (höchstens 1280×720), MediaRecorder
// nimmt das Canvas als WebM (VP9, ~1 Mbit/s, ohne Ton) auf. Läuft in Echtzeit: ein 60-s-Clip braucht 60 s.

export const MAX_CLIP_S = 60
const W = 1280, H = 720, BITRATE = 1_000_000

const once = (el: HTMLMediaElement, ev: string) => new Promise<void>((res, rej) => {
  const ok = () => { el.removeEventListener('error', bad); res() }, bad = () => { el.removeEventListener(ev, ok); rej(new Error('This video cannot be read (try mp4 or webm)')) }
  el.addEventListener(ev, ok, { once: true }); el.addEventListener('error', bad, { once: true })
})
const mime = () => ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t)) ?? 'video/webm'

/** Ausschnitt start..end (Sekunden, höchstens 60 s) → WebM; onProgress 0..1 */
export async function shrinkClip(file: Blob, start: number, end: number, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<{ blob: Blob; durationS: number }> {
  if (!(end > start)) throw new Error('The end must be after the start')
  if (end - start > MAX_CLIP_S + 0.05) throw new Error(`Clips can be at most ${MAX_CLIP_S} seconds long`)
  const url = URL.createObjectURL(file), v = document.createElement('video')
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url
  try {
    await once(v, 'loadedmetadata')
    end = Math.min(end, v.duration || end)
    const s = Math.min(1, W / v.videoWidth, H / v.videoHeight)
    const c = document.createElement('canvas')
    c.width = Math.max(2, Math.round((v.videoWidth * s) / 2) * 2); c.height = Math.max(2, Math.round((v.videoHeight * s) / 2) * 2)
    const g = c.getContext('2d')!
    v.currentTime = start
    await once(v, 'seeked')
    const draw = () => g.drawImage(v, 0, 0, c.width, c.height)
    draw()
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: mime(), videoBitsPerSecond: BITRATE })
    const parts: Blob[] = []
    rec.ondataavailable = e => { if (e.data.size) parts.push(e.data) }
    const done = new Promise<void>(res => { rec.onstop = () => res() })
    rec.start(1000)
    await new Promise<void>((res, rej) => {
      let stopped = false
      const stop = (err?: Error) => { if (stopped) return; stopped = true; v.pause(); err ? rej(err) : res() }
      signal?.addEventListener('abort', () => stop(new DOMException('Cancelled', 'AbortError')), { once: true })
      v.addEventListener('ended', () => stop(), { once: true })
      // jedes neue Videobild zeichnen (requestVideoFrameCallback), Ende am Schnittpunkt
      const frame = () => {
        if (stopped) return
        draw(); onProgress?.(Math.min(1, (v.currentTime - start) / (end - start)))
        if (v.currentTime >= end) stop(); else v.requestVideoFrameCallback(frame)
      }
      v.requestVideoFrameCallback(frame)
      v.play().catch(e => stop(e instanceof Error ? e : new Error(String(e))))
    })
    rec.stop(); await done
    onProgress?.(1)
    return { blob: new Blob(parts, { type: 'video/webm' }), durationS: Math.max(0.1, Math.min(end, v.currentTime) - start) }
  } finally { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url) }
}

/** WebM aus MediaRecorder hat keine Dauer im Kopf: einmal ans Ende springen, dann kennt das <video> sie (Zeitleiste geht) */
export function fixDuration(v: HTMLVideoElement) {
  if (v.duration !== Infinity) return
  v.addEventListener('timeupdate', () => { v.currentTime = 0 }, { once: true })
  v.currentTime = 1e9
}

/** Selbsttest: Testvideo 1920×1080 mit Bewegung und Rauschen (schwer zu komprimieren), 8 Mbit/s */
export async function makeTestVideo(seconds: number): Promise<Blob> {
  const c = document.createElement('canvas'); c.width = 1920; c.height = 1080
  const g = c.getContext('2d')!, rec = new MediaRecorder(c.captureStream(30), { mimeType: mime(), videoBitsPerSecond: 8_000_000 }), parts: Blob[] = []
  rec.ondataavailable = e => { if (e.data.size) parts.push(e.data) }
  const done = new Promise<void>(res => { rec.onstop = () => res() })
  rec.start(500)
  const t0 = performance.now()
  await new Promise<void>(res => {
    const tick = () => {
      const t = (performance.now() - t0) / 1000
      if (t >= seconds) return res()
      g.fillStyle = `hsl(${(t * 60) % 360} 60% 30%)`; g.fillRect(0, 0, 1920, 1080)
      for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(${(i * 37) % 360} 80% 60%)`; g.fillRect((i * 97 + t * 400) % 1920, (i * 53) % 1080, 40, 40) }
      g.fillStyle = '#fff'; g.font = 'bold 160px sans-serif'; g.fillText(`${t.toFixed(1)} s`, 100 + t * 150, 600)
      setTimeout(tick, 33)
    }
    tick()
  })
  rec.stop(); await done
  return new Blob(parts, { type: 'video/webm' })
}
