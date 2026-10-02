// tests/playwright3d.mp.relay.mjs -- multiplayer over the REAL network path: two separate Chromium
// instances (two browser processes, nothing shared) against the public MQTT brokers and, for the
// direct route, the public Nostr relays. Needs internet; talks to services nobody here controls,
// so a failure may be theirs. Not part of the offline test set.
//
//   MODE=blocked (default)  WebRTC cannot open any direct path (Chromium policy
//                           disable_non_proxied_udp, the situation of two players behind strict
//                           routers): everything must work over the relay
//   MODE=direct             WebRTC allowed: the room must switch to the direct channel
//   MODE=relayonly          ?net=relay: WebRTC is never tried
//   REMOTE_WS=ws://...      player B runs in a Playwright server on another machine (two real
//                           networks), e.g. `npx playwright run-server --port 39300` there, reached
//                           through `ssh -L 39300:127.0.0.1:39300 -R 39301:127.0.0.1:5173`;
//                           URL3D_B=http://localhost:39301/index-3d.html is the page as B sees it.
//                           B then draws nothing (no GPU there), so its timings are upper bounds.
//   ONLY=emqx             (any part of a broker's host name) all other brokers are unreachable:
//                           how the game does on that broker alone
//
// Flow: create a game with password -> the other browser sees it -> wrong password -> right
// password -> ready -> start -> co-op battle of SECS seconds (the client steers and fires, the
// host sees its ship react) -> results -> back in the room -> the client leaves, joins again at
// once, a second battle starts and runs a few seconds -> the host closes the game.
// Prints what the client measured: round trip time, snapshot rate, largest snapshot gap, broker
// connects/drops.
//
// Run:  node server.js 5173   then   URL3D=http://localhost:5173/index-3d.html node tests/playwright3d.mp.relay.mjs
import { chromium } from 'playwright';
const BASE = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const MODE = process.env.MODE || 'blocked';
const SECS = Number(process.env.SECS || 60), ONLY = process.env.ONLY || '';
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
const mkPage = async (tag, name) => {
   // REMOTE_WS (+ URL3D_B): player B runs in a Playwright server on another machine / network
   const remote = tag === 'B' && process.env.REMOTE_WS;
   const rargs = args.filter(x => !/angle|gpu/.test(x)).concat('--enable-unsafe-swiftshader');
   const browser = remote ? await chromium.connect(remote, { headers: { 'x-playwright-launch-options': JSON.stringify({ args: rargs }) } })
      : await chromium.launch({ args });          // one browser process per player
   browsers.push(browser);
   // a remote machine usually renders in software: a small window keeps its page responsive
   const ctx = await browser.newContext({ viewport: remote ? { width: 800, height: 450 } : { width: 1440, height: 810 } });
   await ctx.addInitScript(() => { window.__netMeasure = true; });      // the netcode counts its bytes
   if (ONLY) await ctx.addInitScript((only) => {
      const Real = window.WebSocket;
      window.WebSocket = class extends Real { constructor(url, protocols) { if (protocols === 'mqtt' && !String(url).includes(only)) throw new Error('broker blocked by the test'); super(url, protocols); } };
   }, ONLY);
   // ... and a few frames per second are enough there: the netcode does not depend on the frame rate
   if (remote) await ctx.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (fn) => setTimeout(() => raf(fn), 40);
      // no rasterising at all: software WebGL would block the page for seconds and spoil the timings
      for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) if (C) {
         for (const f of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements', 'clear']) if (C.prototype[f]) C.prototype[f] = () => { };
      }
   });
   const page = await ctx.newPage();
   if (remote) page.click = (sel) => page.dispatchEvent(sel, 'click');
   page.on('console', m => {
      if (m.type() !== 'error') return;
      // a public broker or relay that refuses a connection is expected now and then; the browser logs it by itself
      if (/WebSocket connection to|ERR_(NAME_NOT_RESOLVED|CONNECTION|INTERNET|SSL|CERT|TIMED_OUT)/.test(m.text())) netNoise.push(`[${tag}] ${m.text().slice(0, 160)}`);
      else errors.push(`[${tag}] ${m.text()}`);
   });
   page.on('pageerror', e => errors.push(`[${tag}] PAGEERROR: ${e.message}`));
   await page.goto(remote && process.env.URL3D_B ? URL.replace(BASE, process.env.URL3D_B) : URL);
   await page.waitForSelector('.m3-card');
   await page.click('[data-act="mp"]');
   await page.waitForSelector('[data-f="pname"]');
   await page.fill('[data-f="pname"]', name);
   await page.click('.mp-modal [data-ok]');
   return page;
};
const wait = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true, () => false);
const viaOf = (page) => page.evaluate(() => [...document.querySelectorAll('.mp-player')].map(e => e.querySelector('[data-via]')?.dataset.via || ''));
const stats = (page) => page.evaluate(() => {
   const lb = window.__mp.lobby, s = lb.rt?.stats?.();
   if (!s) return null;
   return { relayOut: s.relayOut, relayIn: s.relayIn, relayKb: [Math.round(s.relayBytesOut / 1000), Math.round(s.relayBytesIn / 1000)], directOut: s.directOut, directIn: s.directIn, dups: s.dups, nacks: s.nacks, resent: s.resent, resets: s.resets, badCrypto: s.badCrypto,
      rx: s.rx, peers: s.peers.map(p => ({ via: p.via, rtt: p.rtt == null ? null : Math.round(p.rtt), primary: p.primary })),
      brokers: s.brokers.map(b => ({ url: b.url.replace(/^wss:\/\/|:\d+\/.*$/g, ''), open: b.open, connects: b.connects || 0, drops: b.drops || 0, sent: b.sent || 0, received: b.received || 0, error: b.lastError || '' })) };
});
const NAME = 'Relaytest ' + Math.random().toString(36).slice(2, 7), PW = 'geheim-' + Math.random().toString(36).slice(2, 6);
console.log(`mode ${MODE}${ONLY ? ', only broker ' + ONLY : ''}, battle ${SECS} s, game "${NAME}"`);

