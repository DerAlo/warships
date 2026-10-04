// tests/playwright3d.responsive.mjs -- layout check on small and touch screens: phones held sideways (also with
// the browser bars eating height) and upright, tablets both ways, small laptops. For every size it shots the
// port, the commander sheet, the multiplayer lobby (list, create dialog, room; local test transport), a running
// battle and the battle report, and fails when visible menu tiles or HUD blocks overlap each other, stick out of
// the window, when a control on a touch screen is smaller than a finger (44 px), or when the 3D view comes out
// blank (nearly all white or all black).
// Exit code 1 on a failed check or a console error.
//
// Run:  node server.js 8820   then   URL3D=http://localhost:8820/index-3d.html node tests/playwright3d.responsive.mjs
// ONLY=phone-land runs one size; SHOTS=0 skips the screenshots.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:8820/index-3d.html';
// the lobby runs on the BroadcastChannel test transport: no internet, nothing else changes for the single player game
const PAGE = URL + (URL.includes('?') ? '&' : '?') + 'net=local';
const OUT = process.env.OUT || 'tests/shots/responsive';
const SHOTS = process.env.SHOTS !== '0';
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' && !ok ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};

export const SIZES = [
   { name: 'phone-land', w: 915, h: 412, dpr: 2.625, touch: true },
   { name: 'phone-land-bars', w: 780, h: 330, dpr: 3, touch: true },     // Chrome on Android with address + nav bar
   { name: 'phone-small', w: 640, h: 360, dpr: 2, touch: true },
   { name: 'phone-port', w: 412, h: 860, dpr: 2.625, touch: true },
   { name: 'tablet-land', w: 1180, h: 820, dpr: 2, touch: true },
   { name: 'tablet-port', w: 820, h: 1180, dpr: 2, touch: true },
   { name: 'tablet-android', w: 1280, h: 800, dpr: 1.5, touch: true },
   { name: 'tablet-android-port', w: 800, h: 1232, dpr: 1.5, touch: true },
   { name: 'ipad-mini', w: 1024, h: 768, dpr: 2, touch: true },
   { name: 'tab-a-land', w: 962, h: 601, dpr: 2, touch: true },          // Samsung Galaxy Tab A, Chrome bars included
   { name: 'tab-a-port', w: 601, h: 962, dpr: 2, touch: true },
   { name: 'tab-s-land', w: 1138, h: 712, dpr: 2.25, touch: true },
   { name: 'laptop-small', w: 1280, h: 720, dpr: 1, touch: false },
   { name: 'laptop', w: 1366, h: 768, dpr: 1, touch: false },
];

// visible boxes of the given selectors; pairs that overlap by more than a sliver (and are not nested) fail
const OVERLAP_FN = (sels) => {
   // the part of an element that is really on screen: cut by every scrolling / clipping ancestor
   const clipped = (e) => {
      const r = e.getBoundingClientRect();
      let l = r.left, t = r.top, rt = r.right, b = r.bottom;
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
         const s = getComputedStyle(p);
         if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
            const q = p.getBoundingClientRect();
            l = Math.max(l, q.left); t = Math.max(t, q.top); rt = Math.min(rt, q.right); b = Math.min(b, q.bottom);
         }
      }
      return { left: l, top: t, right: rt, bottom: b, width: rt - l, height: b - t };
   };
   const vis = (e) => {
      if (!e.offsetParent && getComputedStyle(e).position !== 'fixed') return false;
      for (let p = e; p && p !== document.body; p = p.parentElement) {
         const s = getComputedStyle(p);
         if (s.visibility === 'hidden' || +s.opacity < 0.05 || s.display === 'none') return false;
      }
      const r = clipped(e);
      return r.width > 2 && r.height > 2;
   };
   const els = [...new Set(sels.flatMap(s => [...document.querySelectorAll(s)]))].filter(vis);
   const name = (e) => (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + [...e.classList].slice(0, 2).join('.')) + (e.textContent ? ' "' + e.textContent.trim().replace(/\s+/g, ' ').slice(0, 18) + '"' : '');
   const out = [], off = [];
   const W = innerWidth, H = innerHeight;
   for (const e of els) {
      const r = clipped(e);
      if (r.left < -2 || r.top < -2 || r.right > W + 2 || r.bottom > H + 2) off.push(`${name(e)} [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}]`);
   }
   for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      const a = els[i], b = els[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = clipped(a), rb = clipped(b);
      const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ix > 3 && iy > 3) out.push(`${name(a)} x ${name(b)} (${Math.round(ix)}x${Math.round(iy)})`);
   }
   return { n: els.length, overlaps: out, offscreen: off };
};

