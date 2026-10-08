// gamev2/missions_west.js — operations 1-5 (Hormus, Rotes Meer, Ostsee, Schwarzes Meer, Nordatlantik).
// Definitions are built with the helpers of missions.js (passed in, no import cycle).
// All five are fictional present-day scenarios: no real persons, merchant ships are only ever
// protected, never targets. Radio traffic is German (UI), code and comments English.
//
// Shared conventions of the scripts:
//    S (= world._script) carries the mission state; S.tick refreshes objective texts once a second.
//    by(w, easy, normal, hard) picks a value for the difficulty.
//    Allied bots fight with reduced damage (dmgMult) so the player decides the battle; a human
//    captain who takes such a ship in co-op fights at full strength (net/setup.js).
import { addSite } from './sites.js';
import { launchSSM } from './missile.js';
import { addTaskPoint } from './seal.js';

// Balance knobs per mission and difficulty (tests/v2.missions.west.test.mjs measures them with a bot captain).
// blacksea: `out` s into the mission the cruiser leaves its patrol line under the coastal umbrella and
// closes on the flagship (0 = never), so the enemy decides the mission and not the clock. `coopHp`:
// the cruiser's hull with two or more captains (measured: the co-op group otherwise wins less often than one captain).
// giuk: the second captain sails the corvette, which cannot fight a boat (measured: two captains won as
// often as one). `coopHelo`: helicopter sorties the corvette embarks under a human captain (0 = none),
// `coopHp`: hull factor of the boats that meet the two helicopters.
// redsea: a second captain sails the destroyer with full magazines instead of the bot's thin ones (measured: the
// group then wins more often than intended). From wave `coopFrom` on (counted from 0, 99 = never) every launcher
// fires one missile more at such a group.
// hormus: `boats` in the first wave; `coopBoats` is added once a second captain sails the corvette
// (measured: the co-op group wins less often than one captain against the same boats); a whole boat moves the win
// rate by some 20 points, so `coopDmg` scales the damage the boats of that wave deal to such a group. `bat`: missiles
// of the two shore batteries (Felseninsel, Süd; without it 4/6/8 by difficulty), `coopBat`: more in each of them for such
// a group. Both are scaled for the better-armed flagships like the batteries themselves.
export const WEST_TUNE = {
   hormus: {
      easy: { boats: 4, coopBoats: 0 },
      // two captains on 240 runs: -1 -> 71 %, on 120 runs: 0 -> 48 %, -1 with coopDmg 1.25 -> 59 %, 1.5 -> 53 %, 2 -> 39 %
      // since the freighters hold their column (no more circles): coopDmg 1.2 -> 76 %, 1.6 -> 65 %, 1.9 -> 58 % (120 runs)
      normal: { boats: 5, coopBoats: -1, coopDmg: 1.9 },
      // hard, since the freighters hold their column: the boats no longer decide it (one captain, 200 runs: as it was 19 %,
      // their damage x 0.93 -> 23 %, x 0.9 -> 22 %, their hull x 0.8 -> 21 %; two captains, 120 runs: coopBoats 0 / -1 / -2 ->
      // 47 / 49 / 48 % with bat [7, 7]), the batteries do. bat [8, 8] (as it was) -> 19 %, [8, 7] -> 19 %, [7, 8] -> 27 %,
      // [7, 7] -> 31 %. Two captains, 120 runs: bat [8, 8] -> 39 %, [7, 7] -> 48 %, with coopBat 1 -> 37 %, 2 -> 34 %;
      // bat [7, 8] with coopBat 1 -> 37 %, 2 -> 33 %
      hard: { boats: 5, coopBoats: -2, bat: [7, 8], coopBat: 2 },
   },
   redsea: {
      easy: { coopFrom: 99 },
      normal: { coopFrom: 2 },      // measured, two captains on 60 runs: 99 -> 80 %, 7 -> 77 %, 5 -> 73 %, 3 -> 68 %, 2 -> 62 %, 1 -> 57 %, 0 -> 52 %
      hard: { coopFrom: 4 },        // 99 -> 37 %, 7 -> 33 %, 5 -> 32 %, 4 -> 27 %, 3 -> 22 %
   },
   blacksea: {
      easy: { out: 480, coopHp: 1 },
      normal: { out: 420, coopHp: 0.85 },
      // hard, 2/3/4 captains: 0.8 -> 18/20 % (240 runs) / 25 % (120), 0.7 -> 26/29 % (240) / 34 % (120)
      hard: { out: 360, coopHp: 0.7 },
   },
   giuk: {
      easy: { coopHelo: 2, coopHp: 1 },
      // two captains on 240 runs: 1.45 -> 54 %, 1.4 -> 55 %, 1.385 -> 57 %, 1.37 -> 64 %, 1.35 -> 65 %, 1.3 -> 71 %
      normal: { coopHelo: 2, coopHp: 1.48 },
      // two captains on 120 runs: 0.98 -> 54 %, 1.06 -> 47 %, 1.3 -> 26 %
      hard: { coopHelo: 2, coopHp: 1.3 },
   },
};