// ---- 1. host creates a password game
const A = await mkPage('A', 'Anna');
await A.click('[data-act="main"]');
await A.fill('[data-f="name"]', NAME);
await A.selectOption('[data-f="mission"]', 'standard');
await A.fill('[data-f="password"]', PW);
await A.click('.mp-modal [data-ok]');
check('host is in its room', await wait(A, () => !!document.querySelector('.mp-body.room') && document.querySelectorAll('.mp-player').length === 1, null, 20000));
check('host reaches at least one broker', await wait(A, () => window.__mp.lobby.status().open > 0, null, 15000), await A.evaluate(() => window.__mp.lobby.status()));

// ---- 2. the other browser finds it
const B = await mkPage('B', 'Bert');
let t0 = Date.now();
const seen = await wait(B, (n) => [...document.querySelectorAll('.mp-game .n')].some(e => e.textContent.includes(n)), NAME, 20000);
check('client sees the game in the list', seen, `${Date.now() - t0} ms after opening the lobby; brokers ${JSON.stringify(await B.evaluate(() => window.__mp.lobby.status()))}`);
check('no "unreachable" warning', !(await B.evaluate(() => /keine direkte Verbindung/i.test(document.querySelector('.mp-body').innerText))));
const row = B.locator('.mp-game', { hasText: NAME });
// a software-rendered remote page is too slow for Playwright's "stable for two frames" click check
const joinClick = () => process.env.REMOTE_WS ? row.locator('[data-join]').dispatchEvent('click') : row.locator('[data-join]').click();

