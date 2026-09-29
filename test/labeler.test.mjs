import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { deviceSnapshot } from '../src/device-snapshot.mjs'

// A fake Anthropic API: checks what jevb sends and answers with labels.
test('unlabeled native controls are named by Haiku from a screenshot', async () => {
    let seen
    const server = http.createServer(async (req, res) => {
        let body = ''
        for await (const c of req) body += c
        seen = JSON.parse(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
            id: 'msg_1', type: 'message', role: 'assistant', model: seen.model, stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1500, output_tokens: 30 },
            content: [{ type: 'text', text: '{"e1": "Open navigation menu", "e3": "Search"}' }],
        }))
    }).listen(0)
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const { JevDevice } = await import('../src/device.mjs')
    try {
        const xml = `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="390" height="844">
          <XCUIElementTypeButton type="XCUIElementTypeButton" name="Button" enabled="true" visible="true" accessible="true" x="6" y="50" width="32" height="32"/>
          <XCUIElementTypeButton type="XCUIElementTypeButton" name="Post" label="Post" enabled="true" visible="true" accessible="true" x="300" y="250" width="60" height="30"/>
          <XCUIElementTypeButton type="XCUIElementTypeButton" name="Button" enabled="true" visible="true" accessible="true" x="340" y="50" width="30" height="30"/>
        </XCUIElementTypeApplication></AppiumAUT>`
        const s = { webContext: null, platform: 'ios', screen: { w: 390, h: 844 }, wd: { screenshot: async () => 'iVBORw0KGgo=' } }
        const d = new JevDevice()
        const out = await d.labelUnlabeled(s, deviceSnapshot(xml, s.screen))
        assert.equal(seen.model, 'claude-haiku-4-5')
        assert.equal(seen.messages[0].content[0].type, 'image')
        assert.match(seen.messages[0].content[1].text, /e1: x=0\.015 y=0\.059/)
        assert.doesNotMatch(seen.messages[0].content[1].text, /e2:/, 'labelled controls are not sent')
        assert.deepEqual(out.elements.map((e) => e.label), ['Open navigation menu', 'Post', 'Search'])
    } finally {
        server.close()
    }
})
