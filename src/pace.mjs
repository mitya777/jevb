// Two paces for the same actions.
//
// human (default): the page sees what a person produces — curved mouse travel,
//   hover before click, per-key typing with jitter, a reading pause after
//   navigation. Catches hover/focus/debounce/animation bugs that only show up
//   when input isn't instantaneous, and makes recordings watchable.
// agent: as fast as possible — direct clicks, fill() instead of keystrokes,
//   no pauses; waits only on the page itself (load + network idle, capped).

const rand = (min, max) => min + Math.random() * (max - min)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const PACES = ['human', 'agent']

export function resolvePace(pace) {
    const p = pace || process.env.JEVB_PACE || 'human'
    if (!PACES.includes(p)) throw new Error(`unknown pace "${p}" (human|agent)`)
    return p
}

// Mouse position per page, so human travel starts where the last move ended.
const cursor = new WeakMap()

async function humanMove(page, x, y) {
    const from = cursor.get(page) || { x: rand(100, 300), y: rand(100, 300) }
    const dist = Math.hypot(x - from.x, y - from.y)
    const steps = Math.max(8, Math.min(40, Math.round(dist / 18)))
    // Quadratic bezier with a random control point bows the path like a wrist.
    const cx = (from.x + x) / 2 + rand(-0.25, 0.25) * dist
    const cy = (from.y + y) / 2 + rand(-0.25, 0.25) * dist
    for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2 // ease in-out
        const px = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * cx + e ** 2 * x
        const py = (1 - e) ** 2 * from.y + 2 * (1 - e) * e * cy + e ** 2 * y
        await page.mouse.move(px, py)
        await sleep(rand(4, 14))
    }
    cursor.set(page, { x, y })
}

async function targetPoint(locator) {
    const box = await locator.boundingBox()
    if (!box) throw new Error('target has no bounding box (hidden or detached)')
    // Aim near the middle, not dead center.
    return { x: box.x + box.width * rand(0.35, 0.65), y: box.y + box.height * rand(0.35, 0.65) }
}

export async function click(page, locator, pace) {
    if (pace === 'agent') return locator.click({ timeout: 10_000 })
    await locator.scrollIntoViewIfNeeded({ timeout: 10_000 })
    await sleep(rand(120, 300))
    const { x, y } = await targetPoint(locator)
    await humanMove(page, x, y)
    await sleep(rand(80, 260)) // hover dwell
    await page.mouse.down()
    await sleep(rand(40, 110))
    await page.mouse.up()
}

export async function type(page, locator, text, pace) {
    if (pace === 'agent') {
        // fill() doesn't work on contenteditable editors in every framework;
        // fall back to an instant insertText there.
        try { return await locator.fill(text, { timeout: 10_000 }) } catch {
            await locator.click({ timeout: 10_000 })
            return page.keyboard.insertText(text)
        }
    }
    await click(page, locator, pace)
    for (const ch of text) {
        await page.keyboard.type(ch)
        await sleep(ch === ' ' ? rand(60, 180) : rand(35, 140))
        if (Math.random() < 0.03) await sleep(rand(250, 700)) // thinking pause
    }
}

export async function press(page, key, pace) {
    if (pace === 'human') await sleep(rand(120, 350))
    await page.keyboard.press(key)
}

// SPAs render after load/networkidle. Wait until there is text and it has
// stopped changing for two polls (capped), so checks don't judge a blank page.
async function rendered(page, { maxMs = 4_000, pollMs = 150 } = {}) {
    const started = Date.now()
    let last = -1, stable = 0
    while (Date.now() - started < maxMs) {
        const len = await page.evaluate(() => document.body?.innerText.length || 0).catch(() => 0)
        stable = len > 0 && len === last ? stable + 1 : 0
        if (stable >= 2) return
        last = len
        await sleep(pollMs)
    }
}

