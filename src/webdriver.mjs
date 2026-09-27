// Minimal W3C WebDriver client for Appium endpoints (Device Farm's managed
// endpoint or a local Appium). Just the calls the device backend needs.

export class WebDriver {
    constructor(base) {
        this.base = base.replace(/\/+$/, '')
        this.id = null
    }

    async req(method, path, body) {
        const res = await fetch(this.base + path, {
            method,
            headers: { 'Content-Type': 'application/json' },
            ...(body !== undefined && { body: JSON.stringify(body) }),
        })
        const text = await res.text()
        let json
        try { json = JSON.parse(text) } catch { json = { value: { error: `http ${res.status}`, message: text.slice(0, 300) } } }
        if (!res.ok || json.value?.error) {
            const v = json.value || {}
            throw Object.assign(new Error(`WebDriver ${v.error || res.status}: ${(v.message || '').split('\n')[0].slice(0, 300)}`), { code: 'WEBDRIVER', wdError: v.error })
        }
        return json.value
    }

    s(path = '') { return `/session/${this.id}${path}` }

    async newSession(capabilities) {
        const v = await this.req('POST', '/session', { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } })
        this.id = v.sessionId
        return v.capabilities
    }

    async deleteSession() {
        if (!this.id) return
        await this.req('DELETE', this.s()).catch(() => {})
        this.id = null
    }

    source() { return this.req('GET', this.s('/source')) }
    screenshot() { return this.req('GET', this.s('/screenshot')) } // base64 png
    windowRect() { return this.req('GET', this.s('/window/rect')) }
    url(url) { return this.req('POST', this.s('/url'), { url }) }
    currentUrl() { return this.req('GET', this.s('/url')) }
    contexts() { return this.req('GET', this.s('/contexts')) }
    context(name) { return this.req('POST', this.s('/context'), { name }) }
    execute(script, args = []) { return this.req('POST', this.s('/execute/sync'), { script, args }) }
    actions(actions) { return this.req('POST', this.s('/actions'), { actions }) }
    releaseActions() { return this.req('DELETE', this.s('/actions')).catch(() => {}) }

    async activeElement() {
        const v = await this.req('GET', this.s('/element/active'))
        return v['element-6066-11e4-a52e-4f735466cecf'] || v.ELEMENT
    }

    sendKeysTo(el, text) { return this.req('POST', this.s(`/element/${el}/value`), { text, value: [...text] }) }
}
