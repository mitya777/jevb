// The QA proof: a manifest that binds the exact prompt text to the exact
// movie file (and the scenario that ran, and its step log), and a check that
// the manifest's hash is the one committed in a BSV transaction.
//
// What it proves: this prompt text and this movie file (byte for byte) were
// bound together in this manifest no later than the transaction's block time,
// and none of them has changed since.
// What it does not prove: that the movie is an honest, unedited capture of
// the app, that the scenario faithfully follows the prompt, or which model
// wrote the steps. The client's tool and model are recorded as the client
// reported them, unverified.
import fs from 'node:fs'
import path from 'node:path'
import * as bsv from './bsv.mjs'

export const KIND = 'jevb-qa-proof'
export const hashFile = (file) => bsv.sha256(fs.readFileSync(file)).toString('hex')
export const hashText = (text) => bsv.sha256(Buffer.from(text, 'utf8')).toString('hex')

// JSON with sorted keys and no whitespace: the manifest's hash doesn't depend
// on how the file is formatted, only on what it says.
export function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    return JSON.stringify(v)
}
export const manifestHash = (m) => bsv.sha256(Buffer.from(canonical(m))).toString('hex')

// prompt: the exact text (a Buffer or string); files by path. Names are
// stored relative so a bundle can move as a folder.
export function buildManifest({ prompt, movie, steps, scenario, client = {}, recorder, app, result, startedAt, finishedAt, timeline }) {
    const promptBuf = Buffer.isBuffer(prompt) ? prompt : Buffer.from(prompt, 'utf8')
    const scenarioText = fs.readFileSync(scenario, 'utf8')
    return {
        kind: KIND,
        v: 1,
        prompt: { sha256: bsv.sha256(promptBuf).toString('hex'), bytes: promptBuf.length },
        movie: { name: path.basename(movie), sha256: hashFile(movie), bytes: fs.statSync(movie).size, ...(timeline && { timeline }) },
        ...(steps && { steps: { name: path.basename(steps), sha256: hashFile(steps) } }),
        scenario: { name: path.basename(scenario), sha256: hashText(scenarioText), text: scenarioText },
        client: { tool: client.tool || null, model: client.model || null, reportedBy: 'client, not verified' },
        recorder,
        ...(app && { app }),
        ...(result && { result }),
        startedAt, finishedAt,
    }
}

// Checks prompt + movie (+ step log, if given) against the manifest, and the
// manifest against the anchor transaction. chain: also fetch the transaction
// from the network and read its block time (needs a broadcast anchor).
export async function verify({ prompt, movie, steps, manifest, anchor, chain = false, fetchTx = bsv.fetchTxHex, fetchInfo = bsv.fetchTxInfo }) {
    const checks = []
    const add = (name, pass, detail) => { checks.push({ name, pass, ...(detail && { detail }) }); return pass }
    const m = typeof manifest === 'string' ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : manifest
    add('manifest is a jevb QA proof', m.kind === KIND && m.v === 1)
    const promptBuf = Buffer.isBuffer(prompt) ? prompt : fs.readFileSync(prompt)
    add('prompt matches manifest', bsv.sha256(promptBuf).toString('hex') === m.prompt?.sha256, `sha256 ${bsv.sha256(promptBuf).toString('hex')}`)
    add('movie matches manifest', hashFile(movie) === m.movie?.sha256, `sha256 ${hashFile(movie)}`)
    if (steps) add('step log matches manifest', hashFile(steps) === m.steps?.sha256)
    if (m.scenario) add('scenario text matches its hash', hashText(m.scenario.text) === m.scenario.sha256)
    const id = manifestHash(m)
    const result = { ok: false, manifestHash: id, checks }
    const a = typeof anchor === 'string' ? JSON.parse(fs.readFileSync(anchor, 'utf8')) : anchor
    if (!a) { add('anchor given', false, 'no anchor record: nothing ties the manifest to a time'); return finish(result) }
    const raw = Buffer.from(a.rawtx || '', 'hex')
    let found = null
    try {
        add('transaction id matches its bytes', bsv.txid(raw) === a.txid, a.txid)
        found = bsv.findAnchor(raw)
    } catch (e) { add('transaction parses', false, e.message) }
    add('transaction commits to this manifest', found?.hash === id, found ? `committed ${found.hash}` : 'no jevb.qa output')
    if (found?.prompt != null) add('published prompt matches', found.prompt === promptBuf.toString('utf8'))
    result.txid = a.txid
    result.dryRun = !!a.dryRun
    if (a.dryRun) {
        result.onchain = 'dry run: the transaction was built and signed but never broadcast, so it establishes no time'
    } else if (chain) {
        try {
            const hex = String(await fetchTx(a.txid)).trim()
            add('transaction is on chain with the same bytes', hex === a.rawtx)
            const info = await fetchInfo(a.txid)
            if (info?.blocktime) {
                result.anchoredAt = new Date(info.blocktime * 1000).toISOString()
                result.confirmations = info.confirmations
                result.onchain = `mined in block ${info.blockhash}; bound no later than ${result.anchoredAt}`
            } else result.onchain = 'in the mempool, not mined yet: no block time to bind to'
        } catch (e) { add('transaction found on chain', false, e.message) }
    } else result.onchain = 'not looked up (pass --chain to fetch the transaction and its block time)'
    return finish(result)
}

const finish = (r) => ({ ...r, ok: r.checks.every((c) => c.pass) })
