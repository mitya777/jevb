// Demo overlay (JEVB_DEMO=1): headless Chromium has no visible pointer, so draw
// one that follows real mouse events, plus a HUD showing the current step and
// what Jev decided. Pure presentation; never affects what gets clicked.
export const OVERLAY = `(() => {
  const K = '__jevbHudText'
  const mount = () => {
    if (document.getElementById('__jevb_cursor')) return
    const c = document.createElement('div'); c.id = '__jevb_cursor'
    c.style.cssText = 'position:fixed;left:-50px;top:-50px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;'
      + 'background:rgba(255,64,129,.35);border:2px solid #ff4081;box-shadow:0 0 12px rgba(255,64,129,.8);'
      + 'pointer-events:none;z-index:2147483647;transition:transform .12s'
    const h = document.createElement('div'); h.id = '__jevb_hud'
    h.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;padding:10px 14px;border-radius:10px;'
      + 'background:rgba(12,12,20,.88);color:#fff;font:14px/1.4 ui-monospace,Menlo,monospace;pointer-events:none;'
      + 'z-index:2147483646;white-space:pre-wrap;box-shadow:0 4px 20px rgba(0,0,0,.4)'
    document.documentElement.append(c, h)
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px' }, true)
    addEventListener('mousedown', () => { c.style.transform = 'scale(.6)' }, true)
    addEventListener('mouseup', () => { c.style.transform = '' }, true)
    window.__jevbHud = (t) => { h.textContent = t; try { sessionStorage.setItem(K, t) } catch {} }
    try { const t = sessionStorage.getItem(K); if (t) h.textContent = t } catch {}
  }
  if (document.documentElement) mount(); else addEventListener('DOMContentLoaded', mount)
  addEventListener('DOMContentLoaded', mount)
})()`
