// Recorded selectors, and how jevb run chooses between send, selectors and
// Jev. Real Chromium, fake Jev, the fixture shop.
import { fakeJev, fixtures, scenarioFile } from './harness/index.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { assess } from '../src/capture.mjs'
import { chooseTier, isRelative, toPlaywright } from '../src/script.mjs'

process.env.JEVB_SCRIPT_WAIT_MS = '300'
const { runScenario, parse } = await import('../src/scenario.mjs')
const { JevBrowser } = await import('../src/browser.mjs')

let jev, site
before(async () => { jev = await fakeJev(); site = await fixtures() })
after(async () => { await jev.close(); await site.close() })
beforeEach(() => { jev.reset(); site.shop.fail = null })

const run = (file, opts = {}) => runScenario(file, { baseUrl: site.base, onStep: () => {}, ...opts })
const CHECKED = `open flow.html
type the "Write a reply" box => hi there
act click "Post reply"
check is "Posted: hi there" shown?
`
const LOGIN = 'open shop.html\ntype the "Email" field => me@shop.test\ntype the "Password" field => pw-correct\nact click "Log in"\n'
const ORDER = `${LOGIN}type the "Item" field => blue pen\nact click "Place order"\n`

test('the first run records selectors in the file; the next needs Jev only for checks', async () => {
    const file = scenarioFile(CHECKED)
    const first = await run(file)
    assert.equal(first.failed, 0, JSON.stringify(first.results))
    assert.equal(first.via, 'page')
    assert.equal(first.scripted, 0)
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /type the "Write a reply" box => hi there {2}@@ textarea\[placeholder="Write a reply\.\.\."\]/)
    assert.match(text, /act click "Post reply" {2}@@ role=button\[name="Post reply"s\]/)
    assert.deepEqual(parse(text)[2].src, 'act click "Post reply"')

    jev.reset()
    const second = await run(file)
    assert.equal(second.failed, 0, JSON.stringify(second.results))
    assert.equal(second.scripted, 2)
    assert.equal(jev.picks().length, 0, 'no element choices')
    assert.ok(jev.checks().length >= 1, 'the check is still judged')
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'nothing to change')
})

test('a selector that stopped matching falls back to Jev and repairs the file', async () => {
    const file = scenarioFile(CHECKED.replace('act click "Post reply"', 'act click "Post reply"  @@ role=button[name="Gone"s]  # keep me'))
    const r = await run(file)
    assert.equal(r.failed, 0, JSON.stringify(r.results))
    assert.equal(r.healed, 1)
    assert.equal(jev.picks().length, 2)
    assert.match(fs.readFileSync(file, 'utf8'), /act click "Post reply" {2}@@ role=button\[name="Post reply"s\] {2}# keep me/)
})

test('a selector matching several elements is not used; "the first X" is never recorded', async () => {
    const many = scenarioFile('open flow.html\nact click Reply  @@ button\ncheck is "Replying to" shown?\n')
    const r = await run(many, { record: false })
    assert.equal(r.scripted, 0)
    assert.equal(jev.picks().length, 1)
    assert.ok(isRelative('open the newest thread'))
    const first = scenarioFile('open flow.html\nact click the first "Reply" button\n')
    await run(first)
    assert.doesNotMatch(fs.readFileSync(first, 'utf8'), /@@/)
})

test('--via jev ignores selectors and writes none', async () => {
    const file = scenarioFile(CHECKED.replace('act click "Post reply"', 'act click "Post reply"  @@ role=button[name="Post reply"s]'))
    const r = await run(file, { via: 'jev', record: true })
    assert.equal(r.scripted, 0)
    assert.equal(jev.picks().length, 2)
})

test('a flow that only sends data replays by request once its capture says it can', async () => {
    const file = scenarioFile(ORDER)
    const first = await run(file)
    assert.equal(first.failed, 0, JSON.stringify(first.results))
    assert.equal(first.via, 'page')
    const cap = JSON.parse(fs.readFileSync(`${file}.capture.json`, 'utf8'))
    assert.deepEqual(cap.replay, { ok: true, reasons: [] })
    assert.deepEqual(cap.requests.map((r) => [r.method, r.status]), [['POST', 200], ['POST', 201]])
    assert.doesNotMatch(JSON.stringify(cap), /pw-correct|blue pen/)

    jev.reset()
    const n = site.shop.orders.length
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('blue pen', 'red pen')) // typed text can change
    const second = await run(file)
    assert.equal(second.failed, 0, JSON.stringify(second.results))
    assert.equal(second.via, 'send')
    assert.equal(jev.requests.length, 0, 'no model at all')
    assert.equal(site.shop.orders.length, n + 1)
    assert.equal(site.shop.orders.at(-1).item, 'red pen')
})

