// CS2-Map in three (Port von mapopt/final/three/cs2map.mjs):
//  - Lightmap auf uv1 (RGB = indirektes Licht, A = Sonnenmaske), Sonne als DirectionalLight durch die Maske abgeschattet
//  - 2-Layer-Blend + Tint-Maske aus CSDA_materials_cs2, Sonden pro Vertex (_PROBE) für Props ohne Lightmap
//  - Overlays mit polygonOffset, Effekte additiv; Hemisphere nur für Meshes ohne Lightmap/Sonde
//  - Wasser/Glas: Fresnel-Spiegelung des Himmels (equirect), Wasser mit scrollenden Wellen-Normalen; keine Refraktion (Low = High)
//  - Himmel als HDR (manifest.skyHdr), 3D-Skybox (manifest.skybox) in echter Größe hinter der Map
//  - opake Meshes gleicher Material-Variante je Raumzelle zu einem Mesh gebündelt (weniger Draw-Calls/Uniform-Uploads)
import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import type { CSDABlend, CSDAFx, CSDAWater, MapAssetManifest, MapSettings } from '../../../shared/assets3d'
import { worldToGltf } from '../contracts'
import { ENV_ALBEDO } from './lighting'
import { TexPack, packPlugins, uploadNow } from './texstream'

const CSDA = 'CSDA_materials_cs2'
/**
 * Wasser ohne Tiefenpuffer/Refraktion: angenommene Tiefe (m) für die Nebel-Deckkraft und Helligkeit des Wasser-Nebels (Anteil des
 * Map-Lichts, das der Wasserkörper zurückstreut); abgeglichen am Ladebild de_anubis_1 (Wasser-ΔE 38,9 → 17,8, C/runs/anubis_cal4)
 */
const WATER_DEPTH_M = 1.6, WATER_ALBEDO = 0.05
/**
 * shortcut: CS2 spiegelt per SSR/Env-Cubemap die Umgebung; ohne die treffen flache Spiegelstrahlen (Höhe < ENV_HORIZON) und alle Strahlen
 * innen (ohne Sonne in der Umgebung) die beleuchtete Umgebung ≈ Map-Licht am Punkt × ENV_ALBEDO (lighting.ts; Wasser: × Nebelfarbe, die zur
 * Umgebung passt) statt Himmel. Cubemaps/SSR: Backlog High-Phase 2.
 * Wasser liegt meist eingefasst (Anubis-Becken/Kanal: Himmel nur halb bei senkrechtem Blick), Spiegel/Glas offen (Nuke-Becken).
 */
const ENV_HORIZON = { water: 2, glass: 0.3, mirror: 0.3 }
/** glatte opake Flächen (Rauheit ≤ das, ohne Rauheits-Textur, z. B. Nuke-Becken hr_river_water_001): Himmel per Fresnel spiegeln wie CS2 F_SPECULAR_INDIRECT */
const MIRROR_ROUGHNESS = 0.01
/** 3D-Skybox: eigene lineare Tiefe bis hierhin (m), Zeichenreihenfolge vor der Map (danach Tiefenpuffer leeren) */
const SKY_FAR_M = 50000, SKY_ORDER = -10, GROUND_ALBEDO = 0.3

/**
 * Himmels-Spiegelung für Agenten/Waffen/Viewmodel (CSDA_SKYREFL, nur High): eine Engine zur Zeit setzt sie nach dem Laden der Map (setSkyRefl),
 * die Agenten-Materialien übernehmen die Uniforms beim Übersetzen. shortcut: Himmel statt echter env_cubemap; Innenräume bleiben beim Ambient-Cube
 */
export const SKY_REFL = { csdaReflSky: { value: null as THREE.Texture | null }, csdaReflRot: { value: new THREE.Matrix3() }, csdaReflInt: { value: 1 } }
export function setSkyRefl(sky: THREE.Texture | null, st?: MapSettings): THREE.Texture | null {
  SKY_REFL.csdaReflSky.value?.dispose()
  // eigene Kopie mit Mips (Rauheit): Mips am Original ließen die Würfel-Umrechnung des Hintergrunds an den Polen grau verwischen
  const hdr = sky && (sky as THREE.DataTexture).isDataTexture ? sky.clone() : null // nur HDR (WebP-Himmel ist geklemmt)
  if (hdr) { hdr.generateMipmaps = true; hdr.minFilter = THREE.LinearMipmapLinearFilter; hdr.needsUpdate = true }
  SKY_REFL.csdaReflSky.value = hdr
  if (st) { SKY_REFL.csdaReflRot.value.setFromMatrix4(new THREE.Matrix4().makeRotationY(-skyYaw(st))); SKY_REFL.csdaReflInt.value = st.sky.backgroundIntensity }
  return hdr
}
/** beim Verwerfen einer Engine: Kopie nur freigeben, wenn keine neuere Engine sie schon ersetzt hat */
export function releaseSkyRefl(t: THREE.Texture | null) { if (t && SKY_REFL.csdaReflSky.value === t) setSkyRefl(null) }

/** Himmel-Drehung um three-y (rad); Hintergrund (scene.backgroundRotation.y), Nebel und Spiegelungen müssen dieselbe nehmen */
export const skyYaw = (s: MapSettings) => ((s.sky.yawDeg ?? 0) + 90) * Math.PI / 180

/** gemeinsam für Map und Agenten: CSDA_SUNMASK (Sonne × csdaSun), CSDA_NOHEMI, CSDA_PROBE (Vertex-Sonde), CSDA_AGENT (Ambient-Cube), CSDA_SKYAMB (3D-Skybox: Himmelslicht) */
export const LIGHTS_BEGIN = THREE.ShaderChunk.lights_fragment_begin
  .replace('getDirectionalLightInfo( directionalLight, directLight );', '$&\n\t\t#ifdef CSDA_SUNMASK\n\t\tdirectLight.color *= csdaSun;\n\t\t#endif')
  .replace('irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );', '#ifndef CSDA_NOHEMI\n\t\t\t$&\n\t\t\t#endif')
  + `
#ifdef CSDA_SKYAMB
	irradiance += mix( csdaGroundAmb, csdaSkyAmb, 0.5 + 0.5 * inverseTransformDirection( normal, viewMatrix ).y );
#endif
#ifdef CSDA_PROBE
	irradiance += vCsdaProbe.rgb * vCsdaProbe.rgb * csdaProbeScale;
#endif
#ifdef CSDA_AGENT
	{ // Ambient-Cube (Source-Achsen +X,-X,+Y,-Y,+Z,-Z); three-Welt (x,y,z) = Source (y,z,x)
		vec3 wn = inverseTransformDirection( normal, viewMatrix );
		vec3 sn = vec3( wn.z, wn.x, wn.y ), n2 = sn * sn;
		irradiance += n2.x * ( sn.x >= 0.0 ? csdaCube[ 0 ] : csdaCube[ 1 ] ) + n2.y * ( sn.y >= 0.0 ? csdaCube[ 2 ] : csdaCube[ 3 ] ) + n2.z * ( sn.z >= 0.0 ? csdaCube[ 4 ] : csdaCube[ 5 ] );
		// ohne Env-Cubemap wäre Metall im Schatten schwarz: Ambient-Cube in Spiegelrichtung als Radianz (= Irradianz / π)
		// shortcut: CS2 spiegelt die Env-Cubemap der Map; erst bei Bedarf die echten Cubemaps exportieren
		vec3 wr = inverseTransformDirection( reflect( - geometryViewDir, normal ), viewMatrix );
		vec3 sr = vec3( wr.z, wr.x, wr.y ), r2 = sr * sr;
		radiance += RECIPROCAL_PI * ( r2.x * ( sr.x >= 0.0 ? csdaCube[ 0 ] : csdaCube[ 1 ] ) + r2.y * ( sr.y >= 0.0 ? csdaCube[ 2 ] : csdaCube[ 3 ] ) + r2.z * ( sr.z >= 0.0 ? csdaCube[ 4 ] : csdaCube[ 5 ] ) );
		#ifdef CSDA_SKYREFL
		// High: Spiegelung oberhalb des Horizonts = HDR-Himmel (Mip nach Rauheit) × Sonnen-Sichtbarkeit des Agenten (draußen), sonst der Cube
		radiance = mix( radiance, textureLod( csdaReflSky, equirectUv( csdaReflRot * wr ), roughnessFactor * 9.0 ).rgb * csdaReflInt, csdaSunVis * smoothstep( 0.0, 0.25, wr.y ) );
		#endif
	}
#endif
`
if (!LIGHTS_BEGIN.includes('csdaSun;') || !LIGHTS_BEGIN.includes('#ifndef CSDA_NOHEMI') || !LIGHTS_BEGIN.includes('vec3 radiance = vec3( 0.0 );')) throw new Error('three lights_fragment_begin changed: CS2 shader patch does not apply')

