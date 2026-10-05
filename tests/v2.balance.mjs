// V2 balance harness (not part of the pass/fail suite):  node tests/v2.balance.mjs [runs]
//   1. launch-to-impact time of every anti-ship missile at a typical range (70 % of its maximum)
//   2. share of a salvo of 1 / 2 / 4 / 8 missiles that hits each ship class with its hard-kill
//      defences on (radar on, doctrine "free", no decoys, the ship does not manoeuvre), for a subsonic
//      (Harpoon) and a supersonic (Oniks) reference missile. The salvo is a ripple from one launcher
//      (DEFENCE.launchGap apart) from 20 km.
//   3. the same with the defender throwing a decoy cloud when the first seeker comes on.
import { emptySea, put, run } from './v2.util.mjs';
import { SHIPS, MISSILES, DEFENCE } from '../gamev2/config.js';
import { launchSSM } from '../gamev2/missile.js';

const RUNS = +process.argv[2] || 30;
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

console.log(`V2 balance, ${RUNS} runs per cell. DEFENCE: react ${DEFENCE.react} relook ${DEFENCE.relook} samGap ${DEFENCE.samGap} salvo ${DEFENCE.salvo}/${DEFENCE.salvoClose} launchGap ${DEFENCE.launchGap}\n`);
console.log('Launch to impact at 70 % of maximum range (undefended target)');
for (const k in MISSILES) {
   if (MISSILES[k].kind !== 'ssm') continue;
   const r = flightTime(k);
   console.log('  ' + pad(MISSILES[k].name, 16) + lpad((r.R / 1000).toFixed(1), 6) + ' km ' + lpad(r.t == null ? 'miss' : r.t.toFixed(1) + ' s', 8));
}

const SIZES = [1, 2, 4, 8];
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
