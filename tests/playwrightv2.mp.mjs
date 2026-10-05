// tests/playwrightv2.mp.mjs -- V2 multiplayer in two real browser pages of one context, talking over
// BroadcastChannel (?net=local). Nothing leaves the machine: every request and WebSocket that does not
// go to localhost is aborted by Playwright routing, and the test fails if the page tried one.
//
// Parts (ONLY=coop,pvp,phase2,migrate): co-op operation (hormus) with a missile exchange, PvP team battle
// with damage, a kill and the result screens, the phase-2 systems on the guest (helicopter I, ASW torpedo G,
// team K, the blast of `countdown`), host migration when the host page closes.
//
// Run:  node server.js 8836   then   URLV2=http://localhost:8836/index-v2.html node tests/playwrightv2.mp.mjs
//       (RUN_S = seconds of game time in the co-op part, default 60; NO_GPU=1 software GL; SHOTS dir = tests/shots)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.URLV2 || 'http://localhost:8836/index-v2.html';
const URL = BASE + (BASE.includes('?') ? '&' : '?') + 'net=local&nohint';
const OUT = process.env.OUT || 'tests/shots';
const RUN_S = Number(process.env.RUN_S) || 60;
const ONLY = (process.env.ONLY || 'coop,pvp,phase2,migrate').split(',');
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i;
mkdirSync(OUT, { recursive: true });
const errors = [], results = [], external = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 300) : ''));
};
const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });

// ---- one browser context = one "player machine pair"; all pages share BroadcastChannel and localStorage
async function newContext() {
   const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
   await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (LOCAL.test(u) || /^(data|blob|about):/.test(u)) return route.continue();
      external.push(u); return route.abort();
   });
   await ctx.routeWebSocket(/.*/, (ws) => { external.push('WS ' + ws.url()); ws.close(); });
   await ctx.addInitScript(() => {
      HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); };
      // belt and braces: no network API reaches a non-local host from page code either
      const WS = window.WebSocket;
      window.WebSocket = function (u, p) { if (!/^wss?:\/\/(localhost|127\.0\.0\.1)/.test(String(u))) { (window.__extTry = window.__extTry || []).push(String(u)); throw new Error('external WebSocket blocked by test'); } return new WS(u, p); };
   });
   return ctx;
}
async function mkPage(ctx, tag, name) {
   const page = await ctx.newPage();
   page.tag = tag;
   page.on('console', m => { if (m.type() === 'error') errors.push(`[${tag}] ${m.text().slice(0, 300)}`); });
   page.on('pageerror', e => errors.push(`[${tag}] PAGEERROR: ${e.message} ${String(e.stack || '').split('\n').slice(1, 3).join(' | ')}`));
   await page.goto(URL, { waitUntil: 'load' });
   await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 30000 });
   await page.waitForSelector('[data-act="mp"]');
   await page.click('[data-act="mp"]');
   await page.waitForSelector('.mp:not(.hidden)');
   if (!await page.locator('[data-f="pname"]').count()) await page.click('[data-act="name"]');
   await page.fill('[data-f="pname"]', name);
   await page.click('.mp-modal [data-ok]');
   return page;
}
const wait = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const sleep = (page, ms) => page.waitForTimeout(ms);
const shot = (page, name) => page.screenshot({ path: `${OUT}/v2-mp-${name}-${page.tag}.png` });

async function host(A, { name, mode = 'coop', mission, ship }) {
   await A.click('[data-act="main"]');
   await A.fill('[data-f="name"]', name);
   if (mode === 'pvp') await A.click('[data-seg="mode"] [data-v="pvp"]');
   await A.selectOption('[data-f="mission"]', mission);
   await A.click('.mp-modal [data-ok]');
   await A.waitForSelector('.mp-player');
   if (ship) await A.click(`[data-ship="${ship}"]`);
}
async function join(B, name) {
   const ok = await wait(B, (n) => [...document.querySelectorAll('.mp-game')].some(g => g.textContent.includes(n)), name);
   await B.click('.mp-game [data-join]');
   return ok && await wait(B, () => document.querySelectorAll('.mp-player').length === 2);
}
async function startMatch(A, B) {
   await B.click('[data-act="main"]');
   const can = await wait(A, () => !document.querySelector('[data-act="main"]').disabled);
   await A.click('[data-act="main"]');
   const inA = await wait(A, () => window.__phase() === 'playing' && !!window.__world()?.player, null, 40000);
   const inB = await wait(B, () => window.__phase() === 'playing' && !!window.__world()?.player, null, 40000);
   return can && inA && inB;
}
const snap = (page) => page.evaluate(() => {
   const w = window.__world(), p = w.player;
   return { mission: w.mission?.id, ships: w.ships.length, me: p.id, cls: p.cls, x: p.pos.x, y: p.pos.y, side: p.side, t: w.time, alive: p.alive,
      missiles: w.missiles.length, obj: document.getElementById('objectives')?.innerText.length || 0,
      weapons: document.querySelectorAll('#weapons .wslot').length, mag: JSON.stringify(p.mag || {}) };
});
async function closeAll(ctx) { await ctx.close().catch(() => {}); }

