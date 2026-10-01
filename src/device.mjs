// Real phones over Appium, with the same surface as JevBrowser: Jev picks
// what to tap from the device's accessibility tree, checks judge the text on
// screen. Devices come from AWS Device Farm (metered per device-minute) or,
// with JEVB_APPIUM_URL set, a local Appium server (simulator/emulator/USB).
//
// Apps are read from the native accessibility tree (NATIVE_APP context).
// Mobile web (Safari/Chrome on the device) is read from the page itself,
// with the same in-page snapshot the desktop browser uses: a long page's
// native tree is slow to build (a busy feed page took 44s on an iPhone)
// and can't tell hidden elements from shown ones cheaply. Gestures and
// screenshots stay native.
import fs from 'node:fs'
import path from 'node:path'
import { deviceSnapshot, shortlist } from './device-snapshot.mjs'
import { collect, readState } from './snapshot.mjs'
import { startSession } from './devicefarm.mjs'
import { judge, waitForChecks, waitUntil } from './judge.mjs'
import { locateControl, locateEnabled, screenText } from './locate.mjs'
import * as pace from './pace.mjs'
import { ACTIONS, trackBusy } from './idle.mjs'
import { WebDriver } from './webdriver.mjs'

// Short by default: an idle device is still billed. Device Farm itself ends
// a session after 5 minutes without commands.
const DEFAULT_IDLE_MS = Number(process.env.JEVB_DEVICE_IDLE_MS || 180_000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = (a, b) => a + Math.random() * (b - a)

// In-page scroll for agent pace (self-contained: sent through WebDriver).
// Same target as the desktop: the tallest scrolling panel if the app scrolls
// inside one (many feeds do), else the document.
function scrollPage(to, dy) {
    const doc = document.scrollingElement
    let best = null
    for (const el of document.querySelectorAll('body *')) {
        if (el.scrollHeight <= el.clientHeight + 50 || el.clientHeight < innerHeight * 0.4) continue
        const oy = getComputedStyle(el).overflowY
        if (oy !== 'auto' && oy !== 'scroll') continue
        if (!best || el.scrollHeight > best.scrollHeight) best = el
    }
    const el = !best || (doc.scrollHeight > doc.clientHeight + 50 && doc.scrollHeight >= best.scrollHeight) ? doc : best
    if (to) el.scrollTo({ top: to === 'end' ? el.scrollHeight : 0, behavior: 'instant' })
    else el.scrollBy({ top: dy, behavior: 'instant' })
}


const ANDROID_KEYS = { Enter: 66, Back: 4, Home: 3, Tab: 61, Escape: 111, Backspace: 67, Delete: 67 }

export class JevDevice {
    constructor({ idleMs = DEFAULT_IDLE_MS, pace: p, minConfidence = 0.5, log = () => {} } = {}) {
        Object.assign(this, { idleMs, minConfidence, log })
        this.pace = pace.resolvePace(p)
        this.step = ''
        this.jevRequests = 0
        this.jevTokens = { input: 0, output: 0 }
        this.demo = false
        this.sessions = new Map() // name -> { wd, platform, screen, remote, web, device }
        this.expired = new Set()
        this.idleTimer = null
        trackBusy(this, ACTIONS)
    }

    touch() {
        clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => (this.busy ? this.touch() : this.shutdown('idle')), this.idleMs)
        this.idleTimer.unref?.()
    }

    async shutdown(reason = 'stop') {
        clearTimeout(this.idleTimer)
        const names = [...this.sessions.keys()]
        await Promise.all(names.map((n) => this.release(n)))
        if (reason === 'idle') names.forEach((n) => this.expired.add(n))
        if (names.length) this.log(`devices released (${reason}): ${names.join(', ')}`)
        return { videos: [] }
    }

    async release(name) {
        const s = this.sessions.get(name)
        if (!s) return
        this.sessions.delete(name)
        await s.wd.deleteSession()
        await s.remote?.stop()
    }

    has(name = 'default') { return this.sessions.has(name) || this.expired.has(name) }

    status() {
        return {
            devices: [...this.sessions].map(([name, s]) => ({ session: name, device: s.device, platform: s.platform, remote: s.remote?.arn || 'local' })),
            pace: this.pace, idleMs: this.idleMs,
        }
    }

    session(name = 'default') {
        this.touch()
        if (this.expired.has(name)) {
            throw Object.assign(new Error(`device session "${name}" was released after ${this.idleMs}ms idle; open it again`), { code: 'SESSION_EXPIRED' })
        }
        const s = this.sessions.get(name)
        if (!s) throw Object.assign(new Error(`no device session "${name}"; open one with --device`), { code: 'NO_SESSION' })
        return s
    }

    // Provision a device and start an Appium session on it.
    async start(name, { device, platform, app, url }) {
        const local = process.env.JEVB_APPIUM_URL
        platform = platform?.toLowerCase() || (/iphone|ipad|ios/i.test(device || '') || /\.ipa$/.test(app || '') ? 'ios' : 'android')
        let remote = null
        if (!local) {
            remote = await startSession({ device, platform, app, log: this.log })
            platform = remote.device.platform
        }
        const ios = platform === 'ios'
        const caps = {
            platformName: ios ? 'iOS' : 'Android',
            'appium:automationName': ios ? 'XCUITest' : 'UiAutomator2',
            'appium:newCommandTimeout': 300,
        }
        if (local) {
            if (device) caps['appium:deviceName'] = device
            if (process.env.JEVB_APPIUM_UDID) caps['appium:udid'] = process.env.JEVB_APPIUM_UDID
        }
        if (app && /^(https|s3):\/\//.test(app)) caps['appium:app'] = app
        else if (app && local && fs.existsSync(app)) caps['appium:app'] = path.resolve(app)
        else if (app && !fs.existsSync(app) && !app.startsWith('arn:')) caps[ios ? 'appium:bundleId' : 'appium:appPackage'] = app
        // Device Farm injects appium:app itself for an uploaded app.
        const web = !app && !!url
        if (web) caps.browserName = ios ? 'Safari' : 'Chrome'

        const wd = new WebDriver(remote?.endpoint || local)
        const t = Date.now()
        // WebDriverAgent sometimes fails to come up on a real iPhone; the
        // device is already allocated (and billed), so retry once on it.
        for (let attempt = 1; ; attempt++) {
            try {
                await wd.newSession(caps)
                break
            } catch (e) {
                if (attempt < 2 && e.code === 'WEBDRIVER') { this.log(`appium session failed (${e.message.slice(0, 120)}), retrying`); continue }
                await remote?.stop()
                throw e
            }
        }
        this.log(`appium session up in ${Date.now() - t}ms`)
        const s = { wd, platform, remote, web, webContext: null, device: remote?.device.name || device || platform, screen: null }
        if (web) {
            s.webContext = (await wd.contexts()).find((c) => c !== 'NATIVE_APP') || null
        }
        await wd.context('NATIVE_APP').catch(() => {})
        const r = await wd.windowRect()
        s.screen = { w: r.width, h: r.height }
        // XCUITest waits for the app to go idle and for animations to cool
        // off around each gesture; a live web page never does (a busy
        // stream swipe took 28s, 2.6s without). jevb settles on its own.
        if (web && ios) await wd.req('POST', wd.s('/appium/settings'), { settings: { waitForIdleTimeout: 0, animationCoolOffTimeout: 0, waitForQuiescence: false } })
        if (s.webContext) await wd.context(s.webContext)
        this.sessions.set(name, s)
        return s
    }

    // ---- screen reading --------------------------------------------------

    // Run fn in the native context (gestures, keyboard, full-screen shots)
    // and come back to the page.
    async native(s, fn) {
        if (!s.webContext) return fn()
        await s.wd.context('NATIVE_APP')
        try { return await fn() } finally { await s.wd.context(s.webContext) }
    }

    async readWeb(s) {
        const [elements, vw] = await s.wd.execute(`return [(${collect})(), innerWidth]`)
        const state = await s.wd.execute(`return (${readState})(arguments[0])`, [6000])
        // Off-screen sideways (a phone's slide-out sidebar parked at x<0) is
        // unreachable until something opens it; below the fold is a scroll away.
        const sideways = (e) => { const x = Number(e.desc.match(/ at (-?\d+),-?\d+$/)?.[1]); return !e.inView && (x < 0 || x >= vw) }
        return { platform: s.platform, elements: elements.filter((e) => !sideways(e)).map((e) => ({ ...e, web: true })), all: elements, state }
    }

    async read(s) {
        if (s.webContext) return this.readWeb(s)
        const snap = await this.withScreenText(s, deviceSnapshot(await s.wd.source(), s.screen))
        if (s.platform !== 'ios' || snap.state.modal_open) return snap
        // iOS system alerts (permission prompts) belong to SpringBoard and
        // are missing from the app's source on Device Farm; the alert API
        // still sees them. While one is up it is the only thing on screen.
        const text = await s.wd.req('GET', s.wd.s('/alert/text')).catch(() => null)
        if (text == null) return snap
        const buttons = await s.wd.execute('mobile: alert', [{ action: 'getButtons' }]).catch(() => [])
        return {
            ...snap,
            elements: buttons.map((b, i) => ({ id: `a${i + 1}`, role: 'button', label: b, alertButton: b, desc: `button "${b}" in system alert` })),
            state: { viewport_text: text, fields: [], modal_open: true, keyboard_open: false },
        }
    }

    // What the screen offers, for "has it stopped changing": the tappable
    // elements and where they are. Raw source is too noisy (an app's live
    // debug overlay or ticking counters would never settle).
    async layout(s) {
        const snap = s.webContext ? await this.readWeb(s) : deviceSnapshot(await s.wd.source(), s.screen)
        // All elements, sideways ones too: a slide-out menu moving in is not
        // settled. On a page also its text and load state, like the desktop
        // browser: an SPA's loading placeholder has a stable layout too.
        const page = snap.state && s.webContext ? `\n${snap.state.viewport_text.length} ${await s.wd.execute('return document.readyState')}` : ''
        return { snap, key: (snap.all || snap.elements).map((e) => e.desc).join('\n') + page, ready: !page || page.endsWith('complete') && snap.state.viewport_text.length > 0 }
    }

    // Checks judge what the screen shows, read from the screenshot (Haiku),
    // when an Anthropic key is set: an app's tree can lag the screen (Treechat's
    // Android tree kept the previous page while its feed was visible). When
    // the tree's text barely matches the screen, its elements are stale too,
    // so none are offered and a tap goes to the screenshot fallback.
    // JEVB_SCREEN_TEXT=off keeps the tree's text.
    async withScreenText(s, snap) {
        if (process.env.JEVB_SCREEN_TEXT === 'off' || !locateEnabled()) return snap
        let text
        try {
            text = await screenText(await s.wd.screenshot())
        } catch (e) {
            if (!this.textWarned) this.log(`reading the screen from its screenshot failed: ${e.message.slice(0, 160)}`)
            this.textWarned = true
            return snap
        }
        if (!text) return snap
        const words = (t) => (t || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2)
        const tree = words(snap.state.viewport_text), seen = new Set(words(text))
        const overlap = tree.length ? tree.filter((w) => seen.has(w)).length / tree.length : 1
        const stale = tree.length >= 5 && overlap < 0.3
        if (stale) this.log(`accessibility tree doesn't match the screen (${Math.round(overlap * 100)}% of its words shown); using the screenshot`)
        return {
            ...snap,
            elements: stale ? [] : snap.elements,
            state: { ...snap.state, viewport_text: text.slice(0, 6000), from_screenshot: true },
        }
    }

    // Wait for the layout to stop changing, capped. Human pace adds a
    // reading pause scaled by the text on screen.
    async settle(s, pc, { maxMs = 4_000 } = {}) {
        const started = Date.now()
        let last = null, cur
        while (Date.now() - started < maxMs) {
            cur = await this.layout(s)
            if (cur.key === last && cur.ready) break
            last = cur.key
            await sleep(250)
        }
        if (pc === 'agent') return
        await sleep(Math.min(2500, 400 + cur.snap.state.viewport_text.length / 8))
    }

    async judge(s, { intent, checks = [], snap }) {
        // One read shared by the choice and the checks (they run in parallel):
        // each read renumbers the page's elements, so two reads of a changing
        // page gave the pick an id from one and the lookup the other.
        let snapP = snap && Promise.resolve(snap)
        const read = () => (snapP ||= this.read(s))
        const res = await judge({
            intent, checks,
            options: async () => shortlist((await read()).elements, intent),
            state: async () => (await read()).state,
            where: async () => ({ platform: s.platform, device: s.device, ...(s.webContext && { browser: s.platform === 'ios' ? 'Safari' : 'Chrome', url: await s.wd.currentUrl() }) }),
        })
        this.jevRequests += res.requests
        this.jevTokens.input += res.usage.input
        this.jevTokens.output += res.usage.output
        const el = res.target && ((await snapP)?.elements || []).find((e) => e.id === res.target.id)
        return { target: res.target, el, checks: res.checks, snap: await snapP }
    }

    async find(intent, { session, checks } = {}) {
        const s = this.session(session)
        const weakFor = (t, e) => t.id === 'none' || t.confidence < this.minConfidence || !e
        // Wait until the target is on screen and the ride-along checks (which
        // describe the screen before the action) pass, or JEVB_WAIT_MS ends.
        // A screen with nothing usable in the tree (still loading, or a stale
        // tree) is a weak match, not an error: wait, then the screenshot.
        const attempt = () => this.judge(s, { intent, checks }).catch(async (e) => {
            if (e.code !== 'NO_ELEMENTS') throw e
            const r = checks?.length ? await this.judge(s, { checks }) : { checks: [] }
            return { target: { id: 'none', confidence: 1, desc: 'nothing on screen in the accessibility tree' }, el: null, checks: r.checks, snap: null }
        })
        const waited = await waitUntil(attempt, (r) => !weakFor(r.target, r.el) && r.checks.every((c) => c.pass))
        let { target, el, checks: checkResults, snap } = waited.result
        if (waited.tries > 1) Object.assign(target, { tries: waited.tries, waitedMs: waited.waitedMs })
        const weak = () => weakFor(target, el)
        // No confident match (an unnamed control, or one missing from the
        // tree like a clickable div with no role): Claude finds it on the
        // screenshot, computer-use style. Model-written labels for unnamed
        // controls were tried and dropped: Haiku got 3-4 of 8 right and a
        // wrong one ("Open navigation menu" on the floating New button) made
        // Jev tap it confidently.
        const seen = weak() && await this.locateVisually(s, intent, snap)
        if (seen) ({ target, el } = seen)
        if (weak()) {
            throw Object.assign(new Error(`no confident match for "${intent}"`), { code: 'NO_MATCH', detail: target, checks: checkResults })
        }
        return { s, el, target, checks: checkResults }
    }

    // Returns { target, el } for a tap point found on the screenshot, or null
    // (web page, no ANTHROPIC_API_KEY, or the model found nothing).
    async locateVisually(s, intent, snap) {
        if (s.webContext || !locateEnabled()) return null // pages expose clickable divs to the DOM snapshot
        const png = await this.native(s, () => s.wd.screenshot())
        let at
        try {
            at = await locateControl(png, intent)
        } catch (e) {
            this.log(`locating "${intent}" on the screenshot failed: ${e.message.slice(0, 160)}`)
            return null
        }
        if (!at) return null
        if (at.none) {
            this.log(`screenshot fallback for "${intent}" found nothing (${at.ms}ms): ${at.said || 'no click'}`)
            return null
        }
        const k = at.width / s.screen.w // screenshot px per screen unit
        const [x, y] = [Math.round(at.x / k), Math.round(at.y / k)]
        // A tree element that IS the pointed-at control (its center within ~6%
        // of the screen width of the point): tap its exact center. Not merely
        // containing the point - a composer box under an open sidebar also
        // contained the point for "Channels", and its center was 300px away.
        const near = 0.06 * s.screen.w
        const inside = (snap?.elements || []).filter((e) => e.rect && x >= e.rect.x && x <= e.rect.x + e.rect.w && y >= e.rect.y && y <= e.rect.y + e.rect.h
            && Math.hypot(e.x - x, e.y - y) <= near)
            .sort((p, q) => p.rect.w * p.rect.h - q.rect.w * q.rect.h)[0]
        const el = inside || { id: 'visual', role: 'visual', label: intent, x, y, rect: { x: x - 10, y: y - 10, w: 20, h: 20 }, desc: `visual target${at.said ? ` "${at.said.replace(/"/g, "'")}"` : ''} for "${intent}" at ${x},${y}` }
        this.log(`located "${intent}" on the screenshot at ${x},${y} in ${at.ms}ms${at.said ? ` ("${at.said}")` : ''}${inside ? ` -> ${inside.desc}` : ' (not in the accessibility tree)'}`)
        return { el, target: { id: el.id, confidence: 1, desc: el.desc, visual: true, model: process.env.JEVB_LOCATE_MODEL || 'claude-sonnet-5' } }
    }

    // ---- gestures --------------------------------------------------------

    async tap(s, el, pc) {
        if (el.alertButton) {
            if (pc === 'human') await sleep(rand(250, 700))
            return s.wd.execute('mobile: alert', [{ action: 'accept', buttonLabel: el.alertButton }])
        }
        if (el.web) {
            const id = await this.webElement(s, el)
            const ref = { 'element-6066-11e4-a52e-4f735466cecf': id }
            // Like Playwright: bring it into view first, clear of sticky
            // headers (Chrome refuses a click on a covered element).
            const r = await s.wd.execute('arguments[0].scrollIntoView({ block: "center", behavior: "instant" }); const r = arguments[0].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, vw: innerWidth }', [ref])
            if (pc === 'human') await sleep(rand(250, 700))
            if (s.platform === 'android') {
                await s.wd.req('POST', s.wd.s(`/element/${id}/click`), {})
                return id
            }
            // iOS: a real touch at the element's spot on screen. Appium's
            // nativeWebTap misplaces taps near the top of an iOS 27 Safari
            // page (they land on the status bar, so a top-left menu button
            // never opened).
            const dy = await this.pageTop(s)
            if (dy == null) { await s.wd.execute('arguments[0].click()', [ref]); return id }
            const k = s.screen.w / r.vw
            await this.native(s, () => s.wd.actions([{
                type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
                actions: [
                    { type: 'pointerMove', duration: 0, x: Math.round(r.x * k), y: Math.round(dy + r.y * k) },
                    { type: 'pointerDown', button: 0 },
                    { type: 'pause', duration: pc === 'human' ? Math.round(rand(60, 140)) : 40 },
                    { type: 'pointerUp', button: 0 },
                ],
            }]))
            return id
        }
        let { x, y } = el
        if (pc === 'human') {
            // A thumb lands near the middle, not on the exact center pixel.
            const r = el.rect
            x = Math.round(x + rand(-0.2, 0.2) * Math.min(r.w, s.screen.w))
            y = Math.round(y + rand(-0.2, 0.2) * Math.min(r.h, 80))
            await sleep(rand(250, 700)) // find it, move the thumb
        }
        await s.wd.actions([{
            type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
            actions: [
                { type: 'pointerMove', duration: 0, x, y },
                { type: 'pointerDown', button: 0 },
                { type: 'pause', duration: pc === 'human' ? Math.round(rand(60, 140)) : 40 },
                { type: 'pointerUp', button: 0 },
            ],
        }])
    }

    // Where the page's top edge is on screen (iOS), measured once per session:
    // Safari's web view spans the whole screen but the page starts below
    // the status bar. Take a short-labelled element on screen, find it in the
    // native tree (one lookup, ~4s), and compare the two vertical centres.
    async pageTop(s) {
        if (s.pageTop !== undefined) return s.pageTop
        const cands = await s.wd.execute(`return [...document.querySelectorAll('[data-jevb]')].map((e) => {
            const r = e.getBoundingClientRect()
            return { t: (e.getAttribute('aria-label') || e.innerText || '').trim(), y: r.y + r.height / 2, w: r.width }
        }).filter((c) => c.t && c.t.length <= 30 && !c.t.includes('\\n') && c.y > 0 && c.y < innerHeight && c.w < innerWidth * 0.9).slice(0, 3)`)
        const k = s.screen.w / (await s.wd.execute('return innerWidth'))
        s.pageTop = await this.native(s, async () => {
            for (const c of cands) {
                const found = await s.wd.req('POST', s.wd.s('/element'), { using: 'accessibility id', value: c.t }).catch(() => null)
                const nr = found && await s.wd.req('GET', s.wd.s(`/element/${Object.values(found)[0]}/rect`)).catch(() => null)
                const dy = nr && nr.y + nr.height / 2 - c.y * k
                if (dy >= 0 && dy <= 200) return dy
            }
            return null
        })
        this.log(`page top on screen: ${s.pageTop == null ? 'unknown (JS clicks)' : `${Math.round(s.pageTop)}pt`}`)
        return s.pageTop
    }

    // A field's current text; null when it can't be read. iOS reports an
    // empty field's placeholder as its value, so that counts as empty.
    async fieldValue(s, id, web) {
        if (web) return s.wd.req('GET', s.wd.s(`/element/${id}/property/value`)).catch(() => null)
        const [value, placeholder] = await Promise.all(['value', 'placeholderValue'].map((a) =>
            s.wd.req('GET', s.wd.s(`/element/${id}/attribute/${a}`)).catch(() => null)))
        return value === placeholder ? '' : value ?? ''
    }

    async webElement(s, el) {
        const found = await s.wd.req('POST', s.wd.s('/element'), { using: 'css selector', value: `[data-jevb="${el.id}"]` })
        return Object.values(found)[0]
    }

    async swipe(s, from, to, ms) {
        // Android web: gesture inside the page (Chromedriver touch, page px);
        // switching to native and back costs ~3.5s each way there.
        const inPage = s.webContext && s.platform === 'android'
        // Screen units → page px: scale by width, keep inside the visible
        // viewport (the screen also has the status bar and Chrome's toolbar).
        // Measured per swipe: it changes with the page and its zoom.
        const vp = inPage && await s.wd.execute('const v = window.visualViewport; return v ? { w: v.width, h: v.height } : { w: innerWidth, h: innerHeight }')
        const k = inPage ? vp.w / s.screen.w : 1
        const clamp = (v, max) => Math.min(Math.max(v, 1), max - 1)
        const pt = (p) => (inPage
            ? { x: Math.round(clamp(p.x * k, vp.w)), y: Math.round(clamp(p.y * k, vp.h)) }
            : { x: Math.round(p.x), y: Math.round(p.y) })
        const actions = [{
            type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
            actions: [
                { type: 'pointerMove', duration: 0, ...pt(from) },
                { type: 'pointerDown', button: 0 },
                { type: 'pause', duration: 40 },
                { type: 'pointerMove', duration: Math.round(ms), ...pt(to) },
                { type: 'pointerUp', button: 0 },
            ],
        }]
        if (inPage) return s.wd.actions(actions)
        return this.native(s, () => s.wd.actions(actions))
    }

    // ---- actions (same shapes as JevBrowser) -----------------------------

    async open(url, { session = 'default', pace: p, device, platform, app } = {}) {
        const pc = pace.resolvePace(p || this.pace)
        this.touch()
        this.expired.delete(session)
        let s = this.sessions.get(session)
        if (s && (device || app)) { await this.release(session); s = null }
        s ||= await this.start(session, { device, platform, app, url })
        if (url) {
            if (!s.webContext) throw new Error('this device session is an app, not a browser; open it with a url and no --app')
            await s.wd.url(url)
        }
        await this.settle(s, pc)
        return { device: s.device, platform: s.platform, ...(url && { url }), ...(s.remote && { deviceFarmSession: s.remote.arn, deviceStartMs: s.remote.startMs }) }
    }

    async act(intent, { session, pace: p, checks } = {}) {
        const pc = pace.resolvePace(p || this.pace)
        const { s, el, target, checks: checkResults } = await this.find(intent, { session, checks })
        await this.tap(s, el, pc)
        await this.settle(s, pc)
        return { tapped: target, checks: checkResults }
    }

    async type(intent, text, { session, pace: p, submit = false, checks } = {}) {
        const pc = pace.resolvePace(p || this.pace)
        const { s, el, target, checks: checkResults } = await this.find(intent, { session, checks })
        const tapped = await this.tap(s, el, pc)
        await sleep(pc === 'human' ? rand(300, 600) : 300) // keyboard comes up
        // Web fields and iOS append each element send. UiAutomator2 replaces
        // the whole value (and key events go through the IME, which
        // autocapitalizes), so native Android sets prefix + typed-so-far.
        const field = el.web ? tapped : await s.wd.activeElement().catch(() => null)
        // A stale tree (an Android WebView's) can hide the focused field from
        // WebDriver: the tap (often a screenshot one) focused it, so type as
        // key presses into whatever has focus. No read-back possible.
        if (!field) {
            await s.wd.actions([{ type: 'key', id: 'keyboard', actions: [...text].flatMap((c) => [{ type: 'keyDown', value: c }, { type: 'keyUp', value: c }]) }])
            await s.wd.releaseActions()
            if (submit) await this.press('Enter', { session, pace: pc })
            else await this.settle(s, pc)
            return { typed: target, chars: text.length, keys: true, checks: checkResults }
        }
        const replaces = !el.web && s.platform === 'android'
        const prefix = replaces ? el.value || '' : ''
        // Password fields read back masked, and their text must never reach a
        // log: no read-back for them.
        const secret = /password|secure/i.test(`${el.role} ${el.label}`)
        const before = replaces || secret ? '' : (await this.fieldValue(s, field, el.web)) ?? ''
        let typed = ''
        const send = (chunk) => { typed += chunk; return s.wd.sendKeysTo(field, replaces ? prefix + typed : chunk) }
        if (pc === 'agent') await send(text)
        else {
            for (let i = 0; i < text.length;) {
                const n = Math.min(text.length - i, Math.ceil(rand(0, 3)))
                await send(text.slice(i, i + n))
                i += n
                await sleep(rand(60, 180))
            }
        }
        // Read the field back: an iPhone dropped a chunk typed while its
        // keyboard was still coming up ("jevb demo" -> "jb demo"). If the
        // value is not what was typed, clear it and enter the text in one go.
        if (!replaces && !secret) {
            const expected = before + text
            let got = await this.fieldValue(s, field, el.web)
            for (let i = 0; i < 3 && got != null && got !== expected; i++) {
                await sleep(250) // the reported value can lag the last send
                got = await this.fieldValue(s, field, el.web)
            }
            if (got != null && got !== expected) {
                this.log(`field read back ${got.length} of ${expected.length} characters; re-entering`)
                await s.wd.req('POST', s.wd.s(`/element/${field}/clear`), {})
                await s.wd.sendKeysTo(field, expected)
            }
        }
        // The field's reported value lags the last send; settle so a check
        // right after sees it.
        if (submit) await this.press('Enter', { session, pace: pc })
        else await this.settle(s, pc)
        return { typed: target, chars: text.length, checks: checkResults }
    }

    // Enter, Back, Home, HideKeyboard (plus Tab/Escape/Backspace on Android).
    // iOS has no back button: Back is the left-edge swipe.
    async press(key, { session, pace: p } = {}) {
        const pc = pace.resolvePace(p || this.pace)
        const s = this.session(session)
        if (pc === 'human') await sleep(rand(120, 350))
        // On a web page, Enter and Back belong to the page; keyboard and
        // hardware keys are native.
        if (s.webContext && key === 'Enter') await s.wd.sendKeysTo(await s.wd.activeElement(), '\uE007')
        else if (s.webContext && key === 'Back') await s.wd.req('POST', s.wd.s('/back'), {})
        else await this.native(s, () => this.pressNative(s, key))
        await this.settle(s, pc)
        return { pressed: key }
    }

    async pressNative(s, key) {
        if (key === 'HideKeyboard') {
            const shown = () => s.wd.req('GET', s.wd.s('/appium/device/is_keyboard_shown'))
            if (await shown()) {
                // iOS web keyboards close from the ✓ ("Done") in the toolbar
                // above them, which iOS 27 reports as visible="false".
                const done = s.platform === 'ios' && await s.wd.req('POST', s.wd.s('/element'), { using: 'accessibility id', value: 'Done' }).catch(() => null)
                if (done) await s.wd.req('POST', s.wd.s(`/element/${Object.values(done)[0]}/click`), {})
                else await s.wd.execute('mobile: hideKeyboard', [{}]).catch(() => {})
                if (await shown()) throw new Error('keyboard is still shown after HideKeyboard')
            }
        } else if (s.platform === 'android') {
            const keycode = ANDROID_KEYS[key]
            if (!keycode) throw new Error(`unsupported key on Android: ${key}`)
            await s.wd.execute('mobile: pressKey', [{ keycode }])
        } else if (key === 'Enter') {
            await s.wd.sendKeysTo(await s.wd.activeElement(), '\n')
        } else if (key === 'Home') {
            await s.wd.execute('mobile: pressButton', [{ name: 'home' }])
        } else if (key === 'Back') {
            const { w, h } = s.screen
            await this.swipe(s, { x: 2, y: h / 2 }, { x: w * 0.7, y: h / 2 }, 250)
        } else throw new Error(`unsupported key on iOS: ${key}`)
    }

    // dy > 0 scrolls content down (finger swipes up). 'end'/'top' swipe until
    // the screen stops changing (capped for infinite feeds).
    // A phone gesture costs seconds (iOS ~3s), so the cap for infinite feeds
    // is longer than the browser's: a 6.5k-px page needs ~7 flicks.
    async scroll(dy = 600, { session, pace: p, maxMs = 45_000 } = {}) {
        const pc = pace.resolvePace(p || this.pace)
        const s = this.session(session)
        const { w, h } = s.screen
        const to = ['end', 'bottom'].includes(dy) ? 'end' : dy === 'top' ? 'top' : null
        // Agent pace on a web page scrolls the page directly, like the desktop
        // agent pace: a swipe through Device Farm costs ~2.6s on iOS, and the
        // four scrolls of the phone tour were 75s of a 120s agent run.
        if (pc === 'agent' && s.webContext) {
            await s.wd.execute(`(${scrollPage})(arguments[0], arguments[1])`, [to, to ? 0 : Number(dy) * (await s.wd.execute('return innerWidth')) / w])
            await this.settle(s, pc)
            return { scrolled: to || Number(dy) }
        }
        // To the end/top a person flicks (short, fast: the page glides on);
        // for a measured distance they drag.
        const swipeBy = async (dist) => {
            const x = w / 2 + (pc === 'human' ? rand(-w * 0.1, w * 0.1) : 0)
            const y0 = dist > 0 ? h * 0.75 : h * 0.25
            await this.swipe(s, { x, y: y0 }, { x: x + (pc === 'human' ? rand(-15, 15) : 0), y: y0 - dist },
                pc === 'agent' ? 180 : to ? rand(150, 260) : rand(250, 450))
        }
        if (!to) {
            let left = Number(dy)
            while (Math.abs(left) > 1) {
                const step = Math.sign(left) * Math.min(Math.abs(left), h * 0.5)
                await swipeBy(step)
                left -= step
                if (pc === 'human') await sleep(rand(200, 500))
            }
        } else {
            const started = Date.now()
            let last = (await this.layout(s)).key
            while (Date.now() - started < maxMs) {
                await swipeBy((to === 'end' ? 1 : -1) * h * 0.6)
                if (pc === 'human') await sleep(rand(250, 650))
                const cur = (await this.layout(s)).key
                if (cur === last) break
                last = cur
            }
        }
        await this.settle(s, pc)
        return { scrolled: to || Number(dy) }
    }

    async checks(items, { session, waitMs } = {}) {
        return waitForChecks(() => this.judge(this.session(session), { checks: items }).then((r) => r.checks), waitMs)
    }

    async check(question, { session, threshold, negate = false } = {}) {
        return (await this.checks([{ question, threshold, negate }], { session }))[0]
    }

    async snap({ session } = {}) {
        const s = this.session(session)
        const { elements, state } = await this.read(s)
        return { device: s.device, platform: s.platform, modal_open: state.modal_open, keyboard_open: state.keyboard_open, elements: elements.map((e) => `${e.id} ${e.desc}`) }
    }

    async screenshot(file, { session } = {}) {
        const s = this.session(session)
        // Native: the whole phone screen, browser chrome included.
        fs.writeFileSync(file, Buffer.from(await this.native(s, () => s.wd.screenshot()), 'base64'))
        return { path: file }
    }

    async close({ session = 'default' } = {}) {
        await this.release(session)
        return { closed: session }
    }

    async hud() {}
    async showDone() {}
}