// Mehr-Layer-Blend (CSDABlend, shared/assets3d.ts): 'mod' = smoothstep über die Blend-Modulation, 'height' = Höhen-Blend wie
// csgo_environment_blend (GetBlendWeights der VRF-Rekonstruktion: Layer 1 gewinnt bei Malerei 0, Layer 2 bei 1, dazwischen die höhere Textur)
const BLEND_PARS = `
varying vec4 vCsdaBlend;
uniform sampler2D csdaLayer2;
uniform vec4 csdaUv;
#ifdef CSDA_BLENDMOD
uniform sampler2D csdaBlendMod;
uniform vec4 csdaCh;
uniform vec3 csdaSoft;
#endif
#ifdef CSDA_ADJ
uniform mat4 csdaAdj1, csdaAdj2, csdaAdj3;
vec3 csdaAdjust( mat4 m, vec3 c, float k ) { return mix( c, max( ( m * vec4( c, 1.0 ) ).rgb, 0.0 ), k ); }
#endif
#ifdef CSDA_HEIGHT
uniform sampler2D csdaH1, csdaH2;
uniform vec3 csdaHS, csdaHZ, csdaTMC, csdaTMB;
uniform vec4 csdaMTA; // Modell-Tönung je Layer an/aus (xyz), Stärke (w)
// Colorize (CS2 Modell-Tönung): Luma des Layers behalten, Farbton der Tönung; dunkle Tönung hellt nicht auf
vec3 csdaColorize( vec3 c, vec3 t, float k ) {
	vec3 n = normalize( max( t, vec3( 0.001 ) ) );
	float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	return clamp( mix( c, n * min( l / dot( n, vec3( 0.2126, 0.7152, 0.0722 ) ), 3.0 * l * max( t.r, max( t.g, t.b ) ) ), k ), 0.0, 1.0 );
}
#ifdef CSDA_LAYER3
uniform sampler2D csdaLayer3, csdaH3;
#endif
float csdaHW( vec2 ht, vec2 hs, vec2 hz, float bf, float bs ) {
	float h1 = hs.x + bs, height1 = ht.x * h1, h2 = hs.y + bs;
	float h2x = ht.y * ( hs.y - bs ) + mix( - hz.x * h1 - ( 1.0 - hz.y ) * h2 - bs, ( 1.0 - hz.x ) * h1 + hz.y * h2, bf );
	vec2 w = max( vec2( height1, h2x ) - ( max( height1, h2x ) - bs ), 0.0 );
	w.x += 0.001;
	return w.y / ( w.x + w.y );
}
#endif`
const MAP_FRAGMENT = `
#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	#ifdef CSDA_TINT
		#ifdef CSDA_VTINT
			vec3 csdaTintC = mix( vec3( 1.0 ), vColor.rgb, texture2D( csdaTintMask, vMapUv ).r ); // gebündelt: Tint je Vertex
		#else
			vec3 csdaTintC = mix( vec3( 1.0 ), diffuse, texture2D( csdaTintMask, vMapUv ).r );
		#endif
		diffuseColor.rgb = vec3( 1.0 );
		#ifdef CSDA_TINTA
			sampledDiffuseColor.rgb *= csdaTintC; // nur Layer 1 (simple_2way_blend)
		#endif
	#endif
	#ifdef CSDA_BLEND
		vec2 csdaUv2 = vMapUv * csdaUv.xy;
		vec4 csdaL2 = texture2D( csdaLayer2, csdaUv2 );
		#ifdef CSDA_HEIGHT
			vec4 csdaH1t = texture2D( csdaH1, vMapUv ), csdaH2t = texture2D( csdaH2, csdaUv2 );
			// Modell-Tönung (Material- bzw. Vertex-Farbe) färbt je Layer per Colorize statt zu multiplizieren
			#ifdef CSDA_VTINT
				vec3 csdaMT = vColor.rgb;
			#else
				vec3 csdaMT = diffuse;
			#endif
			float csdaMA = csdaMTA.w * ( 1.0 - min( csdaMT.r, min( csdaMT.g, csdaMT.b ) ) );
			diffuseColor.rgb = vec3( 1.0 );
			vec3 csdaTM = clamp( ( ( vec3( csdaH1t.g, csdaH2t.g, 0.5 ) - 0.5 ) * csdaTMC + 0.5 ) * csdaTMB, 0.0, 1.0 );
			#ifdef CSDA_ADJ
				sampledDiffuseColor.rgb = csdaAdjust( csdaAdj1, sampledDiffuseColor.rgb, csdaTM.x );
				csdaL2.rgb = csdaAdjust( csdaAdj2, csdaL2.rgb, csdaTM.y );
			#endif
			sampledDiffuseColor.rgb = csdaColorize( sampledDiffuseColor.rgb, csdaMT, csdaMA * csdaTM.x * csdaMTA.x );
			csdaL2.rgb = csdaColorize( csdaL2.rgb, csdaMT, csdaMA * csdaTM.y * csdaMTA.y );
			vec2 csdaHt = vec2( csdaH1t.r - csdaHZ.x, csdaH2t.r - csdaHZ.y );
			float csdaW = csdaHW( csdaHt, csdaHS.xy, csdaHZ.xy, vCsdaBlend.x, vCsdaBlend.w );
			sampledDiffuseColor = mix( sampledDiffuseColor, csdaL2, csdaW );
			#ifdef CSDA_LAYER3
				vec2 csdaUv3 = vMapUv * csdaUv.zw;
				vec4 csdaL3 = texture2D( csdaLayer3, csdaUv3 ), csdaH3t = texture2D( csdaH3, csdaUv3 );
				float csdaTM3 = clamp( ( ( csdaH3t.g - 0.5 ) * csdaTMC.z + 0.5 ) * csdaTMB.z, 0.0, 1.0 );
				#ifdef CSDA_ADJ
					csdaL3.rgb = csdaAdjust( csdaAdj3, csdaL3.rgb, csdaTM3 );
				#endif
				csdaL3.rgb = csdaColorize( csdaL3.rgb, csdaMT, csdaMA * csdaTM3 * csdaMTA.z );
				float csdaW3 = csdaHW( vec2( max( mix( csdaHt.x, csdaHt.y, csdaW ), csdaHt.y ), csdaH3t.r - csdaHZ.z ), vec2( max( csdaHS.x, csdaHS.y ), csdaHS.z ),
					vec2( max( csdaHZ.x, csdaHZ.y ), csdaHZ.z ), clamp( vCsdaBlend.y * 1.1 - 0.05, 0.0, 1.0 ), vCsdaBlend.w );
				sampledDiffuseColor = mix( sampledDiffuseColor, csdaL3, csdaW3 );
			#endif
		#else
			#ifdef CSDA_ADJ
				sampledDiffuseColor.rgb = csdaAdjust( csdaAdj1, sampledDiffuseColor.rgb, 1.0 );
				csdaL2.rgb = csdaAdjust( csdaAdj2, csdaL2.rgb, 1.0 );
			#endif
			#ifdef CSDA_BLENDMOD
				vec4 csdaBm = texture2D( csdaBlendMod, csdaUv2 );
				float csdaM = dot( csdaBm, csdaCh ), csdaS = max( csdaSoft.x + csdaSoft.y * csdaBm.r + csdaSoft.z * vCsdaBlend.w, 1e-3 );
				float csdaW = smoothstep( max( csdaM - csdaS, 0.0 ), min( csdaM + csdaS, 1.0 ), vCsdaBlend.x );
			#else
				float csdaW = vCsdaBlend.x;
			#endif
			sampledDiffuseColor = mix( sampledDiffuseColor, csdaL2, csdaW );
		#endif
	#endif
	#if defined( CSDA_TINT ) && ! defined( CSDA_TINTA )
		sampledDiffuseColor.rgb *= csdaTintC;
	#endif
	diffuseColor *= sampledDiffuseColor;
#endif`

type Tuple12 = [number, number, number, number, number, number, number, number, number, number, number, number]
/** Ausrichtungs-Maske (F_BLEND_BY_FACING_DIRECTION, CS2-Vertex-Shader): Malerei × smoothstep über die Welt-Normale */
const FACE_VERTEX = `
	{
		vec3 csdaN = normalize( mat3( modelMatrix ) * objectNormal );
		vCsdaBlend.x *= smoothstep( csdaFaceMM.x, csdaFaceMM.y, dot( csdaFaceD2, csdaN ) * 0.5 + 0.5 );
		vCsdaBlend.y *= smoothstep( csdaFaceMM.z, csdaFaceMM.w, dot( csdaFaceD3, csdaN ) * 0.5 + 0.5 );
	}`
/**
 * Textur-Animation (F_TEXTURE_ANIMATION): n Zellen im Quadrat-Raster, Zelle nach Zeit; UV geklemmt wie g_nTextureAddressMode 2 (Kaustik),
 * textureGrad gegen Mip-Sprünge an den Zellgrenzen
 */