// ---- 3. wrong password, then the right one
await joinClick();
await B.fill('[data-f="joinpw"]', 'falsch');
await B.click('.mp-modal [data-ok]');
const denied = await wait(B, () => /Falsches Passwort/.test(document.querySelector('.mp-modal')?.innerText || ''), null, 15000);
check('wrong password is refused', denied, (await B.evaluate(() => document.querySelector('.mp-modal')?.innerText || '')).replace(/\n/g, ' | ').slice(0, 120));
if (!await B.locator('[data-f="joinpw"]').count()) { await B.click('.mp-modal [data-ok]').catch(() => { }); await joinClick(); }
await B.fill('[data-f="joinpw"]', PW);
t0 = Date.now();
await B.click('.mp-modal [data-ok]');
const inRoom = await wait(B, () => !!document.querySelector('.mp-body.room') && document.querySelectorAll('.mp-player').length === 2, null, 30000);
check('client joined the room', inRoom, inRoom ? `${Date.now() - t0} ms` : (await B.evaluate(() => document.querySelector('.mp-modal')?.innerText || document.querySelector('.mp-body').innerText)).replace(/\n/g, ' | ').slice(0, 200));
check('host sees the client', await wait(A, () => document.querySelectorAll('.mp-player').length === 2, null, 10000));
if (!inRoom) { for (const b of browsers) await b.close(); console.log('mp.relay: cannot go on without a room'); process.exit(1); }

// ---- 4. how the room is connected
if (MODE === 'direct') {
   t0 = Date.now();
   const up = await wait(A, () => document.querySelector('.mp-player:not(.me) [data-via]')?.dataset.via === 'direct', null, 40000);
   check('room switched to the direct channel', up, up ? `${Date.now() - t0} ms after joining` : JSON.stringify(await stats(A)));
   check('client shows "direkt" too', await wait(B, () => document.querySelector('.mp-player.me [data-via]')?.dataset.via === 'direct', null, 8000), await viaOf(B));
} else {
   check('host shows the client as "über Relay"', await wait(A, () => document.querySelector('.mp-player:not(.me) [data-via]')?.textContent === 'über Relay', null, 8000), await viaOf(A));
   check('client shows itself as "über Relay"', await wait(B, () => document.querySelector('.mp-player.me [data-via]')?.textContent === 'über Relay', null, 8000), await viaOf(B));
}
// chat both ways (reliable channel)
await B.fill('[data-chat]', 'Hallo vom Gast'); await B.click('[data-send]');
check('chat client -> host', await wait(A, () => /Hallo vom Gast/.test(document.querySelector('[data-log]').innerText), null, 8000));
await A.fill('[data-chat]', 'Hallo vom Host'); await A.click('[data-send]');
check('chat host -> client', await wait(B, () => /Hallo vom Host/.test(document.querySelector('[data-log]').innerText), null, 8000));

// ---- 5. ready, start
await B.click('[data-act="main"]');
check('host may start', await wait(A, () => !document.querySelector('[data-act="main"]').disabled, null, 10000));
await A.click('[data-act="main"]');
const okA = await wait(A, () => window.__phase() === 'playing' && !!window.__world()?.player, null, 30000);
const okB = await wait(B, () => window.__phase() === 'playing' && !!window.__world()?.player, null, 30000);
check('both browsers are in the battle', okA && okB);
check('client is synced', await wait(B, () => window.__net()?.synced, null, 15000));
const battleStart = Date.now();
const me = await B.evaluate(() => window.__world().player.id);
const hostShip = (id) => A.evaluate((id) => { const w = window.__world(), s = w.ships.find(s => s.id === id); return { x: s.pos.x, y: s.pos.y, hdg: s.heading, kn: s.speedKn, tel: s.telegraph, rudder: s.rudderCmd, shots: s.stats.shotsFired, shells: w.shells.filter(q => q.ownerId === id).length, tick: w.tick, phase: w.phase }; }, id);
const ownShip = () => B.evaluate(() => { const w = window.__world(), s = w.player; return { x: s.pos.x, y: s.pos.y, hdg: s.heading, kn: s.speedKn, tick: w.tick, ships: w.ships.length, phase: w.phase }; });
const h0 = await hostShip(me);

