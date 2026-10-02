// tests/playwright3d.subs.mjs -- browser smoke test of the submarine class: port card, surfaced,
// periscope depth + periscope view, torpedo salvo, deep (hydrophone view), surfacing, a depth-charge
// attack on the player's boat and the start of the mission "Geleitzugschlacht".
// Screenshots go to tests/shots/. Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8782   then   URL3D=http://localhost:8782/index-3d.html node tests/playwright3d.subs.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:8782/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};

const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
async function waitFor(fn, timeout = 8000, step = 50) {
   const t0 = Date.now();
   while (Date.now() - t0 < timeout) { if (await ev(fn)) return true; await wait(step); }
   return false;
}
const sub = () => ev(() => { const p = window.__world().player; return { depth: p.depth, depthF: p.depthF, depthM: p.depthM, battery: p.battery, hp: p.hp, alive: p.alive }; });
const shot = (name) => page.screenshot({ path: `${OUT}/3d-sub-${name}.png` });

await page.goto(URL, { waitUntil: 'load' });
await wait(1200);
await shot('menu');

// ---- 1. battle in U 96
await ev(() => window.__start({ difficulty: 'normal', mission: 'standard', ship: 'U96' }));
await waitFor(() => window.__phase() === 'playing', 5000);
await page.mouse.move(720, 405);
check('battle started in a submarine', await ev(() => window.__phase() === 'playing' && !!window.__world().player.sub));
check('depth panel shown', await ev(() => !document.getElementById('sub-panel').classList.contains('hidden')));
await page.keyboard.press('w'); await page.keyboard.press('w');
await wait(2500);
await shot('surfaced');
// close-up from the beam
await ev(() => window.__setAim(Math.PI / 2, 2000));
let notches = 0;
while (notches < 12 && !(await ev(() => window.__zoom3d().bino))) { await page.mouse.wheel(0, -120); await wait(150); notches++; }
await page.mouse.wheel(0, 120); notches--;      // closest third-person rung
await wait(1500);
await shot('model-beam');
await ev(() => window.__setAim(2.4, 2000));
await wait(900);
await shot('model-quarter');
for (let i = 0; i < notches; i++) { await page.mouse.wheel(0, 120); await wait(150); }
await ev(() => window.__setAim(0, 3000));
await wait(600);

// ---- 2. periscope depth
await page.keyboard.press('f');
check('F -> periscope depth', await waitFor(() => window.__world().player.depth === 1 && Math.abs(window.__world().player.depthF - 1) < 0.02, 15000), await sub());
await wait(600);
await shot('periscope-depth');
await page.keyboard.press('Shift');
await wait(900);
check('periscope view (scope + peri rig)', await ev(() => window.__scopeT() > 0.9 && !!window.__cam3.peri), await ev(() => ({ scope: window.__scopeT(), peri: window.__cam3.peri, camY: window.__camY() })));
await shot('periscope-view');

// ---- 3. torpedoes from periscope depth (bow tubes: aim dead ahead)
await ev(() => window.__setAim(0, 3000));
await page.keyboard.press('3');
await wait(300);
const t0 = await ev(() => window.__world().torpedoes.length);
for (let i = 0; i < 3 && (await ev(() => window.__world().torpedoes.length)) === t0; i++) { await page.mouse.down(); await wait(120); await page.mouse.up(); await wait(250); }
await wait(500);
const t1 = await ev(() => window.__world().torpedoes.length);
check('torpedo salvo from periscope depth', t1 > t0, await ev(() => { const p = window.__world().player; return { rel: window.__aim().yaw - p.heading, sel: window.__weaponSel(), depth: p.depth, depthF: p.depthF, ctl: window.__ctl(), L: p.torpLaunchers?.map(l => [l.reload, l.side || l.arc || '']), pick: !!p.torpLauncherFor(window.__aim().yaw) }; }));
await shot('periscope-torps');
await page.keyboard.press('Shift');
await wait(500);

