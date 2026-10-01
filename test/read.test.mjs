// `jevb read`: the free state read, --full, and answering a question by
// picking an on-screen text block (fake Jev; real answers: test/live).
import { fakeJev, fixtures } from './harness/index.mjs'
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

const { JevBrowser } = await import('../src/browser.mjs')
const { readState } = await import('../src/snapshot.mjs')

let jev, site, b
before(async () => { jev = await fakeJev(); site = await fixtures(); b = new JevBrowser({ pace: 'agent' }) })
beforeEach(() => jev.reset())
after(async () => { await b.shutdown(); await jev.close(); await site.close() })

test('no question: what checks see, with no Jev call', async () => {
    await b.open(site.url('state.html'))
    const r = await b.readText()
    assert.match(r.viewport_text, /Visible heading/)
    assert.doesNotMatch(r.viewport_text, /Footer below the fold/)
    assert.equal(r.blocks, undefined)
    assert.equal(jev.requests.length, 0)
})

test('--full: the whole page, offscreen text included', async () => {
    await b.open(site.url('state.html'))
    assert.match((await b.readText({ full: true })).text, /Footer below the fold/)
})

test('blocks carry the text around them, from their own item', async () => {
    await b.open(site.url('layouts.html'))
    const { blocks } = await (await b.page()).evaluate(readState, { maxText: 20000, blocks: true })
    const at = (text) => blocks.find((x) => x.text === text)?.context
    assert.equal(at('$40'), 'Red kettle … Add to cart') // card
    assert.equal(at('grace@example.com'), 'Grace Hopper … Edit') // table row
    assert.match(at('95 points by bob | hide | 12 comments'), /A history of the spreadsheet …/) // sibling rows (HN)
    assert.match(at('Globex, $860, overdue'), /Invoice #1002 Download …/) // header row, then body
})

test('a question returns the block that answers it, verbatim, in one Jev call', async () => {
    await b.open(site.url('layouts.html'))
    const r = await b.readText({ question: 'which invoice says "Globex, $860, overdue"?' })
    assert.equal(r.answer, 'Globex, $860, overdue')
    assert.match(r.in, /Invoice #1002/)
    assert.equal(jev.requests.length, 1)
    const [req] = jev.requests
    assert.deepEqual(Object.keys(req.state), ['question', 'page'], 'the pick sees blocks as options, not page text')
    assert.match(req.questions.answer.criteria.b1, /^header cell "Name"/, 'blocks say what kind of text they are')
})

test('nothing on screen answers: NO_MATCH with candidates, not a guess', async () => {
    await b.open(site.url('layouts.html'))
    await assert.rejects(b.readText({ question: 'what is the weather in Lisbon?' }), (e) => e.code === 'NO_MATCH' && Array.isArray(e.detail.top))
})