function animFragment(n: number, fps: number) {
  const g = Math.ceil(Math.sqrt(n)).toFixed(1)
  return `{
	float csdaC = mod( floor( csdaTime * ${fps.toFixed(2)} ), ${n.toFixed(1)} );
	vec2 csdaCuv = ( clamp( vMapUv, 0.002, 0.998 ) + vec2( mod( csdaC, ${g} ), floor( csdaC / ${g} ) ) ) / ${g};
	diffuseColor *= textureGrad( map, csdaCuv, dFdx( vMapUv ) / ${g}, dFdy( vMapUv ) / ${g} );
}`
}
/**
 * shortcut: Metall der Map spiegelt in CS2 die Env-Cubemap; ohne sie wäre es außerhalb der Sonne schwarz. Ersatz wie bei den Agenten:
 * Radianz = Einstrahlung am Punkt (Lightmap/Sonde) × ENV_ALBEDO / π (Umgebung mit mittlerer Albedo, gleiche wie der Dielektrika-Ersatz in
 * lighting.ts), gewichtet mit der Metallizität. Nuke-Gitterrampen mit 1: weiß statt mittelgrau
 */
const METAL_ENV = `radiance += metalnessFactor * irradiance * ${(ENV_ALBEDO / Math.PI).toFixed(5)};\n#include <lights_fragment_end>`

// Native CS2-Normalen (KTX2, main/assets3d/vtex.ts): RG = Hemi-Oktaeder, wie VRF dekodiert (gemessen: exakt gleich dem VRF-PNG)
const NORMAL_MAP_LINE = 'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;'
const HEMI_OCT = `vec2 csdaE = texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0;
	vec2 csdaT = vec2( csdaE.x + csdaE.y, csdaE.x - csdaE.y ) * 0.5;
	vec3 mapN = normalize( vec3( csdaT, 1.0 - abs( csdaT.x ) - abs( csdaT.y ) ) );`
if (!THREE.ShaderChunk.normal_fragment_maps.includes(NORMAL_MAP_LINE)) throw new Error('three normal_fragment_maps changed: CS2 normal decode does not apply')
// Lightmap- und Sonden-Meshes in einem Bündel: Sonden-Vertices tragen uv1 = −1 → keine Lightmap
const LM_LINE = 'irradiance += lightMapIrradiance;'
if (!THREE.ShaderChunk.lights_fragment_maps.includes(LM_LINE)) throw new Error('three lights_fragment_maps changed: lightmap/probe bundling does not apply')
const LM_MIX = THREE.ShaderChunk.lights_fragment_maps.replace(LM_LINE, 'irradiance += lightMapIrradiance * step( 0.0, vLightMapUv.x );')

// Wasser/Glas (CSDAWater): drei scrollende Ebenen der Wellen-Normalen in Weltkoordinaten (m), Wasser waagrecht (three-y oben)
const WAVES = `
	{
		vec2 csdaP = ( cameraPosition + ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz ).xz, csdaT = vec2( csdaTime );
		vec2 csdaW = texture2D( csdaWaves, csdaP * 0.29 + csdaT * vec2( 0.013, 0.009 ) ).xy + texture2D( csdaWaves, csdaP * 0.13 + csdaT * vec2( - 0.011, 0.006 ) ).xy
			+ texture2D( csdaWaves, csdaP * 0.61 + csdaT * vec2( 0.004, - 0.017 ) ).xy - 1.5;
		normal = normalize( ( viewMatrix * vec4( csdaW.x * csdaWat.w, 1.0, csdaW.y * csdaWat.w, 0.0 ) ).xyz );
	}`
// Spiegelung F·Himmel + Körper (Wasser-Nebel bzw. Glas-Tönung, mit Map-Licht) + Sonnen-Glanz; Alpha = 1 − Durchlass; Spiegel: opak
const WATER_OUT = `
	vec3 csdaV = normalize( vViewPosition );
	float csdaF = csdaWat.y + ( 1.0 - csdaWat.y ) * pow( 1.0 - clamp( dot( normal, csdaV ), 0.0, 1.0 ), csdaWat.x );
	vec3 csdaR = inverseTransformDirection( reflect( - csdaV, normal ), viewMatrix );
	csdaR.y = abs( csdaR.y ); // Wellen kippen die Spiegelung sonst unter den Horizont
	float csdaOut = 1.0; // draußen: Sonnen-Sichtbarkeit der Umgebung (Lightmap-Mip 4 ≈ 16 Texel weich bzw. Sonde); innen ≈ 0 → kein Himmel (Nuke-Glasboden)
	#ifdef CSDA_PROBE
		csdaOut = vCsdaProbe.a;
	#endif
	#if defined( USE_LIGHTMAP ) && defined( CSDA_SUNMASK )
		if ( vLightMapUv.x >= 0.0 ) csdaOut = texture2D( lightMap, vLightMapUv, 4.0 ).a;
	#endif
	vec3 csdaSkyC = mix( reflectedLight.indirectDiffuse / max( diffuseColor.rgb, vec3( 1e-3 ) ) * csdaEnv.rgb,
		textureLod( csdaSky, equirectUv( csdaSkyRot * csdaR ), 0.0 ).rgb * csdaSkyInt, smoothstep( 0.0, csdaEnv.a, csdaR.y ) * smoothstep( 0.02, 0.4, csdaOut ) );
	#if defined( CSDA_MIRROR )
		#ifdef OPAQUE
		diffuseColor.a = 1.0;
		#endif
		gl_FragColor = vec4( mix( outgoingLight, csdaSkyC, csdaF ), diffuseColor.a );
	#else
		#ifdef CSDA_GLASS
			float csdaA = 1.0 - dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) * ( 1.0 - csdaF );
		#else
			float csdaA0 = 1.0 - exp( - ${WATER_DEPTH_M.toFixed(3)} / ( max( abs( dot( normalize( nonPerturbedNormal ), csdaV ) ), 0.05 ) * csdaWat.z ) );
			float csdaA = 1.0 - ( 1.0 - csdaF ) * ( 1.0 - csdaA0 );
		#endif
		gl_FragColor = vec4( ( csdaF * csdaSkyC + ( csdaA - csdaF ) * totalDiffuse + reflectedLight.directSpecular ) / max( csdaA, 1e-3 ), csdaA );
	#endif`

/**
 * Himmels-Effekte der 3D-Skybox (CSDAFx, shared/assets3d.ts): Basis mit UV-Skala/-Schwenk, zweite Textur (F_TWOTEXTURE) multipliziert,
 * Masken 1..3 (R) auf die Deckkraft, Farbe · boost, Fresnel und Abstand wie csgo_effects. shortcut: ohne F_DEPTH_FEATHER (weiche Kante an
 * Geometrie) und ohne Nebel auf Effekten mit Nebel (CS2 blendet additive über die Deckkraft aus); erst bei Bedarf mit Tiefen-Textur
 */
const FX_PARS = `
uniform float csdaTime;
uniform vec4 csdaFxUv;
uniform vec2 csdaFxK;
#ifdef CSDA_FX2
uniform sampler2D csdaColor2;
uniform vec2 csdaFxUv2;
#endif
#ifdef CSDA_FXM1
uniform sampler2D csdaMask1;
uniform vec4 csdaFxM1;
#endif
#ifdef CSDA_FXM2
uniform sampler2D csdaMask2;
uniform vec4 csdaFxM2;
#endif
#ifdef CSDA_FXM3
uniform sampler2D csdaMask3;
uniform vec4 csdaFxM3;
#endif
#ifdef CSDA_FXF
varying vec3 vCsdaFxN, vCsdaFxP;
uniform vec4 csdaFxFr, csdaFxFd;
#endif`
const FX_FRAGMENT = `
#ifdef USE_MAP
	vec2 csdaU = vMapUv * csdaFxUv.xy + csdaFxUv.zw * csdaTime;
	vec4 csdaC = texture2D( map, csdaU );
	#ifdef CSDA_FX2
		csdaC *= texture2D( csdaColor2, vMapUv * csdaFxUv2 );
	#endif
	#ifdef CSDA_FXM1
		csdaC.a *= texture2D( csdaMask1, csdaU * csdaFxM1.xy + csdaFxM1.zw * csdaTime ).r;
	#endif
	#ifdef CSDA_FXM2
		csdaC.a *= texture2D( csdaMask2, csdaU * csdaFxM2.xy + csdaFxM2.zw * csdaTime ).r;
	#endif
	#ifdef CSDA_FXM3
		csdaC.a *= texture2D( csdaMask3, csdaU * csdaFxM3.xy + csdaFxM3.zw * csdaTime ).r;
	#endif
	diffuseColor *= csdaC;
#endif
	diffuseColor *= vec4( vec3( csdaFxK.x ), csdaFxK.y );
#ifdef CSDA_FXF
	diffuseColor.a *= mix( csdaFxFr.z, csdaFxFr.w, clamp( pow( abs( dot( normalize( vCsdaFxN ), normalize( vCsdaFxP ) ) ), csdaFxFr.x ) * csdaFxFr.y, 0.0, 1.0 ) );
	if ( csdaFxFd.x > 0.0 ) diffuseColor.a *= pow( mix( csdaFxFd.z, csdaFxFd.w, clamp( length( vCsdaFxP ) / csdaFxFd.x, 0.0, 1.0 ) ), csdaFxFd.y );
#endif`

