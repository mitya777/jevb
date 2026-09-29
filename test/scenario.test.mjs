// Scenarios end to end: real Chromium on the fixture site, fake Jev.
import { fakeJev, fixtures, scenarioFile } from './harness/index.mjs'
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

const { runScenario, parse } = await import('../src/scenario.mjs')

let jev, site
before(async () => { jev = await fakeJev(); site = await fixtures() })
beforeEach(() => jev.reset())
after(async () => { await jev.close(); await site.close() })

const run = (text, opts = {}) => runScenario(scenarioFile(text), { baseUrl: site.base, pace: 'agent', onStep: () => {}, ...opts })
const byLine = (results) => Object.fromEntries(results.map((r) => [r.step, r]))

test('parse: commands, optional ?, @threshold, comments', () => {
    const steps = parse('# header\npace agent\nact? dismiss the prompt  # maybe\ncheck@0.9 is "X" shown?\n\n')
    assert.deepEqual(steps.map(({ cmd, optional, threshold, arg, line }) => ({ cmd, optional, threshold, arg, line })), [
        { cmd: 'pace', optional: false, threshold: undefined, arg: 'agent', line: 2 },
        { cmd: 'act', optional: true, threshold: undefined, arg: 'dismiss the prompt', line: 3 },
        { cmd: 'check', optional: false, threshold: 0.9, arg: 'is "X" shown?', line: 4 },
    ])
})

test('compose-and-post flow passes; checks batch onto the next pick', async () => {
    const r = await run(`
        open flow.html
        check is "Loaded feed" shown?
        type the "Write a reply" box => hello from jevb
        act click "Post reply"
        check is "Posted: hello from jevb" shown?
        refute is "Error" shown?
    `)
    assert.equal(r.failed, 0, JSON.stringify(r.results, null, 1))
    const steps = byLine(r.results)
    assert.equal(steps['check is "Loaded feed" shown?'].pass, true, 'judged before the SPA rendered')
    assert.equal(steps['type the "Write a reply" box => hello from jevb'].typed.desc, 'textarea "Write a reply..." at 8,98')
    // 1 pick+check pair (in parallel) + 1 pick + 1 trailing batch of 2 checks = 4 requests.
    assert.equal(r.jevCalls, 4)
    assert.deepEqual(jev.checks().map((c) => Object.keys(c.questions).length), [1, 2])
})

test('no-batch sends every check on its own', async () => {
    const r = await run('open flow.html\ncheck is "Thread" shown?\nrefute is "Error" shown?\nact click "Post reply"', { batch: false })
    assert.equal(r.failed, 0)
    assert.equal(r.jevCalls, 3)
})

test('a failed check fails the run but later steps still run', async () => {
    const r = await run('open flow.html\ncheck is "Nonexistent text" shown?\ncheck is "Thread" shown?')
    assert.equal(r.failed, 1)
    assert.deepEqual(r.results.filter((x) => 'pass' in x).map((x) => x.pass), [false, true])
})

test('act? skips a missing control; plain act stops the run with candidates', async () => {
    const r = await run('open flow.html\nact? dismiss the cookie banner\nact dismiss the cookie banner\ncheck is "Thread" shown?')
    const steps = byLine(r.results)
    assert.equal(steps['act? dismiss the cookie banner'].skipped, 'no match')
    assert.match(steps['act dismiss the cookie banner'].error, /no confident match/)
    assert.equal(steps['act dismiss the cookie banner'].detail.id, 'none')
    assert.equal(r.failed, 1)
    assert.equal(steps['check is "Thread" shown?'], undefined, 'ran past a failed step')
})

test('a low-confidence pick is NO_MATCH, not a coin flip', async () => {
    jev.answer((b) => b.questions.target && { target: { choice: 'e2', confidence: 0.45, probabilities: { e2: 0.45, e3: 0.4 } } })
    const r = await run('open flow.html\nact post it')
    assert.match(r.results.at(-1).error, /no confident match/)
})

test('"first"/"last" reply resolve by position on a real page', async () => {
    const r = await run(`
        open flow.html
        act click the last "Reply" button
        check is "Replying to Third post" shown?
        act click the first "Reply" button
        check is "Replying to First post" shown?
    `)
    assert.equal(r.failed, 0, JSON.stringify(r.results, null, 1))
})

test('act waits out a navigation that starts a beat after the click', async () => {
    const r = await run('open flow.html\nact click "Continue to next page"\ncheck is "Welcome to the next page" shown?')
    assert.equal(r.failed, 0, JSON.stringify(r.results, null, 1))
    assert.match(byLine(r.results)['act click "Continue to next page"'].url, /next\.html$/)
})

test('${SECRET} is typed but never echoed back in results', async () => {
    process.env.JEVB_TEST_SECRET = 'sekrit-value-123'
    const r = await run('open flow.html\ntype the "Write a reply" box => ${JEVB_TEST_SECRET}\ncheck is "sekrit-value-123" shown?')
    assert.equal(r.failed, 0, 'the value reached the page')
    assert.ok(jev.checks()[0].state.fields.some((f) => f.value === 'sekrit-value-123'), 'field value is judged')
    assert.doesNotMatch(JSON.stringify(r.results.map(({ step, ...rest }) => rest)), /sekrit-value-123/)
    assert.equal(r.results[1].step, 'type the "Write a reply" box => ${JEVB_TEST_SECRET}')
})

test('a missing ${NAME} fails before anything opens', async () => {
    delete process.env.JEVB_TEST_MISSING
    await assert.rejects(run('open flow.html\ntype the "Write a reply" box => ${JEVB_TEST_MISSING}'), { code: 'MISSING_ENV' })
    assert.equal(jev.requests.length, 0)
})

test('unknown step names the step', async () => {
    const r = await run('open flow.html\nclikc the thing')
    assert.match(r.results.at(-1).error, /unknown step "clikc"/)
})
