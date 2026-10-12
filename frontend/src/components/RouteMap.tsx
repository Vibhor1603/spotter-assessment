import { useEffect, useRef } from 'react'
import {
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  LngLatBounds,
  setWorkerUrl,
} from 'maplibre-gl'
import type {
  Map as MapLibreMapType,
  MapMouseEvent,
  MapGeoJSONFeature,
  GeoJSONSource,
  StyleSpecification,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { Checkpoint, PlanResponse } from '../lib/types'
import { RISK_COLORS } from '../lib/types'

// MapLibre v6 + Vite: worker URL must be set once or GeoJSON sources never tile/paint.
setWorkerUrl(workerUrl)

const STYLE: StyleSpecification = {
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

const TEAL = '#5fdede'
const TEAL_MUTED = 'rgba(95, 222, 222, 0.45)'
const ALT = '#9aa3ad'
const CASING = '#0d1116'

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

function routesCollection(data: PlanResponse, sel: string | null) {
  const selected = sel ?? data.recommended
  return {
    type: 'FeatureCollection' as const,
    features: data.routes.map(r => ({
      type: 'Feature' as const,
      properties: {
        id: r.id,
        best: r.id === data.recommended ? 1 : 0,
        selected: r.id === selected ? 1 : 0,
      },
      geometry: { type: 'LineString' as const, coordinates: r.geometry },
    })),
  }
}

function cpsCollection(data: PlanResponse, sel: string | null) {
  const selected = sel ?? data.recommended
  return {
    type: 'FeatureCollection' as const,
    features: data.routes.flatMap(r =>
      r.checkpoints.map(c => ({
        type: 'Feature' as const,
        properties: {
          routeId: r.id,
          color: RISK_COLORS[c.risk],
          selected: r.id === selected ? 1 : 0,
          payload: JSON.stringify(c),
        },
        geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] },
      })),
    ),
  }
}

function heatCollection(data: PlanResponse) {
  const hm = data.heatmap
  if (!hm?.points?.length) {
    return { type: 'FeatureCollection' as const, features: [] }
  }
  return {
    type: 'FeatureCollection' as const,
    features: hm.points.map(p => {
      const props: Record<string, number> = {}
      p.weights.forEach((w, i) => { props[`w${i}`] = w })
      return {
        type: 'Feature' as const,
        properties: props,
        geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
      }
    }),
  }
}

type Props = {
  data: PlanResponse | null
  selectedId: string | null
  hour: number
  showHeatmap: boolean
  onSelectRoute?: (id: string) => void
}