// ---- 6. the client steers; the host's simulation follows
await B.mouse.move(720, 400);
for (let i = 0; i < 4; i++) { await B.keyboard.press('w'); await sleep(60); }
await B.keyboard.down('d'); await sleep(900); await B.keyboard.up('d');
const ctl = await B.evaluate(() => window.__ctl());
t0 = Date.now();
const applied = await wait(A, ([id, c]) => { const s = window.__world().ships.find(s => s.id === id); return s.telegraph === c.telegraph && s.rudderCmd === c.rudder; }, [me, ctl], 6000);
check('host applies the client\'s helm and telegraph', applied, { telegraph: ctl.telegraph, rudder: ctl.rudder, ms: Date.now() - t0 });

// sample the link once a second for the rest of the battle
const samples = [];
const sample = async () => {
   const n = await B.evaluate(() => { const n = window.__net(), s = window.__mp.lobby.rt?.stats?.(), l = window.__mp.lobby.rt?.link?.(window.__mp.lobby.room?.hostId); return n && { t: performance.now(), snaps: n.snapsIn, secs: n.seconds, rtt: n.rtt, delay: n.delay, kB: n.bytesIn / 1000, gap: s?.rx?.snap?.maxGap ?? null, link: l?.rtt ?? null, via: l?.via ?? null }; });
   if (n) samples.push(n);
};
const sampleFor = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { await sample(); await sleep(1000); } };
await sampleFor(6000);
for (let i = 0; i < 10 && Math.abs((await hostShip(me)).hdg - h0.hdg) <= 0.05; i++) await sampleFor(1000);      // a battleship answers the helm slowly
let hv = await hostShip(me), cv = await ownShip();
check('client\'s ship is under way and turning on the host', hv.kn > 5 && Math.abs(hv.hdg - h0.hdg) > 0.05, { kn: +hv.kn.toFixed(1), turned: +(hv.hdg - h0.hdg).toFixed(2) });
check('client shows the same motion', Math.abs(cv.kn - hv.kn) < 4 && Math.hypot(cv.x - hv.x, cv.y - hv.y) < 80, { kn: +cv.kn.toFixed(1), off: +Math.hypot(cv.x - hv.x, cv.y - hv.y).toFixed(1) });

// ---- 7. the client fires; the host fires that ship's guns
for (let i = 0; i < 6 && (await B.evaluate(() => window.__ctl().rudder)) !== 0; i++) { await B.keyboard.press('a'); await sleep(80); }
let fired = { salvos: 0 };
for (let i = 0; i < 5 && !fired.salvos; i++) {
   await B.evaluate(() => window.__setAim(1.3, 9000));
   await wait(B, () => { const t = window.__turrets(); return t.length > 0 && t.filter(x => x.state === 'ready').length >= Math.ceil(t.length / 2); }, null, 20000);
   await B.mouse.down(); await sleep(80); await B.mouse.up();
   await sleep(150);
   fired = await B.evaluate(() => window.__fired());
}
check('client fired', fired.salvos > 0, fired);
const shot = await wait(A, ([id, n]) => window.__world().ships.find(s => s.id === id).stats.shotsFired > n, [me, h0.shots], 6000);
check('host fired the client ship\'s guns', shot, { shots: (await hostShip(me)).shots });

// ---- 8. keep playing until SECS are over: a turn every 10 s
let turn = 0;
while (Date.now() - battleStart < SECS * 1000) {
   const key = turn++ % 2 ? 'a' : 'd';
   await B.keyboard.down(key); await sleep(700); await B.keyboard.up(key);
   await sampleFor(Math.min(9000, Math.max(1000, SECS * 1000 - (Date.now() - battleStart))));
}
hv = await hostShip(me); cv = await ownShip();
check(`battle still running after ${SECS} s on both sides`, hv.phase === cv.phase && (await B.evaluate(() => window.__phase())) === 'playing', { host: hv.phase, client: cv.phase, played: Math.round((Date.now() - battleStart) / 1000) });
check('positions agree at the end', Math.hypot(cv.x - hv.x, cv.y - hv.y) < 80, { off: +Math.hypot(cv.x - hv.x, cv.y - hv.y).toFixed(1) });

