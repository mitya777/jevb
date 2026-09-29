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
// Reusable actions: `do NAME key=value ...` runs actions/NAME.mjs (code,
// e.g. Playwright: export async function browser({ page, args, jevb })) when
// it exists for this backend, else actions/NAME.jevb (steps; ${key} is an
// argument). A failing block falls back to the .jevb. See findAction.
//
//   do login email=${TEST_EMAIL} password=${TEST_PASSWORD}
//
// Picks and checks replay from the cache (cache.mjs) when the screen allows.
//
// Exit code is non-zero if any check fails or any step throws. Consecutive
// checks are batched into one Jev request (see runScenario).
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { JevBrowser } from './browser.mjs'
import { ReplayCache } from './cache.mjs'
import { JevDevice } from './device.mjs'
import { apiKey } from './jev.mjs'

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

export async function runScenario(file, { pace, baseUrl, batch = true, onStep = console.log, device, app, cache, actionDirs = [] } = {}) {
    if (fs.existsSync('.env')) { try { process.loadEnvFile('.env') } catch {} }
    const steps = parse(fs.readFileSync(file, 'utf8'))
    const dirs = actionPaths(file, actionDirs)
    // Fail before renting a phone: a missing key or ${NAME} used to surface
    // only at the first Jev call, after ~2 billed device minutes.
    apiKey()
    preflight(steps, dirs)
    const onDevice = !!(device || app) || steps.some((s) => ['device', 'app', 'platform'].includes(s.cmd))
    // cache: undefined = JEVB_CACHE (default .jevb/cache.json), false = off.
    const replay = cache === false ? null : cache || ReplayCache.fromEnv()
    if (replay) replay.secrets = secretValues // typed secrets must never reach the cache file
    const b = onDevice ? new JevDevice({ pace, log: (m) => onStep({ log: m }), cache: replay }) : new JevBrowser({ pace, idleMs: 10 * 60_000, cache: replay })
    const deviceOpts = { ...(device && { device }), ...(app && { app }) } // consumed by the next open
    const target = (arg) => (arg && baseUrl ? new URL(arg, baseUrl).href : arg || undefined)
    const results = []
    let failed = 0
    const started = Date.now()
    let lastWorkEnd = started // end of the last non-wait step: trailing waits don't count
    const emit = (r) => { r = redact(r); results.push(r); onStep(r) }

    // Runs steps in order; returns false after an error (later steps depend
    // on page state). `via` names the action a step came from.
    async function runSteps(steps, via = '') {
        const label = (x) => (via ? `${via} › ${x.src}` : x.src)
        const emitChecks = (checkSteps, checkResults, ms) => checkSteps.forEach((cs, i) => {
            const c = checkResults[i]
            if (!c.pass) failed++
            emit({ line: cs.line, step: label(cs), ms, ...c })
        })
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
            b.step = [...pending, ...(s ? [s] : [])].map(label).join('\n  + ')
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
                    case 'do': out = await runAction(s, via); break
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
            emit({ line: s.line, step: label(s), ms: Date.now() - t, ...rest })
            if (out.error) return false
        }
        return true
    }

    // `do NAME k=v ...`: a code block (NAME.mjs, e.g. Playwright) when one
    // exists for this backend, else the plain-language steps in NAME.jevb.
    // A block that throws falls back to NAME.jevb when there is one.
    async function runAction(s, via) {
        const { name, args } = parseDo(s.arg)
        const chain = via ? `${via} › ${name}` : name
        if (chain.split(' › ').length > 8) throw new Error(`actions nested too deep: ${chain}`)
        const found = findAction(name, dirs)
        const values = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, expand(v)]))
        let blockError = null
        if (found.block) {
            const mod = await import(pathToFileURL(found.block).href)
            const fn = onDevice ? mod.device : mod.browser || mod.default
            if (fn) {
                try {
                    const ctx = onDevice
                        ? { jevb: b, session: b.session(), wd: b.session().wd, args: values }
                        : { jevb: b, page: await b.page(), args: values }
                    const res = await fn(ctx)
                    return { action: name, ran: path.basename(found.block), ...(res && typeof res === 'object' && res) }
                } catch (e) {
                    if (!found.steps) throw e
                    blockError = e.message
                }
            }
        }
        if (!found.steps) throw new Error(`action "${name}": ${found.block ? `${path.basename(found.block)} has no ${onDevice ? 'device' : 'browser'} export` : 'not found'} (looked in ${dirs.join(', ')})`)
        const sub = actionSteps(found.steps, values)
        const ok = await runSteps(sub, chain)
        return { action: name, ran: path.basename(found.steps), ...(blockError && { fallback: `block failed: ${blockError}` }), ...(!ok && { error: `action "${name}" failed` }) }
    }

    try {
        await runSteps(steps)
        if (b.demo) {
            const secs = ((lastWorkEnd - started) / 1000).toFixed(2)
            await b.showDone(failed ? `FAILED  ${failed}  ·  ${secs}s` : `DONE  ${secs}s`)
            await new Promise((r) => setTimeout(r, 2500)) // hold the banner for viewers/recordings
        }
    } finally {
        var { videos } = await b.shutdown('scenario done')
        replay?.save()
    }
    return { failed, results, videos, jevCalls: b.jevRequests, jevTokens: b.jevTokens, cacheHits: replay ? { ...replay.hits } : null, totalMs: lastWorkEnd - started }
}

