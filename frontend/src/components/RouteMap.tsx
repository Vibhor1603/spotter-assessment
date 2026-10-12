import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Checkpoint, PlanResponse } from '../lib/types'
import { RISK_COLORS } from '../lib/types'

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
}

function fmtEta(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function popupHtml(c: Checkpoint, routeId: string) {
  const badge = c.load_escalated
    ? `<span class="pop-badge">Load escalated</span>`
    : ''
  return `
    <div class="map-pop">
      <strong>${routeId} · mi ${c.mile}</strong>
      <div class="pop-risk" style="color:${RISK_COLORS[c.risk]}">${c.risk}</div>
      ${badge}
      <dl>
        <dt>ETA</dt><dd>${fmtEta(c.eta)}</dd>
        <dt>Forecast hr</dt><dd>${c.forecast_time}Z</dd>
        <dt>Wind</dt><dd>${Number(c.wind_mph).toFixed(1)} mph (${c.wind_risk ?? '—'})</dd>
        <dt>Rain</dt><dd>${Number(c.rain_in_hr).toFixed(2)} in/hr (${c.rain_risk ?? '—'})</dd>
        <dt>Snow</dt><dd>${Number(c.snow_in_hr).toFixed(2)} in/hr (${c.snow_risk ?? '—'})</dd>
      </dl>
    </div>`
}

type Props = {
  data: PlanResponse | null
  selectedId: string | null
  hour: number
  showHeatmap: boolean
}

export default function RouteMap({ data, selectedId, hour, showHeatmap }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const popup = useRef<maplibregl.Popup | null>(null)
  const ready = useRef(false)

  useEffect(() => {
    if (!el.current || map.current) return
    const m = new maplibregl.Map({
      container: el.current,
      style: STYLE,
      center: [-98, 39],
      zoom: 3.6,
      attributionControl: { compact: true },
    })
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    popup.current = new maplibregl.Popup({
      closeButton: true, maxWidth: '260px', offset: 12,
    })
    m.on('load', () => { ready.current = true })
    map.current = m
    return () => {
      popup.current?.remove()
      m.remove()
      map.current = null
      ready.current = false
    }
  }, [])

  // Draw / refresh route + checkpoint + heatmap sources when plan data changes
  useEffect(() => {
    const m = map.current
    if (!m || !data) return

    const draw = () => {
      for (const id of ['routes', 'cps', 'heat']) {
        if (m.getLayer(`${id}-hit`)) m.removeLayer(`${id}-hit`)
        if (m.getLayer(id)) m.removeLayer(id)
        if (m.getSource(id)) m.removeSource(id)
      }
      if (m.getLayer('heat-layer')) m.removeLayer('heat-layer')

      const sel = selectedId ?? data.recommended
      m.addSource('routes', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: data.routes.map(r => ({
            type: 'Feature',
            properties: {
              id: r.id,
              best: r.id === data.recommended,
              selected: r.id === sel,
            },
            geometry: { type: 'LineString', coordinates: r.geometry },
          })),
        },
      })
      m.addLayer({
        id: 'routes', type: 'line', source: 'routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'case',
            ['get', 'selected'], '#5fdede',
            ['get', 'best'], '#2da44e',
            '#6b7280',
          ],
          'line-width': [
            'case',
            ['get', 'selected'], 6,
            ['get', 'best'], 5,
            3,
          ],
          'line-opacity': [
            'case',
            ['get', 'selected'], 1,
            0.55,
          ],
        },
      })

      m.addSource('cps', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: data.routes.flatMap(r =>
            r.checkpoints.map(c => ({
              type: 'Feature',
              properties: {
                routeId: r.id,
                color: RISK_COLORS[c.risk],
                selected: r.id === sel,
                payload: JSON.stringify(c),
              },
              geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
            })),
          ),
        },
      })
      m.addLayer({
        id: 'cps', type: 'circle', source: 'cps',
        paint: {
          'circle-radius': ['case', ['get', 'selected'], 6, 4],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0d1116',
          'circle-stroke-width': 1.5,
          'circle-opacity': ['case', ['get', 'selected'], 1, 0.35],
        },
      })

      // Heatmap: one GeoJSON with w0..w47 props; slider only changes paint expression
      const hm = data.heatmap
      if (hm?.points?.length) {
        const features = hm.points.map(p => {
          const props: Record<string, number> = {}
          p.weights.forEach((w, i) => { props[`w${i}`] = w })
          return {
            type: 'Feature' as const,
            properties: props,
            geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
          }
        })
        m.addSource('heat', { type: 'geojson', data: { type: 'FeatureCollection', features } })
        m.addLayer({
          id: 'heat-layer',
          type: 'heatmap',
          source: 'heat',
          layout: { visibility: showHeatmap ? 'visible' : 'none' },
          paint: {
            'heatmap-weight': ['get', `w${hour}`],
            'heatmap-intensity': 1.1,
            'heatmap-radius': 28,
            'heatmap-opacity': 0.72,
            'heatmap-color': [
              'interpolate', ['linear'], ['heatmap-density'],
              0, 'rgba(13,17,22,0)',
              0.2, 'rgba(45,164,78,0.55)',
              0.45, 'rgba(212,167,44,0.7)',
              0.7, 'rgba(251,133,0,0.85)',
              0.9, 'rgba(207,34,46,0.95)',
              1, 'rgba(110,64,201,1)',
            ],
          },
        }, 'routes')
      }

      const b = new maplibregl.LngLatBounds()
      data.routes.forEach(r => r.geometry.forEach(p => b.extend(p as [number, number])))
      if (!b.isEmpty()) m.fitBounds(b, { padding: 56, maxZoom: 8, duration: 600 })

      m.off('click', 'cps', onCpClick)
      m.on('click', 'cps', onCpClick)
      m.on('mouseenter', 'cps', () => { m.getCanvas().style.cursor = 'pointer' })
      m.on('mouseleave', 'cps', () => { m.getCanvas().style.cursor = '' })
    }

    function onCpClick(e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) {
      const f = e.features?.[0]
      if (!f || !popup.current || !map.current) return
      const c = JSON.parse(String(f.properties?.payload)) as Checkpoint
      const routeId = String(f.properties?.routeId ?? '')
      popup.current.setLngLat(e.lngLat).setHTML(popupHtml(c, routeId)).addTo(map.current)
    }

    if (m.isStyleLoaded()) draw()
    else m.once('load', draw)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selection/hour handled below
  }, [data])

  // Selection highlight without rebuilding geometry (setData on routes + cps)
  useEffect(() => {
    const m = map.current
    if (!m || !data || !m.getSource('routes')) return
    const sel = selectedId ?? data.recommended
    const routesSrc = m.getSource('routes') as maplibregl.GeoJSONSource
    routesSrc.setData({
      type: 'FeatureCollection',
      features: data.routes.map(r => ({
        type: 'Feature',
        properties: {
          id: r.id,
          best: r.id === data.recommended,
          selected: r.id === sel,
        },
        geometry: { type: 'LineString', coordinates: r.geometry },
      })),
    })
    if (m.getSource('cps')) {
      (m.getSource('cps') as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: data.routes.flatMap(r =>
          r.checkpoints.map(c => ({
            type: 'Feature',
            properties: {
              routeId: r.id,
              color: RISK_COLORS[c.risk],
              selected: r.id === sel,
              payload: JSON.stringify(c),
            },
            geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
          })),
        ),
      })
    }
  }, [selectedId, data])

  // Hour slider: paint-only update — no network, no setData
  useEffect(() => {
    const m = map.current
    if (!m || !m.getLayer('heat-layer')) return
    m.setPaintProperty('heat-layer', 'heatmap-weight', ['get', `w${hour}`])
  }, [hour])

  useEffect(() => {
    const m = map.current
    if (!m || !m.getLayer('heat-layer')) return
    m.setLayoutProperty('heat-layer', 'visibility', showHeatmap ? 'visible' : 'none')
  }, [showHeatmap])

  return <div id="map" ref={el} role="presentation" />
}
