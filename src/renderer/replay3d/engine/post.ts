// Bild-Pipeline wie CS2 (licht-shader Befunde 9, 11): Welt, Viewmodel und Granaten-Kamera zeichnen linear in HDR-Ziele (HalfFloat;
// High MSAA 4), dann ein Endpass auf das Canvas: Bloom (nur High) → Belichtung (Auto-Belichtung, Low = High) + Hable-Kurve der .vpost, normiert auf den Weißpunkt
// → sRGB → Screen-Bloom → Farb-LUT. Alle Szenen-Pässe in Render-Targets = ein Programm-Satz (three tonemappt in RTs nie selbst).
// Umschalten (Bloom/MSAA bei Auflösungsstufe 0,5, Granaten-Kamera, LUT) ändert nur Uniforms/Ziele, nie ein Programm.
import * as THREE from 'three'
import type { MapSettings } from '../../../shared/assets3d'

/** Bloom-Mip-Kette 1/2 … 1/32 */
const LEVELS = 5
/**
 * Anteil je Stufe (vpost m_flBlurWeight, Dust2/Ancient/Inferno 0,2 × 5) → Mischgewicht beim Hochrechnen in place:
 * a_i = 1 − w_i / (1 − Σ_{j<i} w_j). shortcut: feste Gleichverteilung, Mirage/Nuke/Anubis gewichten die letzte Stufe stärker (settings ohne blurWeight).
 */
const BLUR_W = [0.2, 0.2, 0.2, 0.2, 0.2]
const MIX = (() => { let rest = 1; return BLUR_W.map(x => { const a = 1 - x / rest; rest -= x; return a }) })()

const VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }'

// 13-Tap-Downsample (bloom_cs): ±2/±1 Texel um die Quell-UV; KARIS = erste Stufe mit Vorfilter c·smoothstep(0, T, Luma601) und
// Karis-Mittel 1/(1 + Luma) je 2×2-Block (gegen Glühwürmchen)
const DOWN = /* glsl */ `uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uT; varying vec2 vUv;
float luma( vec3 c ) { return dot( c, vec3( 0.299, 0.587, 0.114 ) ); }
vec3 tap( vec2 o ) {
	vec3 c = texture2D( tSrc, vUv + o * uTexel ).rgb;
#ifdef KARIS
	c *= smoothstep( 0.0, uT, luma( c ) );
#endif
	return c;
}
#ifdef KARIS
vec3 box( vec3 a, vec3 b, vec3 c, vec3 d ) {
	float wa = 1.0 / ( 1.0 + luma( a ) ), wb = 1.0 / ( 1.0 + luma( b ) ), wc = 1.0 / ( 1.0 + luma( c ) ), wd = 1.0 / ( 1.0 + luma( d ) );
	return ( a * wa + b * wb + c * wc + d * wd ) / ( wa + wb + wc + wd );
}
#endif
void main() {
	vec3 a = tap( vec2( -2.0, 2.0 ) ), b = tap( vec2( 0.0, 2.0 ) ), c = tap( vec2( 2.0, 2.0 ) );
	vec3 d = tap( vec2( -2.0, 0.0 ) ), e = tap( vec2( 0.0 ) ), f = tap( vec2( 2.0, 0.0 ) );
	vec3 g = tap( vec2( -2.0, -2.0 ) ), h = tap( vec2( 0.0, -2.0 ) ), i = tap( vec2( 2.0, -2.0 ) );
	vec3 j = tap( vec2( -1.0, 1.0 ) ), k = tap( vec2( 1.0, 1.0 ) ), l = tap( vec2( -1.0, -1.0 ) ), m = tap( vec2( 1.0, -1.0 ) );
#ifdef KARIS
	vec3 r = box( j, k, l, m ) * 0.5 + ( box( a, b, d, e ) + box( b, c, e, f ) + box( d, e, g, h ) + box( e, f, h, i ) ) * 0.125;
#else
	vec3 r = e * 0.125 + ( a + c + g + i ) * 0.03125 + ( b + d + f + h ) * 0.0625 + ( j + k + l + m ) * 0.125;
#endif
	gl_FragColor = vec4( clamp( r, 0.0, 65504.0 ), 1.0 );
}`

