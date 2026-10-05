// V2 presentation of helicopters, ASW torpedoes, special-forces teams and the scripted large
// detonation: every situation is made through the sim API in the page, then meshes, plates and
// commands (key and finger) are checked. Screenshots go to tests/shots/v2-view2-*.png.
// Usage: node server.js 8832   then   URLV2=http://localhost:8832/index-v2.html node tests/playwrightv2.view2.mjs
//       (ONLY=helo,asw,team,phone,blast,perf to limit; NO_GPU=1 for software GL)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URLV2 || 'http://localhost:8832/index-v2.html';
const OUT = process.env.OUT || 'tests/shots';
const ONLY = (process.env.ONLY || 'helo,asw,team,phone,blast,perf,menu').split(',');
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const GPU = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: GPU });
const freeBrowser = ONLY.includes('perf') ? await chromium.launch({ args: [...GPU, '--disable-gpu-vsync', '--disable-frame-rate-limit'] }) : null;

async function open(tag, { w, h, touch = false, ship = 'Sachsen', gfx = null, free = false }) {
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
      shot: n => page.screenshot({ path: `${OUT}/v2-view2-${n}.png` }),
      waitFor: (fn, ms = 4000, arg) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false),
      tap: async sel => {
         const r = await page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const q = e.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2, w: q.width, h: q.height }; }, sel);
         if (!r || !r.w) return null;
         await page.touchscreen.tap(r.x, r.y); await page.waitForTimeout(220);
         return r;
      },
   };
   await S.ev(ship => window.__start({ mission: 'training', ship, difficulty: 'normal' }), ship);
   await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 30000 });
   await S.wait(2200);
   // the scenes need a ship that lives through them
   await S.ev(() => { const w = window.__world(); for (const s of w.ships) if (s.side !== w.player.side) s.telegraph = 0; w.bots.length = 0; w.player.hp = w.player.maxHP; });
   return S;
}
// plate: visible, text, rectangle
const plate = (S, sel) => S.ev(sel => {
   const e = document.querySelector(sel); if (!e) return null;
   const q = e.getBoundingClientRect();
   return { shown: !e.classList.contains('hidden') && q.width > 0 && getComputedStyle(e).display !== 'none', text: e.innerText.replace(/\s+/g, ' ').trim(), x: Math.round(q.left), y: Math.round(q.top), w: Math.round(q.width), h: Math.round(q.height) };
}, sel);
const ops = S => S.ev(() => {
   const w = window.__world(), r = window.__renderer3d, o = r.ops, b = r.blast, u = window.__opsui(), h = w.helos[0];
   return { helos: w.helos.length, state: h ? h.state : null, mode: h ? h.mode : null, alt: h ? Math.round(h.alt) : null, drawnH: o.helos, air: r.air?.drawn ?? 0, marks: o.marks, boats: o.boats, dips: o.dips, splashes: o.splashes,
      mapMode: u.mapMode, teams: w.teams.map(t => t.state), tasks: w.taskPoints.map(t => t.state), asw: w.torpedoes.filter(t => t.asw).length,
      blast: { active: b.active, lobes: b.lobes, white: +b.white.toFixed(3), shake: +b.shake.toFixed(2) }, map: window.__ctl().mapOpen };
});
// plates of the right column must not lie on each other or on the fixed HUD
const overlaps = S => S.ev(() => {
   const sels = ['#ops-panel .ops-helo', '#ops-panel .ops-team', '#asw-panel', '#sub-panel', '#weapons', '#cons', '#minimap-wrap', '#ship-card', '#mx-sys', '#mx-threat', '#tu-fire', '#tu-asw', '#tu-map', '#tu-dive', '#tu-up', '#tu-more'];
   const rs = [];
   for (const s of sels) { const e = document.querySelector(s); if (!e || e.classList.contains('hidden')) continue; const q = e.getBoundingClientRect(); if (q.width > 0 && getComputedStyle(e).visibility !== 'hidden') rs.push({ s, q }); }
   const bad = [];
   for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i].q, b = rs[j].q;
      if (!rs[i].s.startsWith('#ops') && !rs[j].s.startsWith('#ops')) continue;
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) bad.push(rs[i].s + ' x ' + rs[j].s);
   }
   const out = rs.filter(r => r.s.startsWith('#ops') && (r.q.left < 0 || r.q.top < 0 || r.q.right > innerWidth + 1 || r.q.bottom > innerHeight + 1)).map(r => r.s + ' off screen');
   return bad.concat(out);
});
const mapXY = (S, wx, wy) => S.ev(async ([wx, wy]) => {
   const M = await import('./gamev2/missileui.js'), r = M.tacticalMapRect(innerWidth, innerHeight), A = window.__world().arena, sc = r.size / (A * 2);
   return { x: r.x0 + (wx + A) * sc, y: r.y0 + (wy + A) * sc };
}, [wx, wy]);