test('another host, or a changed flow, re-records instead of sending', async () => {
    const file = scenarioFile(ORDER)
    await run(file)
    const other = await fixtures()
    try {
        const n = site.shop.orders.length
        const r = await runScenario(file, { baseUrl: other.base, onStep: () => {} })
        assert.equal(r.via, 'page')
        assert.equal(site.shop.orders.length, n, 'nothing went to the recorded host')
        assert.equal(other.shop.orders.length, 1)
    } finally { await other.close() }
})

test('a refused send (4xx) runs through the page; the capture is not trusted again', async () => {
    const file = scenarioFile(LOGIN)
    await run(file)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('pw-correct', 'wrong'))
    const steps = []
    const r = await runScenario(file, { baseUrl: site.base, onStep: (x) => steps.push(x) })
    assert.equal(r.via, 'page')
    assert.deepEqual(steps.filter((x) => x.via).map((x) => x.via), ['send', 'page'])
    assert.equal(JSON.parse(fs.readFileSync(`${file}.capture.json`, 'utf8')).replay.ok, false)
})

test('a 5xx may have taken effect: the run fails and never repeats the order', async () => {
    const file = scenarioFile(ORDER)
    await run(file)
    const n = site.shop.orders.length
    site.shop.fail = 500
    const r = await run(file)
    assert.equal(r.via, 'send')
    assert.equal(r.failed, 1)
    assert.match(r.results.at(-1).error, /not re-run/)
    assert.equal(site.shop.orders.length, n + 1, 'one attempt only')
})

test('a flow with a check always uses the page', async () => {
    const file = scenarioFile(`${ORDER}check is "placed" shown?\n`)
    await run(file)
    const r = await run(file)
    assert.equal(r.via, 'page')
    assert.ok(r.scripted >= 4)
    assert.equal(fs.existsSync(`${file}.capture.json`), false)
})

test('assess: what makes a capture unsafe to replay', () => {
    const req = (o = {}) => ({ method: 'POST', url: 'https://x.test/a', headers: {}, status: 200, ...o })
    const cap = (requests, params = []) => ({ requests, params })
    assert.deepEqual(assess(cap([req({ body: '{"a":"b"}' })]), { order: [0] }), { ok: true, reasons: [] })
    const why = (c, o = {}) => assess(c, { order: c.requests.map((_, i) => i), ...o }).reasons.join('; ')
    assert.match(why(cap([])), /sends no requests/)
    assert.match(why(cap([req({ status: null })])), /never finished/)
    assert.match(why(cap([req()]), { wsFrames: 2 }), /websocket/)
    assert.match(why(cap([req({ body: 'signature=abc&x=1' })])), /one-time field signature/)
    assert.match(why(cap([req({ body: '{"nonce":"abc"}' })])), /one-time field nonce/)
    assert.match(why(cap([req({ headers: { 'x-request-id': 'abc' } })])), /one-time header/)
    assert.match(why(cap([req({ body: `{"tx":"${'ab'.repeat(40)}"}` })])), /computed in the page/)
    assert.match(why(cap([req({ body: 'filename="a.png"' })])), /uploads a file/)
    assert.match(why(cap([req()], ['FIELD_API_KEY'])), /no known source/)
    assert.match(why(cap([req({ body: 'a=b' })]), { typed: [{ value: 'same' }, { value: 'same' }] }), /same text/)
    assert.match(why(cap([req({ url: 'https://x.test/items/42/publish' })]), { order: [1], responses: [{ order: 0, text: '{"id":42}' }] }), /earlier response/)
    assert.match(why(cap([req({ url: 'https://x.test/posts/48213/publish' })]), { order: [1], responses: [{ order: 0, text: '{"id":48213}' }] }), /earlier response/)
})

