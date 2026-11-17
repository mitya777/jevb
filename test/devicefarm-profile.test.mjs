// Which AWS profile Device Farm calls use: JEVB_AWS_PROFILE, else a profile
// named "jevb" defined in either AWS file, else none (the standard chain).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { awsProfile } from '../src/devicefarm.mjs'

function home(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-aws-'))
    fs.mkdirSync(path.join(dir, '.aws'))
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, '.aws', name), text)
    return dir
}

test('JEVB_AWS_PROFILE wins over a jevb profile in the files', () => {
    assert.equal(awsProfile({ JEVB_AWS_PROFILE: 'other' }, home({ credentials: '[jevb]\n' })), 'other')
})

test('a [jevb] section in ~/.aws/credentials selects the jevb profile', () => {
    assert.equal(awsProfile({}, home({ credentials: '[default]\nx = 1\n[jevb]\naws_access_key_id = A\n' })), 'jevb')
})

test('a [profile jevb] section in ~/.aws/config alone selects the jevb profile', () => {
    assert.equal(awsProfile({}, home({ config: '[default]\nregion = us-west-2\n[profile jevb]\ncredential_process = /bin/true\n' })), 'jevb')
})

test('no jevb profile anywhere leaves the standard AWS chain', () => {
    assert.equal(awsProfile({}, home({ config: '[profile jevb-other]\n[jevb]\n', credentials: '[default]\n' })), undefined)
    assert.equal(awsProfile({}, fs.mkdtempSync(path.join(os.tmpdir(), 'jevb-aws-'))), undefined)
})