// ---- actions ---------------------------------------------------------------

// Where `do NAME` looks: actions/ next to the scenario, .jevb/actions in the
// working directory, then JEVB_ACTIONS (colon-separated) and actionDirs.
function actionPaths(file, extra) {
    return [...new Set([
        path.join(path.dirname(path.resolve(file)), 'actions'),
        path.resolve('.jevb/actions'),
        ...(process.env.JEVB_ACTIONS || '').split(':').filter(Boolean).map((d) => path.resolve(d)),
        ...extra.map((d) => path.resolve(d)),
    ])]
}

export function findAction(name, dirs) {
    if (!/^[\w-]+$/.test(name)) throw new Error(`bad action name "${name}"`)
    const first = (ext) => dirs.map((d) => path.join(d, `${name}.${ext}`)).find((f) => fs.existsSync(f)) || null
    return { block: first('mjs'), steps: first('jevb') }
}

// do NAME key=value key="value with spaces" key=${ENV_NAME}
export function parseDo(arg) {
    const [name, ...rest] = arg.trim().split(/\s+/)
    const args = {}
    for (const m of rest.join(' ').matchAll(/(\w+)=(?:"([^"]*)"|(\S+))/g)) args[m[1]] = m[2] ?? m[3]
    return { name, args }
}

// An action file's steps with its ${param}s filled in. Lower-case names are
// parameters; upper-case ${NAME}s stay environment lookups (expanded later).
export function actionSteps(file, values) {
    const text = fs.readFileSync(file, 'utf8')
    const rel = path.basename(file)
    return parse(text.replace(/\$\{([a-z][\w]*)\}/g, (_, k) => {
        if (!(k in values)) throw Object.assign(new Error(`${rel}: missing argument ${k}`), { code: 'MISSING_ARG' })
        return values[k]
    })).map((s) => ({ ...s, line: `${rel}:${s.line}` }))
}

// Everything that can fail before the first (possibly billed) step: env
// variables in type steps and action arguments, and that actions exist.
function preflight(steps, dirs, seen = new Set()) {
    for (const s of steps) {
        if (s.cmd === 'type') expand(s.arg.split(/\s*=>\s*/)[1] ?? '')
        if (s.cmd !== 'do') continue
        const { name, args } = parseDo(s.arg)
        const values = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, expand(v)]))
        const found = findAction(name, dirs)
        if (!found.block && !found.steps) throw Object.assign(new Error(`action "${name}" not found (looked in ${dirs.join(', ')})`), { code: 'NO_ACTION' })
        if (found.steps && !seen.has(name)) preflight(actionSteps(found.steps, values), dirs, new Set([...seen, name]))
    }
}
