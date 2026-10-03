// tests/playwright3d.pvp.mjs -- PvP 2 against 2 over the REAL network path: one Chromium instance per
// player against the public MQTT brokers. Needs internet; a failure may be the public services'.
//
//   MODE=relayonly (default)   ?net=relay: WebRTC is never tried, everything goes over the brokers
//   MODE=hybrid                WebRTC allowed
//   SECS=40                    length of the measured battle
//
// Flow: Anna opens a PvP game -> the list shows it as PvP and the mode filter finds it -> three
// captains join -> team choice, the host moves, balances and locks the teams -> start -> every page
// sees its own team as allies and the other team as enemies -> SECS of battle while the host checks
// every snapshot it sends: no ship the receiving team has not spotted may be in it -> the host sinks
// both captains of team 2 -> every page shows the winning team and every captain -> back in the room.
// Prints the per-team snapshot bytes and each client's download.
//
// Run:  node server.js 8804   then   URL3D=http://localhost:8804/index-3d.html node tests/playwright3d.pvp.mjs
import { chromium } from 'playwright';
const BASE = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const MODE = process.env.MODE || 'relayonly';
const SECS = Number(process.env.SECS || 40);
const URL = MODE === 'relayonly' ? BASE + (BASE.includes('?') ? '&' : '?') + 'net=relay' : BASE;
const errors = [], netNoise = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const args = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browsers = [];
const mkPage = async (tag, name) => {
   const browser = await chromium.launch({ args });          // one browser process per player
   browsers.push(browser);
   const ctx = await browser.newContext({ viewport: { width: 1024, height: 600 } });
   await ctx.addInitScript(() => { window.__netMeasure = true; });
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
const teams = (page) => page.evaluate(() => Object.fromEntries(window.__mp.lobby.room.players.map(p => [p.name, p.team])));
const sizes = (page) => page.evaluate(() => [window.__mp.lobby.teamSize(1), window.__mp.lobby.teamSize(2)]);
const finish = (code) => (async () => {
   for (const b of browsers) await b.close().catch(() => { });
   const bad = results.filter(r => !r.ok).length;
   if (netNoise.length) console.log(`network noise (refused broker connections, not counted): ${netNoise.length}`);
   if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.slice(0, 12).join('\n'));
   console.log(`pvp (${MODE}): ${results.length - bad}/${results.length} checks passed, ${errors.length} console errors`);
   process.exit(code ?? (bad || errors.length ? 1 : 0));
})();
const NAME = 'PvP-Test ' + Math.random().toString(36).slice(2, 7);
console.log(`mode ${MODE}, battle ${SECS} s, game "${NAME}"`);

// ---- 1. the host opens a PvP game
const A = await mkPage('A', 'Anna');
await A.click('[data-act="main"]');
await A.fill('[data-f="name"]', NAME);
await A.click('[data-seg="mode"] [data-v="pvp"]');
await A.selectOption('[data-f="mission"]', 'standard');
await A.selectOption('[data-f="max"]', '4');
await A.click('.mp-modal [data-ok]');
check('host is in its PvP room', await wait(A, () => !!document.querySelector('.mp-body.room') && window.__mp.lobby.room?.mode === 'pvp', null, 20000),
   await A.evaluate(() => document.querySelector('.mp-sub')?.innerText || ''));
check('room shows the teams', await A.evaluate(() => document.querySelectorAll('[data-team-head]').length === 2 && /PvP/i.test(document.querySelector('.mp-sub').innerText)));

// ---- 2. the list shows the mode, the filter finds it
const B = await mkPage('B', 'Bert');
const listed = (page, on) => wait(page, ([n, on]) => [...document.querySelectorAll('.mp-game')].some(e => e.innerText.includes(n)) === on, [NAME, on], 20000);
check('client sees the game in the list', await listed(B, true));
check('game row says PvP', await B.evaluate((n) => /PvP/.test([...document.querySelectorAll('.mp-game')].find(e => e.innerText.includes(n))?.innerText || ''), NAME));
await B.selectOption('[data-flt="mode"]', 'coop');
check('mode filter "Koop" hides it', await listed(B, false));
await B.selectOption('[data-flt="mode"]', 'pvp');
check('mode filter "PvP" shows it', await listed(B, true));
await B.selectOption('[data-flt="mode"]', '');

// ---- 3. three captains join
const C = await mkPage('C', 'Carla'), D = await mkPage('D', 'Dora');
const clients = [B, C, D], pages = [A, B, C, D];
await Promise.all([C, D].map(p => listed(p, true)));
for (const p of clients) await p.locator('.mp-game', { hasText: NAME }).locator('[data-join]').click();
check('all four in the room', await all(pages, () => !!document.querySelector('.mp-body.room') && window.__mp.lobby.room?.players.length === 4, null, 40000), await teams(A));
check('newcomers fill the smaller team', JSON.stringify(await sizes(A)) === '[2,2]', await teams(A));

