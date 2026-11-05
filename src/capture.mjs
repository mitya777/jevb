// Capture the requests one action makes, then replay them without the page.
//
// `act ... --capture f.json` records the fetch/xhr requests the click sends.
// What the page knew goes in as references, never values:
//   - text typed earlier in the session becomes a named parameter,
//     {{NAME|enc}}, filled at send time from arguments or the environment;
//   - tokens the request carried (CSRF, bearer, form authenticity tokens)
//     are traced to where the page keeps them (a meta tag, a hidden input, a
//     cookie, local or session storage, a global object) and become {{@n|enc}}, read fresh
//     from that place at send time;
//   - the Cookie header is dropped: the browser context's cookie jar sends
//     the current ones.
// So a capture file holds no secrets, and `send` works for any site whose
// requests can be made again with a fresh session: logins (the response's
// Set-Cookie lands in the browser), forms, orders, admin actions, API reads.

const MIN_TOKEN = 12
// Header names whose values are credentials. One left as a literal after
// templating becomes a parameter instead of being written to the file.
const SECRET_HEADER = /auth|token|csrf|xsrf|session|secret|key|signature|^client$|^uid$|^expiry$/i
// Body fields the same way (plus passwords); see secretFields().
const SECRET_FIELD = /auth|token|csrf|xsrf|session|secret|key|signature|passw/i
// if-none-match: a replay wants the answer, not a 304 against an old copy.
const DROP_HEADER = /^(:|cookie$|host$|content-length$|connection$|accept-encoding$|if-none-match$|if-modified-since$)/i

const ENCODERS = {
    raw: (v) => v,
    json: (v) => JSON.stringify(v).slice(1, -1),
    url: (v) => encodeURIComponent(v),
    form: (v) => new URLSearchParams({ v }).toString().slice(2), // as URLSearchParams and forms send it: ! ( ) ~ escaped, space as +
}

