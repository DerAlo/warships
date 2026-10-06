// tests/playwrightv2.hud.mjs -- browser check of the V2 weapon HUD (index-v2.html), desktop and touch.
// Starts the training mission and puts every weapon and system through its key (desktop) and its
// button (touch): anti-ship missile, cruise missile on the tactical map, rockets, radar / EMCON,
// air-defence doctrine, priority target, decoys, jammer. Each step is checked against the world
// state. Layout: the HUD plates exist and do not overlap at 1440x810, 844x390 (phone, sideways),
// 1024x768 (tablet) and 390x844 (phone upright: the "turn the device" veil). A frame-time
// comparison at tier medium (missiles in the air vs. none) is printed. Exit code 1 on a failed
// check or any console error.
//
// Run:  node server.js 8827   then   URLV2=http://localhost:8827/index-v2.html node tests/playwrightv2.hud.mjs
//       (ONLY=desktop,phone,tablet,upright,ships,perf to limit; NO_GPU=1 for software GL)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URLV2 || 'http://localhost:8827/index-v2.html';
const OUT = process.env.OUT || 'tests/shots';
const ONLY = (process.env.ONLY || 'desktop,phone,tablet,upright,ships,perf').split(',');
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const GPU = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: GPU });
// the frame-time scene runs without vsync, otherwise both numbers read 16.67 ms
const freeBrowser = ONLY.includes('perf') ? await chromium.launch({ args: [...GPU, '--disable-gpu-vsync', '--disable-frame-rate-limit'] }) : null;

// One page per scene: viewport, touch or mouse, ship, optional graphics tier.
async function open(tag, { w, h, touch = false, ship = 'Burke', gfx = null, start = true, free = false }) {
   const ctx = await (free ? freeBrowser : browser).newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
   const page = await ctx.newPage();
   page.on('console', m => { if (m.type() === 'error') errors.push(tag + ': ' + m.text().slice(0, 400)); });
   page.on('pageerror', e => errors.push(tag + ' PAGEERROR: ' + e.message + ' ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ')));
   page.on('requestfailed', r => errors.push(tag + ' REQUESTFAILED: ' + r.url()));
   await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
   await page.goto(URL + '?nohint' + (gfx ? '&gfx=' + gfx : ''), { waitUntil: 'load' });
   await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 30000 });
   const S = {
      page, ctx, tag, touch,
      ev: (fn, arg) => page.evaluate(fn, arg),
      wait: ms => page.waitForTimeout(ms),
      key: async k => { await page.keyboard.press(k); await page.waitForTimeout(200); },
      shot: n => page.screenshot({ path: `${OUT}/v2-hud-${n}.png` }),
      waitFor: (fn, ms = 4000, arg) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false),
      // a finger tap on the centre of an element
      tap: async sel => {
         const r = await page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const q = e.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2, w: q.width, h: q.height }; }, sel);
         if (!r || !r.w) return null;
         await page.touchscreen.tap(r.x, r.y); await page.waitForTimeout(220);
         return r;
      },
   };
   if (start) {
      await S.ev(ship => window.__start({ mission: 'training', ship, difficulty: 'normal' }), ship);
      await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 30000 });
      await S.wait(2200);
   }
   return S;
}

const state = S => S.ev(() => {
   const w = window.__world(), p = w.player;
   return { mode: window.__weaponSel(), kinds: w.missiles.map(m => m.kind), own: w.missiles.filter(m => m.ownerId === p.id).map(m => m.kind), radar: p.radarOn, doc: p.samDoctrine, prio: p.samPriority ?? null,
      decoys: w.decoys.length, jam: !!p.jamming, mag: { ...p.mag }, map: window.__ctl().mapOpen, alive: p.alive };
});
// a slow headless frame can delay a launch past a fixed wait, so wait for the magazine instead
const ready = S => S.waitFor(() => document.querySelector('#weapons .wslot[data-w=ssm]')?.classList.contains('loaded'), 15000);
const launched = (S, n) => S.waitFor(n => window.__world().player.mag.harpoon <= n, 4000, n);
// screen position of a hostile land position on the open tactical map
const sitePoint = S => S.ev(async () => {
   const M = await import('./gamev2/missileui.js'), r = M.tacticalMapRect(innerWidth, innerHeight), w = window.__world(), A = w.arena, sc = r.size / (A * 2);
   const s = w.sites.find(s => s.alive && s.side !== w.player.side);
   return s ? { x: r.x0 + (s.pos.x + A) * sc + 2, y: r.y0 + (s.pos.y + A) * sc + 2, id: s.id, name: s.name } : null;
});
// a hostile coastal battery near the player fires n missiles at it
const vampires = (S, n = 3) => S.ev(async (n) => {
   const w = window.__world(), p = w.player, M = await import('./gamev2/missile.js'), St = await import('./gamev2/sites.js');
   const site = St.addSite(w, 'battery', 'enemy', { x: p.pos.x + 9000, y: p.pos.y - 7000 });
   // bearing-only shots (a fresh site holds no track yet); the seekers find the ship on their own
   const brg = Math.atan2(p.pos.y - site.pos.y, p.pos.x - site.pos.x);
   for (let i = 0; i < n; i++) { site.lastSsmFire = -99; M.launchSSM(w, site, { bearing: brg + (i - (n - 1) / 2) * 0.02 }); }
}, n);

