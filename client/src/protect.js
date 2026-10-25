// Recording protection for the page. Be clear about what this is:
//   - "watermark": the viewer's own name floats over the picture (and tiles across it), so a leaked recording names its source.
//   - "app": the server also only lets people in through the SanWe's Viewer app, whose window Windows hides from screen recorders.
// A web page can not block screen recorders by itself; these are deterrents plus the Viewer app's black-screen mode.
export function initProtect({ $, toast, getLabel }) {
  let el = null, mover = 0, active = false, lastKey = '';
  const tile = (text) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220"><text x="20" y="130" font-family="system-ui,sans-serif" font-size="22" font-weight="600" fill="white" fill-opacity="0.16" stroke="black" stroke-opacity="0.12" transform="rotate(-24 20 130)">${text.replace(/[<>&"]/g, '')}</text></svg>`;
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  };
  function move() {
    if (!el) return;
    const tag = el.querySelector('.wm-tag');
    tag.style.left = `${6 + Math.random() * 62}%`; tag.style.top = `${8 + Math.random() * 74}%`;
  }
  function on() {
    const text = getLabel();
    if (!el) {
      el = document.createElement('div'); el.id = 'wm'; el.setAttribute('aria-hidden', 'true');
      const tag = document.createElement('div'); tag.className = 'wm-tag'; el.append(tag);
      document.body.append(el);
    }
    el.style.backgroundImage = tile(text);
    el.querySelector('.wm-tag').textContent = text;
    el.hidden = false;
    if (!mover) { move(); mover = setInterval(move, 7000); }
    active = true;
  }
  function off() { if (el) el.hidden = true; clearInterval(mover); mover = 0; active = false; }
  // casual copying: no right-click menu on the picture, and PrintScreen empties the clipboard
  document.addEventListener('contextmenu', (e) => { if (active && e.target.closest?.('#stage-area, #grid, #stage')) e.preventDefault(); });
  document.addEventListener('keyup', (e) => {
    if (active && e.key === 'PrintScreen') { navigator.clipboard?.writeText('').catch(() => {}); toast('Screenshots are not allowed in this class. Your name is on the picture.', 'info'); }
  });
  return {
    /** mode: 'off' | 'watermark' | 'app'. Hosts and co-hosts are never marked. */
    apply(mode, manager) {
      const want = !!mode && mode !== 'off' && !manager, key = want ? getLabel() : '';
      if (want === active && key === lastKey) return;
      lastKey = key; if (want) on(); else off();
    },
  };
}
