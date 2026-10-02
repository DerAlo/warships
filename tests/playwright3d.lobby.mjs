// tests/playwright3d.lobby.mjs -- browser test of the multiplayer lobby with the BroadcastChannel
// test transport (?net=local, no internet): three pages of one browser context create, list,
// filter, join (wrong / right password), pick ships, chat, start and end a match, kick.
// Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8792   then   URL3D=http://localhost:8792/index-3d.html node tests/playwright3d.lobby.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.URL3D || 'http://localhost:8792/index-3d.html';
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
const NETFILE = /mpui\.js|net\/lobby\.js|net\/transport|trystero/;
const mkPage = async (tag, vw, vh) => {
   const page = await ctx.newPage();
   await page.setViewportSize({ width: vw, height: vh });
   page.on('console', m => { if (m.type() === 'error') errors.push(`[${tag}] ${m.text()}`); });
   page.on('pageerror', e => errors.push(`[${tag}] PAGEERROR: ${e.message}`));
   page.netReq = []; page.extReq = [];
   page.on('request', r => { const u = r.url(); if (NETFILE.test(u)) page.netReq.push(u); if (!u.startsWith(new globalThis.URL(BASE).origin) && !u.startsWith('data:') && !u.startsWith('blob:')) page.extReq.push(u); });
   await page.goto(URL);
   await page.waitForSelector('.m3-card');
   // the stand-in game: keeps the session until the test ends it
   await page.evaluate(() => { window.__startNetGame = (s) => { window.__sess = s; window.__got = []; s.transport.on('cmd', (d, from) => window.__got.push([d, from])); }; });
   return page;
};
const openMp = async (page) => { await page.click('[data-act="mp"]'); await page.waitForSelector('.mp:not(.hidden)'); };
const fits = (page) => page.evaluate(() => {
   const de = document.documentElement, bad = [];
   for (const el of document.querySelectorAll('.mp-top, .mp-body > *, .mp-modal .box')) { const r = el.getBoundingClientRect(); if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1) bad.push(el.className); }
   return { scroll: de.scrollHeight > innerHeight + 1 || de.scrollWidth > innerWidth + 1, bad };
});
const rows = (page) => page.evaluate(() => [...document.querySelectorAll('.mp-game')].map(e => ({ name: e.querySelector('.n').textContent, st: e.querySelector('.st').textContent, off: e.querySelector('[data-join]').disabled, text: e.textContent })));
const players = (page) => page.evaluate(() => [...document.querySelectorAll('.mp-player')].map(e => ({ n: e.querySelector('.n').textContent, r: e.querySelector('.r').textContent, s: e.querySelector('.s').textContent })));
const modalText = (page) => page.evaluate(() => document.querySelector('.mp-modal')?.textContent || '');
const wait = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);

// ---- nothing network-related before the screen is opened
const A = await mkPage('A', 1440, 810);
check('port: MEHRSPIELER button', await A.locator('[data-act="mp"]').count() === 1);
// the game's own netcode (net/game.js, transport.js, ...) is plain local code; the lobby, the WebRTC transport and the vendored library must stay unloaded
const early = A.netReq.filter(u => /mpui|lobby|trystero|transport_rtc/.test(u));
check('port: no lobby / signalling module loaded before opening', early.length === 0 && A.extReq.length === 0, { early, ext: A.extReq });
await openMp(A);
check('name prompt on first open', (await modalText(A)).includes('SPIELERNAME'));
await A.fill('[data-f="pname"]', 'Anna');
await A.click('.mp-modal [data-ok]');
check('name stored', await A.evaluate(() => localStorage.getItem('warships3d.net.name')) === 'Anna');
check('local mode: no trystero / rtc module', !A.netReq.some(u => /trystero|transport_rtc/.test(u)), A.netReq);
check('A list fits 1440x810', await fits(A).then(f => !f.scroll && !f.bad.length), await fits(A));
check('empty list message', await A.evaluate(() => document.querySelector('.mp-empty')?.textContent.includes('keine Spiele')));

