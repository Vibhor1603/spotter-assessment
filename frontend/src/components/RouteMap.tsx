import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { PlanResponse } from '../lib/types'
import { RISK_COLORS } from '../lib/types'

// TODO(next): heatmap layer along corridor driven by forecast-hour slider (0-48h),
// checkpoint popups with ETA/wind/rain/snow, highlight selected route.
export default function RouteMap({ data }: { data: PlanResponse | null }) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)

  useEffect(() => {
    if (!el.current || map.current) return
    map.current = new maplibregl.Map({
      container: el.current,
      style: 'https://demotiles.maplibre.org/style.json', // TODO: swap for OSM raster/OpenFreeMap style
      center: [-98, 39], zoom: 3.5,
    })
  }, [])

  useEffect(() => {
    const m = map.current
    if (!m || !data) return
    const draw = () => {
      for (const id of ['routes', 'cps']) {
        if (m.getLayer(id)) m.removeLayer(id)
        if (m.getSource(id)) m.removeSource(id)
      }
      m.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: data.routes.map(r => ({
        type: 'Feature', properties: { best: r.id === data.recommended },
        geometry: { type: 'LineString', coordinates: r.geometry } })) } })
      m.addLayer({ id: 'routes', type: 'line', source: 'routes', paint: {
        'line-color': ['case', ['get', 'best'], '#1a7f37', '#888'], 'line-width': ['case', ['get', 'best'], 5, 3] } })
      m.addSource('cps', { type: 'geojson', data: { type: 'FeatureCollection', features: data.routes.flatMap(r =>
        r.checkpoints.map(c => ({ type: 'Feature', properties: { color: RISK_COLORS[c.risk] },
          geometry: { type: 'Point', coordinates: [c.lon, c.lat] } }))) } })
      m.addLayer({ id: 'cps', type: 'circle', source: 'cps', paint: {
        'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } })
      const b = new maplibregl.LngLatBounds()
      data.routes.forEach(r => r.geometry.forEach(p => b.extend(p)))
      m.fitBounds(b, { padding: 40 })
    }
    if (m.isStyleLoaded()) draw(); else m.once('load', draw)
  }, [data])

  return <div id="map" ref={el} />
}
