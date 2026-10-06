// tests/playwrightv2.leak.mjs -- a long game of V2 on a phone tier: nothing may climb steadily.
// One fleet fight (mission "standard", tier medium, 844x390 touch) runs for 10 minutes of game time with missile
// salvos, air defence, decoys and a helicopter kept going the whole time. Once a minute, after a forced garbage
// collection: geometries / textures / shader programs (renderer.info), DOM nodes, JS heap, live particles.
// Then back to the menu, a second mission (redsea), the menu, the first mission once more and the menu again:
// the menu holds no battle scene, and a mission played a second time leaves nothing more behind than the first time.
// Exit code 1 when a count keeps climbing or on a console error.
//
// Run:  node server.js 8838   then   URLV2=http://localhost:8838/index-v2.html node tests/playwrightv2.leak.mjs
//       (MINUTES=10 by default; NO_GPU=1 for software GL)
import { chromium } from 'playwright';

const URL = process.env.URLV2 || 'http://localhost:8838/index-v2.html';
const MINUTES = +(process.env.MINUTES || 10);
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const GPU = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: [...GPU, '--enable-precise-memory-info'] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message + ' ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ')));
const cdp = await ctx.newCDPSession(page);
await page.goto(URL + '?nohint&gfx=medium', { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 30000 });

const snap = async (label) => {
   await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage');
   const s = await page.evaluate(() => {
      const R = window.__renderer3d, I = R.renderer.info, w = window.__world();
      return { t: w ? Math.round(w.time) : -1, phase: window.__phase(), geo: I.memory.geometries, tex: I.memory.textures, prog: I.programs ? I.programs.length : 0,
         dom: document.getElementsByTagName('*').length, heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
         scene: (() => { let n = 0; R.scene.traverse(() => n++); return n; })(),
         missiles: w ? w.missiles.length : 0, events: w && w.events ? w.events.length : 0, ships: w ? w.ships.length : 0, sites: w && w.sites ? w.sites.length : 0,
         shells: w && w.shells ? w.shells.length : 0, decoys: w && w.decoys ? w.decoys.length : 0, msgs: document.querySelectorAll('.msg').length };
   });
   console.log(`SNAP ${label.padEnd(16)} t=${String(s.t).padStart(4)} s  geo ${s.geo}  tex ${s.tex}  prog ${s.prog}  scene ${s.scene}  dom ${s.dom}  heap ${s.heapMB} MB  missiles ${s.missiles} events ${s.events} ships ${s.ships} sites ${s.sites} shells ${s.shells} decoys ${s.decoys} msgs ${s.msgs}  ${s.phase}`);
   return s;
};

// a battle that never ends by itself: nobody sinks, hostile batteries keep the salvos coming, the player answers
const busy = () => page.evaluate(async () => {
   const w = window.__world(), p = w.player, M = await import('./gamev2/missile.js'), St = await import('./gamev2/sites.js'), H = await import('./gamev2/helo.js');
   w.end = () => { };                 // (no objective or clock ends it either: the load below would win redsea in half a minute)
   const sites = [[10500, -5500], [9000, 7500]].map(([dx, dy]) => St.addSite(w, 'battery', 'enemy', { x: p.pos.x + dx, y: p.pos.y + dy }));
   let k = 0;
   window.__busy = setInterval(() => {
      if (window.__world() !== w || window.__phase() !== 'playing') return;
      for (const s of w.ships) if (s.alive) s.hp = s.maxHP;
      for (const s of sites) { s.hp = s.maxHP ?? s.maxHp ?? s.hp; s.alive = true; }
      const a = w.missiles.filter(m => m.kind !== 'sam').length;
      for (let i = a; i < 14; i++) {
         const site = sites[k++ % 2]; site.lastSsmFire = -99;
         if (site.mag) for (const q in site.mag) site.mag[q] = 99;
         M.launchSSM(w, site, { bearing: Math.atan2(p.pos.y - site.pos.y, p.pos.x - site.pos.x) + ((k % 5) - 2) * 0.02 });
      }
      if (k % 9 === 0) { M.deployDecoys(w, p); p.lastSsmFire = -99; for (const q in p.mag) p.mag[q] = Math.max(p.mag[q], 20); const t = w.ships.find(s => s.alive && s.side !== p.side); M.launchSSM(w, p, t ? { targetId: t.id } : { bearing: p.heading }); }
      if (k % 40 === 0 && !w.helos.length) { p.heloT = 0; H.launchHelo(w, p); }
   }, 500);
});
const start = async (o) => {
   await page.evaluate(o => window.__start(o), o);
   await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 30000 });
   await page.waitForTimeout(2500);
   await busy();
};

