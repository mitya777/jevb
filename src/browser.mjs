// On-demand headless Chromium. Nothing launches until the first action needs
// a page; after `idleMs` with no actions the browser is closed and relaunched
// (fresh) on the next one. Sessions are named browser contexts.
import { chromium } from 'playwright-core'
import { OVERLAY } from './demo.mjs'
import { ask } from './jev.mjs'
import * as pace from './pace.mjs'
import { pageState, shortlist, snapshot } from './snapshot.mjs'

const DEFAULT_IDLE_MS = Number(process.env.JEVB_IDLE_MS || 120_000)

export class JevBrowser {
    constructor({ idleMs = DEFAULT_IDLE_MS, pace: p, headless = process.env.JEVB_HEADED !== '1',
        viewport = { width: 1280, height: 800 }, minConfidence = 0.5, log = () => {},
        demo = process.env.JEVB_DEMO === '1', videoDir = process.env.JEVB_VIDEO || null } = {}) {
        Object.assign(this, { idleMs, headless, viewport, minConfidence, log, demo, videoDir })
        this.step = ''
        this.pace = pace.resolvePace(p)
        this.browser = null
        this.launching = null
        this.sessions = new Map() // name -> { context, page }
        this.idleTimer = null
        // Sessions killed by idle shutdown. Acting on one (other than open)
        // throws, so a check can't silently "pass" against a blank page.
        this.expired = new Set()
    }

    async ensureBrowser() {
        if (this.browser?.isConnected()) return this.browser
        this.launching ||= (async () => {
            const t = Date.now()
            // Prefer the slim headless shell Playwright installs; no Chrome window.
            const b = await chromium.launch({ headless: this.headless })
            b.on('disconnected', () => { this.browser = null; this.sessions.clear() })
            this.log(`chromium up in ${Date.now() - t}ms`)
            return b
        })()
        try { this.browser = await this.launching } finally { this.launching = null }
        return this.browser
    }