/** Spiegel-Kontext: Himmel (equirect, linear), Drehung wie der Hintergrund, Helligkeit, Uhr der Wellen */
/** amb = Einstrahlung des Himmels auf eine waagrechte Fläche (nur HDR-Himmel), Licht der 3D-Skybox statt Hemisphere */
interface Sky { tex: THREE.Texture; rot: THREE.Matrix3; intensity: number; time: { value: number }; amb: { sky: THREE.Color; ground: THREE.Color } | null }

interface Feat {
  /** Layer 2 (+ Blend-Modulation, Layer 3, Höhen 1..3) mit den Blend-Parametern */
  blend?: THREE.Texture | null; blendMod?: THREE.Texture | null; layer3?: THREE.Texture | null; heights?: (THREE.Texture | null)[]; bl?: CSDABlend
  tint?: THREE.Texture | null
  /** Overlay Mod2x (F_BLEND_MODE 3) mit der Modell-Tönung, anim = [Zellen, fps] einer Textur-Animation */
  mod2x?: THREE.Color; anim?: [number, number]; time?: { value: number }
  sunMask?: boolean; probe?: number; fresnel?: number; hemiOct?: boolean
  /** Wasser (waves = Wellen-Normalen), Glas oder opaker Spiegel */
  water?: CSDAWater & { mode: 'water' | 'glass' | 'mirror'; sky: Sky }; waves?: THREE.Texture | null
  /** Tint-Farbe kommt aus dem Vertex-Attribut color (gebündelte Meshes) */
  vtint?: boolean
  /** Bündel aus Lightmap- und Sonden-Meshes (Sonden-Vertices: uv1 = −1, Lightmap-Vertices: Sonde 0) */
  mix?: boolean
  /** 3D-Skybox: Maßstab (eigene Tiefe), skyFog = Nebel-Abstände ÷ skyFog (eigener Skybox-Nebel), skyAmb = Himmelslicht statt Hemisphere (ohne Lightmap/Sonden) */
  sky?: number; skyFog?: number; skyAmb?: Sky['amb']
  /** Himmels-Effekt (Wolken, Sonnenscheibe, Dunst) mit Masken 1..3 und zweiter Textur; Uhr = time */
  fx?: CSDAFx; masks?: (THREE.Texture | null)[]; color2?: THREE.Texture | null
}

