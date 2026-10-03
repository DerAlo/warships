// tests/playwright3d.mp.carrier.mjs -- aircraft carriers in net games, pages of one browser
// context over BroadcastChannel (?net=local).
//
// Co-op: Bert (client) sails an Essex. He launches torpedo bombers with E and flies them; the host
// and the third captain see the flight. Put on a run at an enemy held still (host side), he holds
// LMB for the attack run and releases: the host drops the torpedoes, every page runs them, the
// enemy takes damage. F recalls the flight. Prints the client's download with planes in the air.
// PvP: two carriers, one per team. A spy on the host checks every snapshot that goes to team 2:
// no flight of team 1 that team 2 has not spotted may be in it; team 2's own flights always are.
// Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8807   then   URL3D=http://localhost:8807/index-3d.html node tests/playwright3d.mp.carrier.mjs
import { chromium } from 'playwright';
const BASE = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const URL = BASE + (BASE.includes('?') ? '&' : '?') + 'net=local';
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript(() => {
   window.__netMeasure = true;
   HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); };
   // the carriers researched (the pages share this profile)
   const K = 'warships3d.profile.v1';
   if (!localStorage.getItem(K)) localStorage.setItem(K, JSON.stringify({ v: 1, xp: 0, totalXp: 50000, credits: 0, battles: 5,
      unlocked: { Essex: true, Enterprise: true, Akagi: true, Shokaku: true, GrafZeppelin: true }, modules: {}, skills: [] }));
});
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
const wait = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 }).then(() => true, () => false);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pickShip = async (page, k) => {
   await page.click(`[data-ship="${k}"]`);
   return wait(page, (k) => window.__mp.lobby.me?.ship === k, k, 5000);
};
const startMatch = async (host, clients) => {
   for (const p of clients) await p.click('[data-act="main"]');
   const may = await wait(host, () => !document.querySelector('[data-act="main"]').disabled, null, 15000);
   await host.click('[data-act="main"]');
   const ok = await Promise.all([host, ...clients].map(p => wait(p, () => window.__phase() === 'playing' && window.__world()?.time > 1, null, 30000)));
   return may && ok.every(Boolean);
};
const key = async (page, k) => { await page.bringToFront(); await page.keyboard.press(k); await sleep(120); };

// ================================================================ co-op
const NAME = 'Träger Koop ' + Math.random().toString(36).slice(2, 6);
const A = await mkPage('A', 'Anna');
await A.click('[data-act="main"]');
await A.fill('[data-f="name"]', NAME);
await A.selectOption('[data-f="mission"]', 'standard');
await A.click('.mp-modal [data-ok]');
const B = await mkPage('B', 'Bert'), C = await mkPage('C', 'Carl');
for (const p of [B, C]) {
   await wait(p, (n) => [...document.querySelectorAll('.mp-game')].some(e => e.innerText.includes(n)), NAME);
   await p.locator('.mp-game', { hasText: NAME }).locator('[data-join]').click();
}
check('three captains in the room', await wait(A, () => window.__mp.lobby.room?.players.length === 3, null, 15000));
check('the room offers carriers; Bert takes an Essex', await pickShip(B, 'Essex'));
check('co-op battle started', await startMatch(A, [B, C]));
const me = await B.evaluate(() => window.__world().player.id);
check('Bert commands a carrier', await B.evaluate(() => !!window.__world().player.air && !document.getElementById('air-panel').classList.contains('hidden')));
check('the host runs no AI for it', await A.evaluate((id) => { const s = window.__world().shipById(id); return !!s.human || !window.__world().bots.includes(s); }, me));

// ---- launch: the order goes to the host, the flight shows up, Bert takes it
await B.mouse.move(640, 360);
await key(B, '1');
await key(B, 'e');
const hostSq = () => A.evaluate((id) => { const q = window.__world().squadrons.find(q => q.ownerId === id && q.type === 'tb' && q.state !== 'return'); return q ? { id: q.id, human: q.human, state: q.state, n: q.n } : null; }, me);
check('host launched Bert\'s torpedo bombers', await wait(A, (id) => window.__world().squadrons.some(q => q.ownerId === id && q.type === 'tb' && q.human), me, 8000), await hostSq());
const sq = await hostSq();
check('Bert flies them (squadron view)', await wait(B, (id) => window.__air().flying && window.__air().sqId === id, sq?.id, 8000), await B.evaluate(() => window.__air()));
check('the third captain sees the flight', await wait(C, (id) => window.__world().squadrons.some(q => q.id === id), sq?.id, 5000));
check('planes drawn on the client', await wait(B, () => window.__air().drawn > 0, null, 5000), await B.evaluate(() => window.__air()));
check('climbed out', await wait(A, (id) => window.__world().squadrons.find(q => q.id === id)?.state === 'fly', sq?.id, 20000));
// steering: A held, the host turns the flight
const h0 = await A.evaluate((id) => window.__world().squadrons.find(q => q.id === id).heading, sq.id);
await B.bringToFront(); await B.keyboard.down('KeyD'); await sleep(1200); await B.keyboard.up('KeyD');
const h1 = await A.evaluate((id) => window.__world().squadrons.find(q => q.id === id).heading, sq.id);
check('the client steers its flight on the host', Math.abs(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0))) > 0.15, { h0, h1 });

