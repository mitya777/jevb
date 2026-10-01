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
    const server = http.createServer(async (req, res) => {
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
    return { base, url: (p = '') => new URL(p, base).href, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r) }) }
}

// A scenario file in a temp dir (runScenario reads from disk).
export function scenarioFile(text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-test-'))
    const file = path.join(dir, 'test.jevb')
    fs.writeFileSync(file, text.replace(/^\s+/gm, ''))
    return file
}
