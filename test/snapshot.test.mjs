// What Jev gets to choose from (collect) and what checks judge (readState),
// on real Chromium. No Jev involved.
import { fixtures } from './harness/index.mjs'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

const { JevBrowser } = await import('../src/browser.mjs')
const { pageState } = await import('../src/snapshot.mjs')

let site, b
before(async () => { site = await fixtures(); b = new JevBrowser({ pace: 'agent' }) })
after(async () => { await b.shutdown(); await site.close() })

const labels = (snap) => snap.elements.map((e) => e.replace(/^e\d+ /, '').replace(/ at -?\d+,-?\d+$/, ''))

test('snapshot: one option per real control, named the way a person would', async () => {
    await b.open(site.url('controls.html'))
    assert.deepEqual(labels(await b.snap()), [
        'a "Home" href=/next.html',
        'button "Notifications"', // aria-label
        'button "icon: sidebar-button menu"', // unlabeled icon: class + lucide name hint
        'button "Search threads"', // title
        'div "Channels"', // pointer div + nested pointer span = one row
        'div "Hot"',
        'button "Follow"', // pointer wrapper around a button is not listed twice
        'input "Display name" type=text', // sibling-div label
        'input "Password" type=password',
        'input "Subscribe to digest" type=checkbox', // opacity 0 under a styled label: still the control
        'button "Disabled button" disabled',
        'button "Inside panel"', // its tabindex=0 panel root is not an option
        'a "Far link" href=/far offscreen',
    ])
    // Not offered: display:none, visibility:hidden, aria-hidden, covered by the fixed banner.
})

test('snapshot: controls sharing a label name the item they sit in', async () => {
    await b.open(site.url('flow.html'))
    assert.deepEqual(labels(await b.snap()), [
        'textarea "Write a reply..."',
        'button "Post reply"',
        'button "Reply" in "First post"',
        'button "Reply (1)" in "Second post"',
        'button "Reply (2)" in "Third post"',
        'button "Continue to next page"',
    ])
})

test('snapshot: item context across common layouts', async () => {
    await b.open(site.url('layouts.html'))
    const inItem = labels(await b.snap()).filter((l) => / in "/.test(l))
    assert.deepEqual(inItem, [
        'button "Edit" in "Ada Lovelace ada@example.com"', // table row
        'button "Edit" in "Alan Turing alan@example.com"',
        'button "Edit" in "Grace Hopper grace@example.com"',
        'a "hide" in "1. Rust 2.0 released 120 points by ann | | 40 comments" href=#h1', // title + actions as sibling rows
        'a "hide" in "2. A history of the spreadsheet 95 points by bob | | 12 comm" href=#h2',
        'a "hide" in "3. Show HN: a tiny database 60 points by cy | | 8 comments" href=#h3',
        'button "Download" in "Invoice #1001 Acme Corp, $1,200, paid"', // action in a header, body after it
        'button "Download" in "Invoice #1002 Globex, $860, overdue"',
        'button "Download" in "Invoice #1003 Initech, $300, draft"',
        'button "Add to cart" in "Blue mug $12"', // card grid
        'button "Add to cart" in "Red kettle $40"',
        'button "Add to cart" in "Green teapot $25"',
        'a "reply" in "dana I think tabs are better." href=#r1', // parent comment; its replies nest beside it
        'a "reply" in "eli Spaces, always." href=#r2',
        'a "reply" in "fay Whatever the formatter says." href=#r3',
        'button "Remove" in "Milk"', // list
        'button "Remove" in "Eggs"',
        'button "Remove" in "Bread"',
    ])
})

test('snapshot: ids are live data-jevb attributes that locate the element', async () => {
    await b.open(site.url('controls.html'))
    const snap = await b.snap()
    const page = await b.page()
    for (const line of snap.elements) {
        const id = line.split(' ')[0]
        assert.equal(await page.locator(`[data-jevb="${id}"]`).count(), 1, line)
    }
    // A second snapshot re-numbers from scratch; no stale ids linger.
    await page.evaluate(() => document.querySelector('nav').remove())
    const again = await b.snap()
    assert.match(again.elements[0], /^e1 div "Channels"/)
    assert.equal(await page.locator('[data-jevb="e12"]').count(), 0)
})

test('state: checks see only on-screen text; fields carry values, passwords masked', async () => {
    await b.open(site.url('state.html'))
    const s = await pageState(await b.page())
    assert.equal(s.modal_open, false)
    assert.match(s.viewport_text, /Visible heading/)
    assert.doesNotMatch(s.viewport_text, /Footer below the fold/, 'offscreen text leaks into checks')
    assert.doesNotMatch(s.viewport_text, /Transparent text/)
    assert.doesNotMatch(JSON.stringify(s), /hunter2/, 'password value leaked to Jev state')
    assert.doesNotMatch(JSON.stringify(s), /csrf|tok/)
    assert.deepEqual(s.fields, [
        { field: 'Email', type: 'text', value: 'a@b.co' },
        { field: 'Password', type: 'password', value: '(filled)' },
        { field: 'Empty password', type: 'password', value: '(empty)' },
        { field: 'Remember me', type: 'checkbox', value: 'true' },
        { field: 'Reply editor', type: 'editor', value: 'Draft reply' },
    ])
})

test('state: an open <dialog> is all the user sees', async () => {
    await b.open(site.url('state.html'))
    const page = await b.page()
    await page.click('text=Open dialog')
    const s = await pageState(page)
    assert.equal(s.modal_open, true)
    assert.equal(s.viewport_text, 'Confirm delete?\nDelete')
    assert.deepEqual(s.fields, [{ field: 'Reason', type: 'text', value: 'spam' }])
})

test('state: a role-less fixed overlay counts as a modal (its panel, not the backdrop)', async () => {
    await b.open(site.url('state.html'))
    const page = await b.page()
    await page.click('text=Open overlay')
    const s = await pageState(page)
    assert.equal(s.modal_open, true)
    assert.equal(s.viewport_text, 'Sign up to reply\nJoin')
    // ...and the snapshot only offers what's clickable on top of it.
    assert.deepEqual(labels(await b.snap()), ['button "Join"'])
})
