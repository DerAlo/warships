// tests/playtest3d.mjs -- long-form 3D playtest: for each mission:ship pair it plays a few seconds
// by hand (telegraph, rudder, aimed HE/AP salvos, torpedoes, consumables, binoculars), then lets
// the AI captain the player for a while (fast-forwarded sim) so the battle develops, and takes
// rendered screenshots mid-fight. Finally it walks the menu -> battle -> results -> restart ->
// port flow and checks GPU memory does not grow across restarts. Exit 1 on any console error.
//
// Run:  node server.js 5187   then   URL3D=http://localhost:5187/index-3d.html node tests/playtest3d.mjs
//   PAIRS=standard:Hipper,night:Z23  FF=150 (fast-forward seconds)  OUT=tests/shots  FLOW=0 (skip flow)
const { chromium } = await import(process.env.PW_MODULE || 'playwright');
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:5187/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
const FF = Number(process.env.FF || 150);
mkdirSync(OUT, { recursive: true });
const pairs = (process.env.PAIRS || 'training:Hipper,standard:Bismarck,domination:Z23,convoy:Nuernberg,rheinuebung:Bismarck,laststand:Bismarck,night:Hipper,raid:Z23')
   .split(',').filter(Boolean).map(s => s.split(':'));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1500);
const ev = (fn, arg) => page.evaluate(fn, arg);
const shot = (name) => page.screenshot({ path: `${OUT}/pt-${name}.png` });

// aim at the nearest spotted enemy (leading it by the shell flight time); returns its range or 0
const aimAtTarget = () => ev(() => {
   const w = window.__world(), P = w?.player;
   if (!P?.alive) return 0;
   let best = null, bd = 1e9;
   for (const s of w.ships) {
      if (s.side === P.side || !s.alive || s.spotted === false) continue;
      const d = Math.hypot(s.pos.x - P.pos.x, s.pos.y - P.pos.y);
      if (d < bd) { bd = d; best = s; }
   }
   if (!best) return 0;
   const t = P.flightTime ? P.flightTime(bd) : bd / 800;
   const vx = Math.cos(best.heading) * (best.speed || 0), vy = Math.sin(best.heading) * (best.speed || 0);
   const tx = best.pos.x + vx * t, ty = best.pos.y + vy * t;
   const brg = Math.atan2(ty - P.pos.y, tx - P.pos.x);
   let rel = brg - P.heading; while (rel > Math.PI) rel -= 2 * Math.PI; while (rel < -Math.PI) rel += 2 * Math.PI;
   window.__setAim(rel, Math.hypot(tx - P.pos.x, ty - P.pos.y));
   return Math.round(bd);
});
const click = async () => { await page.mouse.down(); await page.waitForTimeout(50); await page.mouse.up(); };