// ---- 4. team choice, host moves / balances / locks
let t = await teams(A);
const byName = { Bert: B, Carla: C, Dora: D };
const mover = Object.keys(byName).find(n => t[n] === 1);
const M = byName[mover];
await M.click('[data-join-team="2"]');
check(`${mover} switches to team 2 by itself`, await wait(A, (n) => window.__mp.lobby.room.players.find(p => p.name === n)?.team === 2, mover, 10000), await teams(A));
check('three captains in team 2 now', JSON.stringify(await sizes(A)) === '[1,3]');
await A.click('[data-balance]');
check('host balances the teams', await wait(A, () => window.__mp.lobby.teamSize(1) === 2 && window.__mp.lobby.teamSize(2) === 2, null, 5000), await teams(A));
const moveId = await A.evaluate(() => window.__mp.lobby.room.players.find(p => p.team === 2).id);
await A.click(`[data-move="${moveId}"]`);
check('host moves a captain', await wait(A, () => window.__mp.lobby.teamSize(1) === 3, null, 5000), await teams(A));
await A.click('[data-balance]');
await wait(A, () => window.__mp.lobby.teamSize(1) === 2, null, 5000);
await A.click('[data-lock-teams]');
check('host locks the teams', await all(clients, () => window.__mp.lobby.room.teamsLocked === true && !document.querySelector('[data-join-team]'), null, 10000));
t = await teams(A);
const lockedOne = Object.keys(byName).find(n => t[n] === 1);
await byName[lockedOne].evaluate(() => window.__mp.lobby.chooseTeam(2));
await sleep(2500);
check('locked: a captain cannot change team', (await teams(A))[lockedOne] === 1 && JSON.stringify(await sizes(A)) === '[2,2]', await teams(A));
check('every page shows the same teams', (await Promise.all(pages.map(teams))).every(x => JSON.stringify(x) === JSON.stringify(t)), t);
console.log('   teams ' + JSON.stringify(t));

// ---- 5. host-side spy: every snapshot it sends is checked against what the receiving team may see
await A.evaluate(async () => {
   const codec = await import(new URL('game3d/net/codec.js', location.href).href);
   const lb = window.__mp.lobby, rt = lb.rt, S = codec.makeSnap(), orig = rt.send.bind(rt);
   const spy = window.__spy = { snaps: 0, ids: 0, bad: [], withheld: 0, bytes: { player: 0, enemy: 0 }, count: { player: 0, enemy: 0 }, err: '' };
   rt.send = (ch, data, to) => {
      try {
         const w = lb.session && window.__world?.();
         if (ch === 'snap' && data instanceof Uint8Array && w?.net?.pvp && codec.decodeSnap(new DataView(data.buffer, data.byteOffset, data.byteLength), S)) {
            const hostTeam = lb.me.team, inc = new Set(S.id.subarray(0, S.n));
            for (const id of [].concat(to)) {
               const p = lb.room.players.find(x => x.id === id);
               if (!p) continue;
               const side = p.team === hostTeam ? 'player' : 'enemy';
               spy.snaps++; spy.bytes[side] += data.byteLength; spy.count[side]++;
               for (const s of w.ships) {
                  const vis = codec.visibleTo(s, side);
                  if (inc.has(s.id)) { spy.ids++; if (!vis && spy.bad.length < 20) spy.bad.push([w.tick, p.name, s.id, s.side]); }
                  else if (!vis) spy.withheld++;
               }
            }
         }
      } catch (e) { spy.err = String(e); }
      return orig(ch, data, to);
   };
});

// ---- 6. ready, start
for (const p of clients) await p.click('[data-act="main"]');
check('host may start', await wait(A, () => !document.querySelector('[data-act="main"]').disabled, null, 15000));
await A.click('[data-act="main"]');
check('all four in the battle, clients synced', await all(pages, () => window.__phase() === 'playing' && !!window.__world()?.player && (window.__mp.lobby.isHost || window.__net()?.synced), null, 40000));
const battleStart = Date.now();
const ids = Object.fromEntries(await Promise.all(pages.map(async (p, i) => [['Anna', 'Bert', 'Carla', 'Dora'][i], await p.evaluate(() => window.__world().player.id)])));
const view = (page) => page.evaluate((ids) => {
   const w = window.__world(), side = {};
   for (const [n, id] of Object.entries(ids)) side[n] = w.ships.find(s => s.id === id)?.side || '?';
   return { side, allies: w.ships.filter(s => s.side === 'player').length, enemies: w.ships.filter(s => s.side !== 'player').length,
      hidden: w.ships.filter(s => s.side !== 'player' && s.alive && !s.spotted).length };
}, ids);
const views = await Promise.all(pages.map(view));
const sidesOk = views.every((v, i) => {
   const myTeam = t[['Anna', 'Bert', 'Carla', 'Dora'][i]] ?? 1;
   return Object.entries(v.side).every(([n, sd]) => sd === (t[n] === myTeam ? 'player' : 'enemy'));
});
check('every page: own team allied, other team hostile', sidesOk, views.map(v => v.side));
check('fleets are even on every page', views.every(v => v.allies === v.enemies), views.map(v => [v.allies, v.enemies]));
check('clients start with unspotted enemies hidden', views.slice(1).every(v => v.hidden > 0), views.map(v => v.hidden));

