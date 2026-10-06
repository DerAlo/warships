// tests/playwrightv2.help.mjs -- the "Waffenkunde" of V2 (gamev2/guide.js): the reference sheet from the
// menu, the how-to card and the pause card, the first-use notices of the weapons, the tooltips of the
// weapon slots and the helicopter plate, the cruise line under the chart. On a desktop and on two
// phones (844x390, 667x375 with touch) the notices and the helicopter plate are measured against the
// controls, the minimap, the weapon bar, the hit tally and the middle of the screen.
// Screenshots go to tests/shots/v2-help-*.png. Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8861   then   URLV2=http://localhost:8861/index-v2.html node tests/playwrightv2.help.mjs
//       (ONLY=menu,battle,phone844,phone667 to limit; NO_GPU=1 for software GL)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URLV2 || 'http://localhost:8861/index-v2.html';
const OUT = process.env.OUT || 'tests/shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = k => !ONLY || ONLY.includes(k);
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const GPU = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: GPU });

async function open(tag, { w, h, touch = false }) {
   const ctx = await browser.newContext(touch ? { viewport: { width: w, height: h }, hasTouch: true, isMobile: true } : { viewport: { width: w, height: h } });
   const page = await ctx.newPage();
   page.on('console', m => { if (m.type() === 'error') errors.push(tag + ': ' + m.text().slice(0, 300)); });
   page.on('pageerror', e => errors.push(tag + ' PAGEERROR: ' + e.message + ' ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ')));
   page.on('requestfailed', r => errors.push(tag + ' REQUESTFAILED: ' + r.url()));
   await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
   await page.goto(URL + '?nohint', { waitUntil: 'load' });
   await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 30000 });
   await page.waitForTimeout(700);
   // helpers in the page: what is shown, the notices with their rectangles, a watcher of the tips
   await page.evaluate(() => {
      const vis = e => {
         if (!e) return false;
         const r = e.getBoundingClientRect();
         if (r.width < 3 || r.height < 3) return false;
         for (let n = e; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false; }
         return true;
      };
      window.__vis = s => vis(document.querySelector(s));
      window.__open = id => { const e = document.getElementById(id); return !!e && !e.classList.contains('hidden') && vis(e); };
      window.__rect = s => { const e = typeof s === 'string' ? document.querySelector(s) : s; if (!vis(e)) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map(Math.round); };
      window.__tips = () => [...document.querySelectorAll('#msgs .msg.tip')].filter(m => !m.classList.contains('fade'));
      // the tips seen so far (text + count) and the largest number shown at the same time
      window.__tipLog = { max: 0, seen: [] };
      setInterval(() => {
         const t = [...document.querySelectorAll('#msgs .msg.tip')], L = window.__tipLog;
         L.max = Math.max(L.max, t.length);
         for (const m of t) if (!m._logged) { m._logged = true; L.seen.push(m.textContent); }
      }, 50);
   });
   const S = {
      page, ctx, tag, touch,
      ev: (fn, arg) => page.evaluate(fn, arg),
      wait: ms => page.waitForTimeout(ms),
      key: async k => { await page.keyboard.press(k); await page.waitForTimeout(160); },
      shot: n => page.screenshot({ path: `${OUT}/v2-help-${n}.png` }),
      waitFor: (fn, ms = 4000, arg) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false),
      // a click with the mouse or a tap with the finger on the middle of an element
      tap: async sel => {
         const r = await page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const q = e.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2, w: q.width }; }, sel);
         if (!r || !r.w) return null;
         if (touch) await page.touchscreen.tap(r.x, r.y); else await page.mouse.click(r.x, r.y);
         await page.waitForTimeout(260);
         return r;
      },
   };
   S.start = async (mission, ship) => {
      await S.ev(o => window.__start({ mission: o.mission, ship: o.ship, difficulty: 'normal' }), { mission, ship });
      await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 30000 });
      await S.ev(() => { clearInterval(window.__hp); window.__hp = setInterval(() => { const p = window.__world()?.player; if (p && p.alive && p.maxHP) p.hp = p.maxHP; }, 200); });
   };
   return S;
}

