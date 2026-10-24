// Voice bei 0.5x/2x (rateMode 'stretch'): WSOLA-Zeitstreckung im Worker, Tonhöhe bleibt (voice-Spike: 10.9-s-Clip 20–125 ms).

/**
 * rate = Abspieltempo (0.5 → doppelt so lang). Fenster 30 ms Hann, 50 % Überlappung, Suche ±8 ms: grob (Schritt 4), dann fein ±3.
 */
function stretch(x: Float32Array, rate: number, sr = 48000): Float32Array {
  const N = Math.round(0.03 * sr) & ~1, Hs = N >> 1, Ha = Hs * rate, S = Math.round(0.008 * sr)
  const outLen = Math.round(x.length / rate)
  const y = new Float32Array(outLen + N), w = new Float32Array(outLen + N)
  const win = new Float32Array(N)
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)
  const corr = (p: number, ref: number, step: number) => { let c = 0; for (let i = 0; i < Hs; i += step) c += x[p + i] * x[ref + i]; return c }
  let prev = 0
  for (let k = 0, o = 0; o < outLen; k++, o += Hs) {
    const nominal = Math.round(k * Ha)
    let best = Math.min(nominal, Math.max(0, x.length - N))
    if (k > 0) {
      const ref = prev + Hs
      const lo = Math.max(0, nominal - S), hi = Math.min(x.length - N, nominal + S)
      if (ref + Hs <= x.length && lo <= hi) {
        let bestC = -Infinity
        for (let p = lo; p <= hi; p += 4) { const c = corr(p, ref, 4); if (c > bestC) { bestC = c; best = p } }
        const b0 = best; bestC = -Infinity
        for (let p = Math.max(lo, b0 - 3); p <= Math.min(hi, b0 + 3); p++) { const c = corr(p, ref, 2); if (c > bestC) { bestC = c; best = p } }
      }
    }
    for (let i = 0; i < N; i++) { const v = best + i < x.length ? x[best + i] : 0; y[o + i] += v * win[i]; w[o + i] += win[i] }
    prev = best
  }
  for (let i = 0; i < outLen; i++) if (w[i] > 1e-3) y[i] /= w[i]
  return y.subarray(0, outLen)
}

onmessage = (e: MessageEvent<{ key: string; x: Float32Array; rate: number }>) => {
  const { key, x, rate } = e.data, y = stretch(x, rate)
  postMessage({ key, buf: y.buffer, len: y.length }, { transfer: [y.buffer] })
}