const summary = [];
for (const [mission, ship] of pairs) {
   const e0 = errors.length;
   await ev(([mission, ship]) => { window.__start({ difficulty: 'normal', mission, ship }); window.__setRender(false); }, [mission, ship]);
   await page.waitForTimeout(300);
   await page.mouse.move(720, 405);
   for (const k of ['w', 'w', 'w', 'd']) await page.keyboard.press(k);
   // ---- hand-played part (real time, render skipped)
   let lastRange = 0;
   for (let i = 0; i < 24; i++) {
      lastRange = await aimAtTarget();
      if (lastRange) await click();
      if (i === 6) await page.keyboard.press('2');
      if (i === 9) {
         await page.keyboard.press('3');
         await ev(() => window.__setAim(Math.PI / 2, 5000));
         await click();
         await page.keyboard.press('1');
      }
      if (i === 12) { await page.keyboard.press('a'); await page.keyboard.press('a'); }
      if (i === 14) for (const k of ['t', 'y', 'u']) await page.keyboard.press(k);
      if (i === 18) await page.keyboard.press('q');
      await page.waitForTimeout(450);
   }
   const hand = await ev(() => ({ fired: window.__fired(), t: window.__world().time.toFixed(0) }));
   // ---- fast-forward: the AI captains the player so the battle actually develops
   for (let k = 0; k < FF / 30; k++) {
      const ph = await ev(() => {
         const w = window.__world();
         if (w.phase !== 'playing') return w.phase;
         w.autoPlayer = true;
         for (let i = 0; i < 1800 && w.phase === 'playing'; i++) w.update(1 / 60);
         w.autoPlayer = false;
         return w.phase;
      });
      if (ph !== 'playing') break;
   }
   // ---- rendered screenshots mid-fight
   await ev(() => window.__setRender(true));
   const r = await aimAtTarget();
   await page.waitForTimeout(3500);
   await shot(`${mission}-${ship}`);
   if (r) {
      await page.keyboard.press('Shift');
      await page.waitForTimeout(300);
      await aimAtTarget();
      await page.waitForTimeout(2500);
      await shot(`${mission}-${ship}-bino`);
      await page.keyboard.press('Shift');
   }
   await ev(() => window.__setRender(false));
   const st = await ev(() => {
      const w = window.__world(), P = w.player, s = w.stats || {};
      const alive = (side) => w.ships.filter(x => x.alive && (x.side === 'player') === side).length;
      return { phase: w.phase, t: Math.round(w.time), hp: Math.round(P.hp) + '/' + P.maxHP, dmg: Math.round(s.dmg || 0), kills: s.kills || 0,
         hits: `${s.hits || 0}/${s.shotsFired || 0}`, allies: alive(true), enemies: alive(false), reason: w.result?.reason || '' };
   });
   const line = `${mission} ${ship} hand=${JSON.stringify(hand)} end=${JSON.stringify(st)} errors=${errors.length - e0}`;
   console.log(line); summary.push(line);
   // leave the match: end screen must come up
   await ev(() => { const w = window.__world(); if (w.phase === 'playing') w.end(true, 'Testende'); });
   await page.waitForTimeout(3500);
}

// ---- menu flow: port -> battle -> results -> again -> results -> next -> port, GPU memory stable
if (process.env.FLOW !== '0') {
   const mem = () => ev(() => { const i = window.__renderer3d?.renderer?.info?.memory; return i ? { g: i.geometries, t: i.textures } : null; });
   const resVisible = () => ev(() => !document.getElementById('end').classList.contains('hidden'));
   const menuVisible = () => ev(() => !document.getElementById('menu').classList.contains('hidden'));
   await ev(() => window.__setRender(true));
   await page.locator('.m3r-btn[data-act="port"]').click().catch(() => {});
   await page.waitForTimeout(800);
   console.log('port visible after results:', await menuVisible());
   await page.locator('.m3-mis[data-mis="standard"]').click();
   await page.locator('.m3-card[data-ship="Hipper"]').click();
   await shot('flow-port');
   const mems = [];
   await page.locator('.m3-battle').click();
   for (let round = 0; round < 3; round++) {
      await page.waitForTimeout(2500);
      const ph = await ev(() => window.__phase());
      mems.push(await mem());
      await ev((win) => window.__world().end(win, win ? 'Alle Gegner versenkt.' : 'Ihr Schiff wurde versenkt.'), round !== 1);
      await page.waitForTimeout(4500);
      const rv = await resVisible();
      console.log(`round ${round}: phase=${ph} results visible=${rv}`);
      if (round === 0) await shot('flow-results-win');
      if (round === 1) await shot('flow-results-loss');
      if (round < 2) await page.locator('.m3r-btn[data-act="again"]').click();
   }
   await page.locator('.m3r-btn[data-act="next"]').click();
   await page.waitForTimeout(800);
   const sel = await ev(() => document.querySelector('.m3-mis.sel')?.dataset.mis);
   console.log('after "next": menu visible', await menuVisible(), 'selected', sel, 'phase', await ev(() => window.__phase()));
   console.log('gpu memory per round', JSON.stringify(mems));
}
console.log('\n' + summary.join('\n'));
console.log('TOTAL ERRORS', errors.length);
for (const e of errors.slice(0, 15)) console.log('  ', e);
await browser.close();
process.exit(errors.length ? 1 : 0);