// ---- 4. deep
await page.keyboard.press('f');
check('F -> deep', await waitFor(() => window.__world().player.depth === 2 && window.__world().player.depthF > 1.98, 15000), await sub());
await wait(800);
const b0 = (await sub()).battery;
await wait(1500);
check('battery drains while deep', (await sub()).battery < b0, { b0, b1: (await sub()).battery });
check('no torpedo launcher while deep', await ev(() => window.__world().player.torpLauncherFor(window.__world().player.heading) == null));
await shot('deep');
await page.keyboard.press('m'); await wait(500); await shot('deep-map'); await page.keyboard.press('m');

// ---- 5. depth-charge attack on the player's boat (enemy destroyer placed right above)
const dc = await ev(async () => {
   const w = window.__world(), p = w.player;
   const dd = w.ships.find(s => s.side !== p.side && s.alive && s.asw);
   if (!dd) return { none: true };
   dd.pos.x = p.pos.x - Math.cos(p.heading) * 60; dd.pos.y = p.pos.y - Math.sin(p.heading) * 60; dd.heading = p.heading;
   return { dd: dd.cfg.name, hp: p.hp };
});
check('enemy ASW ship available', !dc.none, dc);
if (!dc.none) {
   const hurt = await waitFor(() => { const w = window.__world(); return w.depthCharges.length > 0 || w.player.hp < w.player.maxHP; }, 30000, 100);
   check('bot drops depth charges on the detected boat', hurt, await sub());
   await waitFor(() => window.__world().effects?.some?.(e => e.kind === 'depthCharge'), 8000, 30);
   await wait(250);
   await shot('depth-charge-deep');
}

// ---- 6. surface
await page.keyboard.press('g'); await wait(200); await page.keyboard.press('g');
check('G G -> surfaced', await waitFor(() => { const p = window.__world().player; return !p.alive || (p.depth === 0 && p.depthF < 0.02); }, 20000), await sub());
await wait(1500);
await shot('resurfaced');

// ---- 7. depth-charge attack seen from the surface: the player in a destroyer drops with G
await ev(() => window.__start({ difficulty: 'normal', mission: 'standard', ship: 'Z23' }));
await waitFor(() => window.__phase() === 'playing', 5000);
const hasAsw = await ev(() => !!window.__world().player.asw);
check('destroyer carries depth charges', hasAsw, await ev(() => window.__world().player.cfg.name));
await page.keyboard.press('w'); await page.keyboard.press('w');
await wait(2500);
await ev(() => window.__setAim(Math.PI, 1500));   // look astern at the pattern
await wait(600);
await page.keyboard.press('g');
check('G drops a pattern', await waitFor(() => window.__world().depthCharges.length > 0, 3000, 30));
await ev(() => { window.__dcMax = 0; });
await waitFor(() => { const n = window.__world().depthCharges.filter(c => c.alive).length; window.__dcMax = Math.max(window.__dcMax, n); return n < window.__dcMax; }, 15000, 16);
await wait(350);
await shot('depth-charge-attack');

// ---- 8. mission Geleitzugschlacht
await ev(() => window.__start({ difficulty: 'normal', mission: 'wolfpack' }));
await waitFor(() => window.__phase() === 'playing', 5000);
check('mission "Geleitzugschlacht" starts in a boat', await ev(() => !!window.__world().player.sub), await ev(() => window.__world().player.cfg.name));
await wait(4000);
await shot('mission-wolfpack');
check('mission still running after 4 s', await ev(() => window.__phase() === 'playing'));

// ---- 9. port card
await page.keyboard.press('Escape');
await wait(300);
await page.goto(URL + '?', { waitUntil: 'load' });
await wait(1200);
const card = await ev(() => {
   const els = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && /U 96|U-Boot/.test(e.textContent));
   return els.length;
});
console.log('INFO menu elements mentioning U-Boot/U 96:', card);
try {
   await page.locator('[data-ship="U96"]').first().click({ timeout: 3000 });
   await wait(700);
   await shot('port-card');
   check('port card names the class', await ev(() => /U-Boot/.test(document.body.innerText)));
} catch (e) { check('port card clickable', false, String(e.message).slice(0, 120)); }

if (errors.length) { console.log('CONSOLE ERRORS:'); for (const e of errors.slice(0, 20)) console.log('  ' + e); }
check('zero console errors', errors.length === 0, errors.length);
await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
