// gamev2/missions_special_a.js — special operations, set A. Definitions are built with the helpers of
// missions.js (passed in, no import cycle). Fictional present-day scenarios: no real persons, merchant
// ships are only ever protected, never targets. Radio traffic is German (UI), code and comments English.
//
// Conventions as in missions_west.js / missions_east.js: S (= world._script) carries the mission state,
// ships are kept by id (net/CONTRACT.md), S.tick paces the bookkeeping, by(w, easy, normal, hard) picks
// a value for the difficulty. The mission ticks allocate nothing per frame.
import { addSite } from './sites.js';
import { addTaskPoint } from './seal.js';

// Balance knobs per mission and difficulty (tests/v2.missions.speciala.test.mjs measures them with a bot captain).
// cable: `cable` s the seabed cable holds while the anchor drags, `ships` merchants in the area, `look` s
// a merchant has to be in sight until it is identified, `board` s alongside until the boarding team has the
// bridge, `boats` armed boats (`boatHp` / `boatDmg` their hull and damage factors), `corvette` s into the
// mission at which the corvette arrives (0 = never), `hint` = the situation centre narrows the search to two ships,
// `decoys` further merchants that run as slowly as the dragging one (engine trouble), so speed alone does not give it away.
// Measured with one bot captain (Sachsen, 30 runs): the captain needs 195-265 s (normal) and 205-270 s (hard: longer look and
// boarding, two decoys, four boats), so the cable time is the main knob; hard therefore has the longer cable of the two.
export const SPECIAL_A_TUNE = {
   cable: {
      easy: { cable: 450, ships: 4, look: 2, board: 14, boats: 2, boatHp: 0.7, boatDmg: 0.7, corvette: 0, hint: true, decoys: 0 },
      normal: { cable: 220, ships: 5, look: 3, board: 20, boats: 3, boatHp: 1, boatDmg: 1, corvette: 120, hint: false, decoys: 1 },
      hard: { cable: 232, ships: 5, look: 4, board: 26, boats: 4, boatHp: 1.2, boatDmg: 1.2, corvette: 90, hint: false, decoys: 2 },
   },
   // rig: `valves` s until the occupiers open the valves, `boats` armed boats moored at the platform of which `guards`
   // stay there until a warship is inside RIG.guard, `teams` boarding teams on board, `board` s a team needs on the
   // platform, `post` missiles of the launcher on the reef fired `salvo` at a time every `every` s.
   // Measured with one bot captain (Sachsen, 30 runs): 100 % / 60 % / 30 %. The captain's team is on the platform after
   // 210-260 s on every level, so the valves do not decide his runs: he loses his ship to the boats' rockets while he
   // lies stopped in the circle (number of boats x boatDmg is the knob that moves the win rate).
   rig: {
      easy: { valves: 480, boats: 3, guards: 1, boatHp: 0.7, boatDmg: 0.6, teams: 3, board: 20, post: 3, salvo: 1, every: 40 },
      normal: { valves: 330, boats: 5, guards: 2, boatHp: 1.1, boatDmg: 1.38, teams: 2, board: 30, post: 6, salvo: 2, every: 34 },
      hard: { valves: 300, boats: 6, guards: 3, boatHp: 1.2, boatDmg: 1.2, teams: 2, board: 40, post: 8, salvo: 2, every: 28 },
   },
};
// rig: the platform (x, y) and the radius in which any shell or warhead counts as a hit on it (r); a boat leaves its
// mooring when a warship is inside `sortie` (the guards: `guard`); a team goes over from a warship inside `launch` that
// runs at no more than `slow` of its top speed while no armed boat is inside `clear` of the platform; `safe` is the
// distance from the platform inside which the group's own bot captains hold their guns (world._script.noFire)
export const RIG = { x: 600, y: 200, r: 110, sortie: 5000, guard: 2200, launch: 1500, slow: 0.3, clear: 1000, safe: 280, teamSpeed: 30, relaunch: 12 };
// cable: how close a ship / a helicopter has to be to make out a merchant's anchor gear at night (m),
// boarding distance (m) and the share of its top speed a boarding ship may run at most
export const CABLE = { visShip: 1800, visHelo: 1300, boardDist: 500, boardSpeed: 0.5, cover: 900, damaged: 0.7 };

