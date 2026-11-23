// jevb qa: the anchor transaction, the proof manifest and verify, and the
// hand-over tab's confinement (offline: fake Jev, Playwright's headless shell).
import { fakeJev, fixtures, scenarioFile } from './harness/index.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { registry } from 'playwright-core/lib/server/registry/index'

const bsv = await import('../src/bsv.mjs')
const { buildManifest, canonical, manifestHash, verify } = await import('../src/proof.mjs')
const { compressTimeline, hasFfmpeg } = await import('../src/recorder.mjs')
const { HandoverBrowser, lintScenario, listTabs } = await import('../src/handover.mjs')
const { CdpFilter } = await import('../src/cdp-filter.mjs')
const { parse } = await import('../src/scenario.mjs')
const qa = await import('../src/qa.mjs')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-qa-test-'))

// ---- anchor transaction ----------------------------------------------------

test('WIF and address match the well-known key-1 vector', () => {
    const k = bsv.keyFromWif('KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn')
    assert.equal(k.address, '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH')
    assert.equal(k.publicKey.toString('hex'), '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
})

test('anchor tx: OP_FALSE OP_RETURN with tag, version and hash; signed; parses back', () => {
    const key = bsv.keyFromSecret(crypto.randomBytes(32))
    const hash = crypto.randomBytes(32)
    const { tx, raw, txid, fee } = bsv.buildAnchorTx({ hash, key, utxo: { txid: 'ab'.repeat(32), vout: 1, value: 5000 } })
    assert.equal(bsv.txid(raw), txid)
    const parsed = bsv.parseTx(raw)
    assert.equal(parsed.outputs[0].value, 0)
    assert.equal(parsed.outputs[0].script.subarray(0, 2).toString('hex'), '006a')
    assert.equal(parsed.outputs[1].value, 5000 - fee)
    assert.deepEqual(bsv.findAnchor(raw), { hash: hash.toString('hex') })
    // The input's signature verifies over the FORKID digest, with low S.
    const sigPush = parsed.inputs[0].script
    const der = sigPush.subarray(1, 1 + sigPush[0] - 1)
    assert.equal(sigPush[sigPush[0]], 0x41)
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('3036301006072a8648ce3d020106052b8104000a032200', 'hex'), key.publicKey]), format: 'der', type: 'spki' })
    assert.ok(crypto.verify('sha256', bsv.sha256(bsv.sighash(tx, 0, bsv.p2pkh(key.pkh), 5000)), pub, der))
    assert.ok(fee > 0 && fee < 500)
})

test('the prompt goes onchain only when asked', () => {
    const key = bsv.keyFromSecret(crypto.randomBytes(32))
    const hash = crypto.randomBytes(32)
    const plain = bsv.buildAnchorTx({ hash, key, utxo: { txid: 'cd'.repeat(32), vout: 0, value: 5000 } })
    assert.ok(!plain.raw.toString('utf8').includes('check the cart'))
    const open = bsv.buildAnchorTx({ hash, prompt: 'check the cart', key, utxo: { txid: 'cd'.repeat(32), vout: 0, value: 5000 } })
    assert.equal(bsv.findAnchor(open.raw).prompt, 'check the cart')
})

test('broadcast without a key fails before any network call', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = () => { throw new Error('network used') }
    try {
        await assert.rejects(bsv.anchor(crypto.randomBytes(32), { broadcast: true, wif: '' }), /JEVB_BSV_WIF/)
        const dry = await bsv.anchor(crypto.randomBytes(32))
        assert.equal(dry.dryRun, true)
    } finally { globalThis.fetch = realFetch }
})

// ---- manifest and verify ---------------------------------------------------