export default function RouteMap({ data, selectedId, hour, showHeatmap, onSelectRoute }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibreMapType | null>(null)
  const popup = useRef<Popup | null>(null)
  const ready = useRef(false)
  const onSelectRef = useRef(onSelectRoute)
  const rafRef = useRef(0)
  const dataRef = useRef(data)
  const selectedRef = useRef(selectedId)
  const hourRef = useRef(hour)
  const heatRef = useRef(showHeatmap)
  const drawnPlanRef = useRef<PlanResponse | null>(null)

  onSelectRef.current = onSelectRoute
  dataRef.current = data
  selectedRef.current = selectedId
  hourRef.current = hour
  heatRef.current = showHeatmap

  useEffect(() => {
    if (!el.current || map.current) return
    const m = new MapLibreMap({
      container: el.current,
      style: STYLE,
      center: [-98, 39],
      zoom: 3.6,
      attributionControl: { compact: true },
    })
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    popup.current = new Popup({
      closeButton: true, maxWidth: '260px', offset: 12,
    })

    const markReady = () => {
      ready.current = true
      // Expose for Playwright verification (dev only)
      ;(window as unknown as { __spotterMap?: MapLibreMapType }).__spotterMap = m
      syncAll()
    }
    m.on('load', markReady)
    map.current = m

    return () => {
      cancelAnimationFrame(rafRef.current)
      popup.current?.remove()
      m.remove()
      map.current = null
      ready.current = false
      drawnPlanRef.current = null
      const w = window as unknown as { __spotterMap?: MapLibreMapType }
      if (w.__spotterMap === m) delete w.__spotterMap
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; syncAll reads refs
  }, [])

  function ensureLayers(m: MapLibreMapType) {
    if (!m.getSource('heat')) {
      m.addSource('heat', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    if (!m.getSource('routes')) {
      m.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    if (!m.getSource('cps')) {
      m.addSource('cps', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }

    if (!m.getLayer('heat-layer')) {
      m.addLayer({
        id: 'heat-layer',
        type: 'heatmap',
        source: 'heat',
        layout: { visibility: 'none' },
        paint: {
          'heatmap-weight': ['coalesce', ['get', 'w0'], 0],
          'heatmap-intensity': 1.85,
          'heatmap-radius': [
            'interpolate', ['linear'], ['zoom'],
            4, 22,
            7, 36,
            10, 48,
          ],
          'heatmap-opacity': 0.78,
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(13,17,22,0)',
            0.15, 'rgba(45,164,78,0.55)',
            0.35, 'rgba(212,167,44,0.72)',
            0.55, 'rgba(251,133,0,0.85)',
            0.75, 'rgba(207,34,46,0.95)',
            1, 'rgba(110,64,201,1)',
          ],
        },
      })
    }

    if (!m.getLayer('routes-casing')) {
      m.addLayer({
        id: 'routes-casing',
        type: 'line',
        source: 'routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': CASING,
          'line-width': [
            'case',
            ['==', ['get', 'selected'], 1], 10,
            ['==', ['get', 'best'], 1], 8,
            6,
          ],
          'line-opacity': 0.85,
        },
      })
    }

    if (!m.getLayer('routes')) {
      m.addLayer({
        id: 'routes',
        type: 'line',
        source: 'routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'case',
            ['==', ['get', 'selected'], 1], TEAL,
            ['==', ['get', 'best'], 1], TEAL,
            ALT,
          ],
          'line-width': [
            'case',
            ['==', ['get', 'selected'], 1], 6,
            ['==', ['get', 'best'], 1], 5,
            3,
          ],
          'line-opacity': [
            'case',
            ['==', ['get', 'selected'], 1], 1,
            ['==', ['get', 'best'], 1], 0.92,
            0.55,
          ],
        },
      })
    }

    if (!m.getLayer('routes-hit')) {
      m.addLayer({
        id: 'routes-hit',
        type: 'line',
        source: 'routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': TEAL_MUTED,
          'line-width': 16,
          'line-opacity': 0,
        },
      })
    }

    if (!m.getLayer('cps')) {
      m.addLayer({
        id: 'cps',
        type: 'circle',
        source: 'cps',
        paint: {
          'circle-radius': [
            'case',
            ['==', ['get', 'selected'], 1], 7,
            4.5,
          ],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': CASING,
          'circle-stroke-width': 1.5,
          'circle-opacity': [
            'case',
            ['==', ['get', 'selected'], 1], 1,
            0.4,
          ],
        },
      })
    }
  }

  function bindInteractions(m: MapLibreMapType) {
    m.off('click', 'cps', onCpClick)
    m.off('click', 'routes-hit', onRouteClick)
    m.off('mouseenter', 'cps', onCpEnter)
    m.off('mouseleave', 'cps', onCpLeave)
    m.off('mouseenter', 'routes-hit', onRouteEnter)
    m.off('mouseleave', 'routes-hit', onRouteLeave)

    m.on('click', 'cps', onCpClick)
    m.on('click', 'routes-hit', onRouteClick)
    m.on('mouseenter', 'cps', onCpEnter)
    m.on('mouseleave', 'cps', onCpLeave)
    m.on('mouseenter', 'routes-hit', onRouteEnter)
    m.on('mouseleave', 'routes-hit', onRouteLeave)
  }

  function onCpClick(e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) {
    const f = e.features?.[0]
    if (!f || !popup.current || !map.current) return
    const c = JSON.parse(String(f.properties?.payload)) as Checkpoint
    const routeId = String(f.properties?.routeId ?? '')
    if (routeId) onSelectRef.current?.(routeId)
    popup.current.setLngLat(e.lngLat).setHTML(popupHtml(c, routeId)).addTo(map.current)
  }

  function onRouteClick(e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) {
    const id = e.features?.[0]?.properties?.id
    if (id != null) onSelectRef.current?.(String(id))
  }

  function onCpEnter() {
    const m = map.current
    if (m) m.getCanvas().style.cursor = 'pointer'
  }
  function onCpLeave() {
    const m = map.current
    if (m) m.getCanvas().style.cursor = ''
  }
  function onRouteEnter() {
    const m = map.current
    if (m) m.getCanvas().style.cursor = 'pointer'
  }
  function onRouteLeave() {
    const m = map.current
    if (m) m.getCanvas().style.cursor = ''
  }

  function animateDrawIn(m: MapLibreMapType, d: PlanResponse) {
    cancelAnimationFrame(rafRef.current)
    const full = routesCollection(d, selectedRef.current)
    const src = m.getSource('routes') as GeoJSONSource
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      src.setData(full)
      return
    }
    const start = performance.now()
    const dur = 780
    // Strong ease-out — starts fast, settles cleanly (animations.dev)
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3.2)

    const tick = (now: number) => {
      // Abort if a newer plan replaced this one mid-animation
      if (drawnPlanRef.current !== d || map.current !== m) return
      const t = Math.min(1, (now - start) / dur)
      const p = easeOut(t)
      src.setData({
        type: 'FeatureCollection',
        features: full.features.map(f => {
          const coords = f.geometry.coordinates
          const n = Math.max(2, Math.floor(coords.length * p))
          return {
            ...f,
            geometry: { type: 'LineString' as const, coordinates: coords.slice(0, n) },
          }
        }),
      })
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
      else src.setData(routesCollection(d, selectedRef.current))
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  function applyHeatPaint(m: MapLibreMapType) {
    if (!m.getLayer('heat-layer')) return
    const h = hourRef.current
    m.setPaintProperty('heat-layer', 'heatmap-weight', ['coalesce', ['get', `w${h}`], 0])
    m.setLayoutProperty(
      'heat-layer',
      'visibility',
      heatRef.current && (dataRef.current?.heatmap?.points?.length ?? 0) > 0 ? 'visible' : 'none',
    )
  }

  function syncSelection(m: MapLibreMapType) {
    const d = dataRef.current
    if (!d || !m.getSource('routes')) return
    const sel = selectedRef.current
    ;(m.getSource('routes') as GeoJSONSource).setData(routesCollection(d, sel))
    if (m.getSource('cps')) {
      ;(m.getSource('cps') as GeoJSONSource).setData(cpsCollection(d, sel))
    }
  }

  function syncAll() {
    const m = map.current
    const d = dataRef.current
    if (!m || !ready.current || !m.isStyleLoaded()) return
    if (!d) {
      drawnPlanRef.current = null
      return
    }

    try {
      ensureLayers(m)
      bindInteractions(m)

      const isNewPlan = drawnPlanRef.current !== d
      ;(m.getSource('cps') as GeoJSONSource).setData(
        cpsCollection(d, selectedRef.current),
      )
      ;(m.getSource('heat') as GeoJSONSource).setData(heatCollection(d))
      applyHeatPaint(m)

      if (isNewPlan) {
        drawnPlanRef.current = d
        const b = new LngLatBounds()
        d.routes.forEach(r => r.geometry.forEach(p => b.extend(p as [number, number])))
        if (!b.isEmpty()) {
          m.fitBounds(b, { padding: 64, maxZoom: 8, duration: 900, essential: true })
        }
        animateDrawIn(m, d)
      } else {
        ;(m.getSource('routes') as GeoJSONSource).setData(
          routesCollection(d, selectedRef.current),
        )
      }
    } catch (err) {
      console.error('RouteMap sync failed', err)
    }
  }

  // Plan data changed
  useEffect(() => {
    const m = map.current
    if (!m || !data) return
    if (ready.current && m.isStyleLoaded()) syncAll()
    else m.once('load', () => { ready.current = true; syncAll() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // Selection highlight — setData only
  useEffect(() => {
    const m = map.current
    if (!m || !data || !ready.current || !m.getSource('routes')) return
    syncSelection(m)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, data])

  // Hour slider: paint-only
  useEffect(() => {
    const m = map.current
    if (!m || !m.getLayer('heat-layer')) return
    m.setPaintProperty('heat-layer', 'heatmap-weight', ['coalesce', ['get', `w${hour}`], 0])
  }, [hour])

  useEffect(() => {
    const m = map.current
    if (!m || !m.getLayer('heat-layer')) return
    m.setLayoutProperty(
      'heat-layer',
      'visibility',
      showHeatmap && (data?.heatmap?.points?.length ?? 0) > 0 ? 'visible' : 'none',
    )
  }, [showHeatmap, data])

  return <div id="map" ref={el} role="presentation" />
}