export function specialMissionsA(H) {
   const { P, add, objective, setObj, objText, later, radio, zone, islands, combatants } = H;
   const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
   const objState = (w, id) => (w.mission.objectives.find(o => o.id === id) || {}).state;
   const clock = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
   const rnd = (w, salt) => { const x = Math.sin((w.seed % 100000) * 12.9898 + salt * 78.233) * 43758.5453; return x - Math.floor(x); };
   // The opponent's sensors and weapons leave a merchant alone: it is never 'detected' for the other
   // side (World.canSee), so no bot aims at it and no missile is launched at it.
   const civilian = (ship) => {
      Object.defineProperty(ship, 'detected', { get: () => false, set() {}, configurable: true });
      Object.defineProperty(ship, 'targetable', { get: () => false, set() {}, configurable: true });
      return ship;
   };

   return [
      // ========================================================= Ostsee – Kabelbruch
      // Several merchants cross the area at night; one drags its anchor over a seabed data cable. A merchant
      // is identified by eye: a warship of the group within CABLE.visShip or its helicopter within
      // CABLE.visHelo for `look` seconds. The dragging ship is stopped without a shot: a warship stays
      // within CABLE.boardDist at no more than half speed for `board` seconds while no armed boat covers
      // the merchant. The cable holds `cable` seconds; when it parts the mission is lost.
      {
         id: 'cable', group: 'ops', name: 'Ostsee – Kabelbruch', subtitle: 'Nachteinsatz · Handelsschiffe aufklären, Ankerschlepper entern',
         briefing: 'Die Kabelüberwachung meldet Zug auf einem Seekabel: Eines der Handelsschiffe im Gebiet schleift seinen Anker über den Grund. ' +
            'Finden Sie heraus, welches – aus der Nähe (unter einer Seemeile) oder mit dem Bordhubschrauber, den Sie über ein Schiff schicken, ist die Ankerkette zu erkennen. ' +
            'Wer einen Anker schleppt, läuft außerdem langsamer als die anderen. Stoppen Sie das Schiff ohne einen Schuss: auf 500 m längsseits gehen, ' +
            'höchstens halbe Fahrt, und so bleiben, bis das Boardingteam die Brücke hat. Bewaffnete Boote ohne Kennung decken den Frachter und dürfen bekämpft werden; ' +
            'solange eines neben ihm steht, kann das Team nicht übersetzen. Kein Handelsschiff darf zu Schaden kommen – und das Kabel hält nur wenige Minuten.',
         debrief: 'Der Frachter liegt gestoppt, das Kabel hält. Entschieden hat nicht die Feuerkraft, sondern die Reihenfolge: erst aufklären, dann die Deckung abdrängen, ' +
            'dann längsseits gehen und ruhig bleiben, bis das Team an Bord ist.',
         fleet: { own: 'Fregatte oder Zerstörer mit Bordhubschrauber, 1 Korvette', foe: '2–4 bewaffnete Boote ohne Kennung, später 1 Korvette · 4–5 Handelsschiffe (zu schützen)' },
         env: { time: 'night', weather: 'overcast' }, type: 'boarding', playableShips: ['Sachsen', 'Daring'], recommendedShip: 'Sachsen',
         arena: 12000, timeLimit: 10 * 60, stars: 2,
         setup(w, shipKey) {
            const S = w._script, T = SPECIAL_A_TUNE.cable[w.difficultyKey] || SPECIAL_A_TUNE.cable.normal;
            islands(w, [
               { c: P(-2500, 11400), r: 1900, height: 70, seed: 141, lobes: 5, elong: 3, rot: 0, rough: 0.4, name: 'Nordufer' },
               { c: P(4200, -11300), r: 1700, height: 60, seed: 147, lobes: 5, elong: 2.6, rot: 0.1, rough: 0.4, name: 'Südufer' },
            ]);
            const p = add(w, shipKey, 'player', P(-9200, -400), 0, { isPlayer: true });
            S.allyId = add(w, 'Braunschweig', 'player', P(-10300, 1300), 0, { name: 'Oldenburg', dmgMult: 0.6, ai: { escortId: p.id } }).id;
            // merchants: westbound on separate lanes, the one that drags its anchor at 8 kn, the others faster
            const lanes = [-5200, -2600, 100, 2700, 5300], kinds = ['Container', 'Tanker', 'LNG', 'Container', 'Tanker'];
            const names = ['MV Baltic Wind', 'MT Nordland', 'LNG Polarstern', 'MV Hanse Trader', 'MT Seevogel'];
            const n = T.ships, sus = Math.floor(rnd(w, 1) * n) % n, off = Math.floor(rnd(w, 2) * 5);
            S.merch = []; S.look = []; S.clean = 0;
            for (let i = 0; i < n; i++) {
               const y = lanes[(i + off) % 5], x = 5200 + rnd(w, 10 + i) * 3200;
               const m = civilian(add(w, kinds[i], 'player', P(x, y), Math.PI, { name: names[i], speedKn: (i - sus + n) % n <= T.decoys ? 8 : 11 + Math.floor(rnd(w, 20 + i) * 3), ai: { passive: true, route: [P(-10800, y)] } }));
               S.merch.push(m.id); S.look.push(0);
            }
            S.susId = S.merch[sus]; S.susName = names[sus];
            // armed boats: loiter between the lanes until the group has found the ship, then close round it
            S.boats = [];
            for (let i = 0; i < T.boats; i++) {
               const c = P(1200 + (i % 2) * 2200, (i - (T.boats - 1) / 2) * 2600);
               S.boats.push(add(w, 'Boghammar', 'enemy', c, Math.PI, { name: 'Boot ohne Kennung ' + (i + 1), speedKn: 30, hpMult: T.boatHp, dmgMult: T.boatDmg,
                  ai: { patrol: [c, P(c.x + 1500, c.y + 700), P(c.x + 600, c.y - 900)], aggro: 1.3 } }).id);
            }
            S.total = T.cable; S.cable = T.cable; S.need = T.board; S.board = 0; S.tick = 0; S.found = false; S.said = 0; S.whyT = -99; S.half = false; S.done = false;
            objective(w, 'find', `Klären Sie die Handelsschiffe auf: Welches schleppt den Anker? (0/${n} geprüft)`);
            objective(w, 'stop', `Stoppen Sie den Ankerschlepper durch Boarding, bevor das Kabel reißt (hält noch ${clock(S.cable)})`);
            objective(w, 'cable50', 'Das Kabel behält mindestens die Hälfte seiner Tragfähigkeit', { optional: true });
            objective(w, 'boats', `Schalten Sie alle bewaffneten Boote aus (0/${T.boats})`, { optional: true });
            w.score = { kind: 'count', player: 100, enemy: 0, target: 100 };
            radio(w, 'Lagezentrum', `Zug auf dem Seekabel, es hält noch etwa ${Math.round(S.cable / 60)} Minuten. ${n} Handelsschiffe laufen von Osten durch das Gebiet – eines schleppt seinen Anker. Radar an, Hubschrauber klar.`);
            later(S, 14, () => radio(w, 'Wachoffizier', 'Zum Aufklären näher als eine Seemeile an ein Schiff heran – oder den Bordhubschrauber auf der Karte über das Schiff schicken. Der Ankerschlepper läuft langsamer als die anderen' + (T.decoys ? ' – aber nicht jedes langsame Schiff schleppt einen Anker.' : '.')));
            if (T.hint) later(S, 40, () => {
               if (S.found) return;
               const other = names[(sus + 1 + Math.floor(rnd(w, 3) * (n - 1))) % n], pair = sus % 2 ? [other, names[sus]] : [names[sus], other];
               radio(w, 'Lagezentrum', `Auswertung der Schiffsmeldungen: Auffällig langsam laufen ${pair[0]} und ${pair[1]}. Eines der beiden ist es.`);
            });
            later(S, 55, () => { if (S.boats.some(id => w.shipById(id)?.alive)) radio(w, 'Operationszentrale', 'Kleine schnelle Kontakte zwischen den Handelsschiffen, keine Kennung, bewaffnet. Freigabe zur Bekämpfung – nur die Boote, kein Handelsschiff!', 'warn'); });
            if (T.corvette) later(S, T.corvette, () => {
               if (w.phase !== 'playing' || S.done) return;
               const lead = [w.player, ...(w.net ? w.net.humans : [])].find(s => s && s.alive) || w.shipById(S.allyId);
               if (!lead || !lead.alive) return;
               const c = add(w, 'BuyanM', 'enemy', P(10800, -1500), Math.PI, { name: 'Korvette ohne Kennung', minDist: 12500, ai: { huntId: lead.id, press: true } });
               S.corvId = c.id;
               radio(w, 'Operationszentrale', 'Eine Korvette läuft von Osten an und hält auf uns zu. Ihre Seezielflugkörper unterscheiden nicht zwischen uns und einem Frachter, neben dem wir stehen: Fangen Sie sie ab, sonst trifft es ein Handelsschiff – oder versenken Sie die Korvette.', 'warn');
            });
         },
         update(w, dt, S) {
            if ((S.tick -= dt) > 0) return;
            const step = 0.5; S.tick += step;
            if (S.done) return;
            const T = SPECIAL_A_TUNE.cable[w.difficultyKey] || SPECIAL_A_TUNE.cable.normal;
            const sus = w.shipById(S.susId);
            // a merchant badly hit: the rule of the briefing
            for (let i = 0; i < S.merch.length; i++) {
               const m = w.shipById(S.merch[i]);
               if (m && m.alive && m.hp < m.maxHP * CABLE.damaged) { w.end(false, m.name + ' wurde schwer beschädigt – Handelsschiffe durften nicht zu Schaden kommen.'); return; }
            }
            if (!sus || !sus.alive) return;
            // identification by eye: warship or helicopter of the group close to a merchant
            for (let i = 0; i < S.merch.length; i++) {
               if (S.look[i] < 0) continue;
               const m = w.shipById(S.merch[i]);
               if (!m || !m.alive) continue;
               let near = false;
               for (const s of w.ships) if (s.alive && s.side === 'player' && s.type !== 'TR' && !(s.depth > 0) && hyp(s.pos, m.pos) < CABLE.visShip) { near = true; break; }
               if (!near) for (const h of w.helos) if (h.alive && h.side === 'player' && hyp(h.pos, m.pos) < CABLE.visHelo) { near = true; break; }
               if (!near) { S.look[i] = Math.max(0, S.look[i] - step * 0.5); continue; }
               if ((S.look[i] += step) < T.look) continue;
               S.look[i] = -1;
               if (m.id === S.susId) this.identify(w, S, m);
               else {
                  S.clean++;
                  radio(w, 'Ausguck', `${m.name}: Anker in der Klüse, Kette trocken. Unauffällig.` + (S.found ? '' : S.merch.length - S.clean === 1 ? ' Dann bleibt nur noch eines.' : ''));
                  // every other ship is cleared: the last one is it
                  if (!S.found && S.clean >= S.merch.length - 1) { S.look[S.merch.indexOf(S.susId)] = -1; this.identify(w, S, sus); }
               }
               if (!S.found) objText(w, 'find', `Klären Sie die Handelsschiffe auf: Welches schleppt den Anker? (${S.clean}/${S.merch.length} geprüft)`);
            }
            // the cable
            S.cable = Math.max(0, S.cable - step);
            const pct = Math.round(S.cable / S.total * 100);
            w.score.player = pct;
            if (pct < 50 && !S.half) {
               S.half = true; setObj(w, 'cable50', 'failed');
               radio(w, 'Lagezentrum', `Das Kabel hat die Hälfte seiner Tragfähigkeit verloren. Es hält noch ${clock(S.cable)}.`, 'warn');
            }
            if (S.cable <= 60 && S.said < 1) { S.said = 1; radio(w, 'Lagezentrum', 'Das Kabel reißt in einer Minute! Der Frachter muss jetzt gestoppt werden.', 'warn'); }
            if (S.cable <= 0) {
               setObj(w, 'stop', 'failed');
               w.end(false, S.found ? `Das Seekabel ist durchtrennt – ${S.susName} wurde nicht rechtzeitig gestoppt.` : 'Das Seekabel ist durchtrennt – der Ankerschlepper wurde nicht gefunden.');
               return;
            }
            if (!S.found) { objText(w, 'stop', `Stoppen Sie den Ankerschlepper durch Boarding, bevor das Kabel reißt (hält noch ${clock(S.cable)})`); return; }
            // boarding: a warship of the group alongside at low speed, no armed boat beside the merchant
            let why = 1, covered = false;      // 1 = nobody alongside, 2 = too fast, 3 = covered by a boat, 0 = boarding
            for (let i = 0; i < S.boats.length; i++) { const b = w.shipById(S.boats[i]); if (b && b.alive && hyp(b.pos, sus.pos) < CABLE.cover) { covered = true; break; } }
            for (const s of w.ships) {
               if (!s.alive || s.side !== 'player' || s.type === 'TR' || s.depth > 0 || hyp(s.pos, sus.pos) > CABLE.boardDist) continue;
               if (Math.abs(s.speed) > s.maxSpeed * CABLE.boardSpeed) { if (why === 1) why = 2; continue; }
               why = covered ? 3 : 0;
               break;
            }
            if (why === 0) {
               if (S.board === 0) radio(w, 'Boardingteam', `Wir setzen über. Position und Fahrt halten – ${S.need} Sekunden.`);
               S.board += step;
            } else {
               if (S.board > 0 && w.time - S.whyT > 15) {
                  S.whyT = w.time;
                  radio(w, 'Boardingteam', why === 3 ? 'Ein bewaffnetes Boot steht neben dem Frachter – so können wir nicht übersetzen. Boot abdrängen oder bekämpfen!'
                     : why === 2 ? 'Zu schnell! Höchstens halbe Fahrt, sonst kommen wir nicht an die Bordwand.' : 'Abstand zu groß – auf 500 m an den Frachter heran und dort bleiben.', 'warn');
               }
               S.board = Math.max(0, S.board - step * 0.5);
            }
            objText(w, 'stop', `Stoppen Sie ${S.susName} durch Boarding: auf 500 m längsseits, höchstens halbe Fahrt (${Math.min(S.need, Math.floor(S.board))}/${S.need} s) – Kabel hält noch ${clock(S.cable)}`);
            if (S.board < S.need) return;
            S.done = true;
            delete sus.ai.route; sus.ai.anchored = true;
            setObj(w, 'stop', 'done');
            if (!S.half) setObj(w, 'cable50', 'done');
            radio(w, 'Boardingteam', 'Brücke ist in unserer Hand, Maschine gestoppt. Der Anker wird gehievt.');
            w.end(true, S.half ? `${S.susName} ist gestoppt – das Kabel ist beschädigt, aber es hält.` : `${S.susName} ist gestoppt, das Kabel ist kaum beschädigt.`);
         },
         // the dragging ship is found: the boats close round it
         identify(w, S, m) {
            S.found = true;
            setObj(w, 'find', 'done', `${m.name} schleppt den Anker`);
            radio(w, 'Ausguck', `${m.name}: Backbordkette läuft straff nach achtern aus – das ist der Ankerschlepper! Auf 500 m längsseits gehen, höchstens halbe Fahrt, Boardingteam klar.`, 'warn');
            let n = 0;
            for (let i = 0; i < S.boats.length; i++) {
               const b = w.shipById(S.boats[i]);
               if (!b || !b.alive || !b.ai) continue;
               delete b.ai.patrol; b.ai.escortId = m.id; n++;
            }
            if (n) later(S, w.time + 6, () => radio(w, 'Operationszentrale', 'Die Boote laufen auf den Frachter zu und decken ihn. Solange eines neben ihm steht, kann das Team nicht übersetzen.', 'warn'));
         },
         onSink(w, ship, killer, S) {
            if (S.merch.includes(ship.id)) { w.end(false, ship.name + ' ist gesunken – Handelsschiffe durften nicht zu Schaden kommen.'); return; }
            if (S.boats.includes(ship.id)) {
               let n = 0;
               for (let i = 0; i < S.boats.length; i++) { const b = w.shipById(S.boats[i]); if (!b || !b.alive) n++; }
               objText(w, 'boats', `Schalten Sie alle bewaffneten Boote aus (${n}/${S.boats.length})`);
               if (n >= S.boats.length) { setObj(w, 'boats', 'done'); radio(w, 'Operationszentrale', 'Alle Boote sind ausgeschaltet. Der Frachter hat keine Deckung mehr.'); }
               return;
            }
            if (ship.id === S.corvId) { radio(w, 'Operationszentrale', 'Die Korvette ist ausgefallen.'); return; }
            if (ship.side === 'player' && !combatants(w, 'player').length) w.end(false, 'Ihr Verband ist ausgefallen – niemand kann den Frachter mehr stoppen.');
            else if (ship.side === 'player' && objState(w, 'stop') === 'active') radio(w, 'Operationszentrale', ship.name + ' ist ausgefallen. Die Besatzung wird geborgen.', 'warn');
         },
         timeout(w) { w.end(false, 'Die Zeit ist abgelaufen – das Seekabel ist durchtrennt.'); },
      },

      // ========================================================= Nordsee – Bohrinsel
      // Armed men hold a gas platform and its crew. The platform is a land position of the other side standing in
      // open water (hidden: no missile locks on it, no bot aims at it); any damage to it - a shell that comes down
      // inside RIG.r, a warhead set on its position - loses the mission. Their boats lie moored at its legs, where
      // they cannot be shot at, and come out when a warship closes (the guards only at RIG.guard). A boarding team
      // (seal.js team, launched by the mission) goes over from a warship inside RIG.launch at low speed once no boat
      // is near the platform, and needs `board` seconds there. A boat that stays close to the team's craft for a few
      // seconds drives it off (seal.js: spotted); the mission is lost with the last team or when the valves open.
      {
         id: 'rig', group: 'ops', name: 'Nordsee – Bohrinsel', subtitle: 'Geiselnahme · Boote herauslocken, Boardingteam übersetzen',
         briefing: 'Bewaffnete haben die Gasförderplattform Dogger Alpha besetzt und halten die Besatzung fest. Sie drohen, in wenigen Minuten die Ventile zu öffnen. ' +
            'Schwere Waffen auf die Plattform sind verboten: Schlägt eine Granate oder ein Flugkörper auf ihr ein, ist der Einsatz verloren. ' +
            'Die Boote der Besetzer liegen an den Plattformbeinen – dort sind sie nicht zu bekämpfen. Kommen Sie näher, laufen sie aus: Schießen Sie erst, wenn ein Boot frei von der Plattform ist. ' +
            'Auf dem Riff im Nordwesten steht ein Flugkörperstarter, der Sie auf dem Anmarsch beschießt. ' +
            'Ist kein Boot mehr an der Plattform, gehen Sie in den markierten Kreis (1,5 km) und nehmen die Fahrt heraus (höchstens ein Viertel): Das Boardingteam setzt dann selbst über. ' +
            'Ein Boot, das dem Team zu nahe kommt, zwingt es zum Abdrehen – Sie haben nur wenige Teams. Verloren ist der Einsatz auch, wenn die Ventile geöffnet werden oder Ihr Verband ausfällt.',
         debrief: 'Die Plattform ist gesichert, die Besatzung frei – ohne einen Treffer auf der Anlage. Entschieden hat die Feuerdisziplin: warten, bis die Boote von der Plattform ' +
            'gelöst sind, sie im freien Wasser stellen und erst dann das Team hinüberschicken.',
         fleet: { own: 'Fregatte oder Zerstörer, 1 Korvette · 2–3 Boardingteams', foe: '3–6 bewaffnete Boote an der Plattform, 1 Flugkörperstarter auf dem Riff' },
         env: { time: 'dusk', weather: 'overcast' }, type: 'boarding', playableShips: ['Sachsen', 'Daring'], recommendedShip: 'Sachsen',
         arena: 12000, timeLimit: 10 * 60, stars: 3,
         setup(w, shipKey) {
            const S = w._script, T = SPECIAL_A_TUNE.rig[w.difficultyKey] || SPECIAL_A_TUNE.rig.normal;
            islands(w, [{ c: P(-1700, 4700), r: 520, height: 26, seed: 163, lobes: 4, elong: 1.5, rot: 0.4, rough: 0.5, name: 'Doggerriff' }]);
            const p = add(w, shipKey, 'player', P(-9300, -700), 0, { isPlayer: true });
            S.allyId = add(w, 'Braunschweig', 'player', P(-10400, 900), 0, { name: 'Oldenburg', dmgMult: 0.6, ai: { escortId: p.id } }).id;
            const plat = addSite(w, 'bunker', 'enemy', P(RIG.x, RIG.y), { inland: true, hidden: true, radar: null, hp: 60000, r: RIG.r, heading: 0.5, name: 'Dogger Alpha' });
            plat.model = 'platform';                  // missiles3d.js draws the platform instead of a bunker
            S.platId = plat.id;
            S.postId = addSite(w, 'battery', 'enemy', P(-2200, 4400), { name: 'Flugkörperstarter Doggerriff', hp: 2400, ssm: { type: 'kowsar', n: T.post }, salvo: T.salvo, interval: T.every, delay: 20 }).id;
            S.taskId = addTaskPoint(w, { x: RIG.x, y: RIG.y, kind: 'boarding', label: 'Dogger Alpha', workTime: T.board }).id;
            zone(w, RIG.x, RIG.y, RIG.launch, 'Dogger Alpha', 'goal');
            // boats: moored round the legs (ai.anchored: the boat does nothing at all until the mission lets it go)
            S.boats = [];
            for (let i = 0; i < T.boats; i++) {
               const a = i * 2.4 + 0.7;
               S.boats.push(add(w, 'Boghammar', 'enemy', P(RIG.x + Math.cos(a) * 75, RIG.y + Math.sin(a) * 75), a, { name: 'Boot der Besetzer ' + (i + 1), hpMult: T.boatHp, dmgMult: T.boatDmg, ai: { anchored: true, aggro: 1.3 } }).id);
            }
            S.total = T.valves; S.valves = T.valves; S.teamsLeft = T.teams; S.teamId = null; S.lost = 0; S.relT = 0; S.tick = 0; S.said = 0; S.whyT = -99; S.out = 0; S.done = false;
            // the group's own bot captains hold their guns while the fall of shot would lie at the platform
            S.noFire = (b, aim) => b.side === 'player' && Math.hypot(aim.x - RIG.x, aim.y - RIG.y) < RIG.safe;
            S.onTaskDone = (ww, task) => { if (task.id === S.taskId) this.secured(ww, S); };
            S.onTeamLost = (ww, team) => { if (team.id === S.teamId) this.teamLost(ww, S); };
            objective(w, 'board', `Bringen Sie ein Boardingteam auf die Plattform, bevor die Ventile geöffnet werden (noch ${clock(S.valves)})`);
            objective(w, 'post', 'Schalten Sie den Flugkörperstarter auf dem Riff aus', { optional: true });
            objective(w, 'boats', `Schalten Sie alle Boote der Besetzer aus (0/${T.boats})`, { optional: true });
            objective(w, 'team', 'Kein Boardingteam muss abdrehen', { optional: true });
            w.score = { kind: 'count', player: 100, enemy: 0, target: 100 };
            radio(w, 'Lagezentrum', `Dogger Alpha ist besetzt, die Besatzung wird festgehalten. Die Besetzer öffnen in ${Math.round(S.valves / 60)} Minuten die Ventile. Keine schweren Waffen auf die Plattform – ein Treffer dort, und der Einsatz ist verloren.`, 'warn');
            later(S, 12, () => radio(w, 'Wachoffizier', `${T.boats} Boote liegen an den Plattformbeinen, dort dürfen wir nicht schießen. Wenn wir näher kommen, laufen sie aus – Feuer erst, wenn sie frei von der Plattform sind.`));
            later(S, 26, () => { const s = w.sites.find(x => x.id === S.postId); if (s && s.alive) radio(w, 'Operationszentrale', 'Flugkörperstarter auf dem Doggerriff im Nordwesten der Plattform. Er liegt weit genug von ihr entfernt: Freigabe für Geschütz und Flugkörper.', 'warn'); });
            later(S, 44, () => radio(w, 'Boardingteam', `${T.teams} Teams klar. Wir setzen über, sobald kein Boot mehr an der Plattform steht und wir im markierten Kreis höchstens Viertelfahrt laufen.`));
         },
         update(w, dt, S) {
            if ((S.tick -= dt) > 0) return;
            const step = 0.5; S.tick += step;
            if (S.done) return;
            const T = SPECIAL_A_TUNE.rig[w.difficultyKey] || SPECIAL_A_TUNE.rig.normal;
            let plat = null;
            for (const s of w.sites) if (s.id === S.platId) { plat = s; break; }
            if (!plat) return;
            if (plat.hp < plat.maxHp) { S.done = true; setObj(w, 'board', 'failed'); w.end(false, 'Die Plattform wurde getroffen – schwere Waffen auf Dogger Alpha waren verboten.'); return; }
            // nearest warship of the group to the platform, and the one a team can go over from
            let near = null, nd = Infinity, from = null, fast = false;
            for (const s of w.ships) {
               if (!s.alive || s.side !== 'player' || s.type === 'TR' || s.depth > 0) continue;
               const d = hyp(s.pos, plat.pos);
               if (d < nd) { nd = d; near = s; }
               if (d > RIG.launch) continue;
               if (Math.abs(s.speed) > s.maxSpeed * RIG.slow) fast = true;
               else if (!from || s.isPlayer) from = s;
            }
            // boats: leave the mooring when a warship closes; count those still near the platform
            let moored = 0, close = 0, went = 0;
            for (let i = 0; i < S.boats.length; i++) {
               const b = w.shipById(S.boats[i]);
               if (!b || !b.alive) continue;
               if (b.ai && b.ai.anchored) {
                  if (near && nd < (i < T.guards ? RIG.guard : RIG.sortie)) { delete b.ai.anchored; b.ai.huntId = near.id; b.ai.press = true; b.setTelegraph(4); went++; }
                  else moored++;
               }
               if (hyp(b.pos, plat.pos) < RIG.clear) close++;
            }
            if (went) {
               S.out += went;
               radio(w, 'Ausguck', moored ? `${went === 1 ? 'Ein Boot löst' : went + ' Boote lösen'} sich von der Plattform und ${went === 1 ? 'läuft' : 'laufen'} auf uns zu, ${moored === 1 ? 'eines bleibt' : moored + ' bleiben'} als Wache liegen. Feuer erst, wenn sie frei von der Anlage sind!`
                  : `${went === 1 ? 'Das letzte Boot läuft' : 'Die letzten ' + went + ' Boote laufen'} aus. Feuer erst, wenn ${went === 1 ? 'es' : 'sie'} frei von der Anlage ${went === 1 ? 'ist' : 'sind'}!`, 'warn');
            }
            // the clock of the occupiers
            S.valves = Math.max(0, S.valves - step);
            w.score.player = Math.round(S.valves / S.total * 100);
            if (S.valves <= S.total / 2 && S.said < 1) { S.said = 1; radio(w, 'Lagezentrum', `Die Hälfte der Frist ist um. Die Besetzer öffnen die Ventile in ${clock(S.valves)}.`, 'warn'); }
            if (S.valves <= 60 && S.said < 2) { S.said = 2; radio(w, 'Lagezentrum', 'Noch eine Minute, dann öffnen sie die Ventile! Das Team muss jetzt auf die Plattform.', 'warn'); }
            if (S.valves <= 0) { S.done = true; setObj(w, 'board', 'failed'); w.end(false, 'Die Besetzer haben die Ventile geöffnet – das Boardingteam kam nicht rechtzeitig auf die Plattform.'); return; }
            // the team
            let team = null;
            if (S.teamId != null) for (const t of w.teams) if (t.id === S.teamId) { team = t; break; }
            if (team && team.state === 'working') { objText(w, 'board', `Boardingteam ist auf der Plattform und sichert die Leitstände (${Math.max(0, Math.ceil(team.workT))} s) – Ventile in ${clock(S.valves)}`); return; }
            if (team && team.state === 'out') { objText(w, 'board', `Boardingteam setzt über – halten Sie die Boote von ihm fern (Ventile in ${clock(S.valves)})`); return; }
            S.relT = Math.max(0, S.relT - step);
            const why = !from ? (fast ? 2 : 1) : close ? 3 : S.relT > 0 ? 4 : 0;      // 1 = too far, 2 = too fast, 3 = boats at the platform, 4 = next team gets ready
            if (why === 0) {
               const t = { id: w._nextId++, side: 'player', ownerId: from.id, taskId: S.taskId, x: from.pos.x, y: from.pos.y, pos: { x: from.pos.x, y: from.pos.y },
                  heading: Math.atan2(plat.y - from.pos.y, plat.x - from.pos.x), speed: RIG.teamSpeed, n: 8, state: 'out', t: 0, workT: 0, workTime: T.board, seenT: 0, reason: null };
               const task = w.taskPoints.find(x => x.id === S.taskId);
               w.teams.push(t); S.teamId = t.id; S.teamsLeft--;
               if (task) { task.state = 'busy'; task.teamId = t.id; }
               w.pushEvent('teamOut', { srcId: from.id, teamId: t.id, taskId: S.taskId, pos: { x: t.x, y: t.y }, text: 'Boardingteam setzt über: Dogger Alpha' });
               radio(w, 'Boardingteam', `Wir setzen von ${from.name} über. Halten Sie uns die Boote vom Leib – ${T.board} Sekunden brauchen wir an Bord.`);
               return;
            }
            if (nd < RIG.launch + 600 && why !== 4 && w.time - S.whyT > 18) {
               S.whyT = w.time;
               radio(w, 'Boardingteam', why === 3 ? (moored ? 'Es liegen noch Boote an der Plattform – so können wir nicht hinüber. Näher heran, dann laufen sie aus.' : 'Ein Boot steht noch an der Plattform – erst abdrängen oder bekämpfen, sobald es frei ist.')
                  : why === 2 ? 'Zu schnell zum Aussetzen! Höchstens Viertelfahrt.' : 'Noch zu weit weg – in den markierten Kreis, 1,5 km um die Plattform.', 'warn');
            }
            objText(w, 'board', `Bringen Sie ein Boardingteam auf die Plattform: im Kreis höchstens Viertelfahrt, kein Boot an der Anlage (${S.teamsLeft} ${S.teamsLeft === 1 ? 'Team' : 'Teams'}) – Ventile in ${clock(S.valves)}`);
         },
         secured(w, S) {
            S.done = true;
            setObj(w, 'board', 'done', 'Das Boardingteam hat die Plattform gesichert');
            if (!S.lost) setObj(w, 'team', 'done');
            radio(w, 'Boardingteam', 'Leitstand gesichert, Ventile verriegelt, die Besatzung ist frei.');
            w.end(true, 'Dogger Alpha ist gesichert – die Besatzung ist frei, die Anlage unbeschädigt.');
         },
         teamLost(w, S) {
            S.teamId = null; S.lost++; S.relT = RIG.relaunch;
            setObj(w, 'team', 'failed');
            if (S.done || w.phase !== 'playing') return;
            if (S.teamsLeft <= 0) { S.done = true; setObj(w, 'board', 'failed'); w.end(false, 'Das letzte Boardingteam musste abdrehen – niemand kann die Plattform mehr sichern.'); return; }
            radio(w, 'Boardingteam', `Ein Boot hat uns abgedrängt, wir mussten abdrehen. ${S.teamsLeft === 1 ? 'Ein Team ist' : S.teamsLeft + ' Teams sind'} noch klar – erst die Boote, dann wir.`, 'warn');
         },
         onSiteDestroyed(w, site, by, S) {
            if (site.id === S.postId) { setObj(w, 'post', 'done'); radio(w, 'Operationszentrale', 'Der Flugkörperstarter auf dem Riff ist ausgeschaltet.'); }
         },
         onSink(w, ship, killer, S) {
            if (S.boats.includes(ship.id)) {
               let n = 0;
               for (let i = 0; i < S.boats.length; i++) { const b = w.shipById(S.boats[i]); if (!b || !b.alive) n++; }
               objText(w, 'boats', `Schalten Sie alle Boote der Besetzer aus (${n}/${S.boats.length})`);
               if (n >= S.boats.length) { setObj(w, 'boats', 'done'); radio(w, 'Operationszentrale', 'Alle Boote sind ausgeschaltet. Der Weg zur Plattform ist frei.'); }
               return;
            }
            if (ship.side !== 'player' || S.done) return;
            if (!combatants(w, 'player').length) w.end(false, 'Ihr Verband ist ausgefallen – niemand kann die Plattform mehr sichern.');
            else radio(w, 'Operationszentrale', ship.name + ' ist ausgefallen. Die Besatzung wird geborgen.', 'warn');
         },
         timeout(w) { w.end(false, 'Die Zeit ist abgelaufen – die Besetzer haben die Ventile geöffnet.'); },
      },
   ];
}
