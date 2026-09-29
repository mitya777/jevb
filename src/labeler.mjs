// Names unlabeled controls from a screenshot with Claude Haiku, for screens
// whose accessibility tree has none (an app's menu button that reads as a
// bare "Button"). Haiku sees the whole screen, so it can say what a control
// likely does ("Open navigation menu"), not just what it looks like: a local
// icon captioner (OmniParser) called the same logo "a tree or plant growth
// indicator" and Jev did worse than with no label.
//
// Off unless ANTHROPIC_API_KEY is set (env or ./.env). One call per screen
// that needs it, ~2-3k tokens; labels are cached by the controls' layout.
import fs from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'

const MODEL = process.env.JEVB_LABEL_MODEL || 'claude-haiku-4-5'
let client
const cache = new Map()

export function labelerEnabled() {
    if (!process.env.ANTHROPIC_API_KEY && fs.existsSync('.env')) {
        try { process.loadEnvFile('.env') } catch {}
    }
    return !!process.env.ANTHROPIC_API_KEY
}

// png: base64 screenshot. controls: [{ id, box: { x, y, w, h } }] as fractions
// of the screenshot (0-1), so they survive the API's image downscaling.
// Returns { labels: { id: label }, usage, ms, cached }.
export async function labelControls(png, controls, { context = '' } = {}) {
    const key = JSON.stringify(controls.map((c) => Object.values(c.box).map((v) => v.toFixed(2))))
    if (cache.has(key)) return { ...cache.get(key), cached: true }
    client ||= new Anthropic()
    const t = Date.now()
    const list = controls.map((c) => `${c.id}: x=${c.box.x.toFixed(3)} y=${c.box.y.toFixed(3)} w=${c.box.w.toFixed(3)} h=${c.box.h.toFixed(3)}`).join('\n')
    const res = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        messages: [{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
                {
                    type: 'text',
                    text: `This is a phone screen${context ? ` (${context})` : ''}. These controls have no accessible name. `
                        + 'Boxes are fractions of the image width/height from the top-left:\n'
                        + `${list}\n\n`
                        + 'For each, write a short accessible label saying what the control is and what tapping it most likely does '
                        + '(e.g. "Search", "Open navigation menu", "Compose new post"). Use the rest of the screen for context. '
                        + 'Reply with only a JSON object mapping id to label.',
                },
            ],
        }],
    })
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    const json = text.match(/\{[\s\S]*\}/)?.[0]
    let labels = {}
    try { labels = JSON.parse(json) } catch {}
    const out = { labels, usage: res.usage, ms: Date.now() - t }
    cache.set(key, out)
    return out
}
