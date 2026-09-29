// Device-side snapshot: parse Appium's page source (UiAutomator2 XML on
// Android, XCUITest XML on iOS) into the same shape the browser snapshot
// gives Jev: visible interactive elements with a one-line description, plus
// the visible text checks judge. Ids are per snapshot (e1, e2, ...) and map
// to a tap point, so acting never needs a second element lookup.
import { MAX_OPTIONS } from './snapshot.mjs'

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescape = (s) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m)

// Tiny XML tree parser: page source is machine-generated and well formed.
export function parseXml(xml) {
    const root = { tag: '#root', attrs: {}, children: [] }
    const stack = [root]
    const re = /<(\/?)([\w.:$-]+)((?:\s+[\w.:-]+="[^"]*")*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->/g
    for (let m; (m = re.exec(xml));) {
        if (!m[2]) continue
        if (m[1]) { stack.length > 1 && stack.pop(); continue }
        const attrs = {}
        for (const a of m[3].matchAll(/([\w.:-]+)="([^"]*)"/g)) attrs[a[1]] = unescape(a[2])
        const node = { tag: m[2], attrs, children: [], parent: stack.at(-1) }
        stack.at(-1).children.push(node)
        if (!m[4]) stack.push(node)
    }
    return root
}

function* walk(node) {
    for (const c of node.children) { yield c; yield* walk(c) }
}

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()

// Normalize one node to { platform, type, label, text, rect, visible, ... }.
function android(n) {
    const a = n.attrs
    const b = a.bounds?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/)
    const rect = b ? { x: +b[1], y: +b[2], w: b[3] - b[1], h: b[4] - b[2] } : null
    const cls = a.class || n.tag
    const type = cls.split('.').pop()
    const editable = /EditText|AutoCompleteTextView/.test(type)
    return {
        type, rect, editable,
        text: clean(a.text), desc: clean(a['content-desc']), hint: clean(a.hint),
        id: (a['resource-id'] || '').split('/').pop(),
        password: a.password === 'true',
        enabled: a.enabled !== 'false',
        visible: a.displayed !== 'false',
        interactive: a.clickable === 'true' || a['long-clickable'] === 'true' || a.checkable === 'true' || editable,
        checked: a.checkable === 'true' ? a.checked === 'true' : undefined,
        selected: a.selected === 'true',
        dialog: false,
    }
}

const IOS_CONTROLS = new Set(['Button', 'Link', 'TextField', 'SecureTextField', 'TextView', 'SearchField', 'Switch', 'Toggle',
    'Cell', 'Tab', 'SegmentedControl', 'Slider', 'Stepper', 'PickerWheel', 'MenuItem', 'CheckBox', 'RadioButton', 'Image'])
function ios(n) {
    const a = n.attrs
    const type = (a.type || n.tag).replace(/^XCUIElementType/, '')
    const editable = /TextField|TextView|SearchField/.test(type)
    const rect = a.width ? { x: +a.x, y: +a.y, w: +a.width, h: +a.height } : null
    // Image is only a control when it's accessible (an icon button in RN
    // renders as an accessible Image/Other); plain decorative images are not.
    const accessible = a.accessible === 'true'
    return {
        type, rect, editable,
        // An empty iOS field reports its placeholder as its value.
        text: a.value === a.placeholderValue ? '' : clean(a.value), desc: clean(a.label || a.name), hint: clean(a.placeholderValue),
        id: '',
        password: type === 'SecureTextField',
        enabled: a.enabled !== 'false',
        visible: a.visible !== 'false',
        interactive: (IOS_CONTROLS.has(type) && (type !== 'Image' || accessible)) || (type === 'Other' && accessible && !!(a.label || a.name)),
        checked: type === 'Switch' || type === 'Toggle' ? a.value === '1' : undefined,
        selected: a.selected === 'true',
        dialog: type === 'Alert' || type === 'Sheet',
        keyboard: type === 'Keyboard',
        statictext: type === 'StaticText',
    }
}

const ROLE = {
    Button: 'button', ImageButton: 'button', Link: 'link', EditText: 'textbox', TextField: 'textbox', TextView: 'textbox',
    SecureTextField: 'password', SearchField: 'searchbox', Switch: 'switch', Toggle: 'switch', CheckBox: 'checkbox',
    RadioButton: 'radio', Tab: 'tab', Cell: 'cell', SegmentedControl: 'segmented', Slider: 'slider', Image: 'image', ImageView: 'image',
}

// Label a container with no text of its own by the text inside it (an RN
// Pressable around a <Text>, an Android ViewGroup row).
function innerText(node, norm, max = 100) {
    let out = ''
    for (const c of walk(node)) {
        const d = norm(c)
        const t = d.editable ? d.desc : d.desc || d.text
        if (t && !out.includes(t)) out += (out ? ' ' : '') + t
        if (out.length >= max) break
    }
    return out.slice(0, max)
}

