// game3d/missions_pacific.js — third batch, Pacific: historical operations built by
// pacificMissions(H) from the helpers of missions.js (same contract as missions_extra.js).
// Mission text is German (UI), code English. Only ships of the existing roster are used; where a
// historical class is missing the closest one stands in (see the comment above each operation).
export function pacificMissions(H) {
   const { P, add, objective, setObj, objText, later, radio, zone, inZone, islands } = H;
   const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
   const d2 = (a, b) => (a.pos.x - b.pos.x) ** 2 + (a.pos.y - b.pos.y) ** 2;
   const nearest = (from, list) => {
      let best = null, bd = Infinity;
      for (const s of list) { if (!s.alive) continue; const d = d2(s, from); if (d < bd) { bd = d; best = s; } }
      return best;
   };
   const atEdge = (w, s, m = 900) => Math.abs(s.pos.x) > w.arena - m || Math.abs(s.pos.y) > w.arena - m;
   const NORTH = -Math.PI / 2;

   return [
      // ------------------------------------------------------------ op: Samar, Taffy 3
      // The escort carriers are Enterprise hulls with a fraction of the hit points and 17 kn (no
      // escort carrier class; their aircraft are not simulated). Kongo is the Kirishima class (her
      // sister), the heavy cruisers are Takao hulls, Samuel B. Roberts (a destroyer escort) a Benham.
      // The player cannot win by sinking the Centre Force: the mission is won when Kurita breaks off
      // (time limit) with at most two carriers lost. Heavy cruisers break off once badly hit, and
      // the Yamato turns away north from a torpedo spread, as she did on the day.
      {
         id: 'samar', group: 'ops', name: 'Die letzte Fahrt der Johnston', subtitle: 'Vor Samar · Taffy 3 · 25. Oktober 1944',
         fleet: { own: 'USS Johnston · Zerstörer Hoel, Heermann · Geleitzerstörer Samuel B. Roberts · fünf Geleitträger', foe: 'Schlachtschiffe Yamato, Kongō · Schwere Kreuzer Chōkai, Haguro, Tone, Chikuma · Zerstörer' },
         briefing: 'Im Morgengrauen tauchen am Horizont Pagodenmasten auf: Kuritas Zentralverband mit der Yamato steht unbemerkt vor den Geleitträgern von Taffy 3. ' +
            'Die langsamen, ungepanzerten Träger laufen nach Südosten ab – zwischen ihnen und den schwersten Geschützen der Welt stehen nur drei Zerstörer und ein Geleitzerstörer. ' +
            'Sie führen die USS Johnston. Versenken können Sie diesen Gegner nicht: Gewinnen Sie Zeit. Legen Sie Nebel zwischen Träger und Feind, greifen Sie die schweren Kreuzer mit Torpedos an und ziehen Sie ihr Feuer auf sich. ' +
            'Schwer getroffene Kreuzer drehen ab, und vor einem Torpedofächer weicht selbst die Yamato nach Norden aus. ' +
            'Halten Sie durch, bis Kurita die Verfolgung abbricht – gehen drei Träger verloren, ist Taffy 3 vernichtet.',
         debrief: 'Commander Ernest Evans drehte die Johnston ohne Befehl auf den Feind zu, legte Nebel und traf den Kreuzer Kumano mit einem Torpedo. ' +
            'Hoel, Heermann und die kleine Samuel B. Roberts folgten; die Yamato wich einem Torpedofächer nach Norden aus und fiel aus dem Gefecht. ' +
            'Nach zweieinhalb Stunden brach Kurita ab – er glaubte, Halseys Flottenträger vor sich zu haben. Gambier Bay, Johnston, Hoel und Samuel B. Roberts sanken, Evans erhielt postum die Medal of Honor. ' +
            'Die Landungsflotte im Golf von Leyte blieb unversehrt.',
         env: { time: 'dawn', weather: 'overcast', front: { at: 190, dur: 80, to: 'rain', text: 'Eine Regenbö zieht über Taffy 3 – die Träger laufen hinein' } },
         type: 'escort', playableShips: ['Fletcher'], recommendedShip: 'Fletcher',
         arena: 16000, timeLimit: 9 * 60, stars: 3,
         setup(w, shipKey) {
            islands(w, []);
            const S = w._script, key = w.difficulty.key;
            S.maxLoss = 3;
            S.jd = w.difficulty.botDmg * 0.34;          // Japanese gunnery: armour-piercing shells, poor spotting
            S.breakAt = key === 'easy' ? 0.8 : key === 'hard' ? 0.66 : 0.74;   // a cruiser this battered turns away
            S.aggro = 1.6;                               // they close to finish the carriers instead of sniping from the horizon
            const cveHP = key === 'easy' ? 0.44 : key === 'hard' ? 0.3 : 0.35;
            const anchor = P(-2000, -2500), route = [P(5500, 5000), P(2500, 10500), P(-5000, 14500)];
            S.cves = [['USS Fanshaw Bay', 0, 0], ['USS White Plains', 1100, 700], ['USS St. Lo', -300, 1300], ['USS Kalinin Bay', -1100, -500], ['USS Gambier Bay', 500, -1200]]
               .map(([name, dx, dy]) => add(w, 'Enterprise', 'player', P(anchor.x + dx, anchor.y + dy), 0.78,
                  { name, telegraph: 4, speedKn: 17, hpMult: cveHP, ai: { route: route.map(p => P(p.x + dx, p.y + dy)), routeIdx: 0, passive: true, convoy: true } }));
            S.japs = []; S.cruisers = []; S.offT = new Map();
            S.out = 0; S.lost = 0;
            const hunt = (cls, pos, name, cve, opts = {}, ai = {}) => {
               const s = add(w, cls, 'enemy', pos, 1.2, { name, nation: 'jp', telegraph: 4, dmgMult: S.jd, ...opts, ai: { huntId: S.cves[cve].id, press: true, aggro: S.aggro, ...ai } });
               S.japs.push(s);
               return s;
            };
            const cruiser = (pos, name, cve, opts = {}) => {
               const s = hunt('Takao', pos, name, cve, opts, { retreatBelow: S.breakAt, retreatTo: P(-3000, -15300) });
               S.cruisers.push(s);
               return s;
            };
            cruiser(P(-5600, -12300), 'Chōkai', 4);
            cruiser(P(-3700, -12900), 'Haguro', 3);
            S.yam = hunt('Yamato', P(-7200, -14600), 'Yamato', 0, { speedKn: 23 }, { aggro: 1 });
            hunt('Kirishima', P(-2600, -14900), 'Kongō', 1, { speedKn: 25 });
            const me = add(w, shipKey, 'player', P(-3400, -5200), -1.9, { isPlayer: true, name: 'USS Johnston', telegraph: 4 });
            me.ai.huntId = S.cruisers[0].id; me.ai.press = true;   // only read by the autopilot (tests)
            S.screen = [
               add(w, 'Fletcher', 'player', P(-900, -5000), -1.7, { name: 'USS Hoel', telegraph: 4, dmgMult: 0.25, ai: { huntId: S.cruisers[1].id, press: true } }),
               add(w, 'Fletcher', 'player', P(1200, 1200), -1.6, { name: 'USS Heermann', telegraph: 4, dmgMult: 0.25, ai: { huntId: S.cruisers[1].id, press: true } }),
               add(w, 'Benham', 'player', P(-3600, -1700), -1.6, { name: 'USS Samuel B. Roberts', telegraph: 4, dmgMult: 0.25, ai: { escortId: S.cves[3].id } }),
            ];
            later(S, 4, () => radio(w, 'Konteradmiral Sprague', 'Pagodenmasten im Nordwesten – das ist die japanische Schlachtflotte! Träger: Kurs Südost, alles nebelt!', 'warn'));
            later(S, 26, () => radio(w, 'Konteradmiral Sprague', 'Kleine Jungs: Angriff! Haltet sie uns vom Leib, so lange ihr könnt.'));
            later(S, 150, () => {
               S.flankIn = true;
               radio(w, 'USS Heermann', 'Tone und Chikuma holen im Osten aus – sie wollen den Trägern den Weg abschneiden!', 'warn');
               const lead = nearest({ pos: P(9000, -6000) }, S.cves) || me;
               const a = P(lead.pos.x + 9500, lead.pos.y - 8500);
               cruiser(a, 'Tone', 1, { minDist: 9000 });
               cruiser(P(a.x + 1300, a.y - 900), 'Chikuma', 2, { minDist: 9000 });
            });
            later(S, 300, () => {
               const n = key === 'easy' ? 1 : key === 'hard' ? 3 : 2;
               radio(w, 'USS Samuel B. Roberts', 'Japanische Zerstörer laufen von Westen zum Torpedoangriff auf die Träger an!', 'warn');
               const lead = nearest({ pos: P(-12000, 6000) }, S.cves) || me;
               ['Yukikaze', 'Isokaze', 'Urakaze'].slice(0, n).forEach((name, i) =>
                  hunt('Fubuki', P(lead.pos.x - 9500, lead.pos.y - 3500 + i * 1500), name, i, { minDist: 8000 }));
            });
            later(S, 440, () => radio(w, 'Konteradmiral Sprague', 'Ihr Feuer wird unregelmäßig – sie verlieren den Zusammenhalt. Noch ein paar Minuten, Jungs!'));
            objective(w, 'cves', 'Höchstens 2 Geleitträger verlieren (0 verloren)');
            objective(w, 'hold', 'Halten Sie durch, bis Kurita abdreht (9:00)');
            objective(w, 'out', 'Schalten Sie 2 schwere Kreuzer aus – versenkt oder vertrieben (0/2)', { optional: true });
            objective(w, 'one', 'Höchstens ein Geleitträger geht verloren', { optional: true });
            w.score = { kind: 'convoy', player: 0, enemy: 0, target: S.maxLoss };
         },
         _won(w, S, reason) {
            setObj(w, 'cves', 'done'); setObj(w, 'hold', 'done', 'Kurita bricht die Verfolgung ab');
            if (S.lost <= 1) setObj(w, 'one', 'done');
            w.end(true, reason);
         },
         // a heavy cruiser sunk or driven off
         _out(w, S) {
            S.out++;
            w.score.player = S.out;
            objText(w, 'out', `Schalten Sie 2 schwere Kreuzer aus – versenkt oder vertrieben (${Math.min(S.out, 2)}/2)`);
            if (S.out >= 2) setObj(w, 'out', 'done');
            if (S.flankIn && w.phase === 'playing' && S.cruisers.every(c => !c.alive))
               this._won(w, S, 'Alle schweren Kreuzer sind ausgeschaltet – Kurita ruft seine Schiffe zurück. Taffy 3 hat überlebt.');
         },
         update(w, dt, S) {
            if (w.phase !== 'playing') return;
            objText(w, 'hold', `Halten Sie durch, bis Kurita abdreht (${clock(w.timeLeft)})`);
            // battered cruisers turn away and leave the fight
            for (const c of S.cruisers) {
               if (!c.alive || !c.ai.retreating) continue;
               if (!S.offT.has(c)) { S.offT.set(c, w.time); radio(w, 'USS Hoel', `Die ${c.name} dreht brennend nach Norden ab!`); }
               if (w.time - S.offT.get(c) > 40 || atEdge(w, c)) { w.removeShip(c, 'retreated'); this._out(w, S); if (w.phase !== 'playing') return; }
            }
            // the Yamato combs a torpedo spread by running north, out of the fight for a while
            const y = S.yam;
            if (y.alive) {
               if (S.yamT == null && w.time > (S.yamNext || 0) && w.torpedoes.some(t => t.alive !== false && t.side === 'player' && t.ownerId === (w.player && w.player.id) && (t.pos.x - y.pos.x) ** 2 + (t.pos.y - y.pos.y) ** 2 < 4200 * 4200)) {
                  S.yamT = w.time;
                  y.ai.route = [P(y.pos.x - 1500, -w.arena + 900)]; y.ai.routeIdx = 0;
                  radio(w, 'USS Hoel', 'Die Yamato dreht vor den Torpedos nach Norden ab – sie läuft aus dem Gefecht!');
               } else if (S.yamT != null && w.time - S.yamT > 80) {
                  S.yamT = null; S.yamNext = w.time + 100;
                  y.ai.route = null;
               }
            }
            S.tick = (S.tick || 0) + dt;
            if (S.tick < 1) return;
            S.tick = 0;
            // hunters whose carrier is gone pick the nearest one left
            for (const j of S.japs) {
               if (!j.alive) continue;
               const h = j.ai.huntId != null ? w.shipById(j.ai.huntId) : null;
               if (!h || !h.alive) { const n = nearest(j, S.cves); j.ai.huntId = n ? n.id : null; }
            }
            // autopilot (tests): go for the nearest cruiser still in the fight
            const p = w.player;
            if (p && p.alive) {
               const t = nearest(p, S.cruisers.filter(c => !c.ai.retreating)) || nearest(p, S.japs.filter(j => j.type === 'DD'));
               if (t) p.ai.huntId = t.id;
            }
         },
         onSink(w, ship, killer, S) {
            if (S.cves.includes(ship)) {
               S.lost++;
               w.score.enemy = S.lost;
               objText(w, 'cves', `Höchstens 2 Geleitträger verlieren (${S.lost} verloren)`);
               if (S.lost >= 2) setObj(w, 'one', 'failed');
               if (S.lost >= S.maxLoss) { setObj(w, 'cves', 'failed'); w.end(false, 'Drei Geleitträger sind verloren – Taffy 3 ist vernichtet.'); return; }
               radio(w, 'Konteradmiral Sprague', `${ship.name} sinkt! Wir können uns keinen weiteren Verlust leisten.`, 'warn');
            } else if (S.cruisers.includes(ship)) this._out(w, S);
            else if (S.screen.includes(ship) && !S.screenMsg) { S.screenMsg = true; radio(w, ship.name, 'Wir sinken – macht weiter, Johnston!', 'warn'); }
         },
         timeout(w, S) { this._won(w, S, 'Kurita bricht die Verfolgung ab – Taffy 3 hat gegen jede Wahrscheinlichkeit überlebt.'); },
      },

      // ------------------------------------------------------------ op: Surigao Strait
      // The old American battleships (West Virginia, Tennessee) are the Washington class, the closest
      // radar-directed 16-inch ship; Yamashiro and Fuso are Kirishima hulls with more hit points,
      // Mogami, Nachi and Ashigara are Takao hulls. The player takes either the lead destroyer of
      // the torpedo attack or the flagship of the battle line; the other slot is a bot.
      {
         id: 'surigao', group: 'ops', name: 'Crossing the T', subtitle: 'Surigao-Straße · Nacht zum 25. Oktober 1944',
         fleet: { own: 'Schlachtschiffe West Virginia, Tennessee · Kreuzer Denver, Columbia · Zerstörer McDermut, Monssen, Remey, Melvin', foe: 'Schlachtschiffe Yamashiro, Fusō · Kreuzer Mogami · Zerstörer · später Shimas Kreuzer Nachi und Ashigara' },
         briefing: 'Nishimuras Südverband läuft bei Nacht in Kiellinie durch die Surigao-Straße nach Norden, um die Landungsflotte im Golf von Leyte anzugreifen. ' +
            'Admiral Oldendorf hat die Straße abgeriegelt: Zerstörer greifen von beiden Ufern mit Torpedos an, am Nordausgang liegt die Schlachtlinie quer vor dem Bug des Gegners. ' +
            'Wählen Sie Ihr Schiff: Mit dem Zerstörer McDermut führen Sie den Torpedoangriff aus dem Dunkel der Küste, mit dem Schlachtschiff West Virginia die Linie, die das T kreuzt. ' +
            'Versenken Sie Yamashiro und Fusō, bevor sie den Golf erreichen. Hinter Nishimura folgt ein zweiter Verband unter Admiral Shima – auch er darf nicht durchbrechen.',
         debrief: 'Die Zerstörer der 54. Flottille trafen aus der Dunkelheit: McDermut allein erzielte Treffer auf drei Zerstörern, die Fusō brach nach Torpedotreffern zusammen. ' +
            'Um 03.53 Uhr eröffnete West Virginia auf über 20 Kilometer radargeleitet das Feuer; die Yamashiro lief brennend weiter in die Linie hinein und kenterte mit Admiral Nishimura. ' +
            'Shima kam, sah die brennenden Wracks, schoss Torpedos auf zwei Inseln und kehrte um. Es war das letzte Gefecht der Geschichte zwischen Schlachtschiffen – und das letzte gekreuzte T.',
         env: { time: 'night', weather: 'clear' }, type: 'fleet', playableShips: ['Fletcher', 'Washington'], recommendedShip: 'Fletcher',
         arena: 14000, timeLimit: 11 * 60, stars: 2,
         setup(w, shipKey) {
            islands(w, [
               { c: P(-13800, 1000), r: 2600, height: 520, seed: 2101, lobes: 9, elong: 3, rot: Math.PI / 2 + 0.04, rough: 0.7, name: 'Leyte' },
               { c: P(13800, 2500), r: 2600, height: 480, seed: 2103, lobes: 9, elong: 2.8, rot: Math.PI / 2 - 0.05, rough: 0.7, name: 'Dinagat' },
               { c: P(7800, -9600), r: 750, height: 160, seed: 2107, lobes: 5, rough: 0.6, name: 'Hibuson' },
               { c: P(-8200, 12600), r: 900, height: 240, seed: 2111, lobes: 5, elong: 1.5, rot: 0.4, name: 'Panaon' },
            ]);
            const S = w._script, key = w.difficulty.key;
            const bb = shipKey === 'Washington';
            S.bbPlayer = bb;
            S.gulf = zone(w, 0, -11600, 1700, 'Golf von Leyte', 'danger');
            S.jd = w.difficulty.botDmg * (bb ? 0.42 : 0.34);   // the destroyer captain is the one under their guns
            S.ad = bb ? 0.3 : 0.22;                        // allied bots: the player's ship decides the night
            S.shimaBreak = key === 'easy' ? 0.75 : key === 'hard' ? 0.55 : 0.65;
            const bbHP = w.difficulty.botHP * 1.1;
            const lane = (x) => [P(x, 1500), P(x, -6000), P(S.gulf.x, S.gulf.y)];
            S.bbs = [['Yamashiro', P(0, 9300)], ['Fusō', P(150, 10600)]].map(([name, pos]) =>
               add(w, 'Kirishima', 'enemy', pos, NORTH, { name, nation: 'jp', telegraph: 4, speedKn: 17, hpMult: bbHP, dmgMult: S.jd, ai: { route: lane(pos.x) } }));
            S.mogami = add(w, 'Takao', 'enemy', P(-100, 11900), NORTH, { name: 'Mogami', nation: 'jp', telegraph: 4, speedKn: 22, dmgMult: S.jd, ai: { escortId: S.bbs[0].id } });
            S.jdds = [['Michishio', P(-800, 8100)], ['Asagumo', P(800, 8200)], ['Shigure', P(900, 12300)]].slice(0, key === 'easy' ? 2 : 3)
               .map(([name, pos]) => add(w, 'Fubuki', 'enemy', pos, NORTH, { name, nation: 'jp', telegraph: 4, dmgMult: S.jd * 0.8, ai: { escortId: S.bbs[0].id } }));
            S.shima = [];
            // the American side: [class, name, position, heading, ai]; the first slot of the chosen class is the player
            const across = (y) => [P(3800, y), P(-3800, y)];
            const slots = [
               ['Fletcher', 'USS McDermut', P(-5600, 2600), 0.9, { huntId: S.bbs[0].id, press: true }],
               ['Washington', 'USS West Virginia', P(-1200, -6400), 0, { patrol: across(-6400) }],
               ['Washington', 'USS Tennessee', P(-2700, -6500), 0, { patrol: across(-6500) }],
               ['Cleveland', 'USS Denver', P(2600, -4500), Math.PI, { patrol: across(-4500).reverse() }],
               ['Cleveland', 'USS Columbia', P(4000, -4600), Math.PI, { patrol: across(-4600).reverse() }],
               ['Fletcher', 'USS Monssen', P(-6300, 1600), 0.9, { huntId: S.bbs[1].id, press: true }],
               ['Fletcher', 'USS Remey', P(5600, 2400), 2.3, { huntId: S.bbs[0].id, press: true }],
               ['Fletcher', 'USS Melvin', P(6300, 1400), 2.3, { huntId: S.bbs[1].id, press: true }],
            ];
            S.line = [];
            let me = null;
            for (const [cls, name, pos, hdg, ai] of slots) {
               if (!me && cls === shipKey) {
                  me = add(w, shipKey, 'player', pos, hdg, { isPlayer: true, name, telegraph: bb ? 2 : 3 });
                  me.ai.huntId = S.bbs[0].id; me.ai.aggro = bb ? 1 : 1.3;   // only read by the autopilot (tests)
                  continue;
               }
               const s = add(w, cls, 'player', pos, hdg, { name, telegraph: ai.patrol ? 2 : 3, dmgMult: S.ad, ai });
               if (ai.patrol) S.line.push(s);
            }
            if (bb) {
               later(S, 4, () => radio(w, 'Admiral Oldendorf', 'Schlachtlinie: Die Zerstörer greifen jetzt an. Feuer frei, sobald das Radar die Spitze fasst.'));
               later(S, 45, () => radio(w, 'USS McDermut', 'Torpedos im Wasser! Zwei Schlachtschiffe in Kiellinie, Kurs Nord, zwanzig Knoten.'));
            } else {
               later(S, 4, () => radio(w, 'Captain Coward (Remey)', 'Flottille 54: Angriff von beiden Ufern. Kein Geschützfeuer vor dem Abschuss – nur die Fische!'));
               later(S, 70, () => radio(w, 'Admiral Oldendorf', 'Zerstörer: nach dem Abschuss an die Ufer absetzen. Die Schlachtlinie eröffnet das Feuer.'));
            }
            objective(w, 'bbs', 'Versenken Sie Yamashiro und Fusō (0/2)');
            objective(w, 'gulf', 'Kein schweres Schiff erreicht den Golf von Leyte');
            objective(w, 'mogami', 'Versenken Sie den Kreuzer Mogami', { optional: true });
            objective(w, 'line', 'Kein Schiff der Schlachtlinie geht verloren', { optional: true });
            w.score = { kind: 'kills', player: 0, enemy: 0, target: 2 };
            S.sunk = 0; S.shimaOut = 0;
         },
         // Shima's Second Striking Force follows up the strait; badly hit, a cruiser reverses course
         _shima(w, S) {
            if (S.shimaIn) return;
            S.shimaIn = true;
            const key = w.difficulty.key;
            radio(w, 'PT 137', 'Zweiter Verband in der Südeinfahrt: zwei schwere Kreuzer und Zerstörer, hohe Fahrt, Kurs Nord!', 'warn');
            objective(w, 'shima', 'Vertreiben oder versenken Sie Shimas Kreuzer Nachi und Ashigara (0/2)');
            const route = (x) => [P(x, 2000), P(x, -6000), P(S.gulf.x, S.gulf.y)];
            S.shima = [['Nachi', P(-500, 12700)], ['Ashigara', P(600, 13100)]].map(([name, pos]) =>
               add(w, 'Takao', 'enemy', pos, NORTH, { name, nation: 'jp', telegraph: 4, speedKn: 24, minDist: 7000, dmgMult: S.jd, ai: { route: route(pos.x) } }));
            const n = key === 'easy' ? 0 : key === 'hard' ? 2 : 1;
            ['Shiranui', 'Kasumi'].slice(0, n).forEach((name, i) =>
               add(w, 'Fubuki', 'enemy', P(-1500 + i * 3000, 12400), NORTH, { name, nation: 'jp', telegraph: 4, minDist: 7000, dmgMult: S.jd * 0.8, ai: { escortId: S.shima[0].id } }));
            S.turned = new Map();
         },
         _check(w, S) {
            if (w.phase !== 'playing' || S.sunk < 2 || !S.shimaIn || S.shima.some(c => c.alive)) return;
            setObj(w, 'bbs', 'done'); setObj(w, 'shima', 'done'); setObj(w, 'gulf', 'done');
            if (S.line.every(s => s.alive)) setObj(w, 'line', 'done');
            w.end(true, 'Die Surigao-Straße ist gesperrt – kein japanisches Schiff hat den Golf von Leyte erreicht.');
         },
         _shimaOut(w, S) {
            S.shimaOut++;
            objText(w, 'shima', `Vertreiben oder versenken Sie Shimas Kreuzer Nachi und Ashigara (${S.shimaOut}/2)`);
            this._check(w, S);
         },
         update(w, dt, S) {
            if (w.phase !== 'playing') return;
            if (!S.shimaIn && (w.time > 215 || (S.sunk >= 1 && w.time > S.firstT + 20))) this._shima(w, S);
            for (const s of [...S.bbs, ...S.shima]) {
               if (!s.alive || !inZone(s, S.gulf)) continue;
               setObj(w, 'gulf', 'failed');
               w.end(false, `Die ${s.name} ist in den Golf von Leyte durchgebrochen – die Landungsflotte liegt schutzlos vor ihren Geschützen.`);
               return;
            }
            for (const c of S.shima) {
               if (!c.alive) continue;
               if (!S.turned.has(c)) {
                  // with Nishimura's ships burning wrecks ahead, Shima needs far less persuasion
                  if (c.hp >= c.maxHP * (S.sunk >= 2 ? S.shimaBreak + 0.25 : S.shimaBreak)) continue;
                  S.turned.set(c, w.time);
                  c.ai.route = [P(c.pos.x, w.arena - 700)]; c.ai.routeIdx = 0;
                  radio(w, 'USS Denver', `Die ${c.name} dreht um – sie läuft nach Süden ab!`);
               } else if (w.time - S.turned.get(c) > 35 || atEdge(w, c)) {
                  w.removeShip(c, 'retreated');
                  this._shimaOut(w, S);
                  if (w.phase !== 'playing') return;
               }
            }
            // autopilot (tests): the battleships first, then whatever of Shima's force is nearest
            S.tick = (S.tick || 0) + dt;
            if (S.tick < 1) return;
            S.tick = 0;
            const p = w.player;
            if (p && p.alive) {
               const t = nearest(p, S.bbs) || nearest(p, S.shima.filter(c => !S.turned.has(c))) || nearest(p, S.shima);
               if (t) p.ai.huntId = t.id;
            }
         },
         onSink(w, ship, killer, S) {
            if (S.bbs.includes(ship)) {
               S.sunk++;
               w.score.player = S.sunk;
               if (S.sunk === 1) {
                  S.firstT = w.time;
                  radio(w, 'USS Tennessee', `Die ${ship.name} bricht auseinander! Das zweite Schlachtschiff hält weiter auf uns zu.`);
               } else radio(w, 'Admiral Oldendorf', `Die ${ship.name} kentert. Nishimuras Verband ist vernichtet.`);
               setObj(w, 'bbs', S.sunk >= 2 ? 'done' : 'active', `Versenken Sie Yamashiro und Fusō (${S.sunk}/2)`);
               objText(w, 'bbs', `Versenken Sie Yamashiro und Fusō (${S.sunk}/2)`);
               this._check(w, S);
            } else if (ship === S.mogami) setObj(w, 'mogami', 'done');
            else if (S.shima.includes(ship)) this._shimaOut(w, S);
            else if (S.line.includes(ship)) setObj(w, 'line', 'failed');
         },
         timeout(w, S) {
            if (S.sunk < 2) setObj(w, 'bbs', 'failed');
            w.end(false, 'Der Morgen graut und die japanischen Verbände stehen noch in der Straße – die Sperre hat nicht gehalten.');
         },
      },

      // ------------------------------------------------------------ op: Savo Island, the Japanese side
      // Mikawa's raid plays better than the Allied night of confusion: strike, then get out before
      // dawn. Chokai is a Takao (her class), the older Aoba and Furutaka cruisers are Takao hulls too;
      // Canberra is the Norfolk (County) class, the American heavy cruisers are Cleveland hulls (no
      // American heavy cruiser in the roster), their destroyers the Benham class.
      {
         id: 'savo', group: 'ops', name: 'Nacht vor Savo', subtitle: 'Guadalcanal · Savo-Insel · Nacht zum 9. August 1942',
         fleet: { own: 'Schwerer Kreuzer Chōkai · Kreuzer Aoba, Kako, Kinugasa · Zerstörer Yūnagi', foe: 'Südgruppe: Canberra, Chicago · Nordgruppe: Vincennes, Quincy, Astoria · Zerstörer' },
         briefing: 'Zwei Tage nach der amerikanischen Landung auf Guadalcanal führt Vizeadmiral Mikawa seine Kreuzer bei Nacht durch den „Slot“ heran. ' +
            'Die alliierten Deckungsgruppen liegen ahnungslos beiderseits der Savo-Insel: im Süden Canberra und Chicago, im Nordosten Vincennes, Quincy und Astoria. ' +
            'Sie führen das Flaggschiff Chōkai. Überfallen Sie zuerst die Südgruppe – die Besatzungen brauchen nach dem ersten Schuss einige Augenblicke, bis sie gefechtsbereit sind – ' +
            'und runden Sie dann Savo nach Norden. Versenken Sie drei der fünf Kreuzer und setzen Sie sich durch den Slot nach Nordwesten ab: ' +
            'Bei Tagesanbruch stehen Fletchers Trägerflugzeuge über dem Sund.',
         debrief: 'In 32 Minuten versenkten Mikawas Kreuzer Canberra, Vincennes, Quincy und Astoria; die Chicago verlor den Bug durch einen Torpedo. Über tausend alliierte Seeleute fielen. ' +
            'Die Chōkai erhielt nur wenige Treffer. Aus Sorge vor den amerikanischen Trägern lief Mikawa ab, ohne die schutzlosen Transporter vor Guadalcanal anzugreifen – ' +
            'die Landung überstand so die schwerste Niederlage der US Navy auf See. Auf dem Rückmarsch wurde die Kako von einem U-Boot versenkt.',
         env: { time: 'night', weather: 'overcast' }, type: 'historic', playableShips: ['Takao'], recommendedShip: 'Takao',
         arena: 14000, timeLimit: 13 * 60, stars: 2,
         setup(w, shipKey) {
            islands(w, [
               { c: P(-2600, -1400), r: 1500, height: 480, seed: 2201, lobes: 6, rough: 0.6, name: 'Savo' },
               { c: P(-1000, 13600), r: 2500, height: 620, seed: 2203, lobes: 9, elong: 3.6, rot: 0.04, rough: 0.7, name: 'Guadalcanal' },
               { c: P(12300, -11800), r: 2800, height: 420, seed: 2207, lobes: 8, elong: 1.8, rot: -0.6, rough: 0.7, name: 'Florida' },
            ]);
            const S = w._script, key = w.difficulty.key;
            S.need = 3;
            S.wakeR = key === 'easy' ? 3200 : key === 'hard' ? 5000 : 4200;       // a Japanese ship this close is sighted
            S.surprise = key === 'easy' ? 34 : key === 'hard' ? 20 : 30;          // seconds until the cruisers answer
            S.northDelay = key === 'easy' ? 95 : key === 'hard' ? 55 : 75;        // the northern group reads the gun flashes late
            S.exit = zone(w, -11600, -8600, 1600, 'Der Slot', 'goal');
            const ed = w.difficulty.botDmg * 0.32, eh = w.difficulty.botHP * 0.85;
            const sleeper = (cls, name, pos, to, nation = 'us') => add(w, cls, 'enemy', pos, Math.atan2(to.y - pos.y, to.x - pos.x),
               { name, nation, telegraph: 2, speedKn: 12, dmgMult: ed, hpMult: cls === 'Benham' ? w.difficulty.botHP : eh, ai: { passive: true, patrol: [to, pos] } });
            S.south = {
               ca: [sleeper('Norfolk', 'HMAS Canberra', P(1300, 4300), P(4300, 6300), 'uk'), sleeper('Cleveland', 'USS Chicago', P(600, 3800), P(3600, 5800))],
               dd: [sleeper('Benham', 'USS Patterson', P(2200, 3500), P(5200, 5500)), sleeper('Benham', 'USS Bagley', P(400, 5300), P(3400, 7300))],
            };
            S.north = {
               ca: [sleeper('Cleveland', 'USS Vincennes', P(4600, -5600), P(6800, -3400)), sleeper('Cleveland', 'USS Quincy', P(3900, -6300), P(6100, -4100)), sleeper('Cleveland', 'USS Astoria', P(3200, -7000), P(5400, -4800))],
               dd: [sleeper('Benham', 'USS Helm', P(5600, -6400), P(7800, -4200))],
            };
            S.pickets = [sleeper('Benham', 'USS Blue', P(-9800, 8800), P(-12200, 8200)), sleeper('Benham', 'USS Ralph Talbot', P(-7800, -9600), P(-4800, -8600))];
            S.targets = [...S.south.ca, ...S.north.ca];
            const me = add(w, shipKey, 'player', P(-8600, 2900), 0.12, { isPlayer: true, name: 'Chōkai', telegraph: 4 });
            me.ai.huntId = S.south.ca[0].id; me.ai.press = true; me.ai.aggro = 2.2;   // only read by the autopilot (tests)
            const ad = key === 'easy' ? 0.8 : 0.65;
            S.own = [['Aoba', P(-9600, 2800)], ['Kako', P(-10600, 2700)], ['Kinugasa', P(-11600, 2600)]]
               .map(([name, pos]) => add(w, 'Takao', 'player', pos, 0.12, { name, nation: 'jp', telegraph: 4, dmgMult: ad, ai: { escortIdPlayer: true } }));
            S.yunagi = add(w, 'Fubuki', 'player', P(-12500, 3300), 0.12, { name: 'Yūnagi', nation: 'jp', telegraph: 4, dmgMult: ad, ai: { escortIdPlayer: true } });
            later(S, 4, () => radio(w, 'Vizeadmiral Mikawa', 'An alle: Angriff in Kiellinie. Jedes Schiff feuert selbständig – Torpedos zuerst!'));
            later(S, 30, () => radio(w, 'Ausguck', 'Kreuzer voraus an Steuerbord, kleine Fahrt – sie haben uns nicht bemerkt.'));
            objective(w, 'kills', `Versenken Sie ${S.need} alliierte Kreuzer (0/${S.need})`);
            objective(w, 'four', 'Versenken Sie vier Kreuzer (0/4)', { optional: true });
            objective(w, 'home', 'Kein eigener Kreuzer geht verloren', { optional: true });
            w.score = { kind: 'raid', player: 0, enemy: 0, target: S.need };
            S.kills = 0;
         },
         // destroyers react at once, the cruisers only after S.surprise seconds
         _wake(w, S, g, from, text) {
            if (g.awake) return;
            g.awake = true;
            if (text) radio(w, from, text, 'warn');
            const p = w.player;
            const go = (s) => { if (!s.alive) return; s.ai.passive = false; s.ai.patrol = null; s.maxSpeedKn = s.cfg.speedKn; s.setTelegraph(4); };
            g.dd.forEach(go);
            later(S, w.time + S.surprise, () => g.ca.forEach(go));
            if (g === S.south) later(S, w.time + S.northDelay, () => this._wake(w, S, S.north, 'USS Vincennes', 'Leuchtgranaten im Süden – das sind keine eigenen Schiffe! Alle Mann auf Gefechtsstation!'));
         },
         _pickets(w, S) {
            if (S.picketsUp) return;
            S.picketsUp = true;
            const p = w.player;
            for (const s of S.pickets) if (s.alive) { s.ai.passive = false; s.ai.patrol = null; s.maxSpeedKn = s.cfg.speedKn; s.setTelegraph(4); if (p) { s.ai.huntId = p.id; s.ai.press = true; } }
         },
         _withdraw(w, S) {
            if (S.phase2) return;
            S.phase2 = true;
            const key = w.difficulty.key, p = w.player;
            setObj(w, 'kills', 'done');
            objective(w, 'exit', 'Rückmarsch: Erreichen Sie den Slot im Nordwesten');
            radio(w, 'Vizeadmiral Mikawa', 'Genug! An alle: Gefecht abbrechen, mit Höchstfahrt durch den Slot nach Nordwesten!');
            if (p && p.alive) { p.ai.huntId = null; p.ai.press = false; p.ai.route = [P(S.exit.x, S.exit.y)]; p.ai.routeIdx = 0; }
            this._pickets(w, S);
            later(S, w.time + 14, () => radio(w, 'Ausguck', 'Zerstörer voraus im Slot – die Vorposten verlegen uns den Rückweg!', 'warn'));
            if (key !== 'easy') later(S, w.time + 30, () => {
               if (w.phase !== 'playing' || !w.player) return;
               radio(w, 'Funkaufklärung', 'Die Ostgruppe läuft von Tulagi heran: ein Kreuzer und Zerstörer in unserem Kielwasser!', 'warn');
               add(w, 'Cleveland', 'enemy', P(12300, 1500), Math.PI, { name: 'USS San Juan', nation: 'us', telegraph: 4, minDist: 9000, dmgMult: w.difficulty.botDmg * 0.8, ai: { huntId: w.player.id, press: true } });
               if (key === 'hard') add(w, 'Benham', 'enemy', P(12300, 3200), Math.PI, { name: 'USS Monssen', nation: 'us', telegraph: 4, minDist: 9000, ai: { huntId: w.player.id, press: true } });
            });
         },
         update(w, dt, S) {
            const p = w.player;
            if (!p || !p.alive || w.phase !== 'playing') return;
            if (S.phase2 && inZone(p, S.exit)) {
               setObj(w, 'exit', 'done', 'Die Chōkai ist im Slot verschwunden');
               if (S.own.every(s => s.alive || s.escaped)) setObj(w, 'home', 'done');
               setObj(w, 'four', S.kills >= 4 ? 'done' : 'failed');
               w.end(true, 'Überfall geglückt – Mikawas Kreuzer verschwinden vor dem Morgengrauen im Slot.');
               return;
            }
            S.tick = (S.tick || 0) + dt;
            if (S.tick < 0.5) return;
            S.tick = 0;
            const japs = w.ships.filter(s => s.alive && s.side === 'player');
            const seen = (g, r) => [...g.ca, ...g.dd].some(e => e.alive && (e.hp < e.maxHP || japs.some(j => d2(j, e) < r * r)));
            if (!S.south.awake && (w.time > 150 || seen(S.south, S.wakeR)))
               this._wake(w, S, S.south, 'USS Patterson', '„Warnung! Warnung! Fremde Schiffe laufen in den Sund ein!“');
            if (!S.north.awake && seen(S.north, S.wakeR * 0.8))
               this._wake(w, S, S.north, 'USS Vincennes', 'Scheinwerfer von achtern – das sind Japaner! Alle Mann auf Gefechtsstation!');
            if (!S.picketsUp && (S.pickets.some(e => e.alive && e.hp < e.maxHP) || (S.south.awake && w.time > 330))) this._pickets(w, S);
            if (S.phase2) {
               // the column follows the flagship out; ships that reach the Slot are safe
               for (const s of [...S.own, S.yunagi]) if (s.alive && inZone(s, S.exit)) w.removeShip(s, 'escaped');
            } else {
               // autopilot (tests): the nearest cruiser still afloat
               const t = nearest(p, S.targets);
               if (t) p.ai.huntId = t.id;
            }
         },
         onSink(w, ship, killer, S) {
            if (S.own.includes(ship)) { setObj(w, 'home', 'failed'); return; }
            if (!S.targets.includes(ship)) return;
            S.kills++;
            w.score.player = S.kills;
            objText(w, 'kills', `Versenken Sie ${S.need} alliierte Kreuzer (${Math.min(S.kills, S.need)}/${S.need})`);
            objText(w, 'four', `Versenken Sie vier Kreuzer (${Math.min(S.kills, 4)}/4)`);
            if (S.kills >= 4) setObj(w, 'four', 'done');
            if (S.kills === 1) radio(w, 'Aoba', `Die ${ship.name} sinkt! Weiter – Savo an Backbord runden, die Nordgruppe wartet.`);
            if (S.kills >= S.need) this._withdraw(w, S);
         },
         timeout(w, S) {
            if (!S.phase2) setObj(w, 'kills', 'failed');
            w.end(false, S.phase2 ? 'Der Tag bricht an – Fletchers Trägerflugzeuge stellen Ihren Verband im Slot.' : 'Der Tag bricht an – der Überfall ist gescheitert, die Deckungsgruppen halten den Sund.');
         },
      },
   ];
}
