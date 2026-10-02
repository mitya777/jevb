// On-demand headless Chromium. Nothing launches until the first action needs
// a page; after `idleMs` with no actions the browser is closed and relaunched
// (fresh) on the next one. Sessions are named browser contexts.
import { chromium } from 'playwright-core'
import { OVERLAY } from './demo.mjs'
import { judge, pickText } from './judge.mjs'
import * as pace from './pace.mjs'
import { ACTIONS, trackBusy } from './idle.mjs'
import { pageState, readState, shortlist, snapshot } from './snapshot.mjs'

const DEFAULT_IDLE_MS = Number(process.env.JEVB_IDLE_MS || 120_000)
// Attach to an already-running Chrome (see bin/jevb-chrome.sh) instead of
// launching Chromium. Sessions become tabs in that Chrome's own profile, so
// its cookies, sign-ins and Password Manager apply.
const CDP_URL = process.env.JEVB_CDP_URL || null
// In attached Chrome, idle and `stop` only detach and leave jevb's tabs open;
// `close` still closes its tab. JEVB_CLOSE_TABS=1 closes them on detach too.
const CLOSE_TABS = process.env.JEVB_CLOSE_TABS === '1'

export class JevBrowser {
    constructor({ idleMs = DEFAULT_IDLE_MS, pace: p, headless = process.env.JEVB_HEADED !== '1',
        viewport = { width: 1280, height: 800 }, minConfidence = 0.5, log = () => {},
        demo = process.env.JEVB_DEMO === '1', videoDir = process.env.JEVB_VIDEO || null, cdpUrl = CDP_URL } = {}) {
        Object.assign(this, { idleMs, headless, viewport, minConfidence, log, demo, videoDir, cdpUrl })
        this.step = ''
        this.jevRequests = 0
        this.jevTokens = { input: 0, output: 0 }
        this.pace = pace.resolvePace(p)
        this.browser = null
        this.launching = null
        this.sessions = new Map() // name -> { context, page }
        this.idleTimer = null
        // Sessions killed by idle shutdown. Acting on one (other than open)
        // throws, so a check can't silently "pass" against a blank page.
        this.expired = new Set()
        trackBusy(this, ACTIONS)
    }

    async ensureBrowser() {
        if (this.browser?.isConnected()) return this.browser
        this.launching ||= (async () => {
            const t = Date.now()
            // Prefer the slim headless shell Playwright installs; no Chrome window.
            const b = this.cdpUrl
                ? await chromium.connectOverCDP(this.cdpUrl)
                : await chromium.launch({ headless: this.headless })
            b.on('disconnected', () => { this.browser = null; this.sessions.clear(); this.overlayAdded = false })
            this.log(`${this.cdpUrl ? `attached to ${this.cdpUrl}` : 'chromium up'} in ${Date.now() - t}ms`)
            return b
        })()
        try { this.browser = await this.launching } finally { this.launching = null }
        return this.browser
    }

