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
import { judge } from './judge.mjs'
import { labelControls, labelerEnabled, locateControl } from './labeler.mjs'
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

// Labels that say nothing: the element type standing in for a missing name.
const GENERIC_LABEL = /^(button|imagebutton|imageview|image|view|viewgroup|other|framelayout|linearlayout|clickable|)$/i

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
        const snap = deviceSnapshot(await s.wd.source(), s.screen)
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
        let { target, el, checks: checkResults, snap } = await this.judge(s, { intent, checks })
        const weak = () => target.id === 'none' || target.confidence < this.minConfidence || !el
        // Unlabeled icons (an app's menu button reads as a bare "Button"):
        // have Haiku name them from a screenshot and ask again, once.
        const labeled = weak() && snap && await this.labelUnlabeled(s, snap)
        if (labeled) {
            ({ target, el } = await this.judge(s, { intent, snap: labeled }))
            target.labeled = labeled.labeled
        }
        // Not in the tree at all (a clickable div with no role): find it on
        // the screenshot, computer-use style, and tap there.
        const seen = weak() && await this.locateVisually(s, intent)
        if (seen) ({ target, el } = seen)
        if (weak()) {
            throw Object.assign(new Error(`no confident match for "${intent}"`), { code: 'NO_MATCH', detail: target, checks: checkResults })
        }
        return { s, el, target, checks: checkResults }
    }

    // Name a native screen's unlabeled controls with Claude Haiku (see
    // labeler.mjs): one screenshot, positions as fractions of the screen.
    // Returns a relabelled copy of snap, or null (web page, nothing unlabeled,
    // no ANTHROPIC_API_KEY, or the call failed).
    async labelUnlabeled(s, snap) {
        if (s.webContext || !labelerEnabled()) return null // pages get class/icon hints instead
        const todo = snap.elements.filter((e) => e.rect && GENERIC_LABEL.test(e.label.trim()))
        if (!todo.length) return null
        const png = await this.native(s, () => s.wd.screenshot())
        const { w, h } = s.screen
        const controls = todo.map((e) => ({ id: e.id, box: { x: e.rect.x / w, y: e.rect.y / h, w: e.rect.w / w, h: e.rect.h / h } }))
        let res
        try {
            res = await labelControls(png, controls, { context: `${s.platform} app` })
        } catch (e) {
            if (!this.labelWarned) this.log(`labeling unlabeled controls failed: ${e.message.slice(0, 160)}`)
            this.labelWarned = true
            return null
        }
        const named = todo.filter((e) => typeof res.labels[e.id] === 'string' && res.labels[e.id].trim())
        if (!named.length) return null
        this.log(`Haiku named ${named.length} unlabeled controls in ${res.ms}ms${res.cached ? ' (cached)' : ''}`)
        const label = new Map(named.map((e) => [e.id, res.labels[e.id].trim().replace(/"/g, "'").slice(0, 80)]))
        return {
            ...snap,
            labeled: named.length,
            elements: snap.elements.map((e) => (label.has(e.id)
                ? { ...e, label: label.get(e.id), desc: e.desc.replace(/^(\S+) "[^"]*"/, `$1 "${label.get(e.id)}"`) }
                : e)),
        }
    }

    // Returns { target, el } for a tap point found on the screenshot, or null
    // (web page, no ANTHROPIC_API_KEY, or the model found nothing).
    async locateVisually(s, intent) {
        if (s.webContext || !labelerEnabled()) return null // pages expose clickable divs to the DOM snapshot
        const png = await this.native(s, () => s.wd.screenshot())
        let at
        try {
            at = await locateControl(png, intent)
        } catch (e) {
            this.log(`locating "${intent}" on the screenshot failed: ${e.message.slice(0, 160)}`)
            return null
        }
        if (!at) return null
        const k = at.width / s.screen.w // screenshot px per screen unit
        const [x, y] = [Math.round(at.x / k), Math.round(at.y / k)]
        this.log(`located "${intent}" on the screenshot at ${x},${y} in ${at.ms}ms (not in the accessibility tree)`)
        const el = { id: 'visual', role: 'visual', label: intent, x, y, rect: { x: x - 10, y: y - 10, w: 20, h: 20 }, desc: `visual target for "${intent}" at ${x},${y}` }
        return { el, target: { id: 'visual', confidence: 1, desc: el.desc, visual: true, model: process.env.JEVB_LOCATE_MODEL || 'claude-sonnet-5' } }
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
        const field = el.web ? tapped : await s.wd.activeElement()
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
    // iOS also has Screenshot, and ScreenshotEditor (take one, then open its
    // thumbnail in the markup editor, which shares the image itself).
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

    // Bring another installed app (Settings, Photos, ...) to the front.
    async launch(app, { session, pace: p } = {}) {
        const s = this.session(session)
        if (!app) throw new Error('launch needs a bundle id (iOS) or package (Android)')
        await this.native(s, () => s.wd.execute('mobile: activateApp', [s.platform === 'ios' ? { bundleId: app } : { appId: app }]))
        await this.settle(s, pace.resolvePace(p || this.pace))
        return { launched: app }
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
        } else if (key === 'Screenshot' || key === 'ScreenshotEditor') {
            // The HID consumer "Snapshot" usage: iOS takes a screenshot, as
            // from side + volume up.
            await s.wd.execute('mobile: performIoHidEvent', [{ page: 0x0c, usage: 0x65, durationSeconds: 0.05 }])
            if (key === 'ScreenshotEditor') {
                // The thumbnail sits bottom-left for ~5s and is SpringBoard's,
                // outside the app's tree, so tap where it lands. It can take
                // 1-2s to slide in on a busy host; a second tap lands on the
                // image inside the opened editor, which does nothing.
                const { w, h } = s.screen
                for (const wait of [1500, 1000]) {
                    await sleep(wait)
                    await s.wd.actions([{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: [
                        { type: 'pointerMove', duration: 0, x: Math.round(w * 0.2), y: Math.round(h * 0.86) },
                        { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 80 }, { type: 'pointerUp', button: 0 },
                    ] }])
                }
            }
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

    async checks(items, { session } = {}) {
        return (await this.judge(this.session(session), { checks: items })).checks
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