export function westMissions(H) {
   const { P, add, objective, setObj, objText, later, radio, zone, inZone, islands } = H;
   const by = (w, e, n, h) => (w.difficultyKey === 'easy' ? e : w.difficultyKey === 'hard' ? h : n);
   const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
   const objState = (w, id) => (w.mission.objectives.find(o => o.id === id) || {}).state;
   const clock = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
   // a merchant that has reached the goal zone leaves the battle
   const arrive = (w, ship) => { w.removeShip(ship, 'arrived'); };

   // Convoy bookkeeping shared by the escort missions (Hormus, Rotes Meer, Nordatlantik).
   // S.convoy = merchants, S.goal = zone, S.need = how many have to arrive, S.arrived / S.lost counters.
   function convoyTick(w, S, text) {
      for (const m of S.convoy) {
         if (m.alive && inZone(m, S.goal)) { arrive(w, m); S.arrived++; w.score.player = S.arrived; }
      }
      objText(w, 'convoy', `${text} (${S.arrived}/${S.convoy.length} am Ziel, mindestens ${S.need})`);
      if (S.arrived + S.lost < S.convoy.length) return false;
      return true;
   }
   function convoyLoss(w, S, ship) {
      if (!S.convoy.includes(ship)) return false;
      S.lost++; w.score.enemy = S.lost;
      setObj(w, 'all', 'failed');
      return true;
   }

   return [
      // ========================================================= 1. Straße von Hormus
      {
         id: 'hormus', group: 'ops', name: 'Straße von Hormus', subtitle: 'Geleitschutz · Schnellboote, Kleinst-U-Boot, Küstenbatterien',
         briefing: 'Drei Tanker laufen durch die Meerenge nach Osten. Bewaffnete Schnellboote haben in den letzten Tagen Handelsschiffe bedrängt, ' +
            'an der Südküste stehen Flugkörperbatterien, und ein Kleinst-U-Boot wird im Fahrwasser vermutet. ' +
            'Bleiben Sie beim Geleit. Schnellboote sind Ziele für das Geschütz – Flugkörper sind für sie zu schade. ' +
            'Gegen anfliegende Flugkörper helfen Nahbereichsabwehr und Täuschkörper. Mindestens zwei Tanker müssen durchkommen.',
         debrief: 'Das Geleit ist durch. Schnellboote bekämpft man mit dem Geschütz, anfliegende Flugkörper mit Abwehr und Täuschkörpern – ' +
            'und wer beim Geleit bleibt, schützt es auch.',
         fleet: { own: 'Geleitschiff, 1 Korvette, 3 Tanker', foe: 'Schnellbootgruppen, 1 Kleinst-U-Boot, 2 Küstenbatterien' },
         env: { time: 'day', weather: 'clear' }, type: 'escort', playableShips: ['Sachsen', 'Burke', 'Daring'], recommendedShip: 'Sachsen',
         arena: 20000, timeLimit: 12 * 60, stars: 1,
         setup(w, shipKey) {
            const S = w._script;
            // (sim y grows south: north is up on the chart, missileui.js compass())
            islands(w, [
               { c: P(1500, 17800), r: 3000, height: 320, seed: 21, lobes: 6, elong: 3.6, rot: 0, rough: 0.6, name: 'Südküste' },
               { c: P(-4000, -17600), r: 2800, height: 420, seed: 33, lobes: 6, elong: 2.8, rot: 0.1, rough: 0.8, name: 'Nordkap' },
               { c: P(-3200, 6400), r: 850, height: 120, seed: 41, lobes: 4, rough: 0.5, name: 'Westinsel' },
               { c: P(5600, 7200), r: 1100, height: 160, seed: 47, lobes: 5, rough: 0.5, name: 'Felseninsel' },
               { c: P(9500, -8200), r: 900, height: 140, seed: 53, lobes: 4, rough: 0.5, name: 'Nordriff' },
            ]);
            add(w, shipKey, 'player', P(-12200, 600), 0, { isPlayer: true });
            S.escort = add(w, 'Braunschweig', 'player', P(-14800, -1900), 0, { dmgMult: by(w, 0.05, 0.6, 0.6), ai: { escortId: null } });
            const route = [P(-4000, -900), P(4500, 200), P(9800, 0)];
            S.convoy = [
               add(w, 'Tanker', 'player', P(-13600, -600), 0, { name: 'MT Nordstern', speedKn: 18, ai: { route } }),
               add(w, 'LNG', 'player', P(-14800, -600), 0, { name: 'LNG Aurora', speedKn: 18, ai: { route } }),
               add(w, 'Tanker', 'player', P(-16000, -600), 0, { name: 'MT Seeadler', speedKn: 18, ai: { route } }),
            ];
            S.escort.ai.escortId = S.convoy[2].id;
            S.goal = zone(w, 9800, 0, 1800, 'Golf von Oman');
            S.need = 2; S.arrived = 0; S.lost = 0; S.tick = 0; S.boats = 0;
            const T = WEST_TUNE.hormus[w.difficultyKey] || WEST_TUNE.hormus.normal;
            const extra = { Burke: 2 }[shipKey] || 0;      // one more boat per wave for the strongest escort
            const gun = { Burke: 2, Daring: 1.5 }[shipKey] || 1; S.gun = gun;      // the better-armed escorts meet heavier batteries
            // the batteries stay silent (radar off, not yet located) until the convoy is deep in the strait
            S.batteries = [
               addSite(w, 'battery', 'enemy', P(5600, 6000), { name: 'Küstenbatterie Felseninsel', hidden: true, radarOn: false, delay: 1e9, ssm: { type: 'noor', n: Math.round((T.bat ? T.bat[0] : by(w, 4, 6, 8)) * gun) } }),
               addSite(w, 'battery', 'enemy', P(10500, 14500), { name: 'Küstenbatterie Süd', hidden: true, radarOn: false, delay: 1e9, ssm: { type: 'noor', n: Math.round((T.bat ? T.bat[1] : by(w, 4, 6, 8)) * gun) } }),
            ];
            S.sub = add(w, 'Ghadir', 'enemy', P(4200, -2600), Math.PI, { depth: 1, telegraph: 1, ai: { huntId: S.convoy[0].id } });
            objective(w, 'convoy', 'Geleiten Sie die Tanker durch die Meerenge (0/3 am Ziel, mindestens 2)');
            objective(w, 'all', 'Alle drei Schiffe erreichen den Golf von Oman', { optional: true });
            objective(w, 'sub', 'Versenken Sie das Kleinst-U-Boot', { optional: true });
            w.score = { kind: 'count', player: 0, enemy: 0, target: 3 };
            radio(w, 'Geleitführer', 'Geleit läuft mit 18 Knoten an. Halten Sie Position am Geleit, Radar an.');
            const wave = (n0, from, hunt, text, dmg = 1) => {
               const n = n0 + extra;
               radio(w, 'Ausguck', text, 'warn');
               for (let i = 0; i < n; i++) {
                  const a = (i - (n - 1) / 2) * 420;
                  add(w, 'Boghammar', 'enemy', P(from.x + a, from.y + Math.abs(a) * 0.4), Math.atan2(-from.y, -from.x), { minDist: 6500, speedKn: 38, hpMult: 0.7, dmgMult: by(w, 1, 1.1, 1.25) * dmg, ai: { huntId: hunt.id, aggro: 1.5 } });
               }
               S.boats += n;
            };
            later(S, 40, () => wave(T.boats + (S.coopBoats || 0), P(-6500, 9500), S.convoy[0], 'Schnellboote von Süden, schnell näher kommend. Geschütz klar!', S.coopDmg || 1));
            later(S, 215, () => wave(by(w, 5, 5, 6), P(3500, 11500), S.convoy[1], 'Zweite Schnellbootgruppe hinter der Felseninsel hervor. Sie halten auf die Tanker zu.'));
            later(S, by(w, 345, 315, 285), () => {
               radio(w, 'Operationszentrale', 'Feuerleitradar von der Südküste! Die Küstenbatterien schalten auf. Flugkörperabwehr klar, Täuschkörper bereithalten.', 'warn');
               for (const b of S.batteries) if (b.alive) { b.radarOn = true; b.detected = b.targetable = true; b.nextT = 10 + S.batteries.indexOf(b) * 12; }
            });
            later(S, 410, () => wave(by(w, 4, 4, 6), P(10500, -11500), S.convoy[2], 'Dritte Gruppe von Nordosten, hinter dem Riff hervor.'));
            later(S, 130, () => radio(w, 'Operationszentrale', 'Hinweis: Ein Kleinst-U-Boot wird im Fahrwasser voraus vermutet. Sonar besetzen, Bordhubschrauber bereithalten.'));
         },
         // co-op (net/setup.js): with a captain on the corvette the first wave changes by `coopBoats`, the damage
         // its boats deal by the factor `coopDmg`
         coop(w, S, humans) {
            const T = WEST_TUNE.hormus[w.difficultyKey] || WEST_TUNE.hormus.normal;
            if (!humans.includes(S.escort)) return;
            S.coopBoats = T.coopBoats || 0; S.coopDmg = T.coopDmg || 1;
            if (T.coopBat) for (const b of S.batteries) b.mag.noor += Math.round(T.coopBat * S.gun);
         },
         update(w, dt, S) {
            if ((S.tick -= dt) > 0) return;
            S.tick = 1;
            if (!convoyTick(w, S, 'Geleiten Sie die Tanker durch die Meerenge')) return;
            if (S.arrived >= S.need) {
               if (S.arrived === S.convoy.length) setObj(w, 'all', 'done');
               setObj(w, 'convoy', 'done');
               w.end(true, S.lost ? 'Das Geleit hat die Meerenge passiert – ein Tanker ging verloren.' : 'Alle Tanker haben die Meerenge sicher passiert.');
            } else w.end(false, 'Zu viele Tanker gingen verloren.');
         },
         onSink(w, ship, killer, S) {
            if (ship === S.sub) { setObj(w, 'sub', 'done'); radio(w, 'Operationszentrale', 'Unterwasserkontakt vernichtet. Gute Arbeit.'); return; }
            if (!convoyLoss(w, S, ship)) return;
            radio(w, 'Geleitführer', ship.name + ' sinkt. Die Besatzung geht in die Boote.', 'warn');
            if (S.lost > S.convoy.length - S.need) w.end(false, 'Zwei Tanker gingen verloren – der Auftrag ist gescheitert.');
         },
         timeout(w, S) {
            if (S.arrived >= S.need) { setObj(w, 'convoy', 'done'); w.end(true, 'Das Geleit hat die Meerenge passiert – ein Nachzügler blieb zurück.'); }
            else w.end(false, 'Die Zeit ist abgelaufen – das Geleit hat die Meerenge nicht passiert.');
         },
      },
      // ========================================================= 2. Rotes Meer – Bab al-Mandab
      {
         id: 'redsea', group: 'ops', name: 'Rotes Meer – Bab al-Mandab', subtitle: 'Flugkörperabwehr · Containerschiffe unter Beschuss von Land',
         briefing: 'Drei Containerschiffe laufen nach Süden durch die Meerenge. Von der Ostküste werden Seezielflugkörper in Wellen gestartet. ' +
            'Sie führen die Luftverteidigung: Bleiben Sie zwischen Küste und Geleit und teilen Sie Ihre Flugkörper ein – die Magazine sind endlich. ' +
            'Der Zerstörer im Verband hat bereits Angriffe abgewehrt und nur noch halbe Magazine. ' +
            'Startrampen, die gefeuert haben, werden geortet: Dann können Marschflugkörper sie ausschalten.',
         debrief: 'Das Geleit ist durch die Meerenge. Wer jeden Flugkörper mit dem teuersten Abwehrmittel bekämpft, steht am Ende mit leeren Magazinen da – ' +
            'und die sicherste Abwehr ist eine Startrampe, die nicht mehr feuert.',
         fleet: { own: 'Luftverteidigungsschiff, 1 Zerstörer, 3 Containerschiffe', foe: '3 Startrampen, Radarstation, Flugabwehrstellung an der Ostküste' },
         env: { time: 'dusk', weather: 'clear' }, type: 'escort', playableShips: ['Burke', 'Ticonderoga'], recommendedShip: 'Burke',
         arena: 20000, timeLimit: 11 * 60, stars: 2,
         setup(w, shipKey) {
            const S = w._script;
            islands(w, [
               { c: P(18200, 0), r: 3400, height: 520, seed: 71, lobes: 6, elong: 4, rot: Math.PI / 2, rough: 0.7, name: 'Ostküste' },
               { c: P(-15500, -7000), r: 1500, height: 180, seed: 77, lobes: 5, elong: 1.6, rot: 1.2, rough: 0.5, name: 'Westinseln' },
               { c: P(-13000, 9500), r: 1100, height: 140, seed: 83, lobes: 4, rough: 0.5 },
            ]);
            add(w, shipKey, 'player', P(-200, 13200), -Math.PI / 2, { isPlayer: true });
            const route = [P(-2500, 5000), P(-1800, -3000), P(-2200, -9500)];
            S.convoy = ['MV Hansa Carrier', 'MV Baltic Star', 'MV Elbe Trader'].map((name, i) =>
               add(w, 'Container', 'player', P(-2200, 14800 + i * 1250), -Math.PI / 2, { name, speedKn: 18, ai: { route } }));
            S.ally = add(w, 'Daring', 'player', P(-3600, 16600), -Math.PI / 2, { ai: { escortId: S.convoy[2].id } });
            S.ally.mag.aster30 = by(w, 1, 10, 8); S.ally.mag.camm = by(w, 0, 8, 6);
            S.goal = zone(w, -2200, -9500, 1800, 'Golf von Aden');
            S.need = 2; S.arrived = 0; S.lost = 0; S.tick = 0; S.queue = []; S.wave = 0; S.launched = 0;
            S.launchers = [['Startrampe Nord', 7500], ['Startrampe Mitte', 300], ['Startrampe Süd', -7000]].map(([name, y]) => {
               const L = addSite(w, 'launcher', 'enemy', P(15000, y), { name, hidden: true, hp: by(w, 9000, 16000, 18000), ssm: { type: 'kh35', n: 400 } });
               L.cfg.weapons.ssm.push({ type: 'oniks', n: 400 }); L.mag.oniks = 400;
               return L;
            });
            S.radar = addSite(w, 'radar', 'enemy', P(15000, 3900), { name: 'Radarstation Küste' });
            if (w.difficultyKey !== 'easy') S.sam = addSite(w, 'sam', 'enemy', P(15000, -3300), { name: 'Flugabwehrstellung Küste', sam: { type: 'hq16', n: by(w, 0, 14, 20), ch: 2 } });
            objective(w, 'convoy', 'Schützen Sie die Containerschiffe (0/3 am Ziel, mindestens 2)');
            objective(w, 'all', 'Kein Containerschiff geht verloren', { optional: true });
            objective(w, 'sites', 'Schalten Sie die georteten Startrampen aus (0/3)', { optional: true });
            w.score = { kind: 'count', player: 0, enemy: 0, target: 3 };
            radio(w, 'Geleitführer', 'Geleit läuft nach Süden. Erwarten Flugkörper von der Ostküste – Radar an, Abwehr klar.');
            // waves: every living launcher ripples n missiles; from the fifth wave on the first of each is supersonic
            const T0 = 30, GAP = by(w, 62, 54, 48) * (shipKey === 'Ticonderoga' ? 0.8 : 1);      // the cruiser's big magazine meets denser salvos
            for (let k = 0; k < 9; k++) later(S, T0 + k * GAP, () => this.wave(w, S, k));
            later(S, T0 + 2.5 * GAP, () => radio(w, 'Operationszentrale', 'Magazinstand beachten. Feuerordnung anpassen – nicht jeden Flugkörper doppelt bekämpfen.'));
            later(S, T0 + 4 * GAP - 8, () => radio(w, 'Operationszentrale', 'Warnung: Die nächsten Salven enthalten Überschall-Flugkörper. Täuschkörper bereithalten.', 'warn'));
         },
         wave(w, S, k) {
            const live = S.launchers.filter(L => L.alive);
            if (!live.length || S.arrived + S.lost >= S.convoy.length) return;
            S.wave++;
            const n = by(w, 2, 2, 2) + (k >= by(w, 3, 2, 3) ? 1 : 0) + (k >= by(w, 99, 5, 6) ? 1 : 0) + (k >= (S.coopFrom ?? 99) ? 1 : 0);
            radio(w, 'Operationszentrale', `Flugkörperstart an der Ostküste, Welle ${S.wave}. Anflug aus Ost.`, 'warn');
            for (const L of live) for (let i = 0; i < n; i++)
               S.queue.push({ L, t: w.time + S.launchers.indexOf(L) * 2.5 + i * 1.3, type: k >= 4 && i === 0 && w.difficultyKey !== 'easy' ? 'oniks' : 'kh35', tries: 0 });
         },
         update(w, dt, S) {
            // launch queue: one round per entry, at a merchant (every fourth round at an escort)
            for (let i = S.queue.length - 1; i >= 0; i--) {
               const q = S.queue[i], L = q.L;
               if (w.time < q.t) continue;
               const ships = S.convoy.filter(m => m.alive);
               if (!L.alive || !ships.length || q.tries++ > 200) { S.queue.splice(i, 1); continue; }
               let T = ships[(S.launched + S.launchers.indexOf(L)) % ships.length];
               if (S.launched % 4 === 3) {
                  const esc = w.ships.filter(e => e.alive && e.side === 'player' && !S.convoy.includes(e));
                  if (esc.length) T = esc[S.launched % esc.length];
               }
               const m = (T.targetable && launchSSM(w, L, { targetId: T.id }, q.type)) || (q.tries > 3 ? launchSSM(w, L, { x: T.pos.x, y: T.pos.y }, q.type) : null);
               if (!m) continue;
               S.launched++;
               S.queue.splice(i, 1);
               if (!L.detected && !L.locating) {
                  L.locating = true;
                  later(S, w.time + 7, () => {
                     if (!L.alive) return;
                     L.detected = L.targetable = true;
                     radio(w, 'Operationszentrale', L.name + ' geortet. Freigabe für Marschflugkörper.');
                  });
               }
            }
            if ((S.tick -= dt) > 0) return;
            S.tick = 1;
            if (!convoyTick(w, S, 'Schützen Sie die Containerschiffe')) return;
            if (S.arrived >= S.need) {
               if (!S.lost) setObj(w, 'all', 'done');
               setObj(w, 'convoy', 'done');
               w.end(true, S.lost ? 'Das Geleit ist durch die Meerenge – ein Schiff ging verloren.' : 'Alle Containerschiffe haben die Meerenge sicher passiert.');
            } else w.end(false, 'Zu viele Schiffe gingen verloren.');
         },
         // co-op (net/setup.js): a captain on the destroyer fights with full magazines, so from wave `coopFrom`
         // (counted from 0; 99 = never) every launcher fires one missile more
         coop(w, S, humans) {
            if (humans.includes(S.ally)) S.coopFrom = (WEST_TUNE.redsea[w.difficultyKey] || WEST_TUNE.redsea.normal).coopFrom;
         },
         onSiteDestroyed(w, site, by_, S) {
            if (site === S.radar) { radio(w, 'Operationszentrale', 'Radarstation zerstört. Die Rampen feuern jetzt ohne Zieldaten – deutlich ungenauer.'); return; }
            if (!S.launchers.includes(site)) return;
            const n = S.launchers.filter(L => !L.alive).length;
            objText(w, 'sites', `Schalten Sie die georteten Startrampen aus (${n}/3)`);
            if (n >= 3) { setObj(w, 'sites', 'done'); radio(w, 'Operationszentrale', 'Alle Startrampen ausgeschaltet. Der Beschuss hört auf.'); }
            else radio(w, 'Operationszentrale', site.name + ' ausgeschaltet.');
         },
         onSink(w, ship, killer, S) {
            if (!convoyLoss(w, S, ship)) return;
            radio(w, 'Geleitführer', ship.name + ' ist schwer getroffen und sinkt. Rettungsmittel sind ausgebracht.', 'warn');
            if (S.lost > S.convoy.length - S.need) w.end(false, 'Zwei Containerschiffe gingen verloren – der Auftrag ist gescheitert.');
         },
         timeout(w, S) {
            if (S.arrived >= S.need) { setObj(w, 'convoy', 'done'); w.end(true, 'Das Geleit ist durch die Meerenge – ein Nachzügler blieb zurück.'); }
            else w.end(false, 'Die Zeit ist abgelaufen – das Geleit hat die Meerenge nicht passiert.');
         },
      },
      // ========================================================= 3. Ostsee – Pipeline
      // Stealth: no fight is needed. The alarm level (0..100) rises while a boat of the player side is
      // seen (periscope, surfaced) or held by an enemy sonar, and falls slowly otherwise; at 100 the
      // operation is blown. The patrols run fixed loops whose phase depends on the seed.
      {
         id: 'pipeline', group: 'ops', name: 'Ostsee – Pipeline', subtitle: 'Verdeckte Operation · Kommandotrupp, Patrouillen, Zeitfenster',
         briefing: 'An einem Pipeline-Abschnitt wurde ein Sprengsatz mit Zeitzünder entdeckt. Korvetten und ein U-Boot patrouillieren im Gebiet – Sie dürfen nicht aufgeklärt werden. ' +
            'Laufen Sie getaucht an, gehen Sie nahe am Einsatzpunkt auf Sehrohrtiefe, nehmen Sie Fahrt heraus und setzen Sie den Kommandotrupp aus. ' +
            'Warten Sie in der Nähe, nehmen Sie den Trupp wieder auf und laufen Sie nach Nordwesten ab. ' +
            'Tief und langsam sind Sie kaum zu orten; eine Korvette in der Nähe des Trupps bedeutet seinen Verlust. Ein Gefecht ist nicht vorgesehen.',
         debrief: 'Der Sprengsatz ist geborgen, niemand hat das Boot bemerkt. Ein U-Boot gewinnt nicht durch Waffen, sondern durch Geduld: ' +
            'tief und langsam an den Patrouillen vorbei, auftauchen nur, wenn der Weg frei ist.',
         fleet: { own: '1 U-Boot mit Kommandotrupp', foe: '2–3 Korvetten, 1 U-Boot auf Patrouille' },
         env: { time: 'night', weather: 'fog' }, type: 'stealth', playableShips: ['U212', 'Virginia'], recommendedShip: 'U212',
         arena: 10000, timeLimit: 12 * 60, stars: 3,
         setup(w, shipKey) {
            const S = w._script;
            const rnd = (salt) => { const x = Math.sin((w.seed % 100000) * 12.9898 + salt * 78.233) * 43758.5453; return x - Math.floor(x); };
            islands(w, [
               { c: P(8200, -7200), r: 1500, height: 90, seed: 91, lobes: 5, elong: 1.8, rot: 0.6, rough: 0.4, name: 'Südostküste' },
               { c: P(-8300, -8200), r: 1100, height: 70, seed: 95, lobes: 4, rough: 0.4 },
            ]);
            add(w, shipKey, 'player', P(-5500, -2500), 0.3, { isPlayer: true, depth: 2 });
            const T = P(1500, 1000);
            S.task = addTaskPoint(w, { x: T.x, y: T.y, kind: 'recover', label: 'Pipeline-Abschnitt 7', workTime: 35 });
            S.area = zone(w, T.x, T.y, 2600, 'Einsatzraum');
            S.exit = zone(w, -4500, 5200, 1400, 'Ablaufpunkt');
            S.alarm = 0; S.peak = 0; S.tick = 0; S.stage = 0; S.sunk = 0; S.warned = false; S.nearT = -99;
            S.deadline = by(w, 480, 440, 410);
            // a patrol runs a closed loop of waypoints; f (0..1) = where on the loop it starts
            const patrol = (name, pts, f, kn) => {
               const len = pts.map((a, i) => hyp(a, pts[(i + 1) % pts.length]));
               let d = f * len.reduce((x, y) => x + y, 0), i = 0;
               while (d > len[i]) { d -= len[i]; i++; }
               const a = pts[i], b = pts[(i + 1) % pts.length], g = d / len[i];
               return add(w, 'BuyanM', 'enemy', P(a.x + (b.x - a.x) * g, a.y + (b.y - a.y) * g), Math.atan2(b.y - a.y, b.x - a.x),
                  { name, telegraph: 4, speedKn: kn, ai: { patrol: pts, patrolIdx: i + 1 } });
            };
            const kn = by(w, 12, 14, 16);
            // Alfa: racetrack whose western leg runs over the task point (north to south), Bravo: picket
            // line across the approach, Charlie (hard): in front of the way out
            S.loop = [P(T.x, T.y + 2600), P(T.x, T.y - 2600), P(T.x + 1600, T.y - 2600), P(T.x + 1600, T.y + 2600)];
            S.patrols = [
               // Alfa first passes the task point 130..260 s into the mission
               patrol('Korvette Alfa', S.loop, (((2600 - (130 + rnd(1) * 130) * kn * 2.6) % 13600) + 13600) % 13600 / 13600, kn),
               patrol('Korvette Bravo', [P(-1900, -5600), P(-1900, 2400), P(-2600, 2400), P(-2600, -5600)], rnd(2) * 0.45, kn),
            ];
            if (w.difficultyKey !== 'easy') S.patrols.push(patrol('Korvette Charlie', [P(-7800, 2600), P(-1500, 7600), P(-2000, 8200), P(-8300, 3200)], rnd(3), kn));
            // the submarine circles between the task point and the way out (a route that the script restarts)
            // (easy: north of the task point; otherwise across the way out)
            const loop = w.difficultyKey === 'easy' ? [P(-1500, 5800), P(1800, 6300), P(-600, 3000)]
               : [P(-700, 3300), P(-3300, 1700), P(-2500, 5200)];
            const k0 = Math.floor(rnd(4) * 3);
            S.kiloLoop = loop;
            S.kilo = add(w, 'Kilo', 'enemy', loop[k0], 0, { depth: 1, speedKn: by(w, 6, 7, 9), ai: { route: [loop[(k0 + 1) % 3], loop[(k0 + 2) % 3], loop[k0]] } });
            objective(w, 'reach', 'Erreichen Sie unentdeckt den Einsatzraum');
            objective(w, 'device', `Setzen Sie den Trupp aus – der Sprengsatz muss bis ${clock(S.deadline)} geborgen sein`);
            objective(w, 'exit', 'Nehmen Sie den Trupp wieder auf und erreichen Sie den Ablaufpunkt');
            objective(w, 'clean', 'Versenken Sie kein Schiff', { optional: true });
            objective(w, 'ghost', 'Alarmstufe bleibt unter 50 %', { optional: true });
            w.score = { kind: 'count', player: 0, enemy: 0, target: 100 };
            radio(w, 'Flottenkommando', 'Sie haben Freigabe. Tief und langsam anlaufen. Zeitzünder läuft – der Trupp muss bis ' + clock(S.deadline) + ' fertig sein.');
            later(S, 50, () => radio(w, 'Sonar', 'Schraubengeräusche voraus: eine Korvette läuft quer zu unserem Kurs Streife. Abstand halten oder langsam unter ihr durch.'));
            later(S, S.deadline - 120, () => { if (S.task.state !== 'done') radio(w, 'Flottenkommando', 'Noch zwei Minuten bis zum Ablauf des Zeitzünders.', 'warn'); });
            S.onTaskDone = () => {
               setObj(w, 'device', 'done');
               radio(w, 'Kommandotrupp', 'Sprengsatz entschärft und geborgen. Wir kommen zurück – bleiben Sie auf Sehrohrtiefe und ohne Fahrt.');
            };
            S.onTeamRecovered = () => { S.recovered = true; radio(w, 'Wachoffizier', 'Trupp ist an Bord. Tauchen und nach Nordwesten ablaufen.'); };
            S.onTeamLost = (ww, team, reason) => {
               if (w.phase === 'playing') w.end(false, reason === 'stranded' ? 'Der Trupp konnte nicht wieder aufgenommen werden.' : 'Der Kommandotrupp wurde entdeckt – die Operation ist gescheitert.');
            };
         },
         update(w, dt, S) {
            if ((S.tick -= dt) > 0) return;
            const step = 0.5; S.tick = step;
            const subs = w.ships.filter(s => s.alive && s.side === 'player');
            // co-op: the boats of the other captains (placed after setup) start deep as well
            if (!S.init) { S.init = true; for (const s of subs) if (s.sub && w.time < 2) s.depthTarget = s.depthF = s.depth = 2; }
            // the submarine patrol restarts its loop
            const k = S.kilo;
            if (k.alive && k.ai.route && k.ai.routeIdx >= k.ai.route.length - 1 && hyp(k.pos, k.ai.route[k.ai.route.length - 1]) < 800) k.ai.routeIdx = 0;
            // alarm level
            let seen = 0;
            for (const s of subs) seen = Math.max(seen, s.detected ? 2 : w.time - s.pingT < 1.2 ? 1 : 0);
            S.alarm = Math.max(0, Math.min(100, S.alarm + step * (seen === 2 ? by(w, 8, 11, 14) : seen === 1 ? by(w, 3, 3.3, 5.5) : -1.5)));
            S.peak = Math.max(S.peak, S.alarm);
            w.score.player = Math.round(S.alarm);
            if (seen && !S.warned) { S.warned = true; radio(w, 'Sonar', seen === 2 ? 'Wir sind gesehen worden! Sofort tief gehen.' : 'Aktives Sonar erfasst uns. Fahrt herausnehmen, Abstand gewinnen.', 'warn'); }
            if (!seen && S.alarm < 5) S.warned = false;
            if (S.peak >= 50 && objState(w, 'ghost') === 'active') { setObj(w, 'ghost', 'failed'); radio(w, 'Sonar', 'Die Patrouillen suchen nach uns. Noch haben sie keine sichere Ortung.', 'warn'); }
            if (S.alarm >= 100) { w.end(false, 'Das Boot wurde aufgeklärt – die Operation ist gescheitert.'); return; }
            const a = ` (Alarmstufe ${Math.round(S.alarm)} %)`;
            const left = S.deadline - w.time;
            if (S.task.state !== 'done' && left <= 0) { w.end(false, 'Das Zeitfenster ist verstrichen – der Sprengsatz wurde nicht rechtzeitig geborgen.'); return; }
            // objective chain
            if (S.stage === 0) {
               objText(w, 'reach', 'Erreichen Sie unentdeckt den Einsatzraum' + a);
               if (subs.some(s => inZone(s, S.area))) {
                  S.stage = 1; setObj(w, 'reach', 'done');
                  radio(w, 'Wachoffizier', 'Einsatzraum erreicht. Auf Sehrohrtiefe gehen, Fahrt heraus, Trupp aussetzen – je näher am Punkt, desto kürzer der Weg.');
                  const eta = this.eta(w, S);
                  if (eta < 900) radio(w, 'Sonar', `Korvette Alfa läuft die Pipeline ab und passiert den Einsatzpunkt in etwa ${eta < 45 ? 'einer halben Minute' : Math.max(1, Math.round(eta / 60)) + (Math.round(eta / 60) > 1 ? ' Minuten' : ' Minute')}.`);
               }
            } else if (S.task.state !== 'done') {
               objText(w, 'device', `Setzen Sie den Trupp aus – Sprengsatz bergen, noch ${clock(Math.max(0, left))}` + a);
            } else {
               objText(w, 'exit', (S.recovered ? 'Erreichen Sie den Ablaufpunkt' : 'Nehmen Sie den Trupp wieder auf') + a);
               if (S.recovered && subs.length && subs.every(s => inZone(s, S.exit))) {
                  setObj(w, 'exit', 'done');
                  if (!S.sunk) setObj(w, 'clean', 'done');
                  if (S.peak < 50) setObj(w, 'ghost', 'done');
                  w.end(true, S.peak < 50 && !S.sunk ? 'Auftrag ausgeführt – niemand hat das Boot bemerkt.' : 'Auftrag ausgeführt. Der Gegner weiß allerdings, dass jemand hier war.');
                  return;
               }
            }
            // a corvette closing on the team: one warning
            const team = w.teams.find(t => t.side === 'player' && (t.state === 'out' || t.state === 'working' || t.state === 'returning'));
            if (team && w.time - S.nearT > 60 && S.patrols.some(c => c.alive && hyp(c.pos, team) < 1700)) {
               S.nearT = w.time;
               radio(w, 'Sonar', 'Korvette nähert sich dem Trupp. Abstand unter einer Seemeile.', 'warn');
            }
         },
         onSink(w, ship, killer, S) {
            if (ship.side !== 'enemy') return;
            S.sunk++; S.alarm = Math.min(99, S.alarm + 45);
            setObj(w, 'clean', 'failed');
            radio(w, 'Flottenkommando', 'Eine Versenkung war nicht vorgesehen. Der Verband ist jetzt alarmiert – bringen Sie den Auftrag zu Ende.', 'warn');
         },
         timeout(w) { w.end(false, 'Die Zeit ist abgelaufen – das Boot hat den Ablaufpunkt nicht erreicht.'); },
         // seconds until the pipeline patrol next passes the task point (Infinity when it is gone)
         eta(w, S) {
            const c = S.patrols[0], T = S.task, L = S.loop;
            if (!c.alive) return Infinity;
            const v = Math.max(5, Math.abs(c.speed)), i = (c.ai.patrolIdx || 0) % 4;
            if (i === 1 && c.pos.y > T.y) return (c.pos.y - T.y) / v;
            let d = hyp(c.pos, L[i]);
            for (let k = i; k !== 0; k = (k + 1) % 4) d += hyp(L[k], L[(k + 1) % 4]);
            return (d + hyp(L[0], T)) / v;
         },
         // Scripted captain for tests and the balance table: what a careful player does.
         // h = { steerTo, orderDepth, launchTeam, teamStatus, hyp }; returns the per-step function.
         testRoute(w, h) {
            const S = w._script, p = w.player, T = S.task;
            const wait = { x: T.x - 700, y: T.y - 80 };
            let phase = 0, last = Infinity;
            const surf = () => w.ships.filter(s => s.alive && s.side === 'enemy' && s.depth === 0);
            const nearest = (list, q) => list.reduce((m, s) => Math.min(m, h.hyp(s.pos, q)), Infinity);
            return () => {
               if (!p.alive) return;
               const dS = nearest(surf(), p.pos), dK = S.kilo.alive ? h.hyp(S.kilo.pos, p.pos) : Infinity;
               const quiet = dS < 1500 || dK < 2300;
               const closing = dS < 1050 && dS < last;              // a corvette comes close: stop and let it pass
               last = dS;
               if (phase === 0) {                                   // approach deep
                  h.orderDepth(p, 2, w);
                  const d = h.hyp(p.pos, wait);
                  h.steerTo(p, wait, closing ? 0 : d < 500 ? 1 : quiet ? 2 : 4);
                  if (d < 160) phase = 1;
               } else if (phase === 1) {                            // wait deep until the pipeline patrol has passed
                  p.setTelegraph(0); p.setRudder(0);
                  const need = 2 * h.hyp(p.pos, T) / 9 + T.workTime + 40;      // out, work, back, margin
                  if (S.def.eta(w, S) > need && dS > 1000 && dK > 1500) { h.orderDepth(p, 1, w); if (p.depth <= 1 && h.launchTeam(w, p)) phase = 2; }
                  else h.orderDepth(p, 2, w);
               } else if (phase === 2) {                            // hold; dive under a patrol that comes close
                  p.setTelegraph(0); p.setRudder(0);
                  const team = w.teams.find(t => t.ownerId === p.id && t.state === 'returning');
                  const pickup = team && h.hyp(team, p.pos) < 350;      // come up for the team even with the submarine near
                  h.orderDepth(p, dS < 1150 || (dK < 1500 && !pickup) ? 2 : 1, w);
                  if (S.recovered) phase = 3;
               } else {                                             // leave deep
                  h.orderDepth(p, 2, w);
                  h.steerTo(p, S.exit, closing ? 0 : quiet ? 2 : 4);
               }
            };
         },
      },
      // ========================================================= 4. Schwarzes Meer
      // Surface strike. The allied captains hold their anti-ship missiles until the flagship (or any
      // human captain) fires: then they join on the same target (world.strike, ai_missile.js).
      {
         id: 'blacksea', group: 'ops', name: 'Schwarzes Meer', subtitle: 'Seezielangriff · Kreuzerverband vor verteidigter Küste',
         briefing: 'Ein Lenkwaffenkreuzer mit Korvetten sichert die Zufahrt zu einer Bucht; an der Küste stehen eine Flugkörperbatterie, eine Flugabwehrstellung und ein Radar. ' +
            'Einzelne Flugkörper fängt der Kreuzer ab – seine Abwehr hat aber nur wenige Feuerkanäle. ' +
            'Ihr Verband hält die Seezielflugkörper zurück, bis Sie feuern, und schießt dann auf dasselbe Ziel: Viele Flugkörper zur selben Zeit übersättigen die Abwehr. ' +
            'Räumen Sie zuerst die Korvetten ab, dann den Kreuzer.',
         debrief: 'Der Kreuzer ist versenkt. Seine Abwehr hätte jede Einzelsalve abgefangen – entschieden hat, dass alle Schiffe gleichzeitig auf dasselbe Ziel geschossen haben.',
         fleet: { own: '2 Fregatten, 1 Zerstörer, 1 Korvette', foe: '1 Lenkwaffenkreuzer, 2–4 Korvetten, Küstenbatterie, Flugabwehrstellung, Radar' },
         env: { time: 'day', weather: 'overcast' }, type: 'strike', playableShips: ['Sachsen'], recommendedShip: 'Sachsen',
         arena: 24000, timeLimit: 12 * 60, stars: 2,
         setup(w, shipKey) {
            const S = w._script;
            islands(w, [
               { c: P(16500, 17000), r: 4600, height: 380, seed: 111, lobes: 6, elong: 1.5, rot: -0.6, rough: 0.6, name: 'Kap' },
               { c: P(21000, 4500), r: 3000, height: 260, seed: 117, lobes: 5, elong: 1.4, rot: 1.3, rough: 0.6, name: 'Ostufer' },
               { c: P(-6000, 15000), r: 1300, height: 120, seed: 123, lobes: 4, rough: 0.5 },
            ]);
            const p = add(w, shipKey, 'player', P(-15500, -10500), 0.6, { isPlayer: true });
            S.allies = [
               add(w, 'Daring', 'player', P(-16700, -9000), 0.6, { ai: { escortId: p.id } }),
               add(w, 'Sachsen', 'player', P(-14300, -12000), 0.6, { name: 'Hessen', ai: { escortId: p.id } }),
               add(w, 'Braunschweig', 'player', P(-17200, -11600), 0.6, { ai: { escortId: p.id } }),
            ];
            S.cruiser = add(w, 'Slawa', 'enemy', P(11000, 8500), Math.PI + 0.6, { telegraph: 2, hpMult: by(w, 0.5, 1.2, 1.05), ai: { patrol: [P(6500, 10500), P(11500, 7000)] } });
            S.boats = [
               add(w, 'BuyanM', 'enemy', P(7500, 5000), Math.PI + 0.6, {}),
               add(w, 'BuyanM', 'enemy', P(4000, 10500), Math.PI + 0.6, {}),
            ];
            if (w.difficultyKey !== 'easy') S.boats.push(add(w, 'BuyanM', 'enemy', P(9500, 1500), Math.PI + 0.6, {}));
            if (w.difficultyKey === 'hard') S.boats.push(add(w, 'BuyanM', 'enemy', P(1500, 14500), Math.PI + 0.6, {}));
            S.battery = addSite(w, 'battery', 'enemy', P(13800, 14600), { name: 'Küstenbatterie Kap', ssm: { type: 'kh35', n: by(w, 4, 6, 8) }, salvo: 2, interval: by(w, 40, 32, 26) });
            S.sam = addSite(w, 'sam', 'enemy', P(19200, 5200), { name: 'Flugabwehrstellung Ostufer', sam: { type: 's300f', n: by(w, 6, 10, 14), ch: 2 } });
            S.radar = addSite(w, 'radar', 'enemy', P(14800, 13600), { name: 'Radarstation Kap' });
            S.tick = 0; S.called = -99; S.calls = 0; S.best = 0; S.seen = new Set(); S.free = false;
            S.needSalvo = by(w, 6, 8, 8);
            objective(w, 'cruiser', 'Versenken Sie den Lenkwaffenkreuzer, bevor Verstärkung die Zufahrt schließt (Zeitlimit 12:00)');
            objective(w, 'salvo', `Koordinierte Salve: ${S.needSalvo} Flugkörper von mindestens zwei Schiffen gleichzeitig im Anflug auf den Kreuzer`, { optional: true });
            objective(w, 'battery', 'Schalten Sie die Küstenbatterie aus', { optional: true });
            w.score = { kind: 'count', player: 0, enemy: 0, target: 1 };
            radio(w, 'Verbandsführer', 'Verband läuft an. Alle Schiffe halten die Seezielflugkörper zurück, bis das Führungsschiff feuert.');
            later(S, 70, () => radio(w, 'Operationszentrale', 'Zwei Korvetten laufen uns als Vorposten entgegen. Sie tragen Seezielflugkörper – Radar an, Abwehr klar.'));
            later(S, 200, () => { if (S.cruiser.alive) radio(w, 'Operationszentrale', 'Der Kreuzer steht unter dem Schirm der Küstenstellungen. Einzelne Flugkörper kommen nicht durch – feuern Sie, wenn der ganze Verband in Reichweite ist.'); });
            // the cruiser does not wait for the clock: late in the mission it leaves its line and attacks the flagship
            const T = WEST_TUNE.blacksea[w.difficultyKey] || WEST_TUNE.blacksea.normal;
            if (T.out) later(S, T.out, () => {
               const c = S.cruiser, humans = w.net ? w.net.humans : [w.player];
               const F = [w.player, ...humans, ...S.allies].find(s => s && s.alive);      // the flagship, else another captain, else an escort
               if (!c.alive || !F) return;
               S.out = true;
               radio(w, 'Operationszentrale', 'Der Kreuzer wartet nicht auf die Verstärkung: Er verlässt seine Position vor der Bucht und läuft auf das Führungsschiff zu. Stellen Sie ihn!', 'warn');
               delete c.ai.patrol; c.ai.huntId = F.id; c.ai.press = true;
            });
         },
         update(w, dt, S) {
            // the flagship or a human captain has fired an anti-ship missile at a ship: strike call
            const humans = w.net ? w.net.humans : [w.player];
            // co-op (world.net is set after setup): the cruiser's hull is scaled once for a group with several captains
            if (!S.coop && humans.length > 1) {
               S.coop = true;
               const k = (WEST_TUNE.blacksea[w.difficultyKey] || WEST_TUNE.blacksea.normal).coopHp || 1, c = S.cruiser;
               c.hp = Math.round(c.hp * k); c.maxHP = Math.round(c.maxHP * k);
            }
            let n = 0, own = new Set();
            for (const m of w.missiles) {
               if (m.side !== 'player' || m.kind !== 'ssm') continue;
               if (m.target === S.cruiser.id) { n++; own.add(m.ownerId); }
               if (S.seen.has(m.id)) continue;
               S.seen.add(m.id);
               if (m.target == null || !humans.some(h => h.id === m.ownerId) || w.time - S.called < 12) continue;
               S.called = w.time; S.calls++;
               (w.strike || (w.strike = {})).player = { id: m.target, t: w.time };
               let k = 0;
               for (const a of S.allies) if (a.alive && a.ai && !humans.includes(a)) { a.ai.ssmT = 0.3 + 0.5 * k++; a.ai.ssmLeft = 0; a.ai.joined = null; }
               if (S.calls === 1) radio(w, 'Verbandsführer', 'Führungsschiff feuert. Alle Schiffe: Salve auf dasselbe Ziel, jetzt!');
            }
            if (n > S.best) S.best = n;
            if (n >= S.needSalvo && own.size >= 2 && objState(w, 'salvo') === 'active') {
               setObj(w, 'salvo', 'done');
               radio(w, 'Operationszentrale', `${n} Flugkörper gleichzeitig im Anflug auf den Kreuzer. Seine Abwehr ist übersättigt.`);
            }
            if ((S.tick -= dt) > 0) return;
            S.tick = 0.5;
            // the limit is part of the order: the radio counts down the last two minutes
            for (const k of [120, 60]) if (w.timeLeft <= k && (S.clockSaid || 999) > k) {
               S.clockSaid = k;
               radio(w, 'Operationszentrale', `Gegnerische Verstärkung läuft an – noch ${k === 120 ? 'zwei Minuten' : 'eine Minute'}, um den Kreuzer zu versenken.`, 'warn');
            }
            // hold fire between the calls (released for good when the flagship has no missile left)
            const lead = w.player;
            if (!S.free && (!lead.alive || !(lead.cfg.weapons.ssm || []).some(x => lead.mag[x.type] > 0))) {
               S.free = true;
               radio(w, 'Verbandsführer', 'Führungsschiff hat keine Seezielflugkörper mehr. Feuer frei für alle Schiffe.');
            }
            if (!S.free) for (const a of S.allies) if (a.alive && a.ai && !humans.includes(a) && w.time - S.called > 14 && !(a.ai.ssmLeft > 0)) a.ai.ssmT = 3;
            if (objState(w, 'salvo') === 'active') objText(w, 'salvo', `Koordinierte Salve: ${S.needSalvo} Flugkörper von mindestens zwei Schiffen gleichzeitig im Anflug auf den Kreuzer (bisher ${S.best})`);
         },
         onSink(w, ship, killer, S) {
            if (ship === S.cruiser) {
               setObj(w, 'cruiser', 'done'); w.score.player = 1;
               w.end(true, 'Der Lenkwaffenkreuzer ist versenkt.');
            } else if (S.boats.includes(ship) && S.boats.every(b => !b.alive) && S.cruiser.alive) {
               radio(w, 'Operationszentrale', 'Die Vorposten sind ausgeschaltet. Der Weg zum Kreuzer ist frei.');
            } else if (ship.side === 'player' && !ship.isPlayer) radio(w, 'Verbandsführer', ship.name + ' ist ausgefallen. Die Besatzung wird geborgen.', 'warn');
         },
         onSiteDestroyed(w, site, by_, S) {
            if (site === S.battery) { setObj(w, 'battery', 'done'); radio(w, 'Operationszentrale', 'Küstenbatterie ausgeschaltet.'); }
            else if (site === S.sam) radio(w, 'Operationszentrale', 'Flugabwehrstellung zerstört. Der Kreuzer hat seinen Schirm verloren.');
            else if (site === S.radar) radio(w, 'Operationszentrale', 'Radarstation zerstört. Der Gegner sieht uns jetzt später.');
         },
         timeout(w) { w.end(false, 'Die Zeit ist abgelaufen – der Kreuzer beherrscht weiter die Zufahrt.'); },
      },
      // ========================================================= 5. Nordatlantik – GIUK-Lücke
      // Submarine hunt. The boats are not on the map at the start: each one is reported by the script
      // and placed ahead of the convoy, outside torpedo range of every ship of the player side.
      {
         id: 'giuk', group: 'ops', name: 'Nordatlantik – GIUK-Lücke', subtitle: 'U-Jagd · Bordhubschrauber, Tauchsonar, Leichtgewichtstorpedos',
         briefing: 'Drei Versorger laufen durch die Lücke zwischen Island und Schottland nach Osten. Mehrere konventionelle U-Boote lauern am Kurs. ' +
            'Ihr Rumpfsonar reicht nur wenige Kilometer – der Bordhubschrauber setzt sein Tauchsonar weit voraus und wirft selbst Leichtgewichtstorpedos. ' +
            'Schicken Sie ihn dorthin, wo ein Kontakt gemeldet wird, und bekämpfen Sie das Boot, bevor das Geleit in seine Torpedoreichweite läuft. ' +
            'Mindestens zwei Versorger müssen durchkommen.',
         debrief: 'Das Geleit ist durch. Ein U-Boot, das geortet ist, hat seinen größten Vorteil verloren – der Hubschrauber findet es, bevor es in Schussweite ist.',
         fleet: { own: 'U-Jagd-Schiff mit Bordhubschrauber, 1 Korvette (ohne U-Jagd-Waffen), 3 Versorger', foe: '3–5 konventionelle U-Boote' },
         env: { time: 'dawn', weather: 'rain' }, type: 'escort', playableShips: ['Sachsen', 'Burke'], recommendedShip: 'Sachsen',
         arena: 20000, timeLimit: 11 * 60, stars: 2,
         setup(w, shipKey) {
            const S = w._script;
            islands(w, [{ c: P(-3000, 17500), r: 1500, height: 200, seed: 131, lobes: 5, elong: 2.4, rot: 0.1, rough: 0.7, name: 'Schären' }]);
            add(w, shipKey, 'player', P(-10600, 900), 0, { isPlayer: true });
            const route = [P(-2000, 300), P(4500, -400), P(9500, 0)];
            S.convoy = [
               add(w, 'Container', 'player', P(-12200, -300), 0, { name: 'MV Nordkap', speedKn: 16, ai: { route } }),
               add(w, 'Tanker', 'player', P(-13400, -300), 0, { name: 'MT Skagerrak', speedKn: 16, ai: { route } }),
               add(w, 'Container', 'player', P(-14600, -300), 0, { name: 'MV Färöer', speedKn: 16, ai: { route } }),
            ];
            S.ally = add(w, 'Braunschweig', 'player', P(-13400, -1900), 0, { ai: { escortId: S.convoy[1].id } });
            S.goal = zone(w, 9500, 0, 1800, 'Sammelpunkt Ost');
            S.need = 2; S.arrived = 0; S.lost = 0; S.tick = 0; S.subs = []; S.planned = by(w, 3, 3, 4) + (shipKey === 'Burke' ? by(w, 0, 1, 1) : 0);      // the towed-array destroyer faces one boat more
            objective(w, 'convoy', 'Bringen Sie die Versorger durch die Lücke (0/3 am Ziel, mindestens 2)');
            objective(w, 'subs', `Versenken Sie alle U-Boote (0/${S.planned})`, { optional: true });
            objective(w, 'all', 'Kein Versorger geht verloren', { optional: true });
            w.score = { kind: 'count', player: 0, enemy: 0, target: 3 };
            radio(w, 'Geleitführer', 'Geleit läuft mit 16 Knoten nach Osten. U-Boote am Kurs gemeldet – Sonar besetzen, Bordhubschrauber klar zum Start.');
            // a boat is placed relative to the leading merchant: `ahead` m along the course, `side` m abeam
            const boat = (cls, ahead, side, text) => {
               const lead = S.convoy.find(m => m.alive);
               if (!lead || w.phase !== 'playing') return;
               let pos = P(Math.min(lead.pos.x + ahead, 16500), lead.pos.y + side);
               const friends = w.ships.filter(s => s.alive && s.side === 'player');
               for (let k = 0; k < 12 && friends.some(f => hyp(f.pos, pos) < 10500); k++) pos = P(Math.min(pos.x + 900, 17500), pos.y + Math.sign(side || 1) * 700);
               // the boat lies in ambush beside the track and creeps towards it; the script fires its tubes (see update)
               const s = add(w, cls, 'enemy', pos, Math.PI, { depth: 1, speedKn: 5, hpMult: by(w, 0.8, 0.98, 0.96) * (S.coopHp || 1), dmgMult: by(w, 0.6, 1, 1), ai: { route: [P(pos.x - 600, pos.y * 0.75)] } });
               for (const k of Object.keys(s.mag || {})) s.mag[k] = 0;      // torpedoes only
               // the report is a datum, not a fix: a red area on the map that contains the boat somewhere
               const o = (((w.seed >>> 0) * 31 + S.subs.length * 977) % 1000) / 1000 * Math.PI * 2;
               s._datum = zone(w, pos.x + Math.cos(o) * 900, pos.y + Math.sin(o) * 900, 2400, 'Kontakt ' + (S.subs.length + 1), 'danger');
               S.subs.push(s);
               radio(w, 'Operationszentrale', text, 'warn');
            };
            later(S, 12, () => boat('Kilo', 11500, 1800, 'Unterwasserkontakt voraus, etwas an Backbord. Hubschrauber starten und Tauchsonar setzen!'));
            later(S, by(w, 125, 110, 100), () => boat('Yuan', 11000, -2600, 'Zweiter Kontakt an Steuerbord voraus. Das Boot läuft auf das Geleit zu.'));
            later(S, by(w, 215, 200, 190), () => boat('Kilo', 11000, 2400, 'Dritter Kontakt an Backbord voraus. Hubschrauber neu ansetzen.'));
            if (S.planned > 3) later(S, 150, () => boat('Kilo', 11500, -2000, 'Weiterer Kontakt recht voraus.'));
            if (S.planned > 4) later(S, 250, () => boat('Yuan', 11000, 2200, 'Noch ein Kontakt voraus. Das Geleit ist kurz vor dem Sammelpunkt.'));
            later(S, 60, () => radio(w, 'Operationszentrale', 'Hinweis: Ein geortetes U-Boot bekämpft der Hubschrauber mit eigenen Torpedos. Unsere Leichtgewichtstorpedos reichen nur wenige Kilometer.'));
         },
         // co-op (net/setup.js, once the captains have their ships): the corvette has no sonar and no
         // torpedoes, so under a human captain it embarks a helicopter for `coopHelo` sorties; the
         // boats, reported later, then have a `coopHp` times tougher hull
         coop(w, S, humans) {
            const a = S.ally, T = WEST_TUNE.giuk[w.difficultyKey] || WEST_TUNE.giuk.normal;
            if (!T.coopHelo || !humans.includes(a) || a.cfg.helo) return;
            a.cfg = { ...a.cfg, helo: { name: 'Sea Lynx' } };
            a.addConsumable({ key: 'helo', charges: T.coopHelo, dur: 1, cd: 70 });
            S.coopHp = T.coopHp || 1;
            radio(w, 'Geleitführer', a.name + ' hat für diesen Einsatz einen Bordhubschrauber eingeschifft.');
         },
         update(w, dt, S) {
            if ((S.tick -= dt) > 0) return;
            S.tick = 1;
            // ambush: a boat at periscope depth with a loaded bow fires a narrow spread at the nearest merchant in range
            const R = by(w, 3400, 4200, 4400);
            for (const s of S.subs) {
               if (!s.alive || s.depth > 1) continue;
               let tgt = null, dm = R;
               for (const m of S.convoy) if (m.alive && !m.escaped && hyp(m.pos, s.pos) < dm) { dm = hyp(m.pos, s.pos); tgt = m; }
               if (!tgt || dm < 500) continue;
               const t = dm / s.cfg.torp.speed;
               const brg = Math.atan2(tgt.pos.y + tgt.vel.y * t - s.pos.y, tgt.pos.x + tgt.vel.x * t - s.pos.x);
               s.ai.route = [P(s.pos.x + Math.cos(brg) * 400, s.pos.y + Math.sin(brg) * 400)]; s.ai.routeIdx = 0;      // lay the bow on
               if (!s.torpLauncherFor(brg)) continue;
               s.setTorpSpread('narrow');
               if (s.fireTorpedoes(w, brg) > 0 && !s._shot) { s._shot = true; radio(w, 'Operationszentrale', 'Torpedos im Wasser! Das U-Boot hat auf das Geleit geschossen.', 'warn'); }
            }
            const sunk = S.subs.filter(s => !s.alive).length;
            if (S.subs.length >= S.planned && sunk >= S.planned && S.lost <= S.convoy.length - S.need) {
               if (!S.lost) setObj(w, 'all', 'done');
               setObj(w, 'convoy', 'done');
               w.end(true, 'Alle U-Boote sind versenkt – der Weg für das Geleit ist frei.');
               return;
            }
            if (!convoyTick(w, S, 'Bringen Sie die Versorger durch die Lücke')) return;
            if (S.arrived >= S.need) {
               if (!S.lost) setObj(w, 'all', 'done');
               setObj(w, 'convoy', 'done');
               w.end(true, S.lost ? 'Das Geleit ist durch – ein Versorger ging verloren.' : 'Alle Versorger haben den Sammelpunkt erreicht.');
            } else w.end(false, 'Zu viele Versorger gingen verloren.');
         },
         onSink(w, ship, killer, S) {
            if (S.subs.includes(ship)) {
               const n = S.subs.filter(s => !s.alive).length;
               objText(w, 'subs', `Versenken Sie alle U-Boote (${n}/${S.planned})`);
               if (n >= S.planned) setObj(w, 'subs', 'done');
               radio(w, 'Operationszentrale', 'Unterwasserkontakt vernichtet.');
               const zi = w.mission.zones.indexOf(ship._datum);
               if (zi >= 0) w.mission.zones.splice(zi, 1);
               return;
            }
            if (!convoyLoss(w, S, ship)) return;
            radio(w, 'Geleitführer', ship.name + ' ist torpediert und sinkt. Rettungsinseln sind im Wasser.', 'warn');
            if (S.lost > S.convoy.length - S.need) w.end(false, 'Zwei Versorger gingen verloren – der Auftrag ist gescheitert.');
         },
         timeout(w, S) {
            if (S.arrived >= S.need) { setObj(w, 'convoy', 'done'); w.end(true, 'Das Geleit ist durch – ein Nachzügler blieb zurück.'); }
            else w.end(false, 'Die Zeit ist abgelaufen – das Geleit hat den Sammelpunkt nicht erreicht.');
         },
      },
   ];
}