// ---- the strike: hand back (E), the host puts the flight in front of an enemy held still,
// take it again (the stick resets to the new heading), hold LMB, release
await key(B, 'e');
check('E hands the flight back', await wait(A, (id) => window.__world().squadrons.find(q => q.id === id)?.human === false, sq.id, 3000));
const tgt = await A.evaluate(async (id) => {
   const w = window.__world(), q = w.squadrons.find(q => q.id === id);
   let e = null, best = 1e12;
   for (const s of w.ships) if (s.alive && s.side === 'enemy' && !s.air && !s.cfg.sub && /BB|CA/.test(s.cfg.hull.type)) { const d = Math.hypot(s.pos.x - q.pos.x, s.pos.y - q.pos.y); if (d < best) { best = d; e = s; } }
   if (!e) return null;
   e.ai = { _init: true, passive: true, desired: e.heading, tel: 0, dodged: new Set(), dodgeT: 0, reverseT: 99999, stuckT: 0 };
   e.telegraph = 0; e.speed = 0; e.aa = { range: 0, dps: 0, bands: [] };
   const h = e.heading + Math.PI / 2, gap = 1800 + q.cfg.speed * 2.2;
   q.pos.x = q.prev.x = e.pos.x - Math.cos(h) * gap; q.pos.y = q.prev.y = e.pos.y - Math.sin(h) * gap;
   q.heading = q.want = q.prev.h = h; q.speed = q.cfg.speed; q.order = { kind: 'strike', targetId: e.id, pos: null }; q.ai.phase = 0;
   window.__cvT = { id: e.id, hp: e.hp, h };
   return window.__cvT;
}, sq.id);
check('an enemy to strike', !!tgt, tgt || '');
check('the client sees the flight on its run', await wait(B, ([id, h]) => { const q = window.__world().squadrons.find(q => q.id === id); return q && Math.abs(Math.atan2(Math.sin(q.heading - h), Math.cos(q.heading - h))) < 0.05; }, [sq.id, tgt.h], 3000));
await key(B, 'e');
check('E takes it again', await wait(A, (id) => window.__world().squadrons.find(q => q.id === id)?.human === true, sq.id, 3000));
await B.mouse.move(640, 360);
await B.mouse.down();
const aiming = await wait(A, (id) => window.__world().squadrons.find(q => q.id === id)?.aiming === true, sq.id, 2000);
await sleep(1300);
await B.mouse.up();
check('the host flies the attack run', aiming);
check('torpedoes in the water on the host', await wait(A, (id) => window.__world().torpedoes.some(t => t.alive && t.air && t.ownerId === id), me, 3000));
check('... and on both clients', await wait(B, (id) => window.__world().torpedoes.some(t => t.alive && t.air && t.ownerId === id), me, 3000)
   && await wait(C, (id) => window.__world().torpedoes.some(t => t.alive && t.air && t.ownerId === id), me, 3000));
check('the strike lands: the enemy takes damage', await wait(A, () => { const e = window.__world().shipById(window.__cvT.id); return !e || e.hp < window.__cvT.hp; }, null, 30000),
   await A.evaluate(() => ({ hp0: window.__cvT.hp, hp: window.__world().shipById(window.__cvT.id)?.hp })));
check('the client sees the damage', await wait(B, ([id, hp]) => { const e = window.__world().shipById(id); return !e || e.hp < hp - 1; }, [tgt.id, tgt.hp], 5000));
// ---- recall
const still = await B.evaluate((id) => window.__air().flying && window.__air().sqId === id, sq.id);
if (!still) { await key(B, 'e'); await wait(B, () => window.__air().flying, null, 3000); }
await key(B, 'f');
check('F recalls: the flight turns home on the host', await wait(A, (id) => { const q = window.__world().squadrons.find(q => q.id === id); return !q || q.state === 'return' || q.state === 'land'; }, sq.id, 3000));
check('... and on the client, back on the bridge', await wait(B, (id) => { const q = window.__world().squadrons.find(q => q.id === id); return (!q || q.state === 'return' || q.state === 'land') && !window.__air().flying; }, sq.id, 3000));
// ---- AA focus from a client
const f0 = await A.evaluate((id) => window.__world().shipById(id).aaFocus, me);
await key(B, '4');
check('AA focus key reaches the host', await wait(A, ([id, f0]) => window.__world().shipById(id).aaFocus !== f0, [me, f0], 3000));
// ---- more planes, then the download
await key(B, '3'); await key(B, 'e');
await wait(B, () => window.__air().flying, null, 8000);
await key(B, 'e');
await sleep(8000);
const nb = await B.evaluate(() => window.__net()), na = await A.evaluate(() => window.__net());
const nsq = await A.evaluate(() => window.__world().squadrons.length);
check('client receives snapshots', nb && nb.snapHz > 10, { snapHz: nb?.snapHz });
console.log(`   co-op, 3 captains, ${nsq} flights in the air: Bert down ${nb?.kBpsIn?.toFixed(1)} kB/s, up ${nb?.kBpsOut?.toFixed(2)} kB/s; host out ${na?.kBpsOut?.toFixed(1)} kB/s (averages over the battle)`);
for (const p of [A, B, C]) await p.close();