const pickShip = async (S, key) => {
   await S.ev(k => { document.querySelector('[data-nat="all"]')?.click(); document.querySelector(`[data-ship="${k}"]`)?.click(); }, key);
   await S.wait(350);
   return S.ev(() => document.querySelector('.m3-card.sel')?.dataset.ship || null);
};
// the sheet as it is shown: entry ids in order, which carry "AN BORD", the headings
const sheet = S => S.ev(async () => {
   const G = await import('./gamev2/guide.js');
   const g = document.getElementById('guide'), es = [...g.querySelectorAll('.gd-e')];
   const card = g.querySelector('.card'), btn = g.querySelector('#btn-guide-close');
   return { open: window.__open('guide'), all: G.GUIDE.map(e => e.id), ids: es.map(e => e.dataset.g), on: es.filter(e => e.classList.contains('on')).map(e => e.dataset.g),
      secs: [...g.querySelectorAll('.gd-sec')].map(e => e.textContent), sub: g.querySelector('.gd-sub').textContent,
      empty: es.filter(e => e.textContent.trim().length < 60 || /undefined|NaN|null/.test(e.textContent)).map(e => e.dataset.g),
      scroll: [card.scrollHeight, card.clientHeight], btn: !!btn };
});
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
// the sheet on a small screen: it scrolls, nothing is wider than the screen, the close button is reached at the end
const sheetScroll = S => S.ev(async () => {
   const g = document.getElementById('guide'), card = g.querySelector('.card'), btn = g.querySelector('#btn-guide-close');
   const wide = [...g.querySelectorAll('.gd-e, .gd-h, .gd-k, .title, .gd-sub')].filter(e => { const r = e.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1 || e.scrollWidth > e.clientWidth + 2; }).length;
   const out = { h: [card.scrollHeight, card.clientHeight], top0: card.scrollTop, wide, hscroll: document.documentElement.scrollWidth > innerWidth + 1 || card.scrollWidth > card.clientWidth + 2 };
   card.scrollTop = card.scrollHeight;
   await new Promise(r => setTimeout(r, 200));
   const r = btn.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
   out.moved = card.scrollTop > 0; out.btn = [r.left, r.top, r.right, r.bottom].map(Math.round);
   out.inView = r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1; out.onTop = hit === btn; out.size = [Math.round(r.width), Math.round(r.height)];
   return out;
});

// Rectangles of the newest tip (cut to the notice box and the column that clip it) and of what it must keep clear of.
const tipLayout = S => S.ev(() => {
   const tip = window.__tips().pop();
   if (!tip) return { tip: null };
   const r = tip.getBoundingClientRect(); let l = r.left, t = r.top, R = r.right, b = r.bottom, clipped = 0;
   for (const box of [tip.closest('#msgs'), tip.closest('#tu-hud-l, #tu-hud-r')]) {
      if (!box) continue;
      const c = box.getBoundingClientRect();
      clipped = Math.max(clipped, c.top - t, b - c.bottom, c.left - l, R - c.right);
      l = Math.max(l, c.left); t = Math.max(t, c.top); R = Math.min(R, c.right); b = Math.min(b, c.bottom);
   }
   const a = [l, t, R, b];
   const cx = innerWidth / 2, cy = innerHeight / 2;
   const others = { centre: [cx - 80, cy - 60, cx + 80, cy + 60] };
   for (const s of ['#tu-fire', '#tu-scope', '#tu-lock', '#tu-free', '#minimap-wrap', '#weapons', '#tally', '#mx-sys', '#lock-panel', '#objectives', '#ship-card', '#cons', '#tu-tele', '#tu-rud']) { const q = window.__rect(s); if (q) others[s] = q; }
   document.querySelectorAll('#ops-panel .ops-plate').forEach((e, i) => { const q = window.__rect(e); if (q) others['.ops-plate[' + i + ']'] = q; });
   const hits = [];
   for (const [s, q] of Object.entries(others)) { const ox = Math.min(a[2], q[2]) - Math.max(a[0], q[0]), oy = Math.min(a[3], q[3]) - Math.max(a[1], q[1]); if (ox > 2 && oy > 2) hits.push(s + ' ' + Math.round(ox) + 'x' + Math.round(oy)); }
   const cs = getComputedStyle(tip);
   return { tip: a.map(Math.round), text: tip.textContent, n: window.__tips().length, hits, clipped: Math.round(clipped), out: a[0] < -1 || a[1] < -1 || a[2] > innerWidth + 1 || a[3] > innerHeight + 1,
      cut: tip.scrollHeight - tip.clientHeight > 2 || tip.scrollWidth - tip.clientWidth > 2, font: cs.fontSize, where: tip.closest('#tu-hud-l, #tu-hud-r')?.id || 'hud', seen: others.centre && Object.keys(others).length };
});
const tipOk = L => !!L.tip && L.n === 1 && !L.hits.length && L.clipped <= 1 && !L.out && !L.cut;