function bundle() {
    const dir = tmp()
    const files = qa.bundlePaths(dir)
    fs.writeFileSync(files.prompt, 'Add a note "milk" and check it shows in the list.\n')
    fs.writeFileSync(files.movie, crypto.randomBytes(4096))
    fs.writeFileSync(files.steps, JSON.stringify({ passed: true, steps: [] }))
    const scenario = path.join(dir, 'flow.jevb')
    fs.writeFileSync(scenario, 'type the "New note" box => milk\nact click "Add note"\ncheck is "milk" shown?\n')
    const m = buildManifest({ prompt: fs.readFileSync(files.prompt), movie: files.movie, steps: files.steps, scenario, client: { tool: 'codex', model: 'gpt-test' }, recorder: { tool: 'jevb', version: '0' }, startedAt: 'a', finishedAt: 'b' })
    fs.writeFileSync(files.manifest, JSON.stringify(m, null, 2))
    return { dir, files, m }
}

test('manifest hash ignores formatting and key order, not content', () => {
    const { m } = bundle()
    const shuffled = Object.fromEntries(Object.entries(m).reverse())
    assert.equal(manifestHash(shuffled), manifestHash(m))
    assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}')
    assert.notEqual(manifestHash({ ...m, finishedAt: 'c' }), manifestHash(m))
    assert.equal(m.prompt.sha256, crypto.createHash('sha256').update('Add a note "milk" and check it shows in the list.\n').digest('hex'))
    assert.equal(m.client.reportedBy, 'client, not verified')
})

test('verify passes on an untouched bundle with a dry-run anchor', async () => {
    const { dir } = bundle()
    await qa.anchorBundle(dir)
    const r = await qa.verifyBundle({ dir })
    assert.equal(r.ok, true, JSON.stringify(r.checks))
    assert.equal(r.dryRun, true)
    assert.match(r.onchain, /dry run/)
})

test('verify fails on a changed prompt, movie, step log or manifest', async () => {
    const { dir, files } = bundle()
    await qa.anchorBundle(dir)
    const failing = async (mutate, name) => {
        const saved = Object.fromEntries(Object.values(files).map((f) => [f, fs.readFileSync(f)]))
        mutate()
        const r = await qa.verifyBundle({ dir })
        for (const [f, b] of Object.entries(saved)) fs.writeFileSync(f, b)
        assert.equal(r.ok, false)
        assert.deepEqual(r.checks.filter((c) => !c.pass).map((c) => c.name), [name])
    }
    await failing(() => fs.writeFileSync(files.prompt, 'Add a note "milk" and check it shows in the list. '), 'prompt matches manifest')
    await failing(() => fs.appendFileSync(files.movie, Buffer.from([0])), 'movie matches manifest')
    await failing(() => fs.writeFileSync(files.steps, '{"passed":true,"steps":[1]}'), 'step log matches manifest')
    // Editing the manifest to match a new movie breaks its tie to the anchor.
    await failing(() => {
        fs.appendFileSync(files.movie, Buffer.from([0]))
        const m = JSON.parse(fs.readFileSync(files.manifest))
        m.movie.sha256 = crypto.createHash('sha256').update(fs.readFileSync(files.movie)).digest('hex')
        fs.writeFileSync(files.manifest, JSON.stringify(m))
    }, 'transaction commits to this manifest')
})

test('verify --chain: same bytes on chain and a block time', async () => {
    const { dir, files, m } = bundle()
    const a = await qa.anchorBundle(dir)
    const real = { ...a, dryRun: false } // as if broadcast
    const r = await verify({ prompt: files.prompt, movie: files.movie, manifest: m, anchor: real, chain: true,
        fetchTx: async () => a.rawtx, fetchInfo: async () => ({ blocktime: 1790000000, confirmations: 3, blockhash: '00ab' }) })
    assert.equal(r.ok, true, JSON.stringify(r.checks))
    assert.equal(r.anchoredAt, new Date(1790000000 * 1000).toISOString())
    const swapped = await verify({ prompt: files.prompt, movie: files.movie, manifest: m, anchor: real, chain: true,
        fetchTx: async () => 'ff' + a.rawtx, fetchInfo: async () => ({}) })
    assert.equal(swapped.ok, false)
})

