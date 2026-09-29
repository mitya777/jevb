import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ReplayCache, fingerprint, pageKey } from '../src/cache.mjs'

// A fake Jev: picks the option sharing the most words with the intent, and
// answers a check by whether its "quoted text" is on screen. Counts requests.
const calls = { choice: 0, noul: 0 }
let server
before(async () => {
    server = http.createServer(async (req, res) => {
        let body = ''
        for await (const c of req) body += c
        const { state, questions } = JSON.parse(body)
        const answers = {}
        for (const [key, q] of Object.entries(questions)) {
            if (q.type === 'choice') {
                calls.choice++
                const words = new Set(state.intent.toLowerCase().split(/\W+/).filter((w) => w.length > 2))
                const score = (d) => d.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length
                const [best] = Object.entries(q.criteria).filter(([id]) => id !== 'none').sort((a, b) => score(b[1]) - score(a[1]))
                const pick = best && score(best[1]) ? best[0] : 'none'
                answers[key] = { choice: pick, confidence: 0.9, probabilities: { [pick]: 0.9 } }
            } else {
                calls.noul++
                const quoted = q.instructions.match(/"([^"]+)"/)?.[1] || ''
                answers[key] = { noul: state.viewport_text.includes(quoted) ? 0.95 : 0.05 }
            }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ answers, usage: { input_tokens: 10, output_tokens: 1 }, model: 'fake' }))
    }).listen(0)
    await new Promise((r) => server.once('listening', r))
    process.env.TYPESAFE_ENDPOINT = `http://127.0.0.1:${server.address().port}`
    process.env.TYPESAFEAI_API_KEY = 'test-key'
    process.env.JEVB_CACHE = 'off' // tests pass their own ReplayCache; never touch ./.jevb
    delete process.env.JEVB_REPLAY
})
after(() => server.close())

const fixture = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture.html')).href
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-cache-'))
const reset = () => { calls.choice = 0; calls.noul = 0 }
const quiet = () => {}

async function run(dir, text, opts = {}) {
    const { runScenario } = await import('../src/scenario.mjs')
    const file = path.join(dir, 'test.jevb')
    fs.writeFileSync(file, text)
    return runScenario(file, { pace: 'agent', onStep: quiet, ...opts })
}

const SCENARIO = (url = fixture) => `open ${url}
type the Write a reply box => hello from jevb
act Post reply
check does the page show "Posted: hello from jevb"?
refute does the page show "Error"?
`

test('a repeat run replays picks and checks without asking Jev', async () => {
    const dir = tmp()
    const cache = new ReplayCache(path.join(dir, 'cache.json'))
    reset()
    const first = await run(dir, SCENARIO(), { cache, replay: true })
    assert.equal(first.failed, 0)
    assert.equal(calls.choice, 2)
    assert.equal(calls.noul, 2)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'cache.json'), 'utf8'))
    assert.deepEqual(Object.values(saved.picks).map((e) => e[0].fp).sort(), ['button "Post reply"', 'textarea "Write a reply..."'])
    assert.ok(!JSON.stringify(saved).includes('hello from jevb'), 'typed text is not stored')

    reset()
    const second = await run(dir, SCENARIO(), { cache: new ReplayCache(path.join(dir, 'cache.json')), replay: true })
    assert.equal(second.failed, 0)
    assert.deepEqual(calls, { choice: 0, noul: 0 })
    assert.deepEqual(second.cacheHits, { picks: 2, checks: 2 })
    assert.equal(second.jevCalls, 0)
    assert.ok(second.results.find((r) => r.step === 'act Post reply').clicked.cached)
})

test('a changed screen falls back to Jev and re-records', async () => {
    const dir = tmp()
    const file = path.join(dir, 'cache.json')
    await run(dir, SCENARIO(), { cache: new ReplayCache(file), replay: true })
    // Same page, but the button is renamed: the cached fingerprint is gone.
    const changed = path.join(dir, 'changed.html')
    fs.writeFileSync(changed, fs.readFileSync(new URL(fixture), 'utf8').replace('>Post reply<', '>Post your reply<'))
    const changedUrl = pathToFileURL(changed).href
    // Different file = different page key, so point the old key's entry at it.
    const c = new ReplayCache(file)
    for (const k of Object.keys(c.data.picks)) c.data.picks[k.replace(pageKey(fixture), pageKey(changedUrl))] = c.data.picks[k]
    reset()
    const res = await run(dir, SCENARIO(changedUrl), { cache: c, replay: true })
    assert.equal(res.failed, 0)
    assert.equal(calls.choice, 1, 'only the renamed button needed Jev')
    assert.equal(c.data.picks[`${pageKey(changedUrl)} Post reply`][0].fp, 'button "Post your reply"')
})