// the helicopter plate against the controls, with the line of this change and with the line it had before
const heloPlate = S => S.ev(async () => {
   const pl = document.querySelector('#ops-panel .ops-helo'), sub = pl?.querySelector('.ops-sub');
   if (!pl || !window.__rect(pl)) return { plate: null };
   const others = {};
   for (const s of ['#tu-fire', '#tu-scope', '#tu-lock', '#tu-free', '#minimap-wrap', '#weapons', '#tally', '#mx-sys', '#cons', '#ship-card', '#tu-tele', '#tu-rud']) { const q = window.__rect(s); if (q) others[s] = q; }
   const measure = () => {
      const a = window.__rect(pl), hits = [];
      for (const [s, q] of Object.entries(others)) { const ox = Math.min(a[2], q[2]) - Math.max(a[0], q[0]), oy = Math.min(a[3], q[3]) - Math.max(a[1], q[1]); if (ox > 2 && oy > 2) hits.push(s + ' ' + ox + 'x' + oy); }
      return { rect: a, hits, out: a[0] < -1 || a[1] < -1 || a[2] > innerWidth + 1 || a[3] > innerHeight + 1, cut: sub.scrollWidth - sub.clientWidth > 2 || pl.scrollWidth - pl.clientWidth > 2 };
   };
   const now = measure(), text = sub.textContent;
   sub.textContent = 'Einsätze 2 · Torpedos 2';                 // the line the plate showed on deck before
   await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
   const before = measure();
   sub.textContent = text;
   return { plate: now.rect, title: pl.title, sub: text, stat: pl.querySelector('.ops-stat').textContent, hits: now.hits, out: now.out, cut: now.cut, before: before.rect, hitsBefore: before.hits };
});
// the line under the chart as hud3d.js draws it: its text and where it ends
const chartHint = S => S.ev(async () => {
   const M = await import('./gamev2/missileui.js'), Th = await import('./gamev2/theme.js');
   const text = M.mapTargetHint({ mx: window.__mui().ui });
   const { x0, size } = M.tacticalMapRect(innerWidth, innerHeight);
   const g = document.createElement('canvas').getContext('2d');
   g.font = Th.FONT(size < 420 ? 11 : 13, 'bold');
   const w = g.measureText(text).width;
   return { text, mapOpen: window.__ctl().mapOpen, sel: window.__weaponSel(), x0: Math.round(x0), size: Math.round(size), end: Math.round(x0 + w), width: innerWidth, font: g.font };
});