// Visible HUD plates and controls; pairs that intersect by more than 2 px are reported.
const layout = S => S.ev(() => {
   const sels = ['#weapons', '#mx-sys', '#cons', '#mx-threat', '#ship-card', '#scorebox', '#minimap-wrap', '#lock-panel', '#objectives', '#tally',
      '#tu-tele', '#tu-rud', '#tu-fire', '#tu-scope', '#tu-lock', '#tu-free', '#tu-pause', '#tu-map', '#tu-board', '#tu-help', '#tu-more', '#tu-asw', '#tu-sec', '#tu-dive', '#tu-up'];
   const vis = e => { if (!e) return false; const cs = getComputedStyle(e), r = e.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 2 && r.height > 2 && !!e.offsetParent; };
   const boxes = sels.map(s => [s, document.querySelector(s)]).filter(([, e]) => vis(e)).map(([s, e]) => { const r = e.getBoundingClientRect(); return { s, l: r.left, t: r.top, r: r.right, b: r.bottom }; });
   const hits = [], out = [];
   for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.l < -1 || a.t < -1 || a.r > innerWidth + 1 || a.b > innerHeight + 1) out.push(a.s);
      for (let j = i + 1; j < boxes.length; j++) {
         const b = boxes[j];
         if (Math.min(a.r, b.r) - Math.max(a.l, b.l) > 2 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 2) hits.push(a.s + ' x ' + b.s);
      }
   }
   // tap targets: weapon slots, consumables, system plates
   const taps = [...document.querySelectorAll('#weapons .wslot, #cons .cslot, #mx-sys [data-key]')].filter(vis).map(e => { const r = e.getBoundingClientRect(); return { k: e.dataset.key || e.dataset.slot, w: Math.round(r.width), h: Math.round(r.height) }; });
   return { shown: boxes.map(b => b.s), hits, out, taps, slots: [...document.querySelectorAll('#weapons .wslot')].filter(vis).map(e => e.dataset.w + ':' + (e.querySelector('.wcnt')?.textContent || '')) };
});