// ------------------------------------------------------------------ helicopter (desktop, keys)
if (ONLY.includes('helo')) {
   const S = await open('helo', { w: 1440, h: 810, ship: 'Sachsen' });
   let pl = await plate(S, '#ops-panel .ops-helo');
   check('helo: plate HUBSCHRAUBER is shown on a ship with a helicopter', pl && pl.shown && /HUBSCHRAUBER/i.test(pl.text), pl);
   check('helo: plates do not overlap the HUD (desktop)', (await overlaps(S)).length === 0, await overlaps(S));
   await S.shot('helo-deck');
   await S.key('KeyI');
   await S.waitFor(() => window.__world().helos.length === 1 && window.__renderer3d.ops.helos >= 1, 4000);
   let o = await ops(S);
   check('helo: key I launches it and the mesh is drawn', o.helos === 1 && o.drawnH >= 1 && o.air >= 1, o);
   await S.ev(() => window.__setAim(Math.PI, 600));
   await S.wait(1200); await S.shot('helo-liftoff');
   await S.wait(2500);
   pl = await plate(S, '#ops-panel .ops-helo');
   o = await ops(S);
   check('helo: it climbs off the deck and the plate reports the flight', o.alt > 20 && !/bereit/i.test(pl.text), { alt: o.alt, text: pl.text });
   await S.ev(() => window.__setAim(0, 3000)); await S.wait(600); await S.shot('helo-flying');
   // tactical map: I arms the map mode, a click sends the helicopter there
   await S.key('KeyM'); await S.wait(400);
   await S.key('KeyI');
   o = await ops(S);
   check('helo: I on the open map arms the map mode', o.map && o.mapMode, o);
   const tgt = await S.ev(() => { const p = window.__world().player.pos; return { x: p.x + 2600, y: p.y + 1800 }; });
   const mp = await mapXY(S, tgt.x, tgt.y);
   await S.page.mouse.move(mp.x, mp.y); await S.wait(150);
   await S.shot('helo-mapmode');
   await S.page.mouse.click(mp.x, mp.y); await S.wait(500);
   const g = await S.ev(() => { const h = window.__world().helos[0]; return h ? { mode: h.mode, x: h.goal.x, y: h.goal.y } : null; });
   check('helo: a click on the map sends it to that point', g && g.mode === 'point' && Math.hypot(g.x - tgt.x, g.y - tgt.y) < 400, { g, tgt });
   // put it over the point: it comes down and dips
   await S.ev(() => { const h = window.__world().helos[0]; h.pos.x = h.goal.x - 60; h.pos.y = h.goal.y; h.prev.x = h.pos.x; h.prev.y = h.pos.y; });
   const dipped = await S.waitFor(() => window.__renderer3d.ops.dips >= 1, 15000);
   await S.wait(400);
   await S.shot('helo-map-dip');
   check('helo: the dip draws a ring on the water and a ping on the map', dipped && await S.ev(() => window.__opsui().pings.some(p => p.on !== false)), await ops(S));
   await S.key('KeyM'); await S.wait(300);
   await S.ev(() => { const w = window.__world(), h = w.helos[0], p = w.player; h.pos.x = p.pos.x + 260; h.pos.y = p.pos.y + 120; h.prev.x = h.pos.x; h.prev.y = h.pos.y; window.__setAim(0.4, 400); });
   await S.wait(900); await S.shot('helo-close');
   await S.key('KeyI');
   o = await ops(S);
   check('helo: I with the map closed calls it back', o.state === 'return', o);
   const landed = await S.waitFor(() => window.__world().helos.length === 0 || window.__world().helos[0].alive === false, 30000);
   pl = await plate(S, '#ops-panel .ops-helo');
   check('helo: it lands and the plate shows the turnaround', landed && /klar|bereit|Deck|\d+ ?s/i.test(pl.text), pl);
   // loss
   await S.ev(async () => { const w = window.__world(), p = w.player, H = await import('./gamev2/helo.js'); p.heloT = 0; const c = p.consumable && p.consumable('helo'); if (c) c.cd = 0; const h = H.launchHelo(w, p); if (h) { h.alt = 90; H.killHelo(w, h, null, 'sam'); } });
   await S.wait(1200);
   check('helo: a shot-down helicopter leaves the list without errors', (await ops(S)).helos === 0 || await S.ev(() => window.__world().helos.every(h => !h.alive)), await ops(S));
   await S.ctx.close();
}