// ------------------------------------------------------------------ menu: the sheet from the ship panel and the how-to card
if (want('menu')) {
   const S = await open('menu', { w: 1600, h: 900 }), T = 'menu: ';
   const sel = await pickShip(S, 'Sachsen');
   const btn = await S.ev(() => { const b = document.querySelector('[data-act="guide"]'); return { vis: window.__vis('[data-act="guide"]'), text: b?.textContent || '', rect: window.__rect('[data-act="guide"]') }; });
   check(T + 'ship panel of the Sachsen has the Waffenkunde button', sel === 'Sachsen' && btn.vis && /WAFFENKUNDE/.test(btn.text), { sel, btn });
   await S.shot('menu-1600');
   await S.tap('[data-act="guide"]');
   let G = await sheet(S);
   check(T + 'the button opens the sheet', G.open && G.btn, { open: G.open });
   check(T + 'the sheet has an entry for every id of GUIDE, none empty', sameSet(G.ids, G.all) && !G.empty.length, { n: G.ids.length, missing: G.all.filter(x => !G.ids.includes(x)), empty: G.empty });
   check(T + 'Sachsen: Seezielflugkörper, Luftabwehr and Bordhubschrauber are "an Bord"', ['ssm', 'sam', 'helo'].every(x => G.on.includes(x)) && !G.on.includes('cruise') && !G.on.includes('torp') && /Sachsen/.test(G.secs[0] || ''), { on: G.on, secs: G.secs });
   check(T + 'the entries on board come first', G.ids.slice(0, G.on.length).every(x => G.on.includes(x)), G.ids.slice(0, G.on.length + 1));
   await S.shot('guide-top-1600');
   await S.ev(() => { const c = document.querySelector('#guide .card'); c.scrollTop = c.scrollHeight; });
   await S.wait(200);
   await S.shot('guide-end-1600');
   await S.key('Escape'); await S.wait(700);
   check(T + 'Esc closes the sheet and does not start a battle', !(await S.ev(() => window.__open('guide'))) && await S.ev(() => window.__phase()) === 'menu', await S.ev(() => window.__phase()));
   await S.tap('[data-act="guide"]');
   await S.key('Enter'); await S.wait(900);
   check(T + 'Enter closes the sheet and does not cast off', !(await S.ev(() => window.__open('guide'))) && await S.ev(() => window.__phase()) === 'menu', await S.ev(() => window.__phase()));

   const sel2 = await pickShip(S, 'Braunschweig');
   await S.tap('[data-act="guide"]');
   G = await sheet(S);
   check(T + 'Braunschweig: no helicopter "an Bord", the entry is still listed', sel2 === 'Braunschweig' && G.open && !G.on.includes('helo') && G.ids.includes('helo') && G.on.includes('ssm'), { sel2, on: G.on });
   await S.tap('#btn-guide-close');
   check(T + 'the button "Verstanden" closes the sheet', !(await S.ev(() => window.__open('guide'))));

   await S.tap('[data-act="help"]');
   const how = await S.ev(() => ({ how: window.__open('howto'), btn: window.__vis('#btn-how-guide') }));
   await S.shot('howto-1600');
   await S.tap('#btn-how-guide');
   G = await sheet(S);
   check(T + 'the how-to card has the button and it opens the sheet in its place', how.how && how.btn && G.open && !(await S.ev(() => window.__open('howto'))) && sameSet(G.ids, G.all), { how, open: G.open });
   await S.key('Escape'); await S.wait(500);
   check(T + 'Esc closes it again, still in the menu', !(await S.ev(() => window.__open('guide'))) && await S.ev(() => window.__phase()) === 'menu');
   check(T + 'no tip was shown in the menu', (await S.ev(() => window.__tipLog.seen.length)) === 0);
   check(T + 'no console errors', errors.length === 0, errors.slice(0, 3));
   await S.ctx.close();
}

