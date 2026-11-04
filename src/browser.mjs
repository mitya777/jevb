// On-demand headless Chromium. Nothing launches until the first action needs
// a page; after `idleMs` with no actions the browser is closed and relaunched
// (fresh) on the next one. Sessions are named browser contexts.
import fs from 'node:fs'
import { chromium } from 'playwright-core'
import * as capture from './capture.mjs'
import { startCdpFilter } from './cdp-filter.mjs'
import { OVERLAY } from './demo.mjs'
import { judge, pickText, waitForChecks, waitUntil } from './judge.mjs'
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
const FOREGROUND = process.env.JEVB_FOREGROUND === '1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class JevBrowser {
    constructor({ idleMs = DEFAULT_IDLE_MS, pace: p, headless = process.env.JEVB_HEADED !== '1',
        viewport = { width: 1280, height: 800 }, minConfidence = 0.5, log = () => {},
        demo = process.env.JEVB_DEMO === '1', videoDir = process.env.JEVB_VIDEO || null, cdpUrl = CDP_URL } = {}) {
        Object.assign(this, { idleMs, headless, viewport, minConfidence, log, demo, videoDir, cdpUrl })
        this.step = ''
        this.jevRequests = 0
        this.jevTokens = { input: 0, output: 0 }
        this.pace = pace.resolvePace(p, demo || videoDir ? 'human' : 'fast')
        this.browser = null
        this.launching = null
        this.sessions = new Map() // name -> { context, page }
        this.idleTimer = null
        // Sessions killed by idle shutdown. Acting on one (other than open)
        // throws, so a check can't silently "pass" against a blank page.
        this.expired = new Set()
        // Text typed per session, as named values a capture turns into
        // parameters (see capture.mjs). In memory only.
        this.typed = new Map()
        this.helpers = new Map() // context -> captured page url -> page send reads tokens from
        trackBusy(this, [...ACTIONS, 'send'])
    }

    async ensureBrowser() {
        if (this.browser?.isConnected()) return this.browser
        this.launching ||= (async () => {
            const t = Date.now()
            // Prefer the slim headless shell Playwright installs; no Chrome window.
            // Attached: through a proxy that hides the user's own tabs, so a
            // hung one can't stall the attach (see cdp-filter.mjs).
            const b = this.cdpUrl
                ? await chromium.connectOverCDP(await startCdpFilter(this.cdpUrl, { log: this.log }))
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
        for (const byUrl of this.helpers.values()) for (const p of byUrl.values()) await p.close().catch(() => {})
        this.helpers.clear()
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
            s = { context, page: await this.newTab(browser, context) }
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

    // Attached browsers are the user's own, so open jevb's tab in the
    // background and leave their window where it is. JEVB_FOREGROUND=1 opts
    // back in to a focused tab (Chrome raises the window for it).
    async newTab(browser, context) {
        if (FOREGROUND) return context.newPage()
        const cdp = await browser.newBrowserCDPSession()
        try {
            const [page] = await Promise.all([
                context.waitForEvent('page'),
                cdp.send('Target.createTarget', { url: 'about:blank', background: true }),
            ])
            return page
        } finally { await cdp.detach().catch(() => {}) }
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
        const weak = (t) => t.id === 'none' || t.confidence < this.minConfidence
        // Wait until the target is on screen and the ride-along checks pass,
        // or JEVB_WAIT_MS ends (see waitUntil).
        const waited = await waitUntil(() => this.judge(page, { intent, checks }), (r) => !weak(r.target) && r.checks.every((c) => c.pass))
        const { target, checks: checkResults } = waited.result
        if (waited.tries > 1) Object.assign(target, { tries: waited.tries, waitedMs: waited.waitedMs })
        if (weak(target)) {
            throw Object.assign(new Error(`no confident match for "${intent}"`), { code: 'NO_MATCH', detail: target, checks: checkResults })
        }
        return { page, locator: page.locator(`[data-jevb="${target.id}"]`), target, checks: checkResults }
    }

    async act(intent, { session, pace: p, checks, capture: file } = {}) {
        const pc = pace.resolvePace(p || this.pace)
        const { page, locator, target, checks: checkResults } = await this.find(intent, { session, checks })
        // Some clicks navigate a beat later (after an analytics call, say).
        // Watch for a main-frame navigation request briefly and wait it out.
        // A navigation *request* comes before the new document commits, and
        // load-state waits in between resolve against the old document, so
        // wait for the main frame to actually navigate before settling.
        // Fast pace has no fixed window: it waits for the fetches the click
        // started to finish (cap 5s) and the network to be quiet ~100ms, then
        // re-checks the text, since their responses render after the first
        // settle. Not before 500ms: a click handler's timer that navigates
        // (no request first) is invisible until it fires.
        const pending = new Set()
        let onRequest, clickedAt, fetched = false, navRequested = false
        const onDone = (req) => pending.delete(req)
        const navigated = new Promise((resolve) => {
            onRequest = (req) => {
                if (req.isNavigationRequest() && req.frame() === page.mainFrame()) { navRequested = true; resolve(true) }
                else if (['fetch', 'xhr', 'ping', 'beacon'].includes(req.resourceType())) { pending.add(req); fetched = true }
            }
            page.on('request', onRequest)
            if (pc !== 'fast') setTimeout(() => resolve(false), 1_200)
        })
        const drain = async () => {
            for (let calm = 0; Date.now() - clickedAt < 5_000; await sleep(50)) {
                calm = pending.size ? 0 : calm + 1
                if (calm >= 2) return false
            }
            return false
        }
        const quiet = () => sleep(500).then(drain)
        if (pc === 'fast') { page.on('requestfinished', onDone); page.on('requestfailed', onDone) }
        const committed = page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: 15_000 }).catch(() => null)
        const rec = file && await this.startCapture(page)
        await pace.click(page, locator, pc)
        clickedAt = Date.now()
        const nav = pc === 'fast' ? Promise.race([navigated, quiet()]) : navigated
        await pace.settle(page, pc)
        let went = await nav
        if (!went && pc === 'fast') {
            // A fetch or a navigation can start after quiet() ended, during settle.
            await drain()
            went = navRequested
            if (!went && fetched) await pace.textSettled(page)
        }
        if (went) {
            await committed
            await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
            await pace.settle(page, pc)
        }
        page.off('request', onRequest)
        page.off('requestfinished', onDone)
        page.off('requestfailed', onDone)
        return { clicked: target, url: page.url(), checks: checkResults, ...(rec && { captured: await this.finishCapture(rec, file, session) }) }
    }

    // as: the parameter name a later capture gives this text (default TEXT_n).
    async type(intent, text, { session, pace: p, submit = false, checks, as, capture: file } = {}) {
        const pc = pace.resolvePace(p || this.pace)
        const { page, locator, target, checks: checkResults } = await this.find(intent, { session, checks })
        const typed = (this.typed.get(session || 'default') || []).filter((t) => t.name !== as)
        typed.push({ name: as || `TEXT_${typed.length + 1}`, value: text })
        this.typed.set(session || 'default', typed)
        // Before typing: a live search or autosave sends while keys go in.
        const rec = file && await this.startCapture(page)
        await pace.type(page, locator, text, pc)
        if (submit) { await pace.press(page, 'Enter', pc); await pace.settle(page, pc) }
        return { typed: target, chars: text.length, checks: checkResults, ...(rec && { captured: await this.finishCapture({ ...rec, lastPerEndpoint: true }, file, session) }) }
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
    async checks(items, { session, waitMs } = {}) {
        const page = await this.page(session)
        return waitForChecks(() => this.judge(page, { checks: items }).then((r) => r.checks), waitMs)
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

    // ---- capture / send (see capture.mjs) ---------------------------------

    // Token sources are read before the action: a login or checkout can
    // rotate them, and the request carried the old ones.
    async startCapture(page) {
        const reqs = [], done = new Set()
        const onRequest = (r) => {
            const type = r.resourceType()
            if (type === 'fetch' || type === 'xhr' || (type === 'document' && r.method() !== 'GET')) reqs.push(r)
        }
        const onDone = (r) => done.add(r)
        page.on('request', onRequest)
        page.on('requestfinished', onDone)
        page.on('requestfailed', onDone)
        return { page, reqs, done, onRequest, onDone, at: page.url(), sources: await capture.tokenSources(page) }
    }

    // lastPerEndpoint (type captures): keystrokes at human pace each send a
    // request with a prefix of the text (p, pr, pri...). Only the last one
    // per endpoint is the action, and the prefixes would leak the text.
    async finishCapture({ page, reqs, done, onRequest, onDone, at, sources, lastPerEndpoint }, file, session) {
        // Requests can start a beat after the action (debounced search,
        // autosave) or after another's response: record until all have
        // finished and none has started for 500ms (cap 10s).
        for (let n = -1, t = Date.now(); (n !== reqs.length || reqs.some((r) => !done.has(r))) && Date.now() - t < 10_000;) {
            n = reqs.length
            await new Promise((r) => setTimeout(r, 500))
        }
        page.off('request', onRequest)
        page.off('requestfinished', onDone)
        page.off('requestfailed', onDone)
        // Third-party calls (analytics, ads) aren't part of the action: the
        // browser's own same-site verdict (public-suffix aware) decides.
        // Redirect hops aren't either: send follows redirects itself, and
        // replaying a hop too would run a POST twice.
        const seen = await Promise.all(reqs.filter((r) => !r.redirectedFrom()).map(async (r) => ({ r, headers: await r.allHeaders() })))
        let own = seen.filter(({ headers }) => headers['sec-fetch-site'] !== 'cross-site')
        if (lastPerEndpoint) {
            const key = ({ r }) => `${r.method()} ${new URL(r.url()).origin}${new URL(r.url()).pathname}`
            own = own.filter((x, i) => !own.slice(i + 1).some((y) => key(y) === key(x)))
        }
        await Promise.all(own.map(({ r }) => r.response().catch(() => null)))
        const requests = own.map(({ r, headers }) => ({ method: r.method(), url: r.url(), headers, body: r.postData() }))
        const after = page.isClosed() ? [] : await capture.tokenSources(page)
        const cap = capture.build({ page: at, requests, params: this.typed.get(session || 'default') || [], sources: [...sources, ...after] })
        fs.writeFileSync(file, JSON.stringify(cap, null, 2) + '\n')
        return { file, requests: cap.requests.map((r) => `${r.method} ${r.url}`), params: cap.params }
    }

    // Replays a capture in this session's browser context: its cookies, and
    // tokens read fresh from the captured page, opened once in the
    // background and kept for the next send. Not a session's page: one on
    // the same origin can be a result page without the token.
    async send(file, { session, values } = {}) {
        const cap = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (cap.jevb !== 'capture/1') throw new Error(`${file} is not a jevb capture`)
        const context = (await this.page(session)).context()
        const sessionPage = await this.page(session)
        const pageFor = async (origin, { reload, tab } = {}) => {
            if (tab) {
                if (new URL(sessionPage.url()).origin !== origin) throw Object.assign(new Error(`a sessionStorage token lives in a tab on ${origin}; open it in this session first`), { code: 'SOURCE_GONE' })
                if (reload) await sessionPage.reload({ waitUntil: 'load', timeout: 45_000 })
                return sessionPage
            }
            const url = new URL(cap.page).origin === origin ? cap.page : origin
            const byUrl = this.helpers.get(context) || new Map()
            this.helpers.set(context, byUrl)
            let p = byUrl.get(url)
            if (!p || p.isClosed()) {
                p = this.cdpUrl ? await this.newTab(this.browser, context) : await context.newPage()
                await p.goto(url, { waitUntil: 'load', timeout: 45_000 })
                byUrl.set(url, p)
            } else if (reload) await p.reload({ waitUntil: 'load', timeout: 45_000 })
            return p
        }
        const t = Date.now()
        const results = await capture.send(cap, { context, pageFor, values })
        return { ok: results.every((r) => r.status < 400) && results.length === cap.requests.length, ms: Date.now() - t, results }
    }

    async close({ session = 'default' } = {}) {
        this.typed.delete(session)
        const s = this.sessions.get(session)
        if (s) { await (this.cdpUrl ? s.page.close() : s.context.close()).catch(() => {}); this.sessions.delete(session) }
        if (!this.sessions.size) await this.shutdown('last session closed')
        return { closed: session }
    }
}
