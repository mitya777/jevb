// Plain-text scenarios, one step per line, run in-process (no daemon):
//
//   pace human                      # or agent; can switch mid-scenario
//   open http://localhost:5174/
//   act open the new thread composer
//   type the thread title field => Hello from jevb
//   press Enter
//   scroll 800
//   check does the page show a thread titled "Hello from jevb"?
//   check@0.9 does the reply show an avatar?   # custom threshold
//   refute is an error message shown?           # passes if noul < 0.3
//   shot out/after-post.png
//   read what is the order number?   # the on-screen text that answers, verbatim
//   capture out/order.json          # the next act/type saves the requests it sends
//   send out/order.json ITEM=pen    # replay one, no page (see capture.mjs)
//
// Real phones (AWS Device Farm, or JEVB_APPIUM_URL): `device` / `app` lines
// pick what the next `open` starts; `open` with no url launches the app.
//
//   device pixel 8                  # or: device iphone 15
//   app build/app.apk               # .apk/.ipa, https/s3 url, upload ARN, or bundle id
//   open                            # launch the app (or `open <url>` for mobile web)
//   act? dismiss the notifications prompt   # `act?`: no match is skipped, not a failure
//
// `runScenario(file, { device, app })` (CLI: --device/--app) presets them,
// so one scenario runs on any phone.
//
// Exit code is non-zero if any check fails or any step throws. Consecutive
// checks are batched into one Jev request (see runScenario).
import fs from 'node:fs'
import path from 'node:path'
import { JevBrowser } from './browser.mjs'
import { JevDevice } from './device.mjs'
import { apiKey } from './jev.mjs'
import { chooseTier, flowHash, onlyPutsData, writeLocators } from './script.mjs'