// ------------------------------------------------------------------ desktop: every weapon by key
if (ONLY.includes('desktop')) {
   const S = await open('desktop', { w: 1440, h: 810 }), T = 'desktop: ';
   let s = await state(S), L = await layout(S);
   check(T + 'weapon bar: gun, anti-ship and cruise missiles with their counts', ['gun:', 'ssm:8', 'cruise:24'].every(x => L.slots.some(q => q.startsWith(x))), L.slots);
   check(T + 'system row (radar, doctrine, magazines, priority) and consumables shown', ['#mx-sys', '#cons', '#weapons'].every(x => L.shown.includes(x)), L.shown);
   check(T + 'no HUD plate overlaps another or leaves the screen', !L.hits.length && !L.out.length, { hits: L.hits, out: L.out });
   const tips = await S.ev(() => [...document.querySelectorAll('#weapons .wslot, #mx-sys [data-key]')].map(e => e.title || '').filter(t => /\(.\)/.test(t)).length);
   check(T + 'tooltips name the key', tips >= 5, tips);
   await S.shot('desktop-0-start');

   await S.key('Digit2');
   check(T + '2 selects the anti-ship missile', (await state(S)).mode === 'ssm');
   await ready(S); await S.key('Space'); await launched(S, 7);
   s = await state(S);
   check(T + 'Space launches it (missile in the world, magazine 8 -> 7)', s.own.includes('ssm') && s.mag.harpoon === 7, { own: s.own, mag: s.mag });
   await S.shot('desktop-1-ssm');
   await S.waitFor(() => document.querySelector('#weapons .wslot[data-w=ssm]').classList.contains('loaded'), 15000);
   await S.wait(300); await S.page.mouse.click(720, 300); await launched(S, 6); await S.wait(300);
   s = await state(S);
   check(T + 'left click launches as well, one missile per press', s.mag.harpoon === 6, s.mag);

   await S.key('KeyR');
   s = await state(S);
   const emcon = await S.ev(() => ({ cls: document.getElementById('mx-radar').className, txt: document.getElementById('mx-radar').textContent }));
   check(T + 'R switches the radar off, the plate shows EMCON', s.radar === false && /emcon/.test(emcon.cls) && /EMCON/.test(emcon.txt), emcon);
   await S.wait(500); await S.shot('desktop-2-emcon');
   await S.key('KeyR');
   check(T + 'R again: radar on', (await state(S)).radar === true);

   const docs = [];
   for (let i = 0; i < 3; i++) { await S.key('KeyV'); docs.push((await state(S)).doc); }
   const docTxt = await S.ev(() => document.querySelector('#mx-doc b').textContent);
   check(T + 'V steps the doctrine: Selbstschutz, Feuer halten, Feuer frei', docs.join() === 'self,hold,free' && docTxt === 'Feuer frei', { docs, docTxt });

   await S.key('KeyF');
   check(T + 'F throws decoys (cloud in the world)', (await state(S)).decoys > 0);
   await S.key('KeyJ');
   check(T + 'J switches the jammer on', (await state(S)).jam === true);

   await S.key('Digit3'); await S.wait(300);
   s = await state(S);
   check(T + '3 selects the cruise missile and opens the tactical map', s.mode === 'cruise' && s.map === true, s.mode);
   const sp = await sitePoint(S);
   await S.page.mouse.move(sp.x, sp.y); await S.wait(300);
   await S.shot('desktop-3-map');
   await S.page.mouse.click(sp.x, sp.y); await S.wait(500);
   s = await state(S);
   const cm = await S.ev(() => { const w = window.__world(), m = w.missiles.find(m => m.kind === 'cruise'); return m ? { site: m.siteId ?? m.targetSite ?? null, tx: m.tx, ty: m.ty } : null; });
   check(T + 'click on a land position launches at it (24 -> 23)', s.own.includes('cruise') && s.mag.tomahawk === 23, { cm, name: sp.name });
   await S.key('KeyM'); await S.key('Digit1');
   check(T + '1 back to the gun, map closed', (s = await state(S)).mode === 'main' && !s.map, s.mode);
   // the map without a chart weapon still has a cursor, and it says how to get a target
   await S.key('KeyM'); await S.wait(300);
   const free = await S.ev(() => { const m = window.__mui().ui.map; return { free: m.free, tip: m.freeTip, mode: m.mode }; });
   check(T + 'M with the gun selected: the map shows a plain cursor and the key for the chart', free.free === true && /^3 · /.test(free.tip) && !free.mode, free);
   await S.shot('desktop-3b-map-free');
   await S.key('KeyM'); await S.wait(200);
   // a locked pointer that drifted to the screen edge while aiming is back on the chart when it opens
   await S.ev(() => { Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => document.querySelector('canvas') }); const c = window.__mui().cur; c.x = 0; c.y = 0; });
   await S.key('Digit3'); await S.wait(300);
   const back = await S.ev(() => { const m = window.__mui(), u = m.ui.map, W = window.innerWidth, H = window.innerHeight; return { x: m.cur.x, y: m.cur.y, cur: !!u.cur, mid: Math.abs(m.cur.x - W / 2) < 2, W, H }; });
   check(T + 'chart reopened after aiming elsewhere: the cursor starts in the middle of the map', back.cur && back.mid, back);
   await S.ev(() => window.dispatchEvent(new PointerEvent('pointermove', { movementX: -5000, movementY: -5000 }))); await S.wait(200);
   const edge = await S.ev(() => { const m = window.__mui(); return { x: m.cur.x, y: m.cur.y, cur: !!m.ui.map.cur }; });
   check(T + 'the locked cursor cannot leave the chart', edge.cur && edge.x > 0 && edge.y > 0, edge);
   await S.ev(() => { delete document.pointerLockElement; });
   await S.key('Digit3'); await S.key('Digit1');
   check(T + 'chart closed again, gun selected', (s = await state(S)).mode === 'main' && !s.map, s.mode);

   // empty magazine: the slot says so and the launch is refused with the reason
   await S.ev(() => { window.__world().player.mag.harpoon = 0; });
   await S.key('Digit2'); await S.wait(300); await S.key('Space'); await S.wait(300);
   const empty = await S.ev(() => ({ none: document.querySelector('#weapons .wslot[data-w=ssm]').classList.contains('none'), stat: document.querySelector('#weapons .wslot[data-w=ssm] .wstat')?.textContent,
      msg: [...document.querySelectorAll('#hud *')].some(e => !e.children.length && /Harpoon: Leer/.test(e.textContent)), n: window.__world().missiles.filter(m => m.kind === 'ssm' && m.t < 1).length }));
   check(T + 'empty magazine: slot marked, launch refused with "Leer"', empty.none && /leer/i.test(empty.stat || '') && empty.msg, empty);
   await S.ev(() => { window.__world().player.mag.harpoon = 6; });
   await S.key('Digit1');

   // inbound missiles: threat plate, bearing markers, air defence, priority target
   await vampires(S, 3);
   const seen = await S.waitFor(() => window.__mui().ui.threats.length > 0 && !document.getElementById('mx-threat').classList.contains('hidden'), 25000);
   const thr = await S.ev(() => ({ rows: document.querySelectorAll('#mx-threat .vr').length, txt: document.getElementById('mx-threat').textContent.slice(0, 90), n: window.__mui().ui.threats.length, tti: window.__mui().ui.minTti }));
   check(T + 'inbound missiles: VAMPIRE plate with bearing and time to impact', seen && thr.rows > 0 && /VAMPIRE/.test(thr.txt) && /\d+ s/.test(thr.txt), thr);
   L = await layout(S);
   check(T + 'threat plate overlaps nothing', L.shown.includes('#mx-threat') && !L.hits.length, L.hits);
   await S.key('KeyT');
   s = await state(S);
   const prio = await S.ev(() => document.querySelector('#mx-prio b').textContent);
   check(T + 'T sets a priority target for the air defence', s.prio != null && prio !== '—', { prio: s.prio, txt: prio });
   const eng = await S.waitFor(() => window.__mui().ui.threats.some(t => t.engBy) || window.__world().missiles.some(m => m.kind === 'sam'), 20000);
   check(T + 'the display shows a defence layer engaging', eng);
   await S.shot('desktop-4-vampire');
   await S.key('KeyT');
   await S.key('KeyH'); await S.wait(300);
   const help = await S.ev(() => { const h = document.getElementById('help-panel'); return { shown: !!h && getComputedStyle(h).display !== 'none' && !h.classList.contains('hidden'), txt: h?.textContent || '' }; });
   check(T + 'help lists the V2 keys', help.shown && /Seezielflugkörper/.test(help.txt) && /EMCON/.test(help.txt) && /Doktrin/.test(help.txt) && !/HE \/ AP|Nebel/.test(help.txt));
   await S.shot('desktop-5-help');
   await S.ctx.close();
}