// ------------------------------------------------------------------ lightweight torpedo (desktop)
if (ONLY.includes('asw')) {
   const S = await open('asw', { w: 1440, h: 810, ship: 'Sachsen' });
   await S.ev(() => {
      const w = window.__world(), p = w.player;
      const T = w.spawn('U212', 'enemy', { x: p.pos.x + Math.cos(p.heading + 0.6) * 1500, y: p.pos.y + Math.sin(p.heading + 0.6) * 1500 }, 0);
      w.bots.length = 0; T.depth = 1; T.detected = true; T.visible = true; T.sonarSeen = { x: T.pos.x, y: T.pos.y, t: w.time };
      window.__keep = setInterval(() => { if (T.alive) { T.detected = true; T.sonarSeen = { x: T.pos.x, y: T.pos.y, t: w.time }; } }, 100);
   });
   await S.wait(600);
   let pl = await plate(S, '#asw-panel');
   check('asw: plate reads U-JAGD-TORPEDO with a contact', pl && pl.shown && /U-JAGD-TORPEDO/i.test(pl.text) && /Kontakt/i.test(pl.text) && !/kein Kontakt/i.test(pl.text), pl);
   check('asw: plates do not overlap the HUD', (await overlaps(S)).length === 0, await overlaps(S));
   await S.ev(() => window.__setAim(0.6, 1200));
   await S.key('KeyG');
   await S.wait(500);
   let o = await ops(S);
   check('asw: G drops a lightweight torpedo with a splash', o.asw === 1 && o.splashes >= 1, o);
   await S.shot('asw-splash');
   await S.wait(2500); await S.shot('asw-run');
   pl = await plate(S, '#asw-panel');
   check('asw: the plate counts down and shows the reload', /\d\/\d/.test(pl.text), pl);
   await S.key('KeyM'); await S.wait(500); await S.shot('asw-map'); await S.key('KeyM');
   await S.ev(() => clearInterval(window.__keep));
   await S.ctx.close();
}

