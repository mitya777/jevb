// Turns what Jev picked into a selector, so a repeat of the step needs no
// model. Each step in a .jevb file can carry one after @@:
//
//   act click Log in  @@ role=button[name="Log in"s]
//
// jevb run writes these as it goes and repairs them when one stops matching.
import crypto from 'node:crypto'
import fs from 'node:fs'

// An intent that means "whichever is there now" has no fixed element:
// yesterday's newest thread isn't today's.
const RELATIVE = /\b(first|second|third|fourth|fifth|last|next|previous|newest|latest|oldest|recent|random|any|another)\b/i
export const isRelative = (intent) => RELATIVE.test(intent)

// Runs in the page. Selectors for one element, most stable first.
function candidates(id) {
    const el = document.querySelector(`[data-jevb="${id}"]`)
    if (!el) return []
    const q = (s) => JSON.stringify(s)
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const tag = el.tagName.toLowerCase()
    const attr = (a) => el.getAttribute(a)
    const out = []
    for (const a of ['data-testid', 'data-test-id', 'data-test', 'data-cy']) if (attr(a)) out.push(`[${a}=${q(attr(a))}]`)
    const field = el.matches('input,textarea,select')
    const inputRole = { button: 'button', submit: 'button', checkbox: 'checkbox', radio: 'radio' }[attr('type')] || (attr('type') === 'password' ? null : 'textbox')
    const role = attr('role') || { a: attr('href') != null ? 'link' : null, button: 'button', textarea: 'textbox', select: 'combobox', summary: null, input: inputRole }[tag]
    const name = clean(attr('aria-label') || (field ? el.labels?.[0]?.innerText : el.innerText))
    if (role && name && name.length <= 80) out.push(`role=${role}[name=${q(name)}s]`)
    if (attr('placeholder')) out.push(`${tag}[placeholder=${q(attr('placeholder'))}]`)
    if (attr('aria-label')) out.push(`${tag}[aria-label=${q(attr('aria-label'))}]`)
    if (field && attr('name')) out.push(`${tag}[name=${q(attr('name'))}]`)
    // Generated ids change between builds.
    if (el.id && !/\d{3,}|[a-f0-9]{8,}|^:|^radix-|^react-/i.test(el.id)) out.push(`#${CSS.escape(el.id)}`)
    if (!role && name && name.length <= 80) out.push(`text=${q(name)}`)
    return out
}

// A selector for exactly this element, or null: one with no stable name
// stays with Jev. A hit inside the element counts (text= finds the innermost
// node), since a click there lands on it. Same label twice (desktop and mobile
// nav) falls back to position, but not past 3: more is a list, like a feed,
// where position would mean a different post tomorrow.
export async function stableLocator(page, id, { avoid = [] } = {}) {
    const found = await page.evaluate(candidates, id).catch(() => [])
    const inside = (l) => l.evaluate((n, id) => !!n.closest(`[data-jevb="${id}"]`), id, { timeout: 500 })
    let byPosition = null
    for (const sel of found) {
        if (avoid.some((v) => v && v.length >= 3 && sel.includes(v))) continue // typed text, maybe a secret
        try {
            if (await page.locator(sel).count() === 1 && await inside(page.locator(sel))) return sel
            const visible = `${sel} >> visible=true`
            const n = await page.locator(visible).count()
            if (n === 1 && await inside(page.locator(visible))) return visible
            for (let i = 0; !byPosition && n <= 3 && i < n; i++) {
                if (await inside(page.locator(`${visible} >> nth=${i}`))) byPosition = `${visible} >> nth=${i}`
            }
        } catch {} // not a selector this page accepts: try the next
    }
    return byPosition
}

// Same flow on the same host: typed text can change, anything else re-records.
export function flowHash(steps, baseUrl) {
    // ${NAME} is the parameter's name in the capture, so it counts; literal text doesn't.
    const shape = steps.map((s) => {
        if (s.cmd !== 'type') return `${s.cmd} ${s.arg}`
        const [intent, text = ''] = s.arg.split(/\s*=>\s*/)
        return `type ${intent} => ${text.trim().match(/^\$\{[A-Z0-9_]+\}$/)?.[0] || ''}`
    })
    return crypto.createHash('sha1').update(JSON.stringify([baseUrl || '', shape])).digest('hex')
}