// ---- create a password-protected game
await A.click('[data-act="main"]');
await A.waitForSelector('[data-f="mission"]');
const cr = await A.evaluate(() => ({
   missions: [...document.querySelectorAll('[data-f="mission"] option')].map(o => o.value),
   pvp: (() => { const b = document.querySelector('[data-seg="mode"] [data-v="pvp"]'); return { dis: b.disabled, text: b.textContent }; })(),
   max: [...document.querySelectorAll('[data-f="max"] option')].map(o => o.textContent),
}));
check('create: only co-op missions', cr.missions.length >= 5 && !cr.missions.includes('bismarck'), cr.missions);
check('create: PvP disabled "bald verfügbar"', cr.pvp.dis && cr.pvp.text.includes('bald verfügbar'), cr.pvp);
check('create: max players 1..4', cr.max.join() === '1,2,3,4', cr.max);
check('create dialog fits', await fits(A).then(f => !f.bad.length), await fits(A));
await A.screenshot({ path: `${OUT}/lobby_create.png` });
await A.fill('[data-f="name"]', 'Testspiel Alpha');
await A.selectOption('[data-f="mission"]', 'convoy');
await A.selectOption('[data-f="max"]', '2');
await A.fill('[data-f="password"]', 'geheim');
await A.click('.mp-modal [data-ok]');
check('A is in the room', await wait(A, () => !!document.querySelector('.mp-body.room')));
check('A room fits 1440x810', await fits(A).then(f => !f.scroll && !f.bad.length), await fits(A));
check('A is host with a ship', await players(A).then(p => p.length === 1 && p[0].r === 'HOST' && !p[0].s.includes('kein Schiff')), await players(A));

// ---- second page sees it; filters
const B = await mkPage('B', 1920, 1080);
await openMp(B);
check('B has no name prompt (name known)', !(await modalText(B)).includes('SPIELERNAME'));
await B.click('[data-act="name"]');
await B.fill('[data-f="pname"]', 'Bert');
await B.click('.mp-modal [data-ok]');
check('B sees the game', await wait(B, () => document.querySelectorAll('.mp-game').length === 1));
let r = await rows(B);
check('listing: name, lock, host, mission, 1/2, open', r[0] && r[0].name === 'Testspiel Alpha' && r[0].text.includes('Anna') && r[0].text.includes('1/2') && r[0].st === 'OFFEN' && !r[0].off, r);
check('listing shows the lock', await B.evaluate(() => !!document.querySelector('.mp-game .n svg')));
check('B list fits 1920x1080', await fits(B).then(f => !f.scroll && !f.bad.length), await fits(B));
await B.screenshot({ path: `${OUT}/lobby_list.png` });
const count = () => B.evaluate(() => document.querySelectorAll('.mp-game').length);
await B.fill('[data-flt="q"]', 'gibtsnicht'); check('filter: search without match hides', await count() === 0);
await B.fill('[data-flt="q"]', 'alpha'); check('filter: search by name', await count() === 1);
await B.fill('[data-flt="q"]', 'anna'); check('filter: search by host', await count() === 1);
await B.fill('[data-flt="q"]', '');
await B.selectOption('[data-flt="mode"]', 'pvp'); check('filter: mode pvp hides', await count() === 0);
await B.selectOption('[data-flt="mode"]', 'coop'); check('filter: mode coop shows', await count() === 1);
await B.selectOption('[data-flt="mode"]', '');
await B.selectOption('[data-flt="mission"]', 'standard'); check('filter: other mission hides', await count() === 0);
await B.selectOption('[data-flt="mission"]', 'convoy'); check('filter: mission shows', await count() === 1);
await B.selectOption('[data-flt="mission"]', '');
await B.check('[data-flt="hideLocked"]'); check('filter: hide password-protected', await count() === 0);
await B.uncheck('[data-flt="hideLocked"]');
await B.check('[data-flt="hideFull"]'); await B.check('[data-flt="hideRunning"]'); check('filter: open game passes hide full / running', await count() === 1);
await B.uncheck('[data-flt="hideFull"]'); await B.uncheck('[data-flt="hideRunning"]');
// an entry of another protocol version is listed but cannot be joined
await B.evaluate(() => { const lb = window.__mp.lobby; lb.games.set('x', { entry: { id: 'x', hostId: 'x', name: 'Altes Spiel', host: 'Zeno', mode: 'coop', mission: 'standard', difficulty: 'normal', players: 1, max: 4, locked: false, state: 'lobby', v: 99 }, seen: Date.now() }); lb.cb.onList(); });
r = await rows(B);
check('other NET_VERSION: shown incompatible, not joinable', r.length === 2 && r[0].name === 'Altes Spiel' && r[0].st === 'INKOMPATIBEL' && r[0].off, r);
await B.evaluate(() => { const lb = window.__mp.lobby; lb.games.delete('x'); lb.cb.onList(); });