/** Map-Materialien (MeshStandardMaterial) und unbeleuchtete der 3D-Skybox (MeshBasicMaterial: nur sky und fx greifen) */
function patchMaterial(mat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial, f: Feat) {
  const height = f.bl?.kind === 'height' && !!f.heights?.[0] && !!f.heights?.[1], l3 = height && !!f.layer3 && !!f.heights?.[2], adj = !!f.bl?.adj?.some(Boolean)
  const face = height && !!(f.bl?.face2 || (l3 && f.bl?.face3)), tintA = !!f.tint && !!f.bl?.tintA
  const fxf = !!(f.fx?.fresnel || f.fx?.fade)
  const key = ['csda', f.blend ? 'b' : '', f.blendMod ? 'm' : '', height ? 'H' : '', l3 ? '3' : '', adj ? 'j' : '', face ? 'o' : '', tintA ? 'A' : '', f.tint ? 't' : '',
    f.mod2x ? 'M' : '', f.anim ? 'a' : '', f.sunMask ? 's' : '', f.probe ? 'p' : '', f.fresnel ? 'f' : '', f.hemiOct ? 'h' : '',
    f.water ? { water: 'w', glass: 'g', mirror: 'r' }[f.water.mode] : '', f.waves ? 'n' : '', f.vtint ? 'v' : '', f.sky ? 'k' : '', f.skyFog ? `K${f.skyFog}` : '', f.mix ? 'x' : '',
    f.fx ? `F${f.masks?.map(m => +!!m).join('') ?? ''}${f.color2 ? '2' : ''}${fxf ? 'r' : ''}` : ''].join('')
  mat.customProgramCacheKey = () => key
  mat.onBeforeCompile = sh => {
    // Kopie: sh.defines ist material.defines; Mutieren ändert den Programm-Schlüssel nach dem Kompilieren → jedes Map-Material
    // wurde zweimal übersetzt (compileAsync + erstes Bild, Dust2: 50 Programme, 455 ms Block). customProgramCacheKey trennt die Varianten.
    const D = (sh.defines = { ...sh.defines }) as Record<string, string>
    let vs = sh.vertexShader, fs = sh.fragmentShader
    if (f.blend) {
      const b: CSDABlend = f.bl ?? { kind: 'mod', uv: [1, 1, 1, 1] }
      const mat4 = (m?: number[] | null) => m ? new THREE.Matrix4().set(...m as Tuple12, 0, 0, 0, 1) : new THREE.Matrix4()
      D.CSDA_BLEND = ''
      Object.assign(sh.uniforms, { csdaLayer2: { value: f.blend }, csdaUv: { value: new THREE.Vector4(...b.uv) } })
      if (f.blendMod && !height) {
        D.CSDA_BLENDMOD = ''
        Object.assign(sh.uniforms, { csdaBlendMod: { value: f.blendMod }, csdaCh: { value: new THREE.Vector4(...b.ch ?? [0, 1, 0, 0]) }, csdaSoft: { value: new THREE.Vector3(...b.soft ?? [0.1, 0, 0]) } })
      }
      if (adj) { D.CSDA_ADJ = ''; Object.assign(sh.uniforms, { csdaAdj1: { value: mat4(b.adj![0]) }, csdaAdj2: { value: mat4(b.adj![1]) }, csdaAdj3: { value: mat4(b.adj![2]) } }) }
      if (height) {
        const h = b.h!
        D.CSDA_HEIGHT = ''
        const tm = b.tm ?? [1, 1, 1, 1, 1, 1], mt = b.mt ?? [1, 1, 1]
        Object.assign(sh.uniforms, {
          csdaH1: { value: f.heights![0] }, csdaH2: { value: f.heights![1] }, csdaHS: { value: new THREE.Vector3(h[0], h[2], h[4]) }, csdaHZ: { value: new THREE.Vector3(h[1], h[3], h[5]) },
          csdaTMC: { value: new THREE.Vector3(tm[0], tm[2], tm[4]) }, csdaTMB: { value: new THREE.Vector3(tm[1], tm[3], tm[5]) }, csdaMTA: { value: new THREE.Vector4(mt[0], mt[1], mt[2], b.mta ?? 1) },
        })
        if (f.vtint) { D.CSDA_VTINT = ''; fs = fs.replace('#include <color_fragment>', '') } // Vertex-Tönung nur per Colorize
        if (l3) { D.CSDA_LAYER3 = ''; Object.assign(sh.uniforms, { csdaLayer3: { value: f.layer3 }, csdaH3: { value: f.heights![2] } }) }
      }
      vs = vs.replace('#include <common>', '#include <common>\nattribute vec4 csdaBlend;\nvarying vec4 vCsdaBlend;' + (face ? '\nuniform vec4 csdaFaceMM;\nuniform vec3 csdaFaceD2, csdaFaceD3;' : ''))
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n\tvCsdaBlend = csdaBlend;' + (face ? FACE_VERTEX : ''))
      if (face) {
        const off: CSDABlend['face2'] = [-2, -1, 0, 1, 0] // aus: smoothstep(−2, −1, ≥ 0) = 1
        const f2 = b.face2 ?? off, f3 = (l3 && b.face3) || off
        Object.assign(sh.uniforms, { csdaFaceMM: { value: new THREE.Vector4(f2[0], f2[1], f3[0], f3[1]) }, csdaFaceD2: { value: new THREE.Vector3(f2[2], f2[3], f2[4]) }, csdaFaceD3: { value: new THREE.Vector3(f3[2], f3[3], f3[4]) } })
      }
      fs = fs.replace('#include <common>', '#include <common>\n' + BLEND_PARS)
    }
    if (tintA) D.CSDA_TINTA = ''
    if (f.mod2x) {
      // Mod2x wie CS2 F_BLEND_MODE 3: Farbe in Gamma × Modell-Tönung, Ziel × 2 × Farbe (0,5 = neutral), unbeleuchtet; Alpha blendet zur Mitte.
      // Tönung auf die Gamma-Farbe (Nuke-Bodenpfeile: weiß × 0,18 → dunkelgrau wie CS2; auf die lineare Farbe wären sie fast unsichtbar)
      sh.uniforms.csdaTint2x = { value: f.mod2x }
      fs = fs.replace('#include <common>', '#include <common>\nuniform vec3 csdaTint2x;')
        .replace('#include <opaque_fragment>', 'gl_FragColor = vec4( mix( vec3( 0.5 ), sRGBTransferOETF( vec4( clamp( diffuseColor.rgb, 0.0, 1.0 ), 1.0 ) ).rgb * csdaTint2x, diffuseColor.a ), 1.0 );')
      if (f.anim) {
        sh.uniforms.csdaTime = f.time ?? { value: 0 }
        fs = fs.replace('#include <common>', '#include <common>\nuniform float csdaTime;').replace('#include <map_fragment>', animFragment(f.anim[0], f.anim[1]))
      }
    }
    if (f.tint) {
      D.CSDA_TINT = ''
      sh.uniforms.csdaTintMask = { value: f.tint }
      fs = fs.replace('#include <common>', '#include <common>\nuniform sampler2D csdaTintMask;')
      if (f.vtint) { D.CSDA_VTINT = ''; fs = fs.replace('#include <color_fragment>', '') } // vColor nur über die Maske, nicht noch einmal multiplizieren
    }
    if (f.blend || f.tint) fs = fs.replace('#include <map_fragment>', MAP_FRAGMENT)
    if (f.fresnel) {
      // CS2 csgo_effects: Karten bei streifendem Blick ausblenden
      sh.uniforms.csdaFresnel = { value: f.fresnel }
      fs = fs.replace('#include <common>', '#include <common>\nuniform float csdaFresnel;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n\tdiffuseColor.a *= pow( clamp( abs( dot( normalize( nonPerturbedNormal ), normalize( vViewPosition ) ) ), 0.0, 1.0 ), csdaFresnel );')
    }
    if (f.water) {
      const w = f.water, s = w.sky
      if (w.mode === 'glass') D.CSDA_GLASS = ''
      if (w.mode === 'mirror') D.CSDA_MIRROR = ''
      Object.assign(sh.uniforms, {
        csdaSky: { value: s.tex }, csdaSkyRot: { value: s.rot }, csdaSkyInt: { value: s.intensity }, csdaTime: s.time, csdaWaves: { value: f.waves },
        csdaWat: { value: new THREE.Vector4(w.fresnelExp, w.reflectance, w.fogEndM || 1, 0.5 * (w.normalScale ?? 1)) }, csdaEnv: { value: new THREE.Vector4(...new THREE.Color(...(w.mode === 'water' ? w.fogColorLinear ?? w.colorLinear : [1, 1, 1] as const)).multiplyScalar(ENV_ALBEDO).toArray(), ENV_HORIZON[w.mode]) },
      })
      fs = fs.replace('#include <common>', '#include <common>\nuniform sampler2D csdaSky;\nuniform mat3 csdaSkyRot;\nuniform float csdaSkyInt;\nuniform vec4 csdaWat;\nuniform vec4 csdaEnv;\nuniform sampler2D csdaWaves;\nuniform float csdaTime;')
        .replace('#include <opaque_fragment>', WATER_OUT)
      if (f.waves) fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>' + WAVES)
    }
    if (f.probe) {
      // gebackene CS2-Lichtsonde pro Vertex: rgb = sqrt(irr/4), a = Sonnen-Sichtbarkeit
      D.CSDA_PROBE = ''; D.CSDA_SUNMASK = ''; D.CSDA_NOHEMI = ''
      sh.uniforms.csdaProbeScale = { value: f.probe }
      vs = vs.replace('#include <common>', '#include <common>\nattribute vec4 csdaProbe;\nvarying vec4 vCsdaProbe;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCsdaProbe = csdaProbe;')
      fs = fs.replace('#include <common>', '#include <common>\nvarying vec4 vCsdaProbe;\nuniform float csdaProbeScale;')
        .replace('#include <lights_fragment_begin>', (f.mix ? 'float csdaSun = vLightMapUv.x < 0.0 ? vCsdaProbe.a : texture2D( lightMap, vLightMapUv ).a;\n' : 'float csdaSun = vCsdaProbe.a;\n') + LIGHTS_BEGIN)
      if (f.mix) fs = fs.replace('#include <lights_fragment_maps>', LM_MIX)
    } else if (f.sunMask) {
      D.CSDA_SUNMASK = ''; D.CSDA_NOHEMI = ''
      fs = fs.replace('#include <lights_fragment_begin>', 'float csdaSun = texture2D( lightMap, vLightMapUv ).a;\n' + LIGHTS_BEGIN)
    } else fs = fs.replace('#include <lights_fragment_begin>', LIGHTS_BEGIN)
    if (!f.water && !f.mod2x) fs = fs.replace('#include <lights_fragment_end>', METAL_ENV)
    if (f.hemiOct) fs = fs.replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace(NORMAL_MAP_LINE, HEMI_OCT)) // nach fresnel (hängt sich an das include)
    if (f.fx) {
      const x = f.fx, v4 = (a?: number[], d = [0, 1, 0, 1]) => new THREE.Vector4(...(a ?? d))
      Object.assign(sh.uniforms, { csdaTime: f.time ?? { value: 0 }, csdaFxUv: { value: v4(x.uv) }, csdaFxK: { value: new THREE.Vector2(x.boost, x.opacity) } })
      if (f.color2) { D.CSDA_FX2 = ''; Object.assign(sh.uniforms, { csdaColor2: { value: f.color2 }, csdaFxUv2: { value: new THREE.Vector2(...(x.uv2 ?? [1, 1])) } }) }
      f.masks?.forEach((m, i) => { if (m && x.masks?.[i]) { D[`CSDA_FXM${i + 1}`] = ''; sh.uniforms[`csdaMask${i + 1}`] = { value: m }; sh.uniforms[`csdaFxM${i + 1}`] = { value: v4(x.masks[i]) } } })
      if (fxf) {
        // Normale und Position im Kamera-Raum (echte Abstände wie der Nebel) für Fresnel/Abstand
        D.CSDA_FXF = ''; Object.assign(sh.uniforms, { csdaFxFr: { value: v4(x.fresnel, [0.001, 1, 0, 1]) }, csdaFxFd: { value: v4(x.fade) } })
        vs = vs.replace('#include <common>', '#include <common>\nvarying vec3 vCsdaFxN, vCsdaFxP;')
          .replace('#include <fog_vertex>', '#include <fog_vertex>\n\tvCsdaFxN = normalize( normalMatrix * normal );\n\tvCsdaFxP = mvPosition.xyz;')
      }
      fs = fs.replace('#include <common>', '#include <common>\n' + FX_PARS).replace('#include <map_fragment>', FX_FRAGMENT)
    }
    if (f.sky) {
      if (f.skyAmb) {
        D.CSDA_SKYAMB = ''; D.CSDA_NOHEMI = ''; sh.uniforms.csdaSkyAmb = { value: f.skyAmb.sky }; sh.uniforms.csdaGroundAmb = { value: f.skyAmb.ground }
        fs = fs.replace('#include <common>', '#include <common>\nuniform vec3 csdaSkyAmb;\nuniform vec3 csdaGroundAmb;')
      }
      // echte Größe liegt hinter far: eigene lineare Tiefe (Tiefenpuffer wird nach der Skybox geleert)
      vs = vs.replace('#include <project_vertex>', `#include <project_vertex>\n\tgl_Position.z = ( 2.0 * min( - mvPosition.z * ${(1 / SKY_FAR_M).toExponential(3)}, 1.0 ) - 1.0 ) * gl_Position.w;`)
      // Nebel wie CS2 laut Ladebildern: Skybox mit eigenen Nebel-Entities in Skybox-Abständen (Inferno-Berg, Nuke), sonst Map-Nebel in echten
      // Abständen (Dust2-Dunst auf den Hügeln: oberes Bildviertel ΔE 4,4 → 2,1). shortcut: eigene Nebel-Werte = die der Map (bei allen 7 Maps Kopien)
      if (f.skyFog) vs = vs.replace('#include <fog_vertex>', `mvPosition.xyz /= ${f.skyFog.toFixed(3)};\n#include <fog_vertex>\n\tmvPosition.xyz *= ${f.skyFog.toFixed(3)};`)
    }
    sh.vertexShader = vs; sh.fragmentShader = fs
  }
}

export interface LoadedMap {
  root: THREE.Object3D
  /** sichtbare Map-Meshes (Raycast, Schatten-Empfänger), ohne 3D-Skybox */
  meshes: THREE.Mesh[]
  /** undurchsichtige Meshes für den Raycast (ohne Decals/Glas/Effekte/Skybox) */
  solid: THREE.Mesh[]
  lightmap: THREE.Texture
  sky: THREE.Texture | null
  /** Texturen, die nur in Shader-Uniforms hängen (Layer 2, Blend-Maske, Tint, Wellen) → beim dispose mit freigeben */
  extra: Set<THREE.Texture>
}