// ---- measurements
const sa = await stats(A), sb = await stats(B);
const first = samples[0], last = samples[samples.length - 1];
const hz = (last.snaps - first.snaps) / (last.secs - first.secs), kBps = (last.kB - first.kB) / (last.secs - first.secs);
const rates = samples.slice(1).map((s, i) => (s.snaps - samples[i].snaps) / (s.secs - samples[i].secs)).filter(Number.isFinite);
const links = samples.map(s => s.link).filter(x => x != null).sort((a, b) => a - b);
const med = (a) => a.length ? a[a.length >> 1] : null;
const m = {
   mode: MODE + (ONLY ? '/' + ONLY : ''), route: sb.peers[0]?.via, seconds: +(last.secs - first.secs).toFixed(1),
   snapshotsPerS: +hz.toFixed(2), worstSecondHz: +Math.min(...rates).toFixed(1), largestSnapshotGapMs: Math.round(sb.rx.snap?.maxGap ?? -1),
   transportRttMs: { median: Math.round(med(links)), max: Math.round(links[links.length - 1]) }, netcodeRttMs: Math.round(last.rtt * 1000), renderDelayMs: Math.round(last.delay * 1000),
   kBpsDown: +kBps.toFixed(1), cmdAtHost: sa.rx.cmd?.n, largestCmdGapMs: Math.round(sa.rx.cmd?.maxGap ?? -1),
};
console.log('MEASURED (client) ' + JSON.stringify(m));
console.log('client transport  ' + JSON.stringify({ ...sb, rx: undefined }));
console.log('host transport    ' + JSON.stringify({ ...sa, rx: undefined }));
check('snapshot rate keeps the game playable', hz > (ONLY ? 5 : 15), { hz: +hz.toFixed(1) });
check('no long freeze', (sb.rx.snap?.maxGap ?? 1e9) < 2500, { maxGapMs: Math.round(sb.rx.snap?.maxGap ?? -1) });
if (MODE === 'direct') check('game data went over the direct channel', sb.peers[0]?.via === 'direct' && sb.directIn > 500, { directIn: sb.directIn });
else check('game data went over the relay only', sb.peers[0]?.via === 'relay' && sb.directIn === 0 && sa.directIn === 0, { relayIn: sb.relayIn, directIn: sb.directIn });
check('at least one broker connected throughout', sb.brokers.some(b => b.open && b.drops === 0) && sa.brokers.some(b => b.open && b.drops === 0));

// ---- 9. the battle ends: results, back to the room
await A.evaluate(() => window.__world().end(true, 'Testende'));
const shown = () => { const b = document.querySelector('.m3r-btn[data-act="port"]'); return !!b && b.offsetParent !== null; };
check('both browsers show the results', (await wait(A, shown, null, 15000)) && (await wait(B, shown, null, 15000)));
check('client got the host\'s result', (await B.evaluate(() => window.__world()?.result?.victory)) === true);
await A.click('.m3r-btn[data-act="port"]'); await B.click('.m3r-btn[data-act="port"]');
const back = () => !document.querySelector('.mp').classList.contains('hidden') && document.querySelectorAll('.mp-player').length === 2;
check('both are back in the room with both players', (await wait(A, back, null, 15000)) && (await wait(B, back, null, 15000)));

// ---- 10. the client leaves; the host notices, the game is listed again for the client
await B.click('[data-act="back"]');
check('host sees the client leave', await wait(A, () => document.querySelectorAll('.mp-player').length === 1, null, 12000));
check('client is back in the list and sees the game again', await wait(B, (n) => [...document.querySelectorAll('.mp-game .n')].some(e => e.textContent.includes(n)), NAME, 15000));

