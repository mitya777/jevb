// Notices when an agent drives jevb one CLI call at a time through steps
// that could have been one `jevb run`. Plain bookkeeping in the daemon: no
// Jev call, nothing added to any step's wait. Each successful action in a
// session joins a run; a gap over gapMs starts a new one. At minRun steps,
// and every `every` steps after, the reply carries a hint with the run as a
// draft .jevb scenario. Typed text never goes in the draft (it may be a
// password); it becomes a ${TEXT_n} placeholder to fill from the env.

const checkLine = (c) => `${c.negate ? 'refute' : 'check'}${c.threshold != null ? `@${c.threshold}` : ''} ${c.question}`

// The scenario lines one daemon action stands for, or null if it isn't a step.
export function stepLines(name, a, nextText) {
    const checks = (a.checks || []).map(checkLine)
    switch (name) {
        case 'open': return [...(a.device ? [`device ${a.device}`] : []), ...(a.app ? [`app ${a.app}`] : []), a.url ? `open ${a.url}` : 'open']
        case 'act': return [...checks, `act ${a.intent}`]
        case 'type': return [...checks, `type ${a.intent} => \${${nextText()}}`, ...(a.submit ? ['press Enter'] : [])]
        case 'press': return [`press ${a.key}`]
        case 'scroll': return [`scroll ${a.dy ?? 600}`]
        case 'check': return [checkLine(a)]
        case 'checks': return checks
        case 'read': return [a.question ? `read ${a.question}` : null].filter(Boolean)
        case 'shot': return [`shot ${a.path}`]
        default: return null
    }
}

export class Watch {
    constructor({ minRun = 3, every = 5, gapMs = 60_000, now = Date.now } = {}) {
        Object.assign(this, { minRun, every, gapMs, now })
        this.runs = new Map() // session -> { steps, lines, texts, at }
    }

    // Call after an action succeeds. Returns a hint object or null.
    record(name, a = {}) {
        const key = a.session || 'default'
        // Steps a scenario can't replay end the run: a draft that skipped
        // an eval's setup wouldn't reproduce what worked.
        if (['eval', 'launch', 'close'].includes(name)) { this.runs.delete(key); return null }
        let run = this.runs.get(key)
        const t = this.now()
        if (!run || t - run.at > this.gapMs) run = { steps: 0, lines: [], texts: 0 }
        run.at = t
        this.runs.set(key, run)
        const lines = stepLines(name, a, () => `TEXT_${++run.texts}`)
        if (!lines?.length) return null
        run.steps++
        run.lines.push(...lines)
        const due = run.steps === this.minRun || (run.steps > this.minRun && (run.steps - this.minRun) % this.every === 0)
        if (!due) return null
        return {
            scriptable: `the last ${run.steps} steps could be one \`jevb run\` (one call instead of ${run.steps})`,
            scenario: run.lines.join('\n'),
            ...(run.texts && { env: `set ${Array.from({ length: run.texts }, (_, i) => `TEXT_${i + 1}`).join(', ')} in the env or ./.env` }),
        }
    }
}
