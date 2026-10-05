// V2 balance harness (not part of the pass/fail suite):  node tests/v2.balance.mjs [runs]
//   1. launch-to-impact time of every anti-ship missile at a typical range (70 % of its maximum)
//   2. share of a salvo of 1 / 2 / 4 / 8 missiles that hits each ship class with its hard-kill
//      defences on (radar on, doctrine "free", no decoys, the ship does not manoeuvre), for a subsonic
//      (Harpoon) and a supersonic (Oniks) reference missile. The salvo is a ripple from one launcher
//      (DEFENCE.launchGap apart) from 20 km.
//   3. the same with the defender throwing a decoy cloud when the first seeker comes on.
//   4. tier-peer duel matrix: every class against the classes of its weight group, bot against bot,
//      both sides swapped; win = the other ship sunk, or clearly more hull left after DUEL_T seconds.
//   5. fleet skirmish (mission 'standard', all bots): when it ends, who wins, hits, magazines left.
// Sections: node tests/v2.balance.mjs 30 salvo|duel|fleet   (default: all). Env: DEF='{"samGap":9}',
// ONLY=Daring,Burke, SIZES=4,8, DIFF=easy|normal|hard.
import { emptySea, put, run } from './v2.util.mjs';
import { SHIPS, MISSILES, DEFENCE } from '../gamev2/config.js';
import { launchSSM } from '../gamev2/missile.js';
import { World } from '../gamev2/state.js';

const RUNS = +process.argv[2] || 30;
const MODE = process.argv[3] || 'all';
const DIFF = process.env.DIFF || 'normal';
if (process.env.DEF) Object.assign(DEFENCE, JSON.parse(process.env.DEF));      // try a tuning without editing config.js
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const still = { ai: { passive: true } };
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

// A launcher that is not a ship: it only carries rounds (so no defences or AI interfere).
function launcher(w, type, x, y) {
   return { id: 900000, side: 'enemy', pos: { x, y }, alive: true, cfg: { weapons: { ssm: [{ type }] } }, mag: { [type]: 99 }, lastSsmFire: -999, dmgMult: 1 };
}
function hits(w) { let n = 0; for (const e of w.events) if (e.type === 'missileHit') n++; return n; }

function flightTime(type) {
   const c = MISSILES[type], R = c.range * 0.7;
   const w = emptySea({ ship: 'Typ022' });   // no hard kill
   const L = launcher(w, type, R, 0);
   w.player.targetable = w.player.detected = true;
   launchSSM(w, L, { targetId: w.player.id });
   const t0 = w.time;
   let t = null;
   run(w, 120, () => { if (hits(w)) { t = w.time - t0; return false; } });
   return { R, t };
}

function salvo(cls, type, n, seed, decoy) {
   const w = emptySea({ ship: cls, seed });
   const T = w.player;
   T.hp = T.maxHP = 1e9;                       // count hits, not sinkings
   const L = launcher(w, type, Math.min(20000, MISSILES[type].range * 0.9), 0);
   let fired = 0, hit = 0, seen = 0, thrown = false;
   run(w, 140, () => {
      if (fired < n) { T.targetable = T.detected = true; if (launchSSM(w, L, { targetId: T.id })) fired++; }
      if (decoy && !thrown && T.seekerWarn && w.time - T.seekerWarn.t < 1) { thrown = true; T.useConsumable(w, 'decoy'); }
      if (fired >= n && !w.missiles.some(m => m.kind === 'ssm')) return false;
   });
   for (const e of w.events) { if (e.type === 'missileHit') hit++; else if (e.type === 'vampire') seen++; }
   return { fired, hit };
}
function tryDecoy(w, T) {
   const i = (T.consumables || []).findIndex(c => c.key === 'decoy');
   if (i < 0) return true;
   T.useConsumable(i, w);
   return true;
}

