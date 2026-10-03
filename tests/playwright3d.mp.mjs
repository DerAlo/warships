// tests/playwright3d.mp.mjs -- end to end: lobby -> co-op match -> results -> back to the room ->
// second match, with two pages of one browser context over BroadcastChannel (?net=local).
//
// Run:  node server.js 5173   then   URL3D=http://localhost:5173/index-3d.html node tests/playwright3d.mp.mjs
import { chromium } from 'playwright';
const BASE = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const URL = BASE + (BASE.includes('?') ? '&' : '?') + 'net=local';
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   if (!ok || process.env.VERBOSE) console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 } });
const mkPage = async (tag, name) => {
   const page = await ctx.newPage();
   page.on('console', m => { if (m.type() === 'error') errors.push(`[${tag}] ${m.text()}`); });
   page.on('pageerror', e => errors.push(`[${tag}] PAGEERROR: ${e.message}`));
   await page.goto(URL);
   await page.waitForSelector('.m3-card');
   await page.click('[data-act="mp"]');
   await page.waitForSelector('.mp:not(.hidden)');
   // the name prompt opens by itself only while no name is stored (the pages share localStorage)
   if (!await page.locator('[data-f="pname"]').count()) await page.click('[data-act="name"]');
   await page.fill('[data-f="pname"]', name);
   await page.click('.mp-modal [data-ok]');
   return page;
};
const wait = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const state = (page) => page.evaluate(() => {
   const w = window.__world(), p = w?.player;
   return { phase: window.__phase(), mission: w?.mission?.id, me: p?.id, cls: p?.cls, x: p?.pos.x, y: p?.pos.y, speed: p?.speed, n: w?.ships.length, t: w?.time, wphase: w?.phase,
      mpHidden: document.querySelector('.mp')?.classList.contains('hidden') ?? true };
});

const A = await mkPage('A', 'Anna');
await A.click('[data-act="main"]');
await A.fill('[data-f="name"]', 'Koop Ende zu Ende');
await A.selectOption('[data-f="mission"]', 'standard');
await A.click('.mp-modal [data-ok]');
const B = await mkPage('B', 'Bert');
check('B sees the game', await wait(B, () => document.querySelectorAll('.mp-game').length === 1));
await B.click('.mp-game [data-join]');
check('B is in the room', await wait(B, () => document.querySelectorAll('.mp-player').length === 2));

for (let round = 1; round <= 2; round++) {
   const tag = `match ${round}:`;
   await B.click('[data-act="main"]');                       // ready
   check(`${tag} host may start`, await wait(A, () => !document.querySelector('[data-act="main"]').disabled));
   await A.click('[data-act="main"]');                       // start
   const okA = await wait(A, () => window.__phase() === 'playing' && !!window.__world()?.player);
   const okB = await wait(B, () => window.__phase() === 'playing' && !!window.__world()?.player);
   check(`${tag} both pages are in the battle`, okA && okB);
   await wait(B, () => window.__world().time > 1.5);
   const a = await state(A), b = await state(B);
   check(`${tag} lobby hidden during the battle`, a.mpHidden && b.mpHidden, { a: a.mpHidden, b: b.mpHidden });
   check(`${tag} same mission and roster`, a.mission === 'standard' && b.mission === 'standard' && a.n === b.n && a.n > 2, { a: a.n, b: b.n });
   check(`${tag} two different own ships`, a.me != null && b.me != null && a.me !== b.me, { a: a.me, b: b.me });

   // the client orders full ahead; the host's simulation must move that ship
   const before = await A.evaluate((id) => { const s = window.__world().ships.find(s => s.id === id); return { x: s.pos.x, y: s.pos.y, human: !!s.human || !window.__world().bots.includes(s) }; }, b.me);
   check(`${tag} host does not run the AI on the client's ship`, before.human, before);
   await B.bringToFront();
   await B.keyboard.down('KeyW'); await B.waitForTimeout(1200); await B.keyboard.up('KeyW');
   const moved = await wait(A, ([id, x, y]) => { const s = window.__world().ships.find(s => s.id === id); return Math.hypot(s.pos.x - x, s.pos.y - y) > 15 && s.telegraph > 0; }, [b.me, before.x, before.y], 20000);
   check(`${tag} client's telegraph order moves its ship on the host`, moved, await A.evaluate((id) => { const s = window.__world().ships.find(s => s.id === id); return { tel: s.telegraph, sp: s.speed }; }, b.me));
   const conv = await (async () => {
      const ha = await A.evaluate((id) => { const s = window.__world().ships.find(s => s.id === id); return { x: s.pos.x, y: s.pos.y }; }, b.me);
      const cb = await state(B);
      return { d: Math.hypot(ha.x - cb.x, ha.y - cb.y), sp: cb.speed };
   })();
   check(`${tag} client's own ship follows the host state`, conv.d < 60 && conv.sp > 0.5, conv);
   const net = await B.evaluate(() => window.__net());
   check(`${tag} client receives snapshots`, net && net.snapHz > 10, { snapHz: net?.snapHz, delay: net?.delay });

   // the host's world ends: both must reach the results screen and return to the room
   await A.evaluate(() => window.__world().end(true, 'Test'));
   const endA = await wait(A, () => !!document.querySelector('.m3r-btn[data-act="port"]') && document.querySelector('.m3r-btn[data-act="port"]').offsetParent !== null);
   const endB = await wait(B, () => !!document.querySelector('.m3r-btn[data-act="port"]') && document.querySelector('.m3r-btn[data-act="port"]').offsetParent !== null);
   check(`${tag} both pages show the results`, endA && endB);
   const label = await B.evaluate(() => document.querySelector('.m3r-btn[data-act="port"]')?.textContent);
   check(`${tag} results offer "ZUR LOBBY"`, /LOBBY/.test(label || ''), label);
   const won = await B.evaluate(() => window.__world()?.result?.victory);
   check(`${tag} client got the host's result`, won === true, won);
   await A.click('.m3r-btn[data-act="port"]'); await B.click('.m3r-btn[data-act="port"]');
   const backA = await wait(A, () => !document.querySelector('.mp').classList.contains('hidden') && document.querySelectorAll('.mp-player').length === 2);
   const backB = await wait(B, () => !document.querySelector('.mp').classList.contains('hidden') && document.querySelectorAll('.mp-player').length === 2);
   check(`${tag} both are back in the room with both players`, backA && backB);
}

// ---- the host leaves in the middle of a battle
await B.click('[data-act="main"]');
await wait(A, () => !document.querySelector('[data-act="main"]').disabled);
await A.click('[data-act="main"]');
await wait(B, () => window.__phase() === 'playing' && window.__world()?.time > 1);
await A.close();
// host migration (CONTRACT.md): the only client is the successor and carries on alone
const t0 = await B.evaluate(() => window.__world().time);
const took = await wait(B, () => /Gastgeber gewechselt/.test(document.body.innerText) && window.__net()?.isHost && window.__phase() === 'playing', null, 20000);
check('host gone: the client is told and takes the battle over', took && await wait(B, (t) => window.__world().time > t + 2, t0, 10000), await B.evaluate(() => [window.__phase(), window.__net()?.isHost]));

await browser.close();
const bad = results.filter(r => !r.ok).length;
if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.slice(0, 12).join('\n'));
console.log(`mp: ${results.length - bad}/${results.length} checks passed, ${errors.length} console errors`);
process.exit(bad || errors.length ? 1 : 0);
