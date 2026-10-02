// tests/playwright3d.lobby.live.mjs -- manual live test of the multiplayer lobby over the real
// internet signalling (public Nostr relays + WebRTC): two separate browser contexts create, list,
// join (wrong / right password), chat, start a match and exchange data. Prints timings.
// Needs internet. Both browsers run on this machine, so this does NOT prove NAT traversal
// between two different networks. Console errors from unreachable relays are listed, not fatal.
//
// Run:  node server.js 8792   then   URL3D=http://localhost:8792/index-3d.html node tests/playwright3d.lobby.live.mjs
import { chromium } from 'playwright';

const URL = process.env.URL3D || 'http://localhost:8792/index-3d.html';
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const mkPage = async (tag, name) => {
   const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 } });
   const page = await ctx.newPage();
   page.on('console', m => { if (m.type() === 'error') errors.push(`[${tag}] ${m.text().slice(0, 160)}`); });
   page.on('pageerror', e => errors.push(`[${tag}] PAGEERROR: ${e.message}`));
   page.ws = [];
   page.on('websocket', w => page.ws.push(w.url()));
   await page.goto(URL);
   await page.waitForSelector('.m3-card');
   await page.evaluate(() => { window.__startNetGame = (s) => { window.__sess = s; window.__got = []; s.transport.on('cmd', (d, from) => window.__got.push([d, from, performance.now()])); }; });
   check(`${tag}: no websocket before the multiplayer screen`, page.ws.length === 0, page.ws);
   const t0 = Date.now();
   await page.click('[data-act="mp"]');
   await page.waitForSelector('[data-f="pname"]');
   await page.fill('[data-f="pname"]', name);
   await page.click('.mp-modal [data-ok]');
   const ok = await page.waitForFunction(() => window.__mp.lobby?.lt && window.__mp.lobby.status().open > 0, null, { timeout: 20000 }).then(() => true, () => false);
   check(`${tag}: signalling relays connected`, ok, `${Date.now() - t0} ms, ${JSON.stringify(await page.evaluate(() => window.__mp.lobby?.status()))}`);
   return page;
};
const wait = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const modalText = (page) => page.evaluate(() => document.querySelector('.mp-modal')?.textContent.replace(/\s+/g, ' ') || '');

const A = await mkPage('A', 'Anna');
await A.click('[data-act="main"]');
await A.fill('[data-f="name"]', 'Live-Test ' + Math.random().toString(36).slice(2, 7));
await A.selectOption('[data-f="mission"]', 'standard');
await A.fill('[data-f="password"]', 'geheim');
await A.click('.mp-modal [data-ok]');
check('A: game created', await wait(A, () => !!document.querySelector('.mp-body.room')));
const gameName = await A.evaluate(() => window.__mp.lobby.room.name);

let t = Date.now();
const B = await mkPage('B', 'Bert');
const seen = await wait(B, (n) => [...document.querySelectorAll('.mp-game .n')].some(e => e.textContent === n), gameName);
check('B: game discovered in the list', seen, `${Date.now() - t} ms after opening the multiplayer screen (includes name prompt and relay connect)`);
console.log('   list as B sees it:', JSON.stringify(await B.evaluate(() => window.__mp.lobby.list().map(g => [g.name, g.host, g.mission, g.players + '/' + g.max, g.locked, g.state]))));
const joinBtn = `.mp-game:has(.n:text-is("${gameName}")) [data-join]`;

t = Date.now();
await B.click(joinBtn);
await B.fill('[data-f="joinpw"]', 'falsch');
await B.click('.mp-modal [data-ok]');
check('B: wrong password rejected with a message', await wait(B, () => document.querySelector('.mp-modal .err')?.textContent.includes('Falsches Passwort')), `${Date.now() - t} ms; ${await modalText(B)}`);
check('B: not in the room', await B.evaluate(() => !window.__mp.lobby.room) && await A.evaluate(() => window.__mp.lobby.room.players.length === 1));

t = Date.now();
await B.fill('[data-f="joinpw"]', 'geheim');
await B.click('.mp-modal [data-ok]');
const joined = await wait(B, () => !!document.querySelector('.mp-body.room'));
check('B: joined with the right password', joined, joined ? `${Date.now() - t} ms from click to room` : await modalText(B));
check('A: sees two players', await wait(A, () => document.querySelectorAll('.mp-player').length === 2));

t = Date.now();
await B.fill('[data-chat]', 'Hallo ueber das Internet');
await B.press('[data-chat]', 'Enter');
check('chat B -> A', await wait(A, () => [...document.querySelectorAll('.mp-chat-line')].some(e => e.textContent.includes('Hallo ueber das Internet'))), `${Date.now() - t} ms`);
t = Date.now();
await A.fill('[data-chat]', 'Antwort vom Host');
await A.click('[data-send]');
check('chat A -> B', await wait(B, () => [...document.querySelectorAll('.mp-chat-line')].some(e => e.textContent.includes('Antwort vom Host'))), `${Date.now() - t} ms`);