if (MODE === 'all' || MODE === 'salvo') {
console.log(`V2 balance, ${RUNS} runs per cell. DEFENCE: react ${DEFENCE.react} relook ${DEFENCE.relook} samGap ${DEFENCE.samGap} salvo ${DEFENCE.salvo}/${DEFENCE.salvoClose} launchGap ${DEFENCE.launchGap}\n`);
console.log('Launch to impact at 70 % of maximum range (undefended target)');
for (const k in MISSILES) {
   if (MISSILES[k].kind !== 'ssm') continue;
   const r = flightTime(k);
   console.log('  ' + pad(MISSILES[k].name, 16) + lpad((r.R / 1000).toFixed(1), 6) + ' km ' + lpad(r.t == null ? 'miss' : r.t.toFixed(1) + ' s', 8));
}

const SIZES = process.env.SIZES ? process.env.SIZES.split(',').map(Number) : [1, 2, 4, 8];
function table(title, type, decoy) {
   console.log(`\n${title}: share of the salvo that hits (%), salvo of ${SIZES.join(' / ')}`);
   for (const cls in SHIPS) {
      const s = SHIPS[cls];
      if (s.hull.type === 'SS' || s.hull.type === 'TR' || (ONLY && !ONLY.includes(cls))) continue;
      const w = s.weapons || {};
      const row = SIZES.map(n => {
         let f = 0, h = 0;
         for (let i = 0; i < RUNS; i++) { const r = salvo(cls, type, n, 100 + i * 7 + n, decoy); f += r.fired; h += r.hit; }
         return lpad(f ? Math.round(100 * h / f) : '-', 5);
      });
      const def = (w.sam || []).map(x => x.type + 'x' + x.ch).join('+') + (w.ciws ? ' ' + w.ciws.type + 'x' + w.ciws.n : '');
      console.log('  ' + pad(cls, 13) + pad(s.hull.type, 4) + row.join('') + '   ' + (def || 'no hard kill'));
   }
}
table('Harpoon (subsonic)', 'harpoon', false);
table('Oniks (supersonic)', 'oniks', false);
table('Harpoon, defender throws one decoy cloud', 'harpoon', true);
}

// ---------------------------------------------------------------- 4. tier-peer duels
const TIERS = {
   'Korvetten': ['Braunschweig', 'BuyanM', 'Mowdsch'],
   'Fregatten': ['Sachsen', 'Gorschkow', 'Typ054A'],
   'Zerstörer': ['Burke', 'Daring', 'Typ052D'],
   'Kreuzer': ['Ticonderoga', 'Slawa', 'Typ055'],
};
const DUEL_T = 420, DUEL_R = 15000;
// +1: a wins, -1: b wins, 0: draw
function duel(a, b, seed) {
   const w = emptySea({ ship: a, seed, difficulty: DIFF });
   w.autoPlayer = true;
   const A = w.player, B = put(w, b, 'enemy', DUEL_R, 0, Math.PI, { telegraph: 3 });
   A.ai = A.ai || {}; A.setTelegraph(3);
   run(w, DUEL_T, () => A.alive && B.alive);
   if (A.alive !== B.alive) return { r: A.alive ? 1 : -1, t: w.time };
   const fa = A.hp / A.maxHP, fb = B.hp / B.maxHP;
   return { r: Math.abs(fa - fb) < 0.15 ? 0 : fa > fb ? 1 : -1, t: w.time };
}
if (MODE === 'all' || MODE === 'duel') {
   const n = Math.max(2, Math.round(RUNS / 3));
   console.log(`\nTier-peer duels (${DIFF}), ${n * 2} per pair: win % of the row class against the column class (draws count half), ${DUEL_T} s limit`);
   for (const g in TIERS) {
      const L = TIERS[g], pts = Object.fromEntries(L.map(k => [k, 0])), cnt = { ...pts }, cell = {};
      let sunkBy = 0, games = 0;
      for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
         let p = 0;
         for (let k = 0; k < n; k++) {
            const x = duel(L[i], L[j], 300 + k * 13), y = duel(L[j], L[i], 900 + k * 17);
            p += (x.r + 1) / 2 + (1 - y.r) / 2; games += 2;
            if (x.t < DUEL_T - 1) sunkBy++; if (y.t < DUEL_T - 1) sunkBy++;
         }
         cell[L[i] + L[j]] = p / (2 * n); cell[L[j] + L[i]] = 1 - p / (2 * n);
         pts[L[i]] += p; pts[L[j]] += 2 * n - p; cnt[L[i]] += 2 * n; cnt[L[j]] += 2 * n;
      }
      console.log(`  ${g}  (${Math.round(100 * sunkBy / games)} % of the duels end with a sinking)`);
      console.log('  ' + pad('', 13) + L.map(k => lpad(k.slice(0, 8), 9)).join('') + '    total');
      for (const a of L) console.log('  ' + pad(a, 13) + L.map(b => lpad(a === b ? '·' : Math.round(100 * cell[a + b]), 9)).join('') + lpad(Math.round(100 * pts[a] / cnt[a]), 9));
   }
}

