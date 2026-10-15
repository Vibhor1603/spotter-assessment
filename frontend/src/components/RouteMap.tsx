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
const ALT = '#5a6e72'
const CASING = '#061417'
/** Clear corridor heat without the neon blowout. */
const HEAT_OPACITY = 0.86

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

/** Soft glass-disk marker (Apple Maps–style) drawn to canvas for MapLibre images. */
function drawSoftDisk(opts: {
  size: number
  fill: string
  ring?: string
  ringWidth?: number
  glow?: string
  glyph?: 'start' | 'end'
}): HTMLCanvasElement {
  const dpr = 2
  const size = opts.size * dpr
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')!
  const cx = size / 2
  const cy = size / 2
  const coreR = size * 0.26

  // Ambient glow
  if (opts.glow) {
    const g = ctx.createRadialGradient(cx, cy, coreR * 0.35, cx, cy, size * 0.48)
    g.addColorStop(0, opts.glow)
    g.addColorStop(0.5, 'rgba(197,225,229,0.14)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }

  // Soft contact shadow
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy + dpr, coreR * 1.05, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0,0,0,0.3)'
  ctx.filter = `blur(${2.4 * dpr}px)`
  ctx.fill()
  ctx.restore()

  // Core disk
  ctx.beginPath()
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
  ctx.fillStyle = opts.fill
  ctx.fill()

  // Specular (glass highlight)
  const hi = ctx.createRadialGradient(
    cx - coreR * 0.35, cy - coreR * 0.4, 0,
    cx, cy, coreR,
  )
  hi.addColorStop(0, 'rgba(255,255,255,0.62)')
  hi.addColorStop(0.4, 'rgba(255,255,255,0.12)')
  hi.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.beginPath()
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
  ctx.fillStyle = hi
  ctx.fill()

  // Crisp ring
  if (opts.ring) {
    ctx.beginPath()
    ctx.arc(cx, cy, coreR - (opts.ringWidth ?? 1.5) * dpr * 0.35, 0, Math.PI * 2)
    ctx.strokeStyle = opts.ring
    ctx.lineWidth = (opts.ringWidth ?? 1.75) * dpr
    ctx.stroke()
  }

  // Tiny glyph for start / end
  if (opts.glyph === 'start') {
    ctx.fillStyle = 'rgba(6,20,23,0.9)'
    ctx.beginPath()
    const s = coreR * 0.42
    ctx.moveTo(cx - s * 0.35, cy - s)
    ctx.lineTo(cx - s * 0.35, cy + s)
    ctx.lineTo(cx + s * 0.85, cy)
    ctx.closePath()
    ctx.fill()
  } else if (opts.glyph === 'end') {
    ctx.fillStyle = 'rgba(6,20,23,0.88)'
    const s = coreR * 0.48
    ctx.fillRect(cx - s * 0.5, cy - s * 0.5, s, s)
  }

  return c
}

function toImageData(c: HTMLCanvasElement): ImageData {
  return c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
}

function ensureMarkerImages(m: MapLibreMapType) {
  if (!m.hasImage('mk-start')) {
    const start = drawSoftDisk({
      size: 36,
      fill: '#1A9AA3',
      ring: 'rgba(244,248,248,0.92)',
      ringWidth: 1.75,
      glow: 'rgba(26,154,163,0.55)',
      glyph: 'start',
    })
    m.addImage('mk-start', toImageData(start), { pixelRatio: 2 })
  }
  if (!m.hasImage('mk-end')) {
    const end = drawSoftDisk({
      size: 36,
      fill: '#F4F8F8',
      ring: 'rgba(13,124,130,0.85)',
      ringWidth: 1.85,
      glow: 'rgba(244,248,248,0.4)',
      glyph: 'end',
    })
    m.addImage('mk-end', toImageData(end), { pixelRatio: 2 })
  }
  if (!m.hasImage('mk-truck')) {
    const truck = drawSoftDisk({
      size: 32,
      fill: '#C5E1E5',
      ring: 'rgba(13,124,130,0.9)',
      ringWidth: 1.6,
      glow: 'rgba(197,225,229,0.5)',
    })
    m.addImage('mk-truck', toImageData(truck), { pixelRatio: 2 })
  }
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
    ensureMarkerImages(m)
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
          'heatmap-intensity': [
            'interpolate', ['linear'], ['zoom'],
            3, mobile ? 0.95 : 1.25,
            6, mobile ? 1.1 : 1.45,
            9, mobile ? 1.25 : 1.65,
            12, mobile ? 1.35 : 1.8,
          ],
          'heatmap-radius': [
            'interpolate', ['linear'], ['zoom'],
            3, mobile ? 16 : 28,
            5, mobile ? 22 : 38,
            7, mobile ? 28 : 48,
            9, mobile ? 34 : 58,
            11, mobile ? 40 : 68,
          ],
          'heatmap-opacity': mobile ? 0.78 : HEAT_OPACITY,
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(13,17,22,0)',
            0.08, 'rgba(45,164,78,0.5)',
            0.22, 'rgba(45,164,78,0.72)',
            0.4, 'rgba(212,167,44,0.8)',
            0.6, 'rgba(251,133,0,0.88)',
            0.8, 'rgba(207,34,46,0.94)',
            1, 'rgba(110,64,201,1)',
          ],
        },
      })
    } else {
      m.setPaintProperty('heat-layer', 'heatmap-intensity', [
        'interpolate', ['linear'], ['zoom'],
        3, mobile ? 0.95 : 1.25,
        6, mobile ? 1.1 : 1.45,
        9, mobile ? 1.25 : 1.65,
        12, mobile ? 1.35 : 1.8,
      ])
      m.setPaintProperty('heat-layer', 'heatmap-radius', [
        'interpolate', ['linear'], ['zoom'],
        3, mobile ? 16 : 28,
        5, mobile ? 22 : 38,
        7, mobile ? 28 : 48,
        9, mobile ? 34 : 58,
        11, mobile ? 40 : 68,
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
    const casingAlt = mobile ? 3 : 5.5
    const lineSel = mobile ? 3.25 : 5.5
    const lineAlt = mobile ? 1.5 : 2.25

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
          'line-opacity': 0.42,
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
    m.setPaintProperty('routes-casing', 'line-opacity', 0.92 * dimFactor)
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
    // Quiet alts so overlapping alternatives don’t read as a second parallel path
    m.setPaintProperty('routes', 'line-opacity', [
      'case',
      ['==', ['get', 'selected'], 1], 1 * dimFactor,
      0.28 * dimFactor,
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

    // Soft glass stops: glow bloom → white ring → risk core. Compact on phone; fat hit targets.
    const cpGlowSel = mobile ? 11 : 15
    const cpGlowAlt = mobile ? 8 : 11
    const cpRingSel = mobile ? 6.5 : 8.5
    const cpRingAlt = mobile ? 4.5 : 6
    const cpCoreSel = mobile ? 4.25 : 5.5
    const cpCoreAlt = mobile ? 3 : 4
    const endLabel = mobile ? 11 : 13
    const endOffset = mobile ? 1.7 : 2.05
    const iconSize = mobile ? 0.72 : 0.92
    const truckIcon = mobile ? 0.62 : 0.78

    if (!m.getLayer('cps-hit')) {
      m.addLayer({
        id: 'cps-hit',
        type: 'circle',
        source: 'cps',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            4, mobile ? 18 : 16,
            8, mobile ? 22 : 22,
            12, mobile ? 26 : 28,
          ],
          'circle-color': '#fff',
          'circle-opacity': 0,
        },
      })
    } else {
      m.setPaintProperty('cps-hit', 'circle-radius', [
        'interpolate', ['linear'], ['zoom'],
        4, mobile ? 18 : 16,
        8, mobile ? 22 : 22,
        12, mobile ? 26 : 28,
      ])
    }

    // Soft color bloom under each stop
    if (!m.getLayer('cps-glow')) {
      m.addLayer({
        id: 'cps-glow',
        type: 'circle',
        source: 'cps',
        paint: {
          'circle-radius': [
            'case',
            ['==', ['get', 'selected'], 1],
            ['+', cpGlowSel, ['*', ['coalesce', ['get', 'riskLevel'], 0], 1.1]],
            ['+', cpGlowAlt, ['*', ['coalesce', ['get', 'riskLevel'], 0], 0.7]],
          ],
          'circle-color': ['get', 'color'],
          'circle-opacity': [
            'case',
            ['==', ['get', 'selected'], 1], 0.38,
            0.16,
          ],
          'circle-blur': 0.85,
        },
      })
    } else {
      m.setPaintProperty('cps-glow', 'circle-radius', [
        'case',
        ['==', ['get', 'selected'], 1],
        ['+', cpGlowSel, ['*', ['coalesce', ['get', 'riskLevel'], 0], 1.1]],
        ['+', cpGlowAlt, ['*', ['coalesce', ['get', 'riskLevel'], 0], 0.7]],
      ])
    }

    // Crisp mist ring (Apple-style edge)
    if (!m.getLayer('cps-ring')) {
      m.addLayer({
        id: 'cps-ring',
        type: 'circle',
        source: 'cps',
        paint: {
          'circle-radius': [
            'case',
            ['==', ['get', 'selected'], 1], cpRingSel,
            cpRingAlt,
          ],
          'circle-color': '#ffffff',
          'circle-opacity': 0,
          'circle-stroke-color': 'rgba(244,248,248,0.92)',
          'circle-stroke-width': mobile ? 1.5 : 2,
          'circle-stroke-opacity': [
            'case',
            ['==', ['get', 'selected'], 1], 0.95,
            0.45,
          ],
        },
      })
    } else {
      m.setPaintProperty('cps-ring', 'circle-radius', [
        'case',
        ['==', ['get', 'selected'], 1], cpRingSel,
        cpRingAlt,
      ])
      m.setPaintProperty('cps-ring', 'circle-stroke-width', mobile ? 1.5 : 2)
    }

    if (!m.getLayer('cps')) {
      m.addLayer({
        id: 'cps',
        type: 'circle',
        source: 'cps',
        paint: {
          'circle-radius': [
            'case',
            ['==', ['get', 'selected'], 1],
            ['+', cpCoreSel, ['*', ['min', ['coalesce', ['get', 'riskLevel'], 0], 3], 0.45]],
            cpCoreAlt,
          ],
          'circle-color': ['get', 'color'],
          'circle-opacity': [
            'case',
            ['==', ['get', 'selected'], 1], 1,
            0.42,
          ],
          'circle-blur': 0.05,
          'circle-stroke-width': 0,
        },
      })
    } else {
      m.setPaintProperty('cps', 'circle-radius', [
        'case',
        ['==', ['get', 'selected'], 1],
        ['+', cpCoreSel, ['*', ['min', ['coalesce', ['get', 'riskLevel'], 0], 3], 0.45]],
        cpCoreAlt,
      ])
      m.setPaintProperty('cps', 'circle-blur', 0.05)
      m.setPaintProperty('cps', 'circle-stroke-width', 0)
    }

    // Migrate legacy circle markers → symbol icons
    if (m.getLayer('ends-halo')) m.removeLayer('ends-halo')
    if (m.getLayer('ends-label')) m.removeLayer('ends-label')
    const endsLayer = m.getLayer('ends')
    if (endsLayer && endsLayer.type !== 'symbol') m.removeLayer('ends')
    const truckLayer = m.getLayer('truck')
    if (truckLayer && truckLayer.type !== 'symbol') m.removeLayer('truck')

    // Start / End — custom glass icons + label
    if (!m.getLayer('ends')) {
      m.addLayer({
        id: 'ends',
        type: 'symbol',
        source: 'ends',
        layout: {
          'icon-image': [
            'match', ['get', 'kind'],
            'start', 'mk-start',
            'mk-end',
          ],
          'icon-size': iconSize,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'text-field': ['get', 'label'],
          'text-font': pickLabelFont(m),
          'text-size': endLabel,
          'text-offset': [0, endOffset],
          'text-anchor': 'top',
          'text-letter-spacing': 0.02,
          'text-max-width': 8,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'symbol-sort-key': 10,
        },
        paint: {
          'text-color': '#FFFFFF',
          'text-halo-color': 'rgba(6,20,23,0.95)',
          'text-halo-width': mobile ? 1.6 : 2.2,
          'text-halo-blur': 0.35,
          'icon-opacity': 1,
        },
      })
    } else {
      m.setLayoutProperty('ends', 'icon-size', iconSize)
      m.setLayoutProperty('ends', 'text-size', endLabel)
      m.setLayoutProperty('ends', 'text-offset', [0, endOffset])
      m.setPaintProperty('ends', 'text-halo-width', mobile ? 1.6 : 2.2)
    }

    if (!m.getLayer('truck-halo')) {
      m.addLayer({
        id: 'truck-halo',
        type: 'circle',
        source: 'truck',
        paint: {
          'circle-radius': mobile ? 14 : 20,
          'circle-color': 'rgba(197, 225, 229, 0.32)',
          'circle-blur': 0.75,
          'circle-stroke-width': 0,
        },
      })
    } else {
      m.setPaintProperty('truck-halo', 'circle-radius', mobile ? 14 : 20)
      m.setPaintProperty('truck-halo', 'circle-blur', 0.75)
    }

    if (!m.getLayer('truck')) {
      m.addLayer({
        id: 'truck',
        type: 'symbol',
        source: 'truck',
        layout: {
          'icon-image': 'mk-truck',
          'icon-size': truckIcon,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': 1 },
      })
    } else {
      m.setLayoutProperty('truck', 'icon-size', truckIcon)
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

  function crossfadeHeatHour(m: MapLibreMapType, nextHour: number) {
    cancelAnimationFrame(heatRafRef.current)
    if (!m.getLayer('heat-layer')) return

    if (reduceMotion()) {
      m.setPaintProperty('heat-layer', 'heatmap-weight', ['coalesce', ['get', `w${nextHour}`], 0])
      m.setPaintProperty('heat-layer', 'heatmap-opacity', HEAT_OPACITY)
      return
    }

    const start = performance.now()
    const fade = 140
    const total = 320
    let swapped = false

    const tick = (now: number) => {
      if (map.current !== m || !m.getLayer('heat-layer')) return
      const t = now - start
      if (t < fade) {
        const u = t / fade
        m.setPaintProperty('heat-layer', 'heatmap-opacity', HEAT_OPACITY * (1 - u) + 0.18 * u)
        heatRafRef.current = requestAnimationFrame(tick)
        return
      }
      if (!swapped) {
        swapped = true
        m.setPaintProperty('heat-layer', 'heatmap-weight', ['coalesce', ['get', `w${nextHour}`], 0])
      }
      if (t < total) {
        const u = (t - fade) / (total - fade)
        m.setPaintProperty('heat-layer', 'heatmap-opacity', 0.18 * (1 - u) + HEAT_OPACITY * u)
        heatRafRef.current = requestAnimationFrame(tick)
        return
      }
      m.setPaintProperty('heat-layer', 'heatmap-opacity', HEAT_OPACITY)
    }
    heatRafRef.current = requestAnimationFrame(tick)
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
      ;(m.getSource('heat') as GeoJSONSource).setData(heatCollection(d))
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
      0.42 * dimFactor,
    ])
    if (m.getLayer('cps')) {
      m.setPaintProperty('cps', 'circle-opacity', [
        'case',
        ['==', ['get', 'selected'], 1], 1 * dimFactor,
        0.4 * dimFactor,
      ])
    }
    if (m.getLayer('heat-layer')) {
      m.setPaintProperty('heat-layer', 'heatmap-opacity', HEAT_OPACITY * (dimmed ? 0.35 : 1))
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