// ------------------------------------------------------------------ special-forces team (desktop)
const stopBoat = S => S.ev(() => { const w = window.__world(), p = w.player; window.__keep = setInterval(() => { p.speed = 0; p.telegraph = 0; }, 30); p.speed = 0; });
const addTask = (S, d = 1100) => S.ev(async (d) => {
   const w = window.__world(), p = w.player, Se = await import('./gamev2/seal.js');
   const t = Se.addTaskPoint(w, { x: p.pos.x + Math.cos(p.heading + 0.5) * d, y: p.pos.y + Math.sin(p.heading + 0.5) * d, kind: 'sabotage', label: 'Radarstation', workTime: 6 });
   return { id: t.id, x: t.x, y: t.y };
}, d);
if (ONLY.includes('team')) {
   const S = await open('team', { w: 1440, h: 810, ship: 'U212' });
   let pl = await plate(S, '#ops-panel .ops-team');
   check('team: plate KOMMANDOTRUPP is shown on a boat with a team', pl && pl.shown && /KOMMANDOTRUPP/i.test(pl.text), pl);
   await S.key('KeyK'); await S.wait(300);
   check('team: K without a task point does nothing', (await ops(S)).teams.length === 0);
   await stopBoat(S);
   await addTask(S);
   await S.ev(() => window.__setAim(0.5, 1100));
   await S.wait(700);
   let o = await ops(S);
   pl = await plate(S, '#ops-panel .ops-team');
   check('team: the task point has a marker in the world', o.marks >= 1, { marks: o.marks, text: pl.text });
   check('team: plates do not overlap the HUD', (await overlaps(S)).length === 0, await overlaps(S));
   await S.shot('team-point');
   await S.key('KeyK'); await S.wait(600);
   o = await ops(S);
   check('team: K puts the team out, the boat is drawn', o.teams[0] === 'out' && o.boats >= 1 && o.tasks[0] === 'busy', o);
   await S.ev(() => window.__setAim(0.5, 300)); await S.wait(900);
   await S.shot('team-out');
   await S.key('KeyM'); await S.wait(500); await S.shot('team-map'); await S.key('KeyM');
   // jump the boat to the point: work, then the way back
   await S.ev(() => { const w = window.__world(), t = w.teams[0], k = w.taskPoints[0]; t.x = k.x - 5; t.y = k.y; t.pos.x = t.x; t.pos.y = t.y; });
   const working = await S.waitFor(() => window.__world().teams[0].state === 'working', 6000);
   await S.wait(500);
   pl = await plate(S, '#ops-panel .ops-team');
   check('team: the plate shows the work in progress', working && /arbeit|%|\d+ ?s/i.test(pl.text), pl);
   await S.shot('team-working');
   const back = await S.waitFor(() => window.__world().teams[0].state === 'returning', 12000);
   o = await ops(S);
   check('team: work done, point marked done, team on the way back', back && o.tasks[0] === 'done', o);
   await S.ev(() => { const w = window.__world(), t = w.teams[0], p = w.player; t.x = p.pos.x + 150; t.y = p.pos.y; t.pos.x = t.x; t.pos.y = t.y; });
   await S.wait(500);
   pl = await plate(S, '#ops-panel .ops-team');
   await S.shot('team-returning');
   const rec = await S.waitFor(() => window.__world().teams[0].state === 'recovered', 20000);
   check('team: the stopped boat takes the team aboard', rec, { plate: pl.text, state: (await ops(S)).teams });
   await S.ev(() => clearInterval(window.__keep));
   await S.ctx.close();
}

// ------------------------------------------------------------------ phone 844x390: the same by finger
if (ONLY.includes('phone')) {
   let S = await open('phone-helo', { w: 844, h: 390, touch: true, ship: 'Sachsen' });
   let pl = await plate(S, '#ops-panel .ops-helo');
   check('phone: helicopter plate is on screen and large enough for a finger', pl && pl.shown && pl.w >= 40 && pl.h >= 30 && pl.x >= 0 && pl.y >= 0 && pl.x + pl.w <= 845 && pl.y + pl.h <= 391, pl);
   check('phone: plates do not overlap the controls (surface ship)', (await overlaps(S)).length === 0, await overlaps(S));
   await S.shot('phone-helo');
   await S.tap('#ops-panel .ops-helo');
   await S.waitFor(() => window.__world().helos.length === 1, 3000);
   check('phone: a tap on the plate launches the helicopter', (await ops(S)).helos === 1, await ops(S));
   await S.wait(3500);
   await S.tap('#ops-panel .ops-helo');
   check('phone: a second tap calls it back', (await ops(S)).state === 'return', await ops(S));
   await S.ev(() => {
      const w = window.__world(), p = w.player;
      const T = w.spawn('U212', 'enemy', { x: p.pos.x + 1400, y: p.pos.y + 300 }, 0);
      w.bots.length = 0; T.depth = 1;
      window.__keep = setInterval(() => { if (T.alive) { T.detected = true; T.sonarSeen = { x: T.pos.x, y: T.pos.y, t: w.time }; } }, 100);
   });
   await S.wait(700);
   const b = await plate(S, '#tu-asw');
   check('phone: the ASW button reads U-Jagd-Torpedo', b && b.shown && /U-Jagd/i.test(b.text), b);
   await S.shot('phone-asw');
   await S.tap('#tu-asw'); await S.wait(400);
   check('phone: a tap on it drops the torpedo', (await ops(S)).asw === 1, await ops(S));
   await S.ev(() => clearInterval(window.__keep));
   await S.ctx.close();

   S = await open('phone-team', { w: 844, h: 390, touch: true, ship: 'U212' });
   await stopBoat(S); await addTask(S, 900); await S.wait(600);
   pl = await plate(S, '#ops-panel .ops-team');
   check('phone: team plate is on screen', pl && pl.shown && pl.w >= 40 && pl.h >= 30 && pl.x >= 0 && pl.x + pl.w <= 845 && pl.y >= 0 && pl.y + pl.h <= 391, pl);
   check('phone: plates do not overlap the controls (submarine)', (await overlaps(S)).length === 0, await overlaps(S));
   await S.shot('phone-team');
   await S.tap('#ops-panel .ops-team'); await S.wait(400);
   check('phone: a tap on the plate puts the team out', (await ops(S)).teams[0] === 'out', await ops(S));
   await S.shot('phone-team-out');
   await S.ev(() => clearInterval(window.__keep));
   await S.ctx.close();
}

