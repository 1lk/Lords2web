// Lords of the Realm II (demo) - web port front end: loading, display layout, touch / mouse / keyboard input, UI.
import { Runtime, AudioOut, EV } from './runtime.js';
import { extractGameFiles, checkExe, buildImage, extractCursors, store, fetchInstaller } from './loader.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), canvas = $('screen'), overlay = $('overlay');
const ctx2d = canvas.getContext('2d', { alpha: false });
const params = new URLSearchParams(location.search);
const GW = 640, GH = 480;
const MODE_ADDR = 0x4a3960;     // the game's screen-mode byte; 4 = info popup, which only a right-click closes
const MSG_ADDR = 0x4da82c;      // id of the message balloon being shown (tutorial hints, events), 0 = none; a right-click closes it

let rt = null, running = false, cursors = {}, curId = 0x7f00;
let image = null, gameFiles = null;
const audio = new AudioOut();

// ================================================================================================ settings
const SKEY = 'lords2.settings';
const settings = { zoom: 0, muted: false, pad: true, loupe: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SKEY) || '{}')); } catch { /* storage unavailable */ }
const saveSettings = () => { try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch { /* ignore */ } };

// ================================================================================================ helpers
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}
const show = (id, on) => $(id).classList.toggle('hidden', !on);
function setStatus(msg, pct) {
  $('status').textContent = msg || '';
  const bar = $('progress'); bar.classList.toggle('hidden', pct == null);
  if (pct != null) bar.firstElementChild.style.width = Math.round(pct * 100) + '%';
}
function showError(msg) { const e = $('error'); e.textContent = msg || ''; e.classList.toggle('hidden', !msg); }
const gameMode = () => (rt && rt.ex ? rt.peek8(MODE_ADDR) : 0);
const balloonUp = () => !!(rt && rt.ex && rt.peek32(MSG_ADDR));

function waitFrames(n, maxMs = 300) {
  return new Promise((resolve) => {
    if (!rt || !running) return resolve();
    const f0 = rt.framesPresented, t0 = performance.now();
    const tick = () => { if (!running || rt.framesPresented - f0 >= n || performance.now() - t0 > maxMs) resolve(); else requestAnimationFrame(tick); };
    tick();
  });
}
let chain = Promise.resolve();
const later = (fn) => { chain = chain.then(fn).catch((e) => console.error(e)); return chain; };

// ================================================================================================ layout / zoom
const view = { s: 1, x: 0, y: 0, preset: settings.zoom | 0 };      // preset -1: free (pinch)
let stageW = 1, stageH = 1, fitScale = 1, portrait = true;
let lastG = { x: GW / 2, y: GH / 2 };

function layout() {
  const r = stage.getBoundingClientRect();
  stageW = Math.max(1, r.width); stageH = Math.max(1, r.height);
  portrait = stageH > stageW * 0.95;
  fitScale = Math.min(stageW / GW, stageH / GH);
  if (view.preset >= 0) setPreset(view.preset, false); else { view.s = clamp(view.s, fitScale, fitScale * 5); clampView(); paintView(false); }
}
const presetMul = () => (portrait ? [1, 1.75, 2.7] : [1, 1.6, 2.4]);
function setPreset(i, animate = true) {
  view.preset = i; settings.zoom = i; saveSettings();
  const ns = fitScale * presetMul()[i];
  // keep the point under the pointer (or the centre) where it is
  const g = lastG, r = canvas.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const fx = clamp(r.left - sr.left + g.x * view.s, 0, stageW), fy = clamp(r.top - sr.top + g.y * view.s, 0, stageH);
  zoomAt(ns, i === 0 ? stageW / 2 : fx, i === 0 ? stageH / 2 : fy, animate);
}
function zoomAt(ns, fx, fy, animate = false) {
  ns = clamp(ns, fitScale, fitScale * 5);
  const k = ns / view.s;
  view.x = fx - (fx - view.x) * k; view.y = fy - (fy - view.y) * k; view.s = ns;
  clampView();
  paintView(animate);
}
function clampView() {
  const w = GW * view.s, h = GH * view.s;
  view.x = w <= stageW + 0.5 ? (stageW - w) / 2 : clamp(view.x, stageW - w, 0);
  view.y = h <= stageH + 0.5 ? (stageH - h) / 2 : clamp(view.y, stageH - h, 0);
}
function paintView(animate) {
  canvas.style.transition = animate ? 'transform .18s ease-out' : 'none';
  canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
  canvas.style.imageRendering = view.s * (window.devicePixelRatio || 1) >= 2 ? 'pixelated' : 'auto';
}
function toGame(cx, cy, snap = 0) {
  const r = canvas.getBoundingClientRect();
  let x = Math.floor((cx - r.left) * GW / r.width), y = Math.floor((cy - r.top) * GH / r.height);
  if (snap) {           // within `snap` CSS pixels of the picture's border counts as the border itself (edge scrolling)
    if (cx - r.left < snap) x = 0; else if (r.right - cx <= snap) x = GW - 1;
    if (cy - r.top < snap) y = 0; else if (r.bottom - cy <= snap) y = GH - 1;
  }
  return { x: clamp(x, 0, GW - 1), y: clamp(y, 0, GH - 1) };
}
new ResizeObserver(layout).observe(stage);
window.addEventListener('resize', layout);
if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);

