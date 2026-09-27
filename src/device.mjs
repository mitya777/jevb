// Real phones over Appium, with the same surface as JevBrowser: Jev picks
// what to tap from the device's accessibility tree, checks judge the text on
// screen. Devices come from AWS Device Farm (metered per device-minute) or,
// with JEVB_APPIUM_URL set, a local Appium server (simulator/emulator/USB).
//
// Mobile web runs in Safari/Chrome on the device, but snapshots and taps
// always use the native tree (NATIVE_APP context): one path for apps and
// web, and it sees system UI (alerts, keyboards, permission sheets) too.
import fs from 'node:fs'
import path from 'node:path'
import { deviceSnapshot, shortlist } from './device-snapshot.mjs'
import { startSession } from './devicefarm.mjs'
import { judge } from './judge.mjs'
import * as pace from './pace.mjs'
import { WebDriver } from './webdriver.mjs'

// Short by default: an idle device is still billed. Device Farm itself ends
// a session after 5 minutes without commands.
const DEFAULT_IDLE_MS = Number(process.env.JEVB_DEVICE_IDLE_MS || 180_000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = (a, b) => a + Math.random() * (b - a)

const ANDROID_KEYS = { Enter: 66, Back: 4, Home: 3, Tab: 61, Escape: 111, Backspace: 67, Delete: 67 }

export class JevDevice {
    constructor({ idleMs = DEFAULT_IDLE_MS, pace: p, minConfidence = 0.5, log = () => {} } = {}) {
        Object.assign(this, { idleMs, minConfidence, log })
        this.pace = pace.resolvePace(p)
        this.step = ''
        this.jevRequests = 0
        this.demo = false
        this.sessions = new Map() // name -> { wd, platform, screen, remote, web, device }
        this.expired = new Set()
        this.idleTimer = null
    }

    touch() {
        clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => this.shutdown('idle'), this.idleMs)
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
        try {
            await wd.newSession(caps)
        } catch (e) {
            await remote?.stop()
            throw e
        }
        this.log(`appium session up in ${Date.now() - t}ms`)
        const s = { wd, platform, remote, web, webContext: null, device: remote?.device.name || device || platform, screen: null }
        if (web) {
            s.webContext = (await wd.contexts()).find((c) => c !== 'NATIVE_APP') || null
        }
        await wd.context('NATIVE_APP').catch(() => {})
        const r = await wd.windowRect()
        s.screen = { w: r.width, h: r.height }
        this.sessions.set(name, s)
        return s
    }

    // ---- screen reading --------------------------------------------------

    async read(s) {
        return deviceSnapshot(await s.wd.source(), s.screen)
    }

    // Wait for the UI to stop changing (two identical sources), capped. Human
    // pace adds a reading pause scaled by the text on screen.
    async settle(s, pc, { maxMs = 4_000 } = {}) {
        const started = Date.now()
        let last = null, snap
        while (Date.now() - started < maxMs) {
            const src = await s.wd.source()
            if (src === last) { snap = deviceSnapshot(src, s.screen); break }
            last = src
            await sleep(250)
        }
        if (pc === 'agent') return
        snap ||= deviceSnapshot(last, s.screen)
        await sleep(Math.min(2500, 400 + snap.state.viewport_text.length / 8))
    }

    async judge(s, { intent, checks = [] }) {
        let snap
        const res = await judge({
            intent, checks,
            options: async () => shortlist((snap ||= await this.read(s)).elements, intent),
            state: async () => (snap ||= await this.read(s)).state,
            where: async () => ({ platform: s.platform, device: s.device, ...(s.web && { browser: s.platform === 'ios' ? 'Safari' : 'Chrome' }) }),
        })
        this.jevRequests += res.requests
        const el = res.target && (snap?.elements || []).find((e) => e.id === res.target.id)
        return { target: res.target, el, checks: res.checks }
    }

    async find(intent, { session, checks } = {}) {
        const s = this.session(session)
        const { target, el, checks: checkResults } = await this.judge(s, { intent, checks })
        if (target.id === 'none' || target.confidence < this.minConfidence || !el) {
            throw Object.assign(new Error(`no confident match for "${intent}"`), { code: 'NO_MATCH', detail: target, checks: checkResults })
        }
        return { s, el, target, checks: checkResults }
    }

    // ---- gestures --------------------------------------------------------

    async tap(s, el, pc) {
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

    async keys(s, text) {
        await s.wd.actions([{
            type: 'key', id: 'keyboard',
            actions: [...text].flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]),
        }])
    }

    async swipe(s, from, to, ms) {
        await s.wd.actions([{
            type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
            actions: [
                { type: 'pointerMove', duration: 0, x: Math.round(from.x), y: Math.round(from.y) },
                { type: 'pointerDown', button: 0 },
                { type: 'pause', duration: 40 },
                { type: 'pointerMove', duration: Math.round(ms), x: Math.round(to.x), y: Math.round(to.y) },
                { type: 'pointerUp', button: 0 },
            ],
        }])
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
            await s.wd.context(s.webContext)
            await s.wd.url(url)
            await s.wd.context('NATIVE_APP')
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
        await this.tap(s, el, pc)
        await sleep(pc === 'human' ? rand(300, 600) : 300) // keyboard comes up
        // iOS appends each element send. UiAutomator2 replaces the field's text
        // on each send, so Android types with key events, which insert at the cursor like a
        // keyboard. Chunks of 1–3 chars with jitter at human pace.
        const field = s.platform === 'ios' ? await s.wd.activeElement() : null
        // A tap puts the Android cursor where it lands; type at the end.
        if (!field) await s.wd.execute('mobile: pressKey', [{ keycode: 123 }]) // KEYCODE_MOVE_END
        const send = (chunk) => (field ? s.wd.sendKeysTo(field, chunk) : this.keys(s, chunk))
        if (pc === 'agent') await send(text)
        else {
            for (let i = 0; i < text.length;) {
                const n = Math.min(text.length - i, Math.ceil(rand(0, 3)))
                await send(text.slice(i, i + n))
                i += n
                await sleep(rand(60, 180))
            }
        }
        if (submit) await this.press('Enter', { session, pace: pc })
        return { typed: target, chars: text.length, checks: checkResults }
    }

    // Enter, Back, Home (plus Tab/Escape/Backspace on Android). iOS has no
    // back button: Back is the left-edge swipe.
    async press(key, { session, pace: p } = {}) {
        const pc = pace.resolvePace(p || this.pace)
        const s = this.session(session)
        if (pc === 'human') await sleep(rand(120, 350))
        if (s.platform === 'android') {
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
        await this.settle(s, pc)
        return { pressed: key }
    }

    // dy > 0 scrolls content down (finger swipes up). 'end'/'top' swipe until
    // the screen stops changing (capped for infinite feeds).
    async scroll(dy = 600, { session, pace: p, maxMs = 20_000 } = {}) {
        const pc = pace.resolvePace(p || this.pace)
        const s = this.session(session)
        const { w, h } = s.screen
        const to = ['end', 'bottom'].includes(dy) ? 'end' : dy === 'top' ? 'top' : null
        const swipeBy = async (dist) => {
            const x = w / 2 + (pc === 'human' ? rand(-w * 0.1, w * 0.1) : 0)
            const y0 = dist > 0 ? h * 0.75 : h * 0.25
            await this.swipe(s, { x, y: y0 }, { x: x + (pc === 'human' ? rand(-15, 15) : 0), y: y0 - dist },
                pc === 'human' ? rand(250, 450) : 180)
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
            let last = await s.wd.source()
            while (Date.now() - started < maxMs) {
                await swipeBy((to === 'end' ? 1 : -1) * h * 0.6)
                if (pc === 'human') await sleep(rand(250, 650))
                const cur = await s.wd.source()
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
        fs.writeFileSync(file, Buffer.from(await s.wd.screenshot(), 'base64'))
        return { path: file }
    }

    async close({ session = 'default' } = {}) {
        await this.release(session)
        return { closed: session }
    }

    async hud() {}
    async showDone() {}
}
