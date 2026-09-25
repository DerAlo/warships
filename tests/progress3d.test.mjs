// Career progression (game3d/progress3d.js): rewards, unlock/purchase rules, stat pipeline, storage.
// Also pulled in by tests/sim3d.test.mjs, so `node --test tests/sim3d.test.mjs` runs these too.
import { test } from 'node:test';
import assert from 'node:assert';
import { World } from '../game3d/state.js';
import { SHIPS } from '../game3d/config.js';
import * as PG from '../game3d/progress3d.js';

const memStore = (init = {}) => { const m = { ...init }; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; };

test('progress: XP/credit breakdown from damage, kills, objectives, win bonus, difficulty', () => {
   const stats = { dmg: 60000, kills: 2, citadels: 3, spottingDmg: 10000, potential: 200000, caps: 1 };
   const objectives = [{ state: 'done' }, { state: 'done', optional: true }, { state: 'failed' }];
   const win = PG.calcRewards({ victory: true, stats, alive: true, objectives });
   const loss = PG.calcRewards({ victory: false, stats, alive: false, objectives: [] });
   const hard = PG.calcRewards({ victory: true, stats, alive: true, objectives, rewardMult: 1.3 });
   assert.strictEqual(win.xp, win.lines.reduce((a, l) => a + l.xp, 0));
   assert.strictEqual(win.credits, win.lines.reduce((a, l) => a + l.credits, 0));
   assert.ok(win.lines.some(l => l.label === 'Siegbonus') && !loss.lines.some(l => l.label === 'Siegbonus'));
   const lbl = (r, l) => r.lines.find(x => x.label === l)?.xp || 0;
   assert.strictEqual(lbl(win, 'Missionsziele'), 120 + 100 + 250);
   assert.strictEqual(lbl(win, 'Versenkt'), 320);
   assert.ok(win.xp > loss.xp + 800 && hard.xp > win.xp * 1.25 && hard.xp < win.xp * 1.35);
   // a typical won battle on normal is worth roughly a third of the first unlock
   assert.ok(win.xp > 2200 && win.xp < 3600, 'typical win xp ' + win.xp);
   assert.strictEqual(PG.calcRewards({ victory: false, stats: {} }).xp, 450);
   // the sim books it on World.end
   const w = new World('hard', { mission: 'standard', ship: 'Hipper', seed: 3 });
   w.end(true, 'test');
   assert.ok(w.result.rewards.lines.length >= 2 && w.result.xp === w.result.rewards.xp && w.result.rewards.mult === 1.3);
});

test('progress: unlock + module purchase + skill rules', () => {
   const p = PG.defaultProfile();
   assert.ok(PG.isUnlocked(p, 'Bismarck') && PG.isUnlocked(p, 'Hipper'), 'two free ships');
   assert.ok(!PG.isUnlocked(p, 'Nuernberg') && !PG.isUnlocked(p, 'Z23'));
   assert.ok(PG.isUnlocked(p, 'DukeOfYork'), 'op ships are never gated');
   assert.strictEqual(PG.unlockShip(p, 'Nuernberg'), false);
   PG.grantRewards(p, { xp: 8000, credits: 100000 });
   assert.strictEqual(p.totalXp, 8000);
   assert.ok(PG.unlockShip(p, 'Nuernberg') && PG.isUnlocked(p, 'Nuernberg'));
   assert.strictEqual(p.xp, 8000 - PG.UNLOCK_XP.Nuernberg);
   assert.strictEqual(p.totalXp, 8000, 'spending XP keeps the captain level');
   assert.strictEqual(PG.unlockShip(p, 'Nuernberg'), false, 'no double unlock');
   // modules: tiers in order, credits checked, locked ships cannot be upgraded
   assert.strictEqual(PG.buyModule(p, 'Z23', 'main'), false);
   assert.ok(PG.buyModule(p, 'Hipper', 'main'));
   assert.strictEqual(PG.moduleTier(p, 'Hipper', 'main'), 1);
   assert.strictEqual(p.credits, 100000 - PG.MODULE_COST[0]);
   assert.strictEqual(PG.buyModule(p, 'Hipper', 'main'), false, 'tier 2 too expensive');
   p.credits = 1e7;
   assert.ok(PG.buyModule(p, 'Hipper', 'main') && PG.buyModule(p, 'Hipper', 'main'));
   assert.strictEqual(PG.buyModule(p, 'Hipper', 'main'), false, 'max tier');
   assert.strictEqual(PG.moduleCost(p, 'Hipper', 'main'), 0);
   assert.strictEqual(PG.buyModule(p, 'Hipper', 'nonsense'), false);
   // skills: points from captain level, respec refunds
   const lv = PG.captainLevel(p.totalXp).level;
   assert.ok(lv >= 3);
   assert.ok(PG.learnSkill(p, 'sniper') && !PG.learnSkill(p, 'sniper'));
   assert.strictEqual(PG.skillPointsFree(p), lv - 2);
   assert.strictEqual(PG.learnSkill(p, 'conceal'), lv - 2 >= 3);
   assert.ok(PG.respecSkills(p) && PG.skillPointsFree(p) === lv);
   assert.strictEqual(PG.learnSkill(PG.defaultProfile(), 'prep'), false, 'level 0 has no points');
});

