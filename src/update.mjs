// `jevb update`: install the latest GitHub release of jevb. Releases carry
// the npm pack tarball (see .github/workflows/release.yml), installed with
// `npm install -g`. The repo can be private: requests authenticate with
// GH_TOKEN / GITHUB_TOKEN, or the token of a logged-in `gh`.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
export const version = () => pkg().version
const API = () => process.env.JEVB_GITHUB_API || 'https://api.github.com'
const repo = () => pkg().repository.url.match(/github\.com[/:]([^/]+\/[^/.]+)/)[1]

// 1.10.0 > 1.9.3; a pre-release (1.2.0-rc.1) sorts before its release.
export function newer(a, b) {
    const parse = (v) => v.replace(/^v/, '').split('-')
    const [[ca, pa], [cb, pb]] = [parse(a), parse(b)]
    const [x, y] = [ca.split('.').map(Number), cb.split('.').map(Number)]
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
    return !pa && !!pb
}

function token() {
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
}

async function github(url, { accept = 'application/vnd.github+json' } = {}) {
    const t = token()
    const res = await fetch(url, { headers: { Accept: accept, 'User-Agent': 'jevb', ...(t && { Authorization: `Bearer ${t}` }) } })
    if (res.status === 404 && !t) throw new Error(`no access to ${repo()} releases: it may be private. Log in with \`gh auth login\` or set GITHUB_TOKEN`)
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`)
    return res
}

export async function latest() {
    const rel = await (await github(`${API()}/repos/${repo()}/releases/latest`)).json()
    const asset = rel.assets.find((a) => /^jevb-.*\.tgz$/.test(a.name))
    if (!asset) throw new Error(`release ${rel.tag_name} has no jevb-*.tgz asset`)
    return { version: rel.tag_name.replace(/^v/, ''), url: rel.html_url, asset }
}

export async function download(asset, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-update-'))) {
    // The asset API redirects to storage; fetch drops Authorization on the
    // cross-origin hop.
    const res = await github(asset.url, { accept: 'application/octet-stream' })
    const file = path.join(dir, asset.name)
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    return file
}

// A git clone (or `npm link` to one) updates with git, not a second global install.
export const isCheckout = () => fs.existsSync(path.join(ROOT, '.git'))

export async function update({ check = false, log = console.error } = {}) {
    const current = version()
    const rel = await latest()
    const available = newer(rel.version, current)
    const status = { current, latest: rel.version, available, release: rel.url }
    if (check || !available) return status
    if (isCheckout()) return { ...status, updated: false, reason: `${ROOT} is a git checkout: run \`git pull && npm install\` there` }
    const tgz = await download(rel.asset)
    log(`installing ${rel.asset.name}`)
    execFileSync('npm', ['install', '-g', tgz], { stdio: ['ignore', 'inherit', 'inherit'] })
    // The new version may pin a newer Playwright: fetch its headless Chromium.
    const cli = path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'jevb/node_modules/playwright-core/cli.js')
    if (fs.existsSync(cli)) execFileSync(process.execPath, [cli, 'install', 'chromium-headless-shell'], { stdio: ['ignore', 'inherit', 'inherit'] })
    return { ...status, updated: true }
}