// ---- 7. play: every client steers a little; download sampled
const net0 = await Promise.all(clients.map(p => p.evaluate(() => { const n = window.__net(); return { kB: n.bytesIn / 1000, secs: n.seconds }; })));
const up0 = await A.evaluate(() => { const n = window.__net(); return { kB: n.bytesOut / 1000, secs: n.seconds }; });
for (const p of clients) { await p.mouse.move(512, 300); for (let i = 0; i < 3; i++) { await p.keyboard.press('w'); await sleep(50); } }
let turn = 0, spotted = false;
while (Date.now() - battleStart < SECS * 1000) {
   const key = turn++ % 2 ? 'a' : 'd';
   await Promise.all(clients.map(async p => { await p.keyboard.down(key); await sleep(600); await p.keyboard.up(key); }));
   await sleep(4000);
   if (!spotted) spotted = (await Promise.all(clients.map(p => p.evaluate(() => window.__world().ships.some(s => s.side !== 'player' && s.alive && s.spotted))))).some(Boolean);
}
const net1 = await Promise.all(clients.map(p => p.evaluate(() => { const n = window.__net(); return { kB: n.bytesIn / 1000, secs: n.seconds, snaps: n.snapsIn }; })));
const up1 = await A.evaluate(() => { const n = window.__net(); return { kB: n.bytesOut / 1000, secs: n.seconds }; });
const spy = await A.evaluate(() => window.__spy);
check('host checked the snapshots it sent', spy.snaps > SECS * 20 && !spy.err, { snaps: spy.snaps, err: spy.err });
check('no snapshot carries a ship its team has not spotted', spy.bad.length === 0, spy.bad.slice(0, 5));
check('unspotted ships were withheld', spy.withheld > 0, { withheld: spy.withheld, included: spy.ids });
console.log('   some enemy was spotted during the battle: ' + spotted);
const m = {
   seconds: Math.round((Date.now() - battleStart) / 1000),
   downKBps: clients.map((p, i) => +((net1[i].kB - net0[i].kB) / (net1[i].secs - net0[i].secs)).toFixed(1)),
   hostUpKBps: +((up1.kB - up0.kB) / (up1.secs - up0.secs)).toFixed(1),
   snapBytesAvg: { hostTeam: Math.round(spy.bytes.player / Math.max(1, spy.count.player)), otherTeam: Math.round(spy.bytes.enemy / Math.max(1, spy.count.enemy)) },
   shipsPerSnapAvg: +(spy.ids / Math.max(1, spy.snaps)).toFixed(1),
};
console.log('MEASURED ' + JSON.stringify(m));
check('battle still running on every page', (await Promise.all(pages.map(p => p.evaluate(() => window.__phase())))).every(x => x === 'playing'));

// ---- 8. the host sinks both captains of team 2: team 1 wins
const hostTeam = t.Anna;
const loserTeam = 3 - hostTeam;
await A.evaluate(() => { const w = window.__world(); for (const h of w.net.humans) if (h.side === 'enemy') h.takeDamage(1e9, w.player, 'pen'); });
const shown = () => { const b = document.querySelector('.m3r-btn[data-act="port"]'); return !!b && b.offsetParent !== null; };
check('every page shows the results', await all(pages, shown, null, 30000));
const res = await Promise.all(pages.map(p => p.evaluate(() => ({ win: document.querySelector('[data-pvp-win]')?.dataset.pvpWin, rows: document.querySelectorAll('[data-pvp] tr').length - 1,
   cls: document.querySelector('.m3r')?.className || '', xp: window.__world()?.result?.xp || 0, my: window.__world()?.result?.pvp?.my }))));
check('every page names the winning team', res.every(r => Number(r.win) === hostTeam), res.map(r => r.win));
check('every page lists all four captains', res.every(r => r.rows === 4), res.map(r => r.rows));
check('winners see SIEG, losers NIEDERLAGE', res.every((r, i) => (t[['Anna', 'Bert', 'Carla', 'Dora'][i]] === loserTeam) === /lose/.test(r.cls)), res.map(r => r.cls));
check('losers earn rewards too', res.every(r => r.xp > 0), res.map(r => r.xp));
for (const p of pages) await p.click('.m3r-btn[data-act="port"]');
check('everybody back in the room', await all(pages, () => !document.querySelector('.mp').classList.contains('hidden') && document.querySelectorAll('.mp-player').length === 4, null, 20000));
await A.click('[data-act="back"]');
await sleep(500);
await finish();
