// `jevb setup`: make an install usable and say exactly what's missing.
// Built for coding agents: one command after `npm install -g`, JSON out,
// exit 0 only when jevb can drive a browser and reach Jev. It installs the
// headless Chromium if it's missing; it never writes keys or config.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { apiKey, ask } from './jev.mjs'
import { version } from './update.mjs'

const require = createRequire(import.meta.url)

async function launches() {
    const b = await chromium.launch({ headless: true })
    await b.close()
}

function installChromium() {
    const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js')
    execFileSync(process.execPath, [cli, 'install', 'chromium-headless-shell'], { stdio: ['ignore', 'ignore', 'inherit'] })
}

export async function setup({ install = true } = {}) {
    if (fs.existsSync('.env')) { try { process.loadEnvFile('.env') } catch {} }
    const checks = []
    const add = (name, ok, detail, fix) => checks.push({ name, ok, ...(detail && { detail }), ...(!ok && fix && { fix }) })

    const major = Number(process.versions.node.split('.')[0])
    add('node', major >= 22, `v${process.versions.node}`, 'install Node.js 22 or newer')

    if (process.env.JEVB_CDP_URL) {
        add('browser', true, `attaches to Chrome at ${process.env.JEVB_CDP_URL} (JEVB_CDP_URL)`)
    } else {
        let err = null
        try { await launches() } catch (e) { err = e }
        if (err && /Executable doesn't exist/.test(err.message) && install) {
            try { installChromium(); await launches(); err = null } catch (e) { err = e }
            add('browser', !err, err ? err.message.split('\n')[0] : 'headless Chromium installed and launches', 'npx playwright-core install chromium-headless-shell')
        } else {
            add('browser', !err, err ? err.message.split('\n')[0] : 'headless Chromium launches', 'npx playwright-core install chromium-headless-shell')
        }
    }

    let key = null
    try { key = apiKey() } catch {}
    if (!key) add('jev', false, 'TYPESAFEAI_API_KEY is not set', 'create a key at https://console.typesafe.ai/keys, then export TYPESAFEAI_API_KEY=... or put it in ./.env')
    else {
        const t = Date.now()
        try {
            // Any well-formed answer proves the key and endpoint work.
            const { answers } = await ask({ viewport_text: 'ping' }, { ok: { type: 'noul', instructions: 'Is the text the word "ping"?' } }, { retries: 1 })
            add('jev', typeof answers?.ok?.noul === 'number', `answered in ${Date.now() - t}ms`, 'Jev answered in an unexpected shape; check JEV_MODEL')
        } catch (e) {
            add('jev', false, e.message.slice(0, 160), /401|403/.test(e.message) ? 'the key was rejected: create a new one at https://console.typesafe.ai/keys' : 'check network access to api.typesafe.ai')
        }
    }

    // Optional extras: reported, never required.
    const optional = [
        ['phones (AWS Device Farm)', !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.JEVB_AWS_PROFILE || fs.existsSync(path.join(process.env.HOME || '', '.aws/credentials'))), 'AWS credentials with AWSDeviceFarmFullAccess (see README: Real phones)'],
        ['phones (local Appium)', !!process.env.JEVB_APPIUM_URL, 'set JEVB_APPIUM_URL=http://127.0.0.1:4723 for a simulator, emulator or USB phone'],
        ['unlabeled-control naming (Claude)', !!process.env.ANTHROPIC_API_KEY, 'set ANTHROPIC_API_KEY to name unlabeled controls in native apps'],
    ].map(([name, ok, hint]) => ({ name, ok, ...(!ok && { hint }) }))

    return { ok: checks.every((c) => c.ok), version: version(), checks, optional }
}
