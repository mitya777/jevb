// Localhost JSON daemon so separate CLI calls (e.g. from Claude Code / Codex)
// share one browser and its sessions. The CLI starts it on demand; it exits
// on its own after JEVB_DAEMON_IDLE_MS without requests.
import http from 'node:http'
import { JevBrowser } from './browser.mjs'
import { JevDevice } from './device.mjs'
import { listDevices } from './devicefarm.mjs'

export const PORT = Number(process.env.JEVB_PORT || 7788)
const DAEMON_IDLE_MS = Number(process.env.JEVB_DAEMON_IDLE_MS || 15 * 60_000)

const ACTIONS = {
    status: (b, a, d) => ({ ...b.status(), devices: d.status().devices, deviceIdleMs: d.idleMs }),
    devices: async (b, a) => (await listDevices({ platform: a.platform })).map((x) => `${x.name} · ${x.platform} ${x.os} · ${x.availability}`),
    open: (b, a) => b.open(a.url, a),
    act: (b, a) => b.act(a.intent, a),
    type: (b, a) => b.type(a.intent, a.text, a),
    press: (b, a) => b.press(a.key, a),
    launch: (b, a) => { if (!b.launch) throw new Error('launch needs a device session'); return b.launch(a.app, a) },
    scroll: (b, a) => b.scroll(a.dy, a),
    check: (b, a) => b.check(a.question, a),
    checks: (b, a) => b.checks(a.checks || [], a),
    snap: (b, a) => b.snap(a),
    shot: (b, a) => b.screenshot(a.path, a),
    close: (b, a) => b.close(a),
    pace: (b, a, d) => { if (a.pace) b.pace = d.pace = a.pace; return { pace: b.pace } },
}

// A session opened with --device/--app lives on a phone; everything else is
// Chromium. Later commands go wherever their session lives.
const onDevice = (d, name, a) => (name === 'open' ? !!(a.device || a.app || a.platform) || d.has(a.session) : d.has(a.session))

export function serve() {
    const log = (m) => console.log(new Date().toISOString(), m)
    const browser = new JevBrowser({ log })
    const device = new JevDevice({ log })
    const shutdownAll = (reason) => Promise.all([browser.shutdown(reason), device.shutdown(reason)])
    let exitTimer
    const armExit = () => {
        clearTimeout(exitTimer)
        exitTimer = setTimeout(async () => { await shutdownAll('daemon idle'); process.exit(0) }, DAEMON_IDLE_MS)
    }
    const server = http.createServer(async (req, res) => {
        armExit()
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
        const name = req.url.slice(1)
        if (req.method !== 'POST' || !(name in ACTIONS || name === 'stop')) return send(404, { error: `unknown action ${name}` })
        let body = ''
        for await (const chunk of req) body += chunk
        try {
            const args = body ? JSON.parse(body) : {}
            if (name === 'stop') {
                send(200, { stopped: true })
                await shutdownAll('stop')
                return process.exit(0)
            }
            const useDevice = !['status', 'devices', 'pace'].includes(name) && onDevice(device, name, args)
            send(200, await ACTIONS[name](useDevice ? device : browser, args, device))
        } catch (e) {
            send(500, { error: e.message, code: e.code, detail: e.detail, checks: e.checks })
        }
    })
    server.listen(PORT, '127.0.0.1', () => console.log(`jevb daemon on 127.0.0.1:${PORT} (pace ${browser.pace}, browser starts on demand)`))
    armExit()
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await shutdownAll(sig); process.exit(0) })
}
