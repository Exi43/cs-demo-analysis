// IPC des Utility-Dashboards (preload/index.ts → main/utility.ts). Bilder lädt das Fenster über csutil://img/<sha1>.webp,
// Radarbilder über csutil://radar/<map>.png. utilityThrows baut der 3D-Vorschau-Zweig (Vertrag in utility.ts): das Fenster prüft zur Laufzeit.
import type { ThrowCandidate, UtilityLibrary } from './utility.ts'

/** Eintrag aus resources/maps/map_data.json (Radar ↔ Welt: px = (x − pos_x) / scale, py = (pos_y − y) / scale) */
export interface RadarMeta {
  pos_x: number
  pos_y: number
  scale: number
  verticalsections?: Record<string, { AltitudeMax: string; AltitudeMin: string }>
}

export interface UtilityApi {
  /** 'utility:load': Bibliothek; warning = library.json war kaputt (als Kopie behalten) */
  utilityLoad(): Promise<{ lib: UtilityLibrary; warning?: string }>
  /** 'utility:save': ganze Bibliothek, Main prüft und schreibt atomar */
  utilitySave(lib: UtilityLibrary): Promise<void>
  /** 'utility:maps': map_data.json + vorhandene Radarbilder (Namen ohne .png, auch *_lower) */
  utilityMaps(): Promise<{ meta: Record<string, RadarMeta>; radars: string[] }>
  /** 'utility:addImages': Pfade oder (ohne) Dateidialog → sha1 je Bild, Fehler je Datei */
  utilityAddImages(paths?: string[]): Promise<{ hashes: string[]; errors: string[] }>
  /** 'utility:addImageData': eingefügtes Bild → sha1 */
  utilityAddImageData(data: Uint8Array): Promise<string>
  /** 'utility:addVideo': Pfad oder Dateidialog → Dateiname im Utility-Ordner; null = abgebrochen */
  utilityAddVideo(path?: string): Promise<string | null>
  /** 'utility:open': http(s)-Link im Browser bzw. lokales Video im Standard-Player */
  utilityOpen(target: { url?: string; local?: string }): Promise<void>
  /** 'utility:exportSize': geschätzte Bytes ohne Videos (base) und für die lokalen Videos */
  utilityExportSize(lib: UtilityLibrary): Promise<{ base: number; videos: number; imageCount: number; videoCount: number }>
  /** 'utility:export': Speichern-Dialog, Rückgabe Pfad oder null */
  utilityExport(lib: UtilityLibrary, withVideos: boolean, name: string): Promise<string | null>
  /** 'utility:importOpen': Datei wählen, prüfen → Inhalt für die Vorschau; null = abgebrochen */
  utilityImportOpen(): Promise<{ library: UtilityLibrary; file: string; images: number; videos: number } | null>
  /** 'utility:importCommit': Medien der geprüften Datei schreiben (danach speichert das Fenster die Bibliothek) */
  utilityImportCommit(): Promise<void>
  utilityImportCancel(): Promise<void>
  /** Würfe aus importierten Demos (3D-Vorschau-Zweig); fehlt die Funktion, blendet das Dashboard „From demo“ aus */
  utilityThrows?(map?: string): Promise<ThrowCandidate[]>
}
