// Attached browsers: the user's tabs (even a hung one) stay out of jevb's way.
import { fakeJev, fixtures } from './harness/index.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { registry } from 'playwright-core/lib/server/registry/index'

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
// connectOverCDP waits on it forever; jevb's attach must not. Playwright's
// headless shell, since that's the browser CI installs. Each resource is
// cleaned up by t.after as soon as it exists: a server left open by a
// failed setup keeps the file's process alive and hangs `node --test`.
async function chromeWithHungTab(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-cdp-'))
    const exe = registry.findExecutable('chromium-headless-shell').executablePath()
    // --no-sandbox as Playwright passes it; CI's Ubuntu blocks Chrome's sandbox.
    const chrome = spawn(exe, ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
    t.after(async () => {
        if (chrome.exitCode === null && chrome.signalCode === null) {
            const exit = new Promise((r) => chrome.once('exit', r))
            chrome.kill()
            const late = setTimeout(() => chrome.kill('SIGKILL'), 3_000)
            await exit; clearTimeout(late)
        }
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    })
    const failed = new Promise((_, reject) => {
        chrome.once('error', reject)
        chrome.once('exit', (code) => reject(new Error(`chrome exited (${code}) before DevTools came up`)))
    })
    const portFile = path.join(dir, 'DevToolsActivePort')
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await Promise.race([failed, new Promise((r) => setTimeout(r, 100))])
    const cdpUrl = `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8').split('\n')[0]}`
    const hung = 'data:text/html,<script>setTimeout(()=>{for(;;){}},0)</script>'
    await fetch(`${cdpUrl}/json/new?${encodeURIComponent(hung)}`, { method: 'PUT', signal: AbortSignal.timeout(5_000) })
    await new Promise((r) => setTimeout(r, 500))
    return cdpUrl
}

test('a hung tab in the attached browser doesn\'t block jevb', { timeout: 30_000 }, async (t) => {
    const jev = await fakeJev(); t.after(() => jev.close())
    const site = await fixtures(); t.after(() => site.close())
    const b = new JevBrowser({ pace: 'agent', cdpUrl: await chromeWithHungTab(t) })
    t.after(() => b.shutdown('stop', { closeTabs: true }))
    const res = await b.open(site.url('next.html'))
    assert.equal(res.status, 200)
})
