// JevBrowser lifecycle and paces on real Chromium, fake Jev.
import { fakeJev, fixtures } from './harness/index.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const { JevBrowser } = await import('../src/browser.mjs')

let jev, site
before(async () => { jev = await fakeJev(); site = await fixtures() })
after(async () => { await jev.close(); await site.close() })

test('an idle-expired session throws instead of judging a blank page', async () => {
    const b = new JevBrowser({ pace: 'agent' })
    try {
        await b.open(site.url('next.html'))
        b.idleMs = 300 // after open: a cold launch alone can outlast a short idle (see the todo below)
        b.touch()
        await new Promise((r) => setTimeout(r, 800))
        assert.equal(b.status().browser, 'down')
        await assert.rejects(b.check('is "Welcome" shown?'), { code: 'SESSION_EXPIRED' })
        b.idleMs = 60_000
        await b.open(site.url('next.html')) // open revives it
        assert.equal((await b.check('is "Welcome" shown?')).pass, true)
    } finally { await b.shutdown() }
})

// The idle timer used to be armed when an action started, so an action that
// ran longer than idleMs (cold launch + slow page, `scroll end`) had Chromium
// closed under it: "Target page, context or browser has been closed".
test('an action longer than idleMs is not killed mid-flight; idle counts from its end', async () => {
    const b = new JevBrowser({ pace: 'agent', idleMs: 400 })
    try {
        await b.open(site.url('slow/800/flow.html'))
        assert.equal((await b.check('is "Post reply" shown?')).pass, true)
        await new Promise((r) => setTimeout(r, 700))
        await assert.rejects(b.check('is "Post reply" shown?'), { code: 'SESSION_EXPIRED' })
    } finally { await b.shutdown() }
})

test('sessions are isolated browser contexts', async () => {
    const b = new JevBrowser({ pace: 'agent' })
    try {
        await b.open(site.url('flow.html'), { session: 'a' })
        await b.open(site.url('next.html'), { session: 'b' })
        assert.equal((await b.check('is "Post reply" shown?', { session: 'a' })).pass, true)
        assert.equal((await b.check('is "Post reply" shown?', { session: 'b' })).pass, false)
        await b.close({ session: 'a' })
        assert.equal(b.status().browser, 'up')
        await b.close({ session: 'b' })
        assert.equal(b.status().browser, 'down', 'last close should stop chromium')
    } finally { await b.shutdown() }
})

for (const pace of ['agent', 'human']) {
    test(`${pace} pace types into a field and clicks`, async () => {
        const b = new JevBrowser({ pace })
        try {
            await b.open(site.url('flow.html'))
            await b.type('the "Write a reply" box', 'hi there')
            await b.act('click "Post reply"')
            assert.equal((await b.check('is "Posted: hi there" shown?')).pass, true)
        } finally { await b.shutdown() }
    })
}

for (const pace of ['agent', 'human']) {
    test(`${pace} pace: scroll end/top follow an in-app scroll panel`, async () => {
        const b = new JevBrowser({ pace })
        try {
            await b.open(site.url('panel.html'))
            const page = await b.page()
            await b.scroll('end')
            assert.equal((await b.check('is "Post number 120" shown?')).pass, true)
            await b.scroll('top')
            assert.equal(await page.evaluate(() => document.getElementById('feed').scrollTop), 0)
            await b.scroll(600)
            assert.ok(await page.evaluate(() => document.getElementById('feed').scrollTop) > 0, 'wheel did not reach the panel')
        } finally { await b.shutdown() }
    })
}

test('eval runs a function body in the page and returns its value', async () => {
    const b = new JevBrowser({ pace: 'agent' })
    try {
        await b.open(site.url('next.html'))
        const { value } = await b.evaluate('return { title: document.title, w: innerWidth > 0 }')
        assert.equal(value.w, true)
        assert.equal(typeof value.title, 'string')
    } finally { await b.shutdown() }
})

test('upload: a button that opens the chooser, a visible file input, and a drop zone', async () => {
    const b = new JevBrowser({ pace: 'agent' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-up-'))
    const clip = path.join(dir, 'clip.mp4'), art = path.join(dir, 'art.png')
    fs.writeFileSync(clip, 'x'.repeat(10)); fs.writeFileSync(art, 'y'.repeat(3))
    try {
        await b.open(site.url('upload.html'))
        assert.deepEqual((await b.upload('click "Select video"', [clip])).files, ['clip.mp4'])
        assert.equal((await b.check('is "Video: clip.mp4 (10)" shown?')).pass, true)
        await b.upload('the "Cover image" field', [art])
        assert.equal((await b.check('is "Cover: art.png (3)" shown?')).pass, true)
        // Two file inputs on the page: a drop zone with no chooser can't guess.
        await assert.rejects(b.upload('the "Drag and drop files here" area', [clip]), { code: 'NO_FILE_INPUT' })
    } finally { await b.shutdown() }
})