    touch() {
        clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => this.shutdown('idle'), this.idleMs)
        this.idleTimer.unref?.()
    }

    async shutdown(reason = 'stop') {
        clearTimeout(this.idleTimer)
        const b = this.browser
        this.browser = null
        if (reason === 'idle') for (const name of this.sessions.keys()) this.expired.add(name)
        // Close contexts first so recorded videos are finalized to disk.
        const videos = []
        for (const { context, page } of this.sessions.values()) {
            const v = page.video()
            await context.close().catch(() => {})
            if (v) videos.push(await v.path().catch(() => null))
        }
        this.sessions.clear()
        if (b) { await b.close().catch(() => {}); this.log(`chromium down (${reason})`) }
        for (const v of videos.filter(Boolean)) this.log(`video: ${v}`)
        return { videos: videos.filter(Boolean) }
    }

    async page(name = 'default', { fresh = false } = {}) {
        this.touch()
        if (this.expired.has(name) && !fresh) {
            throw Object.assign(new Error(`session "${name}" expired after ${this.idleMs}ms idle; open a url again`), { code: 'SESSION_EXPIRED' })
        }
        this.expired.delete(name)
        let s = this.sessions.get(name)
        if (s && !s.page.isClosed()) return s.page
        const browser = await this.ensureBrowser()
        const context = await browser.newContext({
            viewport: this.viewport,
            ...(this.videoDir && { recordVideo: { dir: this.videoDir, size: this.viewport } }),
        })
        if (this.demo) await context.addInitScript(OVERLAY)
        const page = await context.newPage()
        s = { context, page }
        this.sessions.set(name, s)
        return page
    }

    // Demo HUD: line 1 = current step, line 2 = what Jev decided.
    async hud(page, result = '') {
        if (!this.demo || !page) return
        const text = `[${this.pace}] ${this.step}${result ? `\n→ ${result}` : ''}`
        await page.evaluate((t) => window.__jevbHud?.(t), text).catch(() => {})
    }

    async showDone(text, { session } = {}) {
        if (!this.demo) return
        const page = await this.page(session).catch(() => null)
        await page?.evaluate((t) => window.__jevbDone?.(t), text).catch(() => {})
    }

    status() {
        return { browser: this.browser ? 'up' : 'down', pace: this.pace, sessions: [...this.sessions.keys()], idleMs: this.idleMs }
    }

    // ---- actions ---------------------------------------------------------

    async open(url, { session, pace: p } = {}) {
        const page = await this.page(session, { fresh: true })
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        await this.hud(page, `loaded ${page.url()}`)
        await pace.settle(page, pace.resolvePace(p || this.pace))
        return { url: page.url(), status: res?.status() ?? null, title: await page.title() }
    }

    // Jev picks which element an intent refers to. Low confidence or "none"
    // throws with the top candidates so the calling agent can rephrase.
    async find(intent, { session } = {}) {
        const page = await this.page(session)
        const all = await snapshot(page)
        const options = shortlist(all, intent)
        if (!options.length) throw Object.assign(new Error('no interactive elements on page'), { code: 'NO_ELEMENTS' })
        const criteria = Object.fromEntries(options.map((e) => [e.id, e.desc]))
        criteria.none = 'No element on the page matches the intent'
        const t = Date.now()
        const { answers } = await ask(
            { intent, page: { url: page.url(), title: await page.title() } },
            { target: { type: 'choice', instructions: 'Which page element should a user interact with to accomplish `intent`?', criteria } },
        )
        const a = answers.target
        const top = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]).slice(0, 3)
            .filter(([id, p], i) => i === 0 || p >= 0.01).map(([id, p]) => ({ id, p: +p.toFixed(3), desc: criteria[id] }))
        const result = { id: a.choice, confidence: a.confidence, desc: criteria[a.choice], jevMs: Date.now() - t, top }
        await this.hud(page, `Jev picked ${result.desc.replace(/ at \d+,\d+$/, '')}  conf ${a.confidence.toFixed(2)}  ${result.jevMs}ms`)
        if (a.choice === 'none' || a.confidence < this.minConfidence) {
            throw Object.assign(new Error(`no confident match for "${intent}"`), { code: 'NO_MATCH', detail: result })
        }
        return { page, locator: page.locator(`[data-jevb="${a.choice}"]`), ...result }
    }

    async act(intent, { session, pace: p } = {}) {
        const pc = pace.resolvePace(p || this.pace)
        const { page, locator, ...picked } = await this.find(intent, { session })
        await pace.click(page, locator, pc)
        await pace.settle(page, pc)
        return { clicked: picked, url: page.url() }
    }

    async type(intent, text, { session, pace: p, submit = false } = {}) {
        const pc = pace.resolvePace(p || this.pace)
        const { page, locator, ...picked } = await this.find(intent, { session })
        await pace.type(page, locator, text, pc)
        if (submit) { await pace.press(page, 'Enter', pc); await pace.settle(page, pc) }
        return { typed: picked, chars: text.length }
    }

    async press(key, { session, pace: p } = {}) {
        const page = await this.page(session)
        await pace.press(page, key, pace.resolvePace(p || this.pace))
        return { pressed: key }
    }

    async scroll(dy = 600, { session, pace: p } = {}) {
        const page = await this.page(session)
        await pace.scroll(page, Number(dy), pace.resolvePace(p || this.pace))
        return { scrolled: Number(dy) }
    }

    // Test assertion: Jev noul over the visible page. pass = noul >= threshold,
    // or with negate (refute) pass = noul < threshold.
    async check(question, { session, threshold, negate = false } = {}) {
        threshold = Number(threshold ?? (negate ? 0.3 : 0.7))
        const page = await this.page(session)
        const state = await pageState(page)
        const t = Date.now()
        const { answers } = await ask(state, {
            check: { type: 'noul', instructions: `Looking at the current page (\`visible_text\`, \`url\`, \`title\`): ${question}` },
        })
        const noul = answers.check.noul
        const ok = negate ? noul < threshold : noul >= threshold
        await this.hud(page, `Jev noul ${noul.toFixed(2)} ${negate ? '<' : '≥'} ${threshold}  ${ok ? 'PASS ✓' : 'FAIL ✗'}  ${Date.now() - t}ms`)
        return { question, noul, threshold, negate, pass: negate ? noul < threshold : noul >= threshold, jevMs: Date.now() - t }
    }

    async snap({ session } = {}) {
        const page = await this.page(session)
        const els = await snapshot(page)
        return { url: page.url(), title: await page.title(), elements: els.map((e) => e.desc.replace(/^/, `${e.id} `)) }
    }

    async screenshot(path, { session, fullPage = false } = {}) {
        const page = await this.page(session)
        await page.screenshot({ path, fullPage })
        return { path }
    }

    async close({ session = 'default' } = {}) {
        const s = this.sessions.get(session)
        if (s) { await s.context.close().catch(() => {}); this.sessions.delete(session) }
        if (!this.sessions.size) await this.shutdown('last session closed')
        return { closed: session }
    }
}