await B.click('[data-act="main"]');
await wait(A, () => !document.querySelector('[data-act="main"]').disabled);
await A.click('[data-act="main"]');
check('both got a session', await wait(A, () => !!window.__sess) && await wait(B, () => !!window.__sess));
const sum = (page) => page.evaluate(() => { const s = window.__sess; return { mode: s.mode, mission: s.mission, difficulty: s.difficulty, seed: s.seed, players: s.players, hostId: s.transport.hostId }; });
const sa = await sum(A), sb = await sum(B);
check('identical session on both sides', JSON.stringify(sa) === JSON.stringify(sb), sa);
// binary + JSON over the game channel, 30 round trips for a latency figure
await A.evaluate(() => { const tr = window.__sess.transport; tr.on('cmd', (d, from) => { window.__got.push([d, from]); if (d && d.ping !== undefined) tr.send('cmd', { pong: d.ping }, from); }); });
const rtt2 = await B.evaluate(async () => {
   const tr = window.__sess.transport, out = [];
   for (let i = 0; i < 30; i++) {
      const n = window.__got.length, t0 = performance.now();
      tr.send('cmd', { ping: i }, tr.hostId);
      const lim = t0 + 5000;
      while (window.__got.length === n && performance.now() < lim) await new Promise(r => setTimeout(r, 0));
      out.push(performance.now() - t0);
   }
   return out.sort((a, b) => a - b).map(x => Math.round(x * 10) / 10);
});
check('game channel round trips', rtt2.length === 30 && rtt2[29] < 5000, `median ${rtt2[15]} ms, max ${rtt2[29]} ms (same machine)`);
await B.evaluate(() => { window.__snap = null; window.__sess.transport.on('snap', (d) => { window.__snap = d; }); });
await A.evaluate(() => window.__sess.transport.send('snap', new Uint8Array(20000).map((_, i) => i % 251)));
check('20 kB binary snapshot arrives intact', await wait(B, () => window.__snap && window.__snap.byteLength === 20000 && new Uint8Array(window.__snap.buffer || window.__snap, window.__snap.byteOffset || 0, 20000).every((v, i) => v === i % 251), null, 8000), await B.evaluate(() => window.__snap && [window.__snap.constructor.name, window.__snap.byteLength]));

await A.evaluate(() => window.__sess.onEnd({ aborted: false, reason: '', victory: true }));
await B.evaluate(() => window.__sess.onEnd({ aborted: false, reason: '', victory: true }));
check('back in the room after the match', await wait(A, () => !!document.querySelector('.mp:not(.hidden) .mp-body.room')) && await wait(B, () => !!document.querySelector('.mp:not(.hidden) .mp-body.room')));

// B leaves the room and must find the game again in the lobby (re-joining the lobby room)
t = Date.now();
await B.click('[data-act="back"]');
check('B: back in the list, game visible again', await wait(B, (n) => [...document.querySelectorAll('.mp-game .n')].some(e => e.textContent === n), gameName), `${Date.now() - t} ms`);
check('A: player list back to one', await wait(A, () => document.querySelectorAll('.mp-player').length === 1), `${Date.now() - t} ms`);
t = Date.now();
await B.click(joinBtn);
await B.fill('[data-f="joinpw"]', 'geheim');
await B.click('.mp-modal [data-ok]');
const again = await wait(B, () => !!document.querySelector('.mp-body.room'));
check('B: joins a second time', again, again ? `${Date.now() - t} ms` : await modalText(B));
// host closes the game: client is told, listing disappears
t = Date.now();
await A.click('[data-act="back"]');
check('B: told that the host closed the game', await wait(B, () => document.querySelector('.mp-modal')?.textContent.includes('Host')), `${Date.now() - t} ms; ${await modalText(B)}`);
await B.click('.mp-modal [data-ok]').catch(() => { });
check('B: listing withdrawn', await wait(B, (n) => ![...document.querySelectorAll('.mp-game .n')].some(e => e.textContent === n), gameName), `${Date.now() - t} ms`);
console.log('   relay sockets opened by A:', A.ws.length, ' by B:', B.ws.length);

await browser.close();
const failed = results.filter(x => !x.ok).length;
console.log(`lobby live: ${results.length - failed}/${results.length} checks passed, ${errors.length} console errors`);
for (const e of [...new Set(errors)]) console.log('  ERROR ' + e);
process.exit(failed ? 1 : 0);
