// Offline test harness: a fake Jev (TypeSafe System One) plus a static server
// for the fixture pages, so the whole stack (snapshot → judge → pace →
// scenario → daemon/CLI) runs against real headless Chromium in seconds,
// deterministically, at no cost.
//
// Import this module FIRST in a test file: it points jevb at nothing real
// before any src module reads its environment.
//
//   import { fakeJev, fixtures } from './harness/index.mjs'
//   const jev = await fakeJev()          // jev.requests: every request jevb sent
//   const site = await fixtures()        // site.url('controls.html')
//
// The fake answers like a well-behaved Jev would on text it can read:
//   choice: a "quoted label" in the intent picks the options with that label
//           (split evenly: `the last "Reply" button`); otherwise word overlap
//           between intent and label, sharpened (none if nothing overlaps)
//   noul:   0.95 if every "quoted phrase" in the question is on screen
//           (viewport_text or a field value), else 0.05; 0.5 with no quotes
// Tests override any answer with jev.answer((body) => ({ key: answer })).
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.TYPESAFEAI_API_KEY = 'test-key'
process.env.TYPESAFE_ENDPOINT = 'http://127.0.0.1:9/unset' // until fakeJev() starts
// Never inherit the developer's jevb/.env: an attached Chrome, demo HUD,
// video recording or a default pace would change what the tests exercise.
for (const k of ['JEVB_CDP_URL', 'JEVB_DEMO', 'JEVB_VIDEO', 'JEVB_HEADED', 'JEVB_PACE', 'JEVB_APPIUM_URL', 'ANTHROPIC_API_KEY']) process.env[k] = ''
// Failing checks and unmatched actions re-poll for JEVB_WAIT_MS; off by
// default so a test's deliberate failures stay instant and request counts exact.
process.env.JEVB_WAIT_MS = '0'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const FIXTURES = path.join(ROOT, 'test/fixtures')

const STOP = new Set('the a an to of on in and or for with into from this that then page is are be it its click tap open press go use'.split(' '))
export const words = (s) => (s || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w)).map((w) => w.replace(/(?<=..)s$/, ''))

// Label from a judge option desc: `button "Reply (1)" at 10,20` -> "reply".
const label = (desc) => words(desc.match(/^\S+ "([^"]*?)(?: \(\d+\))?"/)?.[1] ?? desc).join(' ')
const ROLE_WORDS = { a: 'link', button: 'button', textarea: 'box field', input: 'box field', editor: 'box field editor' }
const optionWords = (desc) => [...label(desc).split(' '), ...(ROLE_WORDS[desc.split(' ')[0]] || '').split(' ')]
const distribute = (scores) => {
    const total = scores.reduce((s, [, n]) => s + n, 0)
    if (!total) return { choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } }
    const probabilities = Object.fromEntries(scores.filter(([, n]) => n).map(([id, n]) => [id, +(n / total).toFixed(3)]))
    const [choice, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]
    return { choice, confidence, probabilities }
}

export function defaultAnswer(state, name, q) {
    if (q.type === 'choice') {
        const options = Object.entries(q.criteria).filter(([id]) => id !== 'none')
        const quoted = (state.intent ?? state.question).match(/"([^"]+)"/)?.[1]
        if (quoted) return distribute(options.map(([id, desc]) => [id, label(desc) === words(quoted).join(' ') ? 1 : 0]))
        const want = new Set(words((state.intent ?? state.question)))
        return distribute(options.map(([id, desc]) => [id, optionWords(desc).filter((w) => want.has(w)).length ** 3]))
    }
    if (q.type === 'noul') {
        const question = q.instructions.split('Judge what the user sees now: ').pop()
        const quoted = [...question.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase())
        if (!quoted.length) return { noul: 0.5 }
        const seen = [state.viewport_text, ...(state.fields || []).map((f) => f.value)].join('\n').toLowerCase()
        return { noul: quoted.every((t) => seen.includes(t)) ? 0.95 : 0.05 }
    }
    throw new Error(`fake Jev: unsupported question type ${q.type} (${name})`)
}

