// tests/playwright3d.mp.rejoin.mjs -- back into a running co-op match, over the REAL network path
// (public MQTT brokers; in hybrid mode also WebRTC via the public Nostr relays). One separate
// Chromium instance per player. Needs internet; a failure may be the public services'.
//
//   MODE=hybrid (default) | relayonly (?net=relay, WebRTC never tried)
//   OFF=13                    seconds the second client is offline
//
// Flow: host A + clients B and C start a password game -> B reloads its tab mid-battle (the AI
// takes the ship) and goes back in through ZURÜCKKEHREN in the game list -> B has its old ship,
// the host's objectives, its own statistics, and steers again -> C loses the network for OFF
// seconds, is thrown out, and goes back in the same way -> an outsider sees no way back and is
// refused with a made-up seat -> routes after the rejoin (the direct channel should come back in
// hybrid mode) -> the host ends the match: results everywhere, the seat is forgotten.
//
// Run:  node server.js 8801   then   URL3D=http://localhost:8801/index-3d.html node tests/playwright3d.mp.rejoin.mjs
import { chromium } from 'playwright';
const BASE = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const MODE = process.env.MODE || 'hybrid';
const OFF = Number(process.env.OFF || 13);
const URL = MODE === 'relayonly' ? BASE + (BASE.includes('?') ? '&' : '?') + 'net=relay' : BASE;
const errors = [], netNoise = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const args = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browsers = [], ctxs = new Map();
let step = 'setup';
const mkPage = async (tag, name) => {
   const browser = await chromium.launch({ args });
   browsers.push(browser);
   const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
   await ctx.addInitScript(() => {
      window.__netMeasure = true;
      // every peer connection, so that the test can cut the direct route like a network change does
      const Real = window.RTCPeerConnection;
      if (Real) { window.__pcs = []; window.RTCPeerConnection = class extends Real { constructor(...a) { super(...a); window.__pcs.push(this); } }; }
   });
   const page = await ctx.newPage();
   ctxs.set(page, ctx);
   page.on('console', m => {
      if (m.type() !== 'error') return;
      if (/WebSocket connection to|ERR_(NAME_NOT_RESOLVED|CONNECTION|INTERNET|SSL|CERT|TIMED_OUT|NETWORK_CHANGED)|net::ERR_/.test(m.text())) netNoise.push(`[${tag}] ${m.text().slice(0, 160)}`);
      else errors.push(`[${tag}] (${step}) ${m.text()}`);
   });
   page.on('pageerror', e => errors.push(`[${tag}] PAGEERROR: ${e.message}`));
   await page.goto(URL);
   await page.waitForSelector('.m3-card');
   await page.click('[data-act="mp"]');
   await page.waitForSelector('[data-f="pname"]');
   await page.fill('[data-f="pname"]', name);
   await page.click('.mp-modal [data-ok]');
   return page;
};
const wait = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true, () => false);
const all = (pages, fn, arg, timeout) => Promise.all(pages.map(p => wait(p, fn, arg, timeout))).then(r => r.every(Boolean));
const hostShip = (A, id) => A.evaluate((id) => { const s = window.__world().ships.find(x => x.id === id); return s && { human: !!s.human, telegraph: s.telegraph, alive: s.alive }; }, id);
const NAME = 'Rejointest ' + Math.random().toString(36).slice(2, 7), PW = 'geheim-' + Math.random().toString(36).slice(2, 6);
console.log(`mode ${MODE}, game "${NAME}"`);

// ---- 1. host + two clients, password game, battle
const A = await mkPage('A', 'Anna');
await A.click('[data-act="main"]');
await A.fill('[data-f="name"]', NAME);
await A.selectOption('[data-f="mission"]', 'standard');
await A.selectOption('[data-f="max"]', '3');
await A.fill('[data-f="password"]', PW);
await A.click('.mp-modal [data-ok]');
check('host is in its room', await wait(A, () => !!document.querySelector('.mp-body.room'), null, 20000));
const B = await mkPage('B', 'Bert'), C = await mkPage('C', 'Carla');
const joined = await Promise.all([B, C].map(async (P) => {
   if (!await wait(P, (n) => [...document.querySelectorAll('.mp-game .n')].some(e => e.textContent.includes(n)), NAME, 25000)) return 'not listed';
   await P.locator('.mp-game', { hasText: NAME }).locator('[data-join]').click();
   await P.fill('[data-f="joinpw"]', PW);
   await P.click('.mp-modal [data-ok]');
   return await wait(P, () => !!document.querySelector('.mp-body.room'), null, 40000) ? 'ok' : 'no room';
}));
check('both clients joined', joined.every(x => x === 'ok'), joined);
for (const P of [B, C]) await P.click('[data-act="main"]');
check('host may start', await wait(A, () => !document.querySelector('[data-act="main"]').disabled, null, 15000));
await A.click('[data-act="main"]');
check('every browser is in the battle', await all([A, B, C], () => window.__phase() === 'playing' && !!window.__world()?.player && window.__net()?.ready, null, 30000));
const [idA, idB, idC] = await Promise.all([A, B, C].map(p => p.evaluate(() => window.__world().player.id)));
check('each client got a seat token', (await Promise.all([B, C].map(p => p.evaluate(() => !!sessionStorage.getItem('warships3d.net.rejoin'))))).every(Boolean));
await B.bringToFront();
for (let i = 0; i < 3; i++) { await B.keyboard.press('w'); await sleep(60); }
const telB = await B.evaluate(() => window.__ctl().telegraph);
check('host follows B', await wait(A, ([id, t]) => window.__world().ships.find(s => s.id === id)?.telegraph === t, [idB, telB], 8000), telB);
await sleep(4000);