// visible buttons smaller than a finger (touch screens only)
const SMALL_FN = (sel) => [...document.querySelectorAll(sel)].filter(e => e.offsetParent && getComputedStyle(e).visibility !== 'hidden')
   .map(e => ({ e, r: e.getBoundingClientRect() })).filter(x => x.r.width < 43.5 || x.r.height < 43.5)
   .map(x => (x.e.className || x.e.tagName.toLowerCase()) + ' "' + x.e.textContent.trim().slice(0, 14) + '" ' + Math.round(x.r.width) + 'x' + Math.round(x.r.height));
const MP_SELS = ['.mp button', '.mp input', '.mp select', '.mp .mp-box', '.mp .mp-game', '.mp .mp-player', '.mp .mp-ship'];
const END_SELS = ['#end button', '#end .m3r-title', '#end .m3r-mis', '#end .m3r-earn > div', '#end .m3r-st', '#end .m3r-teams table', '#end .m3r-rw'];
const MENU_SELS = ['#menu button', '#menu .m3-card', '#menu [class*="card"]', '#menu [class*="tile"]', '#menu h1', '#menu h2', '#menu .tabs > *'];
const HUD_SELS = [
   '#scorebox', '#objectives', '#nav', '#minimap-wrap', '#weapons > *', '#cons > *', '#ship-card', '#roster-ally', '#roster-enemy',
   '#tally', '#lock-panel', '#hint-line', '#touch-ui .tu-btn', '#tu-tele', '#tu-rud', '#air-panel', '#sub-panel', '#aa-panel',
];