/**
 * Auto-Belichtung wie CS2 (histogram_cs: Mittel von log2(max(Rec.-709-Luma, 0,005)) → geometrisches Mittel Y, licht-shader Befund 10):
 * Messbild AE_W × AE_H (je Texel 4 × 4 Abtastungen des HDR-Ziels), asynchron zurückgelesen (PBO, kein GPU-Stau), nächste Messung sobald zurück.
 * Belichtung k = clamp(AE_KEY / Y, min(k₀, AE_PPV[0] · min), AE_PPV[1] · max), k₀ = toneMapping.exposure, min/max = min/maxexposure der
 * post_processing_volume (settings.exposureRange, × Belichtungs-Bias der .vpost); ältere map.json: k₀ · AE_RANGE als Grenzen. Gleitet mit
 * AE_RATE in log2. Gefittet an den 30 CS2-Ladebild-Posen (LUT an, Fehler je Pose in Blenden, rms): feste Belichtung 0,42, k₀-Grenzen 0,23,
 * diese Formel 0,18 (Anubis mit kleinem minexposure dunkler wie CS2). shortcut: CPU-Formel von CS2 unbekannt – bei neuen Ladebild-Messungen nachfitten.
 */
const AE_W = 64, AE_H = 36, AE_KEY = 0.306, AE_PPV = [1.76, 1.9] as const, AE_RANGE = [1, 1.7] as const, AE_RATE = 2.5
const LOGLUM = /* glsl */ `uniform sampler2D tSrc; varying vec2 vUv;
void main() {
	float s = 0.0;
	for ( int i = 0; i < 16; i++ ) {
		vec2 o = ( vec2( float( i - ( i / 4 ) * 4 ), float( i / 4 ) ) - 1.5 ) / vec2( ${AE_W * 4}.0, ${AE_H * 4}.0 );
		s += log2( max( dot( texture2D( tSrc, vUv + o ).rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.005 ) );
	}
	gl_FragColor = vec4( s / 16.0, 0.0, 0.0, 1.0 );
}`

// Zelt 3×3 aus der kleineren Stufe, Radius 1 Ziel-Texel; Alpha = Mischgewicht (Blending ins Ziel)
const UP = /* glsl */ `uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uMix; varying vec2 vUv;
void main() {
	vec2 t = uTexel;
	vec3 r = texture2D( tSrc, vUv ).rgb * 0.25
		+ ( texture2D( tSrc, vUv + vec2( 0.0, t.y ) ).rgb + texture2D( tSrc, vUv - vec2( 0.0, t.y ) ).rgb + texture2D( tSrc, vUv + vec2( t.x, 0.0 ) ).rgb + texture2D( tSrc, vUv - vec2( t.x, 0.0 ) ).rgb ) * 0.125
		+ ( texture2D( tSrc, vUv + t ).rgb + texture2D( tSrc, vUv - t ).rgb + texture2D( tSrc, vUv + vec2( t.x, -t.y ) ).rgb + texture2D( tSrc, vUv + vec2( -t.x, t.y ) ).rgb ) * 0.0625;
	gl_FragColor = vec4( r, uMix );
}`

