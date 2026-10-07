// Attached browsers: the user's tabs (even a hung one) stay out of jevb's way.
import { fakeJev, fixtures } from './harness/index.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'

const { CdpFilter } = await import('../src/cdp-filter.mjs')
const { JevBrowser } = await import('../src/browser.mjs')

function harness() {
    const client = [], browser = []
    const f = new CdpFilter({ toClient: (m) => client.push(JSON.parse(m)), toBrowser: (m) => browser.push(JSON.parse(m)) })
    const send = (m) => f.fromClient(JSON.stringify(m))
    const recv = (m) => f.fromBrowser(JSON.stringify(m))
    return { f, client, browser, send, recv }
}
const attached = (sessionId, targetId, extra = {}) => ({
    method: 'Target.attachedToTarget',
    params: { sessionId, targetInfo: { targetId, type: 'page', url: 'about:blank', ...extra }, waitingForDebugger: false },
})

test('the user\'s tabs are detached and never reach Playwright', () => {
    const { client, browser, recv } = harness()
    recv(attached('S1', 'T1'))
    recv({ method: 'Page.frameNavigated', sessionId: 'S1', params: {} })
    assert.deepEqual(client, [])
    assert.deepEqual(browser.map((m) => [m.method, m.params?.sessionId]), [['Target.detachFromTarget', 'S1']])
})

test('a new user tab paused for the debugger is resumed before detaching', () => {
    const { browser, recv } = harness()
    recv({ ...attached('S1', 'T1'), params: { ...attached('S1', 'T1').params, waitingForDebugger: true } })
    assert.deepEqual(browser.map((m) => m.method), ['Runtime.runIfWaitingForDebugger', 'Target.detachFromTarget'])
})

test('jevb\'s tab is held until createTarget answers, then forwarded before the answer', () => {
    const { client, browser, send, recv } = harness()
    send({ id: 7, sessionId: 'B', method: 'Target.createTarget', params: { url: 'about:blank' } })
    recv(attached('S2', 'MINE'))
    recv(attached('S3', 'USERS')) // the user opened a tab at the same moment
    assert.deepEqual(client, [])
    recv({ id: 7, sessionId: 'B', result: { targetId: 'MINE' } })
    assert.deepEqual(client.map((m) => m.params?.sessionId ?? m.id), ['S2', 7])
    assert.deepEqual(browser.filter((m) => m.method === 'Target.detachFromTarget').map((m) => m.params.sessionId), ['S3'])
})

test('popups from jevb\'s tab and browser sessions pass through', () => {
    const { client, send, recv } = harness()
    send({ id: 1, method: 'Target.createTarget', params: {} })
    recv(attached('S1', 'MINE'))
    recv({ id: 1, result: { targetId: 'MINE' } })
    recv(attached('S2', 'POPUP', { openerId: 'MINE' }))
    recv({ method: 'Target.attachedToTarget', params: { sessionId: 'S3', targetInfo: { targetId: 'BR', type: 'browser' } } })
    assert.deepEqual(client.filter((m) => m.method).map((m) => m.params.sessionId), ['S1', 'S2', 'S3'])
})

// Real Chrome with a tab stuck in an infinite loop: Playwright's own
// connectOverCDP waits on it forever; jevb's attach must not.
let jev, site, chrome, dir, cdpUrl
before(async () => {
    jev = await fakeJev(); site = await fixtures()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-cdp-'))
    chrome = spawn(chromium.executablePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
    const portFile = path.join(dir, 'DevToolsActivePort')
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100))
    cdpUrl = `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8').split('\n')[0]}`
    await fetch(`${cdpUrl}/json/new?${encodeURIComponent('data:text/html,<script>setTimeout(()=>{for(;;){}},0)</script>')}`, { method: 'PUT' })
    await new Promise((r) => setTimeout(r, 500))
})
after(async () => {
    if (chrome && chrome.exitCode === null) await new Promise((r) => { chrome.once('exit', r); chrome.kill() })
    await jev?.close(); await site?.close()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

test('a hung tab in the attached browser doesn\'t block jevb', { timeout: 30_000 }, async () => {
    const b = new JevBrowser({ pace: 'agent', cdpUrl })
    try {
        const res = await b.open(site.url('next.html'))
        assert.equal(res.status, 200)
    } finally { await b.shutdown('stop', { closeTabs: true }) }
})