const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const sz of SIZES) {
   if (process.env.ONLY && !sz.name.includes(process.env.ONLY)) continue;
   const ctx = await browser.newContext({ viewport: { width: sz.w, height: sz.h }, deviceScaleFactor: sz.dpr, hasTouch: sz.touch, isMobile: sz.touch });
   const page = await ctx.newPage();
   const tag = `[${sz.name} ${sz.w}x${sz.h}] `;
   page.on('console', m => { if (m.type() === 'error') errors.push(tag + m.text()); });
   page.on('pageerror', e => errors.push(tag + 'PAGEERROR: ' + e.message));
   await page.addInitScript(() => {
      HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); };
   });
   // Android and iOS have none of the Windows UI fonts (Bahnschrift, Segoe): measure with a wider stand-in
   if (sz.touch) await page.addInitScript(() => {
      const s = document.createElement('style');
      s.textContent = ':root{--font:Arial,sans-serif!important;--font-cond:Arial,sans-serif!important;--mono:Arial,monospace!important}';
      document.addEventListener('DOMContentLoaded', () => document.head.appendChild(s));
   });
   await page.goto(PAGE, { waitUntil: 'load' });
   await page.waitForTimeout(1500);
   if (SHOTS) await page.screenshot({ path: `${OUT}/${sz.name}-1-port.png` });
   let r = await page.evaluate(OVERLAP_FN, MENU_SELS);
   check(tag + `port: no overlapping tiles (${r.n})`, r.overlaps.length === 0, r.overlaps.slice(0, 6));
   check(tag + 'port: nothing outside the window', r.offscreen.length === 0, r.offscreen.slice(0, 6));
   const docW = await page.evaluate(() => document.documentElement.scrollWidth);
   check(tag + 'port: no sideways scrolling', docW <= sz.w + 1, docW);
   const small = async (what, sel) => { if (!sz.touch) return; const s = await page.evaluate(SMALL_FN, sel); check(tag + what + ': touch targets >= 44 px', !s.length, s.slice(0, 6)); };
   const fits = async (what, sels) => {
      const q = await page.evaluate(OVERLAP_FN, sels);
      check(tag + what + ': no overlaps, inside the window (' + q.n + ')', !q.overlaps.length && !q.offscreen.length, [...q.overlaps, ...q.offscreen].slice(0, 6));
   };
   await small('port', '#menu button');

   // the commander sheet (Lehrgänge) over the port
   await page.click('#menu [data-act="captain"]');
   await page.waitForSelector('#menu .m3-cap');
   if (SHOTS) await page.screenshot({ path: OUT + '/' + sz.name + '-1b-captain.png' });
   await fits('kommandant', ['#menu .m3-op button', '#menu .m3-op .t']);
   await small('kommandant', '#menu .m3-op button');
   await page.click('#menu [data-cap="close"]');

   // multiplayer lobby: name prompt, list of games, create dialog, own room; then back to the port
   await page.click('#menu [data-act="mp"]');
   await page.waitForSelector('.mp:not(.hidden) [data-f="pname"]', { timeout: 8000 });
   await page.fill('[data-f="pname"]', 'Testkapitän');
   await page.click('.mp-modal [data-ok]');
   await page.waitForFunction(() => !document.querySelector('.mp-modal') && document.querySelector('.mp-body.list'), null, { timeout: 8000 });
   await page.waitForTimeout(300);
   if (SHOTS) await page.screenshot({ path: OUT + '/' + sz.name + '-1c-lobby.png' });
   await fits('lobby list', MP_SELS);
   await small('lobby list', '.mp button');
   await page.click('.mp [data-act="main"]');
   await page.waitForSelector('.mp-modal [data-f="name"]');
   await fits('lobby create dialog', ['.mp-modal button', '.mp-modal input', '.mp-modal select']);
   await small('lobby create dialog', '.mp-modal button');
   await page.click('.mp-modal [data-ok]');
   await page.waitForSelector('.mp-body.room .mp-player', { timeout: 8000 });
   await page.waitForTimeout(300);
   if (SHOTS) await page.screenshot({ path: OUT + '/' + sz.name + '-1d-room.png' });
   await fits('lobby room', MP_SELS);
   await small('lobby room', '.mp button');
   const docW2 = await page.evaluate(() => document.documentElement.scrollWidth);
   check(tag + 'lobby: no sideways scrolling', docW2 <= sz.w + 1, docW2);
   await page.click('.mp [data-act="back"]');
   await page.waitForSelector('.mp-body.list', { timeout: 8000 });
   await page.click('.mp [data-act="back"]');
   await page.waitForFunction(() => !document.getElementById('menu').classList.contains('hidden'), null, { timeout: 8000 });

   await page.evaluate(() => window.__start({ difficulty: 'easy', mission: 'standard', ship: 'Bismarck' }));
   const t0 = Date.now();
   while (Date.now() - t0 < 8000 && await page.evaluate(() => window.__phase()) !== 'playing') await page.waitForTimeout(100);
   await page.waitForTimeout(2500);
   if (SHOTS) await page.screenshot({ path: `${OUT}/${sz.name}-2-battle.png` });
   r = await page.evaluate(OVERLAP_FN, HUD_SELS);
   check(tag + `battle: no overlapping HUD blocks (${r.n})`, r.overlaps.length === 0, r.overlaps.slice(0, 8));
   check(tag + 'battle: HUD inside the window', r.offscreen.length === 0, r.offscreen.slice(0, 6));
   // blank-scene guard: sample the rendered frame (screenshot pixels, HUD hidden)
   await page.evaluate(() => { document.getElementById('hud').style.visibility = 'hidden'; const t = document.getElementById('touch-ui'); if (t) t.style.visibility = 'hidden'; });
   await page.waitForTimeout(200);
   const png = await page.screenshot({ type: 'jpeg', quality: 60, scale: 'css' });
   await page.evaluate(() => { document.getElementById('hud').style.visibility = ''; const t = document.getElementById('touch-ui'); if (t) t.style.visibility = ''; });
   const stats = await page.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = 64; c.height = 36;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data;
      let white = 0, black = 0, sum = 0, sum2 = 0;
      for (let i = 0; i < d.length; i += 4) {
         const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
         if (l > 235) white++; if (l < 12) black++; sum += l; sum2 += l * l;
      }
      const n = d.length / 4, mean = sum / n;
      return { white: white / n, black: black / n, mean: Math.round(mean), sd: Math.round(Math.sqrt(sum2 / n - mean * mean)) };
   }, png.toString('base64'));
   check(tag + 'battle: 3D view is not blank', stats.white < 0.6 && stats.black < 0.8 && stats.sd > 6, stats);

   // the battle report
   await page.evaluate(() => window.__world().end(true, 'Alle Gegner versenkt.'));
   const shown = await page.waitForFunction(() => !document.getElementById('end').classList.contains('hidden'), null, { timeout: 10000 }).then(() => true, () => false);
   check(tag + 'report: shown after the end', shown);
   await page.waitForTimeout(1500);
   if (SHOTS) await page.screenshot({ path: OUT + '/' + sz.name + '-3-report.png' });
   await fits('report', END_SELS);
   await small('report', '#end button');
   await ctx.close();
}
await browser.close();

const failed = results.filter(r => !r.ok).length;
for (const e of errors.slice(0, 10)) console.log('CONSOLE ERROR ' + e);
console.log(`responsive: ${results.length - failed}/${results.length} checks passed, ${errors.length} console errors`);
process.exit(failed || errors.length ? 1 : 0);