// ---------------------------------------------------------------- 5. fleet skirmish
function skirmish(seed, ship) {
   const w = new World(DIFF, { mission: 'standard', ship, seed });
   w.autoPlayer = true;
   const end = w.end;                          // the battle goes on when the flagship is lost
   w.end = function (v, reason) { if (!/^Ihr Schiff/.test(reason)) end.call(this, v, reason); };
   const n0 = { player: 0, enemy: 0 };
   for (const s of w.ships) n0[s.side]++;
   const LIMIT = 600;
   let hitsN = 0, seq = 0, tDec = null;
   const left = (side) => w.ships.filter(s => s.alive && s.side === side).length;
   for (let i = 0; i < LIMIT * 60 && w.phase === 'playing'; i++) {
      w.update(1 / 60);
      for (const e of w.events) if (e.seq > seq) { seq = e.seq; if (e.type === 'missileHit') hitsN++; }
      // decisive: one side is down to a third of its ships (the harness goes on to the end anyway)
      if (tDec == null && i % 60 === 0 && (left('player') <= n0.player / 3 || left('enemy') <= n0.enemy / 3)) tDec = w.time;
   }
   let samLeft = 0, samMax = 0;
   for (const s of w.roster) for (const x of s.cfg.weapons.sam) if (s.alive) { samLeft += s.mag[x.type]; samMax += x.n; }
   return { t: w.time, tDec, phase: w.phase, hits: hitsN, p: left('player') + '/' + n0.player, e: left('enemy') + '/' + n0.enemy, sam: samMax ? Math.round(100 * samLeft / samMax) : 0 };
}
if (MODE === 'all' || MODE === 'fleet') {
   const n = Math.max(3, Math.round(RUNS / 3));
   console.log(`\nFleet skirmish 'standard' (${DIFF}), all captains are bots, 600 s limit`);
   console.log('  seed  flagship       decisive  end    result   missile hits  west left  east left  SAM left %');
   let dec = 0, hitSum = 0;
   const flag = ['Burke', 'Ticonderoga', 'Sachsen', 'Daring'];
   for (let i = 0; i < n; i++) {
      const r = skirmish(40 + i * 11, flag[i % flag.length]);
      if (r.tDec != null && r.tDec <= 600) dec++;
      hitSum += r.hits;
      console.log('  ' + lpad(40 + i * 11, 4) + '  ' + pad(flag[i % flag.length], 13) + lpad(r.tDec == null ? '-' : Math.round(r.tDec) + ' s', 9) + lpad(Math.round(r.t) + ' s', 7) + '   ' + pad(r.phase, 8) +
         lpad(r.hits, 10) + lpad(r.p, 12) + lpad(r.e, 11) + lpad(r.sam, 10));
   }
   console.log(`  decisive within 10 min: ${dec}/${n}, missile hits per battle: ${(hitSum / n).toFixed(1)}`);
}
