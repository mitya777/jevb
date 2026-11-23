// QA movie of one tab: Chrome's screencast (frames as the tab repaints) to an
// MP4 with ffmpeg. Playwright's own video only records contexts it created,
// and a handed-over tab lives in the user's profile, so this works on any
// attached tab (and on jevb's own).
//
// Dead time is trimmed, and the step log says how: everything before the
// first step is dropped (the opening frame is the screen as step 1 starts),
// and no frame is held longer than maxHoldMs, so waits for a page or a model
// shrink to a beat. The last frame (the DONE/FAILED banner) is held tailMs.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const FPS = 30

export class ScreencastRecorder {
    constructor(page, { dir, maxWidth = 1280, maxHeight = 1280, quality = 80 } = {}) {
        Object.assign(this, { page, dir, maxWidth, maxHeight, quality })
        this.frames = [] // { file, t (ms since epoch) }
        this.cdp = null
    }

    async start() {
        fs.mkdirSync(this.dir, { recursive: true })
        this.cdp = await this.page.context().newCDPSession(this.page)
        this.cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
            const file = path.join(this.dir, `f${String(this.frames.length).padStart(6, '0')}.jpg`)
            fs.writeFileSync(file, Buffer.from(data, 'base64'))
            // Arrival time, on the same clock as the step log.
            this.frames.push({ file, t: Date.now() })
            this.cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
        })
        await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.quality, maxWidth: this.maxWidth, maxHeight: this.maxHeight, everyNthFrame: 1 })
        // Chrome paints only the tab showing in its window. No first frame
        // soon means the tab is behind another one.
        for (let i = 0; i < 30 && !this.frames.length; i++) await new Promise((r) => setTimeout(r, 100))
        if (!this.frames.length) {
            await this.stop()
            throw Object.assign(new Error('the tab sent no picture: Chrome only paints the tab that is showing in its window. Switch that window to the tab (it needn\'t be in front) and run again'), { code: 'TAB_HIDDEN' })
        }
    }

    async stop() {
        const cdp = this.cdp
        this.cdp = null
        if (!cdp) return
        await cdp.send('Page.stopScreencast').catch(() => {})
        await cdp.detach().catch(() => {})
    }
}

// Frame times -> movie: which frames to keep, how long each shows, and a map
// from wall-clock time to movie time (for the step log). Pure; tested alone.
export function compressTimeline(times, { startAt, maxHoldMs = 1200, tailMs = 2000 }) {
    let first = 0
    for (let i = 0; i < times.length; i++) if (times[i] <= startAt) first = i
    const kept = times.map((t, i) => ({ i, t: i === first ? Math.max(t, startAt) : t })).slice(first)
    const durations = kept.map((k, j) => (j + 1 < kept.length ? Math.min(kept[j + 1].t - k.t, maxHoldMs) : tailMs))
    const starts = []
    durations.reduce((acc, d, j) => { starts[j] = acc; return acc + d }, 0)
    const at = (T) => {
        if (T <= kept[0].t) return 0
        let j = kept.length - 1
        while (j > 0 && kept[j].t > T) j--
        return starts[j] + Math.min(T - kept[j].t, durations[j])
    }
    return { frames: kept.map((k) => k.i), durations, totalMs: durations.reduce((a, b) => a + b, 0), at }
}

// Width and height from a JPEG's SOF marker.
export function jpegSize(buf) {
    let o = 2
    while (o < buf.length) {
        if (buf[o] !== 0xff) { o++; continue }
        const m = buf[o + 1]
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) }
        o += 2 + buf.readUInt16BE(o + 2)
    }
    throw new Error('not a JPEG')
}

export async function hasFfmpeg() {
    try { await run('ffmpeg', ['-hide_banner', '-version']); return true } catch { return false }
}

// Encode the kept frames to an H.264 MP4 (plays everywhere, including in a
// browser and on a phone). Returns the timeline used.
export async function makeMovie(frames, out, { startAt, maxHoldMs, tailMs } = {}) {
    if (!frames.length) throw new Error('no frames recorded')
    const tl = compressTimeline(frames.map((f) => f.t), { startAt: startAt ?? frames[0].t, maxHoldMs, tailMs })
    const files = tl.frames.map((i) => frames[i].file)
    const { width, height } = jpegSize(fs.readFileSync(files[0]))
    const W = width - (width % 2), H = height - (height % 2)
    const esc = (f) => `'${path.resolve(f).replace(/'/g, "'\\''")}'`
    // The concat demuxer drops the last entry's duration; a closing copy of
    // the last frame with a token duration carries it, and -t cuts at the end.
    const list = files.map((f, j) => `file ${esc(f)}\nduration ${(tl.durations[j] / 1000).toFixed(3)}`).join('\n') + `\nfile ${esc(files.at(-1))}\nduration 0.040\n`
    const listFile = path.join(path.dirname(files[0]), 'frames.txt')
    fs.writeFileSync(listFile, list)
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease:out_range=tv,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=white,fps=${FPS},format=yuv420p`, '-t', (tl.totalMs / 1000).toFixed(3),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart', '-an', out], { maxBuffer: 16 << 20 })
    return { ...tl, width: W, height: H }
}