test('chooseTier: every reason to stay on the page', () => {
    const steps = parse('open /\nact go\n')
    const cap = { hash: 'h', replay: { ok: true } }
    const base = { steps, cap, hash: 'h', pace: 'fast' }
    assert.equal(chooseTier(base).tier, 'send')
    for (const [over, why] of [
        [{ via: 'page' }, /via page/], [{ onDevice: true }, /phone/], [{ demo: true }, /recording/], [{ pace: 'human' }, /human/],
        [{ steps: parse('open /\ncheck ok?\n') }, /reads the page/], [{ steps: parse('open /\nact? maybe\n') }, /reads the page/],
        [{ cap: null }, /no capture/], [{ hash: 'other' }, /changed/], [{ cap: { hash: 'h', replay: { ok: false, reasons: ['talks over a websocket'] } } }, /websocket/],
    ]) {
        const d = chooseTier({ ...base, ...over })
        assert.equal(d.tier, 'page')
        assert.match(d.why, why)
    }
})

test('export writes a Playwright script that runs with no jevb and no model', async () => {
    const file = scenarioFile(CHECKED)
    await run(file)
    jev.reset()
    const code = toPlaywright(parse(fs.readFileSync(file, 'utf8')), { baseUrl: site.base })
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-export-')), 'flow.mjs')
    fs.writeFileSync(out, code)
    const { run: flow } = await import(out)
    const b = new JevBrowser({ pace: 'fast' })
    try {
        const page = await b.page()
        await flow(page)
        assert.match(await page.locator('body').innerText(), /Posted: hi there/)
        assert.equal(jev.requests.length, 0)
    } finally { await b.shutdown() }
})

test('stableLocator: inner text hits, hidden duplicates, position only for a few, nothing for a list', async () => {
    const { stableLocator } = await import('../src/script.mjs')
    const b = new JevBrowser({ pace: 'fast' })
    try {
        const page = await b.page()
        await page.setContent(`
            <div data-jevb="pill" style="cursor:pointer"><span>Hot</span></div>
            <a href="/x" data-jevb="shown">Explore</a><a href="/x" style="display:none">Explore</a>
            <a href="/y">Now</a><a href="/y" data-jevb="second">Now</a>
            ${'<button>Reply</button>'.repeat(5)}<button data-jevb="reply">Reply</button>
            <input data-jevb="pw" type="password" placeholder="me@secret.test">`)
        assert.equal(await stableLocator(page, 'pill'), 'text="Hot"')
        assert.equal(await stableLocator(page, 'shown'), 'role=link[name="Explore"s]')
        assert.equal(await stableLocator(page, 'second'), 'role=link[name="Now"s] >> visible=true >> nth=1')
        assert.equal(await stableLocator(page, 'reply'), null, 'one of many: stays with Jev')
        assert.equal(await stableLocator(page, 'pw', { avoid: ['me@secret.test'] }), null, 'never writes typed text')
    } finally { await b.shutdown() }
})

test('a request that lands after its step is part of the flow, so replay sends it too', async () => {
    const file = scenarioFile('open shop.html\nact click "Late save"\n')
    const b0 = site.shop
    const r = await run(file)
    assert.equal(r.failed, 0, JSON.stringify(r.results))
    const cap = JSON.parse(fs.readFileSync(`${file}.capture.json`, 'utf8'))
    assert.deepEqual(cap.requests.map((x) => new URL(x.url).pathname), ['/api/autosave'])
    const n = b0.autosaves
    assert.equal((await run(file)).via, 'send')
    assert.equal(b0.autosaves, n + 1)
})