// ------------------------------------------------------------------ touch: the same through buttons
async function touchRun(tag, w, h) {
   const S = await open(tag, { w, h, touch: true }), T = tag + ': ';
   check(T + 'touch controls are up', await S.ev(() => window.__touch().shown));
   let L = await layout(S), s;
   check(T + 'weapon bar, system row, consumables and controls shown', ['#weapons', '#mx-sys', '#cons', '#tu-fire', '#tu-tele', '#tu-rud'].every(x => L.shown.includes(x)), L.shown);
   check(T + 'nothing overlaps or leaves the screen', !L.hits.length && !L.out.length, { hits: L.hits, out: L.out });
   const small = L.taps.filter(t => t.w < 40 || t.h < 40);
   check(T + 'tap targets at least 40 px', L.taps.length >= 8 && !small.length, small.length ? small : L.taps.length);
   await S.shot(tag + '-0-start');

   await S.tap('#weapons .wslot[data-w=ssm]');
   check(T + 'tap on the missile slot selects it', (await state(S)).mode === 'ssm');
   await ready(S); await S.tap('#tu-fire'); await launched(S, 7);
   s = await state(S);
   check(T + 'fire button launches (8 -> 7)', s.own.includes('ssm') && s.mag.harpoon === 7, s.mag);
   await S.tap('#mx-radar');
   check(T + 'radar plate: off (EMCON)', (await state(S)).radar === false);
   await S.wait(400); await S.shot(tag + '-1-emcon');
   await S.tap('#mx-radar');
   check(T + 'radar plate again: on', (await state(S)).radar === true);
   await S.tap('#mx-doc');
   check(T + 'doctrine plate steps the doctrine', (await state(S)).doc === 'self');
   await S.tap('#cons .cslot[data-slot=F]');
   check(T + 'decoy field throws decoys', (await state(S)).decoys > 0);
   await S.tap('#cons .cslot[data-slot=J]');
   check(T + 'jammer field switches the jammer on', (await state(S)).jam === true);
   await S.tap('#weapons .wslot[data-w=cruise]'); await S.wait(300);
   s = await state(S);
   check(T + 'cruise slot opens the tactical map', s.mode === 'cruise' && s.map === true);
   const sp = await sitePoint(S);
   await S.shot(tag + '-2-map');
   await S.page.touchscreen.tap(sp.x, sp.y); await S.wait(500);
   s = await state(S);
   check(T + 'tap on a land position launches the cruise missile (24 -> 23)', s.own.includes('cruise') && s.mag.tomahawk === 23, s.mag);
   L = await layout(S);
   check(T + 'map open: nothing overlaps', !L.hits.length, L.hits);
   await S.tap('#weapons .wslot[data-w=cruise]');
   check(T + 'cruise slot again closes the map', (await state(S)).map === false);
   await S.tap('#weapons .wslot[data-w=gun]');
   await vampires(S, 3);
   const seen = await S.waitFor(() => window.__mui().ui.threats.length > 0 && !document.getElementById('mx-threat').classList.contains('hidden'), 25000);
   check(T + 'inbound missiles: threat plate shown', seen);
   await S.tap('#mx-prio');
   check(T + 'priority plate sets a priority target', (await state(S)).prio != null);
   L = await layout(S);
   check(T + 'under attack: nothing overlaps', L.shown.includes('#mx-threat') && !L.hits.length, L.hits);
   await S.shot(tag + '-3-vampire');
   await S.ctx.close();
}
if (ONLY.includes('phone')) await touchRun('phone', 844, 390);
if (ONLY.includes('tablet')) await touchRun('tablet', 1024, 768);

