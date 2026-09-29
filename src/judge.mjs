// Jev judgments for one screen state, shared by the browser and device
// backends: an optional element choice for `intent` plus any number of
// checks (nouls). All checks share one request (same state). The choice goes
// in its own request, sent at the same time: page text in its state
// measurably lowers pick confidence (0.94 → ~0.5 on Treechat signup), so the
// two never share state. Checks see the screen as it is *before* the action.
//
//   options(): elements to choose from, [{ id, desc }] (already shortlisted)
//   state():   what checks judge (visible text etc.)
//   where():   small context for the choice (url/title, or app/screen)
//   cache, page: optional ReplayCache (cache.mjs) and this screen's page key
//              (a string, or an async function when it costs a round trip).
//              A cached pick or check skips its Jev request. Only picks the
//              caller would accept (>= minConfidence) are remembered.
//   template:  { intent, values } for a step from a parameterized action.
import { ask } from './jev.mjs'

const checkInstructions = (q) => `The user currently sees \`viewport_text\` (only the modal, when \`modal_open\` is true) and form \`fields\`. Judge what the user sees now: ${q}`

export async function judge({ intent, checks = [], options, state, where, cache = null, page = '', minConfidence = 0.5, template = null }) {
    let criteria, opts, pageId, cachedPick = null
    const choiceReq = intent && (async () => {
        if (cache) pageId = typeof page === 'function' ? await page() : page
        opts = await options()
        if (!opts.length) throw Object.assign(new Error('no interactive elements on screen'), { code: 'NO_ELEMENTS' })
        criteria = Object.fromEntries(opts.map((e) => [e.id, e.desc]))
        criteria.none = 'No element on the page matches the intent'
        cachedPick = cache?.pick(pageId, intent, opts, template)
        if (cachedPick) return null
        return ask({ intent, page: await where() },
            { target: { type: 'choice', instructions: 'Which page element should a user interact with to accomplish `intent`?', criteria } })
    })()
    let seen
    const cachedChecks = {}
    const checksReq = checks.length && (async () => {
        seen = await state()
        const keys = checks.map((c) => cache?.checkKey(c.question, seen))
        const todo = []
        checks.forEach((c, i) => {
            const noul = keys[i] && cache.check(keys[i])
            if (noul != null) cachedChecks[`check_${i}`] = { noul, cached: true }
            else todo.push(i)
        })
        if (!todo.length) return null
        const res = await ask(seen, Object.fromEntries(todo.map((i) => [`check_${i}`, { type: 'noul', instructions: checkInstructions(checks[i].question) }])))
        if (cache) for (const i of todo) cache.rememberCheck(keys[i], res.answers[`check_${i}`].noul)
        return res
    })()
    const t = Date.now()
    const [choiceRes, checksRes] = await Promise.all([choiceReq || null, checksReq || null])
    const answers = { ...choiceRes?.answers, ...checksRes?.answers, ...cachedChecks }
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
        return { question: c.question, noul, threshold, negate, pass, jevMs, batch, requests, ...(answers[`check_${i}`].cached && { cached: true }), ...(!pass && seen?.fields?.length && { fields: seen.fields }) }
    })
    let target = null
    if (cachedPick) {
        const { el, entry } = cachedPick
        target = { id: el.id, confidence: entry.confidence, desc: el.desc, cached: true, jevMs: 0, batch, requests, top: [], ...(entry.ordinal && { ordinal: entry.ordinal }) }
    } else if (intent) {
        const a = answers.target
        const top = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]).slice(0, 3)
            .filter(([, p], i) => i === 0 || p >= 0.01).map(([id, p]) => ({ id, p: +p.toFixed(3), desc: criteria[id] }))
        target = { id: a.choice, confidence: a.confidence, desc: criteria[a.choice], jevMs, batch, requests, top }
        // An icon and its label often sit on one control ("icon: home" and
        // "Home", 2px apart) and split Jev's probability below the bar
        // (0.40 + 0.38). Options within 24px of the pick count as the pick.
        const at = (d) => d?.match(/ at (-?\d+),(-?\d+)$/)?.slice(1).map(Number)
        const p0 = a.choice !== 'none' && at(criteria[a.choice])
        if (p0) {
            const near = Object.entries(a.probabilities || {}).filter(([id]) => {
                const p = at(criteria[id])
                return p && Math.hypot(p[0] - p0[0], p[1] - p0[1]) <= 24
            })
            const sum = near.reduce((acc, [, p]) => acc + p, 0)
            if (near.length > 1 && sum > target.confidence) Object.assign(target, { confidence: +sum.toFixed(3), merged: near.length })
        }
        // "The first Reply button" is positional: several identical controls
        // ("Reply", "Reply (1)") split the probability (0.42/0.31/0.24).
        // When the intent says first/last and the likely options are one kind
        // of control, take the topmost/bottommost and their combined weight.
        const order = /\b(first|top(most)?)\b/i.test(intent) ? 1 : /\b(last|bottom(most)?)\b/i.test(intent) ? -1 : 0
        const kind = (d) => d?.match(/^(\S+) "([^"]*?)(?: \(\d+\))?"/)?.slice(1).join(' ')
        const likely = Object.entries(a.probabilities || {}).filter(([id, p]) => p >= 0.1 && id !== 'none')
        if (order && likely.length > 1 && new Set(likely.map(([id]) => kind(criteria[id]))).size === 1 && kind(criteria[likely[0][0]])) {
            const [pick] = likely.sort(([x], [y]) => order * (at(criteria[x])[1] - at(criteria[y])[1]) || at(criteria[x])[0] - at(criteria[y])[0])[0]
            const sum = likely.reduce((acc, [, p]) => acc + p, 0)
            Object.assign(target, { id: pick, desc: criteria[pick], confidence: +sum.toFixed(3), ordinal: order > 0 ? 'first' : 'last' })
        }
        if (cache && target.id !== 'none' && target.confidence >= minConfidence) cache.rememberPick(pageId, intent, target, opts, template)
    }

    const lines = checkResults.map((c) => `${c.negate ? 'refute' : 'check'} ${c.noul.toFixed(2)} ${c.pass ? 'PASS ✓' : 'FAIL ✗'}  ${c.question}`)
    if (target) lines.push(`picked ${target.desc.replace(/ at \d+,\d+$/, '')}  conf ${target.confidence.toFixed(2)}${target.cached ? '  (cached)' : ''}`)
    cache?.save()
    const summary = `Jev ${batch} question${batch > 1 ? 's' : ''} · ${requests} parallel request${requests > 1 ? 's' : ''} · ${jevMs}ms\n  ${lines.join('\n  ')}`
    const usage = [choiceRes, checksRes].reduce((u, r) => ({
        input: u.input + (r?.usage?.input_tokens || 0), output: u.output + (r?.usage?.output_tokens || 0),
    }), { input: 0, output: 0 })
    return { target, checks: checkResults, requests, summary, usage }
}
