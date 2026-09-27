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
import { ask } from './jev.mjs'

export async function judge({ intent, checks = [], options, state, where }) {
    let criteria
    const choiceReq = intent && (async () => {
        const opts = await options()
        if (!opts.length) throw Object.assign(new Error('no interactive elements on screen'), { code: 'NO_ELEMENTS' })
        criteria = Object.fromEntries(opts.map((e) => [e.id, e.desc]))
        criteria.none = 'No element on the page matches the intent'
        return ask({ intent, page: await where() },
            { target: { type: 'choice', instructions: 'Which page element should a user interact with to accomplish `intent`?', criteria } })
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
    }

    const lines = checkResults.map((c) => `${c.negate ? 'refute' : 'check'} ${c.noul.toFixed(2)} ${c.pass ? 'PASS ✓' : 'FAIL ✗'}  ${c.question}`)
    if (target) lines.push(`picked ${target.desc.replace(/ at \d+,\d+$/, '')}  conf ${target.confidence.toFixed(2)}`)
    const summary = `Jev ${batch} question${batch > 1 ? 's' : ''} · ${requests} parallel request${requests > 1 ? 's' : ''} · ${jevMs}ms\n  ${lines.join('\n  ')}`
    return { target, checks: checkResults, requests, summary }
}