// ------------------------------------------------------------------ phone held upright: the veil, no battle HUD
if (ONLY.includes('upright')) {
   const S = await open('upright', { w: 390, h: 844, touch: true }), T = 'upright 390x844: ';
   const v = await S.ev(() => {
      const r = document.getElementById('tu-rotate'), vis = e => e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0;
      return { veil: vis(r), txt: r?.textContent || '', hud: getComputedStyle(document.getElementById('hud')).visibility, btns: [...document.querySelectorAll('#touch-ui .tu-btn')].filter(vis).length };
   });
   check(T + 'the "turn the device" veil covers the battle, no control is left on it', v.veil && /quer/.test(v.txt) && v.hud === 'hidden' && v.btns === 0, v);
   await S.shot('upright');
   // turned sideways the HUD comes back complete
   await S.page.setViewportSize({ width: 844, height: 390 }); await S.wait(800);
   const L = await layout(S);
   check(T + 'turned sideways: HUD complete, nothing overlaps', ['#weapons', '#mx-sys', '#tu-fire'].every(x => L.shown.includes(x)) && !L.hits.length, { hits: L.hits });
   await S.ctx.close();
}

// ------------------------------------------------------------------ other hull types: bar matches the loadout, no errors
if (ONLY.includes('ships')) {
   for (const [ship, want, keys] of [
      ['Boghammar', ['gun', 'ssm', 'rockets'], ['Digit4', 'Space']],     // fast attack craft: rocket salvo on 4
      ['Braunschweig', ['gun', 'ssm'], ['Digit2', 'Space']],              // corvette
      ['U212', ['torp'], ['Digit2', 'Digit5']],                           // submarine: no missiles (2 is refused), torpedoes on 5
      ['Ford', [], ['KeyR', 'KeyV']],                                     // carrier: air group keeps 1-4, radar / doctrine still work
   ]) {
      const S = await open(ship, { w: 1440, h: 810, ship }), T = ship + ': ';
      const L = await layout(S), got = L.slots.map(q => q.split(':')[0]);
      check(T + 'weapon bar matches the loadout', want.every(x => got.includes(x)) && (want.length > 0 || true), L.slots);
      check(T + 'nothing overlaps', !L.hits.length && !L.out.length, { hits: L.hits, out: L.out });
      const before = await state(S);
      // select and fire in one slow headless frame would drop the launch, so let the selection land first
      for (const k of keys) { if (ship === 'Braunschweig' && k === 'Space') await ready(S); await S.key(k); await S.wait(250); }
      if (ship === 'Braunschweig') await S.waitFor(() => window.__world().missiles.some(m => m.kind === 'ssm'), 4000).catch(() => {});
      await S.wait(400);
      const s = await state(S);
      if (ship === 'Boghammar') check(T + '4 + Space fires a rocket salvo', s.own.filter(k => k === 'rocket').length >= 6 && s.mode === 'rockets', s.own.length);
      if (ship === 'Braunschweig') check(T + '2 + Space launches', s.own.includes('ssm'), { own: s.own, mode: s.mode, mag: s.mag, msgs: await S.ev(() => [...document.querySelectorAll('#hud *')].filter(e => !e.children.length && e.textContent.trim().length > 8 && e.offsetParent).map(e => e.textContent.trim()).slice(0, 30)) });
      if (ship === 'U212') check(T + '2 is refused (no missiles), 5 selects torpedoes', s.mode === 'torp' && !s.own.length, { mode: s.mode });
      if (ship === 'Ford') check(T + 'R and V work on the carrier', s.radar !== before.radar && s.doc !== before.doc, { radar: s.radar, doc: s.doc });
      await S.shot('ship-' + ship);
      await S.ctx.close();
   }
}

