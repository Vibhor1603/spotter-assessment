/**
 * Browser verification for map bugfix: Denver→SLC routes, checkpoints, heatmap.
 * Run: node scripts/verify-map.mjs  (expects make dev / vite+django already up)
 */
import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'

const BASE = process.env.SMOKE_URL || 'http://localhost:5173'
const OUT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../_vibhor/verify',
)
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push('page:' + String(e)))
page.on('console', msg => {
  if (msg.type() === 'error') errors.push('console:' + msg.text())
})

function mapDiag() {
  return page.evaluate(() => {
    const m = window.__spotterMap
    if (!m) return { found: false }
    const layers = m.getStyle().layers.map(l => l.id)
    let routeFeat = 0
    try { routeFeat = m.querySourceFeatures('routes').length } catch { /* empty */ }
    return {
      found: true,
      styleLoaded: m.isStyleLoaded(),
      layers,
      sources: Object.keys(m.getStyle().sources),
      hasRoutes: !!m.getLayer('routes'),
      hasCasing: !!m.getLayer('routes-casing'),
      hasCps: !!m.getLayer('cps'),
      hasHeat: !!m.getLayer('heat-layer'),
      heatVis: m.getLayer('heat-layer')
        ? m.getLayoutProperty('heat-layer', 'visibility')
        : null,
      heatWeight: m.getLayer('heat-layer')
        ? m.queryRenderedFeatures({ layers: ['heat-layer'] }).length
        : 0,
      routeFeat,
      zoom: m.getZoom(),
      center: [m.getCenter().lng, m.getCenter().lat],
    }
  })
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
  await page.getByRole('heading', { name: /Weather-Aware Routing/i }).waitFor()
  await page.locator('.brand').click()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: /Plan routes/i }).click({ force: true })
  await page.locator('.why, .banner.error').first().waitFor({ timeout: 120000 })
  if (await page.locator('.banner.error').count()) {
    throw new Error('plan error: ' + await page.locator('.banner.error').innerText())
  }
  await page.getByText(/Why this route/i).waitFor()
  await page.locator('.brand').click()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => {
    const m = window.__spotterMap
    return m && m.getLayer('routes') && m.querySourceFeatures('routes').length > 0
  }, null, { timeout: 20000 })
  // Let draw-in + fitBounds finish
  await page.waitForTimeout(1500)
  // Ensure autocomplete overlays are closed for clean screenshots
  await page.locator('.suggest').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})

  const afterPlan = await mapDiag()
  if (!afterPlan.hasRoutes || !afterPlan.hasCps) {
    throw new Error('missing layers after plan: ' + JSON.stringify(afterPlan))
  }
  await page.screenshot({ path: path.join(OUT, 'denver-slc-routes.png'), fullPage: true })

  // Heatmap at 0h / 24h / 48h
  for (const h of [0, 24, 47]) {
    await page.locator('.hour-slider').fill(String(h))
    await page.waitForTimeout(400)
    const d = await mapDiag()
    if (d.heatVis !== 'visible') {
      throw new Error(`heatmap not visible at hour ${h}: ${JSON.stringify(d)}`)
    }
    await page.screenshot({
      path: path.join(OUT, `heatmap-${h}h.png`),
      fullPage: true,
    })
  }

  // Toggle off / on
  await page.locator('.toggle input').uncheck()
  await page.waitForTimeout(300)
  let d = await mapDiag()
  if (d.heatVis !== 'none') throw new Error('heatmap toggle off failed: ' + JSON.stringify(d))
  await page.screenshot({ path: path.join(OUT, 'heatmap-off.png'), fullPage: true })

  await page.locator('.toggle input').check()
  await page.waitForTimeout(300)
  d = await mapDiag()
  if (d.heatVis !== 'visible') throw new Error('heatmap toggle on failed: ' + JSON.stringify(d))
  await page.screenshot({ path: path.join(OUT, 'heatmap-on.png'), fullPage: true })

  // Select alternate route via card
  await page.locator('.route-card').nth(1).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, 'route-selected-alt.png'), fullPage: true })

  const fatal = errors.filter(e =>
    !e.includes('favicon') && !e.includes('Decode') && !e.includes('tile'),
  )
  console.log(JSON.stringify({
    ok: true,
    afterPlan,
    pageErrors: fatal,
    screenshots: fs.readdirSync(OUT).filter(f => f.endsWith('.png')),
  }, null, 2))
  if (fatal.length) {
    console.error('Console errors present')
    process.exitCode = 1
  }
} catch (e) {
  console.error('VERIFY FAIL', e)
  await page.screenshot({ path: path.join(OUT, 'verify-fail.png'), fullPage: true }).catch(() => {})
  console.error('errors', errors)
  process.exitCode = 1
} finally {
  await browser.close()
}
