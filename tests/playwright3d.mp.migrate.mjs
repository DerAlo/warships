// tests/playwright3d.mp.migrate.mjs -- host migration: the host's page is closed mid-battle and
// the match goes on under the successor (CONTRACT.md "Host migration").
//
//   MODE=local (default: three pages of one browser context over BroadcastChannel, ?net=local)
//      | relayonly (one Chromium per player over the public MQTT brokers, ?net=relay)
//      | hybrid    (the same, WebRTC tried beside the brokers)
//   SILENT=1   the host's page says no goodbye (as after a crash): the others notice the silence
//
// Flow: host A + clients B and C start a co-op battle -> A names B its successor and sends it the
// full state -> A's page is closed -> B takes over (its World becomes the real one, the bots keep
// their AI, an enemy keeps the damage A had dealt), C follows B, both show the notice, the lobby
// moves the room and the listing to B -> C steers its ship on B's World -> A comes back in a
// restored tab (its seat) as a captain and gets its old ship -> B sinks the enemy fleet: every
// page shows the victory, the seats are forgotten. Prints the migration time and the full-state
// bandwidth.
//
// Run:  node server.js 8804   then   URL3D=http://localhost:8804/index-3d.html node tests/playwright3d.mp.migrate.mjs
import { chromium } from 'playwright';
const BASE = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const MODE = process.env.MODE || 'local';
const LOCAL = MODE === 'local';
const q = MODE === 'local' ? 'net=local' : MODE === 'relayonly' ? 'net=relay' : '';
const URL = q ? BASE + (BASE.includes('?') ? '&' : '?') + q : BASE;
const errors = [], netNoise = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const args = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browsers = [], ctxs = new Map();
let shared = null, step = 'setup';
const SEAT = 'warships3d.net.rejoin';

const newCtx = async () => {
   if (LOCAL && shared) return shared;
   const browser = await chromium.launch({ args });
   browsers.push(browser);
   const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
   await ctx.addInitScript(() => { window.__netMeasure = true; });
   if (LOCAL) shared = ctx;
   return ctx;
};
// seat: a rejoin seat put into the tab's sessionStorage before the page loads (a restored tab)
const mkPage = async (tag, name, { ctx, seat } = {}) => {
   ctx = ctx || await newCtx();
   const page = await ctx.newPage();
   ctxs.set(page, ctx);
   // SILENT=1: the host's page dies without a goodbye (crash, power cut): no pagehide handler
   if (tag === 'A' && process.env.SILENT) await page.addInitScript(() => { const ael = window.addEventListener; window.addEventListener = function (t, ...a) { if (t !== 'pagehide') return ael.call(this, t, ...a); }; });
   if (seat) await page.addInitScript(([k, v]) => { if (!sessionStorage.getItem('__seeded')) { sessionStorage.setItem(k, v); sessionStorage.setItem('__seeded', '1'); } }, [SEAT, seat]);
   page.on('console', m => {
      if (m.type() !== 'error') return;
      if (/WebSocket connection to|ERR_(NAME_NOT_RESOLVED|CONNECTION|INTERNET|SSL|CERT|TIMED_OUT|NETWORK_CHANGED)|net::ERR_/.test(m.text())) netNoise.push(`[${tag}] ${m.text().slice(0, 160)}`);
      else errors.push(`[${tag}] (${step}) ${m.text()}`);
   });
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
const wait = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true, () => false);
const all = (pages, fn, arg, timeout) => Promise.all(pages.map(p => wait(p, fn, arg, timeout))).then(r => r.every(Boolean));
const ship = (P, id) => P.evaluate((id) => { const s = window.__world().ships.find(x => x.id === id); return s && { human: !!s.human, telegraph: s.telegraph, alive: s.alive, hp: s.hp, maxHP: s.maxHP, ai: !!s.ai }; }, id);
const NAME = 'Wechseltest ' + Math.random().toString(36).slice(2, 7), PW = LOCAL ? '' : 'geheim-' + Math.random().toString(36).slice(2, 6);
console.log(`mode ${MODE}, game "${NAME}"`);

// ---- 1. host + two clients, battle
const A = await mkPage('A', 'Anna');
await A.click('[data-act="main"]');
await A.fill('[data-f="name"]', NAME);
await A.selectOption('[data-f="mission"]', 'standard');
await A.selectOption('[data-f="max"]', '3');
if (PW) await A.fill('[data-f="password"]', PW);
await A.click('.mp-modal [data-ok]');
check('host is in its room', await wait(A, () => !!document.querySelector('.mp-body.room'), null, 20000));
const joinGame = async (P) => {
   if (!await wait(P, (n) => [...document.querySelectorAll('.mp-game .n')].some(e => e.textContent.includes(n)), NAME, 25000)) return 'not listed';
   await P.locator('.mp-game', { hasText: NAME }).locator('[data-join]').click();
   if (PW) { await P.fill('[data-f="joinpw"]', PW); await P.click('.mp-modal [data-ok]'); }
   return await wait(P, () => !!document.querySelector('.mp-body.room'), null, 40000) ? 'ok' : 'no room';
};
const B = await mkPage('B', 'Bert');
const jb = await joinGame(B);
const C = await mkPage('C', 'Carla');
const jc = await joinGame(C);
check('both clients joined', jb === 'ok' && jc === 'ok', [jb, jc]);
for (const P of [B, C]) await P.click('[data-act="main"]');
check('host may start', await wait(A, () => !document.querySelector('[data-act="main"]').disabled, null, 15000));
await A.click('[data-act="main"]');
check('every page is in the battle', await all([A, B, C], () => window.__phase() === 'playing' && !!window.__world()?.player && window.__net()?.ready, null, 30000));
const [idA, idB, idC] = await Promise.all([A, B, C].map(p => p.evaluate(() => window.__world().player.id)));
const [peerA, peerB] = await Promise.all([A, B].map(p => p.evaluate(() => window.__mp.lobby.selfId)));

