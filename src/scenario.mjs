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
// Exit code is non-zero if any check fails or any step throws.
import fs from 'node:fs'
import path from 'node:path'
import { JevBrowser } from './browser.mjs'

export function parse(text) {
    return text.split('\n').map((raw, i) => ({ raw, line: i + 1 }))
        .map((s) => ({ ...s, src: s.raw.replace(/\s+#.*$/, '').trim() }))
        .filter((s) => s.src && !s.src.startsWith('#'))
        .map((s) => {
            const m = s.src.match(/^(\w+)(?:@([\d.]+))?\s*(.*)$/)
            return { ...s, cmd: m[1], threshold: m[2] ? Number(m[2]) : undefined, arg: m[3] }
        })
}

export async function runScenario(file, { pace, baseUrl, onStep = console.log } = {}) {
    const steps = parse(fs.readFileSync(file, 'utf8'))
    const b = new JevBrowser({ pace, idleMs: 10 * 60_000 })
    const results = []
    let failed = 0
    try {
        for (const s of steps) {
            const t = Date.now()
            let out
            try {
                switch (s.cmd) {
                    case 'pace': b.pace = s.arg; out = { pace: s.arg }; break
                    case 'open': out = await b.open(baseUrl ? new URL(s.arg, baseUrl).href : s.arg); break
                    case 'act': out = await b.act(s.arg); break
                    case 'type': {
                        const [intent, text] = s.arg.split(/\s*=>\s*/)
                        out = await b.type(intent, text ?? '')
                        break
                    }
                    case 'press': out = await b.press(s.arg); break
                    case 'scroll': out = await b.scroll(s.arg || 600); break
                    case 'wait': await new Promise((r) => setTimeout(r, Number(s.arg))); out = {}; break
                    case 'check':
                    case 'refute':
                        out = await b.check(s.arg, { threshold: s.threshold, negate: s.cmd === 'refute' })
                        if (!out.pass) failed++
                        break
                    case 'shot': fs.mkdirSync(path.dirname(s.arg), { recursive: true }); out = await b.screenshot(s.arg); break
                    default: throw new Error(`unknown step "${s.cmd}"`)
                }
            } catch (e) {
                failed++
                out = { error: e.message, detail: e.detail }
            }
            const r = { line: s.line, step: s.src, ms: Date.now() - t, ...out }
            results.push(r)
            onStep(r)
            if (out.error) break // later steps depend on page state; stop at first error
        }
    } finally {
        await b.shutdown('scenario done')
    }
    return { failed, results }
}