function applyTouchClass() { document.body.classList.toggle('nopad', !settings.pad); }
function markTouch() { if (!document.body.classList.contains('touch')) { document.body.classList.add('touch'); layout(); } }
if (matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0) document.body.classList.add('touch');
applyTouchClass();

// ================================================================================================ sending input to the game
const send = (t, a, b) => { if (rt && running) rt.input(t, a, b); };
const sendMove = (g) => { if (g.x !== lastG.x || g.y !== lastG.y) { lastG = { x: g.x, y: g.y }; } send(EV.MOVE, g.x, g.y); };
function rawClick(btn, g) {
  lastG = { x: g.x, y: g.y };
  send(EV.MOVE, g.x, g.y);
  send(btn === 2 ? EV.RDOWN : EV.LDOWN, g.x, g.y);
  send(btn === 2 ? EV.RUP : EV.LUP, g.x, g.y);
}
// A click made by touch. The info popup (screen mode 4) only closes on a right-click, so a tap first closes it.
// A message balloon (tutorial hint, event) is also closed by a right-click; the tap then only turns to the next balloon.
function tapClick(btn, g) {
  ripple(g);
  later(async () => {
    if (btn === 1 && balloonUp()) { rawClick(2, g); await waitFrames(4, 300); scrollUpdate(true); return; }
    if (btn === 1 && gameMode() === 4) { rawClick(2, g); await waitFrames(4, 300); }
    rawClick(btn, g);
    await waitFrames(4, 300);       // the game must see the release before the pointer moves again
    scrollUpdate(true);
  });
}
function ripple(g) {
  const r = canvas.getBoundingClientRect(), o = overlay.getBoundingClientRect();
  const el = document.createElement('i');
  el.className = 'ripple';
  el.style.left = (r.left - o.left + (g.x + 0.5) * r.width / GW) + 'px';
  el.style.top = (r.top - o.top + (g.y + 0.5) * r.height / GH) + 'px';
  overlay.appendChild(el);
  setTimeout(() => el.remove(), 500);
}

let rightArmed = false;
function setRightArmed(on) { rightArmed = on; $('bRight').classList.toggle('on', on); if (on) toast('Next tap = right-click (info)'); }

// ================================================================================================ map scrolling
// The game scrolls the campaign map while the pointer rests on the outermost pixel of the screen.  The pad, the arrow
// keys and (for a mouse) the window border all end up as "park the pointer on that edge".
const scrollSrc = { padX: 0, padY: 0, keyX: 0, keyY: 0, mouseX: 0, mouseY: 0, active: false };
function scrollUpdate(force) {
  const hx = scrollSrc.padX || scrollSrc.keyX || scrollSrc.mouseX, hy = scrollSrc.padY || scrollSrc.keyY || scrollSrc.mouseY;
  if (hx || hy) {
    const g = { x: hx > 0 ? GW - 1 : hx < 0 ? 0 : GW / 2, y: hy > 0 ? GH - 1 : hy < 0 ? 0 : GH / 2 };
    if (force || !scrollSrc.active || g.x !== lastG.x || g.y !== lastG.y) sendMove(g);
    scrollSrc.active = true;
  } else if (scrollSrc.active) {
    scrollSrc.active = false;
    sendMove({ x: GW / 2, y: GH / 2 });
  }
}