// ---- 11. the client comes straight back (what a player does after a battle) and a second battle starts
t0 = Date.now();
await joinClick();
await B.fill('[data-f="joinpw"]', PW);
await B.click('.mp-modal [data-ok]');
const inAgain = await wait(B, () => !!document.querySelector('.mp-body.room') && document.querySelectorAll('.mp-player').length === 2, null, 30000);
check('client joined a second time', inAgain, inAgain ? `${Date.now() - t0} ms` : (await B.evaluate(() => document.querySelector('.mp-modal')?.innerText || document.querySelector('.mp-body').innerText)).replace(/\n/g, ' | ').slice(0, 200));
check('host sees the client again', await wait(A, () => document.querySelectorAll('.mp-player').length === 2, null, 10000));
if (inAgain) {
   await B.click('[data-act="main"]');
   check('host may start again', await wait(A, () => !document.querySelector('[data-act="main"]').disabled, null, 10000));
   await A.click('[data-act="main"]');
   const again = (await wait(A, () => window.__phase() === 'playing' && !!window.__world()?.player, null, 30000)) && (await wait(B, () => window.__phase() === 'playing' && !!window.__world()?.player && window.__net()?.synced, null, 30000));
   check('second battle: both in, client synced', again);
   if (again) {
      const me2 = await B.evaluate(() => window.__world().player.id);
      const n0 = await B.evaluate(() => window.__net().snapsIn);
      for (let i = 0; i < 4; i++) { await B.keyboard.press('w'); await sleep(60); }
      const ctl2 = await B.evaluate(() => window.__ctl());
      check('second battle: host applies the client\'s telegraph', await wait(A, ([id, c]) => window.__world().ships.find(s => s.id === id)?.telegraph === c.telegraph, [me2, ctl2], 6000), { telegraph: ctl2.telegraph });
      { const a = await stats(A), b = await stats(B); console.log('   second visit, routes ' + JSON.stringify({ host: a.peers, client: b.peers, hostDirect: [a.directOut, a.directIn], clientDirect: [b.directOut, b.directIn], hostCmd: a.rx.cmd?.n })); }
      await sleep(5000);
      const n1 = await B.evaluate(() => window.__net().snapsIn);
      check('second battle: snapshots keep arriving', n1 - n0 > (ONLY ? 25 : 60), { in5s: n1 - n0, via: (await stats(B))?.peers[0]?.via });
      await A.evaluate(() => window.__world().end(true, 'Testende'));
      check('second battle: both show the results', (await wait(A, shown, null, 15000)) && (await wait(B, shown, null, 15000)));
      await A.click('.m3r-btn[data-act="port"]'); await B.click('.m3r-btn[data-act="port"]');
      check('second battle: both are back in the room', (await wait(A, back, null, 15000)) && (await wait(B, back, null, 15000)));
   }
}

// ---- 12. the host closes the game: the client is told and the listing goes
await A.click('[data-act="back"]');
if (inAgain) {
   const told = await wait(B, () => /Der Host hat das Spiel (geschlossen|verlassen)/.test(document.querySelector('.mp-modal')?.innerText || ''), null, 15000);
   check('client is told that the host is gone', told, (await B.evaluate(() => document.querySelector('.mp-modal')?.innerText || '')).replace(/\n/g, ' | ').slice(0, 120));
   await B.click('.mp-modal [data-ok]').catch(() => { });
}
check('game disappears from the list when the host leaves', await wait(B, (n) => ![...document.querySelectorAll('.mp-game .n')].some(e => e.textContent.includes(n)), NAME, 15000));

for (const b of browsers) await b.close();
const bad = results.filter(r => !r.ok).length;
if (netNoise.length) console.log(`network noise (refused broker/relay connections, not counted): ${netNoise.length}\n   ` + [...new Set(netNoise)].slice(0, 6).join('\n   '));
if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.slice(0, 12).join('\n'));
console.log(`mp.relay (${MODE}): ${results.length - bad}/${results.length} checks passed, ${errors.length} console errors`);
process.exit(bad || errors.length ? 1 : 0);
