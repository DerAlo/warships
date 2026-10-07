// gamev2/missions_special_a.js — special operations, set A. Definitions are built with the helpers of
// missions.js (passed in, no import cycle). Fictional present-day scenarios: no real persons, merchant
// ships are only ever protected, never targets. Radio traffic is German (UI), code and comments English.
//
// Conventions as in missions_west.js / missions_east.js: S (= world._script) carries the mission state,
// ships are kept by id (net/CONTRACT.md), S.tick paces the bookkeeping, by(w, easy, normal, hard) picks
// a value for the difficulty. The mission ticks allocate nothing per frame.

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
};
// cable: how close a ship / a helicopter has to be to make out a merchant's anchor gear at night (m),
// boarding distance (m) and the share of its top speed a boarding ship may run at most
export const CABLE = { visShip: 1800, visHelo: 1300, boardDist: 500, boardSpeed: 0.5, cover: 900, damaged: 0.7 };

export function specialMissionsA(H) {
   const { P, add, objective, setObj, objText, later, radio, islands, combatants } = H;
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
   ];
}
