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
//
// Real phones (AWS Device Farm, or JEVB_APPIUM_URL): `device` / `app` lines
// pick what the next `open` starts; `open` with no url launches the app.
//
//   device pixel 8                  # or: device iphone 15
//   app build/treechat.apk          # .apk/.ipa, https/s3 url, upload ARN, or bundle id
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

export function parse(text) {
    return text.split('\n').map((raw, i) => ({ raw, line: i + 1 }))
        .map((s) => ({ ...s, src: s.raw.replace(/\s+#.*$/, '').trim() }))
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
function expand(arg) {
    return arg.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
        if (process.env[name] == null) throw Object.assign(new Error(`${name} is not set (env or ./.env)`), { code: 'MISSING_ENV' })
        return process.env[name]
    })
}

export async function runScenario(file, { pace, baseUrl, batch = true, onStep = console.log, device, app } = {}) {
    if (fs.existsSync('.env')) { try { process.loadEnvFile('.env') } catch {} }
    const steps = parse(fs.readFileSync(file, 'utf8'))
    const onDevice = !!(device || app) || steps.some((s) => ['device', 'app', 'platform'].includes(s.cmd))
    const b = onDevice ? new JevDevice({ pace, log: (m) => onStep({ log: m }) }) : new JevBrowser({ pace, idleMs: 10 * 60_000 })
    const deviceOpts = { ...(device && { device }), ...(app && { app }) } // consumed by the next open
    const target = (arg) => (arg && baseUrl ? new URL(arg, baseUrl).href : arg || undefined)
    const results = []
    let failed = 0
    const started = Date.now()
    let lastWorkEnd = started // end of the last non-wait step: trailing waits don't count
    const emit = (r) => { results.push(r); onStep(r) }
    const emitChecks = (checkSteps, checkResults, ms) => checkSteps.forEach((cs, i) => {
        const c = checkResults[i]
        if (!c.pass) failed++
        emit({ line: cs.line, step: cs.src, ms, ...c })
    })
    try {
        for (let i = 0; i < steps.length; i++) {
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
                        out = await b.open(target(s.arg), opts)
                        break
                    }
                    case 'act': out = await b.act(s.arg, { checks }); break
                    case 'type': {
                        const [intent, text] = s.arg.split(/\s*=>\s*/)
                        out = await b.type(intent, expand(text ?? ''), { checks })
                        break
                    }
                    case 'press': out = await b.press(s.arg); break
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
    } finally {
        var { videos } = await b.shutdown('scenario done')
    }
    return { failed, results, videos, jevCalls: b.jevRequests, jevTokens: b.jevTokens, totalMs: lastWorkEnd - started }
}
