// tests/playwrightv2.phone.mjs -- phone layout of V2 (index-v2.html) in every operation.
// At 844x390 with touch each of the ten operations is started (countdown with a surface ship and
// with a submarine) and the HUD is measured in three states: right after the start (objectives
// fresh), busy (a locked target and a full message stack) and under attack (incoming missiles, the
// VAMPIRE plate). Checked by rectangles: no plate overlaps another or a control, nothing leaves the
// screen, nothing is cut off by its column, every touch button is at least 40 px. A lighter pass at
// 390x844 checks the "turn the device" veil. Screenshots go to tests/shots/v2-phone-*.png.
// Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8839   then   URLV2=http://localhost:8839/index-v2.html node tests/playwrightv2.phone.mjs
//       (ONLY=hormus,pipeline,... or ONLY=upright to limit; NO_GPU=1 for software GL)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URLV2 || 'http://localhost:8839/index-v2.html';
const OUT = process.env.OUT || 'tests/shots';
const SCENES = [
   ['hormus', 'Sachsen'], ['redsea', 'Burke'], ['pipeline', 'U212'], ['blacksea', 'Sachsen'], ['giuk', 'Sachsen'],
   ['barents', 'Ford'], ['reefs', 'Burke'], ['strait', 'Sachsen'], ['philsea', 'Ford'], ['countdown', 'Ticonderoga'], ['countdown', 'Virginia'],
];
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

async function open(tag, { w, h, mission, ship }) {
   const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
   const page = await ctx.newPage();
   page.on('console', m => { if (m.type() === 'error') errors.push(tag + ': ' + m.text().slice(0, 300)); });
   page.on('pageerror', e => errors.push(tag + ' PAGEERROR: ' + e.message + ' ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ')));
   page.on('requestfailed', r => errors.push(tag + ' REQUESTFAILED: ' + r.url()));
   await page.goto(URL + '?nohint', { waitUntil: 'load' });
   await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 30000 });
   const S = {
      page, ctx, tag,
      ev: (fn, arg) => page.evaluate(fn, arg),
      wait: ms => page.waitForTimeout(ms),
      shot: n => page.screenshot({ path: `${OUT}/v2-phone-${n}.png` }),
      waitFor: (fn, ms = 4000, arg) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false),
      tap: async sel => {
         const r = await page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const q = e.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2, w: q.width }; }, sel);
         if (!r || !r.w) return null;
         await page.touchscreen.tap(r.x, r.y); await page.waitForTimeout(220);
         return r;
      },
   };
   if (mission) {
      await S.ev(o => window.__start({ mission: o.mission, ship: o.ship, difficulty: 'normal' }), { mission, ship });
      await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 30000 });
      await S.wait(1800);
   }
   return S;
}

// Every visible HUD plate, message line and touch control with its rectangle (cut to the column that
// clips it). Reports pairs that intersect by more than 2 px, plates outside the screen, plates cut
// off by their column and tap targets under 40 px.
const layout = S => S.ev(() => {
   const one = ['#objectives', '#mx-threat', '#lock-panel', '#weapons', '#mx-sys', '#cons', '#asw-panel', '#sub-panel', '#air-panel', '#aa-panel',
      '#minimap-wrap', '#scorebox', '#ship-card', '#tally', '#killfeed', '#torp-alert', '#dc-alert', '#tu-tele', '#tu-rud', '#tu-fire', '#tu-scope', '#tu-lock', '#tu-free'];
   const many = ['#msgs .msg', '#ops-panel .ops-plate', '.tu-sys .tu-btn', '#tu-col .tu-btn', '#tu-bar .tu-btn'];
   const vis = e => {
      if (!e) return false;
      const r = e.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) return false;
      for (let n = e; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false; }
      return true;
   };
   const boxes = [], cut = [];
   const add = (s, e) => {
      if (!vis(e)) return;
      const r = e.getBoundingClientRect(); let l = r.left, t = r.top, R = r.right, b = r.bottom;
      const col = e.closest('#tu-hud-l, #tu-hud-r');
      if (col && col !== e) {
         const c = col.getBoundingClientRect();
         // (the hit tally and the loss reports are the columns' low-priority plates: they give way to the notices by design)
         if (!/tally|killfeed/.test(s) && (b - c.bottom > 3 || R - c.right > 3 || c.left - l > 3)) cut.push(s + ' by ' + Math.round(Math.max(b - c.bottom, R - c.right, c.left - l)) + 'px');
         l = Math.max(l, c.left); t = Math.max(t, c.top); R = Math.min(R, c.right); b = Math.min(b, c.bottom);
         if (R - l < 3 || b - t < 3) return;
      }
      // content that does not fit inside its own plate (scrolled or clipped text)
      if (e.scrollHeight - e.clientHeight > 3 && getComputedStyle(e).overflowY !== 'visible') cut.push(s + ' content +' + (e.scrollHeight - e.clientHeight) + 'px');
      boxes.push({ s, l, t, r: R, b });
   };
   for (const s of one) add(s, document.querySelector(s));
   for (const s of many) [...document.querySelectorAll(s)].forEach((e, i) => add(s.split(' ').pop() + '[' + (e.id || e.dataset.key || e.dataset.k || i) + ']', e));
   const hits = [], out = [];
   for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.l < -1 || a.t < -1 || a.r > innerWidth + 1 || a.b > innerHeight + 1) out.push(a.s);
      for (let j = i + 1; j < boxes.length; j++) {
         const b = boxes[j];
         if (a.s.startsWith('.msg') && b.s.startsWith('.msg')) continue;
         const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l), oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
         if (ox > 2 && oy > 2) hits.push(a.s + ' x ' + b.s + ' ' + Math.round(ox) + 'x' + Math.round(oy));
      }
   }
   const taps = [...document.querySelectorAll('#touch-ui .tu-btn, #weapons .wslot, #cons .cslot, #mx-sys [data-key], #ops-panel [data-key], #tu-tele .tu-st, #tu-tele .tu-sq, #tu-rud')]
      .filter(vis).map(e => { const r = e.getBoundingClientRect(); return { k: e.id || e.dataset.w || e.dataset.key || e.dataset.slot || e.dataset.k || e.dataset.n || e.className, w: Math.round(r.width), h: Math.round(r.height) }; });
   // the newest notice must be readable in full (the stack clips the oldest first)
   const mb = document.getElementById('msgs'), last = mb?.lastElementChild;
   if (last && vis(last)) { const a = mb.getBoundingClientRect(), b = last.getBoundingClientRect(); if (b.top < a.top - 1 || b.bottom > a.bottom + 1 || b.left < a.left - 1 || b.right > a.right + 1) cut.push('newest notice clipped'); }
   const obj = document.getElementById('objectives');
   return { shown: boxes.map(b => b.s), hits, out, cut, small: taps.filter(t => t.w < 40 || t.h < 40), taps: taps.length,
      objFresh: !!obj?.classList.contains('tu-fresh'), objLines: obj ? obj.children.length : 0,
      rects: Object.fromEntries(boxes.map(b => [b.s, [b.l, b.t, b.r, b.b].map(Math.round)])) };
});

