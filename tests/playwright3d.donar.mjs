// tests/playwright3d.donar.mjs -- the cheat-only railgun ship Donar in V1 (index-3d.html): hidden without the
// cheat, selectable after ten clicks on the logo (standard battle and a fixed-ship operation, not in a
// submarine operation), a battle starts with it, the modern model renders, it fires, no console errors.
// Exit code 1 on a failed check or console error. Screenshots: tests/shots/donar3d-*.png
//
// Run:  node server.js 8773   then   BASE=http://localhost:8773 node tests/playwright3d.donar.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8773';
const OUT = process.env.OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 } });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(`${BASE}/index-3d.html`);
await page.waitForSelector('.m3-card');
const card = (k) => page.evaluate((k) => { const e = document.querySelector(`.m3-card[data-ship="${k}"]`); return e ? (e.classList.contains('off') ? 'off' : e.classList.contains('lock') ? 'lock' : 'ok') : 'none'; }, k);

await page.click('[data-mis="standard"]');
await page.click('.m3-tabs [data-nat="all"]');
check('without the cheat: no Donar card', await card('Donar') === 'none');
for (let i = 0; i < 10; i++) await page.click('.m3-logo');
await page.waitForSelector('.m3-toast');
check('cheat toast names the Donar', /Donar/.test(await page.textContent('.m3-toast')));
await page.click('.m3-tabs [data-nat="all"]');
check('standard battle: Donar card selectable', await card('Donar') === 'ok');
// a fixed-ship operation offers it too, a submarine operation does not
await page.click('[data-mis="rheinuebung"]');
await page.click('.m3-tabs [data-nat="all"]');
check('operation Rheinübung: Donar selectable', await card('Donar') === 'ok');
await page.click('[data-mis="wahoo"]');
await page.click('.m3-tabs [data-nat="all"]');
check('submarine operation: no Donar', await card('Donar') !== 'ok');
await page.click('[data-mis="training"]');
await page.click('.m3-tabs [data-nat="all"]');
await page.click('.m3-card[data-ship="Donar"]');
check('training: no PROBEFAHRT tag on the Donar', !(await page.$('.m3-card[data-ship="Donar"] .tri')));

await page.click('[data-mis="standard"]');
await page.click('.m3-tabs [data-nat="all"]');
await page.click('.m3-card[data-ship="Donar"]');
const sel = await page.evaluate(() => ({ sel: document.querySelector('.m3-card.sel')?.dataset.ship, name: document.querySelector('.m3-ship .nm')?.textContent, dis: document.querySelector('.m3-battle').disabled }));
check('Donar selected, battle button enabled', sel.sel === 'Donar' && !sel.dis, sel);
await page.screenshot({ path: `${OUT}/donar3d-port.png` });
await page.click('.m3-battle');
let ok = false;
for (let i = 0; i < 100 && !ok; i++) { ok = await page.evaluate(() => window.__phase() === 'playing' && !!window.__world()?.player); if (!ok) await page.waitForTimeout(200); }
const st = ok ? await page.evaluate(() => { const w = window.__world(), p = w.player; return { key: p.cfg.key, turrets: p.turrets.length, ships: w.ships.length, hp: p.hp }; }) : null;
check('battle starts with the Donar', ok && st.key === 'Donar' && st.turrets === 2 && st.ships >= 6, st);
if (ok) {
   await page.waitForTimeout(2500);
   await page.screenshot({ path: `${OUT}/donar3d-battle.png` });
   // a close look at the model (the HUD hidden), then let the autopilot fight for a while
   await page.addStyleTag({ content: '#hud, .hud, #hud3d, .overlay { visibility:hidden !important; }' });
   const L = 192;
   for (const [view, ang, dist, hgt] of [['side', Math.PI / 2, 1.9, 0.09], ['quarter', 0.62, 1.25, 0.42]]) {
      const pose = { ang, d: L * dist, h: Math.max(14, L * dist * hgt), L };
      await page.evaluate(({ ang, d, h, L }) => {
         const p = window.__world().player, a = p.heading + ang;
         window.__cam3.override = { px: p.pos.x + Math.cos(a) * d, py: h, pz: p.pos.y + Math.sin(a) * d, tx: p.pos.x, ty: L * 0.035, tz: p.pos.y, fov: 30 };
      }, pose);
      await page.waitForTimeout(350);
      await page.evaluate(({ ang, d, h }) => {
         const p = window.__world().player, a = p.heading + ang, o = window.__cam3.override;
         Object.assign(o, { px: p.pos.x + Math.cos(a) * d, py: h, pz: p.pos.y + Math.sin(a) * d, tx: p.pos.x, tz: p.pos.y });
      }, pose);
      await page.waitForTimeout(120);
      await page.screenshot({ path: `${OUT}/donar3d-${view}.png` });
   }
   await page.evaluate(() => { window.__cam3.override = null; window.__world().autoPlayer = true; });
   await page.waitForTimeout(20000);
   const after = await page.evaluate(() => { const w = window.__world(); return { phase: window.__phase(), shots: w.stats.shotsFired, finite: w.ships.every(s => Number.isFinite(s.pos.x) && Number.isFinite(s.hp)) }; });
   check('autopilot fights 20 s: fires, state finite', after.finite && after.shots > 0, after);
}
check('no console errors', errors.length === 0, errors.slice(0, 5));
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