// ------------------------------------------------------------------ large detonation, tiers high and low
if (ONLY.includes('blast')) {
   for (const gfx of ['high', 'low']) {
      const S = await open('blast-' + gfx, { w: 1440, h: 810, ship: 'Sachsen', gfx });
      await S.ev(async () => {
         const w = window.__world(), p = w.player, B = await import('./gamev2/blast.js');
         window.__b = B.addBlast(w, { x: p.pos.x + Math.cos(p.heading) * 6500, y: p.pos.y + Math.sin(p.heading) * 6500, radius: 3000, delay: 5, label: 'Munitionsfrachter' });
         window.__setAim(0, 6500);
      });
      await S.key('KeyM'); await S.wait(600);
      await S.shot('blast-' + gfx + '-map-armed');
      await S.key('KeyM');
      check(`blast ${gfx}: nothing is drawn before the detonation`, (await ops(S)).blast.active === 0, (await ops(S)).blast);
      await S.waitFor(() => window.__b.state === 'done', 9000);
      await S.waitFor(() => window.__renderer3d.blast.white > 0.2, 1500);
      const o0 = await ops(S);
      const dom = await S.ev(() => { const e = document.getElementById('blast-white'); return e ? +getComputedStyle(e).opacity : -1; });
      check(`blast ${gfx}: flash whites the screen out`, o0.blast.active === 1 && o0.blast.white > 0.2 && dom > 0.1, { ...o0.blast, dom });
      await S.shot('blast-' + gfx + '-flash');
      for (const at of [2, 10, 40]) {
         await S.waitFor(at => window.__b.age >= at, 45000, at);
         await S.shot('blast-' + gfx + '-' + at + 's');
         const o = await ops(S);
         check(`blast ${gfx}: cloud is drawn at ${at} s`, o.blast.active === 1 && o.blast.lobes > 3, o.blast);
         if (at === 2) check(`blast ${gfx}: the whiteout is over after 2 s`, o.blast.white < 0.35, o.blast);
      }
      const shook = await S.ev(() => window.__shakeMax || 0);
      await S.key('KeyM'); await S.wait(600); await S.shot('blast-' + gfx + '-map-done'); await S.key('KeyM');
      check(`blast ${gfx}: the cloud still stands after 62 s`, await S.waitFor(() => window.__b.age >= 62, 30000) && (await ops(S)).blast.lobes > 3, { shook, ...(await ops(S)).blast });
      await S.shot('blast-' + gfx + '-62s');
      await S.ctx.close();
   }
}