// ---- scroll pad
const pad = $('pad'), knob = $('knob');
let padId = null;
function padVector(e) {
  const r = pad.getBoundingClientRect(), R = r.width / 2;
  let vx = e.clientX - (r.left + R), vy = e.clientY - (r.top + R);
  const len = Math.hypot(vx, vy);
  const dead = R * 0.24;
  let hx = 0, hy = 0;
  if (len > dead) { const ux = vx / len, uy = vy / len; hx = ux > 0.38 ? 1 : ux < -0.38 ? -1 : 0; hy = uy > 0.38 ? 1 : uy < -0.38 ? -1 : 0; }
  const k = len > R * 0.5 ? (R * 0.5) / len : 1;
  knob.style.transform = `translate(${vx * k}px, ${vy * k}px)`;
  scrollSrc.padX = hx; scrollSrc.padY = hy;
  pad.querySelector('.up').classList.toggle('on', hy < 0);
  pad.querySelector('.down').classList.toggle('on', hy > 0);
  pad.querySelector('.left').classList.toggle('on', hx < 0);
  pad.querySelector('.right').classList.toggle('on', hx > 0);
  scrollUpdate(false);
}
pad.addEventListener('pointerdown', (e) => {
  e.preventDefault(); e.stopPropagation();
  markTouch(); audio.unlock();
  padId = e.pointerId; pad.setPointerCapture(e.pointerId); pad.classList.add('active');
  padVector(e);
});
pad.addEventListener('pointermove', (e) => { if (e.pointerId === padId) { e.preventDefault(); padVector(e); } });
function padEnd(e) {
  if (e.pointerId !== padId) return;
  padId = null; pad.classList.remove('active');
  knob.style.transform = '';
  scrollSrc.padX = scrollSrc.padY = 0;
  pad.querySelectorAll('.a').forEach((a) => a.classList.remove('on'));
  scrollUpdate(false);
}
pad.addEventListener('pointerup', padEnd);
pad.addEventListener('pointercancel', padEnd);
pad.addEventListener('contextmenu', (e) => e.preventDefault());

// ================================================================================================ pointer input
// Touch: tap = click, hold = right-click, drag = left-button drag, two fingers = pinch/pan (a two-finger tap = right-click).
// Mouse: ordinary buttons; the picture's border / window edge scrolls the map.
const SLOP = 10, SLOP_LOUPE = 26, LOUPE_MS = 140, LONG_MS = 650;
const ptrs = new Map();
let mode = 'idle', longTimer = 0, loupeTimer = 0, startG = null, gest = null, touchId = null, tstart = 0;
const loupe = { el: $('loupe'), cv: $('loupeCv'), arc: $('ringArc'), on: false, raf: 0 };
const lctx = loupe.cv.getContext('2d');

function loupeDraw(g) {
  lctx.imageSmoothingEnabled = false;
  lctx.fillStyle = '#000'; lctx.fillRect(0, 0, 132, 132);
  const S = 38;
  lctx.drawImage(canvas, g.x + 0.5 - S / 2, g.y + 0.5 - S / 2, S, S, 0, 0, 132, 132);
}
function loupePlace(cx, cy) {
  const o = overlay.getBoundingClientRect();
  let x = cx - o.left, y = cy - o.top - 100;
  if (y < 70) y = cy - o.top + 100;
  x = clamp(x, 70, o.width - 70); y = clamp(y, 70, o.height - 70);
  loupe.el.style.left = x + 'px'; loupe.el.style.top = y + 'px';
}
function loupeShow(cx, cy, g) {
  if (!settings.loupe) return;
  loupe.on = true; loupe.el.classList.remove('hidden');
  loupePlace(cx, cy); loupeDraw(g);
  cancelAnimationFrame(loupe.raf);
  const t0 = performance.now();
  const spin = () => {
    if (!loupe.on) return;
    const p = clamp((performance.now() - t0 - 0) / (LONG_MS - LOUPE_MS), 0, 1);
    loupe.arc.style.strokeDashoffset = String(414.7 * (1 - p));
    if (loupe.cur) loupeDraw(loupe.cur);
    loupe.raf = requestAnimationFrame(spin);
  };
  loupe.cur = g;
  spin();
}
function loupeHide() { loupe.on = false; loupe.cur = null; cancelAnimationFrame(loupe.raf); loupe.el.classList.add('hidden'); loupe.arc.style.strokeDashoffset = '414.7'; }

stage.addEventListener('contextmenu', (e) => e.preventDefault());
stage.addEventListener('dblclick', (e) => e.preventDefault());

