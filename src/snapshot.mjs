// Page-side snapshot: every visible interactive element gets a stable
// data-jevb id and a one-line description Jev can choose between.

export const MAX_OPTIONS = 254 // Jev choice caps at 255; one slot is "none".

function collect() {
    const SELECTOR = [
        'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary',
        '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=option]',
        '[role=checkbox]', '[role=switch]', '[role=textbox]', '[role=combobox]',
        '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vw = innerWidth, vh = innerHeight
    const out = []
    let n = 0
    for (const el of document.querySelectorAll(SELECTOR)) {
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
        if (el.closest('[aria-hidden=true],[inert]')) continue
        // Skip wrappers whose only job is to contain an already-listed control.
        if (el.matches('[tabindex]') && !el.matches('a,button,input,textarea,select,[role],[contenteditable]')
            && el.querySelector(SELECTOR)) continue
        const id = el.getAttribute('data-jevb') || `e${++n}`
        el.setAttribute('data-jevb', id)
        const role = el.getAttribute('role') || (el.isContentEditable ? 'editor' : el.tagName.toLowerCase())
        const label = clean(
            el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder')
            || el.getAttribute('alt') || el.labels?.[0]?.innerText || el.innerText || el.value
            || el.getAttribute('name') || el.getAttribute('autocomplete') || el.getAttribute('type')
            || [...el.querySelectorAll('img[alt],svg title')].map((x) => x.getAttribute('alt') || x.textContent).join(' '),
        ).slice(0, 100)
        const inView = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw
        const extra = [
            el.type && el.tagName === 'INPUT' ? `type=${el.type}` : '',
            el.getAttribute('href') ? `href=${el.getAttribute('href').slice(0, 60)}` : '',
            el.disabled || el.getAttribute('aria-disabled') === 'true' ? 'disabled' : '',
            inView ? '' : 'offscreen',
            `at ${Math.round(r.left)},${Math.round(r.top)}`,
        ].filter(Boolean).join(' ')
        out.push({ id, role, label, inView, desc: `${role} "${label}" ${extra}`.trim() })
    }
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

export async function pageState(page, { maxText = 8000 } = {}) {
    return page.evaluate((maxText) => ({
        url: location.href,
        title: document.title,
        visible_text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, maxText),
    }), maxText)
}
