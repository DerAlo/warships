// tests/playwright3d.net.mjs -- browser test of the co-op netcode: two pages of one browser
// context (host + client) talk over the BroadcastChannel transport and start a match through
// window.__startNetGame. The client steers and fires, the host sees it; pause / photo mode do not
// stop the battle; both get a results screen and hand back to the lobby (session.onEnd); in a
// second match the host leaves and the client is told. Screenshot to tests/shots/.
// Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8791   then   URL3D=http://localhost:8791/index-3d.html node tests/playwright3d.net.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:8791/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};

const gpu = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
// both pages must keep their animation frames although only one is in front
const browser = await chromium.launch({ args: [...gpu, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
const mk = async (tag) => {
   const page = await ctx.newPage();
   page.on('console', m => { if (m.type() === 'error') errors.push(tag + ': ' + m.text()); });
   page.on('pageerror', e => errors.push(tag + ' PAGEERROR: ' + e.message));
   await page.goto(URL, { waitUntil: 'load' });
   return page;
};
const host = await mk('host'), client = await mk('client');
const wait = ms => host.waitForTimeout(ms);
async function waitFor(page, fn, timeout = 10000, step = 50, arg) {
   const t0 = Date.now();
   while (Date.now() - t0 < timeout) { if (await page.evaluate(fn, arg)) return true; await wait(step); }
   return false;
}
await wait(800);

const PLAYERS = [{ id: 'host', name: 'Kapitän Host', ship: 'Bismarck' }, { id: 'gast', name: 'Kapitän Gast', ship: 'Hipper' }];
const begin = (page, id, room) => page.evaluate(async ({ id, room, players }) => {
   const { makeLocalTransport } = await import('./game3d/net/transport.js');
   window.__netMeasure = true;
   window.__ended = [];
   window.__tp = makeLocalTransport(room, id, 'host');
   await new Promise(r => setTimeout(r, 300));
   window.__startNetGame({ transport: window.__tp, mode: 'coop', mission: 'standard', difficulty: 'normal', seed: 4711, players, onEnd: (r) => window.__ended.push(r) });
}, { id, room, players: PLAYERS });
// the remote captain's ship as the host has it / the own ship as the client shows it
const hostView = () => host.evaluate(() => {
   const w = window.__world(), s = w.net.humans[1];
   return { id: s.id, cls: s.cls, human: s.human, telegraph: s.telegraph, rudder: s.rudderCmd, kn: s.speedKn, x: s.pos.x, y: s.pos.y, hdg: s.heading,
      shots: s.stats.shotsFired, shells: w.shells.filter(q => q.ownerId === s.id).length, tick: w.tick, ships: w.ships.length, ownShots: w.stats.shotsFired, phase: w.phase };
});
const clientView = () => client.evaluate(() => {
   const w = window.__world(), s = w.player;
   return { id: s.id, cls: s.cls, telegraph: s.telegraph, rudder: s.rudderCmd, kn: s.speedKn, x: s.pos.x, y: s.pos.y, hdg: s.heading,
      shells: w.shells.filter(q => q.ownerId === s.id).length, tick: w.tick, ships: w.ships.length, phase: w.phase, timeLeft: w.timeLeft };
});

// ---- 1. start
await Promise.all([begin(host, 'host', 'pw1'), begin(client, 'gast', 'pw1')]);
check('host is playing', await waitFor(host, () => window.__phase() === 'playing', 15000));
check('client is playing', await waitFor(client, () => window.__phase() === 'playing', 15000));
await client.bringToFront();
await client.mouse.move(640, 360);
await waitFor(client, () => window.__net()?.synced, 5000);
let hv = await hostView(), cv = await clientView();
check('client has its own ship', cv.cls === 'Hipper' && cv.id === hv.id && hv.human === true, { client: cv.cls, id: cv.id, hostSide: hv.cls });
check('same roster on both', cv.ships === hv.ships && hv.ships >= 14, { ships: hv.ships });

// ---- 2. the client steers; the host's ship follows
const tele0 = hv.telegraph, hdg0 = hv.hdg;
for (let i = 0; i < 4; i++) { await client.keyboard.press('w'); await wait(60); }
await client.keyboard.down('d'); await wait(900); await client.keyboard.up('d');
const ctl = await client.evaluate(() => window.__ctl());
check('client controls respond at once', ctl.telegraph === 4 && ctl.rudder > 0, { telegraph: ctl.telegraph, rudder: ctl.rudder });
check('host applies the command', await waitFor(host, (c) => { const s = window.__world().net.humans[1]; return s.telegraph === c.telegraph && s.rudderCmd === c.rudder; }, 3000, 50, ctl), { was: tele0 });
await wait(6000);
hv = await hostView(); cv = await clientView();
check('ship under way and turning on the host', hv.kn > 5 && Math.abs(hv.hdg - hdg0) > 0.05, { kn: +hv.kn.toFixed(1), turned: +(hv.hdg - hdg0).toFixed(2) });
check('client shows the same motion', Math.abs(cv.kn - hv.kn) < 3 && Math.hypot(cv.x - hv.x, cv.y - hv.y) < 40, { kn: +cv.kn.toFixed(1), off: +Math.hypot(cv.x - hv.x, cv.y - hv.y).toFixed(1) });
check('AI left the ship alone', hv.telegraph === 4 && hv.rudder === ctl.rudder);
check('timer runs on the client', cv.timeLeft == null || cv.timeLeft > 0, { timeLeft: cv.timeLeft });

// ---- 3. the client fires; the host fires that ship's guns
for (let i = 0; i < 6 && (await client.evaluate(() => window.__ctl().rudder)) !== 0; i++) { await client.keyboard.press('a'); await wait(80); }
const shots0 = hv.shots;
let fired = { salvos: 0 };
for (let i = 0; i < 5 && !fired.salvos; i++) {
   await client.evaluate(() => window.__setAim(1.3, 9000));
   const rdy = await waitFor(client, () => { const t = window.__turrets(); return t.length > 0 && t.filter(x => x.state === 'ready').length >= Math.ceil(t.length / 2); }, 20000, 100);
   if (!rdy) console.log('   turrets: ' + JSON.stringify(await client.evaluate(() => window.__turrets())));
   await client.mouse.down(); await wait(80); await client.mouse.up();
   await wait(150);
   fired = await client.evaluate(() => window.__fired());
}
cv = await clientView();
check('client fired (predicted)', fired.salvos > 0 && cv.shells > 0, { fired, shells: cv.shells });
await wait(700);
hv = await hostView(); cv = await clientView();
check('host fired the client ship\'s guns', hv.shots > shots0 && hv.shells > 0, { shots: hv.shots, shells: hv.shells });
check('shell counts agree', cv.shells === hv.shells, { client: cv.shells, host: hv.shells });
check('host statistics stay separate', hv.ownShots === 0);
await client.screenshot({ path: OUT + '/net-client.png' });

// ---- 4. pause (client) and photo mode (host) do not stop the battle
await client.keyboard.press('p');
await waitFor(client, () => window.__phase() === 'paused', 2000);
const ct0 = (await clientView()).tick;
await wait(1000);
cv = await clientView();
check('client pause menu: battle goes on', (await client.evaluate(() => window.__phase())) === 'paused' && cv.tick - ct0 > 40, { ticks: cv.tick - ct0 });
await client.keyboard.press('p');
check('client resumes', await waitFor(client, () => window.__phase() === 'playing', 2000));
await host.bringToFront();
await host.keyboard.press('o');
await waitFor(host, () => window.__phase() === 'photo', 2000);
const ht0 = (await hostView()).tick;
await wait(1000);
hv = await hostView();
check('host photo mode: simulation goes on', (await host.evaluate(() => window.__photo().on)) && hv.tick - ht0 > 40, { ticks: hv.tick - ht0 });
await host.keyboard.press('o');
check('host leaves photo mode', await waitFor(host, () => window.__phase() === 'playing', 2000));

// ---- 5. traffic
await client.evaluate(() => window.__net());
const n0 = await client.evaluate(() => window.__net());
await wait(5000);
const n1 = await client.evaluate(() => window.__net());
const kBps = (n1.bytesIn - n0.bytesIn) / (n1.seconds - n0.seconds) / 1000, hz = (n1.snapsIn - n0.snapsIn) / (n1.seconds - n0.seconds);
check('traffic inside the budget', kBps > 1 && kBps < 30 && hz > 15 && hz < 25, { kBpsDown: +kBps.toFixed(1), snapshotsPerS: +hz.toFixed(1), renderDelayMs: Math.round(n1.delay * 1000), rttMs: Math.round(n1.rtt * 1000) });

// ---- 6. the match ends: both get their results and go back to the lobby
await host.evaluate(() => window.__world().end(true, 'Testende'));
check('host results screen', await waitFor(host, () => window.__phase() === 'ended', 8000));
check('client results screen', await waitFor(client, () => window.__phase() === 'ended', 8000));
const res = await client.evaluate(() => {
   const w = window.__world(), el = document.getElementById('end');
   return { victory: w.result.victory, reason: w.result.reason, lines: w.result.rewards?.lines?.length || 0, shown: !el.classList.contains('hidden'),
      title: el.querySelector('.m3r-title')?.textContent, buttons: [...el.querySelectorAll('.m3r-btn')].map(b => b.textContent.trim()) };
});
check('client result is the host\'s', res.victory === true && res.reason === 'Testende' && res.shown && res.title === 'SIEG', res);
check('results offer only the way back to the lobby', res.buttons.length === 1 && res.buttons[0] === 'ZUR LOBBY', res.buttons);
await client.bringToFront();
await client.click('#end [data-act="port"]');
await host.bringToFront();
await host.click('#end [data-act="port"]');
await wait(300);
const ce = await client.evaluate(() => window.__ended), he = await host.evaluate(() => window.__ended);
check('session.onEnd once on each side', ce.length === 1 && he.length === 1 && ce[0].aborted === false && ce[0].victory === true && he[0].victory === true, { client: ce, host: he });
check('back in the menu', (await client.evaluate(() => window.__phase())) === 'menu' && (await host.evaluate(() => window.__phase())) === 'menu');

// ---- 7. second match on the same transports... the host leaves in the middle: since host migration
// (CONTRACT.md) the client takes the match over instead of being sent back to the menu
await Promise.all([begin(host, 'host', 'pw2'), begin(client, 'gast', 'pw2')]);
check('second match starts', await waitFor(host, () => window.__phase() === 'playing', 15000) && await waitFor(client, () => window.__phase() === 'playing', 15000));
await waitFor(client, () => window.__net()?.synced, 5000);
await wait(1500);
await host.evaluate(() => document.getElementById('btn-quit').click());
check('client takes the match over as host', await waitFor(client, () => window.__phase() === 'playing' && window.__net()?.isHost === true, 10000));
const note = await client.evaluate(() => document.querySelector('.net-notice')?.textContent || '');
check('client is told in German', /Gastgeber gewechselt/.test(note), note);
const ce2 = await client.evaluate(() => window.__ended), he2 = await host.evaluate(() => window.__ended);
check('host session ended as a handover, client plays on', ce2.length === 0 && he2.length === 1 && he2[0].aborted === true && he2[0].handover === true, { client: ce2, host: he2 });
await client.evaluate(() => document.getElementById('btn-quit').click());
check('client leaves to the menu', await waitFor(client, () => window.__phase() === 'menu', 5000));

// ---- 8. singleplayer still starts after a net game
await host.evaluate(() => window.__start({ difficulty: 'normal', mission: 'training', ship: 'Hipper' }));
check('singleplayer after a net game', await waitFor(host, () => window.__phase() === 'playing' && window.__net() === null, 5000));
await wait(500);

check('no console errors', errors.length === 0, errors.slice(0, 5));
await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
