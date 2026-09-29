// Idle time counts from when the last action ENDS. Armed at the start, the
// timer closed Chromium (or released a phone) under any action that ran
// longer than idleMs: a cold launch plus a slow SPA settle, `scroll end`.
export function trackBusy(obj, methods) {
    obj.busy = 0
    for (const m of methods) {
        const fn = obj[m].bind(obj)
        obj[m] = async (...args) => {
            obj.busy++
            try { return await fn(...args) } finally { obj.busy--; obj.touch() }
        }
    }
}

export const ACTIONS = ['open', 'act', 'type', 'press', 'scroll', 'checks', 'snap', 'screenshot']
