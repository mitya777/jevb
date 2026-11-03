// Capture the requests one action makes, then replay them without the page.
//
// `act ... --capture f.json` records the fetch/xhr requests the click sends.
// What the page knew goes in as references, never values:
//   - text typed earlier in the session becomes a named parameter,
//     {{NAME|enc}}, filled at send time from arguments or the environment;
//   - tokens the request carried (CSRF, bearer, form authenticity tokens)
//     are traced to where the page keeps them (a meta tag, a cookie, local or
//     session storage, a global object) and become {{@n|enc}}, read fresh
//     from that place at send time;
//   - the Cookie header is dropped: the browser context's cookie jar sends
//     the current ones.
// So a capture file holds no secrets, and `send` works for any site whose
// requests can be made again with a fresh session: logins (the response's
// Set-Cookie lands in the browser), forms, orders, admin actions, API reads.

const MIN_TOKEN = 12
// Header names whose values are credentials. One left as a literal after
// templating becomes a parameter instead of being written to the file.
const SECRET_HEADER = /auth|token|csrf|xsrf|session|secret|key|signature/i
const DROP_HEADER = /^(:|cookie$|host$|content-length$|connection$|accept-encoding$)/i

const ENCODERS = {
    raw: (v) => v,
    json: (v) => JSON.stringify(v).slice(1, -1),
    url: (v) => encodeURIComponent(v),
    form: (v) => encodeURIComponent(v).replace(/%20/g, '+'),
}

// Everything the page holds that looks like a token, with where it lives.
// Runs in the page; cookies (HttpOnly too) come from the context.
export async function tokenSources(page) {
    const found = await page.evaluate((min) => {
        const out = []
        // Tokens have no spaces and aren't URLs (window.origin is a string global).
        const add = (value, src) => { if (typeof value === 'string' && value.length >= min && !/\s|^[a-z]+:\/\//i.test(value)) out.push({ value, src }) }
        for (const m of document.querySelectorAll('meta[name][content]')) add(m.content, { from: 'meta', name: m.getAttribute('name') })
        for (const [kind, store] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]]) {
            for (let i = 0; i < store.length; i++) {
                const key = store.key(i), v = store.getItem(key)
                add(v, { from: kind, key })
                try {
                    const o = JSON.parse(v)
                    if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) add(x, { from: kind, key, path: k })
                } catch {}
            }
        }
        // Globals the page's own scripts set (Rails' gon, window.__CONFIG__ ...):
        // plain objects one level down. Skips the platform's own properties.
        const builtin = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(window)).concat(Object.getOwnPropertyNames(EventTarget.prototype)))
        for (const name of Object.keys(window)) {
            if (builtin.has(name) || /^(webkit|on)/.test(name)) continue
            let v
            try { v = window[name] } catch { continue }
            if (typeof v === 'string') add(v, { from: 'global', name })
            else if (v && Object.getPrototypeOf(v) === Object.prototype) {
                for (const [k, x] of Object.entries(v).slice(0, 200)) add(x, { from: 'global', name, path: k })
            }
        }
        return out
    }, MIN_TOKEN).catch(() => [])
    const origin = new URL(page.url()).origin
    for (const c of await page.context().cookies(page.url())) {
        if (c.value.length >= MIN_TOKEN) found.push({ value: c.value, src: { from: 'cookie', name: c.name } })
    }
    return found.map((f) => ({ ...f, src: { ...f.src, origin } }))
}