// ------------------------------------------------------------------ frame time: missiles in the air vs. none (tier medium)
if (ONLY.includes('perf')) {
   const S = await open('perf', { w: 1440, h: 810, gfx: 'medium', free: true });
   const sample = (ms) => S.ev((ms) => new Promise(res => {
      const d = []; let last = performance.now(); const t0 = last;
      const f = (t) => { d.push(t - last); last = t; if (t - t0 < ms) requestAnimationFrame(f); else { d.shift(); d.sort((a, b) => a - b); res({ n: d.length, avg: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2), p95: +d[Math.floor(d.length * 0.95)].toFixed(2), max: +d[d.length - 1].toFixed(2) }); } };
      requestAnimationFrame(f);
   }), ms);
   await S.wait(1500);
   const base = await sample(6000);
   // a real exchange: 12 inbound from two batteries, 6 outbound, the air defence answering
   await S.ev(async () => {
      const w = window.__world(), p = w.player, M = await import('./gamev2/missile.js'), St = await import('./gamev2/sites.js');
      for (const [dx, dy] of [[11000, -6000], [9000, 8000]]) {
         const site = St.addSite(w, 'battery', 'enemy', { x: p.pos.x + dx, y: p.pos.y + dy });
         const brg = Math.atan2(-dy, -dx);
         for (let i = 0; i < 6; i++) { site.lastSsmFire = -99; M.launchSSM(w, site, { bearing: brg + (i - 2.5) * 0.02 }); }
      }
      const tgt = w.ships.find(s => s.alive && s.side !== p.side);
      for (let i = 0; i < 6; i++) { p.lastSsmFire = -99; M.launchSSM(w, p, tgt ? { targetId: tgt.id } : { bearing: 0 }); }
   });
   await S.wait(2500);
   const n0 = await S.ev(() => window.__world().missiles.length);
   const busy = await sample(6000);
   const n1 = await S.ev(() => window.__world().missiles.length);
   await S.shot('perf-missiles');
   console.log('FRAMETIME tier medium 1440x810  no missiles: ' + JSON.stringify(base) + '   missiles in the air (' + n0 + ' -> ' + n1 + '): ' + JSON.stringify(busy));
   check('perf: missiles in the air cost less than 4 ms per frame on average (uncapped frame rate)', busy.avg - base.avg < 4, { base: base.avg, busy: busy.avg, n0, n1 });
   await S.ctx.close();
}

await browser.close(); await freeBrowser?.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of errors.slice(0, 12)) console.log('  ERR ' + e);
process.exit(failed.length || errors.length ? 1 : 0);
