import type { Map as MapLibreMapType } from 'maplibre-gl'

/**
 * MapTiler Dataviz Dark — free API key, purpose-built for overlays.
 * Fallback: OpenFreeMap dark (keyless) if VITE_MAPTILER_KEY is missing.
 *
 * Free key: https://cloud.maptiler.com/account/keys/
 */
const MAPTILER_KEY = (import.meta.env.VITE_MAPTILER_KEY as string | undefined)?.trim() ?? ''

export const HAS_MAPTILER = MAPTILER_KEY.length > 8

/** Best free dark style for route/heatmap product UI. */
export function basemapStyleUrl(): string {
  if (HAS_MAPTILER) {
    return `https://api.maptiler.com/maps/dataviz-v4-dark/style.json?key=${encodeURIComponent(MAPTILER_KEY)}`
  }
  return 'https://tiles.openfreemap.org/styles/dark'
}

export function pickLabelFont(m: MapLibreMapType): string[] {
  const layers = m.getStyle()?.layers ?? []
  for (const layer of layers) {
    if (layer.type !== 'symbol') continue
    const font = (layer.layout as { 'text-font'?: string[] } | undefined)?.['text-font']
    if (Array.isArray(font) && font.length) return font
  }
  return HAS_MAPTILER ? ['Roboto Regular'] : ['Noto Sans Regular']
}

/**
 * Tint MapTiler / OpenFreeMap layers toward Spotter ink / mint.
 * Safe no-ops when a layer id is absent.
 */
export function applySpotterBasemapTheme(m: MapLibreMapType) {
  const set = (id: string, prop: string, value: unknown) => {
    if (!m.getLayer(id)) return
    try {
      // Paint keys vary by style; cast keeps theming resilient across MapTiler / OFM.
      m.setPaintProperty(id, prop as never, value as never)
    } catch {
      /* layer paint schema differs across styles */
    }
  }

  // Core surfaces → Spotter teal-charcoal
  set('background', 'background-color', '#061417')
  set('water', 'fill-color', '#0a2228')
  set('water', 'fill-opacity', 1)
  set('waterway', 'line-color', '#0d2e34')
  set('landcover', 'fill-color', '#0a1c20')
  set('landuse', 'fill-color', '#0c1f24')
  set('park', 'fill-color', '#0c221f')
  set('sand', 'fill-color', '#122428')

  // Roads: quiet hierarchy so routes/heatmap win
  const roadMute = [
    'road_network', 'road', 'road_path', 'road_rail', 'road_pedestrian',
    'Transportation', 'Transportation network',
    'highway_motorway', 'highway_trunk', 'highway_primary', 'highway_secondary',
    'highway_tertiary', 'highway_minor', 'highway_path',
  ]
  for (const id of roadMute) {
    set(id, 'line-opacity', 0.35)
    set(id, 'line-color', '#1a3036')
  }

  // Soften place labels (Apple-quiet chrome)
  for (const layer of m.getStyle()?.layers ?? []) {
    if (layer.type !== 'symbol') continue
    const id = layer.id
    set(id, 'text-color', '#8aa0a4')
    set(id, 'text-halo-color', '#061417')
    set(id, 'text-halo-width', 1.2)
    set(id, 'text-opacity', 0.62)
    set(id, 'icon-opacity', 0.5)
  }
}
