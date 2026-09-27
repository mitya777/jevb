// Minimal TypeSafe System One client. Jev answers typed questions (noul /
// choice / score) over a JSON `state` in ~100ms; code owns control flow.
import fs from 'node:fs'

const ENDPOINT = process.env.TYPESAFE_ENDPOINT || 'https://api.typesafe.ai/v1/systemone'
const MODEL = process.env.JEV_MODEL || 'jev-latest'

function apiKey() {
    if (!process.env.TYPESAFEAI_API_KEY && fs.existsSync('.env')) {
        try { process.loadEnvFile('.env') } catch {}
    }
    const key = process.env.TYPESAFEAI_API_KEY || process.env.TYPESAFE_API_KEY
    if (!key) throw new Error('TYPESAFEAI_API_KEY is not set (env or ./.env)')
    return key
}

export async function ask(state, questions, { retries = 4 } = {}) {
    const body = JSON.stringify({ model: MODEL, state, questions })
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(ENDPOINT, {
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