// The closest text ending just above a field and overlapping it horizontally.
function nearbyLabel(texts, r) {
    for (let i = texts.length - 1; i >= 0; i--) {
        const t = texts[i].rect
        if (!t) continue
        const gap = r.y - (t.y + t.h)
        if (gap < -4 || gap > r.h * 1.5) continue
        if (t.x + t.w < r.x || t.x > r.x + r.w) continue
        if (texts[i].t.length <= 40) return texts[i].t
    }
    return ''
}

export function platformOf(xml) {
    return /XCUIElementType/.test(xml.slice(0, 2000)) ? 'ios' : 'android'
}

// screen: { w, h } in the same units as the source (points on iOS, px on Android).
export function deviceSnapshot(xml, screen) {
    const platform = platformOf(xml)
    const norm = platform === 'ios' ? ios : android
    const root = parseXml(xml)
    const inView = (r) => r && r.w >= 2 && r.h >= 2 && r.x + r.w > 0 && r.y + r.h > 0 && r.x < screen.w && r.y < screen.h
    const elements = []
    const texts = []
    const fields = []
    let dialog = null, keyboard = false
    let n = 0
    for (const node of walk(root)) {
        const d = norm(node)
        if (!d.visible || !inView(d.rect)) continue
        if (d.keyboard) { keyboard = true; continue }
        if (d.dialog && !dialog) dialog = node
        // Keyboard keys are noise for "which element": typing goes through `type`.
        let p = node.parent, inKeyboard = false
        for (; p; p = p.parent) if (platform === 'ios' && /Keyboard$/.test(p.attrs.type || p.tag)) { inKeyboard = true; break }
        if (inKeyboard) continue

        // Field contents are reported in `fields` (passwords masked), never as text.
        // XCUITest names unlabeled web inputs after their type ("TextField").
        if (d.desc === d.type) d.desc = ''
        const own = d.editable ? d.desc : d.desc || d.text
        // Web forms label inputs with text just above them, not an accessible
        // name (a sign-up form in an app's WebView): borrow that text.
        const near = d.editable && !d.desc && nearbyLabel(texts, d.rect)
        if (own && !/^(Vertical|Horizontal) scroll bar, \d+ pages?$/.test(own)) texts.push({ node, t: own, rect: d.rect })
        if (d.editable) fields.push({ label: d.desc || d.hint || near || d.id || d.type, value: d.password ? (d.text ? '(filled)' : '(empty)') : d.text })

        if (!d.interactive || !d.enabled && !d.editable) continue
        const role = ROLE[d.type] || (d.editable ? 'textbox' : 'clickable')
        const label = (d.editable ? d.desc || d.hint || near || d.id || d.type
            : d.desc || d.text || d.hint || innerText(node, norm) || d.id || d.type).slice(0, 100)
        const r = d.rect
        // Clamp the tap point into the visible part of the element.
        const x = Math.round(Math.max(0, r.x) + (Math.min(screen.w, r.x + r.w) - Math.max(0, r.x)) / 2)
        const y = Math.round(Math.max(0, r.y) + (Math.min(screen.h, r.y + r.h) - Math.max(0, r.y)) / 2)
        const extra = [
            d.hint && d.hint !== label ? `hint="${d.hint.slice(0, 40)}"` : '',
            d.editable && d.text && !d.password && d.text !== label ? `value="${d.text.slice(0, 40)}"` : '',
            d.checked !== undefined ? (d.checked ? 'on' : 'off') : '',
            d.selected ? 'selected' : '',
            d.enabled ? '' : 'disabled',
            `at ${x},${y}`,
        ].filter(Boolean).join(' ')
        const id = `e${++n}`
        elements.push({ id, role, label, inView: true, x, y, rect: r, editable: d.editable, value: d.editable && !d.password ? d.text : '', node, desc: `${role} "${label}" ${extra}`.trim() })
    }
    // With an alert/sheet up, only it is "shown" and only it is tappable.
    const within = (node, anc) => { for (let p = node; p; p = p.parent) if (p === anc) return true; return false }
    const shownEls = dialog ? elements.filter((e) => within(e.node, dialog)) : elements
    const shownText = (dialog ? texts.filter((t) => within(t.node, dialog)) : texts).map((t) => t.t)
    const dedup = shownText.filter((t, i) => t !== shownText[i - 1])
    return {
        platform,
        elements: shownEls.map(({ node, ...e }) => e),
        state: { viewport_text: dedup.join('\n').slice(0, 6000), fields, modal_open: !!dialog, keyboard_open: keyboard },
    }
}

export function shortlist(elements, intent) {
    if (elements.length <= MAX_OPTIONS) return elements
    const words = new Set(intent.toLowerCase().split(/\W+/).filter((w) => w.length > 2))
    const score = (e) => e.label.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length * 3 + (e.role === 'clickable' ? 0 : 1)
    return [...elements].sort((a, b) => score(b) - score(a)).slice(0, MAX_OPTIONS)
}
