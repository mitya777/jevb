import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

import { PNG } from 'pngjs'

// A blank screenshot of the given size (locateControl decodes and shrinks it).
function blankPng(w, h) {
    const png = new PNG({ width: w, height: h })
    png.data.fill(255)
    return PNG.sync.write(png).toString('base64')
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
        const s = { webContext: null, platform: 'ios', screen: { w: 390, h: 844 }, wd: { screenshot: async () => blankPng(1170, 2532) } }
        const found = await new JevDevice().locateVisually(s, 'open the sidebar menu')
        assert.equal(seen.tools[0].type, 'computer_toolset_20260801')
        assert.equal(seen.model, 'claude-sonnet-5')
        assert.match(seen.messages[0].content[0].text, /open the sidebar menu/)
        const sent = PNG.sync.read(Buffer.from(seen.messages[0].content[1].source.data, 'base64'))
        assert.equal(sent.width, 585, 'shrunk to <= 720 wide (1170 / 2)')
        assert.deepEqual([found.el.x, found.el.y], [30, 100], 'click in the shrunk image -> screenshot px -> screen points')
        assert.equal(found.target.visual, true)

        // A point inside a tree element taps that element (exact bounds).
        const snap = { elements: [
            { id: 'e1', desc: 'image "Image" at 14,86', x: 30, y: 102, rect: { x: 14, y: 86, w: 32, h: 32 } },
            { id: 'e2', desc: 'other "Header" at 0,30', x: 195, y: 60, rect: { x: 0, y: 30, w: 390, h: 60 } },
        ] }
        const snapped = await new JevDevice().locateVisually(s, 'open the sidebar menu', snap)
        assert.equal(snapped.el.id, 'e1', 'the smallest element containing the point')

        // A big element that merely contains the point (a composer box under
        // an open sidebar) is not the pointed-at control: tap the point.
        const behind = { elements: [{ id: 'e16', desc: 'textbox "Market" at 12,60', x: 195, y: 100, rect: { x: 12, y: 60, w: 366, h: 80 } }] }
        const notSnapped = await new JevDevice().locateVisually(s, 'open the Channels page', behind)
        assert.equal(notSnapped.el.id, 'visual')
        assert.deepEqual([notSnapped.el.x, notSnapped.el.y], [30, 100])
    } finally {
        server.close()
    }
})