export function parse(text) {
    return text.split('\n').map((raw, i) => ({ raw, line: i + 1 }))
        .map((s) => {
            // A recorded selector first: it can hold a # of its own.
            const at = s.raw.match(/^(.*?)\s@@\s(.+?)(\s+#\s.*)?$/)
            return { ...s, src: (at ? at[1] : s.raw.replace(/\s+#.*$/, '')).trim(), ...(at && { locator: at[2] }) }
        })
        .filter((s) => s.src && !s.src.startsWith('#'))
        .map((s) => {
            const m = s.src.match(/^(\w+)(\?)?(?:@([\d.]+))?\s*(.*)$/)
            return { ...s, cmd: m[1], optional: !!m[2], threshold: m[3] ? Number(m[3]) : undefined, arg: m[4] }
        })
}

const isCheck = (s) => s.cmd === 'check' || s.cmd === 'refute'
const toCheck = (s) => ({ question: s.arg, threshold: s.threshold, negate: s.cmd === 'refute' })

// Consecutive check/refute steps become one Jev request. If the next step is
// act/type they join that step's element-choice request too (same page
// state, and checks describe the page before the action either way).
// batch:false runs every step on its own, for comparison.
// ${NAME} in a type step comes from the environment (or ./.env) at run time,
// so credentials live in secrets, never in scenario files. Results and logs
// show the step as written (the placeholder), never the value.
const secretValues = new Set()
function expand(arg) {
    return arg.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
        if (process.env[name] == null) throw Object.assign(new Error(`${name} is not set (env or ./.env)`), { code: 'MISSING_ENV' })
        if (process.env[name].length >= 3) secretValues.add(process.env[name])
        return process.env[name]
    })
}

// A filled-in value can come back in output, e.g. as a field's value="..." in
// Jev's candidates (a test account's email did). Blank every one of them.
function redact(result) {
    if (!secretValues.size) return result
    let json = JSON.stringify(result)
    for (const v of secretValues) json = json.split(JSON.stringify(v).slice(1, -1)).join('***')
    return JSON.parse(json)
}

// via: auto (send when safe, else selectors, else Jev), page (never send), or
// jev (no selectors either). record: false leaves the file as it is.
export async function runScenario(file, { pace, baseUrl, batch = true, onStep = console.log, device, app, via = 'auto', record = true } = {}) {
    if (fs.existsSync('.env')) { try { process.loadEnvFile('.env') } catch {} }
    const steps = parse(fs.readFileSync(file, 'utf8'))
    // Fail before renting a phone: a missing key or ${NAME} used to surface
    // only at the first Jev call, after ~2 billed device minutes.
    apiKey()
    for (const s of steps) if (s.cmd === 'type') expand(s.arg.split(/\s*=>\s*/)[1] ?? '')
    const onDevice = !!(device || app) || steps.some((s) => ['device', 'app', 'platform'].includes(s.cmd))
    const b = onDevice ? new JevDevice({ pace, log: (m) => onStep({ log: m }) }) : new JevBrowser({ pace, idleMs: 10 * 60_000 })
    const deviceOpts = { ...(device && { device }), ...(app && { app }) } // consumed by the next open
    const target = (arg) => (arg && baseUrl ? new URL(arg, baseUrl).href : arg || undefined)
    const results = []
    let failed = 0
    // `capture <file>` applies to the next act/type (see capture.mjs).
    let captureNext = null
    const takeCapture = () => { const c = captureNext; captureNext = null; return c || undefined }
    const started = Date.now()
    const useLocators = via !== 'jev'
    const locators = new Map() // line -> selector to write
    let scripted = 0, healed = 0
    const ownCapture = steps.some((s) => s.cmd === 'capture' || s.cmd === 'send')
    const capFile = `${file}.capture.json`
    const hash = flowHash(steps, baseUrl)
    let lastWorkEnd = started // end of the last non-wait step: trailing waits don't count
    const emit = (r) => { r = redact(r); results.push(r); onStep(r) }
    const emitChecks = (checkSteps, checkResults, ms) => checkSteps.forEach((cs, i) => {
        const c = checkResults[i]
        if (!c.pass) failed++
        emit({ line: cs.line, step: cs.src, ms, ...c })
    })
    const note = (s, target) => {
        if (!target) return
        if (target.via === 'script') scripted++
        if (target.healed) healed++
        if (record && !onDevice && target.locator && target.locator !== s.locator) locators.set(s.line, target.locator)
    }
    // `type x => ${NAME}` is parameter NAME in a capture, else TYPE_n by order.
    const typeParams = steps.filter((s) => s.cmd === 'type').map((s, n) => {
        const text = s.arg.split(/\s*=>\s*/)[1] ?? ''
        return { line: s.line, name: text.trim().match(/^\$\{([A-Z0-9_]+)\}$/)?.[1] || `TYPE_${n + 1}`, text }
    })
    const flowCapture = !ownCapture && !onDevice && !b.demo && via !== 'jev' && onlyPutsData(steps)
    let cap = null
    try { cap = JSON.parse(fs.readFileSync(capFile, 'utf8')) } catch {}
    const decision = ownCapture ? { tier: 'page', why: 'the scenario manages its own captures' } : chooseTier({ steps, cap, hash, via, pace: b.pace, demo: b.demo, onDevice })
    let tier = decision.tier
    let sent = false
    onStep({ via: tier, why: decision.why })
    try {
        if (tier === 'send') {
            const values = {}
            for (const t of typeParams) values[t.name] = expand(t.text)
            let out = null, refused = null
            const t = Date.now()
            try { out = await b.send(capFile, { values }) } catch (e) {
                if (e.code === 'SOURCE_GONE' && !e.attempted) refused = e.message // nothing went out
                else {
                    failed++
                    emit({ step: `send ${path.basename(capFile)}`, ms: Date.now() - t, error: `${e.message}; not re-run, an earlier request may have taken effect` })
                    sent = true
                }
            }
            if (out) {
                const r = out.results
                // The server turned the very first request down, so nothing
                // happened: the page can still do it. Anything later or less
                // clear (5xx, timeout) may have taken effect and never re-runs.
                if (!out.ok && r.length === 1 && r[0].status >= 400 && r[0].status < 500) refused = `refused with ${r[0].status}`
                else {
                    const changed = r.find((x, i) => x.status !== cap.requests[i].status)
                    const bad = !out.ok || changed
                    if (bad) failed++
                    emit({ step: `send ${path.basename(capFile)}`, ms: Date.now() - t, ...out, ...(bad && { error: !out.ok ? `stopped at ${r.at(-1).status} after ${r.length} of ${cap.requests.length} requests; not re-run, it may have taken effect` : `status ${changed.status}, recorded ${cap.requests[r.indexOf(changed)].status}` }) })
                    lastWorkEnd = Date.now()
                    sent = true
                }
            }
            if (refused) {
                // Don't try this capture again until the flow is re-recorded.
                cap.replay = { ok: false, reasons: [refused] }
                fs.writeFileSync(capFile, JSON.stringify(cap, null, 2) + '\n')
                tier = 'page'
                onStep({ via: 'page', why: refused })
            }
        }
        if (!sent && flowCapture && !(cap && cap.hash === hash)) b.startFlow?.()
        for (let i = 0; !sent && i < steps.length; i++) {
            let s = steps[i]
            let pending = []
            if (isCheck(s)) {
                if (batch) while (i < steps.length && isCheck(steps[i])) pending.push(steps[i++])
                else pending.push(steps[i++])
                s = batch && steps[i] && ['act', 'type'].includes(steps[i].cmd) ? steps[i] : null
                if (!s) i-- // no action to ride along with: the checks go alone
            }
            const t = Date.now()
            b.step = [...pending, ...(s ? [s] : [])].map((x) => x.src).join('\n  + ')
            if (b.demo && b.sessions.size) await b.hud(await b.page().catch(() => null)).catch(() => {})
            let out
            const checks = pending.map(toCheck)
            try {
                if (!s) {
                    emitChecks(pending, await b.checks(checks), Date.now() - t)
                    lastWorkEnd = Date.now()
                    continue
                }
                switch (s.cmd) {
                    // An explicit --pace wins over the scenario's own pace lines.
                    case 'pace': if (!pace) b.pace = s.arg; out = { pace: b.pace }; break
                    case 'device': case 'app': case 'platform': deviceOpts[s.cmd] = s.arg; out = { [s.cmd]: s.arg }; break
                    case 'open': {
                        const opts = { ...deviceOpts }
                        for (const k of Object.keys(deviceOpts)) delete deviceOpts[k]
                        await b.flowAttach?.()
                        out = await b.open(target(s.arg), opts)
                        break
                    }
                    case 'capture': captureNext = path.resolve(s.arg); out = { capture: captureNext }; break
                    case 'send': {
                        const [file, ...kv] = s.arg.split(/\s+/)
                        const values = Object.fromEntries(kv.map((x) => [x.slice(0, x.indexOf('=')), expand(x.slice(x.indexOf('=') + 1))]))
                        // Parameters not given come from the env, as ${NAME} would:
                        // a missing one fails here, and results never echo them.
                        for (const p of JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')).params || []) values[p] ??= expand(`\${${p}}`)
                        out = await b.send(path.resolve(file), { values })
                        if (!out.ok) throw Object.assign(new Error(`send ${file}: ${out.results.map((r) => r.status).join(', ')}`), { detail: out.results })
                        break
                    }
                    case 'act': {
                        const opts = { checks, capture: takeCapture(), script: useLocators ? s.locator : undefined, quick: useLocators && !!steps[i + 1]?.locator }
                        out = await (b.flowStep ? b.flowStep(() => b.act(s.arg, opts)) : b.act(s.arg, opts))
                        note(s, out.clicked)
                        break
                    }
                    case 'type': {
                        const [intent, text] = s.arg.split(/\s*=>\s*/)
                        // type x => ${NAME}: a capture names the parameter NAME.
                        const as = typeParams.find((t) => t.line === s.line).name
                        const opts = { checks, as, capture: takeCapture(), script: useLocators ? s.locator : undefined }
                        out = await (b.flowStep ? b.flowStep(() => b.type(intent, expand(text ?? ''), opts)) : b.type(intent, expand(text ?? ''), opts))
                        note(s, out.typed)
                        break
                    }
                    case 'read': out = await b.readText({ question: s.arg || undefined }); break
                    case 'press': out = await (b.flowStep ? b.flowStep(() => b.press(s.arg)) : b.press(s.arg)); break
                    case 'scroll': out = await b.scroll(s.arg || 600); break
                    case 'wait': await new Promise((r) => setTimeout(r, Number(s.arg))); out = {}; break
                    case 'shot': fs.mkdirSync(path.dirname(s.arg), { recursive: true }); out = await b.screenshot(s.arg); break
                    default: throw new Error(`unknown step "${s.cmd}"`)
                }
            } catch (e) {
                if (s.optional && e.code === 'NO_MATCH') out = { skipped: 'no match', checks: e.checks }
                else {
                    failed++
                    out = { error: e.message, detail: e.detail, checks: e.checks }
                }
            }
            if (s.cmd !== 'wait') lastWorkEnd = Date.now()
            const { checks: checkResults, ...rest } = out
            if (pending.length && checkResults) emitChecks(pending, checkResults, Date.now() - t)
            emit({ line: s.line, step: s.src, ms: Date.now() - t, ...rest })
            if (out.error) break // later steps depend on page state; stop at first error
        }
        if (b.demo) {
            const secs = ((lastWorkEnd - started) / 1000).toFixed(2)
            await b.showDone(failed ? `FAILED  ${failed}  ·  ${secs}s` : `DONE  ${secs}s`)
            await new Promise((r) => setTimeout(r, 2500)) // hold the banner for viewers/recordings
        }
        // A failed run's requests say nothing about what the flow should send.
        if (b.flow && !failed) await b.finishFlow(capFile, { hash })
    } finally {
        if (b.flow) b.flow = null
        if (locators.size) { try { writeLocators(file, locators) } catch (e) { onStep({ log: `could not write selectors: ${e.message}` }) } }
        var { videos } = await b.shutdown('scenario done')
    }
    return { failed, results, videos, via: tier, scripted, healed, jevCalls: b.jevRequests, jevTokens: b.jevTokens, totalMs: lastWorkEnd - started }
}