test('ambiguous matches are not replayed', () => {
    const c = new ReplayCache(path.join(tmp(), 'c.json'))
    const els = [{ id: 'e1', desc: 'button "Reply" at 10,100' }, { id: 'e2', desc: 'button "Reply" at 10,300' }]
    c.rememberPick('p', 'reply to Bob', { desc: els[1].desc, confidence: 0.8 }, els)
    assert.equal(c.pick('p', 'reply to Bob', els), null, 'two identical buttons: not cached')
    c.rememberPick('p', 'the last Reply button', { desc: els[1].desc, confidence: 0.8, ordinal: 'last' }, els)
    assert.equal(c.pick('p', 'the last Reply button', els).el.id, 'e2', 'ordinal picks replay by position')
    // Jev confident about one of several: "first" in the intent is enough, if it is the topmost.
    c.rememberPick('p', 'the first visible Reply button', { desc: els[0].desc, confidence: 0.95 }, els)
    assert.equal(c.pick('p', 'the first visible Reply button', els).el.id, 'e1')
    c.rememberPick('p', 'the first Reply under Bob', { desc: els[1].desc, confidence: 0.95 }, els)
    assert.equal(c.pick('p', 'the first Reply under Bob', els), null, 'not the topmost: not replayable')
})

test('secrets never reach the cache file', () => {
    const c = new ReplayCache(path.join(tmp(), 'c.json'))
    c.secrets.add('hunter22')
    const els = [{ id: 'e1', desc: 'input "hunter22" type=password at 0,0' }]
    c.rememberPick('p', 'the password field', { desc: els[0].desc, confidence: 0.9 }, els)
    assert.deepEqual(c.data.picks, {})
})

test('fingerprints ignore position and field values; page keys fold ids', () => {
    assert.equal(fingerprint('textbox "Email" value="a@b.c" at 12,300'), 'textbox "Email"')
    assert.equal(fingerprint('a "Home" href=/home offscreen at 3,-40'), 'a "Home" href=/home')
    assert.equal(pageKey('https://app.treechat.com/t/12345?x=1#y'), 'app.treechat.com/t/:id')
    assert.equal(pageKey('https://x.com/p/0f8a4c2e-1b2c-4d5e-8f90-123456789abc'), 'x.com/p/:id')
})

test('do runs a Playwright block, and falls back to .jevb steps when it fails', async () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, 'actions'))
    fs.writeFileSync(path.join(dir, 'actions', 'reply.mjs'), `
export async function browser({ page, args }) {
    if (args.text === 'boom') throw new Error('selector drifted')
    await page.fill('textarea', args.text)
    await page.click('#post')
    return { via: 'playwright' }
}`)
    fs.writeFileSync(path.join(dir, 'actions', 'reply.jevb'), 'type the Write a reply box => ${text}\nact Post reply\n')
    process.env.JEVB_TEST_TEXT = 'from env'

    reset()
    const fast = await run(dir, `open ${fixture}\ndo reply text="hi there"\ncheck does the page show "Posted: hi there"?\n`, { cache: false, replay: true })
    assert.equal(fast.failed, 0)
    assert.equal(calls.choice, 0, 'the block used no Jev picks')
    assert.equal(fast.results[1].ran, 'reply.mjs')

    reset()
    const fell = await run(dir, `open ${fixture}\ndo reply text=boom\ncheck does the page show "Posted: boom"?\n`, { cache: false, replay: true })
    assert.equal(fell.failed, 0)
    assert.equal(calls.choice, 2)
    const step = fell.results.find((r) => r.action === 'reply')
    assert.equal(step.ran, 'reply.jevb')
    assert.match(step.fallback, /selector drifted/)
    assert.ok(fell.results.some((r) => r.step === 'reply › act Post reply'))

    // Only the .jevb: env values pass through as arguments.
    fs.rmSync(path.join(dir, 'actions', 'reply.mjs'))
    const plain = await run(dir, `open ${fixture}\ndo reply text=\${JEVB_TEST_TEXT}\ncheck does the page show "Posted: from env"?\n`, { cache: false })
    assert.equal(plain.failed, 0)
})

test('a missing action or argument fails before anything runs', async () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, 'actions'))
    fs.writeFileSync(path.join(dir, 'actions', 'reply.jevb'), 'type the reply box => ${text}\n')
    await assert.rejects(run(dir, `open ${fixture}\ndo nope\n`, { cache: false }), /action "nope" not found/)
    await assert.rejects(run(dir, `open ${fixture}\ndo reply\n`, { cache: false }), /missing argument text/)
})

