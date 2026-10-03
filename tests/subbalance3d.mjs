// tests/subbalance3d.mjs -- headless submarine balance sweep: every boat is captained by the AI
// (world.autoPlayer) through the same missions; prints result, damage dealt and what hurt and
// sank the boat (damage type : hull type of the shooter).
// Usage: node tests/subbalance3d.mjs [missions] [diffs] [seeds] [boats]
//   defaults: standard,wolfpack,wahoo  normal  6  all six playable boats
import { World } from '../game3d/state.js';
import { Ship } from '../game3d/ship.js';
import { SHIPS, PLAYABLE } from '../game3d/config.js';

const arg = (i, d) => process.argv[i] && process.argv[i] !== 'all' ? process.argv[i] : d;
const mids = arg(2, 'standard,wolfpack,wahoo').split(',');
const diffs = arg(3, 'normal').split(',');
const seeds = +arg(4, 6);
const boats = arg(5, PLAYABLE.filter(k => SHIPS[k].hull.type === 'SS').join(',')).split(',');
const DT = 1 / 60;

// every hit on the player boat, by cause
let player = null, taken = null, last = '';
const orig = Ship.prototype.takeDamage;
Ship.prototype.takeDamage = function (amt, shooter, type, ps) {
   if (this !== player) return orig.call(this, amt, shooter, type, ps);
   const before = this.hp;
   const r = orig.call(this, amt, shooter, type, ps);
   const k = (type || '?') + ':' + (shooter ? shooter.type : '-');
   const d = Math.max(0, before - this.hp);
   if (d > 0) { taken[k] = (taken[k] || 0) + d; last = k; }
   return r;
};

// SALVO=1: what a human captain gets from one bow salvo at long range. The boat lies at periscope
// depth abeam of a heavy cruiser that steams straight on (it still dodges torpedoes it sees),
// fires one spread at the intercept point and the damage on the cruiser is summed.
if (process.env.SALVO) {
   const { interceptPoint } = await import('../game3d/utils.js');
   const ranges = [3000, 5000, 7000, 9000];
   for (const boat of boats) {
      const row = [];
      for (const R of ranges) {
         let sum = 0;
         for (let s = 0; s < seeds; s++) {
            const w = new World('normal', { mission: 'standard', ship: boat, seed: 7000 + s * 7919 });
            const p = w.player;
            const tgt = w.ships.find(x => x.side === 'enemy' && x.type === 'CA') || w.ships.find(x => x.side === 'enemy' && x.type !== 'SS');
            for (const x of [...w.ships]) if (x !== p && x !== tgt) w.removeShip(x, 'test');
            tgt.pos.x = 0; tgt.pos.y = 0; tgt.heading = 0; tgt.ai.passive = true; tgt.ai.route = [{ x: 30000, y: 0 }]; tgt.ai.routeIdx = 0;
            tgt.speed = tgt.maxSpeed * 0.8;
            const a = (0.5 + (s % 3) * 0.25) * Math.PI / 2;         // 45 / 67 / 90 deg off the bow
            p.pos.x = Math.cos(a) * R + R * 0.25; p.pos.y = Math.sin(a) * R; p.speed = 0;
            p.depthTarget = p.depthF = 1; p.depth = 1;
            w.update(DT);
            const ip = interceptPoint(p.pos, p.cfg.torp.speed, tgt.pos, tgt.vel) || tgt.pos;
            const brg = Math.atan2(ip.y - p.pos.y, ip.x - p.pos.x);
            p.heading = brg;
            const hp0 = tgt.hp;
            p.fireTorpedoes(w, brg);
            const tEnd = w.time + R / 60 + 60;
            while (w.phase === 'playing' && w.time < tEnd) { p.speed = 0; w.update(DT); }
            sum += Math.max(0, hp0 - tgt.hp);
         }
         row.push(`${R / 1000}km ${Math.round(sum / seeds)}`);
      }
      console.log(`salvo ${boat.padEnd(7)} ${row.join('  ')}`);
   }
   process.exit(0);
}

