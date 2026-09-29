// Finds a control on a screenshot when the accessibility tree has no
// confident match: an unnamed control, or one missing from the tree (a
// clickable div with no role). Uses Claude with the computer-use toolset.
// Off unless ANTHROPIC_API_KEY is set (env or ./.env).
import fs from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { PNG } from 'pngjs'

let client

export function locateEnabled() {
    if (!process.env.ANTHROPIC_API_KEY && fs.existsSync('.env')) {
        try { process.loadEnvFile('.env') } catch {}
    }
    return !!process.env.ANTHROPIC_API_KEY
}

// Last resort for a control the accessibility tree doesn't contain at all
// (a clickable div with no role - Treechat's menu button in its Android app):
// ask Claude where to tap, with the computer-use toolset, whose click
// coordinates are trained to be accurate. Plain "give me x,y" prompting was
// off by 100px+ (2 of 4 hits for Haiku and Sonnet); Sonnet 5 with the
// toolset hit 4 of 5, including that menu button. Haiku 4.5 doesn't support
// computer use. Returns { x, y, ms, usage } in screenshot pixels, or null.
const LOCATE_MODEL = process.env.JEVB_LOCATE_MODEL || 'claude-sonnet-5'
export async function locateControl(png, intent) {
    client ||= new Anthropic()
    const buf = Buffer.from(png, 'base64')
    const [W, H] = [buf.readUInt32BE(16), buf.readUInt32BE(20)]
    // Shrink to <= 720px wide first. At a Pixel's full 1008x2240, Sonnet's
    // clicks drifted 250px+ vertically and changed between identical calls
    // (Home at y=1874, then 1930; it's at 2132); at 720 or 504 wide every
    // click landed on the right row. Coordinates are scaled back.
    const k = Math.ceil(W / 720)
    const small = k > 1 ? shrink(buf, k) : { png, width: W, height: H }
    const [w, h] = [small.width, small.height]
    const t = Date.now()
    const res = await client.messages.create({
        model: LOCATE_MODEL,
        max_tokens: 1024,
        tools: [{ type: 'computer_toolset_20260801' }],
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: `This is the current phone screen (${w}x${h}). Tap the control a user should tap to: "${intent}". Use one click and no screenshot. If nothing on screen does that, reply "none" without clicking.` },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: small.png } },
            ],
        }],
    })
    const call = res.content.find((b) => b.type === 'tool_use' && /click|tap/.test(b.name))
    const [x, y] = call?.input?.coordinate || []
    const ms = Date.now() - t
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > w || y > h) {
        // Say why, so a miss isn't silent: a text answer ("none") or another tool.
        const said = res.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_use' ? `[${b.name}]` : '')).join(' ').trim()
        return { none: true, said: said.slice(0, 160), ms, usage: res.usage }
    }
    return { x: x * k, y: y * k, width: W, height: H, ms, usage: res.usage }
}

// Downscale a PNG by an integer factor (box average): no image library beyond
// pngjs, and a phone screenshot takes a few tens of ms.
function shrink(buf, k) {
    const src = PNG.sync.read(buf)
    const out = new PNG({ width: Math.floor(src.width / k), height: Math.floor(src.height / k) })
    for (let y = 0; y < out.height; y++) {
        for (let x = 0; x < out.width; x++) {
            const sum = [0, 0, 0, 0]
            for (let dy = 0; dy < k; dy++) {
                for (let dx = 0; dx < k; dx++) {
                    const i = ((y * k + dy) * src.width + (x * k + dx)) * 4
                    for (let c = 0; c < 4; c++) sum[c] += src.data[i + c]
                }
            }
            const o = (y * out.width + x) * 4
            for (let c = 0; c < 4; c++) out.data[o + c] = Math.round(sum[c] / (k * k))
        }
    }
    return { png: PNG.sync.write(out).toString('base64'), width: out.width, height: out.height }
}
