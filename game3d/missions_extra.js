// game3d/missions_extra.js — second batch of missions and historical operations. Built by
// missions.js through extraMissions(helpers): the helpers (add, objective, zone, later ...) live
// there, this file only holds mission data and scripts. Mission text is German (UI), code English.
// Only ships of the existing roster are used.
export function extraMissions(H) {
   const { P, add, objective, setObj, objText, later, radio, zone, inZone, islands, combatants, spawnTeam, teamHPFrac, SHIPS } = H;
   const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
   const sunk = (list) => list.filter(s => !s.alive && !s.escaped).length;

   return [
      // ------------------------------------------------------------ defence against waves
      {
         id: 'strait', name: 'Sperrriegel', subtitle: 'Fjordeinfahrt · Abwehr in drei Wellen',
         briefing: 'Britische Kreuzer und Zerstörer wollen in den Fjord eindringen und den Hafen samt Nachschublager zusammenschießen. ' +
            'Ihr Verband liegt als Sperrriegel vor der Einfahrt. Der Feind kommt in drei Wellen aus Westen und hält stur auf den Hafen zu – ' +
            'jedes Schiff, das die Hafenzone erreicht, gilt als durchgebrochen. Brechen drei Schiffe durch, ist der Hafen verloren. ' +
            'Halten Sie, bis der Angriff nach zwölf Minuten abgebrochen wird, oder versenken Sie alle Angreifer.',
         env: { time: 'dawn', weather: 'overcast' }, type: 'defense', playableShips: null, recommendedShip: 'Hipper',
         arena: 11000, timeLimit: 12 * 60, stars: 2,
         setup(w, shipKey) {
            islands(w, [
               { c: P(5600, -8000), r: 2500, height: 460, seed: 911, lobes: 8, elong: 2.2, rot: 0.05, rough: 0.7, name: 'Nordufer' },
               { c: P(5600, 8000), r: 2500, height: 430, seed: 913, lobes: 8, elong: 2.2, rot: -0.05, rough: 0.7, name: 'Südufer' },
               { c: P(600, -2700), r: 750, height: 170, seed: 917, lobes: 5, rough: 0.6 },
               { c: P(1400, 3000), r: 800, height: 190, seed: 919, lobes: 5, elong: 1.4, rot: 0.6 },
               { c: P(-4200, 300), r: 600, height: 130, seed: 923, lobes: 4 },
               { c: P(-6500, -6200), r: 900, height: 200, seed: 929, lobes: 5 },
               { c: P(-6300, 6400), r: 850, height: 180, seed: 931, lobes: 5 },
            ]);
            const S = w._script, hard = w.difficulty.key === 'hard';
            S.harbour = zone(w, 8300, 0, 1500, 'Hafen', 'goal');
            S.runners = []; S.broke = 0; S.kills = 0; S.total = 0;
            spawnTeam(w, 'player', [['Hipper', 0, 0], ['Scharnhorst', -900, 900], ['Nuernberg', 300, -2200], ['Z23', 900, 1900], ['Z23', 900, -900]], P(4300, 0), Math.PI, shipKey);
            // runners hold their course for the harbour (and shoot on the way); a ship without a route is cover
            const run = (cls, y, lane) => {
               const s = add(w, cls, 'enemy', P(-10200, y), 0, { telegraph: 4, minDist: S.total ? 9000 : 0,
                  ai: { route: [P(-3000, lane), P(3800, lane * 0.5), P(S.harbour.x, S.harbour.y)] } });
               S.runners.push(s); S.total++;
               return s;
            };
            run('Jervis', -3200, -1500); run('Jervis', 3200, 1500); run('Fiji', 0, 1400);
            later(S, 150, () => {
               w.message('Zweite Welle aus Westen: ein schwerer Kreuzer und Zerstörer!', 'warn');
               run('Norfolk', -800, -1300); run('Jervis', -4200, -1700); if (hard) run('Jervis', 4200, 1700);
            });
            later(S, 330, () => {
               w.message('Dritte Welle! Ein Schlachtschiff deckt den Durchbruch.', 'warn');
               add(w, 'KGV', 'enemy', P(-10300, 600), 0, { telegraph: 3, minDist: 11000 }); S.total++;
               run('Fiji', -2500, -1500); run('Jervis', 3600, 1600);
               if (hard) run('Jervis', -5000, -1800);
               S.wavesDone = true;
            });
            objective(w, 'hold', 'Höchstens 2 Schiffe durchbrechen lassen (0 durchgebrochen)');
            objective(w, 'time', 'Halten Sie die Einfahrt (12:00)');
            objective(w, 'all', 'Versenken Sie alle Angreifer', { optional: true });
            w.score = { kind: 'count', player: 0, enemy: 0, target: 3 };
            w.message('Feindverband im Westen gemeldet. Niemand kommt in den Hafen!');
         },
         update(w, dt, S) {
            for (const s of S.runners) {
               if (!s.alive || !inZone(s, S.harbour)) continue;
               w.removeShip(s, 'escaped');
               S.broke++;
               w.score.enemy = S.broke;
               w.message(`${s.name} ist in den Hafen durchgebrochen!`, 'warn');
               objText(w, 'hold', `Höchstens 2 Schiffe durchbrechen lassen (${S.broke} durchgebrochen)`);
               setObj(w, 'all', 'failed');
               if (S.broke >= 3) { setObj(w, 'hold', 'failed'); w.end(false, 'Drei Schiffe sind durchgebrochen – der Hafen brennt.'); return; }
            }
            objText(w, 'time', `Halten Sie die Einfahrt (${clock(w.timeLeft)})`);
            if (S.wavesDone && w.phase === 'playing' && !combatants(w, 'enemy').length) this._won(w, S);
         },
         _won(w, S) {
            setObj(w, 'hold', 'done'); setObj(w, 'time', 'done');
            if (!S.broke && !combatants(w, 'enemy').length) setObj(w, 'all', 'done');
            w.end(true, combatants(w, 'enemy').length ? 'Der Feind bricht den Angriff ab – die Einfahrt ist gehalten.' : 'Alle Angreifer sind versenkt – der Hafen ist sicher.');
         },
         onSink(w, ship, killer, S) {
            if (ship.side !== 'enemy') { if (!combatants(w, 'player').length) w.end(false, 'Ihr Verband wurde vernichtet.'); return; }
            S.kills++;
            w.score.player = S.kills;
         },
         timeout(w, S) { this._won(w, S); },
      },

      // ------------------------------------------------------------ delaying action
      {
         id: 'rearguard', name: 'Rückzugsgefecht', subtitle: 'Vor der norwegischen Küste · Nachhut',
         briefing: 'Die Gneisenau hat einen Torpedotreffer erhalten und läuft nur noch 13 Knoten. Sie schleppt sich nach Osten in den schützenden Fjord, ' +
            'doch britische Kreuzer und Zerstörer haben die Verfolgung aufgenommen, ein Schlachtkreuzer folgt. ' +
            'Sie bilden die Nachhut: Halten Sie die Verfolger auf, legen Sie Nebel, binden Sie ihr Feuer – bis die Gneisenau den Fjord erreicht. ' +
            'Sinkt die Gneisenau, ist das Gefecht verloren.',
         env: { time: 'dusk', weather: 'rain' }, type: 'delay', playableShips: null, recommendedShip: 'Hipper',
         arena: 12000, timeLimit: 11 * 60, stars: 3,
         setup(w, shipKey) {
            islands(w, [
               { c: P(9300, -7400), r: 2500, height: 520, seed: 941, lobes: 8, elong: 1.8, rot: 1.2, rough: 0.8, name: 'Festland' },
               { c: P(9500, 7600), r: 2400, height: 480, seed: 943, lobes: 8, elong: 1.8, rot: -1.2, rough: 0.8 },
               { c: P(2500, -4200), r: 800, height: 180, seed: 947, lobes: 5 },
               { c: P(1200, 4600), r: 900, height: 200, seed: 953, lobes: 5, elong: 1.5, rot: 0.3 },
               { c: P(-5200, -5600), r: 700, height: 150, seed: 957, lobes: 4 },
               { c: P(-6200, 5200), r: 650, height: 140, seed: 959, lobes: 4 },
            ]);
            const S = w._script, hard = w.difficulty.key === 'hard', easy = w.difficulty.key === 'easy';
            S.fjord = zone(w, 9800, 0, 1500, 'Fjord', 'goal');
            S.gn = add(w, 'Scharnhorst', 'player', P(-3600, 0), 0, { name: 'Gneisenau', telegraph: 4, speedKn: 14,
               ai: { route: [P(3000, 300), P(S.fjord.x, S.fjord.y)], convoy: true } });
            S.gn.hp = Math.round(S.gn.maxHP * (hard ? 0.7 : 0.8));
            add(w, shipKey, 'player', P(-5200, 900), 0, { isPlayer: true });
            add(w, 'Z23', 'player', P(-4600, -1300), 0, { ai: { escortId: S.gn.id } });
            add(w, 'Nuernberg', 'player', P(-4300, 1500), 0, { ai: { escortId: S.gn.id } });
            S.chasers = [];
            const chase = (cls, pos, name, extra = {}) => {
               const s = add(w, cls, 'enemy', pos, 0, { telegraph: 4, name, minDist: 9500, dmgMult: w.difficulty.botDmg * 0.7, ...extra, ai: { huntId: S.gn.id, press: true } });
               S.chasers.push(s);
               return s;
            };
            chase('Norfolk', P(-11300, -1200), 'HMS Norfolk'); chase('Fiji', P(-11300, 1300), 'HMS Sheffield');
            chase('Jervis', P(-10800, -3000)); if (!easy) chase('Jervis', P(-10800, 3200));
            later(S, 170, () => {
               w.message('Zerstörer laufen von Norden zum Torpedoangriff auf die Gneisenau an!', 'warn');
               chase('Jervis', P(S.gn.pos.x + 1500, -11200)); chase('Jervis', P(S.gn.pos.x - 500, -11400));
            });
            later(S, 300, () => {
               w.message(hard ? 'HMS Hood und HMS Suffolk schließen von achtern auf!' : 'Der Schlachtkreuzer HMS Hood schließt von achtern auf!', 'warn');
               chase('Hood', P(-11400, 0), 'HMS Hood');
               if (hard) chase('Norfolk', P(-11400, 2200), 'HMS Suffolk');
            });
            objective(w, 'cover', 'Die Gneisenau erreicht den Fjord');
            objective(w, 'alive', `Die Gneisenau darf nicht sinken (${hard ? 70 : 80} % Kampfkraft)`);
            objective(w, 'kills', 'Versenken Sie 2 Verfolger (0/2)', { optional: true });
            w.score = { kind: 'kills', player: 0, enemy: 0, target: 2 };
            S.kills = 0;
            w.message('Nachhut: Halten Sie die Verfolger von der Gneisenau fern.');
         },
         update(w, dt, S) {
            const g = S.gn;
            if (!g.alive) return;
            objText(w, 'alive', `Die Gneisenau darf nicht sinken (${Math.round(g.hp / g.maxHP * 100)} % Kampfkraft)`);
            const d = Math.max(0, Math.hypot(g.pos.x - S.fjord.x, g.pos.y - S.fjord.y) - S.fjord.r);
            objText(w, 'cover', `Die Gneisenau erreicht den Fjord (noch ${(d / 1000).toFixed(1).replace('.', ',')} km)`);
            if (inZone(g, S.fjord)) {
               w.removeShip(g, 'arrived');
               setObj(w, 'cover', 'done', 'Die Gneisenau hat den Fjord erreicht'); setObj(w, 'alive', 'done');
               w.end(true, 'Die Gneisenau ist in Sicherheit – die Nachhut hat gehalten.');
            }
         },
         onSink(w, ship, killer, S) {
            if (ship === S.gn) { setObj(w, 'alive', 'failed'); setObj(w, 'cover', 'failed'); w.end(false, 'Die Gneisenau ist gesunken.'); return; }
            if (ship.side !== 'enemy') return;
            S.kills++;
            w.score.player = S.kills;
            objText(w, 'kills', `Versenken Sie 2 Verfolger (${Math.min(S.kills, 2)}/2)`);
            if (S.kills >= 2) setObj(w, 'kills', 'done');
         },
         timeout(w) { setObj(w, 'cover', 'failed'); w.end(false, 'Die Gneisenau hat den Fjord nicht rechtzeitig erreicht.'); },
      },

      // ------------------------------------------------------------ fleet action
      {
         id: 'fleet', name: 'Flottenschlacht', subtitle: 'Offene See · Schlachtlinie gegen Schlachtlinie',
         briefing: 'Die Kernflotte stellt die Home Fleet auf offener See: je drei Großkampfschiffe mit Kreuzern und Zerstörern. ' +
            'Hier entscheidet die Schlachtlinie. Versenken Sie alle drei britischen Großkampfschiffe – King George V, Rodney und Hood – ' +
            'bevor die eigene Linie zusammenbricht. Gehen alle deutschen Schlachtschiffe verloren, ist die Schlacht verloren. ' +
            'Kreuzer und Zerstörer halten die feindlichen Torpedoträger von der Linie fern.',
         env: { time: 'day', weather: 'clear', front: { at: 330, dur: 70, to: 'rain', text: 'Regenschauer ziehen über das Gefechtsfeld' } },
         type: 'fleet', playableShips: null, recommendedShip: 'Bismarck',
         arena: 13000, timeLimit: 20 * 60, stars: 3,
         setup(w, shipKey) {
            islands(w, [
               { c: P(-600, -9800), r: 1100, height: 180, seed: 961, lobes: 5, elong: 1.6, rot: 0.3 },
               { c: P(900, 9600), r: 1000, height: 160, seed: 967, lobes: 5, elong: 1.5, rot: -0.2 },
               { c: P(0, 300), r: 520, height: 90, seed: 971, lobes: 4, rough: 0.8 },
            ]);
            const S = w._script;
            const DE = [['Bismarck', 0, -900], ['Scharnhorst', -300, 900], ['Scharnhorst', -500, 2700], ['Hipper', 600, -3000],
               ['Hipper', 600, 4600], ['Nuernberg', 900, -4700], ['Z23', 1900, -1900], ['Z23', 1900, 1900]];
            const UK = [['KGV', 0, -900], ['Rodney', -300, 900], ['Hood', -500, 2700], ['Norfolk', 600, -3000],
               ['Norfolk', 600, 4600], ['Fiji', 900, -4700], ['Jervis', 1900, -1900], ['Jervis', 1900, 1900]];
            S.own = spawnTeam(w, 'player', DE, P(-10200, 0), 0, shipKey).filter(s => s.type === 'BB');
            S.foe = spawnTeam(w, 'enemy', UK, P(10200, 0), Math.PI, null).filter(s => s.type === 'BB');
            objective(w, 'line', `Versenken Sie die britischen Großkampfschiffe (0/${S.foe.length})`);
            objective(w, 'own', `Halten Sie die eigene Schlachtlinie (${S.own.length} Schlachtschiffe)`);
            objective(w, 'light', 'Verlieren Sie höchstens 3 Schiffe', { optional: true });
            w.score = { kind: 'kills', player: 0, enemy: 0, target: S.foe.length };
            S.lost = 0;
            w.message('Feindliche Schlachtlinie voraus. Ziel sind die Großkampfschiffe!');
         },
         onSink(w, ship, killer, S) {
            if (ship.side === 'player') {
               S.lost++;
               if (S.lost > 3) setObj(w, 'light', 'failed');
               if (S.own.includes(ship)) {
                  const left = S.own.filter(s => s.alive).length;
                  w.score.enemy = S.own.length - left;
                  objText(w, 'own', `Halten Sie die eigene Schlachtlinie (${left} Schlachtschiffe)`);
                  if (!left) { setObj(w, 'own', 'failed'); w.end(false, 'Die eigene Schlachtlinie ist vernichtet.'); }
               }
               return;
            }
            if (!S.foe.includes(ship)) return;
            const n = S.foe.filter(s => !s.alive).length;
            w.score.player = n;
            objText(w, 'line', `Versenken Sie die britischen Großkampfschiffe (${n}/${S.foe.length})`);
            if (n === 1) w.message(`${ship.name} sinkt! Die britische Linie wankt.`);
            if (n >= S.foe.length) {
               setObj(w, 'line', 'done'); setObj(w, 'own', 'done');
               if (S.lost <= 3) setObj(w, 'light', 'done');
               w.end(true, 'Die britische Schlachtlinie ist zerschlagen.');
            }
         },
         timeout(w, S) {
            const hp = (l) => l.reduce((a, s) => a + (s.alive ? s.hp : 0), 0) / l.reduce((a, s) => a + s.maxHP, 0);
            if (hp(S.own) > hp(S.foe)) w.end(true, 'Die Home Fleet dreht ab – Ihre Schlachtlinie hat das Feld behauptet.');
            else { setObj(w, 'line', 'failed'); w.end(false, 'Die Dunkelheit trennt die Flotten – die britische Linie steht noch.'); }
         },
      },

      // ============================================================ Historische Operationen
      // ------------------------------------------------------------ op: Channel Dash
      {
         id: 'cerberus', group: 'ops', name: 'Unternehmen Cerberus', subtitle: 'Ärmelkanal · 12. Februar 1942',
         fleet: { own: 'Scharnhorst, Gneisenau, Prinz Eugen, Zerstörer', foe: 'Zerstörer aus Harwich (Campbell, Vivacious, Mackay, Whitshed, Worcester) · Minen' },
         briefing: 'Februar 1942: Scharnhorst, Gneisenau und Prinz Eugen sollen von Brest durch den Ärmelkanal in die Heimat verlegen – am helllichten Tag, ' +
            'unter den Augen der britischen Küste. Der Verband hat die Straße von Dover passiert, vor ihm liegen Minenfelder und die Zerstörer aus Harwich. ' +
            'Führen Sie die Scharnhorst nach Osten in die Nordsee. Halten Sie hohe Fahrt, weichen Sie den Torpedofächern aus – und rechnen Sie mit Minen.',
         debrief: 'Der Durchbruch gelang: Die britische Abwehr reagierte zu spät und zersplittert, die Torpedos der Harwich-Zerstörer gingen fehl, ' +
            'HMS Worcester wurde schwer zusammengeschossen. Die Scharnhorst lief jedoch auf zwei Minen, die Gneisenau auf eine; beide erreichten mit eigener Kraft die Elbmündung. ' +
            'Taktisch ein deutscher Erfolg – strategisch gaben die Schiffe damit ihre Stellung am Atlantik auf.',
         env: { time: 'day', weather: 'overcast', visibility: 0.7, front: { at: 200, dur: 80, to: 'rain', text: 'Regen und tiefe Wolken über dem Kanal' } },
         type: 'breakout', playableShips: ['Scharnhorst'], recommendedShip: 'Scharnhorst',
         arena: 13000, timeLimit: 8 * 60, stars: 2,
         setup(w, shipKey) {
            islands(w, [
               { c: P(-4000, -11600), r: 2800, height: 260, seed: 981, lobes: 8, elong: 3.2, rot: 0.04, rough: 0.6, name: 'England' },
               { c: P(-5500, 11800), r: 2700, height: 220, seed: 983, lobes: 8, elong: 3, rot: -0.04, rough: 0.6, name: 'Frankreich' },
               { c: P(6500, 11900), r: 2000, height: 120, seed: 987, lobes: 7, elong: 2.6, rot: 0.03, rough: 0.5, name: 'Flandern' },
               { c: P(1500, -4800), r: 420, height: 16, seed: 991, lobes: 4, elong: 2.4, rot: 0.5, rough: 0.9 },   // sandbank
            ]);
            const S = w._script, key = w.difficulty.key;
            S.exit = zone(w, 10600, -600, 1700, 'Nordsee', 'goal');
            const me = add(w, shipKey, 'player', P(-10600, 1200), 0, { isPlayer: true, telegraph: 4 });
            me.ai.route = [P(-2000, 900), P(5000, 0), P(S.exit.x, S.exit.y)];   // only read by the autopilot (tests)
            S.gn = add(w, 'Scharnhorst', 'player', P(-11700, 2100), 0, { name: 'Gneisenau', telegraph: 4, ai: { escortIdPlayer: true } });
            S.eugen = add(w, 'Hipper', 'player', P(-11900, 400), 0, { name: 'Prinz Eugen', telegraph: 4, ai: { escortIdPlayer: true } });
            add(w, 'Z23', 'player', P(-9300, -300), 0, { name: 'Z 29', telegraph: 4, ai: { escortIdPlayer: true } });
            add(w, 'Z23', 'player', P(-9500, 2600), 0, { name: 'Paul Jacobi', telegraph: 4, ai: { escortIdPlayer: true } });
            // mine barrages the player has to cross (x lines); the second one not on easy
            S.mines = key === 'easy' ? [-3400] : [-3400, 4300];
            S.dds = [];
            const dd = (name, pos) => S.dds.push(add(w, 'Jervis', 'enemy', pos, Math.PI, { name, telegraph: 4, minDist: 8500, dmgMult: w.difficulty.botDmg * 0.85, ai: { huntId: me.id, press: true } }));
            later(S, 4, () => radio(w, 'Vizeadmiral Ciliax', 'Dover liegt achteraus. Höchstfahrt, Kurs Ost – wir brechen durch!'));
            dd('HMS Campbell', P(1200, -7600)); dd('HMS Vivacious', P(2600, -6600));
            later(S, 35, () => radio(w, 'Prinz Eugen', 'Zerstörer an Backbord voraus! Sie laufen zum Torpedoangriff an!', 'warn'));
            later(S, 170, () => {
               radio(w, 'Ausguck', 'Weitere Zerstörer aus Nordost – die Harwich-Flottille!', 'warn');
               dd('HMS Mackay', P(11800, -5200)); dd('HMS Whitshed', P(11900, -3200));
               if (key !== 'easy') dd('HMS Worcester', P(11500, 3600));
               if (key === 'hard') dd('HMS Walpole', P(11900, 1400));
            });
            objective(w, 'break', 'Führen Sie die Scharnhorst in die Nordsee');
            objective(w, 'ships', 'Gneisenau und Prinz Eugen dürfen nicht sinken', { optional: true });
            objective(w, 'dd', 'Versenken Sie 2 angreifende Zerstörer (0/2)', { optional: true });
            w.score = { kind: 'kills', player: 0, enemy: 0, target: 2 };
         },
         update(w, dt, S) {
            const p = w.player;
            if (!p || !p.alive || w.phase !== 'playing') return;
            if (S.mines.length && p.pos.x > S.mines[0]) {
               S.mines.shift();
               // a ground mine under the hull: damage, flooding and half an hour of repairs compressed to 30 s
               p.takeDamage(Math.min(p.hp - 1, p.maxHP * 0.07), null, 'torp');
               p.flood(1, null);
               w.addEffect('explosion', p.pos, 1.8, 60, { big: true });
               w.shakeAdd(1.5);
               S.slowBase = S.slowBase || p.maxSpeedKn;
               p.maxSpeedKn = 14;
               radio(w, 'Leitender Ingenieur', 'Minentreffer! Maschinen ausgefallen – wir machen kaum noch Fahrt!', 'warn');
               const n = (S.mineSeq = (S.mineSeq || 0) + 1);
               later(S, w.time + 30, () => {
                  if (n !== S.mineSeq || !p.alive) return;
                  p.maxSpeedKn = S.slowBase;
                  radio(w, 'Leitender Ingenieur', 'Maschinen wieder klar – volle Fahrt möglich.');
               });
            }
            if (inZone(p, S.exit)) {
               setObj(w, 'break', 'done', 'Die Scharnhorst hat die Nordsee erreicht');
               if (S.gn.alive && S.eugen.alive) setObj(w, 'ships', 'done');
               w.end(true, 'Durchbruch geglückt – der Verband steht in der Nordsee.');
            }
         },
         onSink(w, ship, killer, S) {
            if (ship === S.gn || ship === S.eugen) { setObj(w, 'ships', 'failed'); return; }
            if (!S.dds.includes(ship)) return;
            const n = S.dds.filter(s => !s.alive).length;
            w.score.player = n;
            objText(w, 'dd', `Versenken Sie 2 angreifende Zerstörer (${Math.min(n, 2)}/2)`);
            if (n >= 2) setObj(w, 'dd', 'done');
         },
         timeout(w) { setObj(w, 'break', 'failed'); w.end(false, 'Britische Bomber und schwere Einheiten sind heran – der Durchbruch ist gescheitert.'); },
      },

      // ------------------------------------------------------------ op: Vian's destroyers
      {
         id: 'vian', group: 'ops', name: 'Vians Nachtangriff', subtitle: 'Nordatlantik · Nacht zum 27. Mai 1941',
         fleet: { own: 'HMS Cossack, Maori, Zulu, Sikh, ORP Piorun', foe: 'Bismarck (Ruder verklemmt)' },
         briefing: 'Ein Flugzeugtorpedo hat das Ruder der Bismarck verklemmt; sie läuft mit wenigen Knoten gegen die schwere See. ' +
            'Die Schlachtschiffe der Home Fleet sind erst im Morgengrauen heran. Captain Vian soll mit der 4. Zerstörerflottille die ganze Nacht Fühlung halten ' +
            'und die Bismarck mit Torpedos weiter lähmen. Führen Sie HMS Cossack bis auf Torpedoreichweite heran, erzielen Sie Torpedotreffer – ' +
            'und bleiben Sie den 38-cm-Türmen und der Mittelartillerie fern, sobald Sie entdeckt sind.',
         debrief: 'Die Zerstörer griffen die ganze Nacht über einzeln aus allen Richtungen an und schossen 16 Torpedos; im schweren Seegang und unter dem radargeleiteten Feuer der Bismarck ' +
            'ist kein Treffer gesichert, doch die Besatzung fand keine Stunde Ruhe. Leuchtgranaten zeigten der Home Fleet den Weg. ' +
            'Am Morgen des 27. Mai schossen King George V und Rodney die Bismarck zusammen; um 10:39 Uhr sank sie.',
         env: { time: 'night', weather: 'rain' }, type: 'torpedo', playableShips: ['Jervis'], recommendedShip: 'Jervis',
         arena: 11000, timeLimit: 10 * 60, stars: 3,
         setup(w, shipKey) {
            islands(w, []);
            const S = w._script, key = w.difficulty.key;
            S.need = key === 'easy' ? 2 : key === 'hard' ? 4 : 3;
            // jammed rudder: she crawls north-west in a wide weave
            S.bis = add(w, 'Bismarck', 'enemy', P(1500, 1500), -2.4, { name: 'Bismarck', telegraph: 4, speedKn: 9, hpMult: w.difficulty.botHP * 1.4,
               ai: { route: [P(-1500, -1200), P(-4500, -3800), P(-7500, -6500)], zigzag: true } });
            S.zone = zone(w, -7500, -6500, 1500, 'Kurs der Bismarck', 'danger');
            const me = add(w, shipKey, 'player', P(-7800, 5200), -0.5, { isPlayer: true, name: 'HMS Cossack', telegraph: 3 });
            me.ai.huntId = S.bis.id;   // only read by the autopilot (tests)
            S.flot = [['HMS Maori', P(-8600, 6100)], ['HMS Zulu', P(8200, 5600)], ['HMS Sikh', P(7600, -6800)], ['ORP Piorun', P(-600, 9600)]]
               .map(([name, pos]) => add(w, 'Jervis', 'player', pos, 0, { name, telegraph: 3, dmgMult: 0.3, ai: { huntId: S.bis.id } }));
            later(S, 4, () => radio(w, 'Captain Vian', 'Flottille an alle: Fühlung halten, einzeln angreifen. Torpedos erst auf sichere Entfernung!'));
            later(S, 50, () => radio(w, 'ORP Piorun', 'Bismarck in Sicht! Sie schießt mit allen Türmen!', 'warn'));
            objective(w, 'torp', `Erzielen Sie ${S.need} Torpedotreffer auf der Bismarck (0/${S.need})`);
            objective(w, 'contact', 'Nehmen Sie Fühlung mit der Bismarck auf');
            objective(w, 'flot', 'Kein Zerstörer der Flottille geht verloren', { optional: true });
            w.score = { kind: 'count', player: 0, enemy: 0, target: S.need };
            S.hits = 0;
         },
         update(w, dt, S) {
            const b = S.bis;
            if (!b.alive || w.phase !== 'playing') return;
            if (!S.contact && b.detected) {
               S.contact = true;
               setObj(w, 'contact', 'done', 'Fühlung mit der Bismarck hergestellt');
               radio(w, 'HMS Cossack', 'Feind in Sicht – Meldung an die Home Fleet abgesetzt.');
            }
            const n = w.stats.torpHits;
            if (n !== S.hits) {
               S.hits = n;
               w.score.player = n;
               objText(w, 'torp', `Erzielen Sie ${S.need} Torpedotreffer auf der Bismarck (${Math.min(n, S.need)}/${S.need})`);
               if (n < S.need) radio(w, 'HMS Cossack', 'Torpedotreffer! Wassersäule an der Bordwand der Bismarck!');
               else this._won(w, S, 'Die Bismarck ist weiter gelähmt – die Home Fleet wird sie im Morgengrauen stellen.');
            }
         },
         _won(w, S, reason) {
            setObj(w, 'torp', 'done'); setObj(w, 'contact', 'done');
            if (S.flot.every(s => s.alive)) setObj(w, 'flot', 'done');
            w.end(true, reason);
         },
         onSink(w, ship, killer, S) {
            if (S.flot.includes(ship)) setObj(w, 'flot', 'failed');
            else if (ship === S.bis) this._won(w, S, 'Die Bismarck ist gesunken – noch vor dem Eintreffen der Home Fleet.');
         },
         timeout(w) { setObj(w, 'torp', 'failed'); w.end(false, 'Der Morgen graut – die Angriffe der Flottille blieben ohne Wirkung.'); },
      },

      // ------------------------------------------------------------ op: Barents Sea
      {
         id: 'barents', group: 'ops', name: 'Schlacht in der Barentssee', subtitle: 'Geleitzug JW 51B · 31. Dezember 1942',
         fleet: { own: 'HMS Sheffield, HMS Jamaica · Geleit: Onslow, Obedient, Achates', foe: 'Admiral Hipper, Zerstörer Friedrich Eckoldt, Richard Beitzen, Z 29' },
         briefing: 'Silvester 1942 im Zwielicht der Polarnacht: Der schwere Kreuzer Admiral Hipper und mehrere Zerstörer greifen den Murmansk-Geleitzug JW 51B an. ' +
            'Die Geleitzerstörer unter Captain Sherbrooke werfen sich dazwischen und nebeln die Frachter ein. ' +
            'Sie führen die Kreuzer von Force R – Sheffield und Jamaica – von Norden heran. Fallen Sie der Hipper in den Rücken, vertreiben Sie sie ' +
            'und halten Sie die deutschen Zerstörer von den Frachtern fern. Gehen drei Frachter verloren, ist der Geleitzug gescheitert.',
         debrief: 'Sheffield und Jamaica überraschten die Hipper aus den Schneeböen und trafen sie dreimal; ein Kesselraum lief voll, Kummetz brach den Angriff ab. ' +
            'Der Zerstörer Friedrich Eckoldt hielt die Sheffield für die Hipper und wurde auf kürzeste Entfernung versenkt; auf britischer Seite gingen Achates und Bramble verloren. ' +
            'Kein Frachter sank. Hitler tobte über das Versagen der Überwasserflotte – Großadmiral Raeder trat zurück.',
         env: { time: 'dusk', weather: 'overcast', visibility: 0.72, front: { at: 150, dur: 60, to: 'storm', text: 'Schneeböen ziehen auf' } },
         type: 'escort', playableShips: ['Fiji'], recommendedShip: 'Fiji',
         arena: 12000, timeLimit: 14 * 60, stars: 2,
         setup(w, shipKey) {
            islands(w, [
               { c: P(-8600, 9000), r: 360, height: 12, seed: 1001, lobes: 5, elong: 1.8, rot: 0.3, rough: 0.9, snow: true },   // ice floes
               { c: P(7600, 8200), r: 300, height: 12, seed: 1003, lobes: 4, elong: 2, rot: 1.2, rough: 0.9, snow: true },
               { c: P(9500, -9200), r: 420, height: 14, seed: 1007, lobes: 5, elong: 1.6, rot: 0.8, rough: 0.9, snow: true },
            ]);
            const S = w._script, key = w.difficulty.key;
            S.exit = zone(w, 10200, 3000, 1500, 'Kurs Murmansk', 'goal');
            const route = [P(1500, 3200), P(6000, 3000), P(S.exit.x, S.exit.y)];
            S.transports = ['SS Empire Archer', 'SS Daldorch', 'SS Calobre', 'SS Chester Valley', 'SS Jefferson Myers'].map((name, i) => {
               const lane = i % 2 ? 450 : -450;
               return add(w, 'Transport', 'player', P(-5600 - (i >> 1) * 800, 3200 + lane), 0,
                  { name, telegraph: 4, speedKn: 9, hpMult: 3, ai: { route: route.map(p => P(p.x, p.y + lane)), routeIdx: 0, passive: true, convoy: true } });
            });
            S.escort = [['HMS Onslow', P(-4200, 1900), 0], ['HMS Obedient', P(-7300, 1900), 2], ['HMS Achates', P(-6200, 4600), 3]]
               .map(([name, pos, t]) => add(w, 'Jervis', 'player', pos, 0, { name, dmgMult: 0.35, ai: { escortId: S.transports[t].id } }));
            const me = add(w, shipKey, 'player', P(-1500, -9800), 1.9, { isPlayer: true, name: 'HMS Sheffield', telegraph: 4 });
            add(w, 'Fiji', 'player', P(-700, -10600), 1.9, { name: 'HMS Jamaica', telegraph: 4, dmgMult: 0.7, ai: { escortIdPlayer: true } });
            // Kummetz comes down from the north-west on the convoy; she breaks off once badly hit
            S.hipper = add(w, 'Hipper', 'enemy', P(-10500, -4600), 0.6, { name: 'Admiral Hipper', telegraph: 4, hpMult: w.difficulty.botHP * 1.8,
               ai: { huntId: S.transports[0].id, press: true, retreatBelow: key === 'hard' ? 0.35 : key === 'easy' ? 0.5 : 0.42, retreatTo: P(-11500, -9000) } });
            me.ai.huntId = S.hipper.id;   // only read by the autopilot (tests)
            S.eckoldt = add(w, 'Z23', 'enemy', P(-10900, -2800), 0.6, { name: 'Friedrich Eckoldt', telegraph: 4, dmgMult: w.difficulty.botDmg * 0.6, ai: { huntId: S.transports[1].id, press: true } });
            add(w, 'Z23', 'enemy', P(-9600, -5600), 0.6, { name: 'Richard Beitzen', telegraph: 4, dmgMult: w.difficulty.botDmg * 0.6, ai: { huntId: S.transports[3].id, press: true } });
            later(S, 4, () => radio(w, 'Captain Sherbrooke (Onslow)', 'Schwerer Kreuzer und Zerstörer im Nordwesten! Geleit nebelt ein – wir greifen an!', 'warn'));
            later(S, 40, () => radio(w, 'Konteradmiral Burnett', 'Force R läuft mit Höchstfahrt auf das Mündungsfeuer zu. Sheffield führt.'));
            later(S, 250, () => {
               if (key === 'easy') return;
               radio(w, 'HMS Obedient', 'Weitere Zerstörer aus Süden – sie halten auf die Frachter zu!', 'warn');
               add(w, 'Z23', 'enemy', P(-2000, 11300), -1.2, { name: 'Z 29', telegraph: 4, minDist: 8500, ai: { huntId: S.transports[2].id, press: true } });
               if (key === 'hard') add(w, 'Z23', 'enemy', P(1500, 11400), -1.4, { name: 'Z 30', telegraph: 4, minDist: 8500, ai: { huntId: S.transports[4].id, press: true } });
            });
            objective(w, 'hipper', 'Vertreiben oder versenken Sie die Admiral Hipper');
            objective(w, 'convoy', 'Höchstens 2 Frachter verlieren (0 verloren)');
            objective(w, 'eckoldt', 'Versenken Sie den Zerstörer Friedrich Eckoldt', { optional: true });
            w.score = { kind: 'convoy', player: 0, enemy: 0, target: 3 };
            S.lost = 0;
         },
         update(w, dt, S) {
            const h = S.hipper;
            for (const t of S.transports) if (t.alive && inZone(t, S.exit)) w.removeShip(t, 'arrived');
            if (!h.alive || w.phase !== 'playing') return;
            if (!S.hit && h.hp < h.maxHP * 0.8) { S.hit = true; radio(w, 'HMS Jamaica', 'Treffer auf der Hipper! Sie hat uns nicht kommen sehen!'); }
            if (h.ai.retreating) {
               if (!S.turn) { S.turn = true; radio(w, 'Funkaufklärung', 'Funkspruch Kummetz: „Gefecht abbrechen, nach Westen absetzen.“'); }
               S.turnT = (S.turnT || 0) + dt;
               if (S.turnT > 40 || Math.abs(h.pos.x) > w.arena - 900 || Math.abs(h.pos.y) > w.arena - 900) {
                  w.removeShip(h, 'retreated');
                  this._won(w, S, 'Die Hipper bricht den Angriff ab – der Geleitzug JW 51B kommt durch.', 'Admiral Hipper vertrieben');
               }
            }
         },
         _won(w, S, reason, text) {
            w.score.player = 1;
            setObj(w, 'hipper', 'done', text); setObj(w, 'convoy', 'done');
            w.end(true, reason);
         },
         onSink(w, ship, killer, S) {
            if (ship === S.hipper) this._won(w, S, 'Die Admiral Hipper ist versenkt – der Geleitzug JW 51B kommt durch.');
            else if (ship === S.eckoldt) setObj(w, 'eckoldt', 'done');
            else if (S.transports.includes(ship)) {
               S.lost++;
               w.score.enemy = S.lost;
               objText(w, 'convoy', `Höchstens 2 Frachter verlieren (${S.lost} verloren)`);
               if (S.lost >= 3) { setObj(w, 'convoy', 'failed'); w.end(false, 'Drei Frachter sind verloren – der Geleitzug ist gescheitert.'); }
            }
         },
         timeout(w) { setObj(w, 'hipper', 'failed'); w.end(false, 'Die Hipper steht noch immer am Geleitzug – Force R kam zu spät.'); },
      },

      // ------------------------------------------------------------ op: First Battle of Narvik
      {
         id: 'narvik', group: 'ops', name: 'Überfall auf Narvik', subtitle: 'Ofotfjord · 10. April 1940',
         fleet: { own: 'HMS Hardy, Hunter, Havock, Hotspur, Hostile', foe: 'Zerstörer Wilhelm Heidkamp, Anton Schmitt u. a. · Frachter im Hafen' },
         briefing: 'April 1940: Zehn deutsche Zerstörer haben Gebirgsjäger in Narvik gelandet und liegen mit ihren Versorgungsschiffen im Hafen. ' +
            'Im Morgengrauen läuft Captain Warburton-Lee mit fünf Zerstörern der 2. Flottille bei Schneetreiben unbemerkt in den Ofotfjord ein. ' +
            'Führen Sie HMS Hardy in den Hafen, versenken Sie die Frachter und überraschen Sie die Zerstörer an ihren Liegeplätzen. ' +
            'Danach heißt es: zurück nach Westen ins offene Meer – aus den Nebenfjorden werden weitere deutsche Zerstörer den Rückweg verlegen.',
         debrief: 'Der Überfall gelang: Wilhelm Heidkamp und Anton Schmitt sanken im Hafen, dazu mehrere Frachter; Kommodore Bonte fiel. ' +
            'Auf dem Rückmarsch stellten fünf deutsche Zerstörer aus dem Herjangs- und dem Ballangenfjord die Flottille. HMS Hardy wurde zusammengeschossen und auf Strand gesetzt, ' +
            'HMS Hunter sank, Warburton-Lee fiel und erhielt postum das Victoria-Kreuz. Drei Tage später vernichtete HMS Warspite die verbliebenen deutschen Zerstörer.',
         env: { time: 'dawn', weather: 'rain', visibility: 0.62 }, type: 'harbour', playableShips: ['Jervis'], recommendedShip: 'Jervis',
         arena: 11000, timeLimit: 14 * 60, stars: 3,
         setup(w, shipKey) {
            islands(w, [
               { c: P(-1500, -8900), r: 2500, height: 620, seed: 1011, lobes: 9, elong: 3, rot: 0.03, rough: 0.8, snow: true, name: 'Nordufer' },
               { c: P(-1500, 9000), r: 2500, height: 640, seed: 1013, lobes: 9, elong: 3, rot: -0.03, rough: 0.8, snow: true, name: 'Südufer' },
               { c: P(10200, -5200), r: 1700, height: 520, seed: 1017, lobes: 6, elong: 1.4, rot: 1.3, rough: 0.8, snow: true },
               { c: P(10300, 5600), r: 1700, height: 560, seed: 1019, lobes: 6, elong: 1.4, rot: -1.3, rough: 0.8, snow: true, name: 'Narvik' },
               { c: P(600, -1900), r: 480, height: 120, seed: 1021, lobes: 4, snow: true },
            ]);
            const S = w._script, key = w.difficulty.key;
            S.need = key === 'easy' ? 3 : 4;
            S.harbour = zone(w, 7300, 600, 1900, 'Hafen Narvik', 'danger');
            S.exit = zone(w, -9000, 0, 1600, 'Vestfjord', 'goal');
            S.ships = ['Frielinghaus', 'Hein Hoyer', 'Aachen', 'Altona', 'Bockenheim', 'Martha H. Fisser'].map((name, i) => {
               const pos = P(6400 + (i % 3) * 900, -300 + (i >> 1) * 650);
               return add(w, 'Transport', 'enemy', pos, Math.PI / 2, { name: 'Dampfer ' + name, nation: 'de', telegraph: 1, speedKn: 2,
                  hpMult: 0.8 * w.difficulty.botHP, ai: { passive: true, patrol: [pos, P(pos.x + 150, pos.y + 250)] } });
            });
            // at their berths, crews asleep: they wake when the first shells land (or after 70 s)
            S.berth = [['Wilhelm Heidkamp', P(8200, -900)], ['Anton Schmitt', P(8500, 1900)]]
               .map(([name, pos]) => add(w, 'Z23', 'enemy', pos, Math.PI, { name, telegraph: 0, dmgMult: w.difficulty.botDmg * 0.7, ai: { passive: true, patrol: [pos, P(pos.x - 200, pos.y)] } }));
            const me = add(w, shipKey, 'player', P(-6500, 300), 0, { isPlayer: true, name: 'HMS Hardy', telegraph: 3 });
            me.ai.huntId = S.ships[0].id; me.ai.press = true;   // only read by the autopilot (tests)
            S.flot = [['HMS Hunter', P(-7300, -700)], ['HMS Havock', P(-7400, 1200)], ['HMS Hotspur', P(-8600, -300)], ['HMS Hostile', P(-8700, 1400)]]
               .map(([name, pos], i) => add(w, 'Jervis', 'player', pos, 0, { name, telegraph: 3, dmgMult: 0.6, ai: { huntId: S.ships[1 + i].id, press: true } }));
            S.german = [...S.berth];
            later(S, 4, () => radio(w, 'Captain Warburton-Lee', 'Flottille: mir nach in den Hafen. Feuer erst auf mein Kommando – sie schlafen noch.'));
            objective(w, 'sink', `Versenken Sie ${S.need} Frachter im Hafen (0/${S.need})`);
            objective(w, 'dds', 'Versenken Sie 2 deutsche Zerstörer (0/2)', { optional: true });
            objective(w, 'flot', 'Verlieren Sie höchstens einen Zerstörer der Flottille', { optional: true });
            w.score = { kind: 'raid', player: 0, enemy: 0, target: S.need };
            S.sunkTr = 0; S.lostDD = 0;
         },
         _wake(w, S) {
            if (S.awake) return;
            S.awake = true;
            for (const s of S.berth) { s.ai.passive = false; s.ai.patrol = null; s.setTelegraph(4); }
            radio(w, 'HMS Hardy', 'Alarm im Hafen – die deutschen Zerstörer machen Dampf auf!', 'warn');
         },
         _withdraw(w, S) {
            if (S.phase2) return;
            S.phase2 = true;
            const key = w.difficulty.key, p = w.player;
            setObj(w, 'sink', 'done');
            objective(w, 'out', 'Rückzug: Erreichen Sie den Vestfjord im Westen');
            radio(w, 'Captain Warburton-Lee', 'Auftrag erfüllt. Flottille: kehrt, mit Höchstfahrt nach Westen ablaufen!');
            if (p && p.alive) { p.ai.huntId = null; p.ai.press = false; p.ai.route = [P(2000, 300), P(-4000, 0), P(S.exit.x, S.exit.y)]; p.ai.routeIdx = 0; }
            for (const s of S.flot) if (s.alive) { s.ai.huntId = null; s.ai.press = false; s.ai.escortId = p ? p.id : null; }
            later(S, w.time + 12, () => {
               radio(w, 'HMS Hostile', 'Zerstörer aus dem Herjangsfjord – sie kommen von Norden!', 'warn');
               const names = key === 'easy' ? ['Wolfgang Zenker'] : key === 'hard' ? ['Wolfgang Zenker', 'Erich Giese', 'Erich Koellner'] : ['Wolfgang Zenker', 'Erich Giese'];
               names.forEach((name, i) => S.german.push(add(w, 'Z23', 'enemy', P(5200 - i * 900, -6300), 1.9, { name, telegraph: 4, minDist: 6500, dmgMult: w.difficulty.botDmg * 0.7, ai: { huntId: p ? p.id : null } })));
            });
            later(S, w.time + 55, () => {
               radio(w, 'HMS Hardy', 'Zwei Zerstörer voraus – Georg Thiele und Bernd von Arnim verlegen uns den Weg!', 'warn');
               const names = key === 'hard' ? ['Georg Thiele', 'Bernd von Arnim'] : ['Georg Thiele'];
               names.forEach((name, i) => S.german.push(add(w, 'Z23', 'enemy', P(-3800, 5600 - i * 1100), -0.9, { name, telegraph: 4, minDist: 6500, dmgMult: w.difficulty.botDmg * 0.7, ai: { huntId: p ? p.id : null } })));
            });
         },
         update(w, dt, S) {
            const p = w.player;
            if (!p || !p.alive || w.phase !== 'playing') return;
            if (!S.awake && (w.time > 70 || S.berth.some(s => s.hp < s.maxHP) || S.ships.some(s => !s.alive || s.hp < s.maxHP))) this._wake(w, S);
            if (S.phase2 && inZone(p, S.exit)) {
               setObj(w, 'out', 'done', 'Die Flottille ist ins offene Meer entkommen');
               if (S.lostDD <= 1) setObj(w, 'flot', 'done');
               w.end(true, 'Überfall geglückt – HMS Hardy hat den Vestfjord erreicht.');
            }
         },
         onSink(w, ship, killer, S) {
            if (S.flot.includes(ship)) {
               S.lostDD++;
               w.score.enemy = S.lostDD;
               if (S.lostDD > 1) setObj(w, 'flot', 'failed');
            } else if (S.german.includes(ship)) {
               const n = S.german.filter(s => !s.alive).length;
               objText(w, 'dds', `Versenken Sie 2 deutsche Zerstörer (${Math.min(n, 2)}/2)`);
               if (n >= 2) setObj(w, 'dds', 'done');
            } else if (S.ships.includes(ship)) {
               S.sunkTr++;
               w.score.player = S.sunkTr;
               objText(w, 'sink', `Versenken Sie ${S.need} Frachter im Hafen (${Math.min(S.sunkTr, S.need)}/${S.need})`);
               this._wake(w, S);
               if (S.sunkTr >= S.need) this._withdraw(w, S);
            }
         },
         timeout(w, S) {
            if (!S.phase2) setObj(w, 'sink', 'failed');
            w.end(false, S.phase2 ? 'Die deutschen Zerstörer haben den Fjord abgeriegelt – kein Entkommen.' : 'Der Überfall ist gescheitert – zu wenige Frachter versenkt.');
         },
      },
   ];
}
