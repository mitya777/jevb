#!/usr/bin/env node
// jevb — on-demand headless Chromium for agents, steered by Jev.
// Every command prints one JSON object; non-zero exit on error / failed check.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.JEVB_PORT || 7788)
const HERE = path.dirname(fileURLToPath(import.meta.url))

const USAGE = `jevb <command> [args] [--pace human|agent] [--session NAME]

  open <url>                       navigate (starts daemon + chromium on demand)
  act <intent...>                  Jev picks the element, then click it
  type <intent...> -- <text...>    Jev picks the field, then type text [--enter]
  press <key>                      e.g. Enter, Escape, Meta+K
  scroll [dy]                      default 600
  check <question...>              Jev noul over the page; exit 1 if < --threshold (0.7)
  refute <question...>             inverse check; exit 1 if >= --threshold (0.3)
  snap                             list interactive elements Jev chooses from
  shot <path> [--full]             screenshot
  pace [human|agent]               get/set the daemon default pace
  close                            close session (last one closes chromium)
  status | stop | serve
  run <scenario.jevb> [--base URL] run a scenario file in-process (for tests)

Pace: human (default) = curved mouse, hover dwell, per-key typing, reading
pauses. agent = as fast as possible. Env: TYPESAFEAI_API_KEY (or ./.env),
JEVB_PACE, JEVB_PORT, JEVB_IDLE_MS (chromium), JEVB_DAEMON_IDLE_MS, JEVB_HEADED=1.`

function parseArgs(argv) {
    const flags = {}, pos = []
    let rest = null
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (rest) rest.push(a)
        else if (a === '--') rest = []
        else if (a.startsWith('--')) {
            const k = a.slice(2)
            const next = argv[i + 1]
            if (['enter', 'full', 'help'].includes(k)) flags[k] = true
            else { flags[k] = next; i++ }
        } else pos.push(a)
    }
    return { flags, pos, rest }
}

async function call(action, args = {}) {
    const res = await fetch(`http://127.0.0.1:${PORT}/${action}`, { method: 'POST', body: JSON.stringify(args) })
    return { ok: res.ok, body: await res.json() }
}

async function ensureDaemon() {
    try { await call('status'); return } catch {}
    const logFile = path.join(os.tmpdir(), `jevb-${PORT}.log`)
    const out = fs.openSync(logFile, 'a')
    spawn(process.execPath, [path.join(HERE, 'jevb.mjs'), 'serve'], {
        detached: true, stdio: ['ignore', out, out], cwd: process.cwd(), env: process.env,
    }).unref()
    for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100))
        try { await call('status'); return } catch {}
    }
    throw new Error(`daemon did not start; see ${logFile}`)
}

const print = (o) => console.log(JSON.stringify(o, null, 2))

async function main() {
    const [cmd, ...argv] = process.argv.slice(2)
    const { flags, pos, rest } = parseArgs(argv)
    if (!cmd || flags.help || cmd === 'help') return console.log(USAGE)

    if (cmd === 'serve') return (await import('../src/daemon.mjs')).serve()
    if (cmd === 'run') {
        const { runScenario } = await import('../src/scenario.mjs')
        const { failed } = await runScenario(pos[0], { pace: flags.pace, baseUrl: flags.base, onStep: (r) => console.log(JSON.stringify(r)) })
        console.log(JSON.stringify({ done: true, failed }))
        process.exitCode = failed ? 1 : 0
        return
    }
    if (cmd === 'stop') {
        try { print((await call('stop')).body) } catch { print({ stopped: false, reason: 'not running' }) }
        return
    }

    const common = { session: flags.session, pace: flags.pace }
    const text = pos.join(' ')
    const args = {
        status: {}, snap: common, close: common,
        open: { ...common, url: pos[0] },
        act: { ...common, intent: text },
        type: { ...common, intent: text, text: (rest || []).join(' '), submit: !!flags.enter },
        press: { ...common, key: pos[0] },
        scroll: { ...common, dy: pos[0] },
        check: { ...common, question: text, threshold: flags.threshold },
        refute: { ...common, question: text, threshold: flags.threshold, negate: true },
        shot: { ...common, path: path.resolve(pos[0] || 'jevb.png'), fullPage: !!flags.full },
        pace: { pace: pos[0] },
    }[cmd]
    if (!args) { console.error(USAGE); process.exitCode = 2; return }

    await ensureDaemon()
    const { ok, body } = await call(cmd === 'refute' ? 'check' : cmd, args)
    print(body)
    if (!ok || (['check', 'refute'].includes(cmd) && !body.pass)) process.exitCode = 1
}

main().catch((e) => { print({ error: e.message }); process.exitCode = 1 })
