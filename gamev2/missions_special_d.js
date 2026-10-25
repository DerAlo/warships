// gamev2/missions_special_d.js — special operations of the modern mode, set D (fictional present-day
// scenarios):
//    mayday     Seenot vor Kap Korsk: a downed aircrew drifts in a life raft towards a hostile coast in a storm;
//               winch them up with the ship's helicopter (it must land back on deck) or pick them up with the
//               ship, before the boats from the coast take them. A frigate with SAMs makes the air deadly.
//    gunline    Feuerunterstützung Mereth: naval gunfire support at night. Fire missions on positions ashore
//               open one after the other, each with a time window; the guns must destroy the target in it.
//               Boats come out of the harbour, a hidden battery opens up halfway.
//    airbase    Flugplatz Serin: strike an airfield with cruise missiles before it launches a mass raid, under
//               its own air attacks; its SAM sites are hidden until they fire. The replenishment ship of the
//               group must survive.
// Each definition has the shape of missions.js DEFS; H = missionHelpers. Everything a mission keeps between
// ticks lives in world._script (S) as plain data and refers to ships and sites by id. The script logic runs
// on a half-second tick (no per-frame work, no per-frame allocations).
// Convention of the mission files: merchant ships are protected, never targets. They sail on the player's
// side with `civilian()` (the opposing side never sees them, so no AI aims at them); a merchant that is
// hit hard (shells or missiles of the player's own side) loses the mission.
// Balance: SPECIAL_D_TUNE holds the knobs per mission and difficulty (tests/v2.missions.specialc.test.mjs
// measures them with the bot captain of tests/v2.missions.speciald.captain.mjs).
import { addSite } from './sites.js';
import { heloOf, recallHelo } from './helo.js';
import { islandReliefAt } from './utils.js';

export const SPECIAL_D_TUNE = {
   mayday: {
      // hoist: s the helicopter hovers over the raft · pick: s the ship lies alongside the raft · drift: m/s the raft
      // drifts towards the coast · boats / boatsAt: first pack from the coast and its time · grabbers: boats of each
      // pack that go for the raft (the others hunt the ship) · msl: boats per pack with Kowsar missiles · wave2 /
      // wave2At: second pack · grab: s an enemy boat needs at the raft to take the crew · frig / frigAt / frigHp / frigSsm: the
      // frigate (0 = none), its time, hull factor and anti-ship missiles · fast: s for the optional quick rescue
      easy: { hoist: 18, pick: 35, drift: 1.2, boats: 3, boatsAt: 70, grabbers: 1, msl: 0, wave2: 2, wave2At: 260, grab: 50, frig: 0, frigAt: 0, frigHp: 0.6, frigSsm: 0, fast: 300 },
      normal: { hoist: 25, pick: 50, drift: 1.5, boats: 4, boatsAt: 45, grabbers: 2, msl: 2, wave2: 3, wave2At: 230, grab: 28, frig: 1, frigAt: 150, frigHp: 0.6, frigSsm: 2, fast: 240 },
      hard: { hoist: 30, pick: 60, drift: 1.8, boats: 4, boatsAt: 35, grabbers: 2, msl: 2, wave2: 5, wave2At: 170, grab: 26, frig: 1, frigAt: 100, frigHp: 0.8, frigSsm: 4, fast: 210 },
   },
   gunline: {
      // n: fire missions · miss: missions that may be missed · first: s until the first window · win: s a window stays
      // open · gap: s between two windows · hp: hull of a target position (the difficulty's botHP on top) · waves: boats
      // that come out of the harbour when mission 1, 2, ... opens · msl: boats of each pack with Kowsar missiles ·
      // batAt: mission at whose opening the hidden battery opens fire (0 = never) · batN / batInt: its missiles and
      // the s between its salvos · ship: knobs per flagship class (a 76 mm gun does a third of a 127 mm round)
      easy: { n: 4, miss: 2, first: 50, win: 120, gap: 20, hp: 1500, waves: [1, 2, 1, 2], msl: 0, batAt: 0, batN: 0, batInt: 40,
         ship: { Sachsen: { hp: 900 }, Braunschweig: { hp: 900 } } },
      normal: { n: 5, miss: 1, first: 45, win: 80, gap: 15, hp: 3000, waves: [2, 3, 2, 3, 2], msl: 1, batAt: 3, batN: 6, batInt: 34,
         ship: { Sachsen: { hp: 1300 }, Braunschweig: { hp: 1300 } } },
      hard: { n: 5, miss: 0, first: 40, win: 78, gap: 12, hp: 2600, waves: [3, 3, 3, 4, 3], msl: 1, batAt: 2, batN: 10, batInt: 28,
         ship: { Sachsen: { hp: 1400 }, Braunschweig: { hp: 1400 } } },
   },
   airbase: {
      // deadline: s until the mass raid takes off (the airfield must be down by then) · fieldHp: hull of the airfield ·
      // samN: missiles of each SAM site · sams: SAM sites · raid / raidAt: s between two raids of the airfield and the
      // first one · tanker: hull factor of the replenishment ship · tlam: cruise missiles aboard the player's ship (0 = full load)
      easy: { deadline: 480, fieldHp: 9000, sams: 1, samN: 8, raid: 80, raidAt: 90, tanker: 1.4, tlam: 0 },
      normal: { deadline: 400, fieldHp: 14000, sams: 2, samN: 20, raid: 55, raidAt: 60, tanker: 1, tlam: 10 },
      hard: { deadline: 360, fieldHp: 17000, sams: 2, samN: 24, raid: 45, raidAt: 45, tanker: 0.9, tlam: 12 },
   },
};
// mayday: hoistR m the hovering helicopter may be off the raft · pickR / pickKn: the ship within that distance at no
// more than that speed picks the crew up · clear m: no armed boat that close (it shoots at the swimmers) · grabR m:
// an enemy boat that close to the raft stops and hauls the crew aboard · merch: hull share below which the merchant
// counts as hit
export const MAYDAY = { hoistR: 180, pickR: 300, pickKn: 5, clear: 1500, grabR: 320, merch: 0.8 };
// gunline: merch as above · stand m: where the gunline station lies off a target (for the radio and the bot)
export const GUNLINE = { merch: 0.85, stand: 6000 };
// airbase: merch as above, the replenishment ship's name
export const AIRBASE = { merch: 0.85 };

