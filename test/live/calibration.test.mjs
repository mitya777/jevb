// Live calibration: the same fixture pages, judged by the REAL Jev. Catches
// model drift (jevb calls `jev-latest`) and prompt regressions in judge.mjs
// that the fake Jev can't. Costs a few cents' worth of Jev requests.
//
//   npm run test:live            (needs TYPESAFEAI_API_KEY in env or ./.env)
//
// Each case asserts the outcome AND prints its margin from the threshold,
// so a drift toward the line shows up before it flips.
import fs from 'node:fs'
import { fixtures, ROOT } from '../harness/index.mjs'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

// The harness blanks the key; take the real one from the shell or jevb/.env.
const envKey = process.env.JEVB_LIVE_KEY || (() => {
    const line = fs.existsSync(`${ROOT}/.env`) && fs.readFileSync(`${ROOT}/.env`, 'utf8').match(/^TYPESAFEAI_API_KEY=(.*)$/m)
    return line?.[1]?.trim().replace(/^["']|["']$/g, '')
})()
const live = process.env.JEVB_LIVE === '1' && envKey
if (live) { process.env.TYPESAFEAI_API_KEY = envKey; delete process.env.TYPESAFE_ENDPOINT }

const { JevBrowser } = await import('../../src/browser.mjs')

let site, b
before(async () => { if (live) { site = await fixtures(); b = new JevBrowser({ pace: 'agent' }) } })
after(async () => { await b?.shutdown(); await site?.close() })

const margins = []
after(() => { if (margins.length) console.log(`\n${margins.map((m) => `  ${m}`).join('\n')}`) })

// intent -> what jevb should pick (unquoted, as a person would say it):
// the label, or the start of the whole option (`button "Edit" in "Grace`).
const PICKS = {
    'controls.html': {
        'open the notifications': 'Notifications',
        'open the navigation menu': 'icon: sidebar-button menu',
        'search for a thread': 'Search threads',
        'go to the Hot tab': 'Hot',
        'enter a display name': 'Display name',
        'enter the password': 'Password',
        'delete my account': null, // no such control: must be NO_MATCH
    },
    'flow.html': {
        'type a reply': 'Write a reply...',
        'post the reply': 'Post reply',
        'click the first Reply button': 'Reply',
        'click the last Reply button': 'Reply (2)',
        // Were TODO before duplicate-label context + the kind-based override:
        // first post 0.49 (under the bar), last post picked the FIRST Reply.
        'reply to the first post': 'Reply',
        'reply to the last post': 'Reply (2)',
        'reply to the second post': 'Reply (1)',
    },
    // Repeated controls in common layouts: item context + first/last.
    'layouts.html': {
        'edit Grace Hopper': 'button "Edit" in "Grace',
        'edit the last row': 'button "Edit" in "Grace',
        'hide the story about the spreadsheet': 'a "hide" in "2.',
        'hide the last story': 'a "hide" in "3.',
        'download the Globex invoice': 'button "Download" in "Invoice #1002',
        'download the first invoice': 'button "Download" in "Invoice #1001',
        'add the red kettle to the cart': 'button "Add to cart" in "Red kettle',
        "reply to dana's comment": 'a "reply" in "dana',
        "reply to fay": 'a "reply" in "fay',
        'remove eggs from the list': 'button "Remove" in "Eggs',
        'remove the first item': 'button "Remove" in "Milk',
    },
}

// Jev's own judgment, not jevb's code (same with every pick strategy tried):
// with no flag control, Jev takes "hide" as close enough (0.7-0.8).
const JEV_TODO = { 'layouts.html': { 'flag the last story': null } }

const SKIP = !live && 'set JEVB_LIVE=1 and TYPESAFEAI_API_KEY'
for (const [todo, set] of [[false, PICKS], ['Jev maps flag → hide', JEV_TODO]]) for (const [page, cases] of Object.entries(set)) {
    for (const [intent, want] of Object.entries(cases)) {
        test(`pick on ${page}: ${intent} → ${want ?? 'NO_MATCH'}`, { skip: SKIP, todo }, async () => {
            await b.open(site.url(page))
            let got
            try { got = (await b.find(intent)).target } catch (e) { if (e.code !== 'NO_MATCH') throw e; got = { ...e.detail, noMatch: true } }
            const label = got.desc?.match(/^\S+ "([^"]*)"/)?.[1]
            margins.push(`${(got.confidence ?? 0).toFixed(2)} pick  ${intent} → ${got.noMatch ? 'NO_MATCH' : got.desc.replace(/ at -?\d+,-?\d+$/, '')}`)
            if (want === null) assert.ok(got.noMatch, `picked ${got.desc} (${got.confidence})`)
            else if (/^\S+ "/.test(want)) assert.ok(!got.noMatch && got.desc.startsWith(want), `${got.desc} (${got.confidence}) ${JSON.stringify(got.top)}`)
            else assert.equal(label, want, JSON.stringify(got.top))
        })
    }
}

// [page, setup click (by visible text), question, expected pass]
const CHECKS = [
    ['state.html', null, 'Is a heading shown?', true],
    ['state.html', null, 'Is a confirmation dialog shown?', false],
    ['state.html', null, 'Is the footer visible?', false], // below the fold
    ['state.html', null, 'Is the email field filled in?', true],
    ['state.html', 'Open dialog', 'Is the user asked to confirm a deletion?', true],
    ['state.html', 'Open dialog', 'Can the user see the "Visible heading" text?', false], // behind the modal
    ['state.html', 'Open overlay', 'Is a sign-up prompt shown?', true],
    ['flow.html', null, 'Are there three posts with Reply buttons?', true],
    ['flow.html', null, 'Is an error message shown?', false],
]

for (const [page, click, question, want] of CHECKS) {
    test(`check on ${page}${click ? ` after "${click}"` : ''}: ${question} → ${want}`, { skip: SKIP }, async () => {
        await b.open(site.url(page))
        if (click) await (await b.page()).click(`text=${click}`)
        const c = await b.check(question)
        margins.push(`${c.noul.toFixed(2)} ${want ? '≥0.7' : '<0.7'} ${question}${click ? ` (after ${click})` : ''}`)
        assert.equal(c.pass, want, `noul ${c.noul}`)
    })
}

// A real site that isn't Treechat. Expectations come from the page itself
// (stories change): the hide link of a story named by its title, and the
// first/last hide link on screen.
test('Hacker News: hide a story by title, and the first/last on screen', { skip: SKIP }, async () => {
    await b.open('https://news.ycombinator.com/')
    const hides = (await b.snap()).elements.filter((e) => /^e\d+ a "hide" in /.test(e) && !/ offscreen /.test(e))
    assert.ok(hides.length >= 3, 'front page changed shape')
    const href = (d) => d.match(/href=(\S+)/)[1]
    const title = hides[2].match(/ in "\d+\. (.*?)(?: \(| \d+ points|"|$)/)?.[1]
    assert.ok(title, hides[2])
    const cases = [[`hide the story ${title}`, hides[2]], ['hide the first story', hides[0]], ['hide the last story on screen', hides.at(-1)]]
    for (const [intent, want] of cases) {
        const got = (await b.find(intent)).target
        margins.push(`${got.confidence.toFixed(2)} pick  HN: ${intent} → ${got.desc.slice(0, 70)}`)
        assert.equal(href(got.desc), href(want), intent)
    }
})

// `jevb read <question>`: Jev picks the on-screen text that answers, and the
// answer is that text verbatim. null = nothing on screen answers (NO_MATCH).
const READS = {
    'layouts.html': {
        'What is the price of the red kettle?': '$40',
        "What is Grace Hopper's email address?": 'grace@example.com',
        'How many points does the spreadsheet story have?': '95 points by bob | hide | 12 comments',
        'What is the status of the Globex invoice?': 'Globex, $860, overdue',
        'What did eli say?': 'eli Spaces, always.',
        'What is the price of the yellow chair?': null,
    },
    'flow.html': {
        'What is the heading of this page?': 'Thread',
    },
}

for (const [page, cases] of Object.entries(READS)) {
    for (const [question, want] of Object.entries(cases)) {
        test(`read on ${page}: ${question} → ${want ?? 'NO_MATCH'}`, { skip: SKIP }, async () => {
            await b.open(site.url(page))
            let got
            try { got = await b.readText({ question }) } catch (e) { if (e.code !== 'NO_MATCH') throw e; got = { noMatch: true, confidence: e.detail.confidence, top: e.detail.top } }
            margins.push(`${(got.confidence ?? 0).toFixed(2)} read  ${question} → ${got.noMatch ? 'NO_MATCH' : got.answer}`)
            if (want === null) assert.ok(got.noMatch, `answered ${got.answer} (${got.confidence})`)
            else assert.equal(got.answer, want, JSON.stringify(got.top))
        })
    }
}

test('Hacker News: read the top story\'s points', { skip: SKIP }, async () => {
    await b.open('https://news.ycombinator.com/')
    const got = await b.readText({ question: 'How many points does the first story have?' })
    margins.push(`${got.confidence.toFixed(2)} read  HN: points of the first story → ${got.answer}`)
    assert.match(got.answer, /^\d+ points by /)
    // The first story's own points row, as the page has it (a long title can
    // push "1." out of the context window, so compare with the DOM).
    const first = await (await b.page()).evaluate(() => document.querySelector('.subline, .subtext')?.innerText.replace(/\s+/g, ' ').trim())
    assert.equal(got.answer, first, 'the points row of the FIRST story')
})