const bodyEncoding = (headers) => {
    const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || ''
    return /json/.test(ct) ? 'json' : /x-www-form-urlencoded/.test(ct) ? 'form' : 'raw'
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Replace each value (longest first) in s by its {{key|enc}}, trying the
// encodings that context could hold. Tokens match anywhere (long, unique);
// typed text (`whole`) only as a whole value: a JSON string, a form or
// query field, or the entire string. A typed "1" mustn't rewrite every 1.
function template(s, items, encs) {
    if (!s) return s
    for (const { key, value, whole } of items) {
        for (const enc of encs) {
            const e = ENCODERS[enc](value)
            if (!e || !s.includes(e)) continue
            const ph = `{{${key}|${enc}}}`
            if (!whole) s = s.split(e).join(ph)
            else if (s === e) s = ph
            else if (enc === 'json') s = s.split(`"${e}"`).join(`"${ph}"`)
            else if (enc === 'form' || enc === 'url') s = s.replace(new RegExp(`(?<=[=])${escapeRe(e)}(?=&|#|$)`, 'g'), ph)
        }
    }
    return s
}

// params: [{ name, value }] typed this session. sources: tokenSources().
// requests: [{ method, url, headers, body }] as the page sent them.
export function build({ page, requests, params, sources }) {
    const used = new Map() // source index in the file -> src
    const srcItems = []
    for (const s of sources) {
        if (srcItems.some((x) => x.value === s.value)) continue // same token in two places: first wins
        srcItems.push({ key: `@${srcItems.length}`, value: s.value, src: s.src })
    }
    const items = [...params.map((p) => ({ key: p.name, value: p.value, whole: true })), ...srcItems]
        .filter((x) => x.value).sort((a, b) => b.value.length - a.value.length)
    const needed = new Set()
    const out = requests.map((r) => {
        const headers = {}
        for (const [k, v] of Object.entries(r.headers)) {
            if (DROP_HEADER.test(k)) continue
            let t = template(v, items, ['raw', 'url'])
            if (SECRET_HEADER.test(k) && !t.includes('{{')) {
                const name = `HEADER_${k.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
                t = `{{${name}|raw}}`
            }
            headers[k] = t
        }
        const enc = bodyEncoding(r.headers)
        const body = template(r.body ?? null, items, enc === 'json' ? ['json', 'raw'] : enc === 'form' ? ['form', 'url', 'raw'] : ['raw', 'json', 'url'])
        const req = { method: r.method, url: template(r.url, items, ['url', 'raw']), headers, ...(body != null && { body }) }
        for (const m of JSON.stringify(req).matchAll(/\{\{([^|}]+)\|/g)) needed.add(m[1])
        return req
    })
    for (const x of srcItems) if (needed.has(x.key)) used.set(x.key, x.src)
    return {
        jevb: 'capture/1',
        page,
        params: [...needed].filter((k) => !k.startsWith('@')),
        sources: Object.fromEntries(used),
        requests: out,
    }
}

const fill = (s, values) => s?.replace(/\{\{([^|}]+)\|(\w+)\}\}/g, (_, key, enc) => {
    if (values[key] == null) throw Object.assign(new Error(`${key} has no value: pass ${key}=... or set it in the env`), { code: 'MISSING_PARAM' })
    return ENCODERS[enc](values[key])
})

async function readSource(src, { context, pageFor }) {
    if (src.from === 'cookie') return (await context.cookies(src.origin)).find((c) => c.name === src.name)?.value
    const page = await pageFor(src.origin)
    return page.evaluate((src) => {
        if (src.from === 'meta') return document.querySelector(`meta[name="${CSS.escape(src.name)}"]`)?.content
        let v = src.from === 'global' ? window[src.name] : (src.from === 'localStorage' ? localStorage : sessionStorage).getItem(src.key)
        if (src.path == null) return v
        if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return undefined } }
        return v?.[src.path]
    }, src)
}

// Replays a capture through the context's own request client (its cookie
// jar, no CORS, no page load unless a token lives in a page). Stops at the
// first 4xx/5xx. values: params by name; the env fills the rest.
export async function send(capture, { context, pageFor, values = {}, env = process.env }) {
    const vals = { ...values }
    for (const p of capture.params) vals[p] ??= env[p]
    for (const [key, src] of Object.entries(capture.sources)) {
        vals[key] = await readSource(src, { context, pageFor })
        if (vals[key] == null) throw Object.assign(new Error(`token ${key} not found (${src.from} ${src.name || src.key} on ${src.origin}); capture again`), { code: 'SOURCE_GONE' })
    }
    const results = []
    for (const r of capture.requests) {
        const t = Date.now()
        const headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, fill(v, vals)]))
        const res = await context.request.fetch(fill(r.url, vals), {
            method: r.method, headers, ...(r.body != null && { data: fill(r.body, vals) }), failOnStatusCode: false,
        })
        const text = await res.text().catch(() => '')
        let json
        try { json = JSON.parse(text) } catch {}
        results.push({ method: r.method, url: res.url(), status: res.status(), ms: Date.now() - t, ...(json !== undefined ? { json } : { body: text.slice(0, 2000) }) })
        if (res.status() >= 400) break
    }
    return results
}