export function specialMissionsD(H) {
   const { P, add, objective, setObj, objText, later, radio, zone, islands } = H;
   // (a row may carry `ship`: { class: knobs } for the flagship's class, merged over the row once per world)
   const tune = (w, id) => {
      const T = SPECIAL_D_TUNE[id], row = T[w.difficultyKey] || T.normal, S = w._script, o = row.ship && S && row.ship[S.shipKey];
      if (!o) return row;
      return S.tuneRow && S.tuneOf === row ? S.tuneRow : (S.tuneOf = row, S.tuneRow = { ...row, ...o });
   };
   const live = (w, id) => { const s = w.shipById(id); return s && s.alive ? s : null; };
   const siteOf = (w, id) => { for (const s of w.sites) if (s.id === id) return s; return null; };
   const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
   const mmss = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
   // a clock in an objective text: steps of 10 s until the last minute (the objectives band fades after a change)
   const coarse = (t) => mmss(t > 60 ? Math.ceil(t / 10) * 10 : Math.max(0, t));
   const lim = (w) => ` (Zeitlimit ${mmss((defs.find(d => d.id === w.mission.id) || {}).timeLimit || 0)})`;
   const KN = 2.6;      // config WORLD.KN_TO_MS
   const rnd = (w, salt) => { const x = Math.sin((w.seed % 100000) * 12.9898 + salt * 78.233) * 43758.5453; return x - Math.floor(x); };
   // radio line that may come back, at most every `gap` seconds (key: a field of S)
   function nag(w, S, key, gap, from, text, level) {
      if (w.time < (S[key] || 0)) return;
      S[key] = w.time + gap;
      radio(w, from, text, level);
   }
   // the opposing side never sees a merchant: no AI aims at it, no missile is launched at it
   // the last land point on the ray from the island's centre at angle a, `back` m inland of it (setup only)
   const shore = (w, isl, a, back) => {
      const c = Math.cos(a), s = Math.sin(a);
      let r = 0;
      for (let k = 0; k < isl.r * 4; k += 25) if (islandReliefAt(isl, { x: isl.c.x + c * k, y: isl.c.y + s * k }) > 0) r = k;
      return P(isl.c.x + c * Math.max(0, r - back), isl.c.y + s * Math.max(0, r - back));
   };
   const civilian = (ship) => {
      Object.defineProperty(ship, 'detected', { get: () => false, set() {}, configurable: true });
      Object.defineProperty(ship, 'targetable', { get: () => false, set() {}, configurable: true });
      return ship;
   };
   // half-second script tick: returns the elapsed time when a tick is due, else 0
   const tick = (S, dt) => { S.acc += dt; if (S.acc < 0.5) return 0; const st = S.acc; S.acc = 0; return st; };
   // the end of the mission, once
   const finish = (w, S, won, text) => { if (S.over) return; S.over = true; w.end(won, text); };
   // merchant rule: a merchant of the list that sank or lost more than `share` of its hull ends the mission
   function merchantsHit(w, S, ids, share) {
      for (const id of ids) {
         const m = w.shipById(id);
         if (!m || !m.alive || m.hp < m.maxHP * share) return m || true;
      }
      return null;
   }
   // boat of the coast: a Boghammar with or without its Kowsar missile
   const boat = (w, pos, hdg, msl, ai, o = {}) => {
      const b = add(w, 'Boghammar', 'enemy', pos, hdg, { telegraph: 4, hpMult: (o.hp || 1) * w.difficulty.botHP, minDist: o.minDist || 0, ai });
      if (!msl) b.mag.kowsar = 0;
      return b;
   };

   const defs = [
      // --------------------------------------------------------------------- Seenot vor Kap Korsk
      // The rule: the crew is saved when the helicopter has hovered over the raft for `hoist` s with no armed boat
      // near and then landed on its ship again, or when the ship itself lies alongside the raft for `pick` s. An
      // enemy boat that reaches the raft stops there and hauls the crew aboard in `grab` s unless it is sunk first.
      // S.crew: 'raft' | 'helo' (in the helicopter on its way home) | 'safe' | 'lost'
      {
         id: 'mayday', group: 'ops', name: 'Seenot vor Kap Korsk', subtitle: 'Sondereinsatz · Abgeschossene Besatzung im Sturm bergen',
         briefing: 'Bei Tagesanbruch ist der Seefernaufklärer „Kondor 21" vor Kap Korsk ins Meer gestürzt. Vier Besatzungsmitglieder treiben ' +
            'in einer Rettungsinsel durch den Sturm, und der Wind drückt sie Stunde um Stunde auf die feindliche Küste zu. Der Frachter MS Hallig ' +
            'Express hat den Notruf aufgefangen und liegt in der Nähe, kann im Seegang aber nicht helfen. Von der Küste laufen Schnellboote aus, ' +
            'die die Flieger gefangen nehmen sollen. Bergen Sie die Besatzung: Schicken Sie den Bordhubschrauber über die Rettungsinsel. Er ' +
            'schwebt dort und winscht die vier auf, solange kein Boot in der Nähe ist, und muss danach wieder auf Ihrem Deck landen. Oder nehmen ' +
            'Sie sie mit dem Schiff selbst auf: unter 300 m an die Insel, höchstens 5 Knoten. Eine Fregatte mit Flugabwehrraketen ist ' +
            'unterwegs – in ihrer Reichweite ist der Hubschrauber leichte Beute. Der Frachter darf nicht zu Schaden kommen.',
         debrief: 'Die vier Flieger der Kondor 21 sind an Bord – unterkühlt, aber am Leben. Die Schnellboote drehen ab, die Hallig Express ' +
            'setzt ihre Reise fort. Entschieden hat die Reihenfolge: erst die Boote von der Insel fernhalten, dann bergen.',
         fleet: { own: 'Flaggschiff mit Bordhubschrauber', foe: 'Schnellboote, 1 Fregatte' },
         env: { time: 'dawn', weather: 'storm' }, type: 'ops', playableShips: ['Sachsen', 'Daring', 'Burke'],
         recommendedShip: 'Sachsen', arena: 20000, timeLimit: 600, stars: 2,
         setup(w, shipKey) {
            const S = w._script; S.shipKey = shipKey; S.acc = 0; const T = tune(w, 'mayday');
            islands(w, [
               { c: P(15200, -1500), r: 3600, height: 320, seed: 211, lobes: 6, elong: 2.2, rot: 1.45, rough: 0.6, name: 'Kap Korsk' },
               { c: P(-12500, -12500), r: 900, height: 120, seed: 213, lobes: 4, rough: 0.5 },
            ]);
            const p = add(w, shipKey, 'player', P(-9500, 3000), -0.35, { isPlayer: true, telegraph: 3 });
            S.coast = zone(w, 15200, -1500, 8200, 'Küstengewässer Korsk', 'danger');
            S.raft = zone(w, 900 + (rnd(w, 1) - 0.5) * 1600, -3200 + (rnd(w, 2) - 0.5) * 1600, 400, 'Rettungsinsel', 'goal');
            const a = Math.atan2(S.coast.y - S.raft.y, S.coast.x - S.raft.x);
            S.dx = Math.cos(a); S.dy = Math.sin(a);
            const m = civilian(add(w, 'Container', 'player', P(-2600, -6400), 0.5, { name: 'MS Hallig Express', telegraph: 0, ai: { passive: true, anchored: true } }));
            S.merch = [m.id];
            S.boats = []; S.grabbers = []; S.total = 0; S.sunk = 0; S.frigId = null;
            S.crew = 'raft'; S.hoist = 0; S.pick = 0; S.grab = 0; S.heloId = null; S.shown = '';
            w.score = { kind: 'count', player: 0, enemy: 0, target: 4 };
            const help = `Hubschrauber ${T.hoist} s über der Insel, oder Schiff unter ${MAYDAY.pickR} m bei höchstens ${MAYDAY.pickKn} kn, ${T.pick} s`;
            S.help = help;
            objective(w, 'rescue', `Bergen Sie die vier Flieger aus der Rettungsinsel (${help})` + lim(w));
            objective(w, 'merch', 'Die MS Hallig Express darf nicht zu Schaden kommen');
            objective(w, 'boats', 'Versenken Sie alle Schnellboote (0/0)', { optional: true });
            objective(w, 'fast', `Besatzung binnen ${mmss(T.fast)} geborgen`, { optional: true });
            later(S, 3, () => radio(w, 'Rettungsleitstelle', 'Mayday von Kondor 21: vier Mann in der Rettungsinsel, Position ist markiert. Der Wind treibt sie auf Kap Korsk zu. Sie sind das einzige Schiff in Reichweite.'));
            later(S, 12, () => radio(w, 'MS Hallig Express', 'Wir liegen beigedreht bei der Insel, aber bei dem Seegang bekommen wir niemanden an Bord. Beeilen Sie sich.'));
            later(S, 22, () => radio(w, 'Flugdeck', `Hubschrauber startklar. Schicken Sie ihn über die Rettungsinsel – er braucht ${T.hoist} Sekunden Schwebeflug für die Winde und muss danach zurück auf unser Deck.`));
            later(S, T.boatsAt, () => this.wave(w, S, T.boats, T.msl, 0));
            later(S, T.wave2At, () => this.wave(w, S, T.wave2, T.msl, 1));
            if (T.frig) later(S, T.frigAt, () => {
               if (S.over) return;
               const f = add(w, 'Typ054A', 'enemy', P(7500, -17500), Math.PI * 0.6,
                  { minDist: 11000, hpMult: T.frigHp * w.difficulty.botHP, telegraph: 3, ai: { route: [P(S.raft.x + 5200, S.raft.y - 2600)] } });
               f.mag.yj83 = Math.min(f.mag.yj83 || 0, T.frigSsm);
               S.frigId = f.id;
               radio(w, 'Luftlage', 'Eine Fregatte läuft aus dem Norden auf die Unfallstelle zu – Flugabwehrraketen an Bord. Halten Sie den Hubschrauber aus ihrer Reichweite oder bergen Sie vorher.', 'warn');
            });
            void p;
         },
         // a pack of boats from the coast: `grabbers` go for the raft, the others hunt the ship
         wave(w, S, n, msl, k) {
            if (S.over || !n) return;
            const T = tune(w, 'mayday'), p = w.player;
            let g = 0;
            for (let i = 0; i < n; i++) {
               const grab = S.crew === 'raft' && g < T.grabbers;
               const pos = P(9800 - (i % 3) * 300, -1500 + (k ? -2600 : 2200) + i * 500);
               const b = boat(w, pos, Math.PI, i < msl, grab ? { route: [S.raft] } : { huntId: p.id, press: true }, { minDist: 6000 });
               S.boats.push(b.id);
               if (grab) { S.grabbers.push(b.id); g++; }
            }
            S.total += n;
            objText(w, 'boats', `Versenken Sie alle Schnellboote (${S.sunk}/${S.total})`);
            radio(w, 'Luftlage', `${n} Schnellboote laufen von Kap Korsk aus${g ? ` – ${g === 1 ? 'eines hält' : g + ' halten'} direkt auf die Rettungsinsel zu` : ''}.`, 'warn');
         },
         update(w, dt, S) {
            if (S.over) return;
            const st = tick(S, dt);
            if (!st) return;
            const T = tune(w, 'mayday'), p = w.player, R = S.raft;
            if (merchantsHit(w, S, S.merch, MAYDAY.merch)) {
               setObj(w, 'merch', 'failed');
               return finish(w, S, false, 'Die MS Hallig Express ist getroffen – ein Handelsschiff unter Beschuss beendet den Einsatz.');
            }
            if (S.crew === 'raft') {
               R.x += S.dx * T.drift * st; R.y += S.dy * T.drift * st;
               if (dist(R, S.coast) < S.coast.r) { setObj(w, 'rescue', 'failed'); return finish(w, S, false, 'Die Rettungsinsel ist in die Küstengewässer getrieben – die Besatzung ist in Gefangenschaft.'); }
            }
            // boats at the raft: the grabbers stop there and haul the crew aboard
            let near = Infinity, atRaft = 0;
            for (const id of S.boats) {
               const b = live(w, id);
               if (!b) continue;
               const d = dist(b.pos, R);
               if (d < near) near = d;
               if (S.crew === 'raft' && d < MAYDAY.grabR && S.grabbers.includes(id)) { atRaft++; if (!b.ai.anchored) b.ai.anchored = true; }
            }
            if (S.crew === 'raft') {
               if (atRaft) {
                  if (S.grab === 0) radio(w, 'Rettungsleitstelle', 'Ein Schnellboot liegt an der Rettungsinsel und zieht die Flieger an Bord – versenken Sie es!', 'warn');
                  S.grab += st;
                  if (S.grab >= T.grab) { setObj(w, 'rescue', 'failed'); return finish(w, S, false, 'Die Schnellboote haben die Besatzung der Kondor 21 an Bord genommen.'); }
               } else S.grab = Math.max(0, S.grab - st * 0.5);
            }
            // the helicopter over the raft
            const h = heloOf(w, p);
            if (S.crew === 'raft' && h && h.state !== 'return') {
               if (h.mode === 'point' && dist(h.goal, R) < 1200) { h.goal.x = R.x; h.goal.y = R.y; }      // the pilot keeps over the drifting raft
               if (h.state === 'dip' && dist(h.pos, R) < MAYDAY.hoistR) {
                  if (near < MAYDAY.clear * 0.6) nag(w, S, 'nagHoist', 15, 'Hubschrauber', 'Beschuss von einem Boot – Winde gestoppt! Halten Sie uns die Boote vom Leib.', 'warn');
                  else {
                     if (S.hoist === 0) radio(w, 'Hubschrauber', `Über der Insel. Winde läuft – wir brauchen ${T.hoist} Sekunden.`);
                     S.hoist += st;
                  }
                  if (S.hoist >= T.hoist) {
                     S.crew = 'helo'; S.heloId = h.id;
                     recallHelo(w, p);
                     radio(w, 'Hubschrauber', 'Alle vier an Bord! Wir kommen zurück – halten Sie das Deck klar.');
                  }
               }
            } else if (S.crew === 'raft' && S.hoist > 0 && (!h || h.state === 'return')) {
               S.hoist = 0;
               radio(w, 'Hubschrauber', 'Wir müssen abdrehen – die Winde ist eingeholt, die Besatzung noch im Wasser.', 'warn');
            }
            if (S.crew === 'helo') {
               let alive = false;
               for (const x of w.helos) if (x.id === S.heloId && x.alive) { alive = true; if (x.state !== 'return') x.state = 'return'; break; }
               if (!alive) {
                  let lost = false;
                  for (let i = w.events.length - 1; i >= 0; i--) {
                     const e = w.events[i];
                     if (e.heloId !== S.heloId || (e.type !== 'heloLanded' && e.type !== 'heloLost')) continue;
                     lost = e.type === 'heloLost'; break;
                  }
                  if (lost || !p.alive) { S.crew = 'lost'; setObj(w, 'rescue', 'failed'); return finish(w, S, false, 'Der Hubschrauber ist mit der geretteten Besatzung verloren.'); }
                  return this.win(w, S, 'Der Hubschrauber ist gelandet – die vier Flieger sind an Bord.');
               }
            }
            // the ship alongside the raft
            if (S.crew === 'raft' && p.alive) {
               const d = dist(p.pos, R), kn = Math.abs(p.speed) / KN;
               if (d < MAYDAY.pickR && kn <= MAYDAY.pickKn + 0.3 && near > MAYDAY.clear) {
                  if (S.pick === 0) radio(w, 'Bootsmann', `Längsseits der Insel. Netz ist ausgebracht – ${T.pick} Sekunden, halten Sie das Schiff ruhig.`);
                  S.pick += st;
                  if (S.pick >= T.pick) return this.win(w, S, 'Die Rettungsinsel ist längsseits – die vier Flieger sind an Bord.');
               } else {
                  if (d < MAYDAY.pickR * 2 && kn > MAYDAY.pickKn + 0.3) nag(w, S, 'nagSlow', 15, 'Bootsmann', `Zu schnell für das Netz – unter ${MAYDAY.pickKn} Knoten, bitte.`);
                  else if (d < MAYDAY.pickR * 2 && near <= MAYDAY.clear) nag(w, S, 'nagBoat', 15, 'Bootsmann', 'Ein Boot ist zu nah – wir können das Netz nicht ausbringen, solange geschossen wird.', 'warn');
                  S.pick = Math.max(0, S.pick - st);
               }
            }
            // progress in the objective text (changes rarely)
            const txt = S.crew === 'helo' ? 'Besatzung im Hubschrauber – er muss auf Ihrem Deck landen'
               : S.hoist > 0 ? `Winde läuft (${Math.min(T.hoist, Math.floor(S.hoist))}/${T.hoist} s)`
               : S.pick > 0 ? `Netz ausgebracht (${Math.min(T.pick, Math.floor(S.pick))}/${T.pick} s)`
               : S.grab > 0 ? `Feindboot an der Insel! (Gefangennahme ${Math.min(99, Math.round(S.grab / T.grab * 100))} %)` : S.help;
            if (txt !== S.shown) { S.shown = txt; objText(w, 'rescue', `Bergen Sie die vier Flieger aus der Rettungsinsel (${txt})` + lim(w)); }
         },
         win(w, S, text) {
            S.crew = 'safe';
            w.score.player = 4;
            setObj(w, 'rescue', 'done'); setObj(w, 'merch', 'done');
            if (w.time <= tune(w, 'mayday').fast) setObj(w, 'fast', 'done'); else setObj(w, 'fast', 'failed');
            if (S.total > 0 && S.sunk >= S.total) setObj(w, 'boats', 'done');
            radio(w, 'Rettungsleitstelle', 'Kondor 21 ist geborgen. Gut gemacht – bringen Sie sie nach Hause.');
            finish(w, S, true, text);
         },
         onSink(w, ship, killer, S) {
            if (S.over) return;
            if (ship.id === w.player.id) { setObj(w, 'rescue', 'failed'); return finish(w, S, false, 'Ihr Schiff ist gesunken – niemand kann die Flieger mehr bergen.'); }
            if (S.merch.includes(ship.id)) { setObj(w, 'merch', 'failed'); return finish(w, S, false, 'Die MS Hallig Express ist gesunken.'); }
            if (ship.id === S.frigId) { radio(w, 'Luftlage', 'Die Fregatte sinkt – der Luftraum über der Insel ist frei.'); return; }
            if (S.boats.includes(ship.id)) {
               S.sunk++;
               objText(w, 'boats', `Versenken Sie alle Schnellboote (${S.sunk}/${S.total})`);
               if (S.grabbers.includes(ship.id) && S.grab > 0) { S.grab = 0; radio(w, 'Rettungsleitstelle', 'Das Boot an der Insel ist erledigt – die Flieger sind noch frei.'); }
            }
         },
         timeout(w, S) { setObj(w, 'rescue', 'failed'); finish(w, S, false, 'Die Zeit ist abgelaufen – die Besatzung hat die Kälte nicht überlebt.'); },
      },
      // --------------------------------------------------------------------- Feuerunterstützung Mereth
      // The rule: the forward observer calls fire missions one after the other. A mission opens with a time window
      // (the target is shown on the chart then); destroyed in it = done, the window closed = missed. More than `miss`
      // missed missions lose. The guns are the weapon: the positions are dug in, only shells that land on them count.
      // S.k: index of the open mission (-1 before the first) · S.open: its window is open · S.dead / S.missed: counts
      {
         id: 'gunline', group: 'ops', name: 'Feuerunterstützung Mereth', subtitle: 'Nachteinsatz · Feueraufträge gegen Stellungen an Land',
         briefing: 'Eigene Landungskräfte haben im Schutz der Nacht einen Brückenkopf an der Küste von Mereth gebildet. Sie haben keine ' +
            'Artillerie an Land – Ihr Geschütz ist ihre einzige Feuerunterstützung. Der vorgeschobene Beobachter „Falke" ruft Feueraufträge ' +
            'nacheinander auf: Mörserstellungen, Panzerabwehr, einen Gefechtsstand. Jeder Auftrag hat ein Zeitfenster; mit seinem Beginn ' +
            'erscheint das Ziel auf der Karte. Zerstören Sie es mit dem Hauptgeschütz, bevor das Fenster schließt – nur Granaten, die in der ' +
            'Stellung einschlagen, zählen. Aus dem Hafen im Westen laufen Schnellboote aus, und irgendwo an der Küste steht eine Batterie, die ' +
            'noch schweigt. Auf der Reede liegt der neutrale Frachter MS Seewind vor Anker: Er darf nicht getroffen werden. Es regnet, die ' +
            'Sicht ist schlecht – halten Sie die Augen auf dem Radar.',
         debrief: 'Falke meldet: Brückenkopf hält, alle Stellungen im Abschnitt sind niedergekämpft. Die Landungskräfte rücken bei ' +
            'Tagesanbruch vor. Saubere Arbeit an der Feuerlinie.',
         fleet: { own: 'Flaggschiff', foe: 'Stellungen an Land, Schnellboote, 1 Küstenbatterie' },
         env: { time: 'night', weather: 'rain' }, type: 'ops', playableShips: ['Daring', 'Sachsen', 'Braunschweig'],
         recommendedShip: 'Daring', arena: 18000, timeLimit: 720, stars: 2,
         setup(w, shipKey) {
            const S = w._script; S.shipKey = shipKey; S.acc = 0; const T = tune(w, 'gunline');
            islands(w, [
               { c: P(0, -12600), r: 5000, height: 150, seed: 307, lobes: 7, elong: 3.0, rot: 0, rough: 0.55, name: 'Mereth' },
               { c: P(13000, 11500), r: 800, height: 90, seed: 311, lobes: 4, rough: 0.5 },
            ]);
            const isl = w.obstacles[0];
            add(w, shipKey, 'player', P(-1500, 3500), -Math.PI / 2, { isPlayer: true, telegraph: 3 });
            // the targets along the south coast (addSite puts each on the coast on the ray from the island's centre)
            const NAMES = ['Panzerabwehr am Strand', 'Mörserstellung West', 'Mörserstellung Ost', 'Beobachtungsbunker', 'Gefechtsstand'];
            const X = [-2400, -6000, 2200, 5600, 300];
            S.targets = [];
            for (let i = 0; i < T.n; i++) {
               // 120 m inland of the south coast straight north of x (the coast is ragged; the ray from the centre would scatter them)
               const x = X[i % X.length];
               let y = isl.c.y;
               for (let yy = isl.c.y; yy < isl.c.y + isl.r * 2; yy += 25) if (islandReliefAt(isl, { x, y: yy }) > 0) y = yy;
               const s = addSite(w, 'bunker', 'enemy', P(x, y - 120), { name: NAMES[i % NAMES.length], hp: T.hp, r: 90, hidden: true, inland: true });
               S.targets.push(s.id);
            }
            // the hidden battery on the western shoulder, the harbour of the boats beyond it
            S.batId = addSite(w, 'battery', 'enemy', P(-12000, isl.c.y + 400), { name: 'Küstenbatterie Mereth', hidden: true, radarOn: false, delay: 1e9, interval: T.batInt, ssm: { type: 'noor', n: Math.max(1, T.batN) } }).id;
            S.harbour = P(-15500, -6200);
            const m = civilian(add(w, 'Container', 'player', P(8800, -3200), 0.15, { name: 'MS Seewind', telegraph: 0, ai: { passive: true, anchored: true } }));
            S.merch = [m.id];
            S.k = -1; S.open = false; S.closeT = 0; S.nextT = T.first; S.dead = 0; S.missed = 0;
            S.boats = []; S.total = 0; S.sunk = 0; S.shown = '';
            w.score = { kind: 'count', player: 0, enemy: 0, target: T.n };
            objective(w, 'fire', `Erfüllen Sie die Feueraufträge (0/${T.n}, höchstens ${T.miss} verfehlt)` + lim(w));
            objective(w, 'merch', 'Der neutrale Frachter MS Seewind darf nicht getroffen werden');
            objective(w, 'all', 'Kein Feuerauftrag verfehlt', { optional: true });
            if (T.batAt) objective(w, 'bat', 'Schalten Sie die Küstenbatterie aus', { optional: true });
            later(S, 3, () => radio(w, 'Falke', `Hier Falke. Brückenkopf steht, wir liegen unter Mörserfeuer. Erster Feuerauftrag in etwa ${Math.round(T.first / 10) * 10} Sekunden – bringen Sie Ihr Schiff auf Schussweite an die Küste.`));
            later(S, 14, () => radio(w, 'Operationszentrale', `Jede Stellung ist eingegraben: Nur Granaten, die in ihr einschlagen, zählen. Ihr Geschütz trägt ${(w.player.cfg.main.range / 1000).toFixed(1).replace('.', ',')} km. Auf der Reede liegt die MS Seewind – Vorsicht mit dem Schussfeld.`));
         },
         update(w, dt, S) {
            if (S.over) return;
            const st = tick(S, dt);
            if (!st) return;
            const T = tune(w, 'gunline');
            if (merchantsHit(w, S, S.merch, GUNLINE.merch)) {
               setObj(w, 'merch', 'failed');
               return finish(w, S, false, 'Die MS Seewind ist getroffen – Feuer auf ein neutrales Handelsschiff beendet den Einsatz.');
            }
            if (S.open) {
               const left = S.closeT - w.time;
               if (left <= 0) {
                  S.open = false; S.missed++;
                  const s = siteOf(w, S.targets[S.k]);
                  if (s) { s.detected = s.targetable = false; }
                  setObj(w, 'all', 'failed');
                  if (S.missed > T.miss) { setObj(w, 'fire', 'failed'); return finish(w, S, false, 'Zu viele Feueraufträge verfehlt – der Brückenkopf kann sich nicht halten.'); }
                  radio(w, 'Falke', `Zeitfenster abgelaufen – ${s ? s.name : 'das Ziel'} feuert weiter. Wir gehen in Deckung. Nächster Auftrag folgt.`, 'warn');
                  S.nextT = w.time + T.gap;
               } else if (left <= 30 && !S.warned) { S.warned = true; radio(w, 'Falke', 'Noch dreißig Sekunden für diesen Auftrag!', 'warn'); }
            } else if (S.k + 1 < T.n && w.time >= S.nextT) this.openMission(w, S, S.k + 1);
            else if (S.k + 1 >= T.n && !S.open) {
               setObj(w, 'fire', 'done'); setObj(w, 'merch', 'done');
               if (S.missed === 0) setObj(w, 'all', 'done');
               radio(w, 'Falke', 'Alle Ziele bekämpft. Feuer einstellen – danke, Marine!');
               return finish(w, S, true, `Feueraufträge erfüllt: ${S.dead} von ${T.n}.`);
            }
            const txt = S.open ? `Auftrag ${S.k + 1}: ${siteOf(w, S.targets[S.k]).name}, noch ${coarse(S.closeT - w.time)}` : S.k < 0 ? 'erster Auftrag folgt' : 'nächster Auftrag folgt';
            if (txt !== S.shown) { S.shown = txt; objText(w, 'fire', `Erfüllen Sie die Feueraufträge (${S.dead}/${T.n}, ${S.missed}/${T.miss} verfehlt – ${txt})` + lim(w)); }
         },
         openMission(w, S, k) {
            const T = tune(w, 'gunline'), s = siteOf(w, S.targets[k]);
            S.k = k; S.open = true; S.warned = false; S.closeT = w.time + T.win;
            s.detected = s.targetable = true;
            radio(w, 'Falke', `Feuerauftrag ${k + 1}: ${s.name}, auf der Karte markiert. Zeitfenster ${mmss(T.win)}. Feuer frei!`, 'warn');
            const n = T.waves[k] || 0;
            if (n) {
               for (let i = 0; i < n; i++) {
                  const b = boat(w, P(S.harbour.x + (i % 2) * 400, S.harbour.y + i * 350), 0.4, i < T.msl, { huntId: w.player.id, press: true }, { minDist: 5000 });
                  S.boats.push(b.id);
               }
               S.total += n;
               radio(w, 'Operationszentrale', `${n === 1 ? 'Ein Schnellboot läuft' : n + ' Schnellboote laufen'} aus dem Hafen im Westen aus.`, 'warn');
            }
            if (T.batAt && k + 1 === T.batAt) {
               const b = siteOf(w, S.batId);
               if (b && b.alive) {
                  b.radarOn = true; b.detected = b.targetable = true; b.nextT = 10;
                  radio(w, 'Operationszentrale', 'Feuerleitradar an der Westküste! Die Küstenbatterie von Mereth geht auf Sendung – rechnen Sie mit Flugkörpern. Sie steht jetzt auf der Karte.', 'warn');
               }
            }
         },
         onSiteDestroyed(w, site, by, S) {
            if (S.over) return;
            if (site.id === S.batId) { setObj(w, 'bat', 'done'); radio(w, 'Operationszentrale', 'Die Küstenbatterie ist ausgeschaltet.'); return; }
            const i = S.targets.indexOf(site.id);
            if (i < 0) return;
            if (S.open && i === S.k) {
               S.open = false; S.dead++; w.score.player = S.dead;
               S.nextT = w.time + tune(w, 'gunline').gap;
               radio(w, 'Falke', `Ziel zerstört! ${site.name} schweigt. ${S.k + 1 < tune(w, 'gunline').n ? 'Nächster Auftrag folgt.' : ''}`);
            }
         },
         onSink(w, ship, killer, S) {
            if (S.over) return;
            if (ship.id === w.player.id) { setObj(w, 'fire', 'failed'); return finish(w, S, false, 'Ihr Schiff ist gesunken – der Brückenkopf ist ohne Feuerunterstützung.'); }
            if (S.merch.includes(ship.id)) { setObj(w, 'merch', 'failed'); return finish(w, S, false, 'Die MS Seewind ist gesunken.'); }
            if (S.boats.includes(ship.id)) S.sunk++;
         },
         timeout(w, S) { setObj(w, 'fire', 'failed'); finish(w, S, false, 'Die Zeit ist abgelaufen – die Landungskräfte müssen sich zurückziehen.'); },
      },
      // --------------------------------------------------------------------- Flugplatz Serin
      // The rule: the airfield must be destroyed before `deadline` s (its mass raid takes off then). It flies raids at
      // the group meanwhile. Its SAM sites are hidden until they fire (then they are located and can be struck).
      // The replenishment ship must not be lost, the neutral merchants in the lane must not be hit.
      {
         id: 'airbase', group: 'ops', name: 'Flugplatz Serin', subtitle: 'Sondereinsatz · Flugplatz mit Marschflugkörpern ausschalten',
         briefing: 'Auf der Insel Serin zieht das Regime seine Kampfflugzeuge für einen Großangriff auf die Hafenstadt Lessa zusammen. Die Aufklärung ' +
            'sagt: In wenigen Minuten starten sie. Ihr Verband ist der einzige in Reichweite. Zerstören Sie den Flugplatz mit Marschflugkörpern, ' +
            'bevor der Großangriff abhebt – ein einzelner Treffer reicht nicht, die Startbahn ist gehärtet. Der Flugplatz wird Ihren Verband ' +
            'mit Jagdbombern angreifen; der Versorger Hiddensee, der Sie begleitet, darf nicht verloren gehen. Flugabwehrstellungen auf der Insel ' +
            'sind nicht geortet – sie verraten sich erst, wenn sie auf Ihre Flugkörper schießen. Durch das Gebiet führt ein Schifffahrtsweg: ' +
            'Die neutralen Frachter dürfen nicht getroffen werden.',
         debrief: 'Der Flugplatz Serin brennt, die Startbahn ist zerstört. Der Großangriff auf Lessa findet nicht statt. Der Versorger hat ' +
            'den Tag überstanden – und mit ihm Ihr Verband.',
         fleet: { own: 'Flaggschiff, 1 Fregatte, Versorger', foe: 'Flugplatz mit Jagdbombern, Flugabwehrstellungen' },
         env: { time: 'day', weather: 'overcast' }, type: 'ops', playableShips: ['Burke', 'Ticonderoga'],
         recommendedShip: 'Burke', arena: 26000, timeLimit: 540, stars: 3,
         setup(w, shipKey) {
            const S = w._script; S.shipKey = shipKey; S.acc = 0; const T = tune(w, 'airbase');
            islands(w, [
               { c: P(18500, 1500), r: 4600, height: 340, seed: 401, lobes: 7, elong: 1.7, rot: 1.3, rough: 0.6, name: 'Serin' },
               { c: P(-4000, -16000), r: 1100, height: 140, seed: 403, lobes: 5, rough: 0.5 },
               { c: P(2000, 17500), r: 900, height: 110, seed: 405, lobes: 4, rough: 0.5 },
            ]);
            const isl = w.obstacles[0];
            const p = add(w, shipKey, 'player', P(-4000, 2500), 0, { isPlayer: true, telegraph: 3 });
            const esc = add(w, 'Sachsen', 'player', P(-5500, 4400), 0, { telegraph: 3, dmgMult: 0.6, ai: { escortId: p.id } });
            const tk = add(w, 'Tanker', 'player', P(-6500, 1200), 0, { name: 'Versorger Hiddensee', telegraph: 2, hpMult: T.tanker, ai: { passive: true, escortId: p.id } });
            S.own = [p.id, esc.id]; S.tankId = tk.id;
            if (T.tlam && p.mag.tomahawk != null) p.mag.tomahawk = Math.min(p.mag.tomahawk, T.tlam);
            // the neutral lane north to south, west of the island
            S.merch = [];
            const lane = [[3500, -21000, Math.PI / 2, 'MS Nordstern'], [6500, 19000, -Math.PI / 2, 'MS Lagune']];
            for (const [x, y, h, name] of lane) {
               const m = civilian(add(w, 'Container', 'player', P(x, y), h, { name, telegraph: 2, speedKn: 12, ai: { passive: true, route: [P(x + (h > 0 ? 1500 : -1500), -y)] } }));
               S.merch.push(m.id);
            }
            // the island: the airfield in the middle, the radar on the west coast, the SAM sites hidden on the coast
            const field = addSite(w, 'airfield', 'enemy', P(isl.c.x + 600, isl.c.y), { name: 'Flugplatz Serin', inland: true, hp: T.fieldHp, interval: T.raid, delay: T.raidAt });
            S.fieldId = field.id;
            S.radarId = addSite(w, 'radar', 'enemy', shore(w, isl, Math.PI, 120), { name: 'Radarstation Serin', inland: true }).id;
            S.depotId = addSite(w, 'bunker', 'enemy', P(isl.c.x + 900, isl.c.y + 1400), { name: 'Treibstofflager Serin', inland: true, hp: 5000, r: 90 }).id;
            S.sams = []; S.samN = T.samN;
            const SAMS = [[Math.PI + 0.5, 'Flugabwehr Nordwest'], [Math.PI - 0.5, 'Flugabwehr Südwest']];
            for (let i = 0; i < T.sams; i++) {
               const [a, name] = SAMS[i];
               S.sams.push(addSite(w, 'sam', 'enemy', shore(w, isl, a, 350), { name, hidden: true, inland: true, sam: { type: 'hq16', n: T.samN, ch: 2 } }).id);
            }
            S.shown = ''; S.said = 0; S.tankHit = false;
            w.score = { kind: 'count', player: 0, enemy: 0, target: 1 };
            objective(w, 'field', `Zerstören Sie den Flugplatz Serin vor dem Großangriff (Start in ${coarse(T.deadline)})` + lim(w));
            objective(w, 'tank', 'Der Versorger Hiddensee darf nicht verloren gehen, kein neutraler Frachter getroffen werden');
            objective(w, 'sam', `Schalten Sie die Flugabwehrstellungen aus (0/${T.sams})`, { optional: true });
            objective(w, 'depot', 'Zerstören Sie das Treibstofflager', { optional: true });
            later(S, 3, () => radio(w, 'Flottenkommando', `Der Großangriff auf Lessa startet in etwa ${Math.round(T.deadline / 60)} Minuten. Bis dahin muss die Startbahn von Serin zerstört sein. Marschflugkörper frei.` + (T.tlam ? ` Sie haben nur ${p.mag.tomahawk} an Bord – kein Schuss ins Blaue.` : '')));
            later(S, 15, () => radio(w, 'Operationszentrale', 'Flugabwehr auf Serin ist nicht geortet. Rechnen Sie damit, dass die erste Welle abgefangen wird – jede Stellung, die schießt, verrät sich.'));
            later(S, Math.max(20, T.raidAt - 15), () => radio(w, 'Luftlage', 'Bewegung auf dem Flugplatz Serin – Jagdbomber rollen zum Start. Flugabwehr klar!', 'warn'));
            void esc;
         },
         update(w, dt, S) {
            if (S.over) return;
            const st = tick(S, dt);
            if (!st) return;
            const T = tune(w, 'airbase');
            if (merchantsHit(w, S, S.merch, AIRBASE.merch)) {
               setObj(w, 'tank', 'failed');
               return finish(w, S, false, 'Ein neutraler Frachter ist getroffen – der Einsatz wird abgebrochen.');
            }
            const tk = live(w, S.tankId);
            if (tk && !S.tankHit && tk.hp < tk.maxHP * 0.6) { S.tankHit = true; radio(w, 'Versorger Hiddensee', 'Schwere Treffer, wir brennen! Wir brauchen Deckung!', 'warn'); }
            // a SAM site that fires gives itself away
            for (const id of S.sams) {
               const s = siteOf(w, id);
               if (s && s.alive && !s.detected && (s.mag.hq16 || 0) < S.samN) {
                  s.detected = s.targetable = true;
                  radio(w, 'Operationszentrale', `${s.name} hat geschossen und ist geortet – sie steht jetzt auf der Karte.`, 'warn');
               }
            }
            const left = T.deadline - w.time;
            for (const k of [120, 60]) {
               if (left <= k && (S.said === 0 || S.said > k)) { S.said = k; radio(w, 'Flottenkommando', `Der Großangriff startet in ${k === 120 ? 'zwei Minuten' : 'einer Minute'}!`, 'warn'); }
            }
            if (left <= 0) {
               setObj(w, 'field', 'failed');
               return finish(w, S, false, 'Der Großangriff ist gestartet – die Jagdbomber von Serin sind auf dem Weg nach Lessa.');
            }
            const txt = coarse(left);
            if (txt !== S.shown) { S.shown = txt; objText(w, 'field', `Zerstören Sie den Flugplatz Serin vor dem Großangriff (Start in ${txt})` + lim(w)); }
         },
         onSiteDestroyed(w, site, by, S) {
            if (S.over) return;
            if (site.id === S.depotId) { setObj(w, 'depot', 'done'); radio(w, 'Operationszentrale', 'Das Treibstofflager brennt.'); return; }
            if (S.sams.includes(site.id)) {
               const n = S.sams.filter(id => !siteOf(w, id).alive).length;
               objText(w, 'sam', `Schalten Sie die Flugabwehrstellungen aus (${n}/${S.sams.length})`);
               if (n >= S.sams.length) setObj(w, 'sam', 'done');
               radio(w, 'Operationszentrale', `${site.name} ist zerstört.`);
               return;
            }
            if (site.id !== S.fieldId) return;
            w.score.player = 1;
            setObj(w, 'field', 'done'); setObj(w, 'tank', 'done');
            radio(w, 'Flottenkommando', 'Treffer auf der Startbahn bestätigt – der Flugplatz Serin ist ausgeschaltet. Der Großangriff fällt aus.');
            finish(w, S, true, 'Der Flugplatz Serin ist zerstört.');
         },
         onSink(w, ship, killer, S) {
            if (S.over) return;
            if (ship.id === w.player.id) { setObj(w, 'field', 'failed'); return finish(w, S, false, 'Ihr Schiff ist gesunken – der Angriff auf Serin ist gescheitert.'); }
            if (ship.id === S.tankId) { setObj(w, 'tank', 'failed'); return finish(w, S, false, 'Der Versorger Hiddensee ist gesunken.'); }
            if (S.merch.includes(ship.id)) { setObj(w, 'tank', 'failed'); return finish(w, S, false, 'Ein neutraler Frachter ist gesunken.'); }
         },
         timeout(w, S) { setObj(w, 'field', 'failed'); finish(w, S, false, 'Die Zeit ist abgelaufen – der Flugplatz Serin steht noch.'); },
      },
   ];
   return defs;
}