// Steps that look at the page need the page; the rest only put data in.
const INPUT_ONLY = new Set(['pace', 'open', 'act', 'type', 'press', 'scroll', 'wait'])
export const onlyPutsData = (steps) => steps.length > 0 && steps.every((s) => INPUT_ONLY.has(s.cmd) && !s.optional)

// Which way to run a flow. A wrong "send" runs an action the page wouldn't
// have, a wrong "page" only costs time, so anything unclear goes to the page.
export function chooseTier({ steps, cap, hash, via = 'auto', pace, demo, onDevice }) {
    const page = (why) => ({ tier: 'page', why })
    if (via !== 'auto') return page(`--via ${via}`)
    if (onDevice) return page('runs on a phone')
    if (demo) return page('recording needs the page')
    if (pace === 'human' || steps.some((s) => s.cmd === 'pace' && s.arg === 'human')) return page('human pace tests the page')
    if (!onlyPutsData(steps)) return page('a step reads the page')
    // No selector means no fixed target ("the newest post", one Reply among
    // many): a replay would hit the recorded one, not today's.
    if (steps.some((s) => (s.cmd === 'act' || s.cmd === 'type') && (!s.locator || isRelative(s.arg.split(/\s*=>\s*/)[0])))) return page('a step has no fixed target')
    if (!cap) return page('no capture yet')
    if (cap.hash !== hash) return page('the flow or host changed since its capture')
    if (!cap.replay?.ok) return page(cap.replay?.reasons?.join('; ') || 'capture has no verdict')
    return { tier: 'send', why: 'only sends data; capture is safe to replay' }
}

// Writes selectors into the scenario, leaving everything else on the line.
export function writeLocators(file, updates) {
    if (!updates.size) return false
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    for (const [line, locator] of updates) {
        const raw = lines[line - 1]
        const m = raw.match(/\s@@\s.+?(\s+#\s.*)?$/)
        const comment = m ? m[1] || '' : raw.match(/\s+#.*$/)?.[0] || ''
        const base = (m ? raw.slice(0, m.index) : raw.slice(0, raw.length - comment.length)).trimEnd()
        lines[line - 1] = `${base}  @@ ${locator}${comment}`
    }
    fs.writeFileSync(file, lines.join('\n'))
    return true
}

// A standalone Playwright script from a recorded flow. Steps without a
// selector, and checks it can't express, are left as comments to fill in.
export function toPlaywright(steps, { baseUrl } = {}) {
    const q = (s) => JSON.stringify(s)
    const envText = (t) => {
        const whole = t.trim().match(/^\$\{([A-Z0-9_]+)\}$/)
        return whole ? `env[${q(whole[1])}]` : q(t)
    }
    const body = steps.map((s) => {
        const pad = '    '
        if (s.cmd === 'open') return `${pad}await page.goto(${q(baseUrl ? new URL(s.arg, baseUrl).href : s.arg)})`
        if (s.cmd === 'press') return `${pad}await page.keyboard.press(${q(s.arg)})`
        if (s.cmd === 'wait') return `${pad}await page.waitForTimeout(${Number(s.arg)})`
        if (s.cmd === 'shot') return `${pad}await page.screenshot({ path: ${q(s.arg)} })`
        if (s.cmd === 'act' || s.cmd === 'type') {
            if (!s.locator) return `${pad}// TODO no selector recorded: ${s.src}`
            if (s.cmd === 'act') return `${pad}await page.locator(${q(s.locator)}).click() // ${s.arg}`
            const [intent, text] = s.arg.split(/\s*=>\s*/)
            return `${pad}await page.locator(${q(s.locator)}).fill(${envText(text ?? '')}) // ${intent}`
        }
        const shown = s.cmd === 'check' && s.arg.match(/"([^"]+)"/)
        if (shown) return `${pad}await page.getByText(${q(shown[1])}).first().waitFor() // ${s.src}`
        return `${pad}// TODO needs a judgment: ${s.src}`
    })
    return `// Generated by jevb export. Plain Playwright: no jevb, no model.
export async function run(page, env = process.env) {
${body.join('\n')}
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch()
    try { await run(await browser.newPage()) } finally { await browser.close() }
}
`
}