step = 'successor';
// ---- 2. the host names B and sends it the full state
check('the host names B as its successor', await wait(A, (b) => window.__net().successor === b, peerB, 10000), await A.evaluate(() => window.__net().successor));
check('C knows the successor too', await wait(C, (b) => window.__net().successor === b, peerB, 10000));
const foe = await A.evaluate(() => {
   const w = window.__world(), s = w.ships.find(x => x.side === 'enemy' && x.alive);
   s.hp = Math.round(s.maxHP * 0.6);
   return { id: s.id, hp: s.hp };
});
await A.evaluate(() => { window.__world().stats.shotsFired = 23; });
await sleep(6000);
const migA = await A.evaluate(() => { const n = window.__net(); return { ...n.mig, seconds: n.seconds }; });
const migKBs = migA.bytes / migA.seconds / 1000, migKB = migA.bytes / Math.max(1, migA.count) / 1000;
console.log(`   full state to the successor: ${migA.count} in ${migA.seconds.toFixed(1)} s, ${migKB.toFixed(1)} kB each, ${migKBs.toFixed(1)} kB/s`);
check('full state about once a second', migA.count >= migA.seconds * 0.7 && migA.count <= migA.seconds * 1.5 + 2, migA);
check('full state stays below 16 kB', migKB < 16, +migKB.toFixed(1));
const seatA = await A.evaluate((k) => sessionStorage.getItem(k), SEAT);
check('the host has a seat of its own', !!seatA && JSON.parse(seatA).token?.length > 10);
await B.bringToFront();
for (let i = 0; i < 3; i++) { await B.keyboard.press('w'); await sleep(60); }
const timeBefore = await B.evaluate(() => window.__world().time);

step = 'close A';
// ---- 3. the host's page is closed
const t0 = Date.now();
await A.close({ runBeforeUnload: true });
const tookB = await wait(B, () => window.__net()?.isHost === true, null, 20000) ? Date.now() - t0 : -1;
const tookC = await wait(C, (b) => window.__net()?.hostId === b, peerB, 20000) ? Date.now() - t0 : -1;
console.log(`   migration: B is the host after ${tookB} ms, C follows after ${tookC} ms`);
check('B took over', tookB >= 0, await B.evaluate(() => window.__net()));
check('C follows B', tookC >= 0, await C.evaluate(() => ({ hostId: window.__net()?.hostId, lost: window.__net()?.lost, phase: window.__phase() })));
check('nobody lost the match', await B.evaluate(() => !window.__net().lost && window.__phase() === 'playing') && await C.evaluate(() => !window.__net().lost && window.__phase() === 'playing'));
const noticeB = await wait(B, () => [...document.querySelectorAll('.net-notice')].some(e => /Gastgeber gewechselt/.test(e.textContent)), null, 5000);
const noticeC = await wait(C, () => [...document.querySelectorAll('.net-notice')].some(e => /Gastgeber gewechselt – Bert/.test(e.textContent)), null, 5000);
check('both show "Gastgeber gewechselt"', noticeB && noticeC, await C.evaluate(() => [...document.querySelectorAll('.net-notice')].map(e => e.textContent)));
const migB = await B.evaluate(() => window.__net().migrated);
console.log('   ' + JSON.stringify(migB));