step = 'reload B';
// ---- 2. B reloads its tab: the AI takes over, B goes back in through the list
const selfB0 = await B.evaluate(() => window.__mp.lobby.selfId);
await B.reload();
await B.waitForSelector('.m3-card');
check('host: the AI steers B\'s ship meanwhile', await wait(A, (id) => window.__world().ships.find(s => s.id === id)?.human === false, idB, 20000));
await sleep(3000);                                 // the battle goes on without B
await B.click('[data-act="mp"]');
const listed = await wait(B, (n) => !!document.querySelector('.mp-game [data-back]') && [...document.querySelectorAll('.mp-game')].some(e => e.textContent.includes(n)), NAME, 25000);
check('after the reload the list offers ZURÜCKKEHREN', listed, await B.evaluate(() => [...document.querySelectorAll('.mp-game')].map(e => e.innerText.replace(/\s+/g, ' ')).join(' | ')));
const t1 = Date.now();
await B.locator('.mp-game', { hasText: NAME }).locator('[data-back]').click();
const backB = await wait(B, () => window.__phase() === 'playing' && !!window.__world()?.player && window.__net()?.ready && window.__net()?.synced, null, 40000);
check('B is back in the battle', backB, { ms: Date.now() - t1, selfIdChanged: selfB0 !== await B.evaluate(() => window.__mp.lobby.selfId) });
check('B commands its old ship', await B.evaluate(() => window.__world().player.id) === idB, idB);
check('host: B\'s ship is human again', await wait(A, (id) => window.__world().ships.find(s => s.id === id)?.human === true, idB, 10000), await hostShip(A, idB));
const tgBack = await B.evaluate(() => [window.__ctl().telegraph, window.__world().player.telegraph]);
const tgHost = (await hostShip(A, idB)).telegraph;
check('B starts with the telegraph the ship has (no stop on return)', tgBack[0] === tgHost || Math.abs(tgBack[0] - tgHost) <= 1, { client: tgBack, host: tgHost });
const same = await Promise.all([A, B].map(p => p.evaluate(() => JSON.stringify(window.__world().mission?.objectives || null))));
check('objectives match the host', same[0] === same[1]);
const statsB = await B.evaluate(() => window.__world().stats), statsH = await A.evaluate((id) => window.__world().ships.find(s => s.id === id).stats, idB);
check('own statistics match the host', JSON.stringify(Object.keys(statsH).sort()) === JSON.stringify(Object.keys(statsB).sort()) && statsB.shotsFired === statsH.shotsFired, { client: statsB.shotsFired, host: statsH.shotsFired });
const shipsSame = await Promise.all([A, B].map(p => p.evaluate(() => window.__world().ships.filter(s => s.alive).map(s => s.id).sort((a, b) => a - b).join(','))));
check('same living ships as the host', await wait(B, (ids) => window.__world().ships.filter(s => s.alive).map(s => s.id).sort((a, b) => a - b).join(',') === ids, shipsSame[0], 5000), shipsSame);
await B.bringToFront();
for (let i = 0; i < 2; i++) { await B.keyboard.press('s'); await sleep(60); }
const telB2 = await B.evaluate(() => window.__ctl().telegraph);
check('B steers again', await wait(A, ([id, t]) => window.__world().ships.find(s => s.id === id)?.telegraph === t, [idB, telB2], 8000), telB2);
check('host room lists B again', await wait(A, () => document.querySelectorAll('.mp-player').length === 3 || window.__mp.lobby.room.players.length === 3, null, 10000));

