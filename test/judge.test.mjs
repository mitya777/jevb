// Jev client + judgment logic against the fake Jev: request shape, retries,
// thresholds, and the pick adjustments (nearby merge, first/last).
import { fakeJev } from './harness/index.mjs'
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

const { ask } = await import('../src/jev.mjs')
const { judge } = await import('../src/judge.mjs')

let jev
before(async () => { jev = await fakeJev() })
beforeEach(() => jev.reset())
after(() => jev.close())

const opts = (...descs) => async () => descs.map((desc, i) => ({ id: `e${i + 1}`, desc }))
const run = (args) => judge({ where: async () => ({ url: 'http://x/', title: 'X' }), state: async () => ({ viewport_text: 'Hello world', fields: [] }), options: opts(), ...args })

test('ask: sends model, bearer key, state and questions', async () => {
    await ask({ a: 1 }, { q: { type: 'noul', instructions: 'say "Hello"' } })
    const [r] = jev.requests
    assert.equal(r.auth, 'Bearer test-key')
    assert.equal(r.model, 'jev-latest')
    assert.deepEqual(r.state, { a: 1 })
})

test('ask: retries 429/503 with backoff, then succeeds', async () => {
    jev.fail(503, 429)
    const { answers } = await ask({ viewport_text: 'Hi' }, { q: { type: 'noul', instructions: '"Hi"' } })
    assert.equal(jev.requests.length, 3)
    assert.equal(answers.q.noul, 0.95)
})

test('ask: a 400 fails at once with the body; retries are bounded', async () => {
    jev.fail(400)
    await assert.rejects(ask({}, { q: { type: 'noul', instructions: '' } }), /Jev 400: upstream/)
    assert.equal(jev.requests.length, 1)
    jev.reset(); jev.fail(503, 503, 503)
    await assert.rejects(ask({}, { q: { type: 'noul', instructions: '' } }, { retries: 2 }), /Jev 503/)
    assert.equal(jev.requests.length, 3)
})

test('judge: pick and checks go as two parallel requests; the pick never sees page text', async () => {
    const res = await run({
        intent: 'post the reply',
        options: opts('button "Post reply" at 10,10', 'a "Home" at 0,0'),
        checks: [{ question: 'is "Hello" shown?' }, { question: 'is "Goodbye" shown?', negate: true }],
    })
    assert.equal(res.requests, 2)
    const [pick] = jev.picks(), [checks] = jev.checks()
    assert.deepEqual(pick.state, { intent: 'post the reply', page: { url: 'http://x/', title: 'X' } })
    assert.deepEqual(Object.keys(checks.questions), ['check_0', 'check_1'])
    assert.ok(Math.abs(pick.at - checks.at) < 50, 'requests were not concurrent')
    assert.equal(res.target.id, 'e1')
    assert.equal(pick.questions.target.criteria.none, 'No element on the page matches the intent')
    assert.deepEqual(res.checks.map((c) => [c.pass, c.threshold]), [[true, 0.7], [true, 0.3]])
})

test('judge: thresholds are inclusive for check, exclusive for refute', async () => {
    jev.answer(() => ({ check_0: { noul: 0.7 }, check_1: { noul: 0.3 }, check_2: { noul: 0.89 } }))
    const res = await run({ checks: [{ question: 'a' }, { question: 'b', negate: true }, { question: 'c', threshold: 0.9 }] })
    assert.deepEqual(res.checks.map((c) => c.pass), [true, false, false])
})

test('judge: an icon and its label 2px apart pool their probability', async () => {
    jev.answer(() => ({ target: { choice: 'e1', confidence: 0.4, probabilities: { e1: 0.4, e2: 0.38, e3: 0.2 } } }))
    const res = await run({ intent: 'go home', options: opts('button "icon: home" at 10,10', 'a "Home" at 12,10', 'a "Hot" at 200,10') })
    assert.equal(res.target.id, 'e1')
    assert.equal(res.target.confidence, 0.78)
    assert.equal(res.target.merged, 2)
})

test('judge: "first"/"last" pick the topmost/bottommost of identical controls', async () => {
    const replies = opts('button "Reply" at 8,300', 'button "Reply (1)" at 8,100', 'button "Reply (2)" at 8,500')
    jev.answer(() => ({ target: { choice: 'e3', confidence: 0.42, probabilities: { e3: 0.42, e1: 0.31, e2: 0.24 } } }))
    const first = await run({ intent: 'click the first Reply button', options: replies })
    assert.deepEqual([first.target.id, first.target.ordinal, first.target.confidence], ['e2', 'first', 0.97])
    const last = await run({ intent: 'click the last reply', options: replies })
    assert.deepEqual([last.target.id, last.target.ordinal], ['e3', 'last'])
    // Mixed kinds of control: no positional override.
    const mixed = await run({ intent: 'click the first Reply button', options: opts('button "Reply" at 8,300', 'a "Reply" at 8,100', 'button "Share" at 8,500') })
    assert.equal(mixed.target.ordinal, undefined)
})

test('judge: "last" wins even when Jev picks the wrong one and another kind takes a share', async () => {
    // Measured on real Jev: "reply to the last post" -> the FIRST Reply 0.44, the textarea 0.22.
    jev.answer(() => ({ target: { choice: 'e2', confidence: 0.35, probabilities: { e2: 0.44, e1: 0.22, none: 0.12, e4: 0.06, e3: 0.05 } } }))
    const res = await run({ intent: 'reply to the last post', options: opts('textarea "Write a reply..." at 8,98', 'button "Reply" at 8,190', 'button "Reply (1)" at 8,261', 'button "Reply (2)" at 8,332') })
    assert.deepEqual([res.target.id, res.target.ordinal, res.target.confidence], ['e4', 'last', 0.55])
})

test('judge: "last" means the last one on screen, not one scrolled far below', async () => {
    jev.answer(() => ({ target: { choice: 'e1', confidence: 0.6, probabilities: { e1: 0.6, e2: 0.3 } } }))
    const res = await run({ intent: 'click the last Reply', options: opts('button "Reply" at 8,100', 'button "Reply (1)" at 8,400', 'button "Reply (2)" offscreen at 8,4000') })
    assert.equal(res.target.id, 'e2')
})

test('judge: no options is an error before any request', async () => {
    await assert.rejects(run({ intent: 'x', options: opts() }), { code: 'NO_ELEMENTS' })
    assert.equal(jev.requests.length, 0)
})