const menu0 = await snap('menu (fresh)');
await start({ mission: 'standard', ship: 'Burke', difficulty: 'normal' });
const S = [];
for (let m = 1; m <= MINUTES; m++) {
   await page.waitForFunction(t => { const w = window.__world(); return !w || window.__phase() !== 'playing' || w.time >= t; }, m * 60, { timeout: 120000 });
   S.push(await snap('battle 1, min ' + m));
}
await page.screenshot({ path: 'tests/shots/v2-leak-10min.png' });
// Baseline minute 4: a geometry counts from its first draw, and ships and island detail levels come into view
// during the first minutes (measured over 20 minutes: 54, 72, 79, 86 in minutes 1-4, then 86-88 to the end).
const a = S[Math.min(3, S.length - 1)], z = S[S.length - 1];
check(`battle ran ${MINUTES} minutes of game time and was still on`, z.phase === 'playing' && z.t >= MINUTES * 60 - 2, { t: z.t, phase: z.phase });
check('geometries do not climb (minute 4 -> end)', z.geo <= a.geo + 4, { from: a.geo, to: z.geo });
check('textures do not climb', z.tex <= a.tex + 1, { from: a.tex, to: z.tex });
check('shader programs do not climb', z.prog <= a.prog + 2, { from: a.prog, to: z.prog });
check('scene objects do not climb', z.scene <= a.scene + 12, { from: a.scene, to: z.scene });
check('DOM nodes do not climb', z.dom <= a.dom + 40, { from: a.dom, to: z.dom });
// heap: the second half of the game may not sit clearly above the first half
const half = Math.floor(S.length / 2), avg = l => l.reduce((x, s) => x + s.heapMB, 0) / l.length;
const h1 = avg(S.slice(1, Math.max(2, half))), h2 = avg(S.slice(half));
check('JS heap does not climb steadily (second half vs. first half, after a collection)', h2 <= h1 * 1.15 + 3, { firstHalfMB: +h1.toFixed(1), secondHalfMB: +h2.toFixed(1), series: S.map(s => s.heapMB) });
check('event list of the world stays bounded', z.events <= Math.max(400, a.events * 1.5), { from: a.events, to: z.events });

// back to the menu, second mission
const toMenu = async (label) => {
   await page.evaluate(() => { clearInterval(window.__busy); document.getElementById('btn-quit').click(); });
   await page.waitForFunction(() => window.__phase() === 'menu', null, { timeout: 10000 });
   await page.waitForTimeout(1500);
   return snap(label);
};
const menu1 = await toMenu('menu (after 1)');
// (the shared models and materials of the weapons stay loaded, and the HUD, built at the first start, stays in the
// document: both are there once, the later returns below show that they do not grow)
check('back in the menu: the battle scene is released', menu1.scene <= menu0.scene + 4 && menu1.geo <= menu0.geo + 16 && menu1.tex <= menu0.tex + 2 && menu1.heapMB <= z.heapMB * 0.6,
   { fresh: [menu0.geo, menu0.tex, menu0.scene, menu0.heapMB], now: [menu1.geo, menu1.tex, menu1.scene, menu1.heapMB], battleHeapMB: z.heapMB });
