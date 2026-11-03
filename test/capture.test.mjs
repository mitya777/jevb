// capture/send against the fixture shop: a login form with a CSRF meta
// token and an HttpOnly session cookie, JSON orders with X-CSRF-Token, and
// a bearer token in localStorage. Real Chromium, fake Jev.
import { fakeJev, fixtures } from './harness/index.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { build } from '../src/capture.mjs'

const { JevBrowser } = await import('../src/browser.mjs')

let jev, site, dir
before(async () => { jev = await fakeJev(); site = await fixtures(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-capture-')) })
after(async () => { await jev.close(); await site.close() })

const file = (name) => path.join(dir, name)
const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'))

test('captures hold references, not secrets; a fresh browser replays them without the page', async () => {
    const b = new JevBrowser({ pace: 'agent' })
    let token
    try {
        await b.open(site.url('shop.html'))
        const page = await b.page()
        token = await page.evaluate(() => document.querySelector('meta[name=csrf-token]').content)
        await b.type('the "Email" field', 'me@shop.test', { as: 'EMAIL' })
        await b.type('the "Password" field', 'pw-correct', { as: 'PASSWORD' })
        const login = await b.act('click "Log in"', { capture: file('login.json') })
        assert.deepEqual(login.captured.requests, [`POST ${site.url('api/login')}`])
        await b.type('the "Item" field', 'blue pen')
        await b.type('the "Note" box', 'gift wrap "please"')
        const order = await b.act('click "Place order"', { capture: file('order.json') })
        assert.deepEqual(order.captured.requests, [`POST ${site.url('api/orders')}`], 'third-party analytics left out')
        await b.act('click "My orders"', { capture: file('list.json') })
    } finally { await b.shutdown() }

    const raw = ['login.json', 'order.json', 'list.json'].map((f) => fs.readFileSync(file(f), 'utf8')).join('\n')
    assert.doesNotMatch(raw, /pw-correct|me@shop\.test|blue pen/, 'typed values are parameters')
    assert.ok(!raw.includes(token), 'the CSRF token is a reference')
    assert.doesNotMatch(raw, /"cookie"/i)
    assert.deepEqual(read('login.json').params.sort(), ['EMAIL', 'PASSWORD'])
    assert.match(read('login.json').requests[0].body, /authenticity_token=\{\{@\d+\|form\}\}/)
    assert.deepEqual(Object.values(read('login.json').sources).map((s) => s.from), ['meta'])
    const o = read('order.json')
    assert.deepEqual(o.params.sort(), ['TEXT_3', 'TEXT_4'])
    assert.match(o.requests[0].headers['x-csrf-token'], /^\{\{@\d+\|raw\}\}$/)
    assert.match(o.requests[0].body, /"qty":1/, 'untyped values stay literal')
    const l = read('list.json')
    assert.match(l.requests[0].headers.authorization, /^Bearer \{\{@\d+\|raw\}\}$/)
    assert.deepEqual(Object.values(l.sources).map((s) => [s.from, s.key, s.path]), [['localStorage', 'auth', 'token']])

    // A new browser: no cookies, no pages. send logs in, orders, lists.
    const b2 = new JevBrowser({ pace: 'agent' })
    try {
        const bad = await b2.send(file('login.json'), { values: { EMAIL: 'me@shop.test', PASSWORD: 'nope' } })
        assert.equal(bad.ok, false)
        assert.equal(bad.results[0].status, 401)
        await assert.rejects(b2.send(file('login.json'), { values: { EMAIL: 'me@shop.test' } }), { code: 'MISSING_PARAM' })
        const before = site.shop.orders.length
        const r1 = await b2.send(file('login.json'), { values: { EMAIL: 'me@shop.test', PASSWORD: 'pw-correct' } })
        assert.equal(r1.ok, true, JSON.stringify(r1))
        const r2 = await b2.send(file('order.json'), { values: { TEXT_3: 'red pen', TEXT_4: 'no "wrap"' } })
        assert.equal(r2.results[0].status, 201, JSON.stringify(r2))
        assert.deepEqual(site.shop.orders.at(-1), { id: before + 1, user: 'me@shop.test', item: 'red pen', note: 'no "wrap"', qty: 1 })
        const r3 = await b2.send(file('list.json'))
        assert.equal(r3.results[0].status, 200, JSON.stringify(r3))
        assert.ok(r3.results[0].json.some((x) => x.item === 'red pen'))
    } finally { await b2.shutdown() }
})

test('typed text is replaced only as a whole value', () => {
    const cap = build({
        page: 'https://x.test/',
        params: [{ name: 'QTY', value: '1' }, { name: 'Q', value: 'pen' }],
        sources: [],
        requests: [
            { method: 'POST', url: 'https://x.test/api/v1/cart?q=pen&page=1', headers: { 'content-type': 'application/json' }, body: '{"qty":"1","sku":"A1","note":"pens"}' },
            { method: 'POST', url: 'https://x.test/a', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'qty=1&q=pen&sku=pen1' },
        ],
    })
    assert.equal(cap.requests[0].url, 'https://x.test/api/v1/cart?q={{Q|url}}&page={{QTY|url}}')
    assert.equal(cap.requests[0].body, '{"qty":"{{QTY|json}}","sku":"A1","note":"pens"}')
    assert.equal(cap.requests[1].body, 'qty={{QTY|form}}&q={{Q|form}}&sku=pen1')
})

test('a credential header with no source in the page becomes a parameter', () => {
    const cap = build({
        page: 'https://x.test/', params: [], sources: [],
        requests: [{ method: 'GET', url: 'https://x.test/admin', headers: { 'x-api-key': 'sk_live_abcdefghijklmnop', accept: 'application/json' } }],
    })
    assert.equal(cap.requests[0].headers['x-api-key'], '{{HEADER_X_API_KEY|raw}}')
    assert.deepEqual(cap.params, ['HEADER_X_API_KEY'])
    assert.doesNotMatch(JSON.stringify(cap), /sk_live/)
})

test('scenarios: capture names ${NAME} parameters; send fills them from the env', async () => {
    const { runScenario } = await import('../src/scenario.mjs')
    const { scenarioFile } = await import('./harness/index.mjs')
    process.env.SHOP_EMAIL = 'env@shop.test'
    process.env.SHOP_PASSWORD = 'pw-correct'
    const run = (text) => runScenario(scenarioFile(text), { baseUrl: site.base, pace: 'agent', onStep: () => {} })
    const out = file('scenario-login.json')
    const r1 = await run(`open shop.html\ntype the "Email" field => \${SHOP_EMAIL}\ntype the "Password" field => \${SHOP_PASSWORD}\ncapture ${out}\nact click "Log in"`)
    assert.equal(r1.failed, 0, JSON.stringify(r1.results))
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).params.sort(), ['SHOP_EMAIL', 'SHOP_PASSWORD'])
    const r2 = await run(`send ${out}`)
    assert.equal(r2.failed, 0, JSON.stringify(r2.results))
    assert.equal(r2.results[0].results[0].json.email, '***', 'logged in; the env value is redacted from results')
    const r3 = await run(`send ${out} SHOP_PASSWORD=wrong`)
    assert.equal(r3.failed, 1, 'a 401 fails the step')
})

test('a classic form post with a hidden token, and a live search while typing', async () => {
    const b = new JevBrowser({ pace: 'agent' })
    try {
        await b.open(site.url('shop.html'))
        const search = await b.type('the "Search" field', 'blue pen', { capture: file('search.json') })
        assert.ok(search.captured.requests.length >= 1, 'requests sent while typing are captured')
        assert.match(read('search.json').requests.at(-1).url, /\/api\/search\?q=\{\{TEXT_1\|form\}\}$/)
        await b.type('the "Newsletter email" field', 'news@shop.test', { as: 'NEWS' })
        await b.act('click "Subscribe"', { capture: file('subscribe.json') })
    } finally { await b.shutdown() }
    const s = read('subscribe.json')
    assert.match(s.requests[0].body, /^authenticity_token=\{\{@\d+\|form\}\}&news_email=\{\{NEWS\|form\}\}$/)
    assert.deepEqual(Object.values(s.sources).map((x) => [x.from, x.name]), [['input', 'authenticity_token']])
    const b2 = new JevBrowser({ pace: 'agent' })
    try {
        const r = await b2.send(file('subscribe.json'), { values: { NEWS: 'again@shop.test' } })
        assert.equal(r.ok, true, JSON.stringify(r))
        assert.match(r.results[0].body, /Subscribed again@shop\.test/)
        const q = await b2.send(file('search.json'), { values: { TEXT_1: 'red ink' } })
        assert.deepEqual(q.results.at(-1).json, { q: 'red ink' })
    } finally { await b2.shutdown() }
})

test('a credential body field with no source becomes a parameter; short look-alikes stay', () => {
    const cap = build({
        page: 'https://x.test/', params: [], sources: [],
        requests: [
            { method: 'POST', url: 'https://x.test/a', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf_token=abcdef0123456789xyz&keyword=shoes&qty=2' },
            { method: 'POST', url: 'https://x.test/b', headers: { 'content-type': 'application/json' }, body: '{"apiKey":"sk_abcdefghijklmnop","password":"hunter2","sort":"new"}' },
        ],
    })
    assert.equal(cap.requests[0].body, 'csrf_token={{FIELD_CSRF_TOKEN|form}}&keyword=shoes&qty=2')
    assert.equal(cap.requests[1].body, '{"apiKey":"{{FIELD_APIKEY|json}}","password":"{{FIELD_PASSWORD|json}}","sort":"new"}')
    assert.doesNotMatch(JSON.stringify(cap), /abcdef0123456789xyz|sk_abc|hunter2/)
})

test('a redirected POST is captured once and replayed once', async () => {
    const b = new JevBrowser({ pace: 'agent' })
    try {
        await b.open(site.url('shop.html'))
        await b.type('the "Email" field', 'me@shop.test'); await b.type('the "Password" field', 'pw-correct')
        await b.act('click "Log in"')
        const r = await b.act('click "Reorder"', { capture: file('reorder.json') })
        assert.deepEqual(r.captured.requests, [`POST ${site.url('api/reorder')}`], 'the 307 hop is not a second request')
        const n = site.shop.orders.length
        const s = await b.send(file('reorder.json'))
        assert.equal(s.ok, true, JSON.stringify(s))
        assert.equal(site.shop.orders.length, n + 1, 'one order, not two')
    } finally { await b.shutdown() }
})

test('credential fields in multipart and spaced JSON bodies become parameters', () => {
    const typed = [{ name: 'PASSWORD', value: 'typed-pw' }]
    const mp = '--B\r\nContent-Disposition: form-data; name="user"\r\n\r\nme\r\n--B\r\nContent-Disposition: form-data; name="password"\r\n\r\ntyped-pw\r\n--B\r\nContent-Disposition: form-data; name="api_token"\r\n\r\ntok_0123456789abcdef\r\n--B--\r\n'
    const cap = build({
        page: 'https://x.test/', params: typed, sources: [],
        requests: [
            { method: 'POST', url: 'https://x.test/a', headers: { 'content-type': 'multipart/form-data; boundary=B' }, body: mp },
            { method: 'POST', url: 'https://x.test/b', headers: { 'content-type': 'application/json' }, body: '{"user": "me", "password" : "autofilled-pw"}' },
        ],
    })
    assert.match(cap.requests[0].body, /name="password"\r\n\r\n\{\{PASSWORD\|raw\}\}\r\n/)
    assert.match(cap.requests[0].body, /name="api_token"\r\n\r\n\{\{FIELD_API_TOKEN\|raw\}\}\r\n/)
    assert.equal(cap.requests[1].body, '{"user": "me", "password" : "{{FIELD_PASSWORD|json}}"}')
    assert.doesNotMatch(JSON.stringify(cap), /typed-pw|tok_0123|autofilled-pw/)
})

test('the stored page URL drops a query that carries a token', () => {
    const cap = build({
        page: 'https://x.test/reset?reset_token=abcdef0123456789&lang=en', params: [], sources: [],
        requests: [{ method: 'POST', url: 'https://x.test/api/reset', headers: { 'content-type': 'application/json' }, body: '{"reset_token":"abcdef0123456789"}' }],
    })
    assert.equal(cap.page, 'https://x.test/reset')
    assert.doesNotMatch(JSON.stringify(cap), /abcdef0123456789/)
    assert.equal(build({ page: 'https://x.test/p?tab=2', params: [], sources: [], requests: [] }).page, 'https://x.test/p?tab=2')
})

test('a human-pace live search keeps only the last request, so no prefix of the text is saved', async () => {
    const b = new JevBrowser({ pace: 'human' })
    try {
        await b.open(site.url('shop.html'))
        const r = await b.type('the "Search" field', 'private', { capture: file('search-human.json') })
        assert.equal(r.captured.requests.length, 1)
    } finally { await b.shutdown() }
    const raw = fs.readFileSync(file('search-human.json'), 'utf8')
    assert.match(raw, /q=\{\{TEXT_1\|(form|url)\}\}/)
    assert.doesNotMatch(raw, /q=p|private/)
})
