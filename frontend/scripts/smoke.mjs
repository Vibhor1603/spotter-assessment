/**
 * One-shot Playwright smoke: plan Denver→SLC and assert routes + heatmap HUD.
 * Run: node scripts/smoke.mjs  (expects make dev already up)
 */
import { chromium } from 'playwright'

const BASE = process.env.SMOKE_URL || 'http://localhost:5173'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))

try {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
  await page.getByRole('heading', { name: /Weather-Aware Routing/i }).waitFor()

  // Defaults are Denver / SLC — just submit
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push('console:' + msg.text())
  })
  await page.getByRole('button', { name: /Plan routes/i }).click()
  // Surface API error banner if plan fails
  const whyOrErr = page.locator('.why, .banner.error')
  await whyOrErr.first().waitFor({ timeout: 120000 })
  if (await page.locator('.banner.error').count()) {
    throw new Error('plan error: ' + await page.locator('.banner.error').innerText())
  }
  await page.getByText(/Why this route/i).waitFor({ timeout: 5000 })
  const cards = page.locator('.route-card')
  const n = await cards.count()
  if (n < 2) throw new Error(`expected >=2 route cards, got ${n}`)

  await page.locator('.map-hud').waitFor({ timeout: 10000 })
  await page.locator('.hour-slider').fill('12')
  await page.locator('.route-card').nth(1).click()

  // Click a checkpoint if map canvas is present
  const map = page.locator('#map')
  await map.waitFor()

  console.log(JSON.stringify({
    ok: true,
    routes: n,
    pageErrors: errors,
    why: await page.locator('.why p').innerText(),
  }, null, 2))
} catch (e) {
  console.error('SMOKE FAIL', e)
  await page.screenshot({ path: '/tmp/smoke-fail.png', fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