test('picks inside an action replay for any argument value', async () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, 'actions'))
    fs.writeFileSync(path.join(dir, 'actions', 'nav.jevb'), 'act open the ${section} link\n')
    const cache = () => new ReplayCache(path.join(dir, 'cache.json'))

    reset()
    assert.equal((await run(dir, `open ${fixture}\ndo nav section=Home\n`, { cache: cache(), replay: true })).failed, 0)
    assert.equal(calls.choice, 1)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'cache.json'), 'utf8'))
    assert.deepEqual(saved.picks, { [`${pageKey(fixture)} open the \${section} link`]: [{ fp: 'a "${section}"', confidence: 0.9 }] })

    reset()
    const other = await run(dir, `open ${fixture}\ndo nav section=Settings\n`, { cache: cache(), replay: true })
    assert.equal(other.failed, 0)
    assert.equal(calls.choice, 0, 'a new value replays the template')
    const step = other.results.find((r) => r.step === 'nav › act open the Settings link')
    assert.equal(step.clicked.cached, true)
    assert.match(step.url, /#settings$/)
})

test('argument values are never stored, even when they are secrets', () => {
    const c = new ReplayCache(path.join(tmp(), 'c.json'))
    c.secrets.add('s3cret-user')
    const els = [{ id: 'e1', desc: 'clickable "s3cret-user" at 0,0' }]
    const template = { intent: 'open the profile of ${who}', values: { who: 's3cret-user' } }
    c.rememberPick('p', 'open the profile of s3cret-user', { desc: els[0].desc, confidence: 0.9 }, els, template)
    assert.deepEqual(c.data.picks, { 'p open the profile of ${who}': [{ fp: 'clickable "${who}"', confidence: 0.9 }] })
    assert.equal(c.pick('p', 'open the profile of s3cret-user', els, template).el.id, 'e1')
})

test('replay is off by default: every pick asks Jev, nothing is written, code blocks are skipped', async () => {
    const dir = tmp()
    const file = path.join(dir, 'cache.json')
    await run(dir, SCENARIO(), { cache: new ReplayCache(file), replay: true }) // a warm cache exists
    reset()
    const res = await run(dir, SCENARIO(), { cache: new ReplayCache(file) })
    assert.equal(res.failed, 0)
    assert.deepEqual(calls, { choice: 2, noul: 2 }, 'the warm cache is ignored')
    assert.equal(res.replay, false)
    assert.equal(res.cacheHits, null)

    fs.mkdirSync(path.join(dir, 'actions'))
    fs.writeFileSync(path.join(dir, 'actions', 'reply.mjs'), 'export async function browser({ page }) { throw new Error("should not run") }\n')
    fs.writeFileSync(path.join(dir, 'actions', 'reply.jevb'), 'type the Write a reply box => ${text}\nact Post reply\n')
    const plain = await run(dir, `open ${fixture}\ndo reply text=hi\n`, { cache: false })
    assert.equal(plain.failed, 0)
    assert.equal(plain.results.find((r) => r.action === 'reply').ran, 'reply.jevb')
    assert.equal(plain.results.find((r) => r.action === 'reply').fallback, undefined)

    // A code-only action needs replay: caught before anything runs.
    fs.writeFileSync(path.join(dir, 'actions', 'fast.mjs'), 'export async function browser() {}\n')
    await assert.rejects(run(dir, `open ${fixture}\ndo fast\n`, { cache: false }), /only a code block .* replay is off/)
    // ...unless the scenario turns replay on itself.
    const on = await run(dir, `replay on\nopen ${fixture}\ndo fast\n`, { cache: false })
    assert.equal(on.failed, 0)
    assert.equal(on.results.find((r) => r.action === 'fast').ran, 'fast.mjs')
    // An explicit option beats the scenario line, like --pace.
    await assert.rejects(run(dir, `replay on\nopen ${fixture}\ndo fast\n`, { cache: false, replay: false }), /replay is off/)
})

test('replay can be switched per call on a browser (the CLI --replay flag)', async () => {
    const { JevBrowser } = await import('../src/browser.mjs')
    const dir = tmp()
    const b = new JevBrowser({ cache: new ReplayCache(path.join(dir, 'c.json')) })
    assert.equal(b.replay, false)
    try {
        await b.open(fixture)
        reset()
        await b.act('Post reply', { replay: true }) // records
        await b.act('Post reply', { replay: true }) // replays
        await b.act('Post reply') // default off: asks Jev
        assert.equal(calls.choice, 2)
    } finally {
        await b.shutdown()
    }
})