    touch() {
        clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => (this.busy ? this.touch() : this.shutdown('idle')), this.idleMs)
        this.idleTimer.unref?.()
    }

    async shutdown(reason = 'stop', { closeTabs = CLOSE_TABS } = {}) {
        clearTimeout(this.idleTimer)
        const b = this.browser
        this.browser = null
        if (reason === 'idle') for (const name of this.sessions.keys()) this.expired.add(name)
        // Close contexts first so recorded videos are finalized to disk.
        const videos = []
        for (const { context, page } of this.sessions.values()) {
            const v = page.video()
            // Attached Chrome: close only our tab (if asked); its profile context isn't ours.
            if (!this.cdpUrl) await context.close().catch(() => {})
            else if (closeTabs) await page.close().catch(() => {})
            if (v) videos.push(await v.path().catch(() => null))
        }
        this.sessions.clear()
        // For a CDP-attached browser, close() only disconnects; Chrome keeps running.
        if (b) { await b.close().catch(() => {}); this.log(`${this.cdpUrl ? 'detached' : 'chromium down'} (${reason})`) }
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
        if (this.cdpUrl) {
            // A new tab in Chrome's default (profile) context, at its real window size.
            const context = browser.contexts()[0]
            if (this.demo && !this.overlayAdded) { await context.addInitScript(OVERLAY); this.overlayAdded = true }
            s = { context, page: await context.newPage() }
            this.sessions.set(name, s)
            return s.page
        }
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

    // Jev judgments for one page state (see judge.mjs).
    async judge(page, { intent, checks = [] } = {}) {
        const res = await judge({
            intent, checks,
            options: async () => shortlist(await snapshot(page), intent),
            state: () => pageState(page),
            where: async () => ({ url: page.url(), title: await page.title() }),
        })
        this.jevRequests += res.requests
        this.jevTokens.input += res.usage.input
        this.jevTokens.output += res.usage.output
        await this.hud(page, res.summary)
        return { target: res.target, checks: res.checks }
    }

    // Jev picks which element an intent refers to. Low confidence or "none"
    // throws with the top candidates (and any batched check results) so the
    // calling agent can rephrase.
    async find(intent, { session, checks } = {}) {
        const page = await this.page(session)
        const { target, checks: checkResults } = await this.judge(page, { intent, checks })
        if (target.id === 'none' || target.confidence < this.minConfidence) {
            throw Object.assign(new Error(`no confident match for "${intent}"`), { code: 'NO_MATCH', detail: target, checks: checkResults })
        }
        return { page, locator: page.locator(`[data-jevb="${target.id}"]`), target, checks: checkResults }
    }

    async act(intent, { session, pace: p, checks } = {}) {
        const pc = pace.resolvePace(p || this.pace)
        const { page, locator, target, checks: checkResults } = await this.find(intent, { session, checks })
        // Some clicks navigate a beat later (after an analytics call, say).
        // Watch for a main-frame navigation request briefly and wait it out.
        // A navigation *request* comes before the new document commits, and
        // load-state waits in between resolve against the old document, so
        // wait for the main frame to actually navigate before settling.
        let onRequest
        const navigated = new Promise((resolve) => {
            onRequest = (req) => req.isNavigationRequest() && req.frame() === page.mainFrame() && resolve(true)
            page.on('request', onRequest)
            setTimeout(() => resolve(false), 1_200)
        })
        const committed = page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: 15_000 }).catch(() => null)
        await pace.click(page, locator, pc)
        await pace.settle(page, pc)
        if (await navigated) {
            await committed
            await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
            await pace.settle(page, pc)
        }
        page.off('request', onRequest)
        return { clicked: target, url: page.url(), checks: checkResults }
    }

    async type(intent, text, { session, pace: p, submit = false, checks } = {}) {
        const pc = pace.resolvePace(p || this.pace)
        const { page, locator, target, checks: checkResults } = await this.find(intent, { session, checks })
        await pace.type(page, locator, text, pc)
        if (submit) { await pace.press(page, 'Enter', pc); await pace.settle(page, pc) }
        return { typed: target, chars: text.length, checks: checkResults }
    }

    async press(key, { session, pace: p } = {}) {
        const page = await this.page(session)
        await pace.press(page, key, pace.resolvePace(p || this.pace))
        return { pressed: key }
    }

    async scroll(dy = 600, { session, pace: p } = {}) {
        const page = await this.page(session)
        const to = ['end', 'bottom', 'top'].includes(dy) ? dy : Number(dy)
        await pace.scroll(page, to, pace.resolvePace(p || this.pace))
        return { scrolled: to }
    }

    // Test assertions: Jev nouls over the visible page, all in one request.
    // pass = noul >= threshold (0.7), or for negate/refute noul < threshold (0.3).
    async checks(items, { session } = {}) {
        const page = await this.page(session)
        return (await this.judge(page, { checks: items })).checks
    }

    async check(question, { session, threshold, negate = false } = {}) {
        return (await this.checks([{ question, threshold, negate }], { session }))[0]
    }

    // `jevb read`: no question = what checks see (no Jev call); --full = the
    // whole document's text; a question = the on-screen block that answers
    // it, verbatim (one Jev choice, see pickText).
    async readText({ session, question, full = false } = {}) {
        const page = await this.page(session)
        if (full) return { url: page.url(), title: await page.title(), text: (await page.evaluate(() => document.body?.innerText || '')).slice(0, 50_000) }
        if (!question) return pageState(page)
        const state = await page.evaluate(readState, { maxText: 20_000, blocks: true })
        const count = (u) => { this.jevRequests++; this.jevTokens.input += u.input; this.jevTokens.output += u.output }
        try {
            // URL only: a <title> that differs from what's on screen ("Flow"
            // over an h1 "Thread") pulled "what's the heading?" to none.
            const res = await pickText({ question, blocks: state.blocks, minConfidence: this.minConfidence, where: async () => ({ url: page.url() }) })
            count(res.usage)
            const { usage, ...out } = res
            return out
        } catch (e) { if (e.usage) count(e.usage); throw e }
    }

    async snap({ session } = {}) {
        const page = await this.page(session)
        const els = await snapshot(page)
        return { url: page.url(), title: await page.title(), elements: els.map((e) => e.desc.replace(/^/, `${e.id} `)) }
    }

    // Run a function body in the page; returns what it returns.
    async evaluate(script, { session } = {}) {
        const page = await this.page(session)
        return { value: await page.evaluate(`(() => { ${script} })()`) }
    }

    async screenshot(path, { session, fullPage = false } = {}) {
        const page = await this.page(session)
        await page.screenshot({ path, fullPage })
        return { path }
    }

    async close({ session = 'default' } = {}) {
        const s = this.sessions.get(session)
        if (s) { await (this.cdpUrl ? s.page.close() : s.context.close()).catch(() => {}); this.sessions.delete(session) }
        if (!this.sessions.size) await this.shutdown('last session closed')
        return { closed: session }
    }
}
