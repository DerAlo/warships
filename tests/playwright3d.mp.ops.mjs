// tests/playwright3d.mp.ops.mjs -- co-op in a historical operation (prescribed ships), three pages
// of one browser context over BroadcastChannel (?net=local): the mission picker offers the
// operations with their player limit, the room shows who commands which ship, the match gives
// the host the flagship (Scharnhorst) and the others the mission's own escorts (Gneisenau, Prinz
// Eugen), and losing the flagship ends the operation for everybody.
//
// Run:  node server.js 5173   then   URL3D=http://localhost:5173/index-3d.html node tests/playwright3d.mp.ops.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const URL = BASE + (BASE.includes('?') ? '&' : '?') + 'net=local';
const OUT = process.env.OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
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
   if (!await page.locator('[data-f="pname"]').count()) await page.click('[data-act="name"]');
   await page.fill('[data-f="pname"]', name);
   await page.click('.mp-modal [data-ok]');
   return page;
};
const wait = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const fits = (page) => page.evaluate(() => {
   const de = document.documentElement, bad = [];
   for (const el of document.querySelectorAll('.mp-top, .mp-body > *')) { const r = el.getBoundingClientRect(); if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1) bad.push(el.className); }
   return { scroll: de.scrollHeight > innerHeight + 1 || de.scrollWidth > innerWidth + 1, bad };
});
const players = (page) => page.evaluate(() => [...document.querySelectorAll('.mp-player')].map(e => ({ n: e.querySelector('.n').textContent, s: e.querySelector('.s').textContent, role: e.querySelector('.s').dataset.role || '' })));
const me = (page) => page.evaluate(() => { const w = window.__world(), p = w?.player; return { id: p?.id, cls: p?.cls, name: p?.name, mission: w?.mission?.id, phase: w?.phase, reason: w?.result?.reason || '' }; });

// ---- the mission picker
const A = await mkPage('A', 'Anna');
await A.click('[data-act="main"]');
await A.waitForSelector('[data-f="mission"]');
const pick = await A.evaluate(() => ({
   groups: [...document.querySelectorAll('[data-f="mission"] optgroup')].map(g => g.label),
   ops: [...document.querySelectorAll('[data-f="mission"] optgroup:nth-of-type(2) option')].map(o => o.value),
   all: [...document.querySelectorAll('[data-f="mission"] option')].map(o => o.value),
}));
check('picker: battles and historical operations in two groups', pick.groups.length === 2 && /Historische Operationen/.test(pick.groups[1]), pick.groups);
check('picker: the operations are offered', ['rheinuebung', 'cerberus', 'nordkap', 'vian'].every(id => pick.ops.includes(id)), pick.ops);
check('picker: Letztes Gefecht and the exercise stay out', !pick.all.includes('laststand') && !pick.all.includes('training'), pick.all);
await A.selectOption('[data-f="mission"]', 'rheinuebung');
const maxR = await A.evaluate(() => [...document.querySelectorAll('[data-f="max"] option')].map(o => o.textContent).join());
check('picker: Rheinübung takes 2 captains', maxR === '1,2', maxR);
await A.selectOption('[data-f="mission"]', 'cerberus');
const maxC = await A.evaluate(() => [...document.querySelectorAll('[data-f="max"] option')].map(o => o.textContent).join());
check('picker: Cerberus takes 4 captains', maxC === '1,2,3,4', maxC);
await A.selectOption('[data-f="max"]', '3');
await A.fill('[data-f="name"]', 'Kanaldurchbruch');
await A.click('.mp-modal [data-ok]');
check('A is in the room', await wait(A, () => !!document.querySelector('.mp-body.room')));