export async function fakeJev() {
    const requests = []
    let override = null
    let failures = [] // statuses to return before answering normally
    let delayMs = 0 // answer this much later (tests of concurrency)
    const server = http.createServer(async (req, res) => {
        let raw = ''
        for await (const c of req) raw += c
        const body = JSON.parse(raw)
        requests.push({ ...body, auth: req.headers.authorization, at: Date.now() })
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
        if (failures.length) {
            res.writeHead(failures.shift(), { 'content-type': 'text/plain' })
            return res.end('upstream connect error')
        }
        try {
            const custom = override?.(body) || {}
            const answers = Object.fromEntries(Object.entries(body.questions).map(([name, q]) =>
                [name, custom[name] ?? defaultAnswer(body.state, name, q)]))
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: raw.length >> 2, output_tokens: 7 } }))
        } catch (e) {
            res.writeHead(400, { 'content-type': 'text/plain' })
            res.end(e.message)
        }
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${server.address().port}/v1/systemone`
    process.env.TYPESAFE_ENDPOINT = url
    return {
        url,
        requests,
        // Requests that asked for an element choice / only ran checks.
        picks: () => requests.filter((r) => r.questions.target),
        checks: () => requests.filter((r) => !r.questions.target),
        answer(fn) { override = fn },
        fail(...statuses) { failures = statuses },
        delay(ms) { delayMs = ms },
        reset() { requests.length = 0; override = null; failures = []; delayMs = 0 },
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(r) }),
    }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }

// Serves test/fixtures over http (not file://: navigation, load and
// networkidle behave like a real site). `/slow/<ms>/<file>` delays a file.
export async function fixtures(dir = FIXTURES) {
    const shop = shopApp()
    const server = http.createServer(async (req, res) => {
        if (await shop.handle(req, res)) return
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
        const slow = p.match(/^\/slow\/(\d+)(\/.*)$/)
        if (slow) { await new Promise((r) => setTimeout(r, Number(slow[1]))); p = slow[2] }
        const file = path.join(dir, p === '/' ? 'index.html' : p)
        if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found') }
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
        fs.createReadStream(file).pipe(res)
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}/`
    return { base, shop, url: (p = '') => new URL(p, base).href, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r) }) }
}

