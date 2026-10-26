import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JevDevice } from '../src/device.mjs'

// A login form on an Android phone: the keyboard opened by Email covers
// Password, so a tap on Password lands on the keyboard until it is closed.
const email = { x: 56, y: 752, width: 608, height: 82 }
const password = { x: 56, y: 922, width: 608, height: 82 }
const passwordEl = { id: 'e5', role: 'textbox', label: 'Password', desc: 'textbox "Password" at 360,963', x: 360, y: 963, rect: { x: 56, y: 922, w: 608, h: 82 } }

function fakePhone({ tapFocusesWithKeyboard }) {
    const state = { focused: 'email', keyboard: true, taps: 0, hides: 0 }
    const rects = { email, password }
    const wd = {
        s: (p) => p,
        activeElement: async () => state.focused,
        actions: async () => {
            state.taps++
            if (!state.keyboard || tapFocusesWithKeyboard) state.focused = 'password'
            state.keyboard = true
        },
        execute: async (cmd) => { if (cmd === 'mobile: hideKeyboard') { state.hides++; state.keyboard = false } },
        req: async (method, path) => {
            if (path === '/appium/device/is_keyboard_shown') return state.keyboard
            const m = path.match(/^\/element\/(\w+)\/rect$/)
            if (m) return rects[m[1]]
            const pw = path.match(/^\/element\/(\w+)\/attribute\/password$/)
            if (pw) return String(pw[1] === 'password')
            throw new Error(`unexpected ${method} ${path}`)
        },
    }
    return { state, s: { platform: 'android', screen: { w: 720, h: 1600 }, wd } }
}

test('a tap that leaves focus on another field closes the keyboard and taps again', async () => {
    const { state, s } = fakePhone({ tapFocusesWithKeyboard: false })
    const dev = new JevDevice()
    dev.log = () => {}
    await dev.tap(s, passwordEl, 'agent')
    assert.equal(state.focused, 'email')
    const field = await dev.focusedTarget(s, passwordEl, 'agent', true, 'email')
    assert.equal(field, 'password')
    assert.equal(state.hides, 1)
    assert.equal(state.taps, 2)
})

test('a field the tap never focuses is an error, not text in the wrong field', async () => {
    const { state, s } = fakePhone({ tapFocusesWithKeyboard: false })
    s.wd.actions = async () => { state.taps++ } // taps never move focus
    const dev = new JevDevice()
    dev.log = () => {}
    await assert.rejects(dev.focusedTarget(s, passwordEl, 'agent', true, 'email'), /didn't focus it/)
})

test('a tap that focuses the target types right away', async () => {
    const { state, s } = fakePhone({ tapFocusesWithKeyboard: true })
    const dev = new JevDevice()
    await dev.tap(s, passwordEl, 'agent')
    assert.equal(await dev.focusedTarget(s, passwordEl, 'agent', true, 'email'), 'password')
    assert.equal(state.hides, 0)
})

test('focus that moved to a field the WebView scrolled up still counts', async () => {
    const { state, s } = fakePhone({ tapFocusesWithKeyboard: true })
    const dev = new JevDevice()
    await dev.tap(s, passwordEl, 'agent')
    password.y = 472 // scrolled into view above the keyboard
    try {
        assert.equal(await dev.focusedTarget(s, passwordEl, 'agent', true, 'email'), 'password')
        assert.equal(state.hides, 0)
    } finally { password.y = 922 }
})

test('a password field is not typed into unless it says it is one', async () => {
    const { s } = fakePhone({ tapFocusesWithKeyboard: true })
    s.wd.activeElement = async () => 'email'
    const dev = new JevDevice()
    dev.log = () => {}
    await assert.rejects(dev.focusedTarget(s, passwordEl, 'agent', true, 'name'), /didn't focus it/)
})

test('a password is not typed when focus cannot be confirmed', async () => {
    const blind = () => {
        const phone = fakePhone({ tapFocusesWithKeyboard: true })
        phone.s.wd.req = async () => { throw new Error('no rect') }
        return phone.s
    }
    const dev = new JevDevice()
    dev.log = () => {}
    assert.equal(await dev.focusedTarget(blind(), passwordEl, 'agent', true, 'email'), null)
    // Not a password: the old behaviour, type into whatever has focus.
    assert.equal(await dev.focusedTarget(blind(), { ...passwordEl, label: 'Email' }, 'agent', false, 'email'), 'password')
})