// ------------------------------------------------------------------ frame time: helicopter + team + detonation vs. idle (tier medium)
if (ONLY.includes('perf')) {
   const S = await open('perf', { w: 1440, h: 810, ship: 'Sachsen', gfx: 'medium', free: true });
   const sample = (ms) => S.ev((ms) => new Promise(res => {
      const d = []; let last = performance.now(); const t0 = last;
      const f = (t) => { d.push(t - last); last = t; if (t - t0 < ms) requestAnimationFrame(f); else { d.shift(); d.sort((a, b) => a - b); res({ n: d.length, avg: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2), p95: +d[Math.floor(d.length * 0.95)].toFixed(2), max: +d[d.length - 1].toFixed(2) }); } };
      requestAnimationFrame(f);
   }), ms);
   await S.ev(() => window.__setAim(0, 5000));
   await S.wait(1500);
   const base = await sample(6000);
   await S.ev(async () => {
      const w = window.__world(), p = w.player, H = await import('./gamev2/helo.js'), Se = await import('./gamev2/seal.js'), B = await import('./gamev2/blast.js');
      const c = Math.cos(p.heading), s = Math.sin(p.heading);
      const h = H.sendHelo(w, p, { x: p.pos.x + c * 900, y: p.pos.y + s * 900 });
      const sub = w.spawn('U212', p.side, { x: p.pos.x + c * 500 - s * 300, y: p.pos.y + s * 500 + c * 300 }, p.heading);
      w.bots.length = 0; sub.speed = 0; sub.telegraph = 0; sub.depth = 0;
      Se.addTaskPoint(w, { x: sub.pos.x + c * 2000, y: sub.pos.y + s * 2000, label: 'Punkt', side: p.side });
      window.__team = Se.launchTeam(w, sub);
      window.__b = B.addBlast(w, { x: p.pos.x + c * 5000, y: p.pos.y + s * 5000, radius: 2500, delay: 0.2, label: 'Test' });
      window.__h = h;
   });
   await S.wait(1500);
   const live = await ops(S);
   const busy = await sample(6000);
   await S.shot('perf-busy');
   const late = await sample(4000);
   console.log('FRAMETIME tier medium 1440x810  idle: ' + JSON.stringify(base) + '   helicopter + team + detonation (0-8 s): ' + JSON.stringify(busy) + '   (8-12 s): ' + JSON.stringify(late));
   check('perf: the scene really ran (helicopter, team boat, detonation drawn)', live.helos === 1 && live.boats >= 1 && live.blast.active === 1, live);
   check('perf: helicopter + team + detonation cost less than 3 ms per frame on average (uncapped, medium)', busy.avg - base.avg < 3 && late.avg - base.avg < 3, { base: base.avg, busy: busy.avg, late: late.avg });
   await S.ctx.close();
}