// Endpass (post_process_ps): c·k → Kurve → sRGB → Screen-Bloom → LUT bei c·31/32 + 1/64. uMode 0 Hable, 1 Neutral (alte map.json), 2 Linear.
// Bloom 'add': CS2 c·(1 − s₁) + b·s₂ (s₁, s₂ CPU-Werte); hier mix(c, b, Stärke) – gemessen besser als c + b·Stärke (Ancient ΔE −0,4).
const FINAL = /* glsl */ `uniform sampler2D tHdr; uniform sampler2D tBloom; uniform sampler3D tLut;
uniform float uExposure; uniform vec4 uCurve; uniform vec3 uCurve2; uniform float uMode; uniform vec2 uBloom; uniform float uLut; uniform float uScope;
varying vec2 vUv;
vec3 hable( vec3 x ) { // A Schulter, B Linear-Stärke, C Linear-Winkel, D Toe-Stärke, E/F Toe-Zähler/-Nenner
	return ( x * ( uCurve.x * x + uCurve.z * uCurve.y ) + uCurve.w * uCurve2.x ) / ( x * ( uCurve.x * x + uCurve.y ) + uCurve.w * uCurve2.y ) - uCurve2.x / uCurve2.y;
}
vec3 neutral( vec3 c ) { // Khronos PBR Neutral (wie three NeutralToneMapping)
	float x = min( c.r, min( c.g, c.b ) );
	c -= x < 0.08 ? x - 6.25 * x * x : 0.04;
	float peak = max( c.r, max( c.g, c.b ) );
	if ( peak < 0.76 ) return c;
	float np = 1.0 - 0.0576 / ( peak - 0.52 );
	c *= np / peak;
	return mix( c, vec3( np ), 1.0 - 1.0 / ( 0.15 * ( peak - np ) + 1.0 ) );
}
vec3 srgb( vec3 c ) { return mix( 1.055 * pow( c, vec3( 0.41666 ) ) - 0.055, c * 12.92, vec3( lessThanEqual( c, vec3( 0.0031308 ) ) ) ); }
void main() {
	vec3 c, b = vec3( 0.0 );
	if ( uScope > 0.0 ) { // Linse des Zielfernrohrs (legacy_sniper_scope.vfx): r in Bildhöhen ab der Mitte, Rand bei R = 0,425, Farbsaum je Kanal
		vec2 p = ( vUv - 0.5 ) * vec2( uScope, 1.0 );
		float r = length( p ), e = smoothstep( 0.385, 0.425, r ), ca = sqrt( smoothstep( 0.05, 1.0, r ) ) * 0.5;
		vec2 n = r > 0.0 ? p / r : vec2( 0.0 ), uv = vUv + n * ( pow( r, 6.0 ) + e * e * e * 0.05 );
		c = vec3( texture2D( tHdr, uv - n * ca * 0.015 ).r, texture2D( tHdr, uv - n * ca * 0.02 ).g, texture2D( tHdr, uv - n * ca * 0.025 ).b );
	} else c = texture2D( tHdr, vUv ).rgb;
	if ( uBloom.x + uBloom.y > 0.0 ) b = texture2D( tBloom, vUv ).rgb;
	vec3 x = max( mix( c, b, uBloom.y ) * uExposure, 0.0 );
	vec3 t = uMode < 0.5 ? hable( x ) * uCurve2.z : uMode < 1.5 ? neutral( x ) : x;
	t = srgb( clamp( t, 0.0, 1.0 ) );
	vec3 bE = b * uExposure, s = clamp( 1.035 * bE / ( bE + 0.187 ), 0.0, 1.0 ) * uBloom.x;
	t = t + s - t * s;
	if ( uLut > 0.0 ) t = texture( tLut, t * ( 31.0 / 32.0 ) + 1.0 / 64.0 ).rgb;
	gl_FragColor = vec4( t, 1.0 );
}`

export interface Post {
  /** HDR-Ziel für Welt und Viewmodel (linear, ohne Tonemapping) */
  readonly target: THREE.WebGLRenderTarget
  setSize(w: number, h: number): void
  /** MSAA (nur wenn beim Anlegen erlaubt) und Bloom an/aus, ohne neues Programm */
  setQuality(msaa: boolean, bloom: boolean): void
  /** Endpass: target → Canvas (Bloom wenn an), Viewport = ganzes Canvas; dt = Sekunden seit dem letzten Bild (Auto-Belichtung) */
  finish(dt: number): void
  /** Auto-Belichtung noch nicht eingeschwungen (Messung läuft oder Belichtung gleitet): in der Pause weiter Bilder zeichnen */
  adapting(): boolean
  /**
   * Linse des Zielfernrohrs im Endpass (Ego, gezoomtes Scharfschützengewehr; Maske/Vignette/Linien zeichnet Hud.tsx): aspect = Breite/Höhe, 0 = aus.
   * shortcut: Rand fest bei R = 0,425 (Unschärfe k = 0); bei Bewegung (k > 0) liegt der Randring ohnehin unter der schwarzen Maske.
   */
  setScope(aspect: number): void
  /** dasselbe Endpass-Programm für ein anderes HDR-Bild in ein Canvas-Rechteck (GL-Pixel, Ursprung unten links), ohne Bloom/Linse */
  draw(tex: THREE.Texture, x: number, y: number, w: number, h: number): void
  /** alle Post-Programme jetzt übersetzen (beim Laden) */
  compile(): void
  dispose(): void
}

