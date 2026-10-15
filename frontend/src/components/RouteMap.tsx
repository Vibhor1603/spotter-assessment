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
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { Checkpoint, PlanResponse, RouteResult } from '../lib/types'
import {
  RISK_COLORS,
  routeRankLabel,
  truckPositionAt,
} from '../lib/types'
import { formatLocalDateTime, parseUTC } from '../lib/time'
import {
  applySpotterBasemapTheme,
  basemapStyleUrl,
  pickLabelFont,
} from '../lib/basemap'

// MapLibre v6 + Vite: worker URL must be set once or GeoJSON sources never tile/paint.
setWorkerUrl(workerUrl)

const TEAL = '#C5E1E5'
const TEAL_MUTED = 'rgba(197, 225, 229, 0.4)'
/** Soft mint-gray — readable as “other option” without competing with selected. */
const ALT = '#8aa3a7'
const CASING = '#061417'
const ALT_OPACITY = 0.52
/** Clear corridor heat without the neon blowout. */
const HEAT_OPACITY = 0.78

function popupHtml(c: Checkpoint, routeName: string) {
  const badge = c.load_escalated
    ? `<span class="pop-badge">Heavier load raised this risk</span>`
    : ''
  return `
    <div class="map-pop">
      <strong>${routeName} · mile ${Math.round(c.mile)}</strong>
      <div class="pop-risk" style="color:${RISK_COLORS[c.risk]}">Risk: ${c.risk}</div>
      ${badge}
      <dl>
        <dt>Arrive</dt><dd>${formatLocalDateTime(c.eta)}</dd>
        <dt>Wind</dt><dd>${Number(c.wind_mph).toFixed(0)} mph · ${c.wind_risk ?? '—'}</dd>
        <dt>Rain</dt><dd>${Number(c.rain_in_hr).toFixed(2)} in/hr · ${c.rain_risk ?? '—'}</dd>
        <dt>Snow</dt><dd>${Number(c.snow_in_hr).toFixed(2)} in/hr · ${c.snow_risk ?? '—'}</dd>
      </dl>
    </div>`
}

function rankById(data: PlanResponse): Map<string, number> {
  const m = new Map<string, number>()
  data.routes.forEach((r, i) => m.set(r.id, i))
  return m
}

function routesCollection(data: PlanResponse, sel: string | null) {
  const selected = sel ?? data.recommended
  // Draw selected last so shared corridors don’t show a doubled “twin” stroke on top.
  const ordered = [...data.routes].sort((a, b) => {
    const as = a.id === selected ? 1 : 0
    const bs = b.id === selected ? 1 : 0
    return as - bs
  })
  return {
    type: 'FeatureCollection' as const,
    features: ordered.map(r => ({
      type: 'Feature' as const,
      properties: {
        id: r.id,
        selected: r.id === selected ? 1 : 0,
        // Higher sort key paints above overlapping alternatives
        z: r.id === selected ? 2 : 1,
      },
      geometry: { type: 'LineString' as const, coordinates: r.geometry },
    })),
  }
}

/** Keep endpoints, load-escalated, High+, and a thinned sample — fewer, larger stops. */
function thinCheckpoints(cps: Checkpoint[]): Checkpoint[] {
  if (cps.length <= 8) return cps
  const out: Checkpoint[] = []
  const step = Math.max(2, Math.ceil(cps.length / 10))
  cps.forEach((c, i) => {
    const keep =
      i === 0 ||
      i === cps.length - 1 ||
      c.load_escalated ||
      c.risk_level >= 2 ||
      i % step === 0
    if (keep) out.push(c)
  })
  return out
}

function cpsCollection(data: PlanResponse, sel: string | null) {
  const selected = sel ?? data.recommended
  const ranks = rankById(data)
  return {
    type: 'FeatureCollection' as const,
    features: data.routes.flatMap(r =>
      thinCheckpoints(r.checkpoints).map(c => ({
        type: 'Feature' as const,
        properties: {
          routeId: r.id,
          rank: ranks.get(r.id) ?? 0,
          color: RISK_COLORS[c.risk],
          riskLevel: c.risk_level,
          selected: r.id === selected ? 1 : 0,
          payload: JSON.stringify(c),
        },
        geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] },
      })),
    ),
  }
}

