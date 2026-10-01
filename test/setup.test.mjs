// `jevb setup` with the fake Jev: ready, missing key, rejected key.
import { fakeJev } from './harness/index.mjs'
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

const { setup } = await import('../src/setup.mjs')

let jev
before(async () => { jev = await fakeJev() })
beforeEach(() => { jev.reset(); process.env.TYPESAFEAI_API_KEY = 'test-key' })
after(() => jev.close())

const byName = (res) => Object.fromEntries(res.checks.map((c) => [c.name, c]))

test('ready: node, browser and a working Jev key', async () => {
    const res = await setup({ install: false })
    assert.equal(res.ok, true, JSON.stringify(res, null, 1))
    assert.deepEqual(res.checks.map((c) => c.name), ['node', 'browser', 'jev'])
    assert.equal(jev.requests.length, 1, 'one tiny Jev call')
    assert.ok(res.optional.every((o) => 'ok' in o))
})

test('no key: not ready, and the fix says where to get one', async () => {
    process.env.TYPESAFEAI_API_KEY = ''
    process.env.TYPESAFE_API_KEY = ''
    const res = await setup({ install: false })
    assert.equal(res.ok, false)
    assert.match(byName(res).jev.fix, /console\.typesafe\.ai\/keys/)
    assert.equal(jev.requests.length, 0)
})

test('rejected key: not ready, told to make a new one', async () => {
    jev.fail(401)
    const res = await setup({ install: false })
    assert.equal(res.ok, false)
    assert.match(byName(res).jev.detail, /Jev 401/)
    assert.match(byName(res).jev.fix, /rejected/)
})