step = 'carry on';
// ---- 4. the battle goes on under B
check('B\'s World runs on', await wait(B, (t) => window.__world().time > t + 2, timeBefore, 10000));
const fb = await ship(B, foe.id);
check('the enemy keeps the damage the old host dealt', fb && fb.alive && Math.abs(fb.hp - foe.hp) <= foe.hp * 0.05, { before: foe.hp, now: fb?.hp });
check('the old host\'s ship sails under the AI', await wait(B, (id) => window.__world().ships.find(s => s.id === id)?.human === false, idA, 5000));
const bots = await B.evaluate(() => { const w = window.__world(); const b = w.ships.filter(s => s.alive && !s.human && !s.isPlayer); return { n: b.length, ai: b.filter(s => s.ai).length, moving: b.filter(s => s.speed > 0.5).length }; });
check('the bots keep their AI and sail', bots.n > 0 && bots.ai === bots.n && bots.moving > bots.n / 2, bots);
check('the old host\'s statistics came along', await B.evaluate((id) => window.__world().ships.find(s => s.id === id)?.stats?.shotsFired >= 23, idA));
check('C gets B\'s snapshots', await wait(C, () => window.__net()?.synced, null, 10000));
const snapsC = await C.evaluate(async () => { const a = window.__net().snapsIn, t = performance.now(); await new Promise(r => setTimeout(r, 3000)); return (window.__net().snapsIn - a) / ((performance.now() - t) / 1000); });
check('C at a full snapshot rate', snapsC > (LOCAL ? 15 : 6), +snapsC.toFixed(1));
await C.bringToFront();
const telC0 = await C.evaluate(() => window.__ctl().telegraph);
const key = telC0 > 0 ? 's' : 'w';
for (let i = 0; i < 2; i++) { await C.keyboard.press(key); await sleep(60); }
const telC = await C.evaluate(() => window.__ctl().telegraph);
check('C steers its ship on B\'s World', telC !== telC0 && await wait(B, ([id, t]) => window.__world().ships.find(s => s.id === id)?.telegraph === t, [idC, telC], 8000), [telC0, telC]);
const posC = await Promise.all([B, C].map(P => P.evaluate((id) => { const s = window.__world().ships.find(x => x.id === id); return [s.pos.x, s.pos.y]; }, idC)));
check('C sees its ship where B has it', Math.hypot(posC[0][0] - posC[1][0], posC[0][1] - posC[1][1]) < 80, posC);
const lob = await Promise.all([B, C].map(P => P.evaluate(() => { const l = window.__mp.lobby; return { host: l.room?.hostId, isHost: l.isHost, n: l.room?.players.length }; })));
check('the room moved to B', lob[0].isHost && lob[0].host === peerB && lob[1].host === peerB && !lob[1].isHost, lob);

step = 'A back';
// ---- 5. the old host comes back as a captain (a restored tab keeps its seat)
const A2 = await mkPage('A2', 'Anna', { ctx: ctxs.get(A) || await newCtx(), seat: seatA });
const listed = await wait(A2, (n) => [...document.querySelectorAll('.mp-game')].some(e => e.textContent.includes(n) && e.querySelector('[data-back]')), NAME, 30000);
check('the list offers the old host ZURÜCKKEHREN', listed, await A2.evaluate(() => [...document.querySelectorAll('.mp-game')].map(e => e.innerText.replace(/\s+/g, ' ')).join(' | ')));
const listHost = await A2.evaluate((n) => window.__mp.lobby.list().find(g => g.name === n)?.hostId, NAME);
check('the listing names B as host', listHost === peerB, listHost);
const t1 = Date.now();
if (listed) await A2.locator('.mp-game', { hasText: NAME }).locator('[data-back]').click();
const backA = await wait(A2, () => window.__phase() === 'playing' && window.__net()?.ready && window.__net()?.synced, null, 40000);
check('the old host is back in the battle', backA, { ms: Date.now() - t1 });
check('as a captain, with its old ship', backA && await A2.evaluate(() => !window.__net().isHost && window.__world().player.id) === idA);
check('B: A\'s ship is human again', await wait(B, (id) => window.__world().ships.find(s => s.id === id)?.human === true, idA, 10000));
await A2.bringToFront();
for (let i = 0; i < 2; i++) { await A2.keyboard.press('w'); await sleep(60); }
const telA = await A2.evaluate(() => window.__ctl().telegraph);
check('A steers its ship on B\'s World', await wait(B, ([id, t]) => window.__world().ships.find(s => s.id === id)?.telegraph === t, [idA, telA], 8000), telA);

step = 'end';
// ---- 6. the battle ends correctly
await B.evaluate(() => { const w = window.__world(); for (const s of w.ships.slice()) if (s.side === 'enemy' && s.alive) s.takeDamage(1e9, w.player, 'pen'); });
const shown = () => { const b = document.querySelector('.m3r-btn[data-act="port"]'); return !!b && b.offsetParent !== null; };
check('every page shows the results', await all([B, C, A2], shown, null, 30000));
const res = await Promise.all([B, C, A2].map(P => P.evaluate(() => ({ phase: window.__world()?.phase, victory: window.__world()?.result?.victory }))));
check('victory everywhere', res.every(r => r.phase === 'won' && r.victory === true), res);
for (const P of [B, C, A2]) await P.click('.m3r-btn[data-act="port"]');
check('the seats are forgotten after the end', await all([C, A2], (k) => !sessionStorage.getItem(k), SEAT, 10000));

step = 'close';
for (const b of browsers) await b.close();
const bad = results.filter(r => !r.ok).length;
if (netNoise.length) console.log(`network noise (refused broker/relay connections, not counted): ${netNoise.length}`);
if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.slice(0, 12).join('\n'));
console.log(`mp.migrate (${MODE}): ${results.length - bad}/${results.length} checks passed, ${errors.length} console errors`);
process.exit(bad || errors.length ? 1 : 0);