function heatCollection(data: PlanResponse, sel: string | null) {
  const hm = data.heatmap
  if (!hm?.points?.length) {
    return { type: 'FeatureCollection' as const, features: [] }
  }
  const selected = sel ?? data.recommended
  const tagged = hm.points.some(p => p.route_id)
  const points = tagged
    ? hm.points.filter(p => p.route_id === selected)
    : hm.points
  return {
    type: 'FeatureCollection' as const,
    features: points.map(p => {
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

function endsCollection(data: PlanResponse) {
  const r = data.routes[0]
  if (!r?.geometry?.length) {
    return { type: 'FeatureCollection' as const, features: [] }
  }
  const start = r.geometry[0]
  const end = r.geometry[r.geometry.length - 1]
  return {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: { kind: 'start', label: 'Start' },
        geometry: { type: 'Point' as const, coordinates: start },
      },
      {
        type: 'Feature' as const,
        properties: { kind: 'end', label: 'End' },
        geometry: { type: 'Point' as const, coordinates: end },
      },
    ],
  }
}

function truckCollection(
  route: RouteResult | null,
  departureIso: string | null,
  forecastIso: string | null,
) {
  if (!route?.geometry?.length || !departureIso || !forecastIso) {
    return { type: 'FeatureCollection' as const, features: [] }
  }
  const pt = truckPositionAt(route, departureIso, parseUTC(forecastIso).getTime())
  if (!pt) return { type: 'FeatureCollection' as const, features: [] }
  return {
    type: 'FeatureCollection' as const,
    features: [{
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'Point' as const, coordinates: pt },
    }],
  }
}

function emptyFC() {
  return { type: 'FeatureCollection' as const, features: [] as never[] }
}


function reduceMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

type Props = {
  data: PlanResponse | null
  selectedId: string | null
  hour: number
  showHeatmap: boolean
  departureIso?: string | null
  dimmed?: boolean
  recenterToken?: number
  onSelectRoute?: (id: string) => void
}

export default function RouteMap({
  data, selectedId, hour, showHeatmap,
  departureIso = null, dimmed = false, recenterToken = 0, onSelectRoute,
}: Props) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibreMapType | null>(null)
  const popup = useRef<Popup | null>(null)
  const ready = useRef(false)
  const onSelectRef = useRef(onSelectRoute)
  const rafRef = useRef(0)
  const heatRafRef = useRef(0)
  const dataRef = useRef(data)
  const selectedRef = useRef(selectedId)
  const hourRef = useRef(hour)
  const heatRef = useRef(showHeatmap)
  const depRef = useRef(departureIso)
  const dimRef = useRef(dimmed)
  const drawnPlanRef = useRef<PlanResponse | null>(null)

  onSelectRef.current = onSelectRoute
  dataRef.current = data
  selectedRef.current = selectedId
  hourRef.current = hour
  heatRef.current = showHeatmap
  depRef.current = departureIso
  dimRef.current = dimmed

  useEffect(() => {
    if (!el.current || map.current) return
    const container = el.current
    const m = new MapLibreMap({
      container,
      style: basemapStyleUrl(),
      center: [-98, 39],
      zoom: 3.6,
      attributionControl: { compact: true },
      fadeDuration: 320,
      maxPitch: 0,
      pitchWithRotate: false,
      dragRotate: false,
      touchPitch: false,
      pixelRatio: Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2),
    })
    m.addControl(new NavigationControl({
      showCompass: false,
      visualizePitch: false,
    }), 'top-right')
    popup.current = new Popup({
      closeButton: true, maxWidth: '280px', offset: 16,
      className: 'spotter-popup',
    })

    const markReady = () => {
      applySpotterBasemapTheme(m)
      ready.current = true
      ;(window as unknown as { __spotterMap?: MapLibreMapType }).__spotterMap = m
      // Layout may settle after Tailwind paint — force a real size then draw
      m.resize()
      syncAll()
    }
    m.on('load', markReady)
    m.on('style.load', () => {
      applySpotterBasemapTheme(m)
      if (ready.current) syncAll()
    })
    map.current = m

    // Tailwind grid height can arrive after mount; keep MapLibre in sync
    const ro = new ResizeObserver(() => {
      if (map.current === m) m.resize()
    })
    ro.observe(container)
    requestAnimationFrame(() => m.resize())

    return () => {
      ro.disconnect()
      cancelAnimationFrame(rafRef.current)
      cancelAnimationFrame(heatRafRef.current)
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
      m.addSource('heat', { type: 'geojson', data: emptyFC() })
    }
    if (!m.getSource('routes')) {
      m.addSource('routes', { type: 'geojson', data: emptyFC() })
    }
    if (!m.getSource('cps')) {
      m.addSource('cps', { type: 'geojson', data: emptyFC() })
    }
    if (!m.getSource('ends')) {
      m.addSource('ends', { type: 'geojson', data: emptyFC() })
    }
    if (!m.getSource('truck')) {
      m.addSource('truck', { type: 'geojson', data: emptyFC() })
    }

    // Phone: tighter heat halo + thinner routes so the map isn’t swallowed.
    const mobile = window.matchMedia('(max-width: 860px)').matches

    if (!m.getLayer('heat-layer')) {
      m.addLayer({
        id: 'heat-layer',
        type: 'heatmap',
        source: 'heat',
        layout: { visibility: 'none' },
        paint: {
          'heatmap-weight': ['coalesce', ['get', 'w0'], 0],
          // Intensity amplifies High+ into yellow/orange; Low stays soft green.
          'heatmap-intensity': [
            'interpolate', ['linear'], ['zoom'],
            3, mobile ? 0.95 : 1.2,
            6, mobile ? 1.15 : 1.45,
            9, mobile ? 1.35 : 1.7,
            12, mobile ? 1.5 : 1.9,
          ],
          'heatmap-radius': [
            'interpolate', ['linear'], ['zoom'],
            3, mobile ? 12 : 20,
            5, mobile ? 16 : 28,
            7, mobile ? 22 : 36,
            9, mobile ? 28 : 44,
            11, mobile ? 34 : 52,
          ],
          'heatmap-opacity': mobile ? 0.7 : HEAT_OPACITY,
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(13,17,22,0)',
            0.08, 'rgba(45,164,78,0.28)',
            0.18, 'rgba(45,164,78,0.55)',
            0.30, 'rgba(180,190,60,0.72)',
            0.42, 'rgba(212,167,44,0.85)',
            0.58, 'rgba(251,133,0,0.9)',
            0.75, 'rgba(207,34,46,0.94)',
            1, 'rgba(110,64,201,1)',
          ],
        },
      })
    } else {
      m.setPaintProperty('heat-layer', 'heatmap-intensity', [
        'interpolate', ['linear'], ['zoom'],
        3, mobile ? 0.95 : 1.2,
        6, mobile ? 1.15 : 1.45,
        9, mobile ? 1.35 : 1.7,
        12, mobile ? 1.5 : 1.9,
      ])
      m.setPaintProperty('heat-layer', 'heatmap-color', [
        'interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(13,17,22,0)',
        0.08, 'rgba(45,164,78,0.28)',
        0.18, 'rgba(45,164,78,0.55)',
        0.30, 'rgba(180,190,60,0.72)',
        0.42, 'rgba(212,167,44,0.85)',
        0.58, 'rgba(251,133,0,0.9)',
        0.75, 'rgba(207,34,46,0.94)',
        1, 'rgba(110,64,201,1)',
      ])
      m.setPaintProperty('heat-layer', 'heatmap-radius', [
        'interpolate', ['linear'], ['zoom'],
        3, mobile ? 12 : 20,
        5, mobile ? 16 : 28,
        7, mobile ? 22 : 36,
        9, mobile ? 28 : 44,
        11, mobile ? 34 : 52,
      ])
    }

    /*
      Single cohesive stroke (no “railroad” double edge):
      1) Soft blurred mint glow (selected only) — presence without hard rim
      2) Dark hairline casing — separation from basemap, not a second teal edge
      3) Solid opaque core — the route you actually see
      Alts stay thin + quiet so shared highway segments don’t look twinned.
    */
    const glowW = mobile ? 10 : 18
    const casingSel = mobile ? 5 : 9
    const casingAlt = mobile ? 3.25 : 5.75
    const lineSel = mobile ? 3.25 : 5.5
    const lineAlt = mobile ? 1.75 : 2.5

    if (!m.getLayer('routes-glow')) {
      // Sit under casing + core (hot reload may have already created those)
      const before = m.getLayer('routes-casing')
        ? 'routes-casing'
        : m.getLayer('routes')
          ? 'routes'
          : undefined
      m.addLayer({
        id: 'routes-glow',
        type: 'line',
        source: 'routes',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'line-sort-key': ['get', 'z'],
        },
        paint: {
          'line-color': TEAL,
          'line-width': glowW,
          'line-opacity': 0,
          'line-blur': mobile ? 6 : 10,
        },
        filter: ['==', ['get', 'selected'], 1],
      }, before)
    }

    if (!m.getLayer('routes-casing')) {
      m.addLayer({
        id: 'routes-casing',
        type: 'line',
        source: 'routes',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'line-sort-key': ['get', 'z'],
        },
        paint: {
          'line-color': CASING,
          'line-width': casingAlt,
          'line-opacity': 0.92,
          'line-blur': 0,
        },
      })
    }

    if (!m.getLayer('routes')) {
      m.addLayer({
        id: 'routes',
        type: 'line',
        source: 'routes',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'line-sort-key': ['get', 'z'],
        },
        paint: {
          'line-color': ALT,
          'line-width': lineAlt,
          'line-opacity': ALT_OPACITY,
          'line-blur': 0,
        },
      })
    }

    const dimFactor = dimRef.current ? 0.35 : 1
    m.setPaintProperty('routes-glow', 'line-width', glowW)
    m.setPaintProperty('routes-glow', 'line-blur', mobile ? 6 : 10)
    m.setPaintProperty('routes-glow', 'line-opacity', (mobile ? 0.22 : 0.28) * dimFactor)
    m.setFilter('routes-glow', ['==', ['get', 'selected'], 1])

    m.setPaintProperty('routes-casing', 'line-color', CASING)
    m.setPaintProperty('routes-casing', 'line-blur', 0)
    m.setPaintProperty('routes-casing', 'line-width', [
      'case',
      ['==', ['get', 'selected'], 1], casingSel,
      casingAlt,
    ])
    // Softer casing on alts so they don’t read as a black void
    m.setPaintProperty('routes-casing', 'line-opacity', [
      'case',
      ['==', ['get', 'selected'], 1], 0.92 * dimFactor,
      0.55 * dimFactor,
    ])
    m.setLayoutProperty('routes-casing', 'line-sort-key', ['get', 'z'])

    m.setPaintProperty('routes', 'line-color', [
      'case',
      ['==', ['get', 'selected'], 1], TEAL,
      ALT,
    ])
    m.setPaintProperty('routes', 'line-blur', 0)
    m.setPaintProperty('routes', 'line-width', [
      'case',
      ['==', ['get', 'selected'], 1], lineSel,
      lineAlt,
    ])
    m.setPaintProperty('routes', 'line-opacity', [
      'case',
      ['==', ['get', 'selected'], 1], 1 * dimFactor,
      ALT_OPACITY * dimFactor,
    ])
    m.setLayoutProperty('routes', 'line-sort-key', ['get', 'z'])

    if (!m.getLayer('routes-hit')) {
      m.addLayer({
        id: 'routes-hit',
        type: 'line',
        source: 'routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': TEAL_MUTED,
          'line-width': 22,
          'line-opacity': 0,
        },
      })
    }

    // Solid risk circles — dark casing cuts them out of the bright heatmap.
    const cpCoreSel = mobile ? 6.5 : 7.5
    const cpCoreAlt = mobile ? 5.5 : 6.5
    const cpCasingPad = mobile ? 2.25 : 2.5
    const cpStroke = mobile ? 1.75 : 2
    const endHalo = mobile ? 14 : 18
    const endR = mobile ? 7 : 9
    const endLabel = mobile ? 11 : 13
    const endOffset = mobile ? 1.6 : 1.9
    const truckHalo = mobile ? 12 : 16
    const truckR = mobile ? 6 : 7.5

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MapLibre data-driven expression
    const coreRadius: any = [
      'case',
      ['==', ['get', 'selected'], 1],
      ['+', cpCoreSel, ['*', ['min', ['coalesce', ['get', 'riskLevel'], 0], 3], 0.35]],
      cpCoreAlt,
    ]

    // Drop leftover symbol layers from earlier experiments
    for (const id of ['cps', 'ends', 'truck'] as const) {
      const layer = m.getLayer(id)
      if (layer && layer.type === 'symbol') m.removeLayer(id)
    }
    // Colored glow blended into heat — replace with dark casing instead
    if (m.getLayer('cps-glow')) m.removeLayer('cps-glow')
    if (m.getLayer('cps-ring')) m.removeLayer('cps-ring')

    if (!m.getLayer('cps-hit')) {
      m.addLayer({
        id: 'cps-hit',
        type: 'circle',
        source: 'cps',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            4, mobile ? 18 : 16,
            8, 22,
            12, mobile ? 26 : 28,
          ],
          'circle-color': '#fff',
          'circle-opacity': 0,
        },
      })
    }

    // Dark plate under every stop — separation from heatmap green
    if (!m.getLayer('cps-casing')) {
      m.addLayer({
        id: 'cps-casing',
        type: 'circle',
        source: 'cps',
        paint: {
          'circle-radius': ['+', coreRadius, cpCasingPad],
          'circle-color': '#061417',
          'circle-opacity': [
            'case',
            ['==', ['get', 'selected'], 1], 0.92,
            0.78,
          ],
          'circle-stroke-width': 0,
        },
      }, 'cps-hit')
    } else {
      m.setPaintProperty('cps-casing', 'circle-radius', ['+', coreRadius, cpCasingPad])
      m.setPaintProperty('cps-casing', 'circle-opacity', [
        'case',
        ['==', ['get', 'selected'], 1], 0.92,
        0.78,
      ])
    }

    if (!m.getLayer('cps')) {
      m.addLayer({
        id: 'cps',
        type: 'circle',
        source: 'cps',
        paint: {
          'circle-radius': coreRadius,
          'circle-color': ['get', 'color'],
          'circle-opacity': 1,
          'circle-stroke-color': '#F4F8F8',
          'circle-stroke-width': cpStroke,
          'circle-stroke-opacity': 1,
        },
      })
    } else {
      m.setPaintProperty('cps', 'circle-radius', coreRadius)
      m.setPaintProperty('cps', 'circle-opacity', 1)
      m.setPaintProperty('cps', 'circle-color', ['get', 'color'])
      m.setPaintProperty('cps', 'circle-stroke-color', '#F4F8F8')
      m.setPaintProperty('cps', 'circle-stroke-width', cpStroke)
      m.setPaintProperty('cps', 'circle-stroke-opacity', 1)
    }

    // Keep stack: casing under fill
    if (m.getLayer('cps-casing') && m.getLayer('cps')) {
      try { m.moveLayer('cps-casing', 'cps') } catch { /* already ordered */ }
    }

    if (!m.getLayer('ends-halo')) {
      m.addLayer({
        id: 'ends-halo',
        type: 'circle',
        source: 'ends',
        paint: {
          'circle-radius': endHalo,
          'circle-color': [
            'match', ['get', 'kind'],
            'start', 'rgba(26,154,163,0.4)',
            'rgba(244,248,248,0.3)',
          ],
          'circle-blur': 0.55,
          'circle-stroke-width': 0,
        },
      })
    } else {
      m.setPaintProperty('ends-halo', 'circle-radius', endHalo)
    }

    if (!m.getLayer('ends')) {
      m.addLayer({
        id: 'ends',
        type: 'circle',
        source: 'ends',
        paint: {
          'circle-radius': endR,
          'circle-color': [
            'match', ['get', 'kind'],
            'start', '#1A9AA3',
            '#F4F8F8',
          ],
          'circle-stroke-color': '#061417',
          'circle-stroke-width': mobile ? 2 : 2.5,
          'circle-stroke-opacity': 1,
        },
      })
    } else {
      m.setPaintProperty('ends', 'circle-radius', endR)
      m.setPaintProperty('ends', 'circle-stroke-width', mobile ? 2 : 2.5)
    }

    if (!m.getLayer('ends-label')) {
      m.addLayer({
        id: 'ends-label',
        type: 'symbol',
        source: 'ends',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': pickLabelFont(m),
          'text-size': endLabel,
          'text-offset': [0, endOffset],
          'text-anchor': 'top',
          'text-letter-spacing': 0.02,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#FFFFFF',
          'text-halo-color': 'rgba(6,20,23,0.95)',
          'text-halo-width': mobile ? 1.6 : 2.2,
          'text-halo-blur': 0.35,
        },
      })
    } else {
      m.setLayoutProperty('ends-label', 'text-size', endLabel)
      m.setLayoutProperty('ends-label', 'text-offset', [0, endOffset])
    }

    if (!m.getLayer('truck-halo')) {
      m.addLayer({
        id: 'truck-halo',
        type: 'circle',
        source: 'truck',
        paint: {
          'circle-radius': truckHalo,
          'circle-color': 'rgba(197, 225, 229, 0.3)',
          'circle-blur': 0.7,
          'circle-stroke-width': 0,
        },
      })
    } else {
      m.setPaintProperty('truck-halo', 'circle-radius', truckHalo)
    }

    if (!m.getLayer('truck')) {
      m.addLayer({
        id: 'truck',
        type: 'circle',
        source: 'truck',
        paint: {
          'circle-radius': truckR,
          'circle-color': '#C5E1E5',
          'circle-stroke-color': '#0D7C82',
          'circle-stroke-width': 2.5,
        },
      })
    } else {
      m.setPaintProperty('truck', 'circle-radius', truckR)
    }
  }

  function bindInteractions(m: MapLibreMapType) {
    m.off('click', 'cps-hit', onCpClick)
    m.off('click', 'cps', onCpClick)
    m.off('click', 'routes-hit', onRouteClick)
    m.off('mouseenter', 'cps-hit', onCpEnter)
    m.off('mouseleave', 'cps-hit', onCpLeave)
    m.off('mouseenter', 'routes-hit', onRouteEnter)
    m.off('mouseleave', 'routes-hit', onRouteLeave)

    m.on('click', 'cps-hit', onCpClick)
    m.on('click', 'cps', onCpClick)
    m.on('click', 'routes-hit', onRouteClick)
    m.on('mouseenter', 'cps-hit', onCpEnter)
    m.on('mouseleave', 'cps-hit', onCpLeave)
    m.on('mouseenter', 'routes-hit', onRouteEnter)
    m.on('mouseleave', 'routes-hit', onRouteLeave)
  }

  function onCpClick(e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) {
    const f = e.features?.[0]
    if (!f || !popup.current || !map.current) return
    const c = JSON.parse(String(f.properties?.payload)) as Checkpoint
    const routeId = String(f.properties?.routeId ?? '')
    const rank = Number(f.properties?.rank ?? 0)
    if (routeId) onSelectRef.current?.(routeId)
    popup.current
      .setLngLat(e.lngLat)
      .setHTML(popupHtml(c, routeRankLabel(rank)))
      .addTo(map.current)
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
    if (reduceMotion()) {
      src.setData(full)
      return
    }
    const start = performance.now()
    const dur = 780
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3.2)

    const tick = (now: number) => {
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

  function fitTrip(m: MapLibreMapType, d: PlanResponse, duration = 1100) {
    const b = new LngLatBounds()
    d.routes.forEach(r => r.geometry.forEach(p => b.extend(p as [number, number])))
    if (!b.isEmpty()) {
      const mobile = window.matchMedia('(max-width: 860px)').matches
      m.fitBounds(b, {
        padding: mobile
          // Bottom clears compact peek (trip + route cards); right clears forecast rail
          ? { top: 88, bottom: 200, left: 24, right: 52 }
          : { top: 96, bottom: 120, left: 56, right: 56 },
        maxZoom: 8.2,
        duration: reduceMotion() ? 0 : duration,
        essential: true,
        easing: (t) => 1 - Math.pow(1 - t, 3.4),
      })
    }
  }

  function heatOpacity() {
    return window.matchMedia('(max-width: 860px)').matches ? 0.7 : HEAT_OPACITY
  }

  function applyHeatPaint(m: MapLibreMapType) {
    if (!m.getLayer('heat-layer')) return
    const h = hourRef.current
    m.setPaintProperty('heat-layer', 'heatmap-weight', ['coalesce', ['get', `w${h}`], 0])
    m.setPaintProperty('heat-layer', 'heatmap-opacity', heatOpacity() * (dimRef.current ? 0.35 : 1))
    m.setLayoutProperty(
      'heat-layer',
      'visibility',
      heatRef.current && (dataRef.current?.heatmap?.points?.length ?? 0) > 0 ? 'visible' : 'none',
    )
  }

  /** Paint-only hour swap. Point positions stay fixed (corridor ribbon); weights change. */
  function crossfadeHeatHour(m: MapLibreMapType, nextHour: number) {
    cancelAnimationFrame(heatRafRef.current)
    if (!m.getLayer('heat-layer')) return
    m.setPaintProperty('heat-layer', 'heatmap-weight', ['coalesce', ['get', `w${nextHour}`], 0])
    m.setPaintProperty('heat-layer', 'heatmap-opacity', heatOpacity() * (dimRef.current ? 0.35 : 1))
  }

  function syncTruck(m: MapLibreMapType) {
    if (!m.getSource('truck')) return
    const d = dataRef.current
    const selId = selectedRef.current
    const route = d
      ? (d.routes.find(r => r.id === selId) ?? d.routes.find(r => r.id === d.recommended) ?? null)
      : null
    const forecastIso = d?.heatmap?.times?.[hourRef.current] ?? null
    ;(m.getSource('truck') as GeoJSONSource).setData(
      truckCollection(route, depRef.current, forecastIso),
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
    if (m.getSource('heat')) {
      ;(m.getSource('heat') as GeoJSONSource).setData(heatCollection(d, sel))
    }
    syncTruck(m)
  }

  function clearPlan(m: MapLibreMapType) {
    drawnPlanRef.current = null
    popup.current?.remove()
    for (const id of ['routes', 'cps', 'heat', 'ends', 'truck'] as const) {
      const src = m.getSource(id) as GeoJSONSource | undefined
      src?.setData(emptyFC())
    }
    if (m.getLayer('heat-layer')) {
      m.setLayoutProperty('heat-layer', 'visibility', 'none')
    }
  }

  function syncAll() {
    const m = map.current
    const d = dataRef.current
    if (!m || !ready.current || !m.isStyleLoaded()) return

    try {
      ensureLayers(m)
      bindInteractions(m)

      if (!d) {
        clearPlan(m)
        return
      }

      const isNewPlan = drawnPlanRef.current !== d
      ;(m.getSource('cps') as GeoJSONSource).setData(
        cpsCollection(d, selectedRef.current),
      )
      ;(m.getSource('heat') as GeoJSONSource).setData(
        heatCollection(d, selectedRef.current),
      )
      ;(m.getSource('ends') as GeoJSONSource).setData(endsCollection(d))
      applyHeatPaint(m)
      syncTruck(m)

      if (isNewPlan) {
        drawnPlanRef.current = d
        fitTrip(m, d)
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

  useEffect(() => {
    const m = map.current
    if (!m) return
    if (ready.current && m.isStyleLoaded()) syncAll()
    else m.once('load', () => { ready.current = true; syncAll() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  useEffect(() => {
    const m = map.current
    if (!m || !data || !ready.current || !m.getSource('routes')) return
    syncSelection(m)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, data])

  useEffect(() => {
    const m = map.current
    if (!m || !m.getLayer('heat-layer')) return
    crossfadeHeatHour(m, hour)
    syncTruck(m)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hour])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    syncTruck(m)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departureIso, selectedId])

  useEffect(() => {
    const m = map.current
    if (!m || !m.getLayer('heat-layer')) return
    m.setLayoutProperty(
      'heat-layer',
      'visibility',
      showHeatmap && (data?.heatmap?.points?.length ?? 0) > 0 ? 'visible' : 'none',
    )
  }, [showHeatmap, data])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current || !m.getLayer('routes')) return
    const dimFactor = dimmed ? 0.35 : 1
    m.setPaintProperty('routes', 'line-opacity', [
      'case',
      ['==', ['get', 'selected'], 1], 1 * dimFactor,
      ALT_OPACITY * dimFactor,
    ])
    if (m.getLayer('routes-casing')) {
      m.setPaintProperty('routes-casing', 'line-opacity', [
        'case',
        ['==', ['get', 'selected'], 1], 0.92 * dimFactor,
        0.55 * dimFactor,
      ])
    }
    if (m.getLayer('cps')) {
      m.setPaintProperty('cps', 'circle-opacity', 1 * dimFactor)
    }
    if (m.getLayer('cps-casing')) {
      m.setPaintProperty('cps-casing', 'circle-opacity', [
        'case',
        ['==', ['get', 'selected'], 1], 0.92 * dimFactor,
        0.78 * dimFactor,
      ])
    }
    if (m.getLayer('heat-layer')) {
      m.setPaintProperty('heat-layer', 'heatmap-opacity', heatOpacity() * (dimmed ? 0.35 : 1))
    }
  }, [dimmed])

  useEffect(() => {
    if (!recenterToken) return
    const m = map.current
    const d = dataRef.current
    if (!m || !d || !ready.current) return
    fitTrip(m, d, 700)
  }, [recenterToken])

  return (
    <div
      id="map"
      ref={el}
      role="presentation"
      className={
        dimmed
          ? 'absolute inset-0 h-full w-full min-h-0 saturate-75 brightness-[0.92]'
          : 'absolute inset-0 h-full w-full min-h-0'
      }
    />
  )
}
