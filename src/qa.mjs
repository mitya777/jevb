// `jevb qa`: a QA movie of a running app, in a tab the user handed over, with
// a proof that binds the user's prompt to the movie.
//
//   jevb tabs                                   the user picks one
//   jevb qa run flow.jevb --tab ID --prompt prompt.txt --out qa/ --recording-ok
//   jevb qa verify qa/ [--chain]
//   jevb qa anchor qa/ --broadcast             a real BSV anchor (needs JEVB_BSV_WIF)
//
// The bundle folder holds prompt.txt (the exact prompt bytes), the scenario,
// qa.mp4, steps.json, manifest.json and anchor.json.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as bsv from './bsv.mjs'
import { HandoverBrowser, lintScenario, listTabs } from './handover.mjs'
import { buildManifest, manifestHash, verify } from './proof.mjs'
import { ScreencastRecorder, hasFfmpeg, makeMovie } from './recorder.mjs'
import { parse, runScenario } from './scenario.mjs'
import { version } from './update.mjs'

export const RECORDING_NOTICE = 'The movie records everything shown in the handed-over tab while the steps run, including any personal or account data on those pages. It is saved on this computer; only hashes leave it, and only when anchored.'

export const bundlePaths = (dir) => ({
    prompt: path.join(dir, 'prompt.txt'), movie: path.join(dir, 'qa.mp4'), steps: path.join(dir, 'steps.json'),
    manifest: path.join(dir, 'manifest.json'), anchor: path.join(dir, 'anchor.json'),
})

export async function runQa({ scenario, tabId, prompt, out, cdpUrl = process.env.JEVB_CDP_URL, client = {}, pace = 'human',
    recordingOk = false, publishPrompt = false, broadcast = false, maxHoldMs = 1200, onStep = () => {} }) {
    if (!recordingOk) throw Object.assign(new Error(`tell the user first, then pass --recording-ok once they agree: ${RECORDING_NOTICE}`), { code: 'NEEDS_CONSENT' })
    if (!await hasFfmpeg()) throw new Error('ffmpeg is not installed (brew install ffmpeg / apt install ffmpeg)')
    const promptBytes = fs.readFileSync(prompt)
    if (!promptBytes.length) throw new Error('the prompt file is empty')
    const refused = lintScenario(parse(fs.readFileSync(scenario, 'utf8')))
    if (refused.length) throw Object.assign(new Error(`refused before running: ${refused.map((r) => `line ${r.line}: ${r.why}`).join('; ')}`), { code: 'REFUSED', detail: refused })
    const tabs = await listTabs(cdpUrl)
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) throw Object.assign(new Error(`no open tab ${tabId}; jevb tabs lists them`), { code: 'TAB_NOT_FOUND' })

    fs.mkdirSync(out, { recursive: true })
    const files = bundlePaths(out)
    const scenarioCopy = path.join(out, path.basename(scenario))
    if (path.resolve(scenario) !== path.resolve(scenarioCopy)) fs.copyFileSync(scenario, scenarioCopy)
    if (path.resolve(prompt) !== path.resolve(files.prompt)) fs.writeFileSync(files.prompt, promptBytes)

    const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-qa-frames-'))
    const b = new HandoverBrowser({ tabId, cdpUrl, pace, idleMs: 30 * 60_000, log: (m) => onStep({ log: m }) })
    const steps = []
    let run, recorder, startAt
    const startedAt = new Date().toISOString()
    try {
        const page = await b.page()
        recorder = new ScreencastRecorder(page, { dir: frameDir })
        await recorder.start()
        b.beforeDetach = () => recorder.stop()
        startAt = Date.now()
        run = await runScenario(scenarioCopy, {
            browser: b, pace, record: false,
            onStep: (r) => { if (r.step || r.line) steps.push({ ...r, endedAt: Date.now() }); onStep(r) },
        })
    } finally {
        await b.shutdown('qa done').catch(() => {}) // a no-op if the run already handed it back
    }
    const finishedAt = new Date().toISOString()

    const tl = await makeMovie(recorder.frames, files.movie, { startAt, maxHoldMs })
    const log = {
        scenario: path.basename(scenarioCopy),
        timeline: `trimmed: starts as step 1 begins; no still frame held over ${maxHoldMs}ms; ${tl.totalMs}ms long`,
        passed: run.failed === 0,
        failed: run.failed,
        steps: steps.map(({ endedAt, ms = 0, ...r }) => ({
            ...r,
            ok: !r.error && r.pass !== false,
            movieAt: +(tl.at(endedAt - ms) / 1000).toFixed(2),
            ms,
        })),
    }
    fs.writeFileSync(files.steps, JSON.stringify(log, null, 2) + '\n')
    fs.rmSync(frameDir, { recursive: true, force: true })

    const manifest = buildManifest({
        prompt: promptBytes, movie: files.movie, steps: files.steps, scenario: scenarioCopy, client,
        recorder: { tool: 'jevb', version: version() }, app: { origin: new URL(tab.url).origin },
        result: { passed: log.passed, failed: run.failed, steps: log.steps.length }, timeline: log.timeline, startedAt, finishedAt,
    })
    fs.writeFileSync(files.manifest, JSON.stringify(manifest, null, 2) + '\n')
    const anchor = await anchorBundle(out, { publishPrompt, broadcast })
    return { out: path.resolve(out), movie: path.resolve(files.movie), passed: log.passed, failed: run.failed, steps: log.steps.length, movieSeconds: +(tl.totalMs / 1000).toFixed(1), manifestHash: manifestHash(manifest), anchor: { dryRun: anchor.dryRun, txid: anchor.txid }, handedBack: tabId }
}

export async function anchorBundle(dir, { publishPrompt = false, broadcast = false } = {}) {
    const files = bundlePaths(dir)
    const manifest = JSON.parse(fs.readFileSync(files.manifest, 'utf8'))
    const prompt = publishPrompt ? fs.readFileSync(files.prompt, 'utf8') : undefined
    const anchor = { manifestHash: manifestHash(manifest), ...(await bsv.anchor(Buffer.from(manifestHash(manifest), 'hex'), { prompt, broadcast })) }
    fs.writeFileSync(files.anchor, JSON.stringify(anchor, null, 2) + '\n')
    return anchor
}

// A bundle folder, or explicit files (a verifier may have them apart).
export function verifyBundle({ dir, prompt, movie, manifest, anchor, steps, chain = false }) {
    const f = dir ? bundlePaths(dir) : {}
    const pick = (given, def) => given || (def && fs.existsSync(def) ? def : undefined)
    return verify({ prompt: pick(prompt, f.prompt), movie: pick(movie, f.movie), steps: pick(steps, f.steps), manifest: pick(manifest, f.manifest), anchor: pick(anchor, f.anchor), chain })
}
