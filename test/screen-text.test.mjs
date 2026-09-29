import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { PNG } from 'pngjs'

// A fake Anthropic API that "reads" the screenshot as the text we choose.
async function fakeReader(text) {
    const server = http.createServer(async (req, res) => {
        for await (const _ of req);
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1500, output_tokens: 80 }, content: [{ type: 'text', text }] }))
    }).listen(0)
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`
    process.env.ANTHROPIC_API_KEY = 'test-key'
    return server
}
const png = () => { const p = new PNG({ width: 4, height: 4 }); p.data.fill(200); return PNG.sync.write(p).toString('base64') }

test('checks judge the screenshot text; a tree that no longer matches the screen offers no taps', async () => {
    const server = await fakeReader('HOME\nPublic Following\nPrince_Hans\nJust discovered Treechat today')
    const { JevDevice } = await import('../src/device.mjs')
    try {
        const d = new JevDevice()
        const s = { platform: 'android', screen: { w: 1008, h: 2244 }, wd: { screenshot: async () => png() } }
        // The tree still holds the previous page (Channels) while the feed shows.
        const stale = { elements: [{ id: 'e3', desc: 'clickable "Following" at 504,426' }],
            state: { viewport_text: "Channels Discover Following My Channels You haven't joined any channels yet", fields: [] } }
        const out = await d.withScreenText(s, stale)
        assert.match(out.state.viewport_text, /Prince_Hans/)
        assert.equal(out.state.from_screenshot, true)
        assert.deepEqual(out.elements, [], 'stale tree elements are not offered')

        // A tree that matches the screen keeps its elements.
        const fresh = { elements: [{ id: 'e1', desc: 'clickable "Public" at 300,426' }],
            state: { viewport_text: 'HOME Public Following Prince_Hans Just discovered Treechat', fields: [] } }
        assert.equal((await d.withScreenText(s, fresh)).elements.length, 1)

        process.env.JEVB_SCREEN_TEXT = 'off'
        assert.equal((await d.withScreenText(s, stale)).state.viewport_text, stale.state.viewport_text)
    } finally {
        delete process.env.JEVB_SCREEN_TEXT
        server.close()
    }
})
