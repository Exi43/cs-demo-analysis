// Licht der Map-Materialien über three hinaus: Env-Ersatz der Dielektrika (ENV_ALBEDO) und stationäre Lichter (directlight 3:
// light_barn/omni2/rect, z. B. Nuke-„Sonne“ durch die Hallenfenster, Inferno/Ancient-Fensterlicht). CS2 rechnet ihr direktes Licht zur Laufzeit und nimmt den Schatten aus direct_light_shadows (Kanal = bakedshadowindex, licht-shader
// Befund 14; die Textur enthält nur Verdeckung, nicht die Lichtform). Hier: Sichtbarkeit aus stationary.dls (main/assets3d/map.ts
// bakeLightmap), Form/Abfall analytisch, Licht je Pixel mit three RE_Direct (diffus + Glanz) für alle Lightmap-Meshes der Map.
// Globaler Patch der lights-Chunks wie installFog (post.ts): die Map-Materialien haben eigene onBeforeCompile (engine/map.ts);
// Uniforms in ShaderLib.standard/physical. Aufruf vor dem ersten Übersetzen. Low = High.
// shortcut: Props mit Sonde (ohne Lightmap) und Agenten bekommen die Lichter nicht (CS2: Sonden-DLS + Shadowmap), Licht-Cookies
// (Fensterkreuze) fehlen; bei sichtbaren Lücken Sonden-DLS (env_light_probe_volume_atlas_dlshd G/B/A) und Cookie-Texturen exportieren.
import * as THREE from 'three'
import type { MapSettings, StationaryLight } from '../../../shared/assets3d'

/**
 * Abfall: CS2-Form w / max(d², w) (Lichtschleife f8_m11.msl) von der Kegelspitze aus, normiert auf R0 m (Barn: Spitze a0 = halbe Größe /
 * spread hinter der Lampe → paralleles Licht ohne Abfall), ab 80 % der Reichweite weich auf 0.
 * shortcut: R0 und die Einheit von brightness sind nicht aus dem Spiel belegt, an den Ladebildern gemessen (R0 1 / 2,5 / 5 m: 2,5 am besten).
 */
const R0 = 2.5
/**
 * Spiegelung ohne Env-Cubemap (Map-Dielektrika; dieselbe Albedo für Metall und Wasser/Glas: engine/map.ts): Umgebung ≈ Einstrahlung am Punkt × ENV_ALBEDO / π
 * (mittlere Albedo), three gewichtet mit Fresnel/Rauheit (RE_IndirectSpecular). Ladebilder (30 Posen): ΔE 6,47 → 6,25 (0,6: 6,27, 0,9: 6,40; Mirage +0,1).
 * shortcut: keine Spiegelbilder von Lampen/Fenstern (CS2: env_cubemap_array je Volumen) – erst mit exportierten Cubemaps.
 */
export const ENV_ALBEDO = 0.4

const PARS = (n: number) => `
#if defined( STANDARD ) && defined( USE_LIGHTMAP ) && defined( CSDA_SUNMASK )
	uniform sampler2D csdaDls;
	uniform vec4 csdaSl[ ${n * 7} ];
#endif`
const END = (n: number) => `
#if defined( STANDARD ) && defined( CSDA_SUNMASK ) && ! defined( CSDA_AGENT )
	radiance += ( 1.0 - metalnessFactor ) * irradiance * ${(ENV_ALBEDO / Math.PI).toFixed(5)}; // Env-Ersatz der Dielektrika
#endif
${n ? LOOP(n) : ''}`
const LOOP = (n: number) => `
#if defined( STANDARD ) && defined( USE_LIGHTMAP ) && defined( CSDA_SUNMASK )
	if ( vLightMapUv.x >= 0.0 ) { // gebündelte Sonden-Vertices: uv1 = −1
		vec3 csdaDl = texture2D( csdaDls, vLightMapUv ).rgb;
		vec3 csdaWp = cameraPosition + ( vec4( geometryPosition, 0.0 ) * viewMatrix ).xyz;
		for ( int i = 0; i < ${n}; i ++ ) {
			// [ pos, range ] [ fwd, Art ] [ Farbe, Kanal ] [ links, halbe Breite ] [ oben, halbe Höhe ] [ Scherung xy, Aufweitung, Spitze a0 ] [ soft xy, Ellipse bzw. Kegel-cos außen/innen ]
			vec4 A = csdaSl[ i * 7 ], B = csdaSl[ i * 7 + 1 ], C = csdaSl[ i * 7 + 2 ];
			float v = C.w < 0.5 ? csdaDl.r : C.w < 1.5 ? csdaDl.g : csdaDl.b;
			vec3 r = csdaWp - A.xyz;
			float d = length( r ), t = B.w < 0.5 ? d : dot( r, B.xyz );
			if ( v < 0.004 || t <= 0.0 || t > A.w ) continue;
			float a = v * smoothstep( 0.0, 1.0, ( A.w - t ) / ( 0.2 * A.w ) );
			vec3 L = - r / d;
			if ( B.w > 0.5 && B.w < 1.5 ) { // Barn
				vec4 D = csdaSl[ i * 7 + 3 ], E = csdaSl[ i * 7 + 4 ], F = csdaSl[ i * 7 + 5 ], G = csdaSl[ i * 7 + 6 ];
				vec2 q = abs( vec2( dot( r, D.xyz ), dot( r, E.xyz ) ) - F.xy * t ) / ( vec2( D.w, E.w ) + F.z * t );
				vec2 e = 1.0 - max( G.xy, 0.02 );
				a *= G.z > 0.5 ? smoothstep( 1.0, min( e.x, e.y ), length( q ) ) : smoothstep( 1.0, e.x, q.x ) * smoothstep( 1.0, e.y, q.y );
				vec3 ax = normalize( B.xyz + F.x * D.xyz + F.y * E.xyz ); // Strahlachse mit Scherung
				L = - normalize( r + ax * F.w );
				a *= pow( ( F.w + ${R0.toFixed(3)} ) / ( F.w + t ), 2.0 ); // Abstand zur Spitze
			} else {
				a *= ${(R0 * R0).toFixed(3)} / max( d * d, ${(R0 * R0).toFixed(3)} );
				if ( B.w > 1.5 ) a *= max( dot( - L, B.xyz ), 0.0 ); // Fläche: Lambert-Strahler
				else { vec4 G = csdaSl[ i * 7 + 6 ]; a *= smoothstep( G.z, G.w, dot( - L, B.xyz ) ); } // Kegel (rundum: −2, −1)
			}
			directLight.color = C.rgb * a;
			directLight.direction = normalize( ( viewMatrix * vec4( L, 0.0 ) ).xyz );
			directLight.visible = true;
			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		}
	}
#endif
`
const ORIG = { lightmap_pars_fragment: THREE.ShaderChunk.lightmap_pars_fragment, lights_fragment_end: THREE.ShaderChunk.lights_fragment_end }
if (!ORIG.lights_fragment_end.includes('RE_IndirectDiffuse(')) throw new Error('three lights_fragment_end changed: stationary lights do not apply')
let gen = 0

