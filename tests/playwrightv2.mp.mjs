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
   if (ship) await A.click(`.mp [data-ship="${ship}"]`);
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

// ====================================================================== PvP
if (ONLY.includes('pvp')) {
   const T = 'pvp: ', ctx = await newContext();
   const A = await mkPage(ctx, 'A', 'Anna'); await host(A, { name: 'V2 PvP Test', mode: 'pvp', mission: 'standard' });
   const B = await mkPage(ctx, 'B', 'Bert');
   check(T + 'B finds the game and is in the room', await join(B, 'V2 PvP Test'));
   if (await B.locator('[data-join-team="2"]').count()) await B.click('[data-join-team="2"]');   // no button when the lobby already placed the guest there
   check(T + 'guest moves to team 2', await wait(B, () => document.querySelector('.mp-player.me')?.previousElementSibling?.dataset.teamHead === '2'
      || [...document.querySelectorAll('[data-team-head]')].find(h => h.dataset.teamHead === '2')?.textContent.includes('dein Team')));
   const east = await B.evaluate(() => [...document.querySelectorAll('.mp [data-ship]')].map(e => ({ k: e.dataset.ship, t: e.textContent })));
   const EAST = ['Typ022', 'Typ054A', 'Typ052D', 'Typ055'];
   check(T + 'team 2 sees the east roster (no west ships, text complete)', east.length >= 4 && EAST.some(k => east.some(e => e.k === k)) && !east.some(e => ['Burke', 'Sachsen'].includes(e.k)) && !east.some(e => /undefined|NaN/.test(e.t)), east.map(e => e.k));
   const pick = (east.find(e => e.k === 'Typ054A') || east[0]).k;
   await B.click(`.mp [data-ship="${pick}"]`);
   check(T + 'guest picks an east ship', await wait(B, (k) => document.querySelector(`.mp [data-ship="${k}"]`)?.classList.contains('sel'), pick));
   check(T + 'host sees the guest on team 2 with that ship', await wait(A, () => { const p = [...document.querySelectorAll('.mp-player')].find(e => e.textContent.includes('Bert')); const h = [...document.querySelectorAll('[data-team-head]')]; return !!p && h.length === 2 && !/kein Schiff/.test(p.textContent) && !!(h[1].compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING); }));
   await shot(A, 'pvp-1-lobby'); await shot(B, 'pvp-1-lobby');
   check(T + 'game starts', await startMatch(A, B));
   await sleep(A, 3000);
   const a = await snap(A), b = await snap(B);
   check(T + 'same mission, both own ships differ, guest is east class', a.mission === b.mission && a.me !== b.me && a.ships === b.ships && ['Typ022', 'Typ054A', 'Typ052D', 'Typ055'].includes(b.cls), { a: [a.me, a.cls], b: [b.me, b.cls] });
   check(T + 'each page sees itself as the "player" side', a.side === 'player' && b.side === 'player');
   await shot(A, 'pvp-2-start'); await shot(B, 'pvp-2-start');
   // both fire an anti-ship missile through the keys
   for (const P of [A, B]) { await P.bringToFront(); await P.keyboard.press('Digit2'); await sleep(P, 150); await P.keyboard.press('Space'); }
   check(T + 'both missiles reach the host world', await wait(A, ([x, y]) => { const w = window.__world(); return [x, y].every(id => w.missiles.some(m => m.ownerId === id)); }, [a.me, b.me], 10000));
   check(T + 'the guest sees both launches', await wait(B, () => window.__world().missiles.filter(m => m.kind === 'ssm').length >= 1, null, 8000));
   // damage on the guest's ship, from the host's ship
   const hp0 = await B.evaluate(() => window.__world().player.hp);
   await A.evaluate((id) => { const w = window.__world(), t = w.ships.find(s => s.id === id), me = w.player; t.takeDamage(t.maxHP * 0.3, me, 'ssm'); }, b.me);
   check(T + 'damage replicates to the guest', await wait(B, (h) => window.__world().player.hp < h - 1, hp0, 6000), { hp0, hp: await B.evaluate(() => window.__world().player.hp) });
   const hpHost = await A.evaluate((id) => window.__world().ships.find(s => s.id === id).hp, b.me);
   check(T + 'host view of the guest ship is damaged', hpHost < hp0);
   await shot(B, 'pvp-3-mid'); await shot(A, 'pvp-3-mid');
   // kill: the host sinks the guest ship; its team is out, the host's team wins
   await A.evaluate((id) => { const w = window.__world(), t = w.ships.find(s => s.id === id); t.takeDamage(t.maxHP * 5, w.player, 'ssm'); }, b.me);
   check(T + 'the kill replicates (guest ship dead on the guest)', await wait(B, () => !window.__world().player.alive, null, 8000));
   const res = (P) => wait(P, () => { const r = document.querySelector('.m3r'); return !!r && r.offsetParent !== null; }, null, 20000);
   const [rA, rB] = [await res(A), await res(B)];
   check(T + 'result screen on both pages', rA && rB, { rA, rB });
   const outcome = (P) => P.evaluate(() => document.querySelector('.m3r-title')?.textContent.trim());
   const oa = await outcome(A), ob = await outcome(B);
   check(T + 'opposite outcomes (host SIEG, guest NIEDERLAGE)', oa === 'SIEG' && ob === 'NIEDERLAGE', { oa, ob });
   await shot(A, 'pvp-4-result'); await shot(B, 'pvp-4-result');
   check(T + 'no console errors on either page', errors.length === 0, errors.slice(0, 3));
   await closeAll(ctx);
}