async function bitmapTexture(url: string, srgb: boolean): Promise<THREE.Texture> {
  // Lightmap: RGB unter Alpha unverändert lassen (kein Premultiply), Orientierung wie Datei
  const bmp = await new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).loadAsync(url)
  const t = new THREE.Texture(bmp as unknown as HTMLImageElement)
  t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.needsUpdate = true
  return t
}

/**
 * Einstrahlung des equirect-HDR-Himmels (obere Hälfte, cos-gewichtet, Zeile 0 = Zenit) auf eine waagrechte Fläche × Helligkeit, linear,
 * × π wie Lightmap und Sonne (CS2 rechnet diffus ohne 1/π). Nuke-Kühltürme/Dust2-Hügel kommen so am nächsten an die Ladebilder (C/runs/k_*).
 */
function skyIrradiance(t: THREE.DataTexture, k: number): THREE.Color {
  const { width: W, height: H, data } = t.image as { width: number; height: number; data: Uint16Array | Float32Array }
  const f = data instanceof Uint16Array ? THREE.DataUtils.fromHalfFloat : (v: number) => v, e = [0, 0, 0], sx = 4, sy = 2 // jedes 4. × 2. Pixel reicht
  for (let y = 0; y < H / 2; y += sy) {
    const th = (y + 0.5) / H * Math.PI, w = Math.cos(th) * Math.sin(th) * (sy * Math.PI / H) * (sx * 2 * Math.PI / W)
    for (let x = 0; x < W; x += sx) for (let c = 0, i = (y * W + x) * 4; c < 3; c++) e[c] += f(data[i + c]) * w
  }
  return new THREE.Color(e[0], e[1], e[2]).multiplyScalar(k * Math.PI)
}

/** Licht der 3D-Skybox ohne Lightmap: Himmel von oben, von unten Boden-Rückstrahlung (Albedo GROUND_ALBEDO) aus Himmel + Sonne */
function skyLight(t: THREE.DataTexture, st: MapSettings): NonNullable<Sky['amb']> {
  const sky = skyIrradiance(t, st.sky.backgroundIntensity), up = Math.max(0, new THREE.Vector3(...st.sun.toSunGltf).normalize().y)
  const sun = new THREE.Color().setRGB(...st.sun.colorSRGB, THREE.SRGBColorSpace).multiplyScalar(st.sun.threeIntensity * up)
  return { sky, ground: sun.add(sky).multiplyScalar(GROUND_ALBEDO) }
}

/** .gltf mit Texturen aus dem gestreamten tex.pack daneben (Protokoll-Handler), jede Textur sofort hochgeladen (texstream.ts) */
function loadGltf(url: string, ktx2: KTX2Loader, renderer: THREE.WebGLRenderer, anisotropy: number, onPct?: (f: number) => void): Promise<GLTF> {
  const pack = new TexPack(url.slice(0, url.lastIndexOf('/') + 1) + 'tex.pack')
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2)
  for (const p of packPlugins(pack, ktx2, renderer, anisotropy)) loader.register(p)
  return loader.loadAsync(url, e => e.total && onPct?.(e.loaded / e.total))
}

/** lädt GLB (native Texturen per ktx2) + Lightmap + Himmel (+ 3D-Skybox) und patcht alle Materialien. onPct 0..1 (GLB-Download). */
export async function loadMap(m: MapAssetManifest, ktx2: KTX2Loader, renderer: THREE.WebGLRenderer, anisotropy: number, onPct: (f: number) => void): Promise<LoadedMap> {
  const [gltf, lm, sky, sbGltf, sbLm] = await Promise.all([
    loadGltf(m.glb, ktx2, renderer, anisotropy, onPct),
    bitmapTexture(m.lightmap, true).then(t => {
      t.channel = 1; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4
      uploadNow(renderer, t) // 64 MB RGBA: nicht bis zum Ende halten
      return t
    }),
    // HDR: linear ohne Clamp (Spiegelungen, Tonemapping); WebP: sRGB mit Clamp, gleiche Skala (backgroundIntensity gilt für beide)
    m.skyHdr ? new HDRLoader().loadAsync(m.skyHdr) as Promise<THREE.Texture>
      : m.sky ? new THREE.TextureLoader().loadAsync(m.sky).then(t => { t.colorSpace = THREE.SRGBColorSpace; return t }) : Promise.resolve(null),
    // optional: ohne 3D-Skybox nur Himmel
    m.skybox ? loadGltf(m.skybox.glb, ktx2, renderer, anisotropy).catch(e => { console.warn('3d skybox', e); return null }) : null,
    m.skybox?.lightmap ? bitmapTexture(m.skybox.lightmap, true).then(t => { t.channel = 1; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t }, () => null) : null,
  ])
  if (sky) sky.mapping = THREE.EquirectangularReflectionMapping

  const extra = new Set<THREE.Texture>()
  const fallback = sky ? null : new THREE.DataTexture(new Uint8Array([156, 195, 230, 255]), 1, 1) // Hintergrundfarbe der Engine
  if (fallback) { fallback.colorSpace = THREE.SRGBColorSpace; fallback.needsUpdate = true; extra.add(fallback) }
  const env: Sky = { tex: sky ?? fallback!, rot: new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(-skyYaw(m.settings))), intensity: m.settings.sky.backgroundIntensity, time: { value: 0 },
    amb: (sky as THREE.DataTexture | null)?.isDataTexture ? skyLight(sky as THREE.DataTexture, m.settings) : null }

  const lmIntensity = m.settings.lightmap.threeIntensity
  const map = await prepare(gltf, { lm, lmIntensity, anisotropy, extra, env })
  if (sbGltf) {
    // Map-Position = (Skybox-Position − origin) · scale; gezeichnet vor der Map, danach Tiefe leeren (wie CS2: Skybox-Pass zuerst)
    const sb = m.skybox!, root = sbGltf.scene, o = worldToGltf(sb.origin[0], sb.origin[1], sb.origin[2], new THREE.Vector3())
    root.scale.setScalar(sb.scale); root.position.copy(o).multiplyScalar(-sb.scale); root.updateMatrixWorld(true)
    if (sbLm) extra.add(sbLm)
    const s = await prepare(sbGltf, { lm: sbLm, lmIntensity, anisotropy, extra, env, sky: sb.scale, skyFog: sb.ownFog && sb.scale !== 1 ? sb.scale : undefined })
    const sbox = new THREE.Group(); sbox.name = 'csda-skybox'
    const see = new Set(s.meshes.map(x => x.material as THREE.Material).filter(x => x.transparent))
    for (const mat of see) { mat.transparent = false; mat.depthWrite = false; if (mat.blending === THREE.NormalBlending) mat.blending = THREE.CustomBlending }
    for (const x of s.meshes) {
      // hinter far: nicht vom Frustum aussondern lassen; Durchsichtiges im opaken Durchgang (vor dem Leeren), sonst läge es über der Map
      x.frustumCulled = false; x.matrix.copy(x.matrixWorld) // Weltmatrix samt Skybox-Maßstab übernehmen, sbox ist neutral
      x.renderOrder = see.has(x.material as THREE.Material) ? SKY_ORDER + 0.5 : SKY_ORDER
      sbox.add(x)
    }
    const clear = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()) // leer: zeichnet nichts, nur der Haken
    clear.frustumCulled = false; clear.renderOrder = SKY_ORDER + 1
    clear.onBeforeRender = r => r.clearDepth()
    sbox.add(clear)
    gltf.scene.add(sbox)
  }
  gltf.scene.updateMatrixWorld(true)
  return { root: gltf.scene, meshes: map.meshes, solid: map.solid, lightmap: lm, sky, extra }
}

interface Ctx { lm: THREE.Texture | null; lmIntensity: number; anisotropy: number; extra: Set<THREE.Texture>; env: Sky; sky?: number; skyFog?: number; flat?: THREE.Texture }

/** 1×1 Ersatz für eine weggefallene Höhen-Textur (R Höhe 0,5, G Tint-Maske 1), einmal je Map (in extra → dispose) */
function flatHeight(c: Ctx) {
  if (!c.flat) { c.flat = new THREE.DataTexture(new Uint8Array([128, 255, 0, 255]), 1, 1); c.flat.needsUpdate = true; c.extra.add(c.flat) }
  return c.flat
}