check('back in the menu: the document holds the menu and the HUD built once', menu1.dom <= z.dom + 10, { fresh: menu0.dom, battle: z.dom, now: menu1.dom });
await start({ mission: 'redsea', difficulty: 'normal' });
const T = [];
for (let m = 1; m <= 2; m++) {
   await page.waitForFunction(t => { const w = window.__world(); return !w || window.__phase() !== 'playing' || w.time >= t; }, m * 60, { timeout: 120000 });
   T.push(await snap('battle 2, min ' + m));
}
const y = T[T.length - 1];
check('second mission: still running, shader programs not piled up', y.phase === 'playing' && y.prog <= z.prog + 3, { first: z.prog, second: y.prog });
check('second mission: heap not above the first battle', y.heapMB <= Math.max(...S.map(s => s.heapMB)) * 1.15 + 3, { first: Math.max(...S.map(s => s.heapMB)), second: y.heapMB });
check('second mission: DOM not above the first battle (+60)', y.dom <= z.dom + 60, { first: z.dom, second: y.dom });
const menu2 = await toMenu('menu (after 2)');
// (another mission brings its own HUD plates and weapon models: bounded by the content, compared loosely here;
// the strict comparison is the same mission played again, below)
check('menu after the second mission: scene released again, heap as after the first', menu2.scene <= menu1.scene + 4 && menu2.tex <= menu1.tex + 1 && menu2.geo <= menu1.geo + 12 && menu2.heapMB <= menu1.heapMB * 1.15 + 3,
   { first: [menu1.geo, menu1.tex, menu1.dom, menu1.scene, menu1.heapMB], second: [menu2.geo, menu2.tex, menu2.dom, menu2.scene, menu2.heapMB] });

// the first mission once more: the same content, so the same numbers
await start({ mission: 'standard', ship: 'Burke', difficulty: 'normal' });
const U = [];
for (let m = 1; m <= 2; m++) {
   await page.waitForFunction(t => { const w = window.__world(); return !w || window.__phase() !== 'playing' || w.time >= t; }, m * 60, { timeout: 120000 });
   U.push(await snap('battle 3, min ' + m));
}
// (like with like: minute 2 against minute 2; missiles in flight and notices move the scene and the document a little)
// (geometries reach the GPU when a ship or an island first comes into view: minute 2 read 65 and 72 in two runs of the same build)
const x = U[U.length - 1], f = S[Math.min(1, S.length - 1)], dom1 = Math.max(...S.map(s => s.dom));
check('first mission again: running, no more in it than the first time', x.phase === 'playing' && x.geo <= f.geo + 10 && x.tex <= f.tex + 1 && x.prog <= z.prog + 2 && x.scene <= f.scene + 24 && x.dom <= dom1 + 10,
   { first: [f.geo, f.tex, z.prog, f.scene, dom1], again: [x.geo, x.tex, x.prog, x.scene, x.dom] });
check('first mission again: heap not above the first time', x.heapMB <= Math.max(...S.map(s => s.heapMB)) * 1.15 + 3, { first: Math.max(...S.map(s => s.heapMB)), again: x.heapMB });
const menu3 = await toMenu('menu (after 3)');
check('menu after three battles: nothing left over compared with the first return', menu3.geo <= Math.max(menu1.geo, menu2.geo) + 2 && menu3.tex <= menu1.tex + 1 && menu3.dom <= menu1.dom + 10 && menu3.scene <= menu1.scene + 4 && menu3.heapMB <= menu1.heapMB * 1.15 + 3,
   { first: [menu1.geo, menu1.tex, menu1.dom, menu1.scene, menu1.heapMB], third: [menu3.geo, menu3.tex, menu3.dom, menu3.scene, menu3.heapMB] });

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of errors.slice(0, 12)) console.log('  ERR ' + e);
process.exit(failed.length || errors.length ? 1 : 0);