// ---- wrong password, then the right one
await B.click('.mp-game [data-join]');
await B.fill('[data-f="joinpw"]', 'falsch');
await B.click('.mp-modal [data-ok]');
check('wrong password: clear message', await wait(B, () => document.querySelector('.mp-modal .err')?.textContent.includes('Falsches Passwort')), await modalText(B));
check('wrong password: not in the room', await B.evaluate(() => !window.__mp.lobby.room && !document.querySelector('.mp-body.room')) && (await players(A)).length === 1);
await B.fill('[data-f="joinpw"]', 'geheim');
await B.click('.mp-modal [data-ok]');
check('right password: B is in the room', await wait(B, () => !!document.querySelector('.mp-body.room')));
check('both see two players', await wait(A, () => document.querySelectorAll('.mp-player').length === 2) && await wait(B, () => document.querySelectorAll('.mp-player').length === 2), [await players(A), await players(B)]);
check('names shown', await players(A).then(p => p[0].n.startsWith('Anna') && p[1].n.startsWith('Bert')), await players(A));
check('B room fits 1920x1080', await fits(B).then(f => !f.scroll && !f.bad.length), await fits(B));

// ---- third page: full game
const C = await mkPage('C', 1440, 810);
await openMp(C);
await wait(C, () => document.querySelectorAll('.mp-game').length === 1);
r = await rows(C);
check('C sees the game full and not joinable', r[0] && r[0].text.includes('2/2') && r[0].st === 'VOLL' && r[0].off, r);
await C.check('[data-flt="hideFull"]');
check('filter: hide full', await C.evaluate(() => document.querySelectorAll('.mp-game').length) === 0);
await C.uncheck('[data-flt="hideFull"]');