// a spotted enemy ship 5 km ahead, the view on it: the lock button finds it
const enemyAhead = S => S.ev(() => {
   const w = window.__world(), p = w.player;
   const T = w.ships.find(s => s.alive && s.side !== p.side && !s.cfg?.submarine && !(s.depth > 0));
   if (!T) return null;
   const put = () => { T.pos.x = p.pos.x + Math.cos(p.heading) * 5000; T.pos.y = p.pos.y + Math.sin(p.heading) * 5000; T.detected = true; T.visible = true; T.spotted = true; };
   put(); clearInterval(window.__keep); window.__keep = setInterval(() => { if (T.alive && p.alive) put(); }, 50);
   window.__setAim(0, 5000);
   return T.name || T.id;
});
const vampires = (S, n = 3) => S.ev(async (n) => {
   const w = window.__world(), p = w.player, M = await import('./gamev2/missile.js'), St = await import('./gamev2/sites.js');
   const site = St.addSite(w, 'battery', 'enemy', { x: p.pos.x + 9000, y: p.pos.y - 7000 });
   const brg = Math.atan2(p.pos.y - site.pos.y, p.pos.x - site.pos.x);
   for (let i = 0; i < n; i++) { site.lastSsmFire = -99; M.launchSSM(w, site, { bearing: brg + (i - (n - 1) / 2) * 0.02 }); }
}, n);
// a full message stack as a fleet fight produces it (same markup as Hud.msg)
const RADIO = ['Leitstelle an Geleit: Schnellboote aus Nordwest, bleiben Sie beim Verband und halten Sie die Tanker frei.', 'radio'];
const NOTES = [['VAMPIRE – 3 Flugkörper im Anflug', 'warn'], ['Flugkörper abgelenkt', 'good'], ['Maschine ausgefallen', 'warn']];
const messages = (S, list) => S.ev((list) => {
   const box = document.getElementById('msgs');
   box.innerHTML = '';
   for (const [t, c] of list) { const d = document.createElement('div'); d.className = 'msg ' + c; d.textContent = t; d.dataset.text = t; box.appendChild(d); }
}, list);

