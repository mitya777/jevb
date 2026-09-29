// `jevb update` against a fake GitHub API (JEVB_GITHUB_API).
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import { after, before, beforeEach, test } from 'node:test'
import { download, latest, newer, update, version } from '../src/update.mjs'

let server, seen, release, auth
before(async () => {
    server = http.createServer((req, res) => {
        seen.push({ url: req.url, auth: req.headers.authorization, accept: req.headers.accept })
        if (auth && req.headers.authorization !== `Bearer ${auth}`) { res.writeHead(404); return res.end('{"message":"Not Found"}') }
        if (req.url === '/repos/mitya777/jevb/releases/latest') {
            res.writeHead(200, { 'content-type': 'application/json' })
            return res.end(JSON.stringify(release))
        }
        if (req.url === '/repos/mitya777/jevb/releases/assets/7' && req.headers.accept === 'application/octet-stream') {
            res.writeHead(200); return res.end('tarball-bytes')
        }
        res.writeHead(404); res.end()
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    process.env.JEVB_GITHUB_API = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())
beforeEach(() => {
    seen = []; auth = null
    process.env.GH_TOKEN = ''; process.env.GITHUB_TOKEN = ''; process.env.PATH = '/nonexistent' // no `gh` token either
    release = {
        tag_name: 'v99.0.0', html_url: 'https://github.com/mitya777/jevb/releases/tag/v99.0.0',
        assets: [{ name: 'notes.txt', url: 'x' }, { name: 'jevb-99.0.0.tgz', url: `${process.env.JEVB_GITHUB_API}/repos/mitya777/jevb/releases/assets/7` }],
    }
})

test('newer: numeric semver, release beats its pre-release', () => {
    assert.equal(newer('1.10.0', '1.9.3'), true)
    assert.equal(newer('v0.2.0', '0.1.9'), true)
    assert.equal(newer('0.1.0', '0.1.0'), false)
    assert.equal(newer('0.1.0', '0.2.0'), false)
    assert.equal(newer('1.2.0', '1.2.0-rc.1'), true)
    assert.equal(newer('1.2.0-rc.1', '1.2.0'), false)
})

test('latest: finds the release tarball among the assets', async () => {
    const rel = await latest()
    assert.equal(rel.version, '99.0.0')
    assert.equal(rel.asset.name, 'jevb-99.0.0.tgz')
})

test('download: asks for the asset bytes', async () => {
    const file = await download((await latest()).asset)
    assert.equal(fs.readFileSync(file, 'utf8'), 'tarball-bytes')
    assert.equal(seen.at(-1).accept, 'application/octet-stream')
})

test('check reports an available update without installing', async () => {
    const res = await update({ check: true })
    assert.deepEqual(res, { current: version(), latest: '99.0.0', available: true, release: release.html_url })
    assert.equal(seen.length, 1, 'check downloaded something')
})

test('already current: nothing to do', async () => {
    release.tag_name = `v${version()}`
    const res = await update()
    assert.equal(res.available, false)
    assert.equal(res.updated, undefined)
})

test('a git checkout is told to git pull, not given a second global install', async () => {
    const res = await update()
    assert.equal(res.updated, false)
    assert.match(res.reason, /git checkout: run `git pull && npm install`/)
    assert.equal(seen.length, 1, 'downloaded despite the checkout')
})

test('private repo: token from GH_TOKEN; without one, the error says how to log in', async () => {
    auth = 'secret-token'
    await assert.rejects(latest(), /may be private.*gh auth login.*GITHUB_TOKEN/)
    process.env.GH_TOKEN = 'secret-token'
    assert.equal((await latest()).version, '99.0.0')
    assert.equal(seen.at(-1).auth, 'Bearer secret-token')
})