// Everything the page holds that looks like a token, with where it lives.
// Runs in the page; cookies (HttpOnly too) come from the context.
export async function tokenSources(page) {
    const found = await page.evaluate((min) => {
        const out = []
        // Tokens have no spaces and aren't URLs (window.origin is a string global).
        const add = (value, src) => { if (typeof value === 'string' && value.length >= min && !/\s|^[a-z]+:\/\//i.test(value)) out.push({ value, src }) }
        for (const m of document.querySelectorAll('meta[name][content]')) add(m.content, { from: 'meta', name: m.getAttribute('name') })
        for (const i of document.querySelectorAll('input[type=hidden][name]')) add(i.value, { from: 'input', name: i.name })
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
    const { origin, pathname } = new URL(page.url())
    for (const c of await page.context().cookies(page.url())) {
        // scope: the URL it applies to (a cookie on /app isn't sent for /).
        if (c.value.length >= MIN_TOKEN) found.push({ value: c.value, src: { from: 'cookie', name: c.name, scope: origin + pathname } })
    }
    return found.map((f) => ({ ...f, src: { ...f.src, origin } }))
}

const bodyEncoding = (headers) => {
    const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || ''
    return /json/.test(ct) ? 'json' : /x-www-form-urlencoded/.test(ct) ? 'form' : /multipart\/form-data/.test(ct) ? 'multipart' : 'raw'
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Replace each value (longest first) in s by its {{key|enc}}, trying the
// encodings that context could hold. Tokens match anywhere (long, unique);
// typed text (`whole`) only as a whole value: a JSON string, a form or
// query field, a multipart part, or the entire string. A typed "1" mustn't
// rewrite every 1.
function template(s, items, encs, multipart = false) {
    if (!s) return s
    for (const { key, value, whole } of items) {
        for (const enc of encs) {
            const e = ENCODERS[enc](value)
            if (!e || !s.includes(e)) continue
            const ph = `{{${key}|${enc}}}`
            if (!whole) s = s.split(e).join(ph)
            else if (s === e) s = ph
            else if (enc === 'json') s = s.replace(new RegExp(`(?<=[:\\[,]\\s*)"${escapeRe(e)}"(?=\\s*[,}\\]])`, 'g'), `"${ph}"`) // values, not keys
            else if (enc === 'form' || enc === 'url') s = s.replace(new RegExp(`(?<=[=])${escapeRe(e)}(?=&|#|$)`, 'g'), ph)
            else if (multipart && enc === 'raw') s = s.split(`\r\n\r\n${e}\r\n`).join(`\r\n\r\n${ph}\r\n`)
        }
    }
    return s
}

// A credential field still holding a literal value (no source found for
// it, e.g. a token only in a JS closure) becomes a parameter, so the file
// never stores it: form, multipart and JSON string fields by name.
function secretFields(body, enc) {
    if (!body) return body
    const name = (k) => `FIELD_${k.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
    // Token-length values only (a "keyword=shoes" field isn't one), or any password.
    const secret = (k, v) => v && !v.includes('{{') && SECRET_FIELD.test(k) && (v.length >= MIN_TOKEN || /passw/i.test(k))
    if (enc === 'form') {
        return body.split('&').map((kv) => {
            const i = kv.indexOf('='), k = decodeURIComponent(kv.slice(0, i).replace(/\+/g, ' ')), v = kv.slice(i + 1)
            return i > 0 && secret(k, v) ? `${kv.slice(0, i)}={{${name(k)}|form}}` : kv
        }).join('&')
    }
    if (enc === 'json') {
        return body.replace(/"([^"\\]+)"(\s*:\s*)"((?:[^"\\]|\\.)+)"/g, (m, k, sep, v) => (secret(k, v) ? `"${k}"${sep}"{{${name(k)}|json}}"` : m))
    }
    if (enc === 'multipart') {
        return body.replace(/(name="([^"]+)"\r\n\r\n)([^\r]*)(?=\r\n)/g, (m, head, k, v) => (secret(k, v) ? `${head}{{${name(k)}|raw}}` : m))
    }
    return body
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
        for (let [k, v] of Object.entries(r.headers)) {
            if (DROP_HEADER.test(k)) continue
            // A Referer's query can hold a credential (a reset link); the
            // origin and path are all a server checks.
            if (/^referer$/i.test(k)) { const u = new URL(v); v = u.origin + u.pathname }
            let t = template(v, items, ['raw', 'url'])
            if (SECRET_HEADER.test(k) && !t.includes('{{')) {
                const name = `HEADER_${k.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
                t = `{{${name}|raw}}`
            }
            headers[k] = t
        }
        const enc = bodyEncoding(r.headers)
        const encs = { json: ['json', 'raw'], form: ['form', 'url', 'raw'], multipart: ['raw'] }[enc] || ['raw', 'json', 'url']
        const body = secretFields(template(r.body ?? null, items, encs, enc === 'multipart'), enc)
        let url = template(r.url, items, ['url', 'form', 'raw'])
        const q = url.indexOf('?')
        if (q >= 0) url = url.slice(0, q + 1) + secretFields(url.slice(q + 1), 'form')
        const req = { method: r.method, url, headers, ...(body != null && { body }) }
        for (const m of JSON.stringify(req).matchAll(/\{\{([^|}]+)\|/g)) needed.add(m[1])
        return req
    })
    for (const x of srcItems) if (needed.has(x.key)) used.set(x.key, x.src)
    // The page send reads tokens from. Its query and hash go if they hold a
    // token, typed text or a credential-looking field (a reset link's token).
    const u = new URL(page)
    if (u.search || u.hash) {
        const leaks = items.some((x) => x.value.length >= 3 && [page, decodeURIComponent(page)].some((s) => s.includes(x.value)))
        if (leaks || [...u.searchParams.keys()].some((k) => SECRET_FIELD.test(k))) { u.search = ''; u.hash = '' }
    }
    return {
        jevb: 'capture/1',
        page: u.href,
        params: [...needed].filter((k) => !k.startsWith('@')),
        sources: Object.fromEntries(used),
        requests: out,
    }
}

// Fields a client computes per request: a replay of the captured value would
// be refused, or worse, accepted twice.
const VOLATILE = /signature|(^|[-_])sig($|[-_])|(^|[-_])signed|nonce|timestamp|hmac|raw[-_]?tx|idempotency|request[-_]?id/i

const responseValues = (text) => {
    const out = new Set()
    // Short ones too: {"id":42} then /items/42/publish. A coincidence only
    // sends the flow through the page. 0 and 1 are flags far more often.
    const walk = (v) => {
        if (typeof v === 'string' && v.length >= 2) out.add(v)
        else if (typeof v === 'number' && Math.abs(v) >= 2) out.add(String(v))
        else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    try { walk(JSON.parse(text)) } catch {}
    return out
}

// Whether a captured flow can run again without its page. Anything unclear
// is a reason not to: the page is slower, never wrong.
export function assess(cap, { wsFrames = 0, binary = false, responses = [], order = [], typed = [] } = {}) {
    const reasons = []
    // One parameter would stand for both, and a later edit to one field lost.
    const texts = typed.map((t) => t.value)
    if (new Set(texts).size < texts.length) reasons.push('two fields hold the same text')
    // Typed but not found as a value in the requests: the page transformed it
    // (a quantity to a number) or never sent it, so a new value couldn't apply.
    const lost = typed.filter((t) => t.name && !cap.params.includes(t.name)).map((t) => t.name)
    if (lost.length) reasons.push(`typed text not found in the requests: ${lost.join(', ')}`)
    if (!cap.requests.length) reasons.push('sends no requests')
    if (wsFrames) reasons.push('talks over a websocket')
    if (binary) reasons.push('sends binary data')
    const unsourced = cap.params.filter((p) => /^(HEADER|FIELD)_/.test(p))
    if (unsourced.length) reasons.push(`no known source for ${unsourced.join(', ')}`)
    cap.requests.forEach((r, i) => {
        const body = r.body || ''
        if (r.status == null) reasons.push(`${r.method} ${r.url.split('?')[0]} never finished`)
        if (/filename="/.test(body)) reasons.push('uploads a file')
        const literal = (k, v) => VOLATILE.test(k) && !String(v).includes('{{')
        for (const [k, v] of Object.entries(r.headers)) if (literal(k, v)) reasons.push(`one-time header ${k}`)
        let fields = []
        try { fields = Object.entries(JSON.parse(body.replace(/\{\{[^}]+\}\}/g, 'x'))) } catch { fields = [...new URLSearchParams(body)] }
        const query = r.url.includes('?') ? [...new URLSearchParams(r.url.slice(r.url.indexOf('?') + 1))] : []
        for (const [k, v] of [...fields, ...query]) if (literal(k, v)) reasons.push(`one-time field ${k}`)
        const stripped = `${r.url} ${body}`.replace(/\{\{[^}]+\}\}/g, '')
        // An id in the request itself: the page may have made it (Treechat
        // names a new thread before posting it), so a replay would reuse it.
        if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(stripped)) reasons.push('holds a fixed id, possibly made in the page')
        if (/[A-Fa-f0-9]{40,}|[A-Za-z0-9+_-]{64,}/.test(stripped)) reasons.push('holds a value computed in the page')
        // A value the server handed back earlier in the flow (a new id).
        for (const res of responses) {
            if (res.order >= order[i]) continue
            for (const v of responseValues(res.text)) {
                if (new RegExp(`(^|[^A-Za-z0-9])${v.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`).test(stripped)) reasons.push(`uses "${v.slice(0, 24)}" from an earlier response`)
            }
        }
    })
    return { ok: reasons.length === 0, reasons: [...new Set(reasons)] }
}

const fill = (s, values) => s?.replace(/\{\{([^|}]+)\|(\w+)\}\}/g, (_, key, enc) => {
    if (values[key] == null) throw Object.assign(new Error(`${key} has no value: pass ${key}=... or set it in the env`), { code: 'MISSING_PARAM' })
    return ENCODERS[enc](values[key])
})

async function readSource(src, { context, pageFor, reload }) {
    if (src.from === 'cookie') {
        const read = async () => (await context.cookies(src.scope || src.origin)).find((c) => c.name === src.name)?.value
        // A fresh browser has no CSRF cookie yet: the captured page sets it.
        return (await read()) ?? (await pageFor(src.origin), await read())
    }
    // sessionStorage belongs to one tab: read it from the session's own.
    const page = await pageFor(src.origin, { reload, tab: src.from === 'sessionStorage' })
    // Scripts can set it a beat after load (a bootstrap global, say).
    const read = () => page.evaluate((src) => {
        if (src.from === 'meta') return document.querySelector(`meta[name="${CSS.escape(src.name)}"]`)?.content
        if (src.from === 'input') return document.querySelector(`input[type=hidden][name="${CSS.escape(src.name)}"]`)?.value
        let v = src.from === 'global' ? window[src.name] : (src.from === 'localStorage' ? localStorage : sessionStorage).getItem(src.key)
        if (src.path == null) return v
        if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return undefined } }
        return v?.[src.path]
    }, src)
    let value = await read()
    for (let t = Date.now(); value == null && Date.now() - t < 3_000; value = await read()) await new Promise((r) => setTimeout(r, 100))
    return value
}

