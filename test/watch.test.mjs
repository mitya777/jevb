// Scriptable-run hints: pure bookkeeping, no browser or Jev.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Watch } from '../src/watch.mjs'

const clock = () => { let t = 0; const now = () => t; now.add = (ms) => { t += ms }; return now }

test('three steps in a row draft a scenario; typed text becomes a placeholder', () => {
    const w = new Watch({ now: clock() })
    assert.equal(w.record('open', { url: 'https://x.test/' }), null)
    assert.equal(w.record('type', { intent: 'the password field', text: 'hunter2', submit: true }), null)
    const hint = w.record('act', { intent: 'click Save', checks: [{ question: 'is "Saved" shown?', negate: true }] })
    assert.equal(hint.scenario, 'open https://x.test/\ntype the password field => ${TEXT_1}\npress Enter\nrefute is "Saved" shown?\nact click Save')
    assert.match(hint.env, /TEXT_1/)
    assert.doesNotMatch(JSON.stringify(hint), /hunter2/)
})

test('hints at 3, then every 5 steps; a long gap or another session starts over', () => {
    const now = clock()
    const w = new Watch({ now })
    const hinted = []
    for (let i = 1; i <= 8; i++) if (w.record('press', { key: 'Enter' })) hinted.push(i)
    assert.deepEqual(hinted, [3, 8])
    now.add(61_000)
    assert.equal(w.record('press', { key: 'Enter' }), null, 'gap reset the run')
    assert.equal(w.record('press', { key: 'Enter', session: 'b' }), null)
    assert.equal(w.record('press', { key: 'Enter' }), null)
    assert.ok(w.record('press', { key: 'Enter' }), 'third in the new run')
})

test('status, snap and phone opens', () => {
    const w = new Watch({ now: clock() })
    assert.equal(w.record('status', {}), null)
    assert.equal(w.record('snap', {}), null)
    w.record('open', { device: 'pixel 9', app: 'a.apk' })
    w.record('check', { question: 'is this a login page?', threshold: 0.9 })
    assert.equal(w.record('scroll', { dy: 'end' }).scenario, 'device pixel 9\napp a.apk\nopen\ncheck@0.9 is this a login page?\nscroll end')
})