/** 7 vec4 je Licht (Aufbau siehe LOOP) */
function pack(l: StationaryLight): THREE.Vector4[] {
  const V = (x: number[], w: number) => new THREE.Vector4(x[0], x[1], x[2], w)
  const [sx, sy] = l.shear ?? [0, 0], sp = l.spread ?? 0, [w, h] = l.size ?? [0, 0]
  const cone = l.cone ? [Math.cos(l.cone[0] * Math.PI / 180), Math.cos(l.cone[1] * Math.PI / 180)] : [-2, -1]
  return [
    V(l.pos, l.rangeM), V(l.fwd, l.kind), V(l.color.map(c => c * Math.PI), l.ch), // CS2 diffus = brightness·N·L·Albedo, three = Farbe·N·L·Albedo/π
    V(l.left, w / 2), V(l.up, h / 2),
    new THREE.Vector4(sx, sy, sp, Math.min(1e5, Math.max(w, h) / 2 / Math.max(sp, 1e-6))),
    new THREE.Vector4(l.soft?.[0] ?? 0, l.soft?.[1] ?? 0, l.kind === 0 ? cone[0] : l.ellipse ? 1 : 0, l.kind === 0 ? cone[1] : 0),
  ]
}

/** lightmapUrl = Manifest-URL der Lightmap (dls liegt daneben); Rückgabe: Aufräumen (Chunks/Uniforms zurück, Textur frei) */
export async function installMapLight(renderer: THREE.WebGLRenderer, st: MapSettings, lightmapUrl: string): Promise<() => void> {
  const s = st.stationary, n = s?.lights.length ?? 0
  let tex: THREE.Texture | null = null, bmp: ImageBitmap | null = null
  if (s && n) {
    bmp = await new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
      .loadAsync(new URL(s.dls, lightmapUrl).href)
    tex = new THREE.Texture(bmp as unknown as HTMLImageElement)
    tex.flipY = false; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.needsUpdate = true
    renderer.initTexture(tex)
  }
  const uni = tex ? { csdaDls: { value: tex }, csdaSl: { value: s!.lights.flatMap(pack) } } : {}
  const CH = THREE.ShaderChunk, libs = [THREE.ShaderLib.standard, THREE.ShaderLib.physical]
  CH.lightmap_pars_fragment = ORIG.lightmap_pars_fragment + (n ? PARS(n) : '') + `\n// csda map light ${++gen}`
  CH.lights_fragment_end = END(n) + ORIG.lights_fragment_end
  const mine = CH.lightmap_pars_fragment
  for (const l of libs) Object.assign(l.uniforms, uni) // cloneUniforms: jede Material-Kopie teilt die GPU-Textur (gleiche Source)
  return () => {
    if (CH.lightmap_pars_fragment === mine) Object.assign(CH, ORIG) // sonst hat eine neuere Engine schon ihren Patch gesetzt
    for (const l of libs) if (tex && l.uniforms.csdaDls?.value === tex) for (const k of Object.keys(uni)) delete l.uniforms[k]
    tex?.dispose(); bmp?.close()
  }
}