/** Materialien einer Map-/Skybox-.gltf patchen und opake Meshes bündeln; Rückgabe: sichtbare und undurchsichtige Meshes */
async function prepare(gltf: GLTF, c: Ctx): Promise<{ meshes: THREE.Mesh[]; solid: THREE.Mesh[] }> {
  const parser = gltf.parser, json = parser.json
  const texOf = async (def: { index: number } | undefined, srgb: boolean): Promise<THREE.Texture | null> => {
    if (!def) return null
    const t: THREE.Texture = await parser.getDependency('texture', def.index)
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    c.extra.add(t)
    return t
  }
  // exportiertes light_environment raus: eigene Sonne im Szenenraum (Lichtanzahl bleibt fest)
  const drop: THREE.Object3D[] = []
  const meshes: THREE.Mesh[] = [], solid: THREE.Mesh[] = []
  gltf.scene.traverse(o => { if ((o as THREE.Light).isLight) drop.push(o); else if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh) })
  for (const o of drop) o.removeFromParent()
  // Skybox-Lightmap nicht ladbar: Lightmap-UVs weg, sonst Bündel mit Lightmap-Code ohne Lightmap (ungültige Shader) → Himmelslicht
  if (!c.lm) for (const m of meshes) m.geometry.deleteAttribute('uv1')
  gltf.scene.updateMatrixWorld(true)

  const done = new Map<string, THREE.Material>(), feats = new Map<THREE.Material, Feat>(), jobs: Promise<unknown>[] = []
  const tick = () => { c.env.time.value = performance.now() / 1000 }
  const content = new Map<number, string>() // glTF-Material → Inhalt ohne Name/Grundfarbe (Grundfarbe wandert beim Bündeln in die Vertices)
  const cands: { mesh: THREE.Mesh; key: string }[] = []
  for (const mesh of meshes) {
    const g = mesh.geometry
    if (g.attributes._blend) { g.setAttribute('csdaBlend', g.attributes._blend); g.deleteAttribute('_blend') }
    if (g.attributes._probe) { g.setAttribute('csdaProbe', g.attributes._probe); g.deleteAttribute('_probe') }
    mesh.matrixAutoUpdate = false
    const src = mesh.material as THREE.MeshStandardMaterial
    const mi = parser.associations.get(src)?.materials
    const ext = (mi !== undefined ? json.materials[mi]?.extensions?.[CSDA] : null) ?? {}
    const flags: string[] = ext.flags ?? []
    const water = flags.includes('water'), glass = flags.includes('glass')
    const anim = flags.find(s => s.startsWith('anim:'))?.split(':').slice(1).map(Number) as [number, number] | undefined
    if (water || anim || ext.fx) mesh.onBeforeRender = tick // jedes Wasser-/Animations-/Effekt-Mesh: ein ausgesondertes hielte sonst die Uhr an
    const transparent = src.transparent || water || flags.includes('overlay') || flags.includes('additive') || flags.includes('blend') || flags.includes('mod2x')
    // Material kann von mehreren Meshes geteilt sein; Varianten (Lightmap / Sonde / ohne) getrennt
    const variant = g.attributes.uv1 ? 'lm' : g.attributes.csdaProbe ? 'pr' : 'none'
    if (!transparent) {
      solid.push(mesh)
      if (src.isMeshStandardMaterial && mi !== undefined) {
        if (!content.has(mi)) { const { name: _n, pbrMetallicRoughness: { baseColorFactor: _f, ...pbr } = {} as any, ...rest } = json.materials[mi]; content.set(mi, JSON.stringify([pbr, rest])) }
        // Lightmap und Sonde in ein Bündel (mix), nur 'none' (ohne beides) bleibt getrennt
        cands.push({ mesh, key: content.get(mi) + (variant === 'none' ? variant : 'lp') + Object.keys(g.attributes).filter(a => a !== 'uv1' && a !== 'csdaProbe').sort().join() })
      }
    }
    const k = src.uuid + ':' + variant
    const known = done.get(k)
    if (known) { mesh.material = known; continue }
    const mat = ['lm', 'pr', 'none'].some(v => done.has(src.uuid + ':' + v)) ? src.clone() : src
    if (mat.map) mat.map.anisotropy = c.anisotropy
    const f: Feat = {}
    // Zusatztexturen hängen nur in der Extension (GLTFLoader lädt sie nicht vorab): parallel holen, nicht je Mesh warten (Dust2: 325 ms Leerlauf)
    const wait: Promise<unknown>[] = []
    if (ext.layer2Texture && g.attributes.csdaBlend) {
      // ohne ext.blend (Cache vor MAP_VERSION 5): Modulation G mit fester Weichheit
      f.bl = ext.blend ?? { kind: 'mod', uv: [1, 1, 1, 1], ch: [0, 1, 0, 0], soft: [ext.blendSoftness ?? 0.1, 0, 0] }
      wait.push(texOf(ext.layer2Texture, true).then(t => { f.blend = t }))
      if (ext.blendModTexture) wait.push(texOf(ext.blendModTexture, false).then(t => { f.blendMod = t }))
      if (ext.layer3Texture) wait.push(texOf(ext.layer3Texture, true).then(t => { f.layer3 = t }))
      // einfarbige Höhen-Texturen entfernt prune beim Bau → Ersatz Höhe 0,5 / Tint-Maske 1
      f.heights = [null, null, null].map(() => flatHeight(c))
      ;[ext.height1Texture, ext.height2Texture, ext.height3Texture].forEach((d, i) => { if (d) wait.push(texOf(d, false).then(t => { f.heights![i] = t })) })
    }
    if (ext.tintMaskTexture) wait.push(texOf(ext.tintMaskTexture, false).then(t => { f.tint = t }))
    // unbeleuchtete Materialien (MeshBasicMaterial: csgo_unlitgeneric, Effekte) ohne Lightmap/Sonde wie in CS2
    if (variant === 'lm' && c.lm && mat.isMeshStandardMaterial) { mat.lightMap = c.lm; mat.lightMapIntensity = c.lmIntensity; f.sunMask = true }
    else {
      mat.lightMap = null // Klon eines Lightmap-Materials: ohne uv1 läse es sonst Texel (0,0) als Zusatzlicht (Sonden-Props zu hell)
      if (variant === 'pr' && mat.isMeshStandardMaterial) f.probe = c.lmIntensity
    }
    const fr = flags.find(s => s.startsWith('fresnel:')); if (fr) f.fresnel = parseFloat(fr.slice(8))
    f.hemiOct = !!(mat.normalMap as THREE.CompressedTexture | null)?.isCompressedTexture
    if (c.sky) { f.sky = c.sky; f.skyFog = c.skyFog; if (!f.sunMask && !f.probe) f.skyAmb = c.env.amb } // Himmelslicht nur ohne gebackenes Licht der Skybox
    const mirror = !transparent && mat.isMeshStandardMaterial && !mat.roughnessMap && mat.roughness <= MIRROR_ROUGHNESS && mat.metalness === 0
    if (water || glass || mirror) {
      // fehlt ext.water (Vertrag shared/assets3d.ts): Exponent 5, Reflectance 0,025; Spiegel: Dielektrikum F0 0,04
      const w: CSDAWater = ext.water ?? (mirror ? { fresnelExp: 5, reflectance: 0.04, colorLinear: [1, 1, 1] } : { fresnelExp: 5, reflectance: 0.025, colorLinear: [1, 1, 1] })
      f.water = { ...w, mode: water ? 'water' : glass ? 'glass' : 'mirror', sky: c.env }
      if (water) {
        // Körperfarbe = Wasser-Nebel, vom Map-Licht beleuchtet; glatt für den Sonnen-Glanz auf den Wellen
        mat.color.setRGB(...(w.fogColorLinear ?? w.colorLinear)).multiplyScalar(WATER_ALBEDO); mat.roughness = 0.1; mat.metalness = 0; mat.depthWrite = false
        if (w.normalTexture) wait.push(texOf(w.normalTexture, false).then(t => { f.waves = t }))
      }
    }
    // Overlays liegen auf der Fläche (main map.ts VRF_OVERLAY_PUSH): Tiefen-Versatz; 'bias' (F_DEPTHBIAS) schreibt weiter Tiefe
    if (flags.includes('overlay') || flags.includes('bias')) { mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -4 }
    if (flags.includes('overlay')) mat.depthWrite = false
    if (flags.includes('additive')) { mat.blending = THREE.AdditiveBlending; mat.depthWrite = false }
    if (flags.includes('mod2x')) {
      // Ziel · Quelle + Quelle · Ziel = 2 · Quelle · Ziel; Ziel-Alpha bleibt
      Object.assign(mat, { transparent: true, depthWrite: false, fog: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.SrcColorFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor })
      // Modell-Tönung erst nach der Gamma-Umrechnung (patchMaterial)
      f.mod2x = mat.color.clone()
      mat.color.setRGB(1, 1, 1)
      if (anim) { f.anim = anim; f.time = c.env.time }
    }
    if (flags.includes('blend')) mat.depthWrite = false
    if (flags.includes('nofog')) mat.fog = false // g_bFogEnabled 0 (Wolken, Sonnenscheiben)
    if (ext.fx) {
      f.fx = ext.fx; f.time = c.env.time; f.masks = [null, null, null]
      ;[ext.mask1Texture, ext.mask2Texture, ext.mask3Texture].forEach((d, i) => { if (d) wait.push(texOf(d, false).then(t => { f.masks![i] = t })) })
      if (ext.color2Texture) wait.push(texOf(ext.color2Texture, true).then(t => { f.color2 = t }))
    }
    if (mat.alphaTest > 0) mat.alphaToCoverage = true
    // unbeleuchtete Skybox-Materialien (MeshBasicMaterial) brauchen den sky-Patch: sonst hinter far abgeschnitten (Dust2-Wolken nur bis 1 km)
    jobs.push(Promise.all(wait).then(() => { if (mat.isMeshStandardMaterial || f.sky || f.fx) { patchMaterial(mat, f); feats.set(mat, f) } mat.needsUpdate = true }))
    mesh.material = mat
    done.set(k, mat)
  }
  await Promise.all(jobs)

  // Bündeln: Kosten je Bild skalieren mit der Objektzahl (setProgram/Uniforms, V-Profil), nicht mit Dreiecken. Ohne Raumzellen: Dust2,
  // 3 Ladebild-Posen, Map-Draw-Calls 1024-u-Zellen −18/−21/−13 %, 4096 u −46/−38/−25 %, ganze Map −57/−51/−39 % bei weniger GPU-Zeit (C/runs/y_c*).
  // Auch große Meshes: nur bis 20 000 Vertices spart 60 ms Kopierzeit, kostet aber 20 Draw-Calls (C/runs/w_*).
  const groups = new Map<string, THREE.Mesh[]>()
  for (const { mesh, key } of cands) {
    const list = groups.get(key)
    if (list) list.push(mesh); else groups.set(key, [mesh])
  }
  const gone = new Set<THREE.Mesh>()
  for (const ms of groups.values()) {
    if (ms.length < 2) continue
    const colors = ms.map(x => (x.material as THREE.MeshStandardMaterial).color)
    const tint = colors.some(x => !x.equals(colors[0]))
    const lmMesh = ms.find(x => x.geometry.attributes.uv1), mix = !!lmMesh && ms.some(x => !x.geometry.attributes.uv1)
    const base = (lmMesh ?? ms[0]).material as THREE.MeshStandardMaterial
    let mat = base
    if (tint || mix) {
      mat = base.clone()
      if (tint) { mat.color.setRGB(1, 1, 1); mat.vertexColors = true }
      const f: Feat = { ...feats.get(base)!, vtint: tint, ...mix && { mix, probe: c.lmIntensity } }
      patchMaterial(mat, f); feats.set(mat, f)
    }
    const mesh = new THREE.Mesh(mergeWorld(ms, tint ? colors : null), mat)
    mesh.matrixAutoUpdate = false; mesh.updateMatrixWorld()
    gltf.scene.add(mesh)
    for (const x of ms) { x.removeFromParent(); x.geometry.dispose(); gone.add(x) }
    meshes.push(mesh); solid.push(mesh)
  }
  const keep = (x: THREE.Mesh) => !gone.has(x)
  return { meshes: meshes.filter(keep), solid: solid.filter(keep) }
}