// ================================================================ PvP
const PV = 'Träger PvP ' + Math.random().toString(36).slice(2, 6);
const P1 = await mkPage('P1', 'Paula'), P2 = await mkPage('P2', 'Quirin');
await P1.click('[data-act="main"]');
await P1.fill('[data-f="name"]', PV);
await P1.click('[data-seg="mode"] [data-v="pvp"]');
await P1.selectOption('[data-f="mission"]', 'standard');
await P1.click('.mp-modal [data-ok]');
await wait(P2, (n) => [...document.querySelectorAll('.mp-game')].some(e => e.innerText.includes(n)), PV);
await P2.locator('.mp-game', { hasText: PV }).locator('[data-join]').click();
check('pvp: two captains, one per team', await wait(P1, () => window.__mp.lobby.room?.players.length === 2 && window.__mp.lobby.teamSize(1) === 1 && window.__mp.lobby.teamSize(2) === 1, null, 15000));
check('pvp: both take a carrier', await pickShip(P1, 'Essex') && await pickShip(P2, 'Akagi'));
// host-side spy: the flights in every snapshot that goes to team 2
await P1.evaluate(async () => {
   const codec = await import(new URL('game3d/net/codec.js', location.href).href);
   const lb = window.__mp.lobby, rt = lb.rt, S = codec.makeSnap(), orig = rt.send.bind(rt);
   const spy = window.__spy = { snaps: 0, sq: 0, own: 0, foe: 0, bad: [], withheld: 0, err: '' };
   rt.send = (ch, data, to) => {
      try {
         const w = lb.session && window.__world?.();
         if (ch === 'snap' && data instanceof Uint8Array && w?.net?.pvp && codec.decodeSnap(new DataView(data.buffer, data.byteOffset, data.byteLength), S)) {
            spy.snaps++;
            const inc = new Set(S.qid.subarray(0, S.nq));
            for (const q of w.squadrons) {
               if (q.n <= 0 || q.state === 'land') continue;
               if (q.side === 'enemy') { if (inc.has(q.id)) spy.own++; continue; }
               if (inc.has(q.id)) { spy.foe++; if (!q.visE && spy.bad.length < 20) spy.bad.push([w.tick, q.id]); }
               else if (!q.visE) spy.withheld++;
            }
            spy.sq += S.nq;
         }
      } catch (e) { spy.err = String(e); }
      return orig(ch, data, to);
   };
});
check('pvp: battle started', await startMatch(P1, [P2]));
check('pvp: each captain on a carrier', await P1.evaluate(() => !!window.__world().player.air) && await P2.evaluate(() => !!window.__world().player.air));
// both launch: the host's flight is handed to its pilots, the client keeps flying its own
await P1.mouse.move(640, 360); await P2.mouse.move(640, 360);
await key(P1, '1'); await key(P1, 'e');
await key(P2, '1'); await key(P2, 'e');
check('pvp: the host flies its flight', await wait(P1, () => window.__air().flying, null, 8000));
check('pvp: the team-2 client flies its own', await wait(P2, () => window.__air().flying, null, 8000));
await key(P1, 'e');
await sleep(20000);
const spy = await P1.evaluate(() => window.__spy);
const p2own = await P2.evaluate(() => { const w = window.__world(); return w.squadrons.filter(q => q.ownerId === w.player.id).map(q => q.side); });
check('pvp: team 2 got snapshots', spy.snaps > 100, spy.snaps);
check('pvp: no unspotted flight of team 1 went to team 2', spy.bad.length === 0 && !spy.err, { bad: spy.bad, err: spy.err });
check('pvp: team 1\'s flight was withheld while unseen', spy.withheld > 0, spy.withheld);
check('pvp: team 2 always got its own flight', spy.own > 0 && p2own.length > 0 && p2own.every(s => s === 'player'), { own: spy.own, p2own });
const n2 = await P2.evaluate(() => window.__net());
console.log(`   pvp: ${spy.snaps} snapshots to team 2, own flight entries ${spy.own}, hostile ${spy.foe}, withheld ${spy.withheld}; team-2 client down ${n2?.kBpsIn?.toFixed(1)} kB/s`);

await browser.close();
const bad = results.filter(r => !r.ok).length;
if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.slice(0, 12).join('\n'));
console.log(`mp.carrier: ${results.length - bad}/${results.length} checks passed, ${errors.length} console errors`);
process.exit(bad || errors.length ? 1 : 0);
