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
    return line?.[1].trim().replace(/^["']|["']$/g, '')
})()
const live = process.env.JEVB_LIVE === '1' && envKey
if (live) { process.env.TYPESAFEAI_API_KEY = envKey; delete process.env.TYPESAFE_ENDPOINT }

const { JevBrowser } = await import('../../src/browser.mjs')

let site, b
before(async () => { if (live) { site = await fixtures(); b = new JevBrowser({ pace: 'agent' }) } })
after(async () => { await b?.shutdown(); await site?.close() })

const margins = []
after(() => { if (margins.length) console.log(`\n${margins.map((m) => `  ${m}`).join('\n')}`) })

// intent -> the label jevb should pick (unquoted, as a person would say it)
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
}

const SKIP = !live && 'set JEVB_LIVE=1 and TYPESAFEAI_API_KEY'
for (const [page, cases] of Object.entries(PICKS)) {
    for (const [intent, want] of Object.entries(cases)) {
        test(`pick on ${page}: ${intent} → ${want ?? 'NO_MATCH'}`, { skip: SKIP }, async () => {
            await b.open(site.url(page))
            let got
            try { got = (await b.find(intent)).target } catch (e) { if (e.code !== 'NO_MATCH') throw e; got = { ...e.detail, noMatch: true } }
            const label = got.desc?.match(/^\S+ "([^"]*)"/)?.[1]
            margins.push(`${(got.confidence ?? 0).toFixed(2)} pick  ${intent} → ${got.noMatch ? 'NO_MATCH' : label}`)
            if (want === null) assert.ok(got.noMatch, `picked ${label} (${got.confidence})`)
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
