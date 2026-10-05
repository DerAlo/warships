// V2 ship-versus-ship fairness: same-tier west-versus-east bot duels on a small fixed seed set, both sides
// swapped. Each pair must stay within 65/35 (15 seeds per order: neither ship wins more than 19 of 30).
// The wider measurement (40+ runs per order, three difficulties) is tests/v2.balance.mjs, section "duel".
import { test } from 'node:test';
import assert from 'node:assert';
import { emptySea, put, run } from './v2.util.mjs';

const DUEL_T = 420, DUEL_R = 15000, SEEDS = Array.from({ length: 15 }, (_, k) => 300 + k * 13);
// +1: a wins, -1: b wins, 0: draw (clearly more hull left after DUEL_T counts, as in the harness)
function duel(a, b, seed) {
   const w = emptySea({ ship: a, seed, difficulty: 'normal' });
   w.autoPlayer = true;
   const A = w.player, B = put(w, b, 'enemy', DUEL_R, 0, Math.PI, { telegraph: 3 });
   A.ai = A.ai || {}; A.setTelegraph(3);
   run(w, DUEL_T, () => A.alive && B.alive);
   if (A.alive !== B.alive) return A.alive ? 1 : -1;
   const fa = A.hp / A.maxHP, fb = B.hp / B.maxHP;
   return Math.abs(fa - fb) < 0.15 ? 0 : fa > fb ? 1 : -1;
}
function split(a, b) {
   let pa = 0, pb = 0;
   for (const s of SEEDS) {
      const x = duel(a, b, s), y = duel(b, a, s + 600);
      pa += (x === 1) + (y === -1) + ((x === 0) + (y === 0)) / 2;
      pb += (x === -1) + (y === 1) + ((x === 0) + (y === 0)) / 2;
   }
   return [pa, pb];
}

for (const [a, b] of [['Sachsen', 'Gorschkow'], ['Slawa', 'Ticonderoga'], ['Ticonderoga', 'Typ055'], ['Daring', 'Burke']]) {
   test(`pair ${a} vs ${b} stays within 65/35`, () => {
      const [pa, pb] = split(a, b);
      assert.ok(pa <= 19.5 && pb <= 19.5, `${a} ${pa} : ${b} ${pb} of ${SEEDS.length * 2}`);
   });
}
