// Shared helpers of the V2 tests and the balance harness: an empty sea to place ships on.
import { World } from '../gamev2/state.js';

// A world without mission logic, islands or other ships: only the player's ship at the origin.
// opts: { ship, seed, arena, difficulty }.
export function emptySea(opts = {}) {
   const w = new World(opts.difficulty || 'normal', { mission: 'training', ship: opts.ship || 'Sachsen', seed: opts.seed ?? 1 });
   const p = w.player;
   w.ships = [p]; w.roster = [p]; w.bots = [];
   w._byId = new Map([[p.id, p]]);
   w.obstacles = [];
   w.sites = []; w.missiles = []; w.decoys = [];
   w.arena = opts.arena || 40000;
   w.timeLeft = null;
   w.mission.objectives = [];
   w._script = { def: { timeout() {} }, timers: [], used: new Set(), dup: 0, onSink() {} };
   p.pos.x = 0; p.pos.y = 0; p.heading = 0; p.telegraph = 0; p.speed = 0;
   w.events.length = 0;
   return w;
}
// Spawn a ship; without opts.ai it is a bot with the default AI, { passive: true } keeps it harmless.
export function put(w, cls, side, x, y, heading = 0, opts = {}) {
   return w.spawn(cls, side, { x, y }, heading, { telegraph: 0, ...opts });
}
export function island(w, x, y, r = 1500, height = 200) {
   return w.addIsland({ c: { x, y }, r, height, seed: 3, lobes: 5, rough: 0.2 });
}
export function run(w, secs, each) {
   const n = Math.round(secs * 60);
   for (let i = 0; i < n; i++) { w.update(1 / 60); if (each && each(w) === false) break; }
   return w;
}
