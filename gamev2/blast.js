// gamev2/blast.js — scripted large detonations of the missions (no player weapon, no command):
// one event with three radius bands that is applied exactly once to everything inside.
// Plain data in world.blasts[]; World.update calls updateBlasts.
//
// Blast: { id, x, y, pos {x, y}, r { destroyed, heavy, shock } (m), t0 (world time of the detonation),
//          state 'armed' | 'done', age (s since the detonation), label, hit { ships, sunk, sites, air } }
//    addBlast(world, { x, y, r | radius, delay = 0, label, id }) -> blast
//       r: { destroyed, heavy, shock }, or radius: one number (= shock radius; heavy 55 %, destroyed 25 %)
//    Bands (ships / land positions): destroyed -> sunk / destroyed; heavy -> BLAST.heavy of the full
//       hull, fires, engine and rudder out; shock -> BLAST.shock of the full hull, radar and jammer
//       off. A deep boat is one band better off. Aircraft, helicopters and missiles inside the heavy
//       radius are gone; special-forces teams inside it are lost.
//    Done blasts stay BLAST.keep seconds (the renderer fades the cloud by `age`), then they are removed.
// Event: blast { blastId, pos, r { destroyed, heavy, shock }, hit { ships, sunk, sites, air }, text }.
import { damageSite } from './sites.js';
import { hurtSquad } from './air.js';
import { killHelo } from './helo.js';
import { loseTeam } from './seal.js';

export const BLAST = { heavy: 0.6, shock: 0.15, keep: 120 };

export function addBlast(world, o = {}) {
   let r = o.r;
   if (!r || typeof r !== 'object') { const R = +(o.radius ?? o.r) || 3000; r = { destroyed: R * 0.25, heavy: R * 0.55, shock: R }; }
   const b = {
      id: o.id ?? world._nextId++, x: +o.x || 0, y: +o.y || 0, pos: null,
      r: { destroyed: +r.destroyed || 0, heavy: Math.max(+r.heavy || 0, +r.destroyed || 0), shock: Math.max(+r.shock || 0, +r.heavy || 0, +r.destroyed || 0) },
      t0: world.time + Math.max(0, +o.delay || 0), state: 'armed', age: 0, label: o.label || 'Detonation', hit: null,
   };
   b.pos = { x: b.x, y: b.y };
   world.blasts.push(b);
   return b;
}
// 0 outside, 1 shock, 2 heavy, 3 destroyed
export function blastBand(b, p) {
   const d = Math.hypot(p.x - b.x, p.y - b.y);
   return d <= b.r.destroyed ? 3 : d <= b.r.heavy ? 2 : d <= b.r.shock ? 1 : 0;
}

function detonate(world, b) {
   const hit = { ships: 0, sunk: 0, sites: 0, air: 0 };
   for (const s of world.ships.slice()) {
      if (!s.alive) continue;
      let band = blastBand(b, s.pos);
      if (band && s.depth === 2) band--;
      if (!band) continue;
      hit.ships++;
      if (band === 3) s.takeDamage(s.hp + 1, null, 'blast', 0);
      else if (band === 2) {
         s.takeDamage(s.maxHP * BLAST.heavy, null, 'blast', 0.2);
         if (s.alive) {
            if (s.modules) { s.modules.engine = Math.max(s.modules.engine || 0, 20); s.modules.rudder = Math.max(s.modules.rudder || 0, 20); }
            if (!(s.depth > 0)) { s.ignite(0, null); s.ignite(2, null); }
         }
      } else {
         s.takeDamage(s.maxHP * BLAST.shock, null, 'blast', 0.5);
         if (s.alive) { s.radarOn = false; s.jamming = false; }
      }
      if (!s.alive) hit.sunk++;
   }
   for (const s of world.sites) {
      if (!s.alive) continue;
      const band = blastBand(b, s);
      if (!band) continue;
      hit.sites++;
      damageSite(world, s, band === 3 ? s.hp + 1 : s.maxHp * (band === 2 ? BLAST.heavy : BLAST.shock), null, 'blast');
      if (s.alive && band === 1) s.radarOn = false;
   }
   for (const q of world.squadrons) {
      if (q.n <= 0 || q.state === 'land' || blastBand(b, q.pos) < 2) continue;
      for (let i = q.n + 1; i > 0 && q.n > 0; i--) { hurtSquad(world, q, q.hp + 1, null); hit.air++; }
   }
   for (const h of world.helos.slice()) if (h.alive && blastBand(b, h.pos) >= 2 && killHelo(world, h, null, 'blast')) hit.air++;
   for (const m of world.missiles) if (m.alive && blastBand(b, m) >= 2) m.alive = false;
   for (const t of world.teams) if (blastBand(b, t) >= 2) loseTeam(world, t, 'blast');
   b.state = 'done'; b.hit = hit; b.age = 0;
   world.addEffect('detonation', b.pos, 6, b.r.heavy, { big: true, blast: true, blastId: b.id });
   if (world.shakeAdd && world.player && blastBand(b, world.player.pos)) world.shakeAdd(3);
   world.pushEvent('blast', { blastId: b.id, pos: { x: b.x, y: b.y }, r: { ...b.r }, hit, text: b.label });
   if (world._script && world._script.onBlast) world._script.onBlast(world, b);
}

export function updateBlasts(world, dt) {
   const bs = world.blasts;
   if (!bs.length) return;
   let old = false;
   for (const b of bs) {
      if (b.state === 'armed') { if (world.time >= b.t0) detonate(world, b); }
      else { b.age += dt; if (b.age > BLAST.keep) old = true; }
   }
   if (old) world.blasts = bs.filter(b => b.state === 'armed' || b.age <= BLAST.keep);
}
