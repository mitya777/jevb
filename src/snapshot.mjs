// Page-side snapshot: every visible interactive element gets a stable
// data-jevb id and a one-line description Jev can choose between.

export const MAX_OPTIONS = 254 // Jev choice caps at 255; one slot is "none".

// Runs in the page: Playwright evaluates it, and on phones jevb sends its
// source through WebDriver's execute (so it must stay self-contained).
export function collect() {
    const SELECTOR = [
        'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary',
        '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=option]',
        '[role=checkbox]', '[role=switch]', '[role=textbox]', '[role=combobox]',
        '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    // Real controls: SELECTOR minus generic focus/onclick containers, which
    // apps put around whole panels (e.g. a tabindex=0 panel root).
    const CONTROL = SELECTOR.split(',').filter((x) => !x.startsWith('[tabindex') && x !== '[onclick]').join(',')
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    // Form fields labelled by a sibling <div>/<span> instead of <label for>.
    const nearbyLabel = (el) => {
        if (!el.matches('input,textarea,select,[role=textbox],[contenteditable]')) return ''
        const by = el.getAttribute('aria-labelledby')
        if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ')
        for (let n = el, depth = 0; n && depth < 3; n = n.parentElement, depth++) {
            const prev = n.previousElementSibling
            const t = clean(prev?.innerText)
            if (t && t.length <= 40) return t
        }
        return ''
    }
    // Last resort for an unlabeled icon control (no aria-label, no alt):
    // what a developer would go by. Readable class names (not CSS-module
    // hashes), a Lucide icon's name, an image's file name. E.g. a
    // mobile menu opener -> "icon: sidebar-button space-icon-comp mark-circle".
    const iconHint = (el) => {
        const words = new Set()
        for (const n of [el, ...el.querySelectorAll('*')].slice(0, 12)) {
            for (const c of n.classList) {
                const m = c.match(/^lucide-([a-z-]+)$/)
                if (m) words.add(m[1])
                else if (/^[a-z]+(-[a-z]+)+$/.test(c) && !/^(flex|h|w|m|p|text|bg|border)-/.test(c)) words.add(c)
            }
            const src = n.tagName === 'IMG' && (n.currentSrc || n.src || '').split('?')[0].split('/').pop()
            if (src) words.add(src.replace(/\.\w+$/, ''))
        }
        return words.size ? `icon: ${[...words].slice(0, 5).join(' ')}` : ''
    }
    const vw = innerWidth, vh = innerHeight
    const out = []
    // Ids are per snapshot: clear stale ones so a covered element can't keep
    // an id that gets reassigned to something else.
    for (const el of document.querySelectorAll('[data-jevb]')) el.removeAttribute('data-jevb')
    let n = 0
    // React apps attach onClick to plain <div>s, invisible to SELECTOR. From
    // each innermost cursor:pointer element, climb while the parent is also
    // pointer and shows the same text: that's one clickable item ("Channels"
    // row, "Hot" pill), not the whole pointer-styled toolbar around it.
    const pointer = (el) => el && getComputedStyle(el).cursor === 'pointer'
    const text = (el) => clean(el.innerText)
    // Not something a person can see or hit. Custom-styled checkboxes and
    // radios are real inputs at opacity 0 under a painted label (TodoMVC,
    // most UI kits); they're still what gets clicked. Anything else at
    // opacity 0 is hidden.
    const unseen = (el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) return true
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none') return true
        return Number(cs.opacity) === 0 && !el.matches('input[type=checkbox],input[type=radio],input[type=file],input[type=range]')
    }
    // Custom selects (react-select and kin) render an icon or value in a
    // pointer div and keep their only focusable part, a 1px transparent
    // input, inside it. That input carries the name; the div is the target.
    const hiddenInputLabel = (el) => [...el.querySelectorAll('input[aria-label]')].find(unseen)?.getAttribute('aria-label') || ''
    const candidates = new Set(document.querySelectorAll(SELECTOR))
    for (const leaf of document.querySelectorAll('body *')) {
        if (!pointer(leaf) || [...leaf.children].some(pointer)) continue
        if (leaf.closest(CONTROL)) continue // inside a real control already listed
        let el = leaf
        while (pointer(el.parentElement) && text(el.parentElement) === text(el) && !el.parentElement.matches(CONTROL)) el = el.parentElement
        if (!text(el) && !el.querySelector('svg,img')) continue
        // A control inside it that people can't see doesn't stand in for it.
        if ([...el.querySelectorAll(CONTROL)].some((c) => text(c) === text(el) && !unseen(c))) continue
        candidates.add(el)
    }
    for (const el of candidates) {
        if (unseen(el)) continue
        const r = el.getBoundingClientRect()
        if (el.closest('[aria-hidden=true],[inert]')) continue
        // Skip wrappers whose only job is to contain an already-listed control.
        if (el.matches('[tabindex]') && !el.matches('a,button,input,textarea,select,[role],[contenteditable]')
            && el.querySelector(SELECTOR)) continue
        const id = `e${++n}`
        el.setAttribute('data-jevb', id)
        const role = el.getAttribute('role') || (el.isContentEditable ? 'editor'
            : el.matches(SELECTOR) ? el.tagName.toLowerCase() : 'clickable')
        const label = clean(
            el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder')
            || el.getAttribute('alt') || el.labels?.[0]?.innerText || nearbyLabel(el) || el.innerText || el.value
            || el.getAttribute('name') || el.getAttribute('autocomplete') || el.getAttribute('type')
            || hiddenInputLabel(el)
            || [...el.querySelectorAll('img[alt],svg title')].map((x) => x.getAttribute('alt') || x.textContent).join(' ')
            || iconHint(el),
        ).slice(0, 100)
        const inView = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw
        // Covered by something else (a modal, a sticky bar): not clickable now.
        if (inView) {
            const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1), cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1)
            const hit = document.elementFromPoint(cx, cy)
            if (hit && !el.contains(hit) && !hit.contains(el)) continue
        }
        const extra = [
            el.type && el.tagName === 'INPUT' ? `type=${el.type}` : '',
            el.getAttribute('href') ? `href=${el.getAttribute('href').slice(0, 60)}` : '',
            el.disabled || el.getAttribute('aria-disabled') === 'true' ? 'disabled' : '',
            inView ? '' : 'offscreen',
            `at ${Math.round(r.left)},${Math.round(r.top)}`,
        ].filter(Boolean).join(' ')
        out.push({ id, role, label, inView, el, extra })
    }
    // Controls sharing a label ("Reply" on every post, "Edit" on every row)
    // differ only by where they are. Name the item each one sits in, so
    // "edit Grace's row" or "reply to the post about cats" can be matched.
    // Climb to the largest ancestor that holds no other control with this
    // label. Where the climb stops, the item may be a run of siblings rather
    // than one element: a title row plus an actions row (Hacker News), a
    // header plus a body, a comment whose replies nest beside it. Take the
    // siblings between this control's run and its neighbours'. If content
    // comes before the first control, items lead with content and the run
    // ends at the control; otherwise the run starts there.
    const base = (l) => l.replace(/ \(\d+\)$/, '')
    const count = {}
    for (const o of out) count[base(o.label)] = (count[base(o.label)] || 0) + 1
    const textOf = (n) => (n.nodeType === 3 ? n.textContent : n.innerText || '')
    for (const o of out) {
        let context = ''
        if (o.label && count[base(o.label)] > 1) {
            const same = out.filter((x) => x !== o && base(x.label) === base(o.label)).map((x) => x.el)
            let item = o.el, shared = null
            for (let n = o.el.parentElement, depth = 0; n && n !== document.body && depth < 15; n = n.parentElement, depth++) {
                if (same.some((x) => n.contains(x))) { shared = n; break }
                item = n
            }
            let run = [item]
            if (shared) {
                const kids = [...shared.childNodes].filter((k) => textOf(k).trim() || k === item || (k.nodeType === 1 && k.querySelector?.('[data-jevb]')))
                const holds = (k) => k === item || (k.nodeType === 1 && same.some((x) => k.contains(x)))
                const at = kids.indexOf(item), marks = kids.map((k, i) => (holds(k) ? i : -1)).filter((i) => i >= 0)
                const k0 = marks.indexOf(at)
                run = marks[0] > 0
                    ? kids.slice(k0 > 0 ? marks[k0 - 1] + 1 : 0, at + 1) // content leads: run ends at the control
                    : kids.slice(at, k0 < marks.length - 1 ? marks[k0 + 1] : kids.length) // control leads: run starts at it
            }
            const t = clean(run.map(textOf).join(' ').replace(o.el.innerText, ' '))
            if (t) context = t.replace(/"/g, "'").slice(0, 60)
        }
        o.desc = `${o.role} "${o.label}"${context ? ` in "${context}"` : ''} ${o.extra}`.trim()
    }
    for (const o of out) { delete o.el; delete o.extra } // not serializable / folded into desc
    return out
}