/** lut = lut.bin (32³ × RGB8, r schnellste Achse) oder null; msaa/bloom = erlaubt (High) */
export function createPost(renderer: THREE.WebGLRenderer, st: MapSettings, lut: ArrayBuffer | null, msaa: boolean, bloomOk: boolean): Post {
  const hdr = (w: number, h: number, samples = 0, depth = false) => new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, samples, depthBuffer: depth, stencilBuffer: depth, generateMipmaps: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, resolveDepthBuffer: false, resolveStencilBuffer: false,
  })
  const target = hdr(1, 1, msaa ? 4 : 0, true) // Stencil: X-Ray-Umrisse (xray.ts)
  const levels = bloomOk ? Array.from({ length: LEVELS }, () => hdr(1, 1)) : []

  const tri = new THREE.BufferGeometry()
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
  tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2))
  const pass = (fs: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string> = {}, blend = false) =>
    new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms, defines, depthTest: false, depthWrite: false, toneMapped: false, transparent: blend, blending: blend ? THREE.NormalBlending : THREE.NoBlending })
  const karis = pass(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uT: { value: Math.max(1e-3, st.bloom?.threshold ?? 1) } }, { KARIS: '' })
  const down = pass(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uT: { value: 1 } })
  const up = pass(UP, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uMix: { value: 0.5 } }, {}, true)

  // Kurve: Hable aus der .vpost, normiert auf H(W); Neutral/Linear nur für alte map.json bzw. ohne .vpost
  const tm = st.toneMapping, cv = tm.type === 'Hable' ? tm.curve : undefined
  const H = (x: number) => cv ? (x * (cv.shoulder * x + cv.linearAngle * cv.linearStrength) + cv.toeStrength * cv.toeNum) / (x * (cv.shoulder * x + cv.linearStrength) + cv.toeStrength * cv.toeDenom) - cv.toeNum / cv.toeDenom : 1
  let lutTex: THREE.Data3DTexture | null = null
  if (lut && lut.byteLength === 32 ** 3 * 3) {
    const src = new Uint8Array(lut), rgba = new Uint8Array(32 ** 3 * 4)
    for (let i = 0, j = 0; i < src.length; i += 3, j += 4) { rgba[j] = src[i]; rgba[j + 1] = src[i + 1]; rgba[j + 2] = src[i + 2]; rgba[j + 3] = 255 }
    lutTex = new THREE.Data3DTexture(rgba, 32, 32, 32)
    lutTex.minFilter = lutTex.magFilter = THREE.LinearFilter; lutTex.unpackAlignment = 1; lutTex.needsUpdate = true
  }
  const bloomS = st.bloom?.mode === 'add' ? [0, st.bloom.strength] : [st.bloom?.strength ?? 0, 0]
  const fu = {
    tHdr: { value: target.texture as THREE.Texture }, tBloom: { value: (levels[0]?.texture ?? null) as THREE.Texture | null }, tLut: { value: lutTex },
    uExposure: { value: tm.exposure }, uMode: { value: cv ? 0 : tm.type === 'Linear' ? 2 : 1 },
    uCurve: { value: new THREE.Vector4(cv?.shoulder ?? 0, cv?.linearStrength ?? 1, cv?.linearAngle ?? 1, cv?.toeStrength ?? 0) },
    uCurve2: { value: new THREE.Vector3(cv?.toeNum ?? 0, cv?.toeDenom ?? 1, cv ? 1 / H(cv.whitePoint) : 1) },
    uBloom: { value: new THREE.Vector2() }, uLut: { value: lutTex ? 1 : 0 }, uScope: { value: 0 },
  }
  const final = pass(FINAL, fu)

  const quad = new THREE.Mesh(tri, final), qs = new THREE.Scene(), cam = new THREE.Camera()
  quad.frustumCulled = false; qs.add(quad)
  const run = (m: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget | null) => { quad.material = m; renderer.setRenderTarget(to); renderer.render(qs, cam) }
  let bloomOn = false, w = 1, h = 1, scope = 0
  const vp = new THREE.Vector4()

  // Auto-Belichtung: jede Messung startet, sobald die vorige zurück ist; Ziel = Messung, ruhig = zwei Messungen in Folge gleich
  const aeRT = new THREE.WebGLRenderTarget(AE_W, AE_H, { type: THREE.FloatType, depthBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
  const logLum = pass(LOGLUM, { tSrc: { value: target.texture as THREE.Texture } }), aeBuf = new Float32Array(AE_W * AE_H * 4)
  const k0 = tm.exposure, er = st.exposureRange, bias = er ? k0 / (1.26 * (er[0] + er[1]) / 2) : 1 // map.ts mapSettings: k₀ = 1,26 · Mittel · Bias
  const lo = er ? Math.min(k0, AE_PPV[0] * er[0] * bias) : k0 * AE_RANGE[0], hi = er ? AE_PPV[1] * er[1] * bias : k0 * AE_RANGE[1]
  let k = k0, want = 0, last = 0, reading = false, aeOff = false, disposed = false
  const measure = () => {
    logLum.uniforms.tSrc.value = target.texture
    run(logLum, aeRT)
    reading = true
    renderer.readRenderTargetPixelsAsync(aeRT, 0, 0, AE_W, AE_H, aeBuf).then(() => {
      if (disposed) return
      let s = 0
      for (let i = 0; i < aeBuf.length; i += 4) s += aeBuf[i]
      const y = 2 ** (s / (AE_W * AE_H)), next = Math.min(hi, Math.max(lo, AE_KEY * bias / y))
      if (!want) k = next // erste Messung: sofort
      last = want; want = next
    }, e => { aeOff = true; console.warn('auto exposure off', e) }).finally(() => { reading = false })
  }

  const self: Post = {
    target,
    setSize(nw, nh) {
      w = nw; h = nh
      target.setSize(w, h)
      levels.forEach((l, i) => l.setSize(Math.max(1, Math.ceil(w / 2 ** (i + 1))), Math.max(1, Math.ceil(h / 2 ** (i + 1)))))
    },
    setQuality(ms, bl) {
      const s = msaa && ms ? 4 : 0
      if (target.samples !== s) { target.samples = s; target.dispose() } // nächstes setRenderTarget legt das Ziel neu an
      bloomOn = bl && levels.length > 0 && (st.bloom?.strength ?? 0) > 0
    },
    setScope(a) { scope = a },
    adapting: () => !aeOff && (reading || !want || Math.abs(Math.log2(want / last)) > 0.01 || Math.abs(Math.log2(want / k)) > 0.01),
    finish(dt) {
      const ac = renderer.autoClear
      renderer.autoClear = false // jeder Pass deckt sein Ziel ganz ab; Hochrechnen mischt ins Ziel
      if (!aeOff && !reading) measure()
      if (want) k *= (want / k) ** (1 - Math.exp(-AE_RATE * dt)) // in log2 gleiten
      fu.uExposure.value = k
      if (bloomOn) {
        let src: THREE.Texture = target.texture, sw = w, sh = h
        levels.forEach((l, i) => {
          const m = i ? down : karis
          m.uniforms.tSrc.value = src; (m.uniforms.uTexel.value as THREE.Vector2).set(1 / sw, 1 / sh)
          run(m, l); src = l.texture; sw = l.width; sh = l.height
        })
        for (let i = LEVELS - 2; i >= 0; i--) {
          up.uniforms.tSrc.value = levels[i + 1].texture; (up.uniforms.uTexel.value as THREE.Vector2).set(1 / levels[i].width, 1 / levels[i].height)
          up.uniforms.uMix.value = MIX[i]
          run(up, levels[i])
        }
      }
      fu.tHdr.value = target.texture; fu.uScope.value = scope
      fu.uBloom.value.set(bloomOn ? bloomS[0] : 0, bloomOn ? bloomS[1] : 0)
      run(final, null)
      renderer.autoClear = ac
    },
    draw(tex, x, y, dw, dh) {
      fu.tHdr.value = tex; fu.uBloom.value.set(0, 0); fu.uScope.value = 0
      const ac = renderer.autoClear
      renderer.getViewport(vp); renderer.setRenderTarget(null); renderer.setViewport(x, y, dw, dh); renderer.autoClear = false
      quad.material = final; renderer.render(qs, cam)
      renderer.setViewport(vp); renderer.autoClear = ac
    },
    compile() {
      const ms = new THREE.Scene()
      if (levels.length) {
        for (const m of [karis, down, up]) { const q = new THREE.Mesh(tri, m); q.frustumCulled = false; ms.add(q) }
        renderer.setRenderTarget(levels[0]); renderer.compile(ms, cam)
      }
      quad.material = logLum; renderer.setRenderTarget(aeRT); renderer.compile(qs, cam); quad.material = final
      renderer.setRenderTarget(null); renderer.compile(qs, cam)
    },
    dispose() {
      disposed = true
      target.dispose(); aeRT.dispose(); for (const l of levels) l.dispose()
      for (const m of [karis, down, up, final, logLum]) m.dispose()
      tri.dispose(); lutTex?.dispose()
    },
  }
  return self
}

/**
 * CS2-Nebel im HDR vor dem Endpass (licht-shader Befund 8, Formeln aus csgo_environment_ps): erst Gradient-Nebel (env_gradient_fog,
 * Farbe fest), dann Cubemap-Nebel (env_cubemap_fog, Farbe = Himmel in Blickrichtung). Globaler Patch der fog-Chunks: gilt für alle
 * eingebauten three-Materialien mit fog: true in Szenen mit scene.fog (Map, Agenten, Viewmodel), Low = High. In Render-Targets
 * tonemappt three nicht, fog_fragment läuft also vor der Kurve. Parameter als Konstanten (eine Engine = eine Map); der Himmel als
 * kleine Cubemap (Hintergrund mit Drehung/Helligkeit gerendert, zurückgelesen), als Uniform in ShaderLib, weil die Map-/Agenten-
 * Materialien eigene onBeforeCompile haben. Aufruf nach scene.background/-Rotation/-Intensity, vor dem ersten Übersetzen.
 * Rückgabe: Aufräumen (Chunks/ShaderLib zurück, Textur frei).
 */
// three-Originale einmal beim Laden: überlappen zwei Engines (3D verlassen und schnell wieder öffnen), stellte die alte sonst den Patch
// der neuen zurück bzw. schriebe ihren eigenen Stand zurück (neue Szene ab 1 m nebelschwarz)
const FOG_ORIG = { fog_pars_vertex: THREE.ShaderChunk.fog_pars_vertex, fog_vertex: THREE.ShaderChunk.fog_vertex, fog_pars_fragment: THREE.ShaderChunk.fog_pars_fragment, fog_fragment: THREE.ShaderChunk.fog_fragment }
let fogGen = 0
export function installFog(renderer: THREE.WebGLRenderer, scene: THREE.Scene, st: MapSettings): () => void {
  const c = st.fog && st.fog.maxOpacity > 0 && st.fog.endM > st.fog.startM ? st.fog : undefined
  const g = st.gradientFog && st.gradientFog.maxOpacity > 0 && st.gradientFog.endM > st.gradientFog.startM ? st.gradientFog : undefined
  if (!c && !g) return () => {}
  const n = (v: number) => (Number.isFinite(v) ? v : 0).toFixed(6)
  /** Höhen-Rampe: 1 bei heightStart (dichter), 0 bei heightEnd */
  const height = (hs?: number, he?: number, e?: number) => hs !== undefined && he !== undefined && he !== hs && e
    ? ` * clamp( pow( clamp( ( ${n(he)} - csdaZ ) * ${n(1 / (he - hs))}, 0.0, 1.0 ), ${n(e)} ), 0.0, 1.0 )` : ''
  let cube: THREE.CubeTexture | null = null
  if (c) {
    const S = 32, rt = new THREE.WebGLCubeRenderTarget(S, { type: THREE.HalfFloatType })
    const sky = new THREE.Scene()
    sky.background = scene.background; sky.backgroundIntensity = scene.backgroundIntensity; sky.backgroundRotation.copy(scene.backgroundRotation)
    new THREE.CubeCamera(0.1, 10, rt).update(renderer, sky)
    const faces = Array.from({ length: 6 }, (_, i) => {
      const b = new Uint16Array(S * S * 4)
      renderer.readRenderTargetPixels(rt, 0, 0, S, S, b, i)
      return new THREE.DataTexture(b, S, S, THREE.RGBAFormat, THREE.HalfFloatType)
    })
    rt.dispose()
    cube = new THREE.CubeTexture(faces as unknown as HTMLImageElement[])
    cube.format = THREE.RGBAFormat; cube.type = THREE.HalfFloatType; cube.generateMipmaps = true
    cube.minFilter = THREE.LinearMipmapLinearFilter; cube.magFilter = THREE.LinearFilter; cube.needsUpdate = true
  }
  const CH = THREE.ShaderChunk
  CH.fog_pars_vertex = '#ifdef USE_FOG\n\tvarying vec3 vCsdaFog;\n#endif'
  CH.fog_vertex = '#ifdef USE_FOG\n\tvCsdaFog = mvPosition.xyz;\n#endif'
  CH.fog_pars_fragment = `#ifdef USE_FOG\n\tvarying vec3 vCsdaFog;\n${cube ? '\tuniform samplerCube csdaFogSky;\n' : ''}#endif`
  CH.fog_fragment = `#ifdef USE_FOG // csda ${++fogGen}
{
	vec3 csdaV = ( vec4( vCsdaFog, 0.0 ) * viewMatrix ).xyz; // Kamera → Punkt, Weltachsen
	float csdaD = length( csdaV ), csdaZ = cameraPosition.y + csdaV.y;
${g ? `	if ( csdaD > ${n(g.startM)} ) {
		float csdaA = pow( clamp( ( csdaD - ${n(g.startM)} ) * ${n(1 / (g.endM - g.startM))}, 0.0, 1.0 ), ${n(g.exponent)} )${height(g.heightStartM, g.heightEndM, g.heightExponent)} * ${n(g.maxOpacity)};
		gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( ${g.colorLinear.map(n).join(', ')} ), csdaA );
	}
` : ''}${c ? `	if ( csdaD > ${n(c.startM)} ) {
		float csdaF = clamp( pow( clamp( ( csdaD - ${n(c.startM)} ) * ${n(1 / (c.endM - c.startM))}, 0.0, 1.0 ), ${n(c.exponent)} ), 0.0, 1.0 )${height(c.heightStartM, c.heightEndM, c.heightExponent)};
		// shortcut: CS2-LOD = lodBias · (1 − f) in Mips der Himmels-Cubemap; hier lodBias als Anteil der 5 Mips der 32²-Kopie
		vec3 csdaC = textureLod( csdaFogSky, csdaV / csdaD, ${n((c.lodBias ?? 0) * 5)} * ( 1.0 - csdaF ) ).rgb;
		gl_FragColor.rgb = mix( gl_FragColor.rgb, csdaC, csdaF * ${n(c.maxOpacity)} );
	}
` : ''}}
#endif`
  const mine = CH.fog_fragment
  const libs = cube ? Object.values(THREE.ShaderLib).filter(s => s.fragmentShader.includes('#include <fog_fragment>')) : []
  for (const s of libs) s.uniforms.csdaFogSky = { value: cube } // cloneUniforms: jede Material-Kopie teilt die GPU-Textur (gleiche Source)
  scene.fog = new THREE.Fog(0, 0, 1) // nur der Schalter USE_FOG; Werte stehen im Chunk
  return () => {
    if (CH.fog_fragment === mine) Object.assign(CH, FOG_ORIG) // sonst hat eine neuere Engine schon ihren Patch gesetzt
    for (const s of libs) if (s.uniforms.csdaFogSky?.value === cube) delete s.uniforms.csdaFogSky
    if (cube) { cube.dispose(); for (const f of cube.image as unknown as THREE.DataTexture[]) f.dispose() }
  }
}