// ---- two more captains join: each gets the next escort
const B = await mkPage('B', 'Bert');
check('B sees the game', await wait(B, () => document.querySelectorAll('.mp-game').length === 1));
await B.click('.mp-game [data-join]');
check('B is in the room', await wait(B, () => document.querySelectorAll('.mp-player').length === 2));
const C = await mkPage('C', 'Carl');
check('C sees the game', await wait(C, () => document.querySelectorAll('.mp-game').length === 1));
await C.click('.mp-game [data-join]');
check('C is in the room', await wait(C, () => document.querySelectorAll('.mp-player').length === 3));
const roleOk = (p) => p.length === 3 && /Scharnhorst/.test(p[0].s) && p[1].role === 'Gneisenau' && /Gneisenau/.test(p[1].s) && p[2].role === 'Prinz Eugen' && /Prinz Eugen/.test(p[2].s);
check('room: everybody sees who commands which ship', await wait(B, () => document.querySelectorAll('.mp-player .s[data-role]').length === 3) && roleOk(await players(A)) && roleOk(await players(B)) && roleOk(await players(C)), await players(C));
const col = await C.evaluate(() => ({ head: document.querySelector('[data-scount]').textContent, n: document.querySelectorAll('[data-role-slot]').length, sel: document.querySelector('[data-role-slot].sel')?.textContent || '', picker: document.querySelectorAll('[data-ships] [data-ship]').length }));
check('room: ship column shows the prescribed ships, own one marked, no picker', col.head === 'vorgegeben' && col.n === 3 && /Prinz Eugen/.test(col.sel) && /Carl/.test(col.sel) && col.picker === 0, col);
check('room fits 1440x810', await fits(C).then(f => !f.scroll && !f.bad.length), await fits(C));
await C.screenshot({ path: `${OUT}/mp_ops_room.png` });

// ---- the match
await B.click('[data-act="main"]'); await C.click('[data-act="main"]');           // ready
check('host may start', await wait(A, () => !document.querySelector('[data-act="main"]').disabled));
await A.click('[data-act="main"]');
const inA = await wait(A, () => window.__phase() === 'playing' && !!window.__world()?.player);
const inB = await wait(B, () => window.__phase() === 'playing' && !!window.__world()?.player);
const inC = await wait(C, () => window.__phase() === 'playing' && !!window.__world()?.player);
check('all three pages are in the battle', inA && inB && inC);
await wait(C, () => window.__world().time > 1.5);
const [a, b, c] = [await me(A), await me(B), await me(C)];
check('host commands the flagship', a.mission === 'cerberus' && a.cls === 'Scharnhorst' && /^Scharnhorst/.test(a.name), a);
check('B commands Gneisenau, C Prinz Eugen', b.cls === 'Scharnhorst' && /^Gneisenau \(Bert\)/.test(b.name) && c.cls === 'Hipper' && /^Prinz Eugen \(Carl\)/.test(c.name), { b, c });
const hostView = await A.evaluate(([ib, ic]) => {
   const w = window.__world(), S = w._script, sb = w.ships.find(s => s.id === ib), sc = w.ships.find(s => s.id === ic);
   return { gn: S?.gn === sb, eugen: S?.eugen === sc, human: !!(sb?.human && sc?.human), dmg: [sb?.dmgMult, sc?.dmgMult] };
}, [b.id, c.id]);
check('host: they are the ships the mission script watches, steered by humans at full strength', hostView.gn && hostView.eugen && hostView.human && hostView.dmg.join() === '1,1', hostView);
await B.bringToFront();
const before = await A.evaluate((id) => { const s = window.__world().ships.find(s => s.id === id); return { x: s.pos.x, y: s.pos.y, tel: s.telegraph }; }, b.id);
await B.keyboard.down('KeyS'); await B.waitForTimeout(1500); await B.keyboard.up('KeyS');
const slowed = await wait(A, ([id, tel]) => window.__world().ships.find(s => s.id === id).telegraph < tel, [b.id, before.tel], 10000);
check('B\'s telegraph order reaches Gneisenau on the host', slowed, await A.evaluate((id) => window.__world().ships.find(s => s.id === id).telegraph, b.id));
const objC = await C.evaluate(() => window.__world().mission.objectives.map(o => o.id).join());
check('objectives reach the clients', /ships/.test(objC), objC);

// ---- the flagship sinks: the operation has failed for everybody
await A.evaluate(() => window.__world().player.takeDamage(1e9, null, 'pen'));
const ended = await Promise.all([A, B, C].map(p => wait(p, () => window.__world()?.phase === 'lost', null, 20000)));
check('flagship lost: every page lost the operation', ended.every(Boolean), ended);
const reasons = await Promise.all([A, B, C].map(p => me(p).then(x => x.reason)));
check('the reason names the flagship', reasons.every(r => /Flaggschiff/.test(r)), reasons);

await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`mp.ops: ${results.length - failed}/${results.length} checks passed, ${errors.length} console errors`);
for (const e of errors.slice(0, 10)) console.log('  ' + e);
process.exit(failed || errors.length ? 1 : 0);