/**
 * Meshes in Weltkoordinaten zu einer Geometrie: Position Float32, Normale Int8 (normiert), übrige Attribute im gemeinsamen Typ
 * (sonst Float32), Tint → Attribut color. Fehlt einem Mesh ein Attribut (Bündel Lightmap + Sonde): uv1 = −1, sonst 0.
 * Liest quantisierte/verschachtelte glTF-Attribute direkt (getX je Vertex wäre zu langsam).
 */
function mergeWorld(ms: THREE.Mesh[], tint: THREE.Color[] | null): THREE.BufferGeometry {
  const geos = ms.map(x => x.geometry)
  const nv = geos.reduce((s, g) => s + g.attributes.position.count, 0), ni = geos.reduce((s, g) => s + (g.index ?? g.attributes.position).count, 0)
  const out = new THREE.BufferGeometry(), nm = new THREE.Matrix3(), box = new THREE.Box3()
  for (const name of new Set(geos.flatMap(g => Object.keys(g.attributes)))) {
    const has = geos.map(g => g.attributes[name] as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined), a0 = has.find(a => a)!, k = a0.itemSize
    const pos = name === 'position', nrm = name === 'normal', fill = name === 'uv1' ? -1 : 0
    const same = has.every(a => !a || (a.array.constructor === a0.array.constructor && a.normalized === a0.normalized))
    const raw = same && !pos && !nrm && (fill === 0 || has.every(a => a))
    const Ctor = (pos ? Float32Array : nrm ? Int8Array : raw ? a0.array.constructor : Float32Array) as Float32ArrayConstructor
    const dst = new Ctor(nv * k)
    let o = 0
    geos.forEach((g, j) => {
      const a = has[j]
      if (!a) { const e = o + g.attributes.position.count * k; dst.fill(fill, o, e); o = e; return }
      const n = a.count
      const il = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
      const src = a.array, st = il ? (a as THREE.InterleavedBufferAttribute).data.stride : k, off = il ? (a as THREE.InterleavedBufferAttribute).offset : 0
      // wie three denormalize: Int8/16 → max(v/max, −1), Uint8/16 → v/max
      const sc = raw || !a.normalized ? 1 : src instanceof Int8Array ? 1 / 127 : src instanceof Uint8Array ? 1 / 255 : src instanceof Int16Array ? 1 / 32767 : src instanceof Uint16Array ? 1 / 65535 : 1
      const lo = !raw && a.normalized && (src instanceof Int8Array || src instanceof Int16Array) ? -1 : -Infinity
      if (pos) { // ohne −1-Klemme: −32768/32767 weicht um 3·10⁻⁵ ab
        const e = ms[j].matrixWorld.elements, mn = box.min, mx = box.max
        for (let i = 0, b = off; i < n; i++, b += st, o += 3) {
          const x = src[b] * sc, y = src[b + 1] * sc, z = src[b + 2] * sc
          const X = dst[o] = e[0] * x + e[4] * y + e[8] * z + e[12], Y = dst[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13], Z = dst[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14]
          if (X < mn.x) mn.x = X; if (X > mx.x) mx.x = X; if (Y < mn.y) mn.y = Y; if (Y > mx.y) mx.y = Y; if (Z < mn.z) mn.z = Z; if (Z > mx.z) mx.z = Z
        }
      } else if (nrm) { // wird ohnehin neu normiert
        const e = nm.getNormalMatrix(ms[j].matrixWorld).elements
        for (let i = 0, b = off; i < n; i++, b += st, o += 3) {
          const x = src[b], y = src[b + 1], z = src[b + 2]
          const u = e[0] * x + e[3] * y + e[6] * z, v = e[1] * x + e[4] * y + e[7] * z, w = e[2] * x + e[5] * y + e[8] * z, l = 127 / (Math.sqrt(u * u + v * v + w * w) || 1)
          dst[o] = Math.round(u * l); dst[o + 1] = Math.round(v * l); dst[o + 2] = Math.round(w * l)
        }
      } else if (raw && st === k) { dst.set(src.subarray(off, off + n * k), o); o += n * k }
      else for (let i = 0; i < n; i++) for (let q = 0, b = off + i * st; q < k; q++) dst[o++] = raw ? src[b + q] : Math.max(src[b + q] * sc, lo)
    })
    out.setAttribute(name, new THREE.BufferAttribute(dst, k, nrm || (raw && a0.normalized)))
  }
  if (tint) {
    const col = new Float32Array(nv * 3)
    let o = 0
    geos.forEach((g, j) => { const { r, g: gr, b } = tint[j]; for (let i = 0; i < g.attributes.position.count; i++, o += 3) { col[o] = r; col[o + 1] = gr; col[o + 2] = b } })
    out.setAttribute('color', new THREE.BufferAttribute(col, 3))
  }
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni)
  let o = 0, base = 0
  geos.forEach((g, j) => {
    const ix = g.index?.array, n = g.attributes.position.count, flip = ms[j].matrixWorld.determinant() < 0 // gespiegelt: Umlaufsinn umdrehen
    const cnt = ix ? ix.length : n
    for (let i = 0; i < cnt; i += 3) {
      const a = ix ? ix[i] : i, b = ix ? ix[i + 1] : i + 1, d = ix ? ix[i + 2] : i + 2
      idx[o++] = a + base; idx[o++] = (flip ? d : b) + base; idx[o++] = (flip ? b : d) + base
    }
    base += n
  })
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  out.boundingBox = box; out.boundingSphere = box.getBoundingSphere(new THREE.Sphere()) // Kugel um die Box: etwas größer, spart einen Durchlauf
  return out
}
