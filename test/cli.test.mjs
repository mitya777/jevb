// The CLI + daemon as an agent uses them: separate processes sharing one
// browser. Exit codes are the contract.
import { FIXTURES, ROOT, fakeJev, fixtures } from './harness/index.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

let jev, site, port, cwd
before(async () => {
    jev = await fakeJev(); site = await fixtures()
    port = 20000 + Math.floor(Math.random() * 20000)
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-cli-')) // no ./.env here
})
after(async () => { await jevb('stop'); await jev.close(); await site.close() })

const jevb = (...args) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'bin/jevb.mjs'), ...args], {
        cwd, env: { ...process.env, JEVB_PORT: String(port), JEVB_DAEMON_IDLE_MS: '60000' },
    }, (err, stdout) => resolve({ code: err?.code ?? 0, out: stdout.trim() }))
})
const json = (r) => JSON.parse(r.out)

test('open → snap → act → check across separate CLI calls', async () => {
    assert.equal((await jevb('open', site.url('flow.html'), '--pace', 'agent')).code, 0)
    const snap = json(await jevb('snap'))
    assert.ok(snap.elements.includes('e2 button "Post reply" at 194,119'), snap.elements.join('\n'))
    assert.equal((await jevb('type', 'the "Write a reply" box', '--pace', 'agent', '--', 'from', 'the', 'cli')).code, 0)
    const act = await jevb('act', 'click "Post reply"', '--check', 'is "Loaded feed" shown?', '--pace', 'agent')
    assert.equal(act.code, 0, act.out)
    assert.equal(json(act).checks[0].pass, true)
    assert.equal((await jevb('check', 'is "Posted: from the cli" shown?')).code, 0)
})

test('exit 1 on a failed check, refute, batch, or no match', async () => {
    await jevb('open', site.url('flow.html'), '--pace', 'agent')
    assert.equal((await jevb('check', 'is "Nope" shown?')).code, 1)
    assert.equal((await jevb('refute', 'is "Thread" shown?')).code, 1)
    assert.equal((await jevb('refute', 'is "Nope" shown?')).code, 0)
    assert.equal((await jevb('checks', '--check', 'is "Thread" shown?', '--refute', 'is "Thread" shown?')).code, 1)
    const miss = await jevb('act', 'dismiss the cookie banner')
    assert.equal(miss.code, 1)
    assert.equal(json(miss).code, 'NO_MATCH')
})

test('read: state without a question, an answer with one, exit 1 when nothing answers', async () => {
    await jevb('open', site.url('flow.html'), '--pace', 'agent')
    const state = await jevb('read')
    assert.equal(state.code, 0)
    assert.match(json(state).viewport_text, /Post reply/)
    const answer = await jevb('read', 'which', 'text', 'says', '"Third post"?')
    assert.equal(answer.code, 0, answer.out)
    assert.equal(json(answer).answer, 'Third post')
    assert.equal((await jevb('read', 'what', 'is', 'the', 'weather?')).code, 1)
})

test('run: a scenario file exits 0 and reports Jev usage', async () => {
    const file = path.join(cwd, 'ok.jevb')
    fs.writeFileSync(file, 'pace agent\nopen flow.html\nact click "Post reply"\ncheck is "Posted:" shown?\n')
    const r = await jevb('run', file, '--base', site.base)
    assert.equal(r.code, 0, r.out)
    const done = JSON.parse(r.out.split('\n').at(-1))
    assert.equal(done.failed, 0)
    assert.equal(done.jevCalls, 2)
})

test('upload resolves files against the caller cwd; a missing file exits 1', async () => {
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), 'abcd')
    await jevb('open', site.url('upload.html'), '--pace', 'agent')
    const up = await jevb('upload', 'click "Select video"', '--', 'clip.mp4')
    assert.equal(up.code, 0, up.out)
    assert.equal((await jevb('check', 'is "Video: clip.mp4 (4)" shown?')).code, 0)
    const missing = await jevb('upload', 'click "Select video"', '--', 'nope.mp4')
    assert.equal(missing.code, 1)
    assert.match(json(missing).error, /no such file/)
})
