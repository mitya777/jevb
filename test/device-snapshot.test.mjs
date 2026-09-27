import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deviceSnapshot, parseXml } from '../src/device-snapshot.mjs'

const ANDROID = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2400">
  <android.widget.FrameLayout index="0" package="com.treechat" class="android.widget.FrameLayout" text="" clickable="false" enabled="true" displayed="true" bounds="[0,0][1080,2400]">
    <android.view.ViewGroup index="0" class="android.view.ViewGroup" text="" content-desc="" clickable="true" enabled="true" displayed="true" bounds="[40,200][1040,320]">
      <android.widget.TextView index="0" class="android.widget.TextView" text="Log in &amp; explore" clickable="false" enabled="true" displayed="true" bounds="[60,220][600,300]" />
    </android.view.ViewGroup>
    <android.widget.EditText index="1" class="android.widget.EditText" text="" hint="Email" resource-id="com.treechat:id/email" clickable="true" enabled="true" password="false" displayed="true" bounds="[40,400][1040,500]" />
    <android.widget.EditText index="2" class="android.widget.EditText" text="hunter2" hint="Password" clickable="true" enabled="true" password="true" displayed="true" bounds="[40,520][1040,620]" />
    <android.widget.Button index="3" class="android.widget.Button" text="" content-desc="Settings" clickable="true" enabled="true" displayed="true" bounds="[900,40][1040,160]" />
    <android.widget.Button index="4" class="android.widget.Button" text="Offscreen" clickable="true" enabled="true" displayed="true" bounds="[40,2600][1040,2700]" />
    <android.widget.Button index="5" class="android.widget.Button" text="Hidden" clickable="true" enabled="true" displayed="false" bounds="[40,700][1040,800]" />
  </android.widget.FrameLayout>
</hierarchy>`

const IOS = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Treechat" label="Treechat" enabled="true" visible="true" accessible="false" x="0" y="0" width="393" height="852" index="0">
    <XCUIElementTypeOther type="XCUIElementTypeOther" name="New thread" label="New thread" enabled="true" visible="true" accessible="true" x="300" y="760" width="60" height="60" index="0"/>
    <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="Hot threads" name="Hot threads" label="Hot threads" enabled="true" visible="true" accessible="true" x="16" y="100" width="200" height="24" index="1"/>
    <XCUIElementTypeTextField type="XCUIElementTypeTextField" value="hello" name="Reply" label="Reply" placeholderValue="Write a reply" enabled="true" visible="true" accessible="true" x="16" y="600" width="361" height="44" index="2"/>
    <XCUIElementTypeImage type="XCUIElementTypeImage" name="decor" enabled="true" visible="true" accessible="false" x="0" y="0" width="393" height="80" index="3"/>
    <XCUIElementTypeKeyboard type="XCUIElementTypeKeyboard" enabled="true" visible="true" accessible="false" x="0" y="560" width="393" height="292" index="4">
      <XCUIElementTypeKey type="XCUIElementTypeKey" name="q" label="q" enabled="true" visible="true" accessible="true" x="3" y="600" width="37" height="42" index="0"/>
    </XCUIElementTypeKeyboard>
  </XCUIElementTypeApplication>
</AppiumAUT>`

const IOS_ALERT = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Treechat" enabled="true" visible="true" accessible="false" x="0" y="0" width="393" height="852">
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="Post" label="Post" enabled="true" visible="true" accessible="true" x="16" y="100" width="80" height="44"/>
    <XCUIElementTypeAlert type="XCUIElementTypeAlert" name="Allow notifications?" label="Allow notifications?" enabled="true" visible="true" accessible="false" x="60" y="300" width="270" height="200">
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="Allow notifications?" name="Allow notifications?" label="Allow notifications?" enabled="true" visible="true" accessible="true" x="80" y="320" width="230" height="22"/>
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="Allow" label="Allow" enabled="true" visible="true" accessible="true" x="60" y="450" width="135" height="44"/>
    </XCUIElementTypeAlert>
  </XCUIElementTypeApplication>
