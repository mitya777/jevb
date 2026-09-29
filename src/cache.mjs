// Replay cache: Jev's answers from earlier runs, so a repeat run skips them.
//
// Picks: an intent on a page maps to the fingerprint of the element Jev
// chose (its snapshot description minus position). On the next run, if
// exactly one element on screen has that fingerprint it is used without
// asking Jev: about the cost of a snapshot instead of a 0.5–1.4s Jev call. No
// match, or several (a feed of identical "Reply" buttons), falls back to Jev,
// and its new pick replaces the old one. Works the same for Chromium, mobile
// web and native app snapshots, since all three describe elements the same way.
//
// Checks: a check's noul is saved under a hash of the question plus the exact
// state Jev judged (visible text, fields). Same screen, same answer; any
// change to the screen is a miss. Only hashes are stored, never page text.
//
// File: JEVB_CACHE (default .jevb/cache.json in the working directory;
// "off" disables). It holds UI labels and hashes only, so it can be
// committed and let CI replay without Jev calls.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MAX_CHECKS = 5_000
const MAX_FPS = 4 // fingerprints kept per page+intent (screens sharing a path)

// Stable part of a snapshot description: role, label and attributes, without
// where it is or what a field currently holds.
export const fingerprint = (desc) => desc
    .replace(/ at -?\d+,-?\d+$/, '')
    .replace(/ (offscreen|selected)\b/g, '')
    .replace(/ value="[^"]*"/, '')
    .trim()

// Ids, hashes and numbers in a path are one page, not many (/t/123 = /t/456).
export function pageKey(url) {
    if (!url) return ''
    try {
        const u = new URL(url)
        const path = u.pathname.split('/').map((seg) => (/^(\d+|[0-9a-f-]{16,}|[A-Za-z0-9_-]{20,})$/i.test(seg) ? ':id' : seg)).join('/')
        return u.protocol === 'file:' ? `file:${path}` : `${u.host}${path}`
    } catch {
        return url
    }
}

const at = (desc) => desc?.match(/ at (-?\d+),(-?\d+)$/)?.slice(1).map(Number)

export class ReplayCache {
    constructor(file) {
        this.file = file
        this.data = { picks: {}, checks: {} }
        this.dirty = { picks: new Set(), checks: new Set() }
        this.secrets = new Set() // values that must never be written (see scenario.mjs)
        this.hits = { picks: 0, checks: 0 }
        try { Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8'))) } catch {}
    }

    static fromEnv(setting = process.env.JEVB_CACHE) {
        if (['off', '0', 'false', 'none'].includes(String(setting).toLowerCase())) return null
        return new ReplayCache(path.resolve(setting || '.jevb/cache.json'))
    }

    leaks(text) {
        for (const v of this.secrets) if (text.includes(v)) return true
        return false
    }

    // The element to use for `intent`, from this screen's elements, or null.
    pick(page, intent, elements) {
        const entries = this.data.picks[`${page} ${intent}`]
        if (!entries) return null
        for (const e of entries) {
            const matches = elements.filter((el) => fingerprint(el.desc) === e.fp)
            let el = matches.length === 1 ? matches[0] : null
            // "the first Reply button": topmost/bottommost of the identical ones.
            if (matches.length > 1 && e.ordinal) {
                const y = (m) => at(m.desc)?.[1] ?? 0
                el = [...matches].sort((a, b) => (e.ordinal === 'first' ? y(a) - y(b) : y(b) - y(a)))[0]
            }
            if (el) {
                this.hits.picks++
                return { el, entry: e }
            }
        }
        return null
    }

    rememberPick(page, intent, target, elements) {
        const fp = fingerprint(target.desc || '')
        const key = `${page} ${intent}`
        if (!fp || this.leaks(key) || this.leaks(fp)) return
        // Only a pick replay can find again unambiguously: a unique element,
        // or "the first/last X" that really is the topmost/bottommost X.
        const same = elements.filter((el) => fingerprint(el.desc) === fp)
        let ordinal = target.ordinal
        if (!ordinal && same.length > 1) {
            const word = /\b(first|top(most)?)\b/i.test(intent) ? 'first' : /\b(last|bottom(most)?)\b/i.test(intent) ? 'last' : null
            const ys = same.map((el) => at(el.desc)?.[1] ?? 0), y = at(target.desc)?.[1]
            if (word && y === (word === 'first' ? Math.min(...ys) : Math.max(...ys))) ordinal = word
        }
        if (!ordinal && same.length !== 1) return
        const entry = { fp, confidence: target.confidence, ...(ordinal && { ordinal }) }
        const old = this.data.picks[key] || []
        if (old[0]?.fp === fp && old[0]?.ordinal === ordinal) return
        this.data.picks[key] = [entry, ...old.filter((e) => e.fp !== fp)].slice(0, MAX_FPS)
        this.dirty.picks.add(key)
    }

    checkKey(question, state) {
        return crypto.createHash('sha256').update(`${question}\n${JSON.stringify(state)}`).digest('base64url').slice(0, 22)
    }

    check(key) {
        const noul = this.data.checks[key]
        if (noul !== undefined) this.hits.checks++
        return noul
    }

    rememberCheck(key, noul) {
        delete this.data.checks[key] // re-insert: insertion order = recency for trimming
        this.data.checks[key] = noul
        this.dirty.checks.add(key)
    }

    // Merge into whatever is on disk (another run may have written since we
    // loaded), then replace the file atomically.
    save() {
        if (!this.dirty.picks.size && !this.dirty.checks.size) return
        let disk = { picks: {}, checks: {} }
        try { disk = { ...disk, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) } } catch {}
        for (const k of this.dirty.picks) disk.picks[k] = this.data.picks[k]
        for (const k of this.dirty.checks) { delete disk.checks[k]; disk.checks[k] = this.data.checks[k] }
        const keys = Object.keys(disk.checks)
        for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CHECKS))) delete disk.checks[k]
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const tmp = `${this.file}.${process.pid}.tmp`
        fs.writeFileSync(tmp, `${JSON.stringify(disk, null, 1)}\n`)
        fs.renameSync(tmp, this.file)
        this.dirty.picks.clear()
        this.dirty.checks.clear()
    }
}
