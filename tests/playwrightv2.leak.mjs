// tests/playwrightv2.leak.mjs -- a long game of V2 on a phone tier: nothing may climb steadily.
// One fleet fight (mission "standard", tier medium, 844x390 touch) runs for 10 minutes of game time with missile
// salvos, air defence, decoys and a helicopter kept going the whole time. Once a minute, after a forced garbage
// collection: geometries / textures / shader programs (renderer.info), DOM nodes, JS heap, live particles.
// Then back to the menu, a second mission (redsea), and the same numbers again.
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
const a = S[Math.min(1, S.length - 1)], z = S[S.length - 1];
check(`battle ran ${MINUTES} minutes of game time and was still on`, z.phase === 'playing' && z.t >= MINUTES * 60 - 2, { t: z.t, phase: z.phase });
check('geometries do not climb (minute 2 -> end)', z.geo <= a.geo + 4, { from: a.geo, to: z.geo });
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
await page.evaluate(() => { clearInterval(window.__busy); document.getElementById('btn-quit').click(); });
await page.waitForFunction(() => window.__phase() === 'menu', null, { timeout: 10000 });
await page.waitForTimeout(1500);
const menu1 = await snap('menu (after 1)');
check('back in the menu: geometries and textures of the battle are released', menu1.geo <= menu0.geo + 6 && menu1.tex <= menu0.tex + 2, { fresh: [menu0.geo, menu0.tex, menu0.scene], now: [menu1.geo, menu1.tex, menu1.scene] });
check('back in the menu: DOM back to the menu size', menu1.dom <= menu0.dom + 60, { fresh: menu0.dom, now: menu1.dom });
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
await page.evaluate(() => { clearInterval(window.__busy); document.getElementById('btn-quit').click(); });
await page.waitForTimeout(1500);
const menu2 = await snap('menu (after 2)');
check('menu after the second mission: nothing left over compared with the first return', menu2.geo <= menu1.geo + 2 && menu2.tex <= menu1.tex + 1 && menu2.dom <= menu1.dom + 10 && menu2.scene <= menu1.scene + 4,
   { first: [menu1.geo, menu1.tex, menu1.dom, menu1.scene], second: [menu2.geo, menu2.tex, menu2.dom, menu2.scene] });

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of errors.slice(0, 12)) console.log('  ERR ' + e);
process.exit(failed.length || errors.length ? 1 : 0);