</AppiumAUT>`

test('parseXml builds a tree and unescapes attributes', () => {
    const root = parseXml('<a x="1 &amp; 2"><b/><c y="&#x41;"></c></a>')
    const a = root.children[0]
    assert.equal(a.attrs.x, '1 & 2')
    assert.deepEqual(a.children.map((c) => c.tag), ['b', 'c'])
    assert.equal(a.children[1].attrs.y, 'A')
})

test('android: clickable containers take their inner text, fields and state', () => {
    const { platform, elements, state } = deviceSnapshot(ANDROID, { w: 1080, h: 2400 })
    assert.equal(platform, 'android')
    assert.deepEqual(elements.map((e) => e.label), ['Log in & explore', 'Email', 'Password', 'Settings'])
    const [row, email, pw, settings] = elements
    assert.equal(row.role, 'clickable')
    assert.deepEqual([row.x, row.y], [540, 260])
    assert.equal(email.role, 'textbox')
    assert.match(settings.desc, /^button "Settings"/)
    assert.ok(!pw.desc.includes('hunter2'), 'password value never reaches Jev')
    assert.deepEqual(state.fields, [{ label: 'Email', value: '' }, { label: 'Password', value: '(filled)' }])
    assert.match(state.viewport_text, /Log in & explore/)
    assert.doesNotMatch(state.viewport_text, /Offscreen|Hidden/)
})

test('ios: accessible Other is tappable, keyboard keys and decorative images are not', () => {
    const { platform, elements, state } = deviceSnapshot(IOS, { w: 393, h: 852 })
    assert.equal(platform, 'ios')
    assert.deepEqual(elements.map((e) => e.label), ['New thread', 'Reply'])
    assert.match(elements[1].desc, /textbox "Reply" hint="Write a reply" value="hello"/)
    assert.equal(state.keyboard_open, true)
    assert.match(state.viewport_text, /Hot threads/)
    assert.match(state.viewport_text, /New thread/, 'button labels are visible text too')
    assert.deepEqual(state.fields, [{ label: 'Reply', value: 'hello' }])
})

test('ios: an alert is the only thing shown and tappable', () => {
    const { elements, state } = deviceSnapshot(IOS_ALERT, { w: 393, h: 852 })
    assert.equal(state.modal_open, true)
    assert.deepEqual(elements.map((e) => e.label), ['Allow'])
    assert.equal(state.viewport_text, 'Allow notifications?\nAllow')
})

const ANDROID_WEBFORM = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <android.webkit.WebView class="android.webkit.WebView" text="" clickable="false" enabled="true" displayed="true" bounds="[0,0][1008,2244]">
    <android.widget.TextView class="android.widget.TextView" text="Username" clickable="false" enabled="true" displayed="true" bounds="[68,560][230,610]" />
    <android.widget.EditText class="android.widget.EditText" text="" clickable="true" enabled="true" password="false" displayed="true" bounds="[68,625][940,720]" />
    <android.widget.TextView class="android.widget.TextView" text="Email" clickable="false" enabled="true" displayed="true" bounds="[68,760][200,810]" />
    <android.widget.EditText class="android.widget.EditText" text="" clickable="true" enabled="true" password="false" displayed="true" bounds="[68,820][940,915]" />
  </android.webkit.WebView>
</hierarchy>`

test('unlabeled web inputs borrow the text just above them', () => {
    const { elements, state } = deviceSnapshot(ANDROID_WEBFORM, { w: 1008, h: 2244 })
    assert.deepEqual(elements.map((e) => e.label), ['Username', 'Email'])
    assert.deepEqual(state.fields.map((f) => f.label), ['Username', 'Email'])
})

test('ios: an empty field reporting its placeholder as value is empty', () => {
    const xml = `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="393" height="852">
      <XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField" name="SecureTextField" value="8 character minimum" placeholderValue="8 character minimum" enabled="true" visible="true" accessible="true" x="16" y="300" width="361" height="44"/>
    </XCUIElementTypeApplication></AppiumAUT>`
    const { state } = deviceSnapshot(xml, { w: 393, h: 852 })
    assert.deepEqual(state.fields, [{ label: '8 character minimum', value: '(empty)' }])
})