test('progress: modules + skills flow through the ship stat pipeline (player only)', () => {
   const lo = { modules: { main: 3, engine: 3, rudder: 3, hull: 3, fcs: 3 }, skills: ['sniper', 'conceal', 'adren', 'prep', 'vigil', 'fireprot', 'pyro'] };
   const base = new World('normal', { mission: 'standard', ship: 'Hipper', seed: 5 });
   const w = new World('normal', { mission: 'standard', ship: 'Hipper', seed: 5, loadout: lo });
   const a = base.player, b = w.player, c = SHIPS.Hipper;
   assert.strictEqual(a.cfg, c, 'no loadout: stock config object');
   assert.strictEqual(new World('normal', { mission: 'standard', ship: 'Hipper', seed: 5, loadout: { modules: {}, skills: [] } }).player.cfg, c);
   assert.ok(Math.abs(b.maxHP / a.maxHP - 1.09) < 0.002);
   assert.ok(Math.abs(b.turrets[0].reloadMax / a.turrets[0].reloadMax - 0.92) < 0.005);
   assert.ok(Math.abs(b.cfg.main.range / c.main.range - 1.06) < 0.002);
   assert.strictEqual(b.cfg.main.vShell, c.main.vShell, 'range upgrade keeps the shell velocity');
   assert.ok(Math.abs(b.cfg.main.dispH / c.main.dispH - 0.89) < 0.001);
   assert.ok(b.maxSpeedKn > a.maxSpeedKn * 1.04 && b.maxSpeedKn < a.maxSpeedKn * 1.06);
   assert.ok(Math.abs(b.cfg.rudderShift / c.rudderShift - 0.9) < 0.001);
   assert.ok(Math.abs(b.detectRange / a.detectRange - 0.92) < 0.002);
   assert.ok(b.consumables.every((k, i) => k.cdMax < a.consumables[i].cdMax));
   assert.ok(b.torpSpot > 1 && b.fireDur < 1 && b.adrenaline > 0 && a.torpSpot === 1 && a.fireDur === 1 && a.adrenaline === 0);
   assert.ok(b.cfg.main.he.fire > c.main.he.fire);
   // the shared class config and the bots stay untouched
   assert.strictEqual(c.main.reload, 10.5);
   for (const s of w.ships) if (!s.isPlayer) assert.strictEqual(s.cfg, SHIPS[s.cls]);
   // Brandschutz: shorter fires
   b.ignite('mid', null); assert.ok(b.fires[0].dur < 35 && b.fires[0].dur > 30);
   // every single effect is modest
   for (const d of PG.MODULES) for (const tr of d.tiers) for (const v of Object.values(tr)) assert.ok(Math.abs(v) <= 0.1);
   for (const s of PG.SKILLS) if (!s.top) for (const v of Object.values(s.fx)) assert.ok(Math.abs(v) <= 0.15);   // top tier = trade-off flags
});

test('progress: profile load survives broken, old and blocked storage', () => {
   assert.deepStrictEqual(PG.loadProfile(null), PG.defaultProfile());
   assert.deepStrictEqual(PG.loadProfile(memStore({ [PG.PROFILE_KEY]: '{not json' })), PG.defaultProfile());
   assert.deepStrictEqual(PG.loadProfile(memStore({ [PG.PROFILE_KEY]: '[1,2]' })), PG.defaultProfile());
   const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); } };
   assert.deepStrictEqual(PG.loadProfile(throwing), PG.defaultProfile());
   assert.strictEqual(PG.saveProfile(PG.defaultProfile(), throwing), false);
   // garbage fields are dropped / clamped
   const bad = PG.loadProfile(memStore({ [PG.PROFILE_KEY]: JSON.stringify({ xp: -5, credits: 'lots', totalXp: 1e3,
      unlocked: { Z23: 'yes', Nuernberg: true, Foo: true }, modules: { Hipper: { main: 9, engine: -1, bogus: 2 }, Z23: null },
      skills: ['conceal', 'sniper', 'sniper', 'nope'] }) }));
   assert.strictEqual(bad.xp, 0); assert.strictEqual(bad.credits, 0);
   assert.deepStrictEqual(bad.unlocked, { Nuernberg: true });
   assert.deepStrictEqual(bad.modules, { Hipper: { main: 3 } });
   assert.deepStrictEqual(bad.skills, [], 'skills beyond the captain points are dropped');
   // older menu record (warships3d.progress.v1) carries its XP/credits over once
   const old = PG.loadProfile(memStore({ 'warships3d.progress.v1': JSON.stringify({ missions: {}, xp: 9000, credits: 400000 }) }));
   assert.strictEqual(old.xp, 9000); assert.strictEqual(old.totalXp, 9000); assert.strictEqual(old.credits, 400000);
   // round trip
   const st = memStore(), p = PG.defaultProfile();
   PG.grantRewards(p, { xp: 5000, credits: 90000 }); PG.learnSkill(p, 'prep');
   assert.ok(PG.saveProfile(p, st));
   assert.deepStrictEqual(PG.loadProfile(st), p);
});