// ====================================================================== phase-2 systems on the guest
// The guest runs on replicated data only: helicopter (I), ASW torpedo (G), team (K), large blast.
if (ONLY.includes('phase2')) {
   const plate = (P, cls) => P.evaluate((c) => { const e = document.querySelector('.ops-plate.' + c); return e ? { hidden: e.classList.contains('hidden'), txt: e.innerText.replace(/\s+/g, ' ').slice(0, 80) } : null; }, cls);
   const e0 = errors.length;
   // ---- scenario 1: two Sachsen (helicopter + ASW torpedoes), a hostile boat close to the guest
   {
      const T = 'phase2 heli/ASW: ', ctx = await newContext();
      const A = await mkPage(ctx, 'A', 'Anna'); await host(A, { name: 'V2 Phase2 A', mission: 'standard', ship: 'Sachsen' });
      const B = await mkPage(ctx, 'B', 'Bert');
      await join(B, 'V2 Phase2 A'); await B.click('.mp [data-ship="Sachsen"]');
      check(T + 'game starts', await startMatch(A, B));
      await sleep(B, 2000); await B.bringToFront();
      const me = await B.evaluate(() => ({ id: window.__world().player.id, helo: !!window.__world().player.cfg.helo, asw: !!window.__world().player.cfg.weapons.asw }));
      check(T + 'guest ship carries helicopter and ASW torpedoes', me.helo && me.asw, me);
      const pl0 = await plate(B, 'ops-helo');
      check(T + 'helicopter plate is shown to the guest', pl0 && !pl0.hidden, pl0);
      await B.keyboard.press('KeyI');
      check(T + 'I: helicopter exists on the host, owned by the guest', await wait(A, (id) => window.__world().helos.some(h => h.ownerId === id), me.id, 8000));
      check(T + 'the guest world shows the helicopter', await wait(B, () => window.__world().helos.length > 0 && window.__world().helos[0].net === true, null, 8000));
      await sleep(B, 3000);
      const h1 = await B.evaluate(() => { const h = window.__world().helos[0]; return h ? { x: h.pos.x, y: h.pos.y, st: h.state, fuel: h.fuel } : null; });
      await sleep(B, 3000);
      const h2 = await B.evaluate(() => { const h = window.__world().helos[0]; return h ? { x: h.pos.x, y: h.pos.y, st: h.state } : null; });
      check(T + 'helicopter moves on the guest', h1 && h2 && Math.hypot(h1.x - h2.x, h1.y - h2.y) > 20, { h1, h2 });
      const pl1 = await plate(B, 'ops-helo');
      check(T + 'helicopter plate shows state (not the idle text)', pl1 && !pl1.hidden && pl1.txt.length > 8 && !/undefined|NaN/.test(pl1.txt), pl1);
      await shot(B, 'phase2-helo');
      // hostile boat 2.5 km from the guest, on the surface
      await A.evaluate((id) => {
         const w = window.__world(), g = w.ships.find(s => s.id === id);
         w.spawn('Kilo', 'enemy', { x: g.pos.x + 2200, y: g.pos.y }, 0, { telegraph: 0, ai: { passive: true, anchored: true } });
      }, me.id);
      await sleep(B, 2500);
      const torpsBefore = await B.evaluate(() => window.__world().torpedoes.length);
      await B.keyboard.press('KeyG');
      const hostAsw = await wait(A, () => window.__world().torpedoes.some(t => t.asw), null, 6000);
      check(T + 'G: ASW torpedo launched on the host', hostAsw);
      check(T + 'the guest world shows it (asw torpedo)', await wait(B, () => window.__world().torpedoes.some(t => t.asw), null, 6000), { before: torpsBefore });
      const ap = await B.evaluate(() => document.getElementById('tu-asw') ? 'touch' : [...document.querySelectorAll('[data-key="G"]')].map(e => e.innerText.replace(/\s+/g, ' ').slice(0, 40)));
      await shot(B, 'phase2-asw');
      check(T + 'no console errors', errors.length === e0, errors.slice(e0, e0 + 3));
      await closeAll(ctx);
   }
   // ---- scenario 2: guest in a submarine with a SEAL team, a task point beside it
   {
      const T = 'phase2 team: ', ctx = await newContext(), e1 = errors.length;
      const A = await mkPage(ctx, 'A', 'Anna'); await host(A, { name: 'V2 Phase2 B', mission: 'standard', ship: 'Sachsen' });
      const B = await mkPage(ctx, 'B', 'Bert');
      await join(B, 'V2 Phase2 B'); await B.click('.mp [data-ship="U212"]');
      check(T + 'game starts', await startMatch(A, B));
      await sleep(B, 2000); await B.bringToFront();
      const me = await B.evaluate(() => ({ id: window.__world().player.id, seal: !!window.__world().player.cfg.sub?.seal, depth: window.__world().player.depth }));
      check(T + 'guest sails a boat with a team', me.seal && me.depth <= 1, me);
      await A.evaluate(async (id) => {
         const w = window.__world(), g = w.ships.find(s => s.id === id), S = await import('./gamev2/seal.js');
         S.addTaskPoint(w, { x: g.pos.x + 600, y: g.pos.y + 100, label: 'Sender sprengen', side: 'player', workTime: 6 });
      }, me.id);
      check(T + 'the task point reaches the guest world', await wait(B, () => window.__world().taskPoints.length > 0, null, 8000));
      for (let i = 0; i < 5; i++) { await B.keyboard.press('KeyS'); await sleep(B, 150); }      // telegraph to stop; the plate must stop saying "zu schnell"
      check(T + 'plate follows the speed (no "zu schnell" once slow)', await wait(B, () => { const e = document.querySelector('.ops-team'); return !!e && !/schnell/i.test(e.innerText); }, null, 40000), await plate(B, 'ops-team'));
      await B.keyboard.press('KeyK');
      check(T + 'K: team in the water on the host', await wait(A, (id) => window.__world().teams.some(t => t.ownerId === id), me.id, 8000), await B.evaluate(() => [...document.querySelectorAll('#hud *')].filter(e => !e.children.length && /Trupp|Tief|schnell|Einsatz/.test(e.textContent)).map(e => e.textContent).slice(0, 3)));
      check(T + 'the guest world shows the team', await wait(B, () => window.__world().teams.length > 0, null, 8000));
      check(T + 'team plate shows the team under way (replicated state)', await wait(B, () => { const e = document.querySelector('.ops-team'); return !!e && /unterwegs|arbeitet|kehrt/.test(e.innerText); }, null, 8000), await plate(B, 'ops-team'));
      await shot(B, 'phase2-team');
      check(T + 'no console errors', errors.length === e1, errors.slice(e1, e1 + 3));
      await closeAll(ctx);
   }
   // ---- scenario 3: the large blast of `countdown`
   {
      const T = 'phase2 blast: ', ctx = await newContext(), e1 = errors.length;
      const A = await mkPage(ctx, 'A', 'Anna'); await host(A, { name: 'V2 Phase2 C', mission: 'countdown' });
      const B = await mkPage(ctx, 'B', 'Bert');
      check(T + 'B joins', await join(B, 'V2 Phase2 C'));
      check(T + 'game starts', await startMatch(A, B));
      await sleep(B, 2000); await B.bringToFront();
      await A.evaluate(() => { const w = window.__world(); w.timeLeft = 8; });     // the script arms the final blast at <= 4 s
      check(T + 'blast armed on the host', await wait(A, () => window.__world().blasts.length > 0, null, 15000));
      check(T + 'blast reaches the guest (armed)', await wait(B, () => window.__world().blasts.some(b => b.state === 'armed' || b.state === 'done'), null, 8000));
      await shot(B, 'phase2-blast-armed');
      const white = await wait(B, () => { const e = document.querySelector('.blast-white'); return !!e && parseFloat(getComputedStyle(e).opacity) > 0.05; }, null, 12000);
      const done = await wait(B, () => window.__world().blasts.some(b => b.state === 'done'), null, 12000);
      await shot(B, 'phase2-blast-done');
      check(T + 'blast detonates on the guest (state done)', done, { white });
      await sleep(B, 1500);
      check(T + 'both pages still run after the blast', await wait(B, () => !!window.__world() , null, 3000) && await wait(A, () => !!window.__world(), null, 3000));
      check(T + 'no console errors', errors.length === e1, errors.slice(e1, e1 + 3));
      await closeAll(ctx);
   }
}

