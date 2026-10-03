// tests/playwright3d.mp.multi.mjs -- co-op with 3 or 4 players over the REAL network path: one
// separate Chromium instance per player (nothing shared) against the public MQTT brokers and, in
// hybrid mode, the public Nostr relays. Needs internet; a failure may be the public services'.
//
//   PLAYERS=3|4 (default 3)    host + PLAYERS-1 clients
//   MODE=hybrid (default)      WebRTC allowed: each client is direct where a channel comes up
//   MODE=relayonly             ?net=relay: WebRTC is never tried, everything goes over the brokers
//   MODE=blocked               WebRTC cannot open any path (disable_non_proxied_udp)
//   ONLY=emqx                  every page can reach only the broker whose URL contains this text
//                              (measures the rate-limited broker alone; combine with MODE=relayonly)
//   SECS=45                    length of the measured battle
//   SHOTS=dir                  screenshot of the room with all players (default: the scratch dir)
//
// Flow: password game -> all clients join at once -> room check (every page lists every player,
// the player column shows all rows) -> ready -> start -> every client steers, the host follows ->
// SECS of battle while each client is sampled -> results on every page -> back in the room -> the
// host closes. Prints per client: snapshots/s, worst second, largest snapshot gap, route; for the
// host: upload in kB/s (relay and direct), messages/s per broker, broker backlog and repairs.
//
// Run:  node server.js 8801   then   URL3D=http://localhost:8801/index-3d.html PLAYERS=4 node tests/playwright3d.mp.multi.mjs
import { chromium } from 'playwright';
const BASE = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const MODE = process.env.MODE || 'hybrid';
const PLAYERS = Math.max(2, Math.min(4, Number(process.env.PLAYERS || 3)));
const SECS = Number(process.env.SECS || 45);
const URL = MODE === 'relayonly' ? BASE + (BASE.includes('?') ? '&' : '?') + 'net=relay' : BASE;
const errors = [], netNoise = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const args = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
if (MODE === 'blocked') args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browsers = [];
const NAMES = ['Anna', 'Bert', 'Carla', 'Dora'];
const ONLY = process.env.ONLY || '';
const mkPage = async (tag, name) => {
   const browser = await chromium.launch({ args });          // one browser process per player
   browsers.push(browser);
   const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
   await ctx.addInitScript(() => { window.__netMeasure = true; });
   if (ONLY) await ctx.addInitScript((only) => {
      const Real = window.WebSocket;
      window.WebSocket = class extends Real { constructor(url, protocols) { if (protocols === 'mqtt' && !String(url).includes(only)) throw new Error('broker blocked by the test'); super(url, protocols); } };
   }, ONLY);
   const page = await ctx.newPage();
   page.on('console', m => {
      if (m.type() !== 'error') return;
      if (/WebSocket connection to|ERR_(NAME_NOT_RESOLVED|CONNECTION|INTERNET|SSL|CERT|TIMED_OUT)/.test(m.text())) netNoise.push(`[${tag}] ${m.text().slice(0, 160)}`);
      else errors.push(`[${tag}] ${m.text()}`);
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
const tstats = (page) => page.evaluate(() => {
   const s = window.__mp.lobby.rt?.stats?.();
   if (!s) return null;
   const lb = window.__mp.lobby;
   return { t: performance.now(), hostVia: lb.isHost ? '' : lb.rt.link?.(lb.room?.hostId)?.via || '?', relayOut: s.relayOut, relayIn: s.relayIn, relayBytesOut: s.relayBytesOut, relayBytesIn: s.relayBytesIn, directOut: s.directOut, directIn: s.directIn,
      directBytesOut: s.directBytesOut || 0, directBytesIn: s.directBytesIn || 0, nacks: s.nacks, resent: s.resent, resets: s.resets, dups: s.dups,
      snapGap: s.rx.snap?.maxGap ?? null, cmd: s.rx.cmd ? { n: s.rx.cmd.n, maxGap: Math.round(s.rx.cmd.maxGap) } : null,
      peers: s.peers.map(p => ({ id: p.id, via: p.via, rtt: p.rtt == null ? null : Math.round(p.rtt), primary: p.primary })),
      brokers: s.brokers.map(b => ({ url: b.url.replace(/^wss:\/\/|:\d+\/.*$/g, ''), open: b.open, drops: b.drops || 0, sent: b.sent || 0, received: b.received || 0, backlog: b.backlog || 0 })) };
});
const NAME = 'Multitest ' + Math.random().toString(36).slice(2, 7), PW = 'geheim-' + Math.random().toString(36).slice(2, 6);
console.log(`mode ${MODE}, ${PLAYERS} players, battle ${SECS} s, game "${NAME}"`);

// ---- 1. host creates a password game for PLAYERS players
const A = await mkPage('A', NAMES[0]);
await A.click('[data-act="main"]');
await A.fill('[data-f="name"]', NAME);
await A.selectOption('[data-f="mission"]', 'standard');
await A.selectOption('[data-f="max"]', String(PLAYERS));
await A.fill('[data-f="password"]', PW);
await A.click('.mp-modal [data-ok]');
check('host is in its room', await wait(A, () => !!document.querySelector('.mp-body.room'), null, 20000));
const clients = [];
for (let i = 1; i < PLAYERS; i++) clients.push(await mkPage(String.fromCharCode(65 + i), NAMES[i]));
const pages = [A, ...clients];

// ---- 2. all clients join at once
const t0 = Date.now();
const joined = await Promise.all(clients.map(async (P) => {
   if (!await wait(P, (n) => [...document.querySelectorAll('.mp-game .n')].some(e => e.textContent.includes(n)), NAME, 25000)) return 'not listed';
   await P.locator('.mp-game', { hasText: NAME }).locator('[data-join]').click();
   await P.fill('[data-f="joinpw"]', PW);
   await P.click('.mp-modal [data-ok]');
   return await wait(P, () => !!document.querySelector('.mp-body.room'), null, 40000) ? 'ok' : (await P.evaluate(() => document.querySelector('.mp-modal')?.innerText || '')).replace(/\n/g, ' | ').slice(0, 120);
}));
check(`all ${PLAYERS - 1} clients joined`, joined.every(x => x === 'ok'), { joined, ms: Date.now() - t0 });
const full = await all(pages, (n) => document.querySelectorAll('.mp-player').length === n, PLAYERS, 20000);
check(`every page lists all ${PLAYERS} players`, full, await Promise.all(pages.map(p => p.evaluate(() => document.querySelectorAll('.mp-player').length))));
if (!full) { for (const b of browsers) await b.close(); process.exit(1); }

// ---- 3. the room with all players: every row fully visible, no free slot left, names right
const ui = await Promise.all(pages.map(p => p.evaluate(() => {
   const col = document.querySelector('[data-players]'), rows = [...document.querySelectorAll('.mp-player')];
   const cr = col.getBoundingClientRect();
   return { names: rows.map(r => r.querySelector('.n').firstChild.textContent), slots: document.querySelectorAll('.mp-slot').length,
      clipped: rows.filter(r => { const b = r.getBoundingClientRect(); return b.bottom > cr.bottom + 1 || b.right > cr.right + 1; }).length,
      overflowX: document.documentElement.scrollWidth > innerWidth, count: document.querySelector('[data-pcount]').textContent };
})));
check('room shows every player in full on every page', ui.every(u => u.clipped === 0 && !u.overflowX && u.slots === 0 && u.count === `${PLAYERS}/${PLAYERS}` && NAMES.slice(0, PLAYERS).every(n => u.names.includes(n))), ui);
const shotDir = process.env.SHOTS || '';
if (shotDir) { await A.screenshot({ path: `${shotDir}/mp-room-${PLAYERS}.png` }); await clients[0].screenshot({ path: `${shotDir}/mp-room-${PLAYERS}-client.png` }); }
if (MODE === 'hybrid') {
   await all(clients, () => document.querySelector('.mp-player.me [data-via]')?.dataset.via === 'direct', null, 30000);
   console.log('   routes in the room (host view): ' + JSON.stringify(await A.evaluate(() => [...document.querySelectorAll('.mp-player:not(.me)')].map(e => e.querySelector('[data-via]')?.dataset.via || '?'))));
}
// a full game is listed as full for an outsider? (the host announces players/max)
check('listing says full', await A.evaluate((n) => { const e = window.__mp.lobby._entry(); return e.players === n && e.max === n; }, PLAYERS));

// ---- 4. ready, start
for (const P of clients) await P.click('[data-act="main"]');
check('host may start', await wait(A, () => !document.querySelector('[data-act="main"]').disabled, null, 15000));
await A.click('[data-act="main"]');
check('every browser is in the battle', await all(pages, () => window.__phase() === 'playing' && !!window.__world()?.player, null, 30000));
check('every client is synced', await all(clients, () => window.__net()?.synced, null, 20000));
const ids = await Promise.all(pages.map(p => p.evaluate(() => window.__world().player.id)));
check('every player has an own ship', new Set(ids).size === PLAYERS, ids);
check('host sees all clients as humans', await A.evaluate((ids) => ids.slice(1).every(id => window.__world().ships.find(s => s.id === id)?.human), ids));

// ---- 5. each client orders full ahead; the host's ship follows
for (const P of clients) { await P.bringToFront(); for (let i = 0; i < 4; i++) { await P.keyboard.press('w'); await sleep(60); } }
const moved = await Promise.all(clients.map(async (P, i) => {
   const c = await P.evaluate(() => window.__ctl());
   return wait(A, ([id, tel]) => window.__world().ships.find(s => s.id === id)?.telegraph === tel, [ids[i + 1], c.telegraph], 8000);
}));
check('host applies every client\'s telegraph', moved.every(Boolean), moved);

// ---- 6. measure for SECS seconds
const sampleAll = () => Promise.all(pages.map(p => p.evaluate(() => { const n = window.__net(); return n && { snaps: n.snapsIn, secs: n.seconds, out: n.bytesOut, rtt: n.rtt }; })));
const tsA = [], snapS = [];
const battleStart = Date.now();
tsA.push(await tstats(A)); snapS.push(await sampleAll());
const c0 = await Promise.all(clients.map(tstats));
let turn = 0;
while (Date.now() - battleStart < SECS * 1000) {
   const P = clients[turn % clients.length], key = (turn >> 1) % 2 ? 'a' : 'd'; turn++;
   await P.keyboard.down(key); await sleep(500); await P.keyboard.up(key);
   await sleep(500);
   snapS.push(await sampleAll()); tsA.push(await tstats(A));
}
const c1 = await Promise.all(clients.map(tstats));
check(`battle still running after ${SECS} s on every page`, (await Promise.all(pages.map(p => p.evaluate(() => window.__phase())))).every(x => x === 'playing'));
const off = await Promise.all(clients.map(async (P, i) => {
   const h = await A.evaluate((id) => { const s = window.__world().ships.find(s => s.id === id); return [s.pos.x, s.pos.y]; }, ids[i + 1]);
   const c = await P.evaluate(() => [window.__world().player.pos.x, window.__world().player.pos.y]);
   return Math.round(Math.hypot(h[0] - c[0], h[1] - c[1]));
}));
check('every client\'s own ship agrees with the host', off.every(d => d < 80), off);

// ---- measurements
const h0 = tsA[0], h1 = tsA[tsA.length - 1], dt = (h1.t - h0.t) / 1000;
const per = clients.map((P, i) => {
   const rates = [];
   for (let k = 1; k < snapS.length; k++) { const a = snapS[k - 1][i + 1], b = snapS[k][i + 1]; if (a && b && b.secs > a.secs) rates.push((b.snaps - a.snaps) / (b.secs - a.secs)); }
   const a = snapS[0][i + 1], b = snapS[snapS.length - 1][i + 1];
   return { name: NAMES[i + 1], route: c1[i].hostVia, snapsPerS: +((b.snaps - a.snaps) / (b.secs - a.secs)).toFixed(1), worstSecondHz: +Math.min(...rates).toFixed(1),
      largestGapMs: Math.round(c1[i].snapGap), rttMs: Math.round(b.rtt * 1000), nacks: c1[i].nacks - c0[i].nacks,
      kBpsDown: +(((c1[i].relayBytesIn - c0[i].relayBytesIn) + (c1[i].directBytesIn - c0[i].directBytesIn)) / dt / 1000).toFixed(1) };
});
const host = {
   seconds: +dt.toFixed(1),
   uploadKBps: +(((h1.relayBytesOut - h0.relayBytesOut) + (h1.directBytesOut - h0.directBytesOut)) / dt / 1000).toFixed(1),
   relayKBps: +((h1.relayBytesOut - h0.relayBytesOut) / dt / 1000).toFixed(1), directKBps: +((h1.directBytesOut - h0.directBytesOut) / dt / 1000).toFixed(1),
   relayMsgPerS: +((h1.relayOut - h0.relayOut) / dt).toFixed(1), gameKBpsOut: +((snapS[snapS.length - 1][0].out - snapS[0][0].out) / dt / 1000).toFixed(1),
   brokers: h1.brokers.map((b, k) => ({ url: b.url, open: b.open, drops: b.drops, msgPerS: +((b.sent - h0.brokers[k].sent) / dt).toFixed(1), maxBacklog: Math.max(...tsA.map(s => s.brokers[k].backlog)) })),
   resent: h1.resent - h0.resent, resets: h1.resets - h0.resets, cmdLargestGapMs: h1.cmd?.maxGap,
   routes: h1.peers.map(p => p.via),
};
console.log('MEASURED host     ' + JSON.stringify(host));
for (const c of per) console.log('MEASURED client   ' + JSON.stringify(c));
// broker.emqx.io alone forwards ~8 messages/s, shared by all clients through one publish
const minRate = ONLY ? 6 : 15;
check(`every client gets a playable snapshot rate (> ${minRate}/s)`, per.every(c => c.snapsPerS > minRate), per.map(c => c.snapsPerS));
check('no long freeze on any client', per.every(c => c.largestGapMs < 2500), per.map(c => c.largestGapMs));
if (MODE !== 'hybrid') check('game data went over the relay only', host.directKBps === 0 && host.routes.every(v => v === 'relay'), host.routes);

// ---- 7. end: results everywhere, back to the room
await A.evaluate(() => window.__world().end(true, 'Testende'));
const shown = () => { const b = document.querySelector('.m3r-btn[data-act="port"]'); return !!b && b.offsetParent !== null; };
check('every browser shows the results', await all(pages, shown, null, 20000));
check('every client got the host\'s result', (await Promise.all(clients.map(P => P.evaluate(() => window.__world()?.result?.victory)))).every(v => v === true));
for (const P of pages) await P.click('.m3r-btn[data-act="port"]');
check('everybody is back in the room with everybody', await all(pages, (n) => !document.querySelector('.mp').classList.contains('hidden') && document.querySelectorAll('.mp-player').length === n, PLAYERS, 20000));

// ---- 8. the host closes the game
await A.click('[data-act="back"]');
check('every client is told that the host is gone', await all(clients, () => /Der Host hat das Spiel (geschlossen|verlassen)/.test(document.querySelector('.mp-modal')?.innerText || ''), null, 20000));

for (const b of browsers) await b.close();
const bad = results.filter(r => !r.ok).length;
if (netNoise.length) console.log(`network noise (refused broker/relay connections, not counted): ${netNoise.length}`);
if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.slice(0, 12).join('\n'));
console.log(`mp.multi (${MODE}, ${PLAYERS} players): ${results.length - bad}/${results.length} checks passed, ${errors.length} console errors`);
process.exit(bad || errors.length ? 1 : 0);