test('progress: top skill "Manuelle Steuerung der Sekundärbewaffnung" loads, learns and bakes in', () => {
   const sk = PG.SKILLS.find(s => s.key === 'manualSec');
   assert.ok(sk && sk.name === 'Manuelle Steuerung der Sekundärbewaffnung' && sk.desc && sk.top);
   assert.strictEqual(sk.cost, 4, 'top tier costs 4 points');
   assert.ok(sk.cost === Math.max(...PG.SKILLS.map(s => s.cost)), 'the most expensive skill');
   const total = PG.SKILLS.reduce((a, s) => a + s.cost, 0);
   assert.ok(PG.CAPTAIN_XP.length - 1 < total, 'the point cap still forces a choice');
   // learning needs 4 free points
   const p = PG.defaultProfile();
   PG.grantRewards(p, { xp: PG.CAPTAIN_XP[3], credits: 0 });
   assert.strictEqual(PG.learnSkill(p, 'manualSec'), false, 'level 3: not enough points');
   PG.grantRewards(p, { xp: PG.CAPTAIN_XP[5] - PG.CAPTAIN_XP[3], credits: 0 });
   assert.ok(PG.learnSkill(p, 'manualSec') && !PG.learnSkill(p, 'manualSec'));
   assert.strictEqual(PG.skillPointsFree(p), 1);
   // survives a save/load round trip and sanitising
   const st = memStore();
   assert.ok(PG.saveProfile(p, st));
   assert.deepStrictEqual(PG.loadProfile(st).skills, ['manualSec']);
   assert.deepStrictEqual(PG.sanitizeProfile({ totalXp: PG.CAPTAIN_XP[3], skills: ['manualSec'] }).skills, [], 'too few points: dropped');
   // stat pipeline: flag + class-scaled secondary dispersion, main battery untouched
   const lo = PG.loadoutFor(p, 'Bismarck');
   const bb = PG.applyLoadout(SHIPS.Bismarck, lo), ca = PG.applyLoadout(SHIPS.Hipper, lo), dd = PG.applyLoadout(SHIPS.Z23, lo);
   assert.ok(bb.manualSec && ca.manualSec && dd.manualSec);
   assert.ok(Math.abs(bb.sec.dispH / SHIPS.Bismarck.sec.dispH - (1 - PG.MANUAL_SEC_DISP.BB)) < 1e-9);
   assert.ok(Math.abs(ca.sec.dispH / SHIPS.Hipper.sec.dispH - (1 - PG.MANUAL_SEC_DISP.CA)) < 1e-9);
   assert.ok(PG.MANUAL_SEC_DISP.BB >= 0.5 && PG.MANUAL_SEC_DISP.BB <= 0.6, 'battleships: 50-60 % tighter');
   assert.ok(PG.MANUAL_SEC_DISP.CA < PG.MANUAL_SEC_DISP.BB && PG.MANUAL_SEC_DISP.CL <= PG.MANUAL_SEC_DISP.CA && PG.MANUAL_SEC_DISP.DD < PG.MANUAL_SEC_DISP.CL);
   assert.strictEqual(dd.sec, null, 'no secondaries, nothing to scale');
   assert.strictEqual(bb.main.dispH, SHIPS.Bismarck.main.dispH);
   assert.strictEqual(SHIPS.Bismarck.manualSec, undefined, 'shared class config untouched');
   const w = new World('normal', { mission: 'standard', ship: 'Bismarck', seed: 5, loadout: lo });
   assert.ok(w.player.manualSec);
   for (const s of w.ships) if (!s.isPlayer) assert.ok(!s.manualSec, 'bots never get the skill');
});