// ---- ship pick, ready, chat, host settings
check('host cannot start before everyone is ready', await A.evaluate(() => document.querySelector('[data-act="main"]').disabled));
const shipsB = await B.evaluate(() => [...document.querySelectorAll('.mp-ship')].map(e => e.dataset.ship));
const unlockedB = await B.evaluate(async () => { const P = await import('./game3d/progress3d.js'), C = await import('./game3d/config.js'); const p = P.loadProfile(); return C.PLAYABLE.filter(k => P.isUnlocked(p, k)); });
check('ship picker: only own unlocked ships', shipsB.length > 0 && shipsB.every(k => unlockedB.includes(k)), { shipsB, unlockedB });
const pick = shipsB[shipsB.length - 1];
await B.click(`.mp-ship[data-ship="${pick}"]`);
check('ship pick reaches the host', await wait(A, (k) => window.__mp.lobby.room.players[1]?.ship === k, pick) && await wait(B, () => !!document.querySelector('.mp-ship.sel')));
await B.click('[data-act="main"]');
check('ready reaches the host', await wait(A, () => window.__mp.lobby.room.players[1]?.ready === true && !document.querySelector('[data-act="main"]').disabled));
await B.fill('[data-chat]', 'Hallo Anna');
await B.press('[data-chat]', 'Enter');
check('chat B -> A', await wait(A, () => [...document.querySelectorAll('.mp-chat-line')].some(e => e.textContent.includes('Bert:') && e.textContent.includes('Hallo Anna'))));
check('Enter in the chat does not start a battle', await B.evaluate(() => !document.querySelector('.mp').classList.contains('hidden')));
await A.fill('[data-chat]', 'Moin <b>Bert</b>');
await A.click('[data-send]');
check('chat A -> B (escaped)', await wait(B, () => [...document.querySelectorAll('.mp-chat-line')].some(e => e.textContent.includes('Moin <b>Bert</b>'))));
await A.selectOption('[data-cfg="mission"]', 'standard');
check('host changes mission', await wait(B, () => document.querySelector('[data-mission]')?.dataset.mission === 'standard'));
await A.click('.mp [data-diff="hard"]');
check('host changes difficulty', await wait(B, () => window.__mp.lobby.room.difficulty === 'hard'));
check('client has no host controls', await B.evaluate(() => !document.querySelector('[data-cfg]') && !document.querySelector('[data-kick]') && document.querySelector('.mp [data-diff]').disabled));
check('mission change resets ready', await wait(B, () => window.__mp.lobby.me?.ready === false && document.querySelector('[data-act="main"]').textContent === 'BEREIT'));
await B.click('[data-act="main"]');
await wait(B, () => window.__mp.lobby.me?.ready === true);
await A.screenshot({ path: `${OUT}/lobby_room_host.png` });
await B.screenshot({ path: `${OUT}/lobby_room_client.png` });

// ---- start: identical session on both pages
await wait(A, () => !document.querySelector('[data-act="main"]').disabled);
await A.click('[data-act="main"]');
check('both pages got a session', await wait(A, () => !!window.__sess) && await wait(B, () => !!window.__sess));
const sum = (page) => page.evaluate(() => { const s = window.__sess; return { mode: s.mode, mission: s.mission, difficulty: s.difficulty, seed: s.seed, players: s.players, hostId: s.transport.hostId, isHost: s.transport.isHost, selfId: s.transport.selfId, peers: s.transport.peers(), fn: typeof s.onEnd }; });
const sa = await sum(A), sb = await sum(B);
const same = (k) => JSON.stringify(sa[k]) === JSON.stringify(sb[k]);
check('session: same seed, mission, difficulty, mode', same('seed') && same('mission') && same('difficulty') && same('mode') && sa.mission === 'standard' && sa.difficulty === 'hard' && sa.mode === 'coop' && Number.isInteger(sa.seed) && sa.seed >= 0, [sa, sb]);
check('session: same players in the same order, host first', same('players') && sa.players.length === 2 && sa.players[0].id === sa.hostId && sa.players[0].name === 'Anna' && sa.players[1].name === 'Bert' && sa.players[1].ship === pick, sa.players);
check('session: transport roles', sa.isHost && !sb.isHost && same('hostId') && sa.selfId === sa.players[0].id && sb.selfId === sb.players[1].id && sa.peers.join() === sb.selfId && sb.peers.join() === sa.selfId && sa.fn === 'function', [sa, sb]);
check('lobby screen hidden during the match', await A.evaluate(() => document.querySelector('.mp').classList.contains('hidden')) && await B.evaluate(() => document.querySelector('.mp').classList.contains('hidden')));
await A.evaluate(() => window.__sess.transport.send('cmd', { n: 1 }));
await B.evaluate(() => window.__sess.transport.send('cmd', { n: 2 }, window.__sess.transport.hostId));
check('session transport carries game channels both ways', await wait(B, () => window.__got[0]?.[0].n === 1) && await wait(A, () => window.__got[0]?.[0].n === 2));
check('C sees the game running', await wait(C, () => document.querySelector('.mp-game .st')?.textContent === 'LÄUFT' && document.querySelector('.mp-game [data-join]').disabled), await rows(C));
await C.check('[data-flt="hideRunning"]');
check('filter: hide running', await C.evaluate(() => document.querySelectorAll('.mp-game').length) === 0);
await C.uncheck('[data-flt="hideRunning"]');