// ------------------------------------------------------------------ battle on a desktop: notices, tooltips, chart line, pause
if (want('battle')) {
   const e0 = errors.length;
   const S = await open('battle', { w: 1600, h: 900 }), T = 'battle: ';
   await S.start('training', 'Burke');
   // the first seconds: no notice
   let early = 0;
   for (let i = 0; i < 8; i++) { await S.wait(300); early += await S.ev(() => window.__tips().length); }
   check(T + 'no tip in the first seconds of the battle', early === 0 && (await S.ev(() => window.__tipLog.seen.length)) === 0, await S.ev(() => window.__world().time.toFixed(1) + ' s'));

   // tooltips of the weapon slots and the helicopter plate
   const tt = await S.ev(() => ({ slots: [...document.querySelectorAll('#weapons .wslot')].filter(e => window.__rect(e)).map(e => ({ k: e.dataset.key || e.dataset.w, t: e.title })),
      helo: document.querySelector('#ops-panel .ops-helo')?.title || '', sub: document.querySelector('#ops-panel .ops-helo .ops-sub')?.textContent || '', stat: document.querySelector('#ops-panel .ops-helo .ops-stat')?.textContent || '' }));
   const tip = k => tt.slots.find(s => s.k === k)?.t || '';
   check(T + 'every weapon slot has a tooltip', tt.slots.length >= 3 && tt.slots.every(s => s.t.length > 30), tt.slots.map(s => s.k + ':' + s.t.length));
   check(T + 'the tooltips say what the weapon is for', /Sichtweite/.test(tip('1')) && /Harpoon/.test(tip('2')) && /gegen Schiffe jenseits der Geschützreichweite/.test(tip('2')) && /Tomahawk/.test(tip('3')) && /Landstellungen/.test(tip('3')) && /Fahrende Schiffe trifft er nicht/.test(tip('3')),
      [tip('1').split('\n')[0], tip('2').split('\n')[0], tip('3').split('\n')[0]]);
   check(T + 'the helicopter plate has a tooltip and says "U-Jagd" while the helicopter is on deck', /jagt U-Boote/.test(tt.helo) && /Gegen Schiffe wirkungslos/.test(tt.helo) && /U-Jagd/.test(tt.sub) && /I: Start voraus/.test(tt.sub), { sub: tt.sub, stat: tt.stat, title: tt.helo.split('\n')[0] });

   // weapon 2 for the first time: one notice with the name of the missile
   await S.key('Digit2');
   const got = await S.waitFor(() => window.__tips().length > 0, 3000);
   await S.wait(250);
   let L = await tipLayout(S);
   check(T + 'selecting weapon 2 shows one tip that names the missile', got && L.n === 1 && /Harpoon/.test(L.text) && /gegen Schiffe/.test(L.text) && /mit X erfassen/.test(L.text), L.text);
   check(T + 'the tip keeps clear of the middle of the screen, the weapon bar and the plates', tipOk(L), { tip: L.tip, hits: L.hits, clipped: L.clipped, cut: L.cut });
   await S.shot('tip-ssm-1600');
   const gone = await S.waitFor(() => document.querySelectorAll('#msgs .msg.tip').length === 0, 14000);
   check(T + 'the tip goes away by itself', gone);

   // the helicopter notice comes by itself, after the gap
   const helo = await S.waitFor(() => window.__tips().some(m => /Hubschrauber/.test(m.textContent)), 12000);
   await S.wait(250);
   L = await tipLayout(S);
   check(T + 'the helicopter tip comes by itself', helo && L.n === 1 && /jagt nur U-Boote/.test(L.text) && /I: Start voraus/.test(L.text), L.text);
   check(T + 'the helicopter tip keeps clear too', tipOk(L), { tip: L.tip, hits: L.hits, clipped: L.clipped, cut: L.cut });
   await S.shot('tip-helo-1600');
   await S.waitFor(() => document.querySelectorAll('#msgs .msg.tip').length === 0, 14000);

   // weapon 2 again: nothing new
   await S.key('Digit1'); await S.wait(300); await S.key('Digit2'); await S.wait(2500);
   let log = await S.ev(() => window.__tipLog);
   check(T + 'selecting weapon 2 again shows no second tip', log.seen.filter(t => /Harpoon/.test(t)).length === 1 && log.seen.length === 2, log.seen.map(t => t.slice(0, 24)));

   // weapon 3: the chart with the cruise line
   await S.key('Digit3');
   await S.waitFor(() => window.__ctl().mapOpen && window.__weaponSel() === 'cruise', 3000);
   await S.wait(500);
   const H = await chartHint(S);
   check(T + 'weapon 3 opens the chart, the line under it says what the cruise missile is for', H.mapOpen && H.sel === 'cruise' && H.text === 'MARSCHFLUGKÖRPER – Landstellung oder Punkt im Ring anklicken  ·  fahrende Schiffe trifft er nicht', H);
   check(T + 'the chart line fits the screen', H.end <= H.width - 4, { end: H.end, width: H.width });
   await S.wait(2500);
   check(T + 'no tip lies over the open chart', (await S.ev(() => window.__ctl().mapOpen && window.__tips().length)) === 0);
   await S.shot('chart-cruise-1600');
   if (await S.ev(() => window.__ctl().mapOpen)) await S.key('KeyM');
   const shut = await S.waitFor(() => !window.__ctl().mapOpen, 3000);
   const cr = await S.waitFor(() => window.__tips().some(m => /Tomahawk/.test(m.textContent)), 16000);
   await S.wait(250);
   L = await tipLayout(S);
   check(T + 'the cruise tip comes once the chart is closed and names the missile and what it is for', shut && cr && L.n === 1 && /gegen Landstellungen/.test(L.text) && /anklicken/.test(L.text) && tipOk(L), { text: L.text, tip: L.tip, hits: L.hits });
   await S.shot('tip-cruise-1600');
   await S.key('Digit1'); await S.wait(300);
   log = await S.ev(() => window.__tipLog);
   check(T + 'never more than one tip at a time, each one once', log.max === 1 && log.seen.length === 3 && new Set(log.seen).size === 3, { max: log.max, seen: log.seen.map(t => t.slice(0, 24)) });

   // pause: the sheet with the systems of this ship first; Esc closes the sheet only
   if (await S.ev(() => window.__ctl().mapOpen)) { await S.key('KeyM'); await S.wait(300); }
   await S.key('KeyP');
   const paused = await S.waitFor(() => window.__phase() === 'paused' && window.__open('pause'), 3000);
   await S.wait(500);
   const hint = await S.ev(() => { const h = document.querySelector('#pause .hint'), b = document.getElementById('btn-guide'), lh = parseFloat(getComputedStyle(h).lineHeight) || parseFloat(getComputedStyle(h).fontSize) * 1.3;
      return { btn: window.__vis('#btn-guide'), lines: Math.round(h.getBoundingClientRect().height / lh), text: h.textContent.trim(), rect: window.__rect(b) }; });
   check(T + 'the pause card has the Waffenkunde button, its line is not broken up', paused && hint.btn && hint.lines <= 1, hint);
   await S.shot('pause-1600');
   await S.tap('#btn-guide');
   const G = await sheet(S);
   const wantOn = await S.ev(async () => { const G = await import('./gamev2/guide.js'), C = await import('./gamev2/config.js'); return G.GUIDE.filter(e => e.has(C.SHIPS.Burke)).map(e => e.id); });
   check(T + 'the button opens the sheet with the systems of the Burke first', G.open && sameSet(G.on, wantOn) && G.ids.slice(0, wantOn.length).every(x => wantOn.includes(x)) && ['ssm', 'cruise', 'helo', 'sam'].every(x => G.on.includes(x)) && sameSet(G.ids, G.all) && /Burke/.test(G.secs[0] || ''), { on: G.on, secs: G.secs });
   await S.shot('pause-guide-1600');
   await S.wait(500);
   await S.key('Escape'); await S.wait(800);
   const after = await S.ev(() => ({ guide: window.__open('guide'), pause: window.__open('pause'), phase: window.__phase() }));
   check(T + 'Esc closes the sheet only: the pause card stays', !after.guide && after.pause && after.phase === 'paused', after);
   await S.key('Escape');
   check(T + 'Esc again resumes the battle', await S.waitFor(() => window.__phase() === 'playing' && !window.__open('pause'), 3000), await S.ev(() => window.__phase()));
   check(T + 'no console errors', errors.length === e0, errors.slice(e0, e0 + 3));
   await S.ctx.close();
}

