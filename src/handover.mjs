// A tab the user hands over: jevb drives exactly one existing tab of an
// attached Chrome (JEVB_CDP_URL), the one the user picked from `jevb tabs`.
//
// Confinement, in layers:
//   - CDP (cdp-filter.mjs, `only`): Playwright sees no other tab, popups are
//     detached, and opening, closing, focusing or attaching to tabs is
//     refused before Chrome sees the command.
//   - Here: one session only; `open` stays on the tab's origin; no eval,
//     capture or send; no shortcut keys; the tab is never closed, only
//     detached, and the demo overlay is removed on the way out.
//   - Steps (lintScenario + guardElement): no signing out, no credentials,
//     no account or security settings, no typing into password or one-time
//     code fields, no ${SECRET} values. Checked on the scenario's words
//     before anything runs, and on the element Jev picked before each click.
import { JevBrowser } from './browser.mjs'
import { browserWsUrl } from './cdp-filter.mjs'
import { OVERLAY } from './demo.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const SIGN_OUT = /\b(sign|log)[\s-]?(out|off)\b|\blogout\b|\bsignout\b/i
export const CREDENTIALS = /\b(passwords?|passcodes?|passphrases?|pin code|2fa|two[- ]factor|mfa|one[- ]time (code|password)|otp|security keys?|passkeys?|api keys?|access tokens?|recovery (codes?|email|phone)|credentials?)\b/i
export const ACCOUNT = /\b(delete|close|deactivate|disable|cancel|remove)\s+(my\s+|the\s+|your\s+|this\s+)?(account|subscription|profile|organi[sz]ation|workspace)\b|\b(account|security|privacy|billing|payment|login|sign[- ]in) settings\b|\bchange (my |the |your )?(e-?mail|username|phone number|login)\b/i
const DENY = [[SIGN_OUT, 'signing out'], [CREDENTIALS, 'credentials'], [ACCOUNT, 'account or security settings']]

const ALLOWED_STEPS = new Set(['open', 'act', 'type', 'press', 'scroll', 'check', 'refute', 'read', 'wait', 'shot', 'pace'])
// Keys a flow needs; anything with Control/Meta/Alt could be a browser
// shortcut (close tab, quit, open a window), so it isn't allowed.
const SAFE_KEY = /^(Shift\+)?(Enter|Escape|Tab|Space|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End|[\x20-\x7e])$/

export const refusal = (message) => Object.assign(new Error(`refused: ${message}`), { code: 'REFUSED' })

const denied = (text) => DENY.find(([re]) => re.test(text || ''))?.[1]

// Steps a hand-over run will not take, with the reason, before any runs.
export function lintScenario(steps) {
    const out = []
    for (const s of steps) {
        const no = (why) => out.push({ line: s.line, step: s.src, why })
        if (!ALLOWED_STEPS.has(s.cmd)) { no(`"${s.cmd}" steps are not allowed in a handed-over tab`); continue }
        if (s.cmd === 'act' || s.cmd === 'type') {
            const [intent, text] = s.cmd === 'type' ? s.arg.split(/\s*=>\s*/) : [s.arg]
            const why = denied(intent)
            if (why) no(`touches ${why}`)
            if (text && /\$\{[A-Z0-9_]+\}/.test(text)) no('types a ${SECRET} value; a handed-over tab gets no credentials or secrets')
        }
        if (s.cmd === 'open' && s.arg && SIGN_OUT.test(s.arg)) no('opens a sign-out address')
        if (s.cmd === 'press' && !SAFE_KEY.test(s.arg.trim())) no(`key "${s.arg}" could be a browser shortcut`)
    }
    return out
}

// The open page-type tabs of an attached Chrome, without attaching to any.
export async function listTabs(cdpUrl) {
    const http = (await browserWsUrl(cdpUrl)).replace(/^ws/, 'http').replace(/\/devtools\/browser\/.*$/, '')
    const res = await fetch(`${http}/json/list`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`${http}/json/list: HTTP ${res.status}`)
    // Chrome's own UI (toolbar, omnibox popups) shows up as pages too.
    return (await res.json()).filter((t) => t.type === 'page' && !/^(chrome|devtools|chrome-extension|chrome-untrusted):/.test(t.url)).map((t) => ({ id: t.id, title: t.title, url: t.url }))
}

// What jevb checks about the element Jev picked, before acting on it.
async function describeElement(locator) {
    return locator.evaluate((el) => ({
        tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase(),
        autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
        label: [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('name'), el.id,
            (el.innerText || el.value || '').trim().slice(0, 120), el.getAttribute('href')].filter(Boolean).join(' | '),
    })).catch(() => null)
}