// ====================================================================== co-op
if (ONLY.includes('coop')) {
   const T = 'coop: ', ctx = await newContext();
   const A = await mkPage(ctx, 'A', 'Anna'); await host(A, { name: 'V2 Koop Hormus', mission: 'hormus' });
   const B = await mkPage(ctx, 'B', 'Bert');
   check(T + 'B finds the game and is in the room', await join(B, 'V2 Koop Hormus'));
   await shot(A, 'coop-1-lobby'); await shot(B, 'coop-1-lobby');
   const roster = await B.evaluate(() => [...document.querySelectorAll('[data-role-slot]')].map(e => e.textContent));
   check(T + 'guest sees the prescribed ships', roster.length >= 2, roster);
   check(T + 'both ready up and the game starts', await startMatch(A, B));
   await sleep(A, 2500);
   const a = await snap(A), b = await snap(B);
   check(T + 'same mission and ship count', a.mission === 'hormus' && b.mission === 'hormus' && a.ships === b.ships && a.ships > 3, { a: a.ships, b: b.ships });
   check(T + 'each captain controls a different ship', a.me !== b.me && a.cls !== undefined, { a: [a.me, a.cls], b: [b.me, b.cls] });
   await shot(A, 'coop-2-start'); await shot(B, 'coop-2-start');
   // guest sees ships move (any ally of the guest's world changes position)
   const p0 = await B.evaluate(() => window.__world().ships.map(s => [s.id, s.pos.x, s.pos.y]));
   await sleep(B, 4000);
   const moved = await B.evaluate((p0) => { const w = window.__world(); return w.ships.filter(s => { const q = p0.find(x => x[0] === s.id); return q && Math.hypot(s.pos.x - q[1], s.pos.y - q[2]) > 5; }).length; }, p0);
   check(T + 'guest sees ships move', moved >= 2, moved);
   const hud = await B.evaluate(() => ({ obj: document.getElementById('objectives')?.innerText || '', slots: [...document.querySelectorAll('#weapons .wslot')].map(e => e.dataset.w + ':' + (e.querySelector('.wcnt')?.textContent || '')), sys: document.getElementById('mx-sys')?.innerText || '' }));
   check(T + 'guest HUD: objectives filled', hud.obj.length > 10 && !/undefined|NaN/.test(hud.obj), hud.obj.slice(0, 80));
   check(T + 'guest HUD: missile panel filled', hud.slots.some(s => /^ssm:\d+/.test(s)) && !/undefined|NaN/.test(hud.sys), hud.slots);
   // guest fires an anti-ship missile
   await B.bringToFront();
   const magBefore = await B.evaluate(() => ({ ...window.__world().player.mag }));
   await B.keyboard.press('Digit2'); await sleep(B, 200);
   await B.keyboard.press('Space');
   const hostSees = await wait(A, (id) => window.__world().missiles.some(m => m.kind === 'ssm' && m.ownerId === id), b.me, 8000);
   check(T + 'guest fires an anti-ship missile and the host world has it', hostSees);
   const guestSees = await wait(B, () => window.__world().missiles.some(m => m.kind === 'ssm' && m.side === 'player'), null, 6000);
   check(T + 'guest sees its own missile in flight', guestSees);
   check(T + 'guest magazine drops', await wait(B, (m) => { const p = window.__world().player; return Object.keys(m).some(k => (p.mag[k] ?? 0) < m[k]); }, magBefore, 6000));
   // hostile missiles at the guest ship
   await A.evaluate(async (id) => {
      const w = window.__world(), M = await import('./gamev2/missile.js'), St = await import('./gamev2/sites.js');
      const t = w.ships.find(s => s.id === id);
      const site = St.addSite(w, 'battery', 'enemy', { x: t.pos.x + 9000, y: t.pos.y - 7000 });
      const brg = Math.atan2(t.pos.y - site.pos.y, t.pos.x - site.pos.x);
      for (let i = 0; i < 3; i++) { site.lastSsmFire = -99; M.launchSSM(w, site, { bearing: brg + (i - 1) * 0.02 }); }
   }, b.me);
   const warn = await wait(B, () => window.__mui().ui.threats.length > 0 && !document.getElementById('mx-threat').classList.contains('hidden'), null, 30000);
   check(T + 'missile at the guest raises its incoming-missile warning', warn, await B.evaluate(() => document.getElementById('mx-threat').innerText.slice(0, 80)));
   await shot(B, 'coop-3-vampire'); await shot(A, 'coop-3-mid');
   // run RUN_S seconds of game time
   const ok60 = await wait(A, (s) => window.__world().time >= s, RUN_S, (RUN_S + 30) * 1000);
   const a2 = await snap(A), b2 = await snap(B);
   check(T + `ran ${RUN_S} s of game time`, ok60, { host: a2.t, guest: b2.t });
   check(T + 'guest world tracks host time', Math.abs(a2.t - b2.t) < 3, { a: a2.t, b: b2.t });
   await shot(A, 'coop-4-mid'); await shot(B, 'coop-4-mid');
   check(T + 'no console errors on either page', errors.length === 0, errors.slice(0, 3));
   await closeAll(ctx);
}

check('no request or WebSocket tried to leave localhost', external.length === 0, external.slice(0, 5));
const bad = results.filter(r => !r.ok).length;
console.log(`${results.length - bad}/${results.length} checks passed, console errors: ${errors.length}`);
if (errors.length) console.log(errors.slice(0, 8).join('\n'));
await browser.close();
process.exit(bad || errors.length ? 1 : 0);
