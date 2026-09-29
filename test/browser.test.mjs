// JevBrowser lifecycle and paces on real Chromium, fake Jev.
import { fakeJev, fixtures } from './harness/index.mjs'
import assert from 'node:assert/strict'
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

// Checks wait like Playwright's expect: a screen still loading (a Channels
// page judged 0.4s after the tap showed only a spinner) passes once it's there.
test('a failing check re-polls until the screen gets there, within waitMs', async () => {
    const b = new JevBrowser({ pace: 'agent' })
    try {
        await b.open(site.url('next.html'))
        const page = await b.page()
        await page.evaluate(() => setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p>Loaded later</p>'), 1200))
        const [quick] = await b.checks([{ question: 'is "Loaded later" shown?' }], { waitMs: 0 })
        assert.equal(quick.pass, false, 'without waiting it is not there yet')
        const [waited] = await b.checks([{ question: 'is "Loaded later" shown?' }], { waitMs: 4000 })
        assert.equal(waited.pass, true)
        assert.ok(waited.tries > 1 && waited.waitedMs >= 600, `re-polled (${waited.tries} tries, ${waited.waitedMs}ms)`)
        const [never] = await b.checks([{ question: 'is "Never there" shown?' }], { waitMs: 1000 })
        assert.equal(never.pass, false, 'still fails when it never appears')
    } finally { await b.shutdown() }
})
