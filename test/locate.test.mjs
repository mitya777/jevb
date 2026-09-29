import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

// A PNG header is all locateControl reads (for the pixel size).
function pngHeader(w, h) {
    const b = Buffer.alloc(33)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).copy(b)
    b.write('IHDR', 12)
    b.writeUInt32BE(w, 16)
    b.writeUInt32BE(h, 20)
    return b.toString('base64')
}

test('a control missing from the tree is tapped where Claude points on the screenshot', async () => {
    let seen
    const server = http.createServer(async (req, res) => {
        let body = ''
        for await (const c of req) body += c
        seen = JSON.parse(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
            id: 'msg_1', type: 'message', role: 'assistant', model: seen.model, stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 6400, output_tokens: 40 },
            content: [{ type: 'tool_use', id: 'tu_1', name: 'left_click', toolset_name: 'computer', input: { coordinate: [45, 150] } }],
        }))
    }).listen(0)
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const { JevDevice } = await import('../src/device.mjs')
    try {
        // Android: screenshot px == screen units; iOS would be 3x.
        const s = { webContext: null, platform: 'ios', screen: { w: 390, h: 844 }, wd: { screenshot: async () => pngHeader(1170, 2532) } }
        const found = await new JevDevice().locateVisually(s, 'open the sidebar menu')
        assert.equal(seen.tools[0].type, 'computer_toolset_20260801')
        assert.equal(seen.model, 'claude-sonnet-5')
        assert.match(seen.messages[0].content[0].text, /open the sidebar menu/)
        assert.deepEqual([found.el.x, found.el.y], [15, 50], 'screenshot pixels scaled to screen points')
        assert.equal(found.target.visual, true)

        // A point inside a tree element taps that element (exact bounds).
        const snap = { elements: [
            { id: 'e1', desc: 'image "Image" at 6,40', x: 22, y: 56, rect: { x: 6, y: 40, w: 32, h: 32 } },
            { id: 'e2', desc: 'other "Header" at 0,30', x: 195, y: 60, rect: { x: 0, y: 30, w: 390, h: 60 } },
        ] }
        const snapped = await new JevDevice().locateVisually(s, 'open the sidebar menu', snap)
        assert.equal(snapped.el.id, 'e1', 'the smallest element containing the point')
    } finally {
        server.close()
    }
})