export async function snapshot(page) {
    const elements = await page.evaluate(collect)
    return elements
}

// Keep the list under Jev's option cap: in-view first, then crude word
// overlap with the intent. Jev does the real judging.
export function shortlist(elements, intent) {
    if (elements.length <= MAX_OPTIONS) return elements
    const words = new Set(intent.toLowerCase().split(/\W+/).filter((w) => w.length > 2))
    const score = (e) => (e.inView ? 10 : 0)
        + e.label.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length * 3
    return [...elements].sort((a, b) => score(b) - score(a)).slice(0, MAX_OPTIONS)
}

// What checks see. `viewport_text` is what's on screen right now; with a
// modal open it is only the modal's text (the page behind is not "shown").
// Deliberately no whole-page text: offscreen/covered content in the state
// pulled judgments off (footer-visible 0.75 → 0.58 at page bottom).
// innerText omits form values, so typed input is listed in `fields`;
// password values are reduced to filled/empty.
export async function pageState(page, { maxText = 6000 } = {}) {
    return page.evaluate(readState, maxText)
}

// In-page half of pageState (self-contained, like collect). The argument is
// maxText, or { maxText, blocks }: blocks also returns the on-screen text
// grouped by its nearest block element, each with the item it sits in, for
// `jevb read <question>` to choose from.
export function readState(arg) {
    {
        const { maxText = 6000, blocks: wantBlocks = false } = typeof arg === 'object' && arg ? arg : { maxText: arg }
        const clean = (t) => t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
        const vw = innerWidth, vh = innerHeight
        const shown = (el) => {
            const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
            return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none'
        }
        // A modal: explicit dialog semantics, or whatever sits on top at the
        // viewport center inside a fixed layer covering most of the screen.
        let modal = [...document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true],dialog[open]')].find(shown) || null
        if (!modal) {
            for (let n = document.elementFromPoint(vw / 2, vh / 2); n && n !== document.body; n = n.parentElement) {
                const cs = getComputedStyle(n), r = n.getBoundingClientRect()
                if (cs.position === 'fixed' && r.width * r.height > vw * vh * 0.5) { modal = n; break }
            }
            // The full-screen fixed layer may be the backdrop; prefer the panel in it.
            if (modal && modal.children.length) {
                const panel = [...modal.querySelectorAll('*')].find((c) => {
                    const r = c.getBoundingClientRect()
                    return c.innerText?.trim() && r.width < vw * 0.95 && r.width * r.height > vw * vh * 0.1
                })
                if (panel) modal = panel
            }
            if (modal && modal.contains(document.querySelector('main, [role=main]')) ) modal = null // app shell, not a modal
        }
        // body can be briefly null while Safari swaps documents (seen on an iOS 18 simulator)
        const root = modal || document.body || document.documentElement
        let viewport = ''
        const byBlock = new Map()
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        const range = document.createRange()
        for (let t = walker.nextNode(); t && viewport.length < maxText; t = walker.nextNode()) {
            if (!t.textContent.trim()) continue
            range.selectNodeContents(t)
            const r = range.getBoundingClientRect()
            if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || r.width === 0) continue
            const cs = t.parentElement && getComputedStyle(t.parentElement)
            if (cs && (cs.visibility === 'hidden' || Number(cs.opacity) === 0)) continue
            viewport += t.textContent.trim() + (getComputedStyle(t.parentElement).display === 'inline' ? ' ' : '\n')
            if (wantBlocks) {
                let b = t.parentElement
                while (b && b !== root && ['inline', 'contents'].includes(getComputedStyle(b).display)) b = b.parentElement
                if (!byBlock.has(b)) byBlock.set(b, [])
                byBlock.get(b).push(t.textContent)
            }
        }
        const flat = (x) => x.replace(/\s+/g, ' ').trim()
        const blocks = []
        for (const [el, parts] of byBlock) {
            const text = flat(parts.join(' ')).slice(0, 300)
            if (!text) continue
            // The item it sits in: the text just around it in the nearest
            // element with more text ("$40" -> "Red kettle … Add to cart").
            // A window, not the whole element: that element may hold every
            // item (a list, Hacker News title and points rows as siblings).
            let context = ''
            for (let a = el, d = 0; a && d < 6 && (a === root || root.contains(a)); a = a.parentElement, d++) {
                const around = flat(a.innerText || '')
                const at = around.indexOf(text)
                if (at < 0 || around.length <= text.length + 3) continue
                const end = at + text.length
                // Cut at word boundaries, but only where the window cut a word.
                const before = (at > 50 ? around.slice(at - 50, at).replace(/^\S*\s/, '') : around.slice(0, at)).trim()
                const after = (around.length > end + 25 ? around.slice(end, end + 25).replace(/\s\S*$/, '') : around.slice(end)).trim()
                context = [before, after].filter(Boolean).join(' … ')
                break
            }
            // What kind of text it is, so "what's the heading?" or "what does
            // the button say?" can be answered: the role, else the tag.
            const tag = el.tagName.toLowerCase(), role = el.getAttribute('role')
            const kind = role || (/^h[1-6]$/.test(tag) ? 'heading' : { button: 'button', a: 'link', td: 'cell', th: 'header cell', li: 'item', label: 'label', caption: 'caption', summary: 'summary', legend: 'legend', title: 'title' }[tag] || 'text')
            const r = el.getBoundingClientRect()
            if (!blocks.some((x) => x.text === text && x.context === context)) blocks.push({ kind, text, context, at: [Math.round(r.left), Math.round(r.top)] })
        }
        const fields = []
        for (const el of root.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]')) {
            if (!shown(el)) continue
            const name = (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder')
                || el.getAttribute('name') || el.type || 'field').trim().slice(0, 60)
            let value = el.isContentEditable ? el.innerText : el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value
            if (el.type === 'password') value = value ? '(filled)' : '(empty)'
            fields.push({ field: name, type: el.type || (el.isContentEditable ? 'editor' : el.tagName.toLowerCase()), value: (value || '').slice(0, 200) })
        }
        return {
            url: location.href,
            title: document.title,
            modal_open: !!modal,
            viewport_text: clean(viewport).slice(0, maxText),
            fields,
            ...(wantBlocks && { blocks }),
        }
    }
}