export function guardElement(info, { typing }) {
    if (!info) return
    if (typing && (info.type === 'password' || /current-password|new-password|one-time-code/.test(info.autocomplete))) {
        throw refusal('jevb never types into a password or one-time-code field in a handed-over tab')
    }
    const why = denied(info.label)
    if (why) throw refusal(`the picked control (${info.label.slice(0, 80)}) touches ${why}`)
}

const REMOVE_OVERLAY = `for (const id of ['__jevb_cursor', '__jevb_hud', '__jevb_done']) document.getElementById(id)?.remove()`

export class HandoverBrowser extends JevBrowser {
    constructor({ tabId, cdpUrl = process.env.JEVB_CDP_URL, ...rest } = {}) {
        if (!cdpUrl) throw new Error('a hand-over needs an attached Chrome: set JEVB_CDP_URL (see bin/jevb-chrome.sh)')
        if (!tabId) throw new Error('a hand-over needs the id of the tab the user picked (jevb tabs)')
        super({ demo: true, ...rest, cdpUrl })
        this.tabId = tabId
        this.cdpFilter = { only: tabId }
        this.origin = null
        this.typing = false
        this.beforeDetach = null
    }

    async page(name = 'default') {
        if (name && name !== 'default') throw refusal('a hand-over has one tab; no other sessions')
        this.touch()
        const s = this.sessions.get('default')
        if (s) {
            if (s.page.isClosed()) throw Object.assign(new Error('the handed-over tab was closed'), { code: 'TAB_GONE' })
            return s.page
        }
        const browser = await this.ensureBrowser()
        const context = browser.contexts()[0]
        let page = null
        for (let i = 0; i < 50 && !page; i++) {
            for (const p of context.pages()) if (await targetIdOf(p) === this.tabId) page = p
            if (!page) await sleep(100)
        }
        if (!page) throw Object.assign(new Error(`tab ${this.tabId} is not open in this Chrome (jevb tabs lists them)`), { code: 'TAB_NOT_FOUND' })
        this.origin = new URL(page.url()).origin
        if (this.demo) {
            await page.addInitScript(OVERLAY)
            await page.evaluate(OVERLAY).catch(() => {})
        }
        this.sessions.set('default', { context, page })
        return page
    }

    async open(url, opts = {}) {
        const page = await this.page()
        let target
        try { target = new URL(url || page.url(), page.url()) } catch { throw refusal(`"${url}" is not a URL`) }
        if (!/^https?:$/.test(target.protocol)) throw refusal(`only http(s) pages, not ${target.protocol}`)
        if (target.origin !== this.origin) throw refusal(`the handed-over tab stays on ${this.origin}; ${target.origin} is another site`)
        if (SIGN_OUT.test(target.pathname + target.search)) throw refusal('that address signs out')
        return super.open(target.href, opts)
    }

    async find(intent, opts = {}) {
        const why = denied(intent)
        if (why) throw refusal(`"${intent}" touches ${why}`)
        const found = await super.find(intent, opts)
        guardElement(await describeElement(found.locator), { typing: this.typing })
        return found
    }

    async type(intent, text, opts) {
        this.typing = true
        try { return await super.type(intent, text, opts) } finally { this.typing = false }
    }

    async press(key, opts) {
        if (!SAFE_KEY.test(String(key).trim())) throw refusal(`key "${key}" could be a browser shortcut`)
        return super.press(key, opts)
    }

    async evaluate() { throw refusal('eval is not allowed in a handed-over tab') }
    async send() { throw refusal('send is not allowed in a handed-over tab') }
    async startCapture() { throw refusal('capture is not allowed in a handed-over tab') }

    // Detach and give the tab back: never close it, whatever JEVB_CLOSE_TABS says.
    async close() { return { ...(await this.shutdown('handed back')), closed: false } }

    async shutdown(reason = 'stop') {
        const s = this.sessions.get('default')
        if (this.beforeDetach) { const f = this.beforeDetach; this.beforeDetach = null; await f().catch((e) => this.log(`before detach: ${e.message}`)) }
        if (s && !s.page.isClosed()) await s.page.evaluate(REMOVE_OVERLAY).catch(() => {})
        const res = await super.shutdown(reason, { closeTabs: false })
        return { ...res, handedBack: this.tabId }
    }
}

async function targetIdOf(page) {
    const s = await page.context().newCDPSession(page)
    try { return (await s.send('Target.getTargetInfo')).targetInfo.targetId } finally { await s.detach().catch(() => {}) }
}
