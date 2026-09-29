// Jev judgments for one screen state, shared by the browser and device
// backends: an optional element choice for `intent` plus any number of
// checks (nouls). All checks share one request (same state). The choice goes
// in its own request, sent at the same time: page text in its state
// measurably lowers pick confidence (0.94 → ~0.5 on a real sign-up page), so the
// two never share state. Checks see the screen as it is *before* the action.
//
//   options(): elements to choose from, [{ id, desc }] (already shortlisted)
//   state():   what checks judge (visible text etc.)
//   where():   small context for the choice (url/title, or app/screen)
import { ask } from './jev.mjs'

const at = (d) => d?.match(/ at (-?\d+),(-?\d+)$/)?.slice(1).map(Number)
// Kind of control: role + label without a count suffix ("Reply (3)").
const kind = (d) => d?.match(/^(\S+) "([^"]*?)(?: \(\d+\))?"/)?.slice(1).join(' ')

// One option standing for repeated controls, with the span of items they
// sit in so Jev knows what they act on ("Reply" on posts, not the reply box).
function groupDesc(ds) {
    const [role, label] = ds[0].match(/^(\S+) "([^"]*?)(?: \(\d+\))?"/).slice(1)
    const item = (d) => d.match(/ in "([^"]*)"/)?.[1]
    const [first, last] = [item(ds[0]), item(ds.at(-1))]
    return `${role} "${label}" ×${ds.length}, one per item${first && last ? `, from "${first}" to "${last}"` : ''}`
}

