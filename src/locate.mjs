// Finds a control on a screenshot when the accessibility tree has no
// confident match: an unnamed control, or one missing from the tree (a
// clickable div with no role). Uses Claude with the computer-use toolset.
// Off unless ANTHROPIC_API_KEY is set (env or ./.env).
import fs from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'

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
    const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)]
    // Coordinates are in the screenshot's pixels only if it isn't downscaled:
    // stay within the image limits (2576px long edge, 3.75MP). Phone
    // screenshots seen so far fit (Pixel 1008x2244, iPhone 1170x2532).
    if (Math.max(w, h) > 2576 || w * h > 3.75e6) return null
    const t = Date.now()
    const res = await client.messages.create({
        model: LOCATE_MODEL,
        max_tokens: 1024,
        tools: [{ type: 'computer_toolset_20260801' }],
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: `This is the current phone screen (${w}x${h}). Tap the control a user should tap to: "${intent}". Use one click and no screenshot. If nothing on screen does that, reply "none" without clicking.` },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
            ],
        }],
    })
    const call = res.content.find((b) => b.type === 'tool_use' && /click|tap/.test(b.name))
    const [x, y] = call?.input?.coordinate || []
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > w || y > h) return null
    return { x, y, width: w, height: h, ms: Date.now() - t, usage: res.usage }
}