stage.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  audio.unlock();
  if (e.pointerType === 'mouse') {
    stage.setPointerCapture(e.pointerId);
    const g = toGame(e.clientX, e.clientY, 2);
    lastG = g;
    send(EV.MOVE, g.x, g.y);
    if (e.button === 0) send(EV.LDOWN, g.x, g.y); else if (e.button === 2) send(EV.RDOWN, g.x, g.y);
    return;
  }
  markTouch();
  stage.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) {
    mode = 'pending'; touchId = e.pointerId; tstart = performance.now();
    startG = toGame(e.clientX, e.clientY);
    sendMove(startG);
    loupeTimer = setTimeout(() => { if (mode === 'pending') { const p = ptrs.get(touchId); if (p) loupeShow(p.x, p.y, toGame(p.x, p.y)); } }, LOUPE_MS);
    longTimer = setTimeout(() => {
      if (mode !== 'pending') return;
      const p = ptrs.get(touchId), g = p ? toGame(p.x, p.y) : startG;
      mode = 'consumed'; loupeHide();
      if (navigator.vibrate) navigator.vibrate(14);
      tapClick(2, g);
    }, LONG_MS);
  } else if (ptrs.size === 2) {
    clearTimeout(longTimer); clearTimeout(loupeTimer); loupeHide();
    if (mode === 'drag') send(EV.LUP, lastG.x, lastG.y);
    mode = 'gesture';
    gest = gestureState(); gest.moved = false; gest.t0 = performance.now();
  }
}, { passive: false });

function gestureState() {
  const [a, b] = [...ptrs.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}

stage.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') {
    // a pointer outside the picture (letterbox) clamps onto the edge, which scrolls the map
    const g = toGame(e.clientX, e.clientY, 2);
    lastG = g; send(EV.MOVE, g.x, g.y);
    scrollSrc.mouseX = scrollSrc.mouseY = 0;
    return;
  }
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  e.preventDefault();
  p.x = e.clientX; p.y = e.clientY;
  if (mode === 'pending' && e.pointerId === touchId) {
    const d = Math.hypot(p.x - p.x0, p.y - p.y0);
    if (d > (loupe.on ? SLOP_LOUPE : SLOP)) {
      clearTimeout(longTimer); clearTimeout(loupeTimer); loupeHide();
      mode = 'drag';
      send(EV.LDOWN, startG.x, startG.y);
    } else if (loupe.on) {
      const g = toGame(p.x, p.y); loupe.cur = g; loupePlace(p.x, p.y);
      sendMove(g);
    }
  }
  if (mode === 'drag' && e.pointerId === touchId) {
    const g = toGame(p.x, p.y);
    sendMove(g);
  } else if (mode === 'gesture' && ptrs.size >= 2) {
    const n = gestureState();
    const sr = stage.getBoundingClientRect();
    const k = n.dist / gest.dist;
    if (Math.abs(k - 1) > 0.01 || Math.hypot(n.cx - gest.cx, n.cy - gest.cy) > 3) gest.moved = true;
    view.x += n.cx - gest.cx; view.y += n.cy - gest.cy;
    zoomAt(view.s * k, n.cx - sr.left, n.cy - sr.top, false);
    view.preset = -1;
    gest = { ...gest, dist: n.dist, cx: n.cx, cy: n.cy };
  }
}, { passive: false });