// ------------------------------------------------------------------ phones: the notices and the plate against the controls
for (const [w, h] of [[844, 390], [667, 375]]) {
   if (!want('phone' + w)) continue;
   const e0 = errors.length, sz = w + 'x' + h, T = 'phone ' + sz + ': ';
   const S = await open('phone' + w, { w, h, touch: true });

   // menu: the button is there and reachable, the sheet scrolls to its close button
   await pickShip(S, 'Sachsen');
   await S.shot('menu-' + sz);
   // (a phone shows the ship file on its own pane: the button adds nothing to the first view)
   check(T + 'menu: the first view is not more crowded, the button waits on the ship pane', !(await S.ev(() => window.__vis('[data-act="guide"]'))));
   await S.tap('.m3-rail [data-pane="ship"]');
   const mb = await S.ev(() => { const b = document.querySelector('[data-act="guide"]'); if (!b || !window.__vis('[data-act="guide"]')) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect();
      const fs = parseFloat(getComputedStyle(b).fontSize), pane = b.closest('.m3-ship')?.getBoundingClientRect();
      return { rect: [r.left, r.top, r.right, r.bottom].map(Math.round), h: Math.round(r.height), fs, cut: b.scrollWidth - b.clientWidth > 2 || b.scrollHeight - b.clientHeight > 2,
         inPane: !pane || (r.left >= pane.left - 1 && r.right <= pane.right + 1), hscroll: document.documentElement.scrollWidth > innerWidth + 1 }; });
   check(T + 'menu: the Waffenkunde button on the ship pane is one line, inside its pane, nothing scrolls sideways', !!mb && mb.rect[0] >= 0 && mb.rect[2] <= w + 1 && mb.inPane && mb.h >= 40 && mb.h <= 48 && !mb.cut && !mb.hscroll, mb);
   await S.shot('menu-button-' + sz);
   await S.tap('[data-act="guide"]');
   let G = await sheet(S);
   check(T + 'menu: a tap opens the sheet, every entry is there', G.open && sameSet(G.ids, G.all) && G.on.includes('helo'), { open: G.open, n: G.ids.length });
   const tapTxt = await S.ev(() => ({ helo: document.querySelector('#guide [data-g="helo"] .gd-k')?.textContent || '', lock: document.querySelector('#guide [data-g="lock"] .gd-k')?.textContent || '' }));
   check(T + 'the sheet names the touch controls, not the keys', /antippen/.test(tapTxt.helo) && /Knopf Ziel/.test(tapTxt.lock) && !/Taste/.test(tapTxt.helo + tapTxt.lock), tapTxt);
   await S.shot('guide-top-' + sz);
   let sc = await sheetScroll(S);
   check(T + 'the sheet scrolls and its close button is reached at the end', sc.h[0] > sc.h[1] + 50 && sc.moved && sc.inView && sc.onTop && sc.size[1] >= 40, sc);
   check(T + 'nothing in the sheet is wider than the screen', !sc.wide && !sc.hscroll, { wide: sc.wide, hscroll: sc.hscroll });
   await S.shot('guide-end-' + sz);
   await S.tap('#btn-guide-close');
   check(T + 'the close button closes the sheet, still in the menu', !(await S.ev(() => window.__open('guide'))) && await S.ev(() => window.__phase()) === 'menu');

   // battle
   await S.start('training', 'Burke');
   await S.wait(1800);
   check(T + 'touch controls are up', await S.ev(() => window.__touch().shown));
   const P = await heloPlate(S);
   check(T + 'helicopter plate: says "U-Jagd" on deck and how to send it', !!P.plate && /U-Jagd/.test(P.sub) && /antippen/.test(P.sub) && P.title.length > 30, { sub: P.sub, stat: P.stat });
   check(T + 'helicopter plate: clear of the fire controls, the minimap, the weapon bar and the tally, nothing cut', !!P.plate && !P.hits.length && !P.out && !P.cut, { plate: P.plate, before: P.before, hits: P.hits, hitsBefore: P.hitsBefore });
   await S.shot('plate-' + sz);

   await S.tap('#weapons .wslot[data-key="2"]');
   const got = await S.waitFor(() => window.__tips().length > 0, 3000);
   await S.wait(300);
   let L = await tipLayout(S);
   check(T + 'weapon 2: one tip that names the missile, in touch words', got && L.n === 1 && /Harpoon/.test(L.text) && !/mit X/.test(L.text), L.text);
   check(T + 'the tip is whole and clear of the fire buttons, the minimap, the weapon bar, the tally and the middle', tipOk(L), { tip: L.tip, where: L.where, hits: L.hits, clipped: L.clipped, cut: L.cut, font: L.font });
   await S.shot('tip-ssm-' + sz);
   await S.waitFor(() => document.querySelectorAll('#msgs .msg.tip').length === 0, 14000);
   const helo = await S.waitFor(() => window.__tips().some(m => /Hubschrauber/.test(m.textContent)), 12000);
   await S.wait(300);
   L = await tipLayout(S);
   check(T + 'the helicopter tip comes by itself and names the plate to tap', helo && L.n === 1 && /Feld HUBSCHRAUBER antippen/.test(L.text), L.text);
   check(T + 'the helicopter tip is whole and clear of the controls too', tipOk(L), { tip: L.tip, hits: L.hits, clipped: L.clipped, cut: L.cut });
   await S.shot('tip-helo-' + sz);
   await S.waitFor(() => document.querySelectorAll('#msgs .msg.tip').length === 0, 14000);

   // the chart with the cruise line
   await S.tap('#weapons .wslot[data-key="3"]');
   await S.waitFor(() => window.__ctl().mapOpen && window.__weaponSel() === 'cruise', 3000);
   await S.wait(500);
   const H = await chartHint(S);
   check(T + 'weapon 3 opens the chart with the cruise line', H.mapOpen && H.sel === 'cruise' && H.text === 'MARSCHFLUGKÖRPER – Landstellung oder Punkt im Ring antippen', H);
   check(T + 'the chart line fits inside the screen', H.x0 >= 0 && H.end <= H.width - 4, { x0: H.x0, end: H.end, width: H.width, font: H.font });
   await S.wait(2500);
   check(T + 'no tip lies over the open chart', (await S.ev(() => window.__ctl().mapOpen && window.__tips().length)) === 0);
   await S.shot('chart-cruise-' + sz);
   if (await S.ev(() => window.__vis('#tu-chartx'))) await S.tap('#tu-chartx');
   const shut = await S.waitFor(() => !window.__ctl().mapOpen, 3000);
   const cr = await S.waitFor(() => window.__tips().some(m => /Tomahawk/.test(m.textContent)), 16000);
   await S.wait(300);
   L = await tipLayout(S);
   check(T + 'the cruise tip comes once the chart is closed and is whole and clear of the controls', shut && cr && L.n === 1 && /antippen/.test(L.text) && tipOk(L), { text: L.text, tip: L.tip, hits: L.hits, clipped: L.clipped });
   await S.shot('tip-cruise-' + sz);
   await S.tap('#weapons .wslot[data-key="1"]');
   await S.wait(300);
   const log = await S.ev(() => window.__tipLog);
   check(T + 'never more than one tip at a time, each one once', log.max === 1 && log.seen.length === 3 && new Set(log.seen).size === 3, { max: log.max, seen: log.seen.map(t => t.slice(0, 24)) });

   // pause: the button, the sheet over the card, back to the card
   if (await S.ev(() => window.__ctl().mapOpen)) { await S.tap('#minimap-wrap'); await S.wait(300); }
   await S.tap('#tu-pause');
   const paused = await S.waitFor(() => window.__phase() === 'paused' && window.__open('pause'), 3000);
   await S.wait(400);
   const pb = await S.ev(() => { const b = document.getElementById('btn-guide'); b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { rect: [r.left, r.top, r.right, r.bottom].map(Math.round), h: Math.round(r.height), inView: r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1, onTop: hit === b }; });
   check(T + 'pause: the Waffenkunde button is reachable and at least 40 px high', paused && pb.inView && pb.onTop && pb.h >= 40, pb);
   await S.shot('pause-' + sz);
   await S.tap('#btn-guide');
   G = await sheet(S);
   check(T + 'pause: a tap opens the sheet with the systems of the Burke first', G.open && ['ssm', 'cruise', 'helo'].every(x => G.on.includes(x)) && G.ids.slice(0, G.on.length).every(x => G.on.includes(x)) && /Burke/.test(G.secs[0] || ''), { on: G.on, secs: G.secs });
   await S.shot('pause-guide-' + sz);
   sc = await sheetScroll(S);
   check(T + 'pause: the sheet scrolls to its close button', sc.moved && sc.inView && sc.onTop && !sc.wide && !sc.hscroll, sc);
   await S.wait(300);
   await S.tap('#btn-guide-close');
   const after = await S.ev(() => ({ guide: window.__open('guide'), pause: window.__open('pause'), phase: window.__phase() }));
   check(T + 'pause: closing the sheet leaves the pause card up', !after.guide && after.pause && after.phase === 'paused', after);
   check(T + 'no console errors', errors.length === e0, errors.slice(e0, e0 + 3));
   await S.ctx.close();
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of errors.slice(0, 12)) console.log('  ERR ' + e);
process.exit(failed.length || errors.length ? 1 : 0);