// ---- the movie timeline ----------------------------------------------------

test('timeline: drops time before step 1, caps still frames, maps step times', () => {
    const tl = compressTimeline([0, 500, 1000, 6000, 6100], { startAt: 900, maxHoldMs: 1200, tailMs: 2000 })
    assert.deepEqual(tl.frames, [1, 2, 3, 4]) // frame 1 opens the movie, as of startAt
    assert.deepEqual(tl.durations, [100, 1200, 100, 2000])
    assert.equal(tl.at(900), 0)
    assert.equal(tl.at(1000), 100)
    assert.equal(tl.at(5000), 1300) // a 5s wait shows as 1.2s
    assert.equal(tl.at(6050), 1350)
})

// ---- hand-over confinement -------------------------------------------------

test('lint refuses sign-out, credentials, settings, secrets, eval-like steps and shortcuts', () => {
    const refused = lintScenario(parse([
        'act click "Add note"',
        'act sign out of the app',
        'type the password field => hunter2',
        'type the "New note" box => ${API_TOKEN}',
        'act open account settings',
        'act delete my account',
        'send order.json',
        'press Meta+W',
        'press Enter',
        'open /logout',
        'check is "milk" shown?',
    ].join('\n')))
    assert.deepEqual(refused.map((r) => r.line), [2, 3, 4, 5, 6, 7, 8, 10])
})

test('cdp filter in hand-over mode: one tab, no new/closed/focused tabs, no popups', () => {
    const client = [], browser = []
    const f = new CdpFilter({ only: 'TAB', toClient: (m) => client.push(JSON.parse(m)), toBrowser: (m) => browser.push(JSON.parse(m)) })
    for (const [id, method, params] of [[1, 'Target.createTarget', { url: 'about:blank' }], [2, 'Target.closeTarget', { targetId: 'TAB' }],
        [3, 'Target.activateTarget', { targetId: 'TAB' }], [4, 'Target.attachToTarget', { targetId: 'OTHER' }], [5, 'Target.attachToTarget', { targetId: 'TAB' }]]) {
        f.fromClient(JSON.stringify({ id, method, params }))
    }
    f.fromClient(JSON.stringify({ id: 6, sessionId: 'S1', method: 'Page.bringToFront' }))
    assert.deepEqual(client.map((m) => m.id), [1, 2, 3, 4, 6])
    assert.ok(client.every((m) => /^jevb: /.test(m.error.message)))
    assert.deepEqual(browser.map((m) => m.id), [5])
    const attached = (sessionId, targetId, extra = {}) => f.fromBrowser(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { targetId, type: 'page', ...extra }, waitingForDebugger: false } }))
    attached('S1', 'TAB'); attached('S2', 'OTHER'); attached('S3', 'POPUP', { openerId: 'TAB' })
    assert.deepEqual(client.filter((m) => m.method).map((m) => m.params.sessionId), ['S1'])
})

// A browser of our own with two tabs: the user's app tab and another site.
async function chromeWithTabs(t, urls) {
    const dir = tmp()
    const exe = registry.findExecutable('chromium-headless-shell').executablePath()
    const chrome = spawn(exe, ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
    t.after(async () => {
        if (chrome.exitCode === null && chrome.signalCode === null) {
            const exit = new Promise((r) => chrome.once('exit', r))
            chrome.kill()
            await exit
        }
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    })
    const portFile = path.join(dir, 'DevToolsActivePort')
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100))
    const cdpUrl = `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8').split('\n')[0]}`
    const ids = []
    for (const u of urls) ids.push((await (await fetch(`${cdpUrl}/json/new?${encodeURIComponent(u)}`, { method: 'PUT' })).json()).id)
    await new Promise((r) => setTimeout(r, 800))
    return { cdpUrl, ids }
}