function endPointer(e, cancelled) {
  audio.unlock();
  if (e.pointerType === 'mouse') {
    const g = toGame(e.clientX, e.clientY, 2);
    if (e.button === 0) send(EV.LUP, g.x, g.y); else if (e.button === 2) send(EV.RUP, g.x, g.y);
    return;
  }
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  clearTimeout(longTimer); clearTimeout(loupeTimer);
  const wasLoupe = loupe.on;
  loupeHide();
  if (mode === 'pending' && ptrs.size === 1 && !cancelled) {
    // a small slide while the magnifier was showing is an aiming correction: click where the finger ended up
    const g = wasLoupe ? toGame(p.x, p.y) : startG;
    tapClick(rightArmed ? 2 : 1, g);
    if (rightArmed) setRightArmed(false);
  } else if (mode === 'drag' && e.pointerId === touchId) {
    const g = toGame(p.x, p.y);
    send(EV.LUP, g.x, g.y);
    scrollUpdate(true);
  } else if (mode === 'gesture' && gest && !gest.moved && performance.now() - gest.t0 < 350 && !cancelled) {
    tapClick(2, toGame(gest.cx, gest.cy));          // quick two-finger tap
    mode = 'consumed';
  }
  ptrs.delete(e.pointerId);
  if (ptrs.size === 0) mode = 'idle';
  else if (mode === 'gesture' && ptrs.size === 1) mode = 'consumed';
}
stage.addEventListener('pointerup', (e) => { e.preventDefault(); endPointer(e, false); }, { passive: false });
stage.addEventListener('pointercancel', (e) => endPointer(e, true));
stage.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'mouse' || e.buttons) return;
  // the mouse left the picture area through the window border: keep scrolling that way
  const r = stage.getBoundingClientRect();
  const hx = e.clientX <= r.left + 2 ? -1 : e.clientX >= r.right - 2 ? 1 : 0;
  const hy = e.clientY <= r.top + 2 ? -1 : 0;
  scrollSrc.mouseX = hx; scrollSrc.mouseY = hy; scrollUpdate(false);
});
stage.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { scrollSrc.mouseX = scrollSrc.mouseY = 0; scrollUpdate(false); } });
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ================================================================================================ keyboard
const VK = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38,
  ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, Shift: 16, Control: 17, Alt: 18,
};
function vkOf(e) {
  if (e.key in VK) return VK[e.key];
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return 111 + parseInt(e.key.slice(1), 10);
  if (e.code && /^Numpad[0-9]$/.test(e.code)) return 96 + parseInt(e.code.slice(6), 10);
  if (e.key.length === 1) {
    const c = e.key.toUpperCase().charCodeAt(0);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90)) return c;
    return { ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '`': 192, '[': 219, '\\': 220, ']': 221, "'": 222 }[e.key] || 0;
  }
  return 0;
}
function gameKey(down, vk, e) {
  const sys = e && e.altKey;
  send(down ? (sys ? EV.SYSKEYDOWN : EV.KEYDOWN) : (sys ? EV.SYSKEYUP : EV.KEYUP), vk, down ? (e && e.repeat ? 0x40000001 : 1) : 0xC0000001);
}
function pressKey(vk, ch) {          // a key tapped on the soft keyboard
  gameKey(true, vk, null);
  if (ch) send(EV.CHAR, ch, 1);
  gameKey(false, vk, null);
}
const ARROWS = { ArrowLeft: ['keyX', -1], ArrowRight: ['keyX', 1], ArrowUp: ['keyY', -1], ArrowDown: ['keyY', 1] };
window.addEventListener('keydown', (e) => {
  if (!running || e.target === $('kbd') || e.ctrlKey || e.metaKey) return;
  audio.unlock();
  if (e.altKey && e.key === 'Enter') { e.preventDefault(); return; }       // would toggle the game's windowed mode
  const vk = vkOf(e);
  if (!vk) return;
  e.preventDefault();
  if (e.key in ARROWS) { const [k, v] = ARROWS[e.key]; scrollSrc[k] = v; scrollUpdate(false); }
  gameKey(true, vk, e);
  if (e.key.length === 1 && !e.altKey) send(EV.CHAR, e.key.charCodeAt(0), 1);
  else if (e.key === 'Enter') send(EV.CHAR, 13, 1);
  else if (e.key === 'Backspace') send(EV.CHAR, 8, 1);
  else if (e.key === 'Escape') send(EV.CHAR, 27, 1);
  else if (e.key === 'Tab') send(EV.CHAR, 9, 1);
});
window.addEventListener('keyup', (e) => {
  if (!running || e.target === $('kbd')) return;
  const vk = vkOf(e);
  if (e.key in ARROWS) { scrollSrc[ARROWS[e.key][0]] = 0; scrollUpdate(false); }
  if (vk && !(e.altKey && e.key === 'Enter')) { e.preventDefault(); gameKey(false, vk, e); }
});
window.addEventListener('blur', () => { scrollSrc.keyX = scrollSrc.keyY = 0; scrollSrc.mouseX = scrollSrc.mouseY = 0; scrollUpdate(false); });

// soft keyboard: a hidden text field; whatever is typed into it is diffed against a sentinel and replayed as key presses
const kbd = $('kbd');
const SENT = ' '.repeat(16);
function resetKbd() { kbd.value = SENT; try { kbd.setSelectionRange(SENT.length, SENT.length); } catch { /* ignore */ } }
const strip = $('keystrip');
let stripHide = 0;
function updateKb() {      // how much of the layout viewport the soft keyboard covers: the strip sits right above it
  const vv = window.visualViewport;
  const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
  document.documentElement.style.setProperty('--kb', kb + 'px');
}
if (window.visualViewport) { window.visualViewport.addEventListener('resize', updateKb); window.visualViewport.addEventListener('scroll', updateKb); }
kbd.addEventListener('focus', () => { resetKbd(); clearTimeout(stripHide); updateKb(); strip.classList.remove('hidden'); $('bKeys').classList.add('on'); });
kbd.addEventListener('blur', () => {
  $('bKeys').classList.remove('on');
  clearTimeout(stripHide); stripHide = setTimeout(() => { if (document.activeElement !== kbd) strip.classList.add('hidden'); }, 150);
});
// The game's text boxes overwrite from the cursor, so editing needs real cursor keys; these buttons must not take focus away from the hidden field.
const STRIP_KEYS = {
  home: () => pressKey(36, 0), left: () => pressKey(37, 0), right: () => pressKey(39, 0), end: () => pressKey(35, 0),
  del: () => pressKey(46, 0), bs: () => pressKey(8, 8), enter: () => pressKey(13, 13),
  clear: async () => { pressKey(35, 0); for (let i = 0; i < 40; i++) { pressKey(8, 8); if (i % 8 === 7) await waitFrames(1, 100); } },
  done: () => kbd.blur(),
};
strip.addEventListener('pointerdown', (e) => e.preventDefault());
strip.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-k]');
  if (!b) return;
  audio.unlock();
  const k = b.dataset.k;
  Promise.resolve(STRIP_KEYS[k] && STRIP_KEYS[k]()).catch((err) => console.error(err));
  if (k !== 'done' && document.activeElement !== kbd) kbd.focus({ preventScroll: true });
});
kbd.addEventListener('input', () => {
  const v = kbd.value;
  if (v.length > SENT.length) for (const ch of v.slice(SENT.length)) { const c = ch.charCodeAt(0); pressKey(c >= 97 && c <= 122 ? c - 32 : c, c); }
  else if (v.length < SENT.length) for (let i = 0; i < SENT.length - v.length; i++) pressKey(8, 8);
  resetKbd();
});
kbd.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pressKey(13, 13); } });

