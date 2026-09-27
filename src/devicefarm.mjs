// AWS Device Farm provisioning: pick a real device, upload the app, start a
// metered remote access session and hand back its managed Appium endpoint.
// Billing is per device-minute from when the device is allocated until the
// session stops, so callers must stop() promptly (the device backend does on
// close, idle and daemon exit). Device Farm only runs in us-west-2.
//
// Credentials: profile "jevb" if present (see profile()), else the standard
// AWS chain (AWS_PROFILE, AWS_ACCESS_KEY_ID/…, ~/.aws). Project: JEVB_DF_PROJECT_ARN, else a project named "jevb"
// (created on first use).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    CreateProjectCommand, CreateRemoteAccessSessionCommand, CreateUploadCommand, DeviceFarmClient,
    GetRemoteAccessSessionCommand, GetUploadCommand, ListDevicesCommand, ListProjectsCommand,
    StopRemoteAccessSessionCommand,
} from '@aws-sdk/client-device-farm'

const PROJECT_NAME = 'jevb'
let client
// A long-lived, Device-Farm-only IAM key in profile "jevb" (README) beats a
// console login that expires; JEVB_AWS_PROFILE picks another profile, and
// without either the standard chain applies (AWS_PROFILE, env keys, login).
function profile() {
    if (process.env.JEVB_AWS_PROFILE) return process.env.JEVB_AWS_PROFILE
    const creds = path.join(os.homedir(), '.aws', 'credentials')
    try { if (/^\[jevb\]\s*$/m.test(fs.readFileSync(creds, 'utf8'))) return 'jevb' } catch {}
    return undefined
}
const df = () => (client ||= new DeviceFarmClient({ region: 'us-west-2', profile: profile() }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function projectArn() {
    if (process.env.JEVB_DF_PROJECT_ARN) return process.env.JEVB_DF_PROJECT_ARN
    for (let nextToken; ;) {
        const res = await df().send(new ListProjectsCommand({ nextToken }))
        const p = res.projects.find((x) => x.name === PROJECT_NAME)
        if (p) return p.arn
        if (!(nextToken = res.nextToken)) break
    }
    return (await df().send(new CreateProjectCommand({ name: PROJECT_NAME }))).project.arn
}

export async function listDevices({ platform } = {}) {
    const filters = [{ attribute: 'REMOTE_ACCESS_ENABLED', operator: 'EQUALS', values: ['TRUE'] }]
    if (platform) filters.push({ attribute: 'PLATFORM', operator: 'EQUALS', values: [platform.toUpperCase()] })
    const out = []
    for (let nextToken; ;) {
        const res = await df().send(new ListDevicesCommand({ filters, nextToken }))
        out.push(...res.devices)
        if (!(nextToken = res.nextToken)) break
    }
    return out.map((d) => ({
        arn: d.arn, name: d.name, os: d.os, platform: d.platform.toLowerCase(), formFactor: d.formFactor,
        availability: d.availability,
    }))
}

const AVAIL = { HIGHLY_AVAILABLE: 3, AVAILABLE: 2, BUSY: 1, TEMPORARY_NOT_AVAILABLE: 0 }
const osNum = (v) => v.split('.').reduce((acc, x, i) => acc + Number(x || 0) / 100 ** i, 0)

// `query` matches device names case-insensitively ("pixel 8", "iPhone 15").
// Among matches: most available, then newest OS, then phones over tablets.
export async function pickDevice(query, { platform } = {}) {
    if (!platform && query) platform = /iphone|ipad|ios/i.test(query) ? 'ios' : undefined
    const all = await listDevices({ platform })
    const words = (query || '').toLowerCase().split(/\s+/).filter(Boolean)
    const matches = all.filter((d) => words.every((w) => `${d.name} ${d.platform} ${d.os}`.toLowerCase().includes(w)))
    if (!matches.length) {
        throw Object.assign(new Error(`no remote-access device matches "${query}"; try \`jevb devices\``), { code: 'NO_DEVICE' })
    }
    matches.sort((a, b) => (AVAIL[b.availability] ?? 0) - (AVAIL[a.availability] ?? 0)
        || osNum(b.os) - osNum(a.os) || (a.formFactor === 'PHONE' ? -1 : 1))
    return matches[0]
}

// Upload a local .apk/.ipa and wait until Device Farm has processed it.
export async function uploadApp(file, { project, log = () => {} } = {}) {
    const type = file.endsWith('.ipa') ? 'IOS_APP' : file.endsWith('.apk') ? 'ANDROID_APP' : null
    if (!type) throw new Error(`app must be an .apk or .ipa: ${file}`)
    const { upload } = await df().send(new CreateUploadCommand({ projectArn: project, name: path.basename(file), type }))
    const body = fs.readFileSync(file)
    const put = await fetch(upload.url, { method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream' } })
    if (!put.ok) throw new Error(`app upload failed: ${put.status} ${await put.text()}`)
    log(`uploaded ${path.basename(file)} (${(body.length / 1e6).toFixed(1)}MB), processing`)
    for (const started = Date.now(); Date.now() - started < 10 * 60_000; await sleep(2000)) {
        const u = (await df().send(new GetUploadCommand({ arn: upload.arn }))).upload
        if (u.status === 'SUCCEEDED') return u.arn
        if (u.status === 'FAILED') throw new Error(`Device Farm rejected ${path.basename(file)}: ${u.metadata || u.message || 'processing failed'}`)
    }
    throw new Error('app upload processing timed out')
}

// Start a metered remote access session; resolves once the Appium endpoint
// is live. Returns { arn, endpoint, device, stop() }.
export async function startSession({ device, platform, app, log = () => {} } = {}) {
    const project = await projectArn()
    const d = await pickDevice(device, { platform })
    let appArn
    if (app && fs.existsSync(app)) appArn = await uploadApp(app, { project, log })
    else if (app?.startsWith('arn:')) appArn = app
    log(`requesting ${d.name} (${d.platform} ${d.os}, ${d.availability})`)
    const t = Date.now()
    const { remoteAccessSession: s } = await df().send(new CreateRemoteAccessSessionCommand({
        projectArn: project, deviceArn: d.arn, name: `jevb ${new Date().toISOString()}`,
        ...(appArn && { appArn }),
        configuration: { billingMethod: 'METERED', parameters: { 'appium:version': '3' } },
    }))
    const stop = async () => {
        await df().send(new StopRemoteAccessSessionCommand({ arn: s.arn })).catch((e) => log(`stop failed: ${e.message}`))
        log(`device session stopped (${d.name})`)
    }
    try {
        let last
        for (; ;) {
            const cur = (await df().send(new GetRemoteAccessSessionCommand({ arn: s.arn }))).remoteAccessSession
            if (cur.status !== last) log(`device ${cur.status.toLowerCase()} after ${Math.round((Date.now() - t) / 1000)}s`)
            last = cur.status
            const endpoint = cur.endpoints?.remoteDriverEndpoint
            if (cur.status === 'RUNNING' && endpoint) {
                return { arn: s.arn, endpoint, device: d, startMs: Date.now() - t, stop }
            }
            if (['COMPLETED', 'STOPPING'].includes(cur.status)) {
                throw new Error(`device session ended before starting: ${cur.result || ''} ${cur.message || ''}`.trim())
            }
            if (Date.now() - t > 15 * 60_000) throw new Error('timed out waiting for a device')
            await sleep(3000)
        }
    } catch (e) {
        await stop() // never leave a metered session running behind an error
        throw e
    }
}