test('a handed-over tab: acts only there, refuses the rest, and is handed back open', { timeout: 60_000 }, async (t) => {
    const jev = await fakeJev(); t.after(() => jev.close())
    const site = await fixtures(); t.after(() => site.close())
    const { cdpUrl, ids: [app, other] } = await chromeWithTabs(t, [site.url('account.html'), site.url('next.html')])
    const b = new HandoverBrowser({ tabId: app, cdpUrl, pace: 'fast' })
    t.after(() => b.shutdown('test'))
    const page = await b.page()
    assert.equal(page.context().pages().length, 1, 'Playwright sees only the handed-over tab')
    await b.type('the "New note" box', 'milk')
    await b.act('click "Add note"')
    assert.equal(await page.locator('#notes li').innerText(), 'milk')

    await assert.rejects(b.page('second'), { code: 'REFUSED' })
    await assert.rejects(b.open('http://localhost:1/elsewhere'), /another site/)
    await assert.rejects(b.open('https://example.com/'), /another site/)
    await assert.rejects(b.act('log out'), /signing out/)
    await assert.rejects(b.act('click the "Menu: Log out" button'), /signing out/) // the intent says so
    await assert.rejects(b.act('open the menu'), /picked control.*signing out/) // only the element does
    await assert.rejects(b.type('the "Secret word" box', 'x'), /password/)
    await assert.rejects(b.press('Meta+W'), /shortcut/)
    await assert.rejects(b.evaluate('1'), { code: 'REFUSED' })
    await assert.rejects(page.context().newPage(), /confined/)
    assert.equal(await page.locator('h1').innerText(), 'My notes', 'nothing above signed out')

    const res = await b.close()
    assert.equal(res.handedBack, app)
    const tabs = await listTabs(cdpUrl)
    assert.ok(tabs.find((x) => x.id === app), 'the user\'s tab is still open')
    assert.equal(tabs.find((x) => x.id === other).url, site.url('next.html'), 'the other tab was not touched')
})

test('jevb qa run: movie, step log, manifest, dry-run anchor, verify; refused without consent', { timeout: 90_000 }, async (t) => {
    if (!await hasFfmpeg()) return t.skip('ffmpeg not installed')
    const jev = await fakeJev(); t.after(() => jev.close())
    const site = await fixtures(); t.after(() => site.close())
    const { cdpUrl, ids: [app] } = await chromeWithTabs(t, [site.url('account.html')])
    const out = tmp()
    const prompt = path.join(tmp(), 'prompt.txt')
    fs.writeFileSync(prompt, 'Add a note "milk" and check that it shows up.')
    const scenario = scenarioFile('type the "New note" box => milk\nact click "Add note"\ncheck is "milk" shown?\n')
    await assert.rejects(qa.runQa({ scenario, tabId: app, prompt, out, cdpUrl }), { code: 'NEEDS_CONSENT' })
    const bad = scenarioFile('act sign out\n')
    await assert.rejects(qa.runQa({ scenario: bad, tabId: app, prompt, out, cdpUrl, recordingOk: true }), { code: 'REFUSED' })

    const r = await qa.runQa({ scenario, tabId: app, prompt, out, cdpUrl, recordingOk: true, pace: 'fast', client: { tool: 'test', model: 'none' } })
    assert.equal(r.passed, true)
    assert.equal(r.anchor.dryRun, true)
    const log = JSON.parse(fs.readFileSync(path.join(out, 'steps.json')))
    assert.deepEqual(log.steps.map((s) => s.ok), [true, true, true])
    assert.ok(fs.statSync(path.join(out, 'qa.mp4')).size > 1000)
    assert.equal((await qa.verifyBundle({ dir: out })).ok, true)
    fs.appendFileSync(path.join(out, 'prompt.txt'), '!')
    assert.equal((await qa.verifyBundle({ dir: out })).ok, false)
    assert.ok((await listTabs(cdpUrl)).find((x) => x.id === app), 'tab handed back open')
})