// ================================================================================================ cursor
function applyCursor() {
  let css = 'default';
  if (curId === 0) css = 'none';
  else if (cursors[curId]) { const c = cursors[curId]; css = `url(${c.url}) ${c.hx} ${c.hy}, auto`; }
  stage.style.cursor = css;
}

// ================================================================================================ main loop
// The game is stepped from a pump of its own and the display frame only paints, so the game can be woken more often than 60 Hz
// (its timers stay accurate) and can sleep when it has nothing to do (yield kind 3: idling in its message loop).
//   yield 1: the slice was used up    -> continue at once (after the browser had a chance to paint / take input)
//   yield 2: waiting for the next frame -> continue on the next display frame
//   yield 3: idle in the main loop    -> poll again after a short nap
const chan = new MessageChannel();
let chanFn = null;
chan.port1.onmessage = () => { const f = chanFn; chanFn = null; if (f) f(); };
const soon = (fn) => { chanFn = fn; chan.port2.postMessage(0); };
const nap = (fn, ms) => soon(() => setTimeout(fn, ms));      // a timer started from a message task is not clamped like a nested one
const IDLE_NAP_MS = 1;      // pause between two bursts of idle passes through the game's main loop
const IDLE_RATE = 1000;     // passes per second given to the game while it idles: its own counters (hint balloons...) were written for a loop that spins freely, so a pace is needed that is neither a busy loop nor a crawl
let pumpGen = 0, frameWanted = false, idleBatch = 1, idleCycle = 0, idleSince = 0;
function startPump() { const g = ++pumpGen; frameWanted = false; idleCycle = 0; soon(() => pump(g)); }
// Passes per burst follow the real length of a nap + burst, so the pass rate stays near IDLE_RATE whatever timer granularity the browser has.
function tuneIdle(now) {
  if (idleSince) {
    idleCycle = idleCycle ? idleCycle * 0.9 + (now - idleSince) * 0.1 : now - idleSince;
    const want = clamp(Math.round(IDLE_RATE * idleCycle / 1000), 1, 16);
    if (want !== idleBatch) { idleBatch = want; rt.ex.rt_set_idle_batch(want); }
  }
}
function pump(g) {
  if (g !== pumpGen || !running) return;
  const t0 = performance.now();
  tuneIdle(t0);
  let code = 0;
  try {
    do { code = rt.step(); } while (!code && rt.yieldKind === 1 && performance.now() - t0 < 9);
  } catch (err) { console.error(err); stop('The game stopped unexpectedly: ' + err.message); return; }
  if (code) { stop(code === 1 ? 'The game has ended.' : 'The game stopped (code ' + code + ').'); return; }
  const k = rt.yieldKind;
  idleSince = k === 3 ? t0 : 0;
  if (k === 3) nap(() => pump(g), IDLE_NAP_MS);
  else if (k === 2) frameWanted = true;
  else soon(() => pump(g));
}
function paint() {
  requestAnimationFrame(paint);
  if (!running) return;
  if (frameWanted) { frameWanted = false; pump(pumpGen); }
  rt.render(ctx2d);
}
function stop(msg) {
  running = false; audio.setRunning(false); loupeHide();
  $('endedMsg').textContent = msg; show('ended', true);
}
document.addEventListener('visibilitychange', () => {
  if (!rt || !rt.ex) return;
  if (document.hidden) { if (running) { running = false; audio.setRunning(false); rt._hiddenAt = performance.now(); rt._paused = true; } }
  else if (rt._paused) { rt.timeOffset += performance.now() - rt._hiddenAt; rt._paused = false; running = true; audio.setRunning(true); wakeLock(); startPump(); }
});
let lock = null;
async function wakeLock() { try { if ('wakeLock' in navigator && !lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch { lock = null; } }

// ================================================================================================ start-up
async function boot(files, fromCache) {
  showError('');
  setStatus('Preparing…', 0.05);
  const exe = files.get('LORDS2.EXE');
  if (!exe) throw new Error('LORDS2.EXE not found in the package.');
  checkExe(exe);
  const built = buildImage(exe);
  image = built.image;
  cursors = extractCursors(image);
  gameFiles = new Map([...files].filter(([k]) => !/\.(EXE|DLL)$/i.test(k) && k !== 'STATUS.TXT'));
  if (!fromCache) { setStatus('Saving a copy in this browser…', 0.8); await store.putGame(files).catch((e) => console.warn('cache failed', e)); }
  setStatus('Ready.', 1);
  show('playBox', true); show('pickBox', false); show('fetchBox', false);
}

const mb = (n) => (n / 1048576).toFixed(1);
let archiveJob = null;                               // AbortController of a download in progress

// Download the installer from the Internet Archive, unpack it and keep it; on any failure the file picker comes up instead.
async function loadFromArchive() {
  if (archiveJob) return;
  const job = archiveJob = new AbortController();
  showError('');
  show('pickBox', false); show('playBox', false); show('fetchBox', true);
  setStatus('Contacting the Internet Archive…', 0.02);
  try {
    const { bytes, source } = await fetchInstaller((p, got, total) =>
      setStatus('Downloading the demo from the Internet Archive… ' + mb(got) + ' of ' + mb(total) + ' MB', 0.03 + 0.6 * p), job.signal);
    console.info('installer from', source);
    show('fetchBox', false);
    setStatus('Unpacking the installer…', 0.65);
    const files = await extractGameFiles(bytes, (p) => setStatus('Unpacking the installer…', 0.65 + 0.15 * p));
    await boot(files, false);
  } catch (err) {
    if (err.name === 'AbortError') return;           // the player chose a file of their own
    console.warn('archive download failed:', err.details || err.message);
    setStatus('', null);
    show('fetchBox', false); show('pickBox', true); show('playBox', false);
    const why = err.details && err.details[0] ? ' (' + err.details[0].replace(/^[^:]*: /, '') + ')' : '';
    showError(err.details ? "Couldn't download the demo from the Internet Archive" + why + '.' : err.message || String(err));
  } finally { if (archiveJob === job) archiveJob = null; }
}

async function loadFromFile(file) {
  showError('');
  if (archiveJob) archiveJob.abort();
  show('fetchBox', false);
  try {
    setStatus('Reading ' + file.name + '…', 0.02);
    const bytes = new Uint8Array(await file.arrayBuffer());
    setStatus('Unpacking the installer…', 0.1);
    const files = await extractGameFiles(bytes, (p) => setStatus('Unpacking the installer…', 0.1 + 0.6 * p));
    await boot(files, false);
  } catch (err) {
    console.error(err);
    setStatus('', null);
    showError(err.message || String(err));
    show('pickBox', true); show('playBox', false);
  }
}

async function startGame() {
  show('loader', false);
  rt = new Runtime({
    onLog: (s) => { if (params.has('log')) console.log('[game] ' + s); },
    onCursor: (id) => { curId = id; applyCursor(); },
    onCommit: (name, bytes) => { if (name !== 'STATUS.TXT') store.putSave(name, bytes); },
  });
  await rt.load('lords2.wasm');
  const saves = await store.getSaves();
  rt.start(image, gameFiles, saves);
  if (params.has('trace')) rt.setTrace(true);
  audio.attach(rt);
  audio.setMuted(settings.muted);
  $('bSound').classList.toggle('off', settings.muted);
  audio.setRunning(true);
  applyCursor();
  layout();
  running = true;
  startPump();
  wakeLock();
  window.lords2 = { rt, audio, view, send, tapClick, rawClick, settings, mode: gameMode, scrollSrc, get running() { return running; }, get idleBatch() { return idleBatch; } };
  toast(document.body.classList.contains('touch') ? 'Tap = click · Hold = info (right-click) · Pinch = zoom' : 'Left / right mouse buttons · move to the edge to scroll', 5000);
}

// ================================================================================================ UI wiring
$('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFromFile(f); });
const drop = $('loader');
drop.addEventListener('dragover', (e) => { e.preventDefault(); });
drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFromFile(f); });
$('playBtn').addEventListener('click', () => {
  audio.unlock();                       // must happen inside the tap (iOS)
  startGame().catch((err) => { console.error(err); showError(err.message); show('loader', true); });
});
$('otherBtn').addEventListener('click', () => { show('playBox', false); show('pickBox', true); setStatus('', null); });
$('ownBtn').addEventListener('click', () => { if (archiveJob) archiveJob.abort(); show('fetchBox', false); show('pickBox', true); setStatus('', null); });
$('archiveBtn').addEventListener('click', () => loadFromArchive());
$('restartBtn').addEventListener('click', () => location.reload());

$('bZoom').addEventListener('click', () => setPreset(view.preset < 0 ? 1 : (view.preset + 1) % 3));
$('bRight').addEventListener('click', () => setRightArmed(!rightArmed));
$('bKeys').addEventListener('click', () => { if (document.activeElement === kbd) kbd.blur(); else kbd.focus(); });
$('bSound').addEventListener('click', () => {
  const m = !audio.muted; audio.setMuted(m); settings.muted = m; saveSettings();
  $('bSound').classList.toggle('off', m); toast(m ? 'Sound off' : 'Sound on');
});
const fsEl = document.documentElement;
const fsOn = () => document.fullscreenElement || document.webkitFullscreenElement;
if (!(fsEl.requestFullscreen || fsEl.webkitRequestFullscreen) || document.fullscreenEnabled === false) $('bFull').classList.add('hidden');
$('bFull').addEventListener('click', () => {
  if (fsOn()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else { const p = (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl); if (p && p.catch) p.catch(() => {}); }
});
$('bMenu').addEventListener('click', () => { $('optPad').checked = settings.pad; $('optLoupe').checked = settings.loupe; show('menu', true); });
$('menuClose').addEventListener('click', () => show('menu', false));
$('optPad').addEventListener('change', (e) => { settings.pad = e.target.checked; saveSettings(); applyTouchClass(); });
$('optLoupe').addEventListener('change', (e) => { settings.loupe = e.target.checked; saveSettings(); });
// two-step buttons: the first tap asks, the second one does it (embedding frames may suppress confirm() dialogs)
function confirmButton(id, ask, action) {
  const b = $(id), label = b.textContent;
  let timer = 0, armed = false;
  const reset = () => { armed = false; clearTimeout(timer); b.textContent = label; b.classList.remove('danger'); };
  b.addEventListener('click', async () => {
    if (!armed) { armed = true; b.textContent = ask; b.classList.add('danger'); timer = setTimeout(reset, 4500); return; }
    reset();
    try { await action(); } catch (e) { console.error(e); toast('That did not work: ' + (e.message || e)); }
  });
}
confirmButton('mReset', 'Tap again: delete saved games', async () => {
  await store.clearSaves(); try { localStorage.removeItem(SKEY); } catch { /* ignore */ }
  toast('Saved games deleted. Restarting…'); setTimeout(() => location.reload(), 700);
});
confirmButton('mForget', 'Tap again: forget game files', async () => {
  await store.clearGame(); await store.clearSaves(); location.reload();
});

// offline copy of the page + wasm (only where service workers are allowed: https / localhost, not inside sandboxed frames)
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost') && !params.has('nosw')) {
  window.addEventListener('load', () => {
    try { navigator.serviceWorker.register('sw.js').catch((e) => console.info('no service worker:', e.message)); } catch (e) { console.info('no service worker:', e.message); }
  });
}

(async () => {
  requestAnimationFrame(paint);
  layout();
  let wasmOk = false;
  try { wasmOk = !!window.WebAssembly && !!new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); } catch { wasmOk = false; }
  if (!wasmOk) {
    showError('WebAssembly is not available here, so the game cannot start. Open this page directly in a current Chrome, Safari or Firefox (some embedded viewers block it).');
    show('pickBox', false); show('fetchBox', false); return;
  }
  if (typeof DecompressionStream === 'undefined') showError('This browser is too old to unpack the installer (DecompressionStream is missing).');
  try {
    if (await store.hasGame()) {
      setStatus('Loading cached game files…', 0.3);
      await boot(await store.getGame(), true);
      if (params.has('auto')) startGame();
    } else if (params.has('nofetch')) { show('pickBox', true); setStatus('', null); }     // ?nofetch: go straight to the file picker
    else loadFromArchive();
  } catch (err) { console.error(err); showError(err.message); show('pickBox', true); show('playBox', false); show('fetchBox', false); }
})();