// After navigation or a click that changes the page, a person reads before
// acting. Scale with visible text, capped so tests stay bounded.
export async function settle(page, pace) {
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    // Both paces wait for the page itself (SPAs render after DOMContentLoaded);
    // only human adds a reading pause on top.
    await page.waitForLoadState('networkidle', { timeout: pace === 'agent' ? 3_000 : 5_000 }).catch(() => {})
    await rendered(page)
    if (pace === 'agent') return
    const chars = await page.evaluate(() => document.body?.innerText.length || 0).catch(() => 0)
    await sleep(Math.min(2500, 400 + chars / 8))
}

// The element that actually scrolls: the tallest overflow container if the
// app scrolls inside a panel (Treechat's feed does), else the document.
async function scrollTarget(page) {
    return page.evaluate(() => {
        const doc = document.scrollingElement
        let best = null
        for (const el of document.querySelectorAll('body *')) {
            if (el.scrollHeight <= el.clientHeight + 50 || el.clientHeight < innerHeight * 0.4) continue
            const oy = getComputedStyle(el).overflowY
            if (oy !== 'auto' && oy !== 'scroll') continue
            if (!best || el.scrollHeight > best.scrollHeight) best = el
        }
        if (!best || (doc.scrollHeight > doc.clientHeight + 50 && doc.scrollHeight >= best.scrollHeight)) {
            return { doc: true, x: innerWidth / 2, y: innerHeight / 2 }
        }
        best.setAttribute('data-jevb-scroller', '1')
        const r = best.getBoundingClientRect()
        return { doc: false, x: r.left + r.width / 2, y: r.top + Math.min(r.height, innerHeight) / 2 }
    })
}

const scrollPos = (page, doc) => page.evaluate((doc) => {
    const el = doc ? document.scrollingElement : document.querySelector('[data-jevb-scroller]')
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight }
}, doc)

// dy: pixels (negative = up), or 'end' / 'top'. 'end' on an infinite feed
// stops after maxMs.
export async function scroll(page, dy, pace, { maxMs = 20_000 } = {}) {
    const target = await scrollTarget(page)
    const to = dy === 'end' || dy === 'bottom' ? 'end' : dy === 'top' ? 'top' : null
    if (pace === 'agent') {
        if (!to) return page.mouse.wheel(0, Number(dy)).then(() => page.mouse.move(target.x, target.y))
        return page.evaluate(({ doc, to }) => {
            const el = doc ? document.scrollingElement : document.querySelector('[data-jevb-scroller]')
            el.scrollTo({ top: to === 'end' ? el.scrollHeight : 0, behavior: 'instant' }) // beat CSS scroll-behavior:smooth
        }, { doc: target.doc, to })
    }
    await humanMove(page, target.x + rand(-60, 60), target.y + rand(-40, 40))
    if (!to) {
        const ticks = Math.max(1, Math.round(Math.abs(dy) / 120))
        for (let i = 0; i < ticks; i++) {
            await page.mouse.wheel(0, Math.sign(dy) * rand(90, 150))
            await sleep(rand(30, 90))
        }
        return sleep(rand(200, 500))
    }
    // Flick-and-read until the position stops moving (or maxMs on infinite feeds).
    const dir = to === 'end' ? 1 : -1
    const started = Date.now()
    let last = -1, still = 0
    while (Date.now() - started < maxMs) {
        const burst = Math.round(rand(3, 6))
        for (let i = 0; i < burst; i++) {
            await page.mouse.wheel(0, dir * rand(160, 260))
            await sleep(rand(25, 60))
        }
        await sleep(rand(250, 650)) // glance at what scrolled in
        const { top, max } = await scrollPos(page, target.doc)
        if ((dir > 0 && top >= max - 2) || (dir < 0 && top <= 0)) break
        still = Math.abs(top - last) < 2 ? still + 1 : 0
        if (still >= 2) break
        last = top
    }
    await sleep(rand(300, 600))
}
