import assert from 'node:assert/strict'
import { test } from 'node:test'

test('text cut mid-emoji is repaired before it reaches Jev', async () => {
    process.env.TYPESAFEAI_API_KEY ||= 'test-key'
    const { ask } = await import('../src/jev.mjs')
    const realFetch = globalThis.fetch
    let sent
    globalThis.fetch = async (url, opts) => {
        sent = opts.body
        return new Response(JSON.stringify({ answers: {}, usage: {} }), { status: 200 })
    }
    try {
        const cut = 'Nice pic 😀'.slice(0, 10) // ends on a lone high surrogate
        assert.equal(cut.isWellFormed(), false)
        await ask({ viewport_text: cut }, { q: { type: 'noul', instructions: cut } })
        assert.equal(JSON.parse(sent).state.viewport_text.isWellFormed(), true)
        assert.doesNotMatch(sent, /\\ud83d/i)
    } finally {
        globalThis.fetch = realFetch
    }
})
