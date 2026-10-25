// Small helpers shared by the home screen (home.js) and the meeting window (main.js).
export const $ = (id) => document.getElementById(id);

export const store = {
  get(k) { try { return localStorage.getItem(k) ?? undefined; } catch { return undefined; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: preferences just won't persist */ } },
};

export const guestName = () => `Guest-${Math.floor(100 + Math.random() * 900)}`;
export const TYPE_LABEL = { game: 'Game Hub', hangout: 'Hangout', meeting: 'Meeting' };
const hue = (str) => [...str].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);

// Cover art element: the uploaded image, or a coloured tile with the first letter when there is none.
export function coverEl(cover, label, cls) {
  const el = document.createElement('div');
  el.className = cls;
  if (cover) {
    el.style.backgroundImage = `url("${cover}")`;
  } else {
    el.style.background = `linear-gradient(135deg, hsl(${hue(label)} 55% 38%), hsl(${(hue(label) + 50) % 360} 55% 26%))`;
    el.textContent = (label.trim()[0] ?? '?').toUpperCase();
  }
  return el;
}

// Meeting ids are shown in groups, like 397 559 1554 (10 digits) or 397 5591 5541 (11 digits).
export function fmtId(id) {
  const d = String(id).replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  if (d.length === 11) return `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}`;
  return String(id);
}

// Profile pictures travel as a small JPEG data URL in a participant attribute. Anything else is ignored, so a hostile
// client cannot smuggle other content into a style rule.
const PIC_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]{20,6000}$/;
export const safePic = (v) => (typeof v === 'string' && PIC_RE.test(v) ? v : '');

// Paint an avatar circle: the picture when there is one (and pictures are not hidden), else the first letter of the name.
export function paintAvatar(el, name, pic) {
  const p = safePic(pic);
  el.textContent = p ? '' : (name || '?').trim().charAt(0).toUpperCase();
  el.style.backgroundImage = p ? `url("${p}")` : '';
  el.classList.toggle('has-pic', !!p);
}

// Square, centre-cropped, 64 px JPEG: small enough for an attribute.
export async function resizePicture(file, size = 64) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas'); c.width = c.height = size;
  const side = Math.min(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  bmp.close?.();
  for (const q of [0.75, 0.6, 0.45, 0.3]) { const url = c.toDataURL('image/jpeg', q); if (safePic(url)) return url; }
  throw new Error('That picture is too detailed to use; try another one.');
}