for (const [mission, ship] of SCENES) {
   if (!want(mission) && !want(mission + '-' + ship)) continue;
   const tag = mission + '-' + ship, T = tag + ': ', e0 = errors.length;
   const S = await open(tag, { w: 844, h: 390, mission, ship });
   check(T + 'touch controls are up', await S.ev(() => window.__touch().shown));
   // keep the player alive through the forced states
   await S.ev(() => { const p = window.__world().player; window.__hpKeep = setInterval(() => { if (p.alive && p.maxHP) p.hp = p.maxHP; }, 200); });
   let L = await layout(S);
   check(T + 'start: objectives shown fresh, nothing overlaps', L.objFresh && L.shown.includes('#objectives') && !L.hits.length, { hits: L.hits, lines: L.objLines });
   check(T + 'start: nothing leaves the screen or is cut off', !L.out.length && !L.cut.length, { out: L.out, cut: L.cut });
   check(T + 'start: tap targets at least 40 px', L.taps >= 6 && !L.small.length, L.small.length ? L.small : L.taps);
   await S.shot(tag + '-0-start');

   // busy: a locked target and a full message stack while the objectives still show
   const tgt = await enemyAhead(S);
   let locked = false;
   if (tgt) { await S.wait(500); if (await S.ev(() => !document.getElementById('tu-lock').classList.contains('hidden'))) { await S.tap('#tu-lock'); locked = await S.waitFor(() => window.__ctl().lockId != null && !document.getElementById('lock-panel').classList.contains('hidden'), 3000); } }
   await messages(S, [NOTES[0], NOTES[1], RADIO]); await S.wait(350);
   L = await layout(S);
   const carrier = ship === 'Ford';
   // (a carrier has no lock button; three operations start without a hostile surface ship)
   check(T + 'busy: target locked, lock card shown' + (carrier ? ' (carrier: no lock button)' : !tgt ? ' (no hostile surface ship here)' : ''), carrier || !tgt || (locked && L.shown.includes('#lock-panel')), { tgt, locked });
   check(T + 'busy: objectives, lock card, messages and controls do not overlap', !L.hits.length, { hits: L.hits, fresh: L.objFresh });
   check(T + 'busy: nothing leaves the screen or is cut off', !L.out.length && !L.cut.length, { out: L.out, cut: L.cut });
   await S.shot(tag + '-1-busy');

   // under attack: incoming missiles, the VAMPIRE plate takes the objectives band
   await vampires(S, 3);
   const seen = await S.waitFor(() => window.__mui().ui.threats.length > 0 && !document.getElementById('mx-threat').classList.contains('hidden'), mission === 'pipeline' ? 6000 : 25000);
   await messages(S, [RADIO, ...NOTES]); await S.wait(350);
   L = await layout(S);
   // (a submerged boat is no target for a sea-skimmer: no plate there)
   const deep = await S.ev(() => window.__world().player.depth > 0);
   check(T + 'attack: VAMPIRE plate shown' + (deep && !seen ? ' (submerged: none expected)' : ''), deep ? true : seen && L.shown.includes('#mx-threat'), L.shown.filter(s => /mx|msg/.test(s)));
   check(T + 'attack: VAMPIRE plate, messages, lock card and plates do not overlap', !L.hits.length, { hits: L.hits });
   check(T + 'attack: nothing leaves the screen or is cut off', !L.out.length && !L.cut.length, { out: L.out, cut: L.cut });
   check(T + 'attack: tap targets at least 40 px', !L.small.length, L.small);
   await S.shot(tag + '-2-attack');
   if (process.env.RECTS) console.log('RECTS ' + tag + ' ' + JSON.stringify(L.rects));
   check(T + 'no console errors', errors.length === e0, errors.slice(e0, e0 + 3));
   await S.ctx.close();
}

// ------------------------------------------------------------------ phone held upright: the veil
if (want('upright')) {
   for (const [mission, ship] of [['hormus', 'Sachsen'], ['pipeline', 'U212'], ['philsea', 'Ford']]) {
      const S = await open('upright-' + mission, { w: 390, h: 844, mission, ship }), T = 'upright 390x844 ' + mission + ': ';
      const v = await S.ev(() => {
         const r = document.getElementById('tu-rotate'), vis = e => e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0;
         const q = r.getBoundingClientRect();
         return { veil: vis(r), covers: q.left <= 0 && q.top <= 0 && q.right >= innerWidth && q.bottom >= innerHeight, txt: r.textContent || '',
            hud: getComputedStyle(document.getElementById('hud')).visibility, btns: [...document.querySelectorAll('#touch-ui .tu-btn')].filter(vis).length,
            scroll: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      check(T + 'the "turn the device" veil covers the battle, no control or plate is left on it', v.veil && v.covers && /quer/.test(v.txt) && v.hud === 'hidden' && v.btns === 0 && !v.scroll, v);
      if (mission === 'hormus') {
         await S.shot('upright');
         // the notices live under the minimap on a phone held sideways and go back to the middle on a larger screen
         const where = async (w, h) => { await S.page.setViewportSize({ width: w, height: h }); await S.wait(700); return S.ev(() => document.getElementById('msgs').parentNode.id); };
         const a = await where(844, 390), b = await where(1024, 768), c = await where(844, 390);
         check(T + 'notices: under the minimap sideways, back in the HUD on a tablet, and under the minimap again', a === 'tu-hud-r' && b === 'hud' && c === 'tu-hud-r', [a, b, c]);
      }
      await S.ctx.close();
   }
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of errors.slice(0, 12)) console.log('  ERR ' + e);
process.exit(failed.length || errors.length ? 1 : 0);