// ------------------------------------------------------------------ menu texts and the HUD layout of the finale
if (ONLY.includes('menu')) {
   for (const [tag, w, h, touch] of [['desk', 1440, 810, false], ['phone', 844, 390, true]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
      const page = await ctx.newPage();
      page.on('console', m => { if (m.type() === 'error') errors.push('menu-' + tag + ': ' + m.text().slice(0, 300)); });
      page.on('pageerror', e => errors.push('menu-' + tag + ' PAGEERROR: ' + e.message));
      await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
      await page.goto(URL + '?nohint', { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 30000 });
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}/v2-view2-menu-${tag}.png` });
      const m = await page.evaluate(() => {
         const e = document.querySelector('.m3-era'); if (!e) return null;
         const r = e.getBoundingClientRect(), bar = e.parentElement.getBoundingClientRect();
         const sib = [...e.parentElement.children].filter(c => c !== e).map(c => c.getBoundingClientRect());
         const hit = sib.some(q => Math.min(q.right, r.right) - Math.max(q.left, r.left) > 1 && Math.min(q.bottom, r.bottom) - Math.max(q.top, r.top) > 1);
         const t = document.body.innerText;
         return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), inside: r.right <= innerWidth && r.bottom <= innerHeight && r.left >= 0 && r.top >= 0, hit, text: e.innerText.replace(/\s+/g, ' '),
            old: /Historisch|HISTORISCH|1939|Sprenggranate|Panzergranate|Torpedobomber|Sturzkampf/.test(t + document.getElementById('loading')?.innerText) };
      });
      check(`menu ${tag}: mode button is visible, inside the screen, overlaps nothing`, m && m.w > 20 && m.inside && !m.hit && /HAUPTSPIEL|WK2/.test(m.text), m);
      check(`menu ${tag}: no WW2 wording left on the start screen`, m && !m.old, m);
      // the ship card shows the modern loadout; the mission list says Einsatz
      const card = await page.evaluate(async () => { const M = await import('./gamev2/config.js'); const S = M.SHIP_STATS; return Object.keys(S).length; });
      const txt = await page.evaluate(() => document.body.innerText);
      if (tag === 'desk') {
         await page.evaluate(() => document.querySelector('[data-act="ship"], .m3-tab[data-tab="ship"]')?.click());
         await page.waitForTimeout(400);
         const t2 = await page.evaluate(() => document.body.innerText);
         check('menu: ship card lists missiles / air defence, not shell types', /Seezielflugkörper|Luftabwehr|Marschflugkörper/.test(t2) && !/Sprenggranate|Panzergranate/.test(t2), { card, hasEinsatz: /Einsätze/.test(txt) });
         await page.screenshot({ path: `${OUT}/v2-view2-menu-ship.png` });
      }
      await ctx.close();
   }
   // the finale, with an incoming salvo: objectives, VAMPIRE plate and the radio banner must not lie on each other
   for (const [tag, w, h, touch] of [['desk', 1440, 810, false], ['phone', 844, 390, true]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
      const page = await ctx.newPage();
      page.on('console', m => { if (m.type() === 'error') errors.push('lay-' + tag + ': ' + m.text().slice(0, 300)); });
      page.on('pageerror', e => errors.push('lay-' + tag + ' PAGEERROR: ' + e.message));
      await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
      await page.goto(URL + '?nohint', { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 30000 });
      await page.evaluate(() => window.__start({ mission: 'countdown', difficulty: 'normal' }));
      await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 30000 });
      await page.waitForTimeout(2500);
      await page.evaluate(async () => {
         const w = window.__world(), p = w.player, M = await import('./gamev2/missile.js'), St = await import('./gamev2/sites.js');
         w.message('Funkspruch: Verband meldet starke Luftaktivität im Nordosten, Gegenmaßnahmen einleiten und Position halten.', 'info');
         p.hp = p.maxHP;
         const site = St.addSite(w, 'battery', 'enemy', { x: p.pos.x + 9000, y: p.pos.y - 7000 });
         const brg = Math.atan2(p.pos.y - site.pos.y, p.pos.x - site.pos.x);
         for (let i = 0; i < 3; i++) { site.lastSsmFire = -99; M.launchSSM(w, site, { bearing: brg + (i - 1) * 0.02 }); }
      });
      await page.waitForTimeout(1600);
      const L = await page.evaluate(() => {
         const R = s => { const e = document.querySelector(s); if (!e) return null; const q = e.getBoundingClientRect(); const cs = getComputedStyle(e); return (cs.display === 'none' || q.width < 2 || e.classList.contains('hidden')) ? null : { l: q.left, t: q.top, r: q.right, b: q.bottom, op: +cs.opacity * +getComputedStyle(e.parentElement).opacity }; };
         const o = R('#objectives'), thr = R('#mx-threat'), msg = R('.msg.radio');
         const hit = (a, b) => a && b && a.op > 0.3 && b.op > 0.3 && Math.min(a.r, b.r) - Math.max(a.l, b.l) > 2 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 2;
         const lines = [...document.querySelectorAll('#objectives .obj')].map(e => e.scrollHeight - e.clientHeight);
         const ob = document.getElementById('objectives');
         const clipped = ob ? ob.scrollHeight > ob.clientHeight + 1 || ob.getBoundingClientRect().bottom > innerHeight - 90 * (innerHeight < 500) : false;
         return { o, thr: !!thr, msg: !!msg, objThr: hit(o, thr), objMsg: hit(o, msg), thrMsg: hit(thr, msg), clipped, lines };
      });
      check(`layout ${tag}: objectives / VAMPIRE plate / radio banner do not overlap`, L.thr && L.msg && !L.objThr && !L.objMsg && !L.thrMsg, L);
      check(`layout ${tag}: objectives are not clipped`, !L.clipped && L.lines.every(v => v <= 1), L);
      await page.screenshot({ path: `${OUT}/v2-view2-layout-${tag}.png` });
      await ctx.close();
   }
}

await browser.close(); await freeBrowser?.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of errors.slice(0, 12)) console.log('  ERR ' + e);
process.exit(failed.length || errors.length ? 1 : 0);
