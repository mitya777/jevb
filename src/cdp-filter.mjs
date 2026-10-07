// A CDP proxy that shows Playwright only jevb's own tabs in an attached
// browser. Playwright's connectOverCDP attaches to every tab in the profile
// and waits for each one to initialize, so one hung tab of the user's (a
// frozen renderer, a paused debugger) blocked every jevb command. Here the
// user's tabs, workers and extensions are detached as soon as Chrome
// auto-attaches them, and Playwright never hears about them.
//
// "Ours" = tabs created through this connection (Target.createTarget) and
// the popups they open. Chrome may announce a new tab before it answers
// createTarget, so while a create is in flight, messages are queued until
// the answer says whether an unknown tab is jevb's.
import { ws as WebSocket, wsServer as WebSocketServer } from 'playwright-core/lib/utilsBundle'

const OWN_ID = 1_000_000_000 // ids for the proxy's own commands; Playwright's start at 1
const TARGET_EVENTS = new Set(['Target.targetCreated', 'Target.targetInfoChanged', 'Target.targetDestroyed', 'Target.targetCrashed'])

// Resolve http://host:port to the browser's DevTools websocket URL.
export async function browserWsUrl(cdpUrl) {
    if (/^wss?:/.test(cdpUrl)) return cdpUrl
    const res = await fetch(new URL('/json/version', cdpUrl), { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`${cdpUrl}/json/version: HTTP ${res.status}`)
    return (await res.json()).webSocketDebuggerUrl
}

// Start the proxy for one client connection. Resolves to the ws:// URL to
// hand connectOverCDP; it closes when either side does.
export async function startCdpFilter(cdpUrl, { log = () => {} } = {}) {
    const upstreamUrl = await browserWsUrl(cdpUrl)
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    server.once('connection', (client) => {
        server.close()
        const upstream = new WebSocket(upstreamUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
        const filter = new CdpFilter({ toClient: (m) => client.send(m), toBrowser: (m) => upstream.send(m), log })
        const early = []
        client.on('message', (data) => (upstream.readyState === WebSocket.OPEN ? filter.fromClient(String(data)) : early.push(String(data))))
        upstream.on('open', () => { for (const m of early.splice(0)) filter.fromClient(m) })
        upstream.on('message', (data) => filter.fromBrowser(String(data)))
        const end = () => { client.close(); upstream.close() }
        client.on('close', end); upstream.on('close', end)
        client.on('error', end); upstream.on('error', (e) => { log(`cdp upstream: ${e.message}`); end() })
    })
    return `ws://127.0.0.1:${server.address().port}/`
}

// The filtering itself, transport-free so it can be tested with plain arrays.
export class CdpFilter {
    constructor({ toClient, toBrowser, log = () => {} }) {
        Object.assign(this, { toClient, toBrowser, log })
        this.ours = new Set()           // targetIds jevb may see
        this.foreign = new Set()        // sessionIds of detached tabs; drop their stragglers
        this.creates = new Set()        // session:id of Target.createTarget calls in flight
        this.queue = []                 // browser messages held while a create is in flight
        this.ownId = OWN_ID
        this.detached = 0
    }

    fromClient(raw) {
        const msg = JSON.parse(raw)
        // jevb opens tabs over a browser CDP session too, so any session counts.
        if (msg.method === 'Target.createTarget') this.creates.add(`${msg.sessionId || ''}:${msg.id}`)
        this.toBrowser(raw)
    }

    fromBrowser(raw) {
        const msg = JSON.parse(raw)
        if (msg.id >= OWN_ID) return // answers to our own detach calls
        const key = `${msg.sessionId || ''}:${msg.id}`
        if (msg.id !== undefined && this.creates.delete(key)) {
            if (msg.result?.targetId) this.ours.add(msg.result.targetId)
        }
        this.queue.push({ raw, msg })
        this.drain()
    }

    // Forward or drop queued messages in order; stop at a tab we can't place
    // yet (a create is still in flight and may be announcing it).
    drain() {
        while (this.queue.length) {
            const { raw, msg } = this.queue[0]
            const verdict = this.classify(msg)
            if (verdict === 'wait') return
            this.queue.shift()
            if (verdict === 'forward') this.toClient(raw)
        }
    }

    classify(msg) {
        if (msg.sessionId && this.foreign.has(msg.sessionId)) return 'drop'
        if (msg.sessionId || msg.id !== undefined) return 'forward' // inside our tabs, or an answer
        if (msg.method === 'Target.attachedToTarget') {
            const { sessionId, targetInfo: t, waitingForDebugger } = msg.params
            // 'browser' = a session jevb asked for (newBrowserCDPSession).
            if (t.type === 'browser' || this.ours.has(t.targetId)) return 'forward'
            if (t.openerId && this.ours.has(t.openerId)) { this.ours.add(t.targetId); return 'forward' }
            if (this.creates.size) return 'wait'
            this.detach(sessionId, waitingForDebugger)
            return 'drop'
        }
        if (msg.method === 'Target.detachedFromTarget') {
            if (this.foreign.has(msg.params.sessionId)) return 'drop'
            if (msg.params.targetId) this.ours.delete(msg.params.targetId)
            return 'forward'
        }
        if (TARGET_EVENTS.has(msg.method)) {
            const id = msg.params.targetInfo?.targetId ?? msg.params.targetId
            return this.ours.has(id) ? 'forward' : 'drop'
        }
        return 'forward' // Browser.* and other browser-level events
    }

    // Detaching is handled by the browser process, so it answers even when
    // the tab's renderer is hung. A brand-new tab is paused for us; let it run.
    detach(sessionId, waitingForDebugger) {
        this.foreign.add(sessionId)
        this.detached++
        if (waitingForDebugger) this.toBrowser(JSON.stringify({ id: this.ownId++, sessionId, method: 'Runtime.runIfWaitingForDebugger' }))
        this.toBrowser(JSON.stringify({ id: this.ownId++, method: 'Target.detachFromTarget', params: { sessionId } }))
    }
}