// ====================================================================== host migration
if (ONLY.includes('migrate')) {
   const T = 'migrate: ', ctx = await newContext(), e1 = errors.length;
   await ctx.addInitScript(() => { window.__netMeasure = true; });
   const A = await mkPage(ctx, 'A', 'Anna'); await host(A, { name: 'V2 Wechsel', mission: 'standard', ship: 'Sachsen' });
   const B = await mkPage(ctx, 'B', 'Bert');
   await join(B, 'V2 Wechsel');
   check(T + 'game starts', await startMatch(A, B));
   const idB = await B.evaluate(() => window.__world().player.id), idA = await A.evaluate(() => window.__world().player.id);
   const peerB = await B.evaluate(() => window.__mp.lobby.selfId);
   check(T + 'the host names B as successor', await wait(A, (b) => window.__net().successor === b, peerB, 10000));
   // a busy scene: many missiles in the air (ours and hostile ones), so the full state is large
   await A.evaluate(async () => {
      const w = window.__world(), M = await import('./gamev2/missile.js'), St = await import('./gamev2/sites.js');
      const p = w.player; for (const k of Object.keys(p.mag)) p.mag[k] = 99;
      for (let i = 0; i < 14; i++) { p.lastSsmFire = -99; M.launchSSM(w, p, { bearing: -0.4 + i * 0.06 }); }
      const site = St.addSite(w, 'battery', 'enemy', { x: p.pos.x + 9000, y: p.pos.y - 7000 });
      for (let i = 0; i < 14; i++) { site.lastSsmFire = -99; M.launchSSM(w, site, { bearing: Math.atan2(p.pos.y - site.pos.y, p.pos.x - site.pos.x) + (i - 7) * 0.02 }); }
   });
   await sleep(A, 4500);
   const busy = await A.evaluate(() => ({ missiles: window.__world().missiles.filter(m => m.alive).length, mig: window.__net().mig, seconds: window.__net().seconds }));
   const kB = busy.mig.bytes / Math.max(1, busy.mig.count) / 1000;
   console.log(`   busy scene: ${busy.missiles} missiles, full state ${kB.toFixed(1)} kB avg (${busy.mig.count} sent)`);
   check(T + 'full state is sent about once a second', busy.mig.count >= 3, busy.mig);
   check(T + 'full state of a busy scene is sane (sent in pieces of 9 kB at most, so below the 16 kB transport limit)', kB < 40, +kB.toFixed(1));
   await shot(B, 'migrate-1-before');
   const before = await A.evaluate(() => ({ t: window.__world().time, hp: window.__world().ships.filter(s => s.side === 'enemy').map(s => [s.id, Math.round(s.hp)]) }));
   const t0 = Date.now();
   await A.close({ runBeforeUnload: true });
   const took = await wait(B, () => window.__net()?.isHost === true, null, 20000);
   console.log(`   B is host after ${Date.now() - t0} ms`);
   check(T + 'B took over as host', took, await B.evaluate(() => { const n = window.__net(); return { isHost: n.isHost, lost: n.lost, mig: n.migrated }; }));
   check(T + 'the match was not lost on B', await B.evaluate(() => !window.__net().lost && window.__phase() === 'playing'));
   const info = await B.evaluate(() => window.__net().migrated);
   console.log('   ' + JSON.stringify(info));
   const tB = await B.evaluate(() => window.__world().time);
   check(T + 'the world runs on under B', await wait(B, (t) => window.__world().time > t + 3, tB, 15000));
   const after = await B.evaluate(() => ({ missiles: window.__world().missiles.filter(m => m.alive).length, ships: window.__world().ships.filter(s => s.alive).length, bots: window.__world().ships.filter(s => s.alive && !s.human && !s.isPlayer && s.ai).length }));
   check(T + 'missiles and ships carried over (at least half of the missiles)', after.missiles >= Math.floor(busy.missiles * 0.5) && after.ships > 3 && after.bots > 2, { before: busy.missiles, after });
   const mp = await B.evaluate(async () => { const w = window.__world(); return { enemyHp: w.ships.filter(s => s.side === 'enemy').map(s => [s.id, Math.round(s.hp)]) }; });
   const kept = before.hp.filter(([id, hp]) => { const q = mp.enemyHp.find(x => x[0] === id); return q && q[1] <= hp + 1; }).length;
   check(T + 'enemy damage kept (no enemy healed)', kept === before.hp.length, { kept, of: before.hp.length });
   await B.bringToFront();
   const tel0 = await B.evaluate(() => window.__ctl().telegraph);
   await B.keyboard.press(tel0 > 0 ? 'KeyS' : 'KeyW'); await sleep(B, 200);
   const tel1 = await B.evaluate(() => window.__ctl().telegraph);
   check(T + 'B steers its own ship on its own world', tel1 !== tel0 && await wait(B, (t) => window.__world().player.telegraph === t, tel1, 5000), [tel0, tel1]);
   const fire = await B.evaluate(() => window.__world().missiles.length);
   await B.keyboard.press('Digit2'); await sleep(B, 200); await B.keyboard.press('Space');
   check(T + 'B can fire a missile as host', await wait(B, (n) => window.__world().missiles.some(m => m.ownerId === window.__world().player.id && m.t < 3), fire, 6000));
   await shot(B, 'migrate-2-after');
   check(T + 'no console errors', errors.length === e1, errors.slice(e1, e1 + 3));
   await closeAll(ctx);
}

check('no request or WebSocket tried to leave localhost', external.length === 0, external.slice(0, 5));
const bad = results.filter(r => !r.ok).length;
console.log(`${results.length - bad}/${results.length} checks passed, console errors: ${errors.length}`);
if (errors.length) console.log(errors.slice(0, 8).join('\n'));
await browser.close();
process.exit(bad || errors.length ? 1 : 0);