// BOTS=1: boat against boat as bots. Begegnungsgefechte that roll submarines; every bot boat on
// both sides is swapped for the class under test, the player ship stays a surface ship.
if (process.env.BOTS) {
   const n = seeds;
   for (const boat of boats) {
      let dealt = 0, lost = 0, runs = 0, boatsN = 0;
      const t0 = Date.now();
      for (let s = 0, found = 0; found < n && s < n * 12; s++) {
         const w = new World('normal', { mission: 'standard', seed: 5000 + s * 104729 });
         const subs = w.bots.filter(b => b.sub);
         if (!subs.length) continue;
         found++; runs++;
         const mine = subs.map(old => w.replaceShip(old, boat, { name: old.name, ai: old.ai }));
         boatsN += mine.length;
         const dealtBy = new Map();
         const o2 = Ship.prototype.takeDamage;
         Ship.prototype.takeDamage = function (amt, shooter, type, ps) {
            const b = this.hp; const r = o2.call(this, amt, shooter, type, ps);
            if (shooter && mine.includes(shooter)) dealtBy.set(shooter, (dealtBy.get(shooter) || 0) + Math.max(0, b - this.hp));
            return r;
         };
         w.autoPlayer = true;
         while (w.phase === 'playing' && w.time < 1200) w.update(DT);
         Ship.prototype.takeDamage = o2;
         for (const m of mine) { dealt += dealtBy.get(m) || 0; if (!m.alive && !m.escaped) lost++; }
      }
      console.log(`bots ${boat.padEnd(7)} battles ${runs} boats ${boatsN} dmg/boat=${Math.round(dealt / (boatsN || 1))} ` +
         `sunk ${lost}/${boatsN} [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
   }
   process.exit(0);
}

const pct = (o, tot) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5)
   .map(([k, v]) => `${k} ${Math.round(100 * v / (tot || 1))}%`).join(', ');
for (const mid of mids) for (const diff of diffs) for (const boat of boats) {
   let wins = 0, alive = 0, dmg = 0, kills = 0, tSum = 0;
   const cause = {}, death = {}, reasons = {};
   const t0 = Date.now();
   for (let s = 0; s < seeds; s++) {
      const w = new World(diff, { mission: mid, ship: boat, seed: 1000 + s * 7919 });
      w.autoPlayer = true;
      // operations prescribe their boat: swap it for the boat under test (same place, same orders)
      if (w.player.cls !== boat) {
         const old = w.player;
         const np = w.replaceShip(old, boat, { isPlayer: true, name: old.name, telegraph: old.telegraph, ai: old.ai });
         np.stats = old.stats; w.player = np;
      }
      player = w.player; taken = {}; last = '';
      while (w.phase === 'playing' && w.time < 1800) w.update(DT);
      if (w.phase === 'won') wins++;
      if (player.alive) alive++; else death[last || '?'] = (death[last || '?'] || 0) + 1;
      dmg += w.stats.dmg; kills += w.stats.kills; tSum += w.time;
      for (const k in taken) cause[k] = (cause[k] || 0) + taken[k];
      const r = (w.result?.reason || 'timeout?').slice(0, 30);
      reasons[r] = (reasons[r] || 0) + 1;
   }
   const tot = Object.values(cause).reduce((a, b) => a + b, 0);
   console.log(`${mid.padEnd(9)} ${diff.padEnd(6)} ${boat.padEnd(7)} win ${wins}/${seeds} alive ${alive} ` +
      `dmg=${Math.round(dmg / seeds)} k=${(kills / seeds).toFixed(1)} t=${(tSum / seeds / 60).toFixed(1)}min ` +
      `[${((Date.now() - t0) / 1000).toFixed(0)}s]\n   taken: ${pct(cause, tot)}\n   sunk by: ${JSON.stringify(death)}  ${JSON.stringify(reasons)}`);
}