export async function judge({ intent, checks = [], options, state, where }) {
    let criteria, descs, groups = {}
    // "The last Reply", "hide the first story": positional intents ask two
    // things. Which kind of control is Jev's call; which one is position.
    // Repeated controls (same role and label) go to Jev as ONE option, and
    // code takes the topmost/bottommost on screen. Asked per control, Jev
    // split the weight across copies (0.42/0.31/0.24), spread it onto
    // titles and "none" (0.21 in total on Hacker News), or took the first
    // copy for "the last post".
    const order = intent && (/\b(first|top(most)?)\b/i.test(intent) ? 1 : /\b(last|bottom(most)?)\b/i.test(intent) ? -1 : 0)
    const choiceReq = intent && (async () => {
        const opts = await options()
        if (!opts.length) throw Object.assign(new Error('no interactive elements on screen'), { code: 'NO_ELEMENTS' })
        descs = Object.fromEntries(opts.map((e) => [e.id, e.desc]))
        if (order) {
            const byKind = {}
            for (const e of opts) { const k = kind(e.desc); if (k && at(e.desc)) (byKind[k] ||= []).push(e.id) }
            for (const ids of Object.values(byKind)) if (ids.length > 1) groups[ids[0]] = ids
        }
        const hidden = new Set(Object.values(groups).flatMap((ids) => ids.slice(1)))
        criteria = Object.fromEntries(opts.filter((e) => !hidden.has(e.id)).map((e) => [e.id,
            groups[e.id] ? groupDesc(groups[e.id].map((id) => descs[id])) : e.desc]))
        criteria.none = 'No element on the page matches the intent'
        return ask({ intent, page: await where() },
            { target: { type: 'choice', criteria, instructions: 'Which page element should a user interact with to accomplish `intent`?'
                + (Object.keys(groups).length ? ' An option marked ×N stands for N identical controls, one per item; choose it if the intent means that kind of control. Which one (first/last) is resolved by position afterwards.' : '') } })
    })()
    let seen
    const checksReq = checks.length && (async () => ask(seen = await state(), Object.fromEntries(checks.map((c, i) => [
        `check_${i}`, { type: 'noul', instructions: `The user currently sees \`viewport_text\` (only the modal, when \`modal_open\` is true) and form \`fields\`. Judge what the user sees now: ${c.question}` },
    ]))))()
    const t = Date.now()
    const [choiceRes, checksRes] = await Promise.all([choiceReq || null, checksReq || null])
    const answers = { ...choiceRes?.answers, ...checksRes?.answers }
    const jevMs = Date.now() - t
    const requests = (choiceRes ? 1 : 0) + (checksRes ? 1 : 0)
    const batch = checks.length + (intent ? 1 : 0)

    const checkResults = checks.map((c, i) => {
        const negate = !!c.negate
        const threshold = Number(c.threshold ?? (negate ? 0.3 : 0.7))
        const noul = answers[`check_${i}`].noul
        const pass = negate ? noul < threshold : noul >= threshold
        // A failed check shows the form fields Jev judged, to tell a wrong
        // screen from a wrong judgment.
        return { question: c.question, noul, threshold, negate, pass, jevMs, batch, requests, ...(!pass && seen?.fields?.length && { fields: seen.fields }) }
    })
    let target = null
    if (intent) {
        const a = answers.target
        const top = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]).slice(0, 3)
            .filter(([, p], i) => i === 0 || p >= 0.01).map(([id, p]) => ({ id, p: +p.toFixed(3), desc: criteria[id] }))
        target = { id: a.choice, confidence: a.confidence, desc: criteria[a.choice], jevMs, batch, requests, top }
        // An icon and its label often sit on one control ("icon: home" and
        // "Home", 2px apart) and split Jev's probability below the bar
        // (0.40 + 0.38). Options within 24px of the pick count as the pick.
        const p0 = a.choice !== 'none' && at(criteria[a.choice])
        if (p0) {
            const near = Object.entries(a.probabilities || {}).filter(([id]) => {
                const p = at(criteria[id])
                return p && Math.hypot(p[0] - p0[0], p[1] - p0[1]) <= 24
            })
            const sum = near.reduce((acc, [, p]) => acc + p, 0)
            if (near.length > 1 && sum > target.confidence) Object.assign(target, { confidence: +sum.toFixed(3), merged: near.length })
        }
        const members = groups[a.choice]
        if (members) {
            const shown = members.filter((id) => !/ offscreen /.test(descs[id]))
            const [pick] = (shown.length ? shown : members)
                .sort((x, y) => order * (at(descs[x])[1] - at(descs[y])[1]) || at(descs[x])[0] - at(descs[y])[0])
            Object.assign(target, { id: pick, desc: descs[pick], ordinal: order > 0 ? 'first' : 'last', of: members.length })
        }
    }

    const lines = checkResults.map((c) => `${c.negate ? 'refute' : 'check'} ${c.noul.toFixed(2)} ${c.pass ? 'PASS ✓' : 'FAIL ✗'}  ${c.question}`)
    if (target) lines.push(`picked ${target.desc.replace(/ at \d+,\d+$/, '')}  conf ${target.confidence.toFixed(2)}`)
    const summary = `Jev ${batch} question${batch > 1 ? 's' : ''} · ${requests} parallel request${requests > 1 ? 's' : ''} · ${jevMs}ms\n  ${lines.join('\n  ')}`
    const usage = [choiceRes, checksRes].reduce((u, r) => ({
        input: u.input + (r?.usage?.input_tokens || 0), output: u.output + (r?.usage?.output_tokens || 0),
    }), { input: 0, output: 0 })
    return { target, checks: checkResults, requests, summary, usage }
}

// Checks wait like Playwright's expect: re-judge the screen until they pass
// or waitMs runs out (JEVB_CHECK_WAIT_MS, default 4000). A Channels page
// judged 0.4s after the tap was still a spinner (0.12); its list came a
// second later. Checks riding with an action judge the screen before it,
// so they're asked once.
export async function waitForChecks(run, waitMs = Number(process.env.JEVB_CHECK_WAIT_MS ?? 4000)) {
    const started = Date.now()
    for (let tries = 1; ; tries++) {
        const results = await run()
        if (results.every((c) => c.pass) || Date.now() - started >= waitMs) {
            return tries > 1 ? results.map((c) => ({ ...c, tries, waitedMs: Date.now() - started })) : results
        }
        await new Promise((r) => setTimeout(r, 600))
    }
}