// Replays a capture through the context's own request client (its cookie
// jar, no CORS, no page load unless a token lives in a page). Stops at the
// first 4xx/5xx. values: params by name; the env fills the rest.
// A token page read earlier can go stale (Rails rotates its CSRF token at
// login): on 401/403/419/422 the page is reloaded and the request tried once
// more. The server refused the first one, so it can't run twice.
export async function send(capture, { context, pageFor, values = {}, env = process.env }) {
    const vals = { ...values }
    for (const p of capture.params) vals[p] ??= env[p]
    // All of them before anything is sent: a missing one for a later request
    // mustn't leave an earlier POST done, to be repeated on the retry.
    const missing = capture.params.filter((p) => vals[p] == null)
    if (missing.length) throw Object.assign(new Error(`${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no value: pass NAME=... or set it in the env`), { code: 'MISSING_PARAM' })
    const readAll = async (reload) => {
        const reloaded = new Set() // once per page, so every token comes from one load
        for (const [key, src] of Object.entries(capture.sources)) {
            const page = `${src.origin} ${src.from === 'sessionStorage' ? 'tab' : 'helper'}`
            const first = reload && src.from !== 'cookie' && !reloaded.has(page)
            if (first) reloaded.add(page)
            vals[key] = await readSource(src, { context, pageFor, reload: first })
            if (vals[key] == null) throw Object.assign(new Error(`token ${key} not found (${src.from} ${src.name || src.key} on ${src.origin}); capture again`), { code: 'SOURCE_GONE' })
        }
    }
    const hasTokens = Object.keys(capture.sources).length > 0
    const results = []
    for (const r of capture.requests) {
        const t = Date.now()
        // Before each request: the one before may have rotated a token.
        // attempted says whether anything had gone out if this throws.
        try { await readAll(false) } catch (e) { throw Object.assign(e, { attempted: results.length }) }
        const once = () => context.request.fetch(fill(r.url, vals), {
            method: r.method,
            headers: Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, fill(v, vals)])),
            ...(r.body != null && { data: fill(r.body, vals) }),
            failOnStatusCode: false,
        })
        let res = await once()
        if (hasTokens && [401, 403, 419, 422].includes(res.status())) {
            await res.dispose()
            try { await readAll(true) } catch (e) { throw Object.assign(e, { attempted: results.length }) }
            res = await once()
        }
        const text = await res.text().catch(() => '')
        await res.dispose() // else the context keeps every body until it closes
        let json
        try { json = JSON.parse(text) } catch {}
        results.push({ method: r.method, url: res.url(), status: res.status(), ms: Date.now() - t, ...(json !== undefined ? { json } : { body: text.slice(0, 2000) }) })
        // A write that answered differently than when recorded may not have
        // done the same thing: what follows could depend on it.
        if (res.status() >= 400 || (r.status != null && res.status() !== r.status)) break
    }
    return results
}
