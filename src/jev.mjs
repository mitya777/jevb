// Minimal TypeSafe System One client. Jev answers typed questions (noul /
// choice / score) over a JSON `state` in ~100ms; code owns control flow.
import fs from 'node:fs'

// Read per call, so tests can point jevb at a fake Jev (test/harness).
const endpoint = () => process.env.TYPESAFE_ENDPOINT || 'https://api.typesafe.ai/v1/systemone'
const model = () => process.env.JEV_MODEL || 'jev-latest'

export function apiKey() {
    if (!process.env.TYPESAFEAI_API_KEY && fs.existsSync('.env')) {
        try { process.loadEnvFile('.env') } catch {}
    }
    const key = process.env.TYPESAFEAI_API_KEY || process.env.TYPESAFE_API_KEY
    if (!key) throw new Error('TYPESAFEAI_API_KEY is not set (env or ./.env)')
    return key
}

export async function ask(state, questions, { retries = 4 } = {}) {
    // Screen text is cut to length (labels 100 chars, viewport 6000), and a cut
    // can split an emoji's surrogate pair; Jev rejects the lone half with
    // 400 "invalid Unicode text" (a logged-in feed did). Repair every string.
    const body = JSON.stringify({ model: model(), state, questions }, (k, v) => (typeof v === 'string' ? v.toWellFormed() : v))
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(endpoint(), {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
            body,
        })
        if (res.ok) {
            const json = await res.json()
            return { answers: json.answers, usage: json.usage, model: json.model }
        }
        // Rate limits and brief upstream outages (a 503 "upstream connect
        // error" ended a phone run mid-tour).
        if ([429, 502, 503, 504, 529].includes(res.status) && attempt < retries) {
            await new Promise((r) => setTimeout(r, 250 * 2 ** attempt + Math.random() * 100))
            continue
        }
        throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 500)}`)
    }
}