step = 'C offline';
// ---- 3. C loses the network for OFF seconds
const ctxC = ctxs.get(C);
await ctxC.setOffline(true);
await C.evaluate(() => { for (const pc of window.__pcs || []) pc.close(); });     // offline does not stop a loopback WebRTC channel
const lostC = await wait(C, () => window.__phase() !== 'playing' || !!window.__net()?.lost, null, (OFF + 5) * 1000);
await sleep(Math.max(0, OFF * 1000 - 6000));
await ctxC.setOffline(false);
check('C noticed the lost connection', lostC, await C.evaluate(() => window.__net()?.lost || window.__phase()));
check('host: the AI steers C\'s ship meanwhile', (await hostShip(A, idC)).human === false);
// back: from the room (still connected) or from the list (room gone)
const way = await C.waitForFunction(() => {
   const m = document.querySelector('[data-act="main"]');
   if (m && m.dataset.kind === 'rejoin' && !m.disabled) return 'room';
   if (document.querySelector('.mp-game [data-back]')) return 'list';
   return false;
}, null, { timeout: 45000, polling: 200 }).then(h => h.jsonValue(), () => null);
check('C is offered the way back', !!way, way);
if (way) {
   await C.evaluate(() => document.querySelector('.mp-modal [data-ok], .mp-modal [data-cancel]')?.click());
   if (way === 'room') await C.click('[data-act="main"]'); else await C.locator('.mp-game [data-back]').first().click();
   check('C is back in the battle', await wait(C, () => window.__phase() === 'playing' && window.__net()?.ready && window.__net()?.synced, null, 40000), way);
   check('C commands its old ship', await C.evaluate(() => window.__world()?.player?.id) === idC);
   check('host: C\'s ship is human again', await wait(A, (id) => window.__world().ships.find(s => s.id === id)?.human === true, idC, 10000));
}

step = 'outsider';
// ---- 4. an outsider: no way back, a made-up seat is refused
const M = await mkPage('M', 'Mallory');
check('outsider sees the running game without ZURÜCKKEHREN', await wait(M, (n) => [...document.querySelectorAll('.mp-game')].some(e => e.textContent.includes(n)), NAME, 25000)
   && await M.evaluate(() => !document.querySelector('.mp-game [data-back]') && !!document.querySelector('.mp-game [data-join][disabled]')));
const forged = await M.evaluate(async (n) => {
   const lb = window.__mp.lobby, g = lb.list().find(x => x.name === n);
   try { await lb.join(g, '', { seat: 'abcdefghij', token: 'x'.repeat(24), key: '' }); return 'joined'; } catch (e) { return e.code || String(e); }
}, NAME);
check('a made-up seat is refused', forged === 'norejoin', forged);

step = 'routes';
// ---- 5. routes after the rejoins
await sleep(MODE === 'hybrid' ? 20000 : 3000);
const routes = await A.evaluate(([b, c]) => { const lb = window.__mp.lobby; const ids = lb.room.players.map(p => p.id).filter(id => id !== lb.selfId); return ids.map(id => ({ id: id.slice(0, 6), via: lb.rt.link?.(id)?.via || '?' })); }, [idB, idC]);
console.log('   routes after the rejoins (host view): ' + JSON.stringify(routes));
if (MODE === 'hybrid') check('direct channel back after the rejoin (Trystero)', routes.every(r => r.via === 'direct'), routes);
else check('relay route after the rejoin', routes.every(r => r.via === 'relay'), routes);
const snapsB = await B.evaluate(async () => { const a = window.__net().snapsIn, t = performance.now(); await new Promise(r => setTimeout(r, 3000)); return (window.__net().snapsIn - a) / ((performance.now() - t) / 1000); });
check('B gets a full snapshot rate after the rejoin', snapsB > 15, +snapsB.toFixed(1));

step = 'end';
// ---- 6. end: results everywhere, seats forgotten
await A.evaluate(() => window.__world().end(true, 'Testende'));
const shown = () => { const b = document.querySelector('.m3r-btn[data-act="port"]'); return !!b && b.offsetParent !== null; };
check('every browser shows the results', await all([A, B, C], shown, null, 20000));
check('the returned clients got the host\'s result', (await Promise.all([B, C].map(P => P.evaluate(() => window.__world()?.result?.victory)))).every(v => v === true));
for (const P of [A, B, C]) await P.click('.m3r-btn[data-act="port"]');
check('the seat is forgotten after the end', await all([B, C], () => !sessionStorage.getItem('warships3d.net.rejoin'), null, 10000));

step = 'close';
for (const b of browsers) await b.close();
const bad = results.filter(r => !r.ok).length;
if (netNoise.length) console.log(`network noise (refused broker/relay connections, not counted): ${netNoise.length}`);
if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.slice(0, 12).join('\n'));
console.log(`mp.rejoin (${MODE}): ${results.length - bad}/${results.length} checks passed, ${errors.length} console errors`);
process.exit(bad || errors.length ? 1 : 0);