// ---- end of the match: back in the room
await A.evaluate(() => window.__sess.onEnd({ aborted: false, reason: '', victory: true }));
await B.evaluate(() => window.__sess.onEnd({ aborted: false, reason: '', victory: true }));
check('after onEnd both are back in the room', await wait(A, () => !!document.querySelector('.mp:not(.hidden) .mp-body.room')) && await wait(B, () => !!document.querySelector('.mp:not(.hidden) .mp-body.room')));
check('room is open again, nobody ready', await wait(B, () => window.__mp.lobby.room.state === 'lobby' && !window.__mp.lobby.me.ready) && await wait(C, () => document.querySelector('.mp-game .st')?.textContent === 'VOLL'));

// ---- kick; kicked player cannot come back; game withdrawn when the host leaves
await A.click('[data-kick]');
check('kicked: clear message, back in the list', await wait(B, () => document.querySelector('.mp-modal')?.textContent.includes('aus dem Spiel entfernt') && !!document.querySelector('.mp-body.list')), await modalText(B));
await B.click('.mp-modal [data-ok]');
check('host sees one player again', await wait(A, () => document.querySelectorAll('.mp-player').length === 1));
await wait(B, () => document.querySelectorAll('.mp-game').length === 1);
await B.click('.mp-game [data-join]');
await B.fill('[data-f="joinpw"]', 'geheim');
await B.click('.mp-modal [data-ok]');
check('kicked player cannot rejoin', await wait(B, () => document.querySelector('.mp-modal')?.textContent.includes('entfernt')) && await B.evaluate(() => !window.__mp.lobby.room), await modalText(B));
await B.click('.mp-modal [data-ok]');
await A.click('[data-act="back"]');
check('host leaves: listing disappears', await wait(C, () => document.querySelectorAll('.mp-game').length === 0) && await wait(B, () => document.querySelectorAll('.mp-game').length === 0));
check('host is back in the list', await A.evaluate(() => !!document.querySelector('.mp-body.list')));

// ---- stale entry disappears when a host vanishes without a goodbye
await A.click('[data-act="main"]');
await A.fill('[data-f="name"]', 'Kurzlebig');
await A.click('.mp-modal [data-ok]');
check('open game listed', await wait(C, () => document.querySelector('.mp-game .n')?.textContent === 'Kurzlebig'));
check('open game: no lock, join without password', await C.evaluate(() => !document.querySelector('.mp-game .n svg')));
const t0 = Date.now();
await A.close({ runBeforeUnload: false });
const gone = await C.waitForFunction(() => document.querySelectorAll('.mp-game').length === 0, null, { timeout: 20000 }).then(() => true, () => false);
check('vanished host: entry disappears', gone, `${Date.now() - t0} ms`);
console.log(`stale entry removed after ${Date.now() - t0} ms`);

// ---- back to the port: singleplayer untouched
await C.click('[data-act="back"]');
check('back to the port', await C.evaluate(() => document.querySelector('.mp').classList.contains('hidden') && !document.querySelector('#menu').classList.contains('hidden') && !window.__mp.lobby));
check('no request left the origin', !B.extReq.length && !C.extReq.length, [B.extReq, C.extReq]);

await browser.close();
const failed = results.filter(x => !x.ok).length;
console.log(`lobby: ${results.length - failed}/${results.length} checks passed, ${errors.length} console errors`);
for (const e of errors) console.log('  ERROR ' + e);
process.exit(failed || errors.length ? 1 : 0);