// A small shop for capture/send: /shop.html logs in with a form post that
// carries the page's CSRF meta token (sets an HttpOnly session cookie),
// places orders as JSON with an X-CSRF-Token header, and lists them with a
// bearer token the page keeps in localStorage. Every page load mints fresh
// tokens. Placing an order also pings a third-party "analytics" host.
function shopApp() {
    const rand = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    const csrf = new Set(), keys = new Set(), sessions = new Map(), orders = []
    const cookie = (req) => (req.headers.cookie || '').match(/(?:^|; )sid=([^;]+)/)?.[1]
    const json = (res, code, o, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(o)) }
    const body = async (req) => { let b = ''; for await (const c of req) b += c; return b }
    const page = (host) => {
        const token = rand(), key = rand(), formToken = rand() // the form's own token, not the meta one
        csrf.add(token); csrf.add(formToken); keys.add(key)
        const analytics = `http://${host.replace('127.0.0.1', 'localhost')}/api/collect`
        return `<!doctype html><html><head><title>Shop</title><meta name="csrf-token" content="${token}"></head><body>
<h1>Shop</h1>
<input placeholder="Email"> <input type="password" placeholder="Password"> <button id="login">Log in</button>
<input placeholder="Item"> <textarea placeholder="Note"></textarea> <button id="order">Place order</button>
<button id="list">My orders</button>
<button id="reorder">Reorder</button>
<button id="like">Like</button>
<button id="save">Late save</button>
<input placeholder="Search">
<form method="post" action="/api/subscribe"><input type="hidden" name="authenticity_token" value="${formToken}"><input name="news_email" placeholder="Newsletter email"><button>Subscribe</button></form>
<p id="out"></p>
<script>
window.APP = { apiKey: '${key}' }
localStorage.setItem('auth', JSON.stringify({ token: window.APP.apiKey }))
const meta = () => document.querySelector('meta[name=csrf-token]').content
const out = (t) => { document.getElementById('out').textContent = t }
const $ = (s) => document.querySelector(s)
$('#login').onclick = async () => {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: $('[placeholder=Email]').value, password: $('[type=password]').value, authenticity_token: meta() }) })
  out(r.ok ? 'Logged in as ' + (await r.json()).email : 'Login failed')
}
$('#order').onclick = async () => {
  fetch('${analytics}', { method: 'POST', mode: 'no-cors', body: 'event=order' }).catch(() => {})
  const r = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': meta() },
    body: JSON.stringify({ item: $('[placeholder=Item]').value, note: $('[placeholder=Note]').value, qty: 1 }) })
  out(r.ok ? 'Order ' + (await r.json()).id + ' placed' : 'Order failed ' + r.status)
}
$('[placeholder=Search]').oninput = (e) => { fetch('/api/search?' + new URLSearchParams({ q: e.target.value })) }
$('#reorder').onclick = async () => {
  const r = await fetch('/api/reorder', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': meta() }, body: JSON.stringify({ item: 'again', note: '', qty: 1 }) })
  out(r.ok ? 'Reordered' : 'Reorder failed ' + r.status)
}
$('#like').onclick = async () => {
  const r = await fetch('/api/like', { method: 'POST', headers: { 'x-xsrf-token': document.cookie.match(/xsrf=([^;]+)/)[1] } })
  out(r.ok ? 'Liked' : 'Like failed ' + r.status)
}
$('[placeholder=Note]').oninput = (e) => { fetch('/api/autosave', { method: 'POST', body: e.target.value }) }
$('#save').onclick = () => setTimeout(() => fetch('/api/autosave', { method: 'POST', body: 'x=y' }), 1000) // after act has returned
$('#list').onclick = async () => {
  const r = await fetch('/api/orders', { headers: { authorization: 'Bearer ' + JSON.parse(localStorage.getItem('auth')).token } })
  out(r.ok ? 'Orders: ' + (await r.json()).map((o) => o.item).join(', ') : 'List failed ' + r.status)
}
</script></body></html>`
    }
    return {
        orders, sessions, autosaves: 0,
        fail: null, // a status for POST /api/orders to answer with, after taking the order
        async handle(req, res) {
            const url = new URL(req.url, 'http://x')
            if (url.pathname === '/shop.html') {
                const xsrf = rand() // double-submit cookie: the page's script copies it into a header
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `xsrf=${xsrf}; Path=/; SameSite=Lax` })
                res.end(page(req.headers.host)); return true
            }
            if (!url.pathname.startsWith('/api/')) return false
            if (url.pathname === '/api/collect') { await body(req); res.writeHead(204); res.end(); return true }
            if (url.pathname === '/api/login' && req.method === 'POST') {
                const f = new URLSearchParams(await body(req))
                if (!csrf.has(f.get('authenticity_token'))) return json(res, 422, { error: 'bad csrf' }), true
                if (f.get('password') !== 'pw-correct') return json(res, 401, { error: 'wrong password' }), true
                const sid = rand()
                sessions.set(sid, f.get('email'))
                return json(res, 200, { email: f.get('email') }, { 'set-cookie': `sid=${sid}; HttpOnly; Path=/; SameSite=Lax` }), true
            }
            if (url.pathname === '/api/like') {
                const c = (req.headers.cookie || '').match(/(?:^|; )xsrf=([^;]+)/)?.[1]
                return json(res, c && c === req.headers['x-xsrf-token'] ? 200 : 403, { liked: !!c && c === req.headers['x-xsrf-token'] }), true
            }
            if (url.pathname === '/api/autosave') { await body(req); this.autosaves++; return json(res, 200, {}), true }
            if (url.pathname === '/api/reorder') { res.writeHead(307, { location: '/api/orders' }); res.end(); return true }
            if (url.pathname === '/api/search') return json(res, 200, { q: url.searchParams.get('q') }), true
            if (url.pathname === '/api/subscribe' && req.method === 'POST') {
                const f = new URLSearchParams(await body(req))
                if (!csrf.has(f.get('authenticity_token'))) return json(res, 422, { error: 'bad csrf' }), true
                res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<p>Subscribed ${f.get('news_email')}</p>`); return true
            }
            const user = sessions.get(cookie(req))
            if (!user) return json(res, 401, { error: 'not logged in' }), true
            if (url.pathname === '/api/orders' && req.method === 'POST') {
                if (!csrf.has(req.headers['x-csrf-token'])) return json(res, 403, { error: 'bad csrf' }), true
                const o = { id: orders.length + 1, user, ...JSON.parse(await body(req)) }
                orders.push(o)
                return json(res, this.fail || 201, o), true
            }
            if (url.pathname === '/api/orders') {
                if (!keys.has((req.headers.authorization || '').replace(/^Bearer /, ''))) return json(res, 401, { error: 'bad key' }), true
                return json(res, 200, orders.filter((o) => o.user === user)), true
            }
            return json(res, 404, { error: 'no route' }), true
        },
    }
}

// A scenario file in a temp dir (runScenario reads from disk).
export function scenarioFile(text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-test-'))
    const file = path.join(dir, 'test.jevb')
    fs.writeFileSync(file, text.replace(/^\s+/gm, ''))
    return file
}
