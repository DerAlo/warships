// game3d/missions_west.js — third batch, Atlantic and Mediterranean: historical operations built by
// westMissions(H) from the helpers of missions.js (same contract as missions_extra.js).
//   laplata    River Plate: three cruisers hunt the Admiral Graf Spee from two bearings
//   pedestal   Malta convoy: bring the tanker Ohio through a submarine, air raids and fast boats
//   juno       Scharnhorst and Gneisenau run down the carrier Glorious behind her destroyers' smoke
import { canLaunch, launchSquadron } from './air.js';
import { orderDepth } from './submarine.js';

export function westMissions(H) {
   const { P, add, objective, setObj, objText, later, radio, zone, inZone, islands } = H;
   const pct = (f) => Math.max(0, Math.round(f * 100));
   const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
   const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

   return [
      // ------------------------------------------------------------ op: River Plate
      // The player leads the light cruisers. The Graf Spee (closest class: the 28 cm Scharnhorst
      // hull, cut down in HP and salvo weight) keeps her heavy guns on the Exeter until the light
      // cruisers hurt her or come close: who draws the fire, and from where, is the mission.
      {
         id: 'laplata', group: 'ops', name: 'Schlacht am Río de la Plata', subtitle: 'Südatlantik · 13. Dezember 1939',
         fleet: { own: 'HMS Ajax, HMS Achilles · HMS Exeter', foe: 'Panzerschiff Admiral Graf Spee' },
         briefing: 'Im Morgengrauen vor der Mündung des Río de la Plata: Commodore Harwood hat das Panzerschiff Admiral Graf Spee gestellt, das seit Kriegsbeginn neun Handelsschiffe versenkt hat. ' +
            'Ihre 28-cm-Geschütze sind jedem seiner Kreuzer überlegen – deshalb greift er aus zwei Richtungen an: Die Exeter läuft nach Westen, Sie führen Ajax und Achilles nach Osten. ' +
            'Zwingen Sie die Graf Spee, ihr Feuer zu teilen. Solange sie auf die Exeter schießt, können Sie herangehen; trifft Ihre Division hart genug, schwenkt sie die Türme auf Sie – dann helfen Nebel und Fahrt. ' +
            'Schießen Sie das Panzerschiff gefechtsunfähig, bevor es in den Atlantik entkommt.',
         debrief: 'Die Graf Spee schoss die Exeter binnen einer Stunde zum Wrack: Alle Türme fielen aus, mit Schlagseite lief der Kreuzer zu den Falklandinseln ab. ' +
            'Ajax und Achilles gingen bis auf vier Seemeilen heran und trafen das Panzerschiff rund zwanzigmal. Kapitän Langsdorff brach das Gefecht ab und lief in das neutrale Montevideo ein. ' +
            'Dort überzeugten ihn britische Funktäuschungen, vor der Mündung warte eine Übermacht – am 17. Dezember 1939 sprengte die Besatzung ihr Schiff auf dem Río de la Plata selbst.',
         env: { time: 'dawn', weather: 'clear' }, type: 'historic', playableShips: ['Fiji'], recommendedShip: 'Fiji',
         arena: 13000, timeLimit: 11 * 60, stars: 2,
         setup(w, shipKey) {
            islands(w, [
               { c: P(-11600, -11400), r: 2300, height: 90, seed: 1101, lobes: 7, elong: 2.4, rot: 0.6, rough: 0.5, name: 'Punta del Este' },
               { c: P(-8200, -6400), r: 300, height: 30, seed: 1103, lobes: 4, rough: 0.7, name: 'Isla de Lobos' },
            ]);
            const S = w._script, key = w.difficulty.key;
            S.port = zone(w, -10700, -1200, 1700, 'Río de la Plata', 'danger');
            S.limit = key === 'hard' ? 0.42 : key === 'easy' ? 0.58 : 0.5;
            S.baseDmg = w.difficulty.botDmg * 1.1;
            S.spee = add(w, 'Scharnhorst', 'enemy', P(-2600, -3600), 0.75, {
               name: 'Admiral Graf Spee', telegraph: 4, speedKn: 28, hpMult: w.difficulty.botHP * 1.25, dmgMult: S.baseDmg,
               ai: { retreatBelow: S.limit, retreatTo: P(S.port.x, S.port.y) },
            });
            const me = add(w, shipKey, 'player', P(3300, 4300), -2.25, { isPlayer: true, name: 'HMS Ajax', telegraph: 3 });
            me.ai.huntId = S.spee.id;   // only read by the autopilot (tests)
            S.achilles = add(w, 'Fiji', 'player', P(4000, 5000), -2.25, { name: 'HMS Achilles', telegraph: 3, hpMult: 0.85, dmgMult: 0.3, ai: { escortIdPlayer: true } });
            S.exeter = add(w, 'Norfolk', 'player', P(300, 6300), -2.6, {
               name: 'HMS Exeter', telegraph: 4, hpMult: 0.9, dmgMult: 0.3, ai: { retreatBelow: 0.3, retreatTo: P(-1500, 12300) },
            });
            S.spee.ai.huntId = S.exeter.id;
            // the Exeter takes the western flank (the angling side is rolled on the first AI tick)
            later(S, 0.5, () => { if (S.exeter.ai) S.exeter.ai.angSide = -1; });
            S.acc = 0; S.heat = 0; S.dmg0 = 0; S.crossT = 0; S.tick = 0;
            later(S, 3, () => radio(w, 'Commodore Harwood', 'Das ist ein Panzerschiff! Exeter nach Westen, erste Division mir nach – wir nehmen sie in die Zange.'));
            later(S, 16, () => radio(w, 'HMS Exeter', 'Liegen unter schwerem Feuer – 28-cm-Aufschläge deckend!', 'warn'));
            objective(w, 'damage', `Schießen Sie die Graf Spee gefechtsunfähig (Zustand 100 %, Ziel ${pct(S.limit)} %)`);
            objective(w, 'port', 'Halten Sie Fühlung, bis sie in den Río de la Plata flüchtet');
            objective(w, 'cross', 'Kreuzfeuer: 30 s aus zwei Richtungen zugleich (0/30)', { optional: true });
            objective(w, 'exeter', 'Die Exeter darf nicht sinken', { optional: true });
            w.score = { kind: 'kills', player: 0, enemy: 0, target: 1 };
         },
         update(w, dt, S) {
            const s = S.spee, me = w.player, ex = S.exeter;
            if (!s.alive || w.phase !== 'playing') return;
            const exFights = ex.alive && !ex.ai.retreating;
            // the Exeter breaks off for the Falklands once her turrets are gone
            if (ex.alive && ex.ai.retreating) {
               if (!S.exOut) {
                  S.exOut = w.time;
                  radio(w, 'HMS Exeter', 'Alle Türme ausgefallen, Schlagseite – wir laufen nach Süden ab. Viel Glück, Ajax!', 'warn');
                  later(S, w.time + 5, () => { if (s.alive && !s.ai.retreating) radio(w, 'Commodore Harwood', 'Jetzt gilt ihr ganzes Feuer uns. Nebel, Zickzack – und dranbleiben!', 'warn'); });
               }
               if (w.time - S.exOut > 50 || Math.abs(ex.pos.y) > w.arena - 900) w.removeShip(ex, 'retreated');
            }
            // which division do the 28 cm turrets engage? Damage by the player (decaying) and range
            const d = w.stats.dmg - S.dmg0;
            S.dmg0 = w.stats.dmg;
            S.acc = Math.max(0, S.acc - s.maxHP * 0.0025 * dt) + d;
            const dMe = me && me.alive ? dist(me.pos, s.pos) : Infinity;
            if (S.acc > s.maxHP * 0.05 || dMe < 6000) {
               if (S.heat <= 0 && exFights && !s.ai.retreating && !S.swung) {
                  S.swung = true;
                  radio(w, 'HMS Achilles', 'Sie schwenkt die schweren Türme auf uns! Die Exeter bekommt Luft.', 'warn');
               }
               S.heat = 28; S.acc = 0;
            }
            S.heat -= dt;
            s.ai.huntId = !exFights || S.heat > 0 ? (me && me.alive ? me.id : null) : ex.id;
            // crossfire: the two divisions more than 60 degrees apart as seen from her bridge
            let cross = false;
            if (exFights && me && me.alive && dMe < 14000) {
               const a = Math.atan2(me.pos.y - s.pos.y, me.pos.x - s.pos.x), b = Math.atan2(ex.pos.y - s.pos.y, ex.pos.x - s.pos.x);
               cross = angDiff(a, b) > 60 * Math.PI / 180;
            }
            s.dmgMult = S.baseDmg * (cross ? 0.7 : 1);   // fire control split between two bearings
            if (cross && S.crossT < 30) {
               S.crossT += dt;
               if (!S.crossMsg) { S.crossMsg = true; radio(w, 'Artillerieoffizier', 'Kreuzfeuer! Sie muss ihre Feuerleitung teilen – ihre Salven liegen schlechter.'); }
               if (S.crossT >= 30) setObj(w, 'cross', 'done', 'Kreuzfeuer gehalten');
            }
            if ((S.tick -= dt) <= 0) {
               S.tick = 1;
               if (S.crossT < 30) objText(w, 'cross', `Kreuzfeuer: 30 s aus zwei Richtungen zugleich (${Math.floor(S.crossT)}/30)`);
               if (!s.ai.retreating) objText(w, 'damage', `Schießen Sie die Graf Spee gefechtsunfähig (Zustand ${pct(s.hp / s.maxHP)} %, Ziel ${pct(S.limit)} %)`);
            }
            if (!S.half && s.hp < s.maxHP * (S.limit + 0.2)) { S.half = true; radio(w, 'HMS Achilles', 'Treffer im Vorschiff der Graf Spee – sie brennt!'); }
            if (s.ai.retreating) {
               if (!S.turn) {
                  S.turn = w.time;
                  setObj(w, 'damage', 'done', 'Graf Spee gefechtsunfähig geschossen');
                  radio(w, 'Funkaufklärung', 'Funkspruch Langsdorff: „Schiff nicht mehr seefähig für den Nordatlantik. Laufe in den La Plata ein.“');
                  later(S, w.time + 6, () => { if (s.alive) radio(w, 'Commodore Harwood', 'Sie dreht nach Westen ab! Fühlung halten – aber bleiben Sie aus ihren Achtertürmen.'); });
               }
               // keep touch for a minute while she runs for the estuary (or see her into it)
               if (dMe < 12000) S.shadow = (S.shadow || 0) + dt;
               if (inZone(s, S.port) || S.shadow > 60) {
                  w.removeShip(s, 'retreated');
                  this._won(w, S, 'Die Graf Spee flüchtet nach Montevideo – dort sitzt sie in der Falle.', 'Graf Spee in den Río de la Plata getrieben');
               }
            }
         },
         _won(w, S, reason, text) {
            w.score.player = 1;
            setObj(w, 'damage', 'done', 'Graf Spee gefechtsunfähig geschossen');
            setObj(w, 'port', 'done', text);
            if (!S.exLost) setObj(w, 'exeter', 'done');
            w.end(true, reason);
         },
         onSink(w, ship, killer, S) {
            if (ship === S.spee) this._won(w, S, 'Die Admiral Graf Spee ist versenkt – der Handelskrieg im Südatlantik ist beendet.', 'Graf Spee versenkt');
            else if (ship === S.exeter) {
               S.exLost = true;
               setObj(w, 'exeter', 'failed');
               radio(w, 'HMS Achilles', 'Die Exeter sinkt! Jetzt liegt es an uns.', 'warn');
            }
         },
         timeout(w, S) {
            if (S.spee.ai.retreating) { w.removeShip(S.spee, 'retreated'); this._won(w, S, 'Die Graf Spee flüchtet nach Montevideo – dort sitzt sie in der Falle.', 'Graf Spee in den Río de la Plata getrieben'); return; }
            setObj(w, 'damage', 'failed');
            w.end(false, 'Die Graf Spee hat ihre Verfolger abgeschüttelt und ist in den Atlantik entkommen.');
         },
      },

      // ------------------------------------------------------------ op: Pedestal
      // Escort with three different threats in a row: a submarine ahead of the track, air strikes
      // from Sicily (flown from a carrier far outside the battle that stands in for the airfields)
      // and torpedo boats after dark. Only the tanker counts.
      {
         id: 'pedestal', group: 'ops', name: 'Operation Pedestal', subtitle: 'Straße von Sizilien · 12. August 1942',
         fleet: { own: 'HMS Kenya, HMS Manchester, Ashanti, Pathfinder · Tanker Ohio, 3 Frachter', foe: 'U-Boot Axum · II. Fliegerkorps (Ju 87) · Schnellboote' },
         briefing: 'August 1942: Malta hat noch Treibstoff für wenige Wochen. Vierzehn Frachter und der Tanker Ohio sollen die Insel retten – Sie führen mit dem Kreuzer Kenya das Nahgeleit durch die Enge zwischen Kap Bon und Pantelleria. ' +
            'Dort wartet alles, was die Achse hat: U-Boote vor dem Bug, Stukas und Torpedoflieger aus Sizilien, bei Einbruch der Nacht Schnellboote unter der Küste. ' +
            'Halten Sie sich nahe am Tanker: Ihre Flak deckt ihn, Ihre Wasserbomben (G) vertreiben das U-Boot, Radar und Geschütze fangen die Boote ab. ' +
            'Die Ohio muss den Ausgang im Osten erreichen – geht sie verloren, ist Malta verloren.',
         debrief: 'Am Abend des 12. August torpedierte das italienische U-Boot Axum mit einem Fächer die Kreuzer Nigeria und Cairo und den Tanker Ohio. In der Nacht versenkten Schnellboote vor Kap Bon den Kreuzer Manchester und vier Frachter. ' +
            'Die Ohio wurde danach von Bomben und einem abstürzenden Stuka getroffen und blieb liegen; zwischen zwei Zerstörern vertäut schleppte man sie am 15. August in den Grand Harbour, wo sie nach dem Löschen auf Grund sank. ' +
            'Nur fünf von vierzehn Schiffen kamen an – aber ihr Treibstoff hielt Malta im Krieg.',
         env: { time: 'dusk', weather: 'clear', visibility: 0.8 }, type: 'escort', playableShips: ['Fiji'], recommendedShip: 'Fiji',
         arena: 13000, timeLimit: 12 * 60, stars: 3,
         setup(w, shipKey) {
            islands(w, [
               { c: P(-1500, 11900), r: 2800, height: 260, seed: 1201, lobes: 8, elong: 2.8, rot: 0.04, rough: 0.6, name: 'Kap Bon' },
               { c: P(6200, -6000), r: 950, height: 420, seed: 1203, lobes: 5, elong: 1.3, rot: 0.4, rough: 0.7, name: 'Pantelleria' },
            ]);
            const S = w._script, key = w.difficulty.key;
            S.exit = zone(w, 10900, 1900, 1500, 'Kurs Malta', 'goal');
            const route = [P(-2500, 1500), P(4500, 1700), P(S.exit.x, S.exit.y)];
            const hulls = [['SS Ohio', 4.2], ['MV Melbourne Star', 2.4], ['MV Brisbane Star', 2.4], ['MV Rochester Castle', 2.4]];
            S.convoy = hulls.map(([name, hp], i) => {
               const lane = i % 2 ? 450 : -450;
               return add(w, 'Transport', 'player', P(-8400 - (i >> 1) * 850, 1500 + lane), 0,
                  { name, telegraph: 4, speedKn: 15, hpMult: hp, ai: { route: route.map(p => P(p.x, p.y + lane)), routeIdx: 0, passive: true, convoy: true } });
            });
            S.ohio = S.convoy[0];
            S.freighters = S.convoy.slice(1);
            const me = add(w, shipKey, 'player', P(-7300, 300), 0, { isPlayer: true, name: 'HMS Kenya', telegraph: 3 });
            me.ai.escortId = S.ohio.id;   // only read by the autopilot (tests)
            S.escort = [['Jervis', 'HMS Ashanti', P(-7000, 2600), 0], ['Jervis', 'HMS Pathfinder', P(-10300, 600), 2], ['Fiji', 'HMS Manchester', P(-9900, 2700), 3]]
               .map(([cls, name, pos, t]) => add(w, cls, 'player', pos, 0, { name, dmgMult: 0.3, ai: { escortId: S.convoy[t].id } }));
            // the close escort's flak is thin after two days of raids: the player's umbrella matters
            for (const e of S.escort) for (const b of e.aa.bands) b.dps *= 0.55;
            // II. Fliegerkorps: the Sicilian airfields, played by a carrier parked far to the north
            S.cv = add(w, 'GrafZeppelin', 'enemy', P(-5200, -11800), 0, { name: 'II. Fliegerkorps (Sizilien)', telegraph: 1, speedKn: 3, ai: { passive: true, patrol: [P(-4700, -11800), P(-5700, -11800)] } });
            // an airfield is not a ship: out of sight unless somebody runs right into it
            S.cv.cfg = { ...S.cv.cfg, detect: { ...S.cv.cfg.detect, surface: 2500, fire: 2500 } };
            S.cv.air.ft.max = S.cv.air.ft.hangar = 0;
            S.cv.dmgMult = w.difficulty.botDmg * 0.55;   // scales the bombs and torpedoes of her squadrons
            // Axum waits submerged just off the track
            S.sub = add(w, 'U96', 'enemy', P(-3300, 3300), Math.PI * 0.9, { name: 'Axum', nation: 'it', telegraph: 1, dmgMult: w.difficulty.botDmg * 0.8, ai: { huntId: S.ohio.id } });
            orderDepth(S.sub, 1, w);
            const strike = (type, targetId) => {
               const cv = S.cv, o = S.ohio;
               if (!cv.alive || !o.alive || w.phase !== 'playing') return;
               cv.air.deckT = 0;
               if (canLaunch(w, cv, type)) launchSquadron(w, cv, type, { kind: 'strike', targetId, pos: { x: o.pos.x + 2200, y: o.pos.y } });
            };
            const wave = (t, text, types) => {
               types.forEach(([type, onOhio], i) => later(S, t + i * 7, () => strike(type, onOhio ? S.ohio.id : null)));
               later(S, t + 38, () => { if (S.ohio.alive) radio(w, 'Radar HMS Kenya', text, 'warn'); });
            };
            wave(50, 'Flugzeuge aus Nord, zwanzig Meilen – Stukas! Flak klar, dicht an den Tanker!', [['db', true]]);
            wave(170, 'Zweite Welle: Torpedoflieger tief über dem Wasser, dahinter Stukas!', key === 'easy' ? [['tb', false]] : [['tb', false], ['db', true]]);
            if (key === 'hard') wave(300, 'Noch eine Welle Stukas aus Nord!', [['db', true]]);
            // after dark: fast boats from behind Pantelleria and from under Cape Bon
            later(S, 270, () => {
               if (!S.ohio.alive) return;
               radio(w, 'HMS Ashanti', 'Es wird dunkel. Motorengeräusche an Backbord voraus – Schnellboote!', 'warn');
               const o = S.ohio;
               const boats = [['MS 16', 5200, -5200], ['MS 22', 6000, -4300], ['S 30', 5400, 5600], ['S 36', 6400, 5000], ['MAS 564', 7400, -3200]];
               S.boats = boats.slice(0, key === 'easy' ? 3 : key === 'hard' ? 5 : 4).map(([name, dx, dy]) =>
                  add(w, 'Gnevny', 'enemy', P(Math.min(o.pos.x + dx, 11500), o.pos.y + dy), Math.PI, {
                     name, nation: 'it', telegraph: 4, hpMult: w.difficulty.botHP * 0.36, dmgMult: w.difficulty.botDmg * 0.45,
                     ai: { huntId: o.id, press: true, aggro: 1.6 },
                  }));
            });
            later(S, 3, () => radio(w, 'Konteradmiral Burrough', 'Wir stehen in der Enge. Kenya übernimmt das Nahgeleit der Ohio – ohne den Tanker war alles umsonst.'));
            later(S, 20, () => { if (S.sub.alive) radio(w, 'Asdic HMS Ashanti', 'Kontakt voraus, Peilung Steuerbord 20 – U-Boot auf Sehrohrtiefe! Wasserbomben klar (G).', 'warn'); });
            objective(w, 'ohio', 'Bringen Sie den Tanker Ohio zum Ausgang im Osten (Zustand 100 %)');
            objective(w, 'threats', 'Überstehen Sie U-Boot, Luftangriffe und Schnellboote');
            objective(w, 'half', 'Die Ohio kommt mit mindestens 50 % an', { optional: true });
            objective(w, 'freighters', 'Mindestens 2 der 3 Frachter kommen durch (0 verloren)', { optional: true });
            w.score = { kind: 'convoy', player: 0, enemy: 0, target: 4 };
            S.lost = 0; S.arrived = 0; S.tick = 0;
         },
         update(w, dt, S) {
            if (w.phase !== 'playing') return;
            const o = S.ohio;
            for (const t of S.freighters) {
               if (t.alive && inZone(t, S.exit)) { w.removeShip(t, 'arrived'); S.arrived++; w.score.player = S.arrived; }
            }
            if ((S.tick -= dt) <= 0) {
               S.tick = 1;
               objText(w, 'ohio', `Bringen Sie den Tanker Ohio zum Ausgang im Osten (Zustand ${pct(o.hp / o.maxHP)} %)`);
               if (!S.hit && o.hp < o.maxHP * 0.75) { S.hit = true; radio(w, 'SS Ohio', 'Treffer mittschiffs, Feuer an Deck – wir halten Fahrt!', 'warn'); }
               if (!S.crit && o.hp < o.maxHP * 0.35) { S.crit = true; radio(w, 'SS Ohio', 'Maschine stottert, wir liegen tief im Wasser. Viel halten wir nicht mehr aus!', 'warn'); }
               if (!S.raid && w.squadrons.some(q => q.side === 'enemy' && dist(q.pos, o.pos) < 6000)) S.raid = true;
               if (!S.near && dist(o.pos, S.exit) < 4500) { S.near = true; radio(w, 'Konteradmiral Burrough', 'Die Enge liegt hinter uns – noch wenige Meilen bis in den Schutz der Spitfires von Malta!'); }
            }
            if (o.alive && inZone(o, S.exit)) {
               w.removeShip(o, 'arrived');
               S.arrived++;
               w.score.player = S.arrived;
               setObj(w, 'ohio', 'done', 'Die Ohio hat die Enge passiert');
               setObj(w, 'threats', 'done');
               setObj(w, 'half', o.hp >= o.maxHP * 0.5 ? 'done' : 'failed');
               setObj(w, 'freighters', S.lost <= 1 ? 'done' : 'failed');
               radio(w, 'Malta', 'Tanker in Sicht! Die ganze Insel steht an den Kaimauern.');
               w.end(true, 'Die Ohio läuft nach Malta – der Treibstoff hält die Insel im Krieg.');
            }
         },
         onSink(w, ship, killer, S) {
            if (ship === S.ohio) {
               setObj(w, 'ohio', 'failed');
               w.end(false, 'Die Ohio ist gesunken – ohne ihren Treibstoff kann Malta nicht gehalten werden.');
            } else if (S.freighters.includes(ship)) {
               S.lost++;
               w.score.enemy = S.lost;
               objText(w, 'freighters', `Mindestens 2 der 3 Frachter kommen durch (${S.lost} verloren)`);
               if (S.lost >= 2) setObj(w, 'freighters', 'failed');
               radio(w, 'HMS Pathfinder', `${ship.name} sinkt! Wir nehmen Überlebende auf.`, 'warn');
            } else if (ship === S.sub) radio(w, 'HMS Ashanti', 'Öl und Trümmer an der Oberfläche – das U-Boot ist erledigt!');
            else if (S.boats && S.boats.includes(ship) && S.boats.every(b => !b.alive)) radio(w, 'HMS Manchester', 'Alle Schnellboote vernichtet. Der Weg nach Malta ist frei!');
         },
         timeout(w) {
            setObj(w, 'ohio', 'failed');
            w.end(false, 'Die Ohio liegt bei Tagesanbruch noch in der Enge – die Bomber aus Sizilien finden sie.');
         },
      },

      // ------------------------------------------------------------ op: Juno
      // A stern chase against the clock: the carrier is slow at first and works up to full speed,
      // her destroyers lay smoke across the line of fire and come in with torpedoes, and Swordfish
      // are brought on deck unless the flight deck is wrecked in time.
      {
         id: 'juno', group: 'ops', name: 'Unternehmen Juno', subtitle: 'Nordmeer · 8. Juni 1940',
         fleet: { own: 'Scharnhorst, Gneisenau', foe: 'Flugzeugträger HMS Glorious · Zerstörer Acasta, Ardent' },
         briefing: 'Nordmeer, 8. Juni 1940, klare Sicht: Admiral Marschall stößt mit Scharnhorst und Gneisenau in die britische Räumung Norwegens. Am Nachmittag steigt eine Rauchfahne über die Kimm – ' +
            'der Flugzeugträger Glorious, nur von zwei Zerstörern begleitet, kein Flugzeug in der Luft und nicht alle Kessel unter Dampf. ' +
            'Jede Minute zählt: Der Träger macht Fahrt auf, seine Zerstörer legen Nebel und greifen mit Torpedos an, und an Deck werden Swordfish klargemacht. ' +
            'Zerschlagen Sie das Flugdeck, bevor sie starten, weichen Sie den Torpedos aus und versenken Sie die Glorious, ehe sie nach Südosten entkommt.',
         debrief: 'Die Scharnhorst traf die Glorious mit der dritten Salve auf über 24 Kilometer – einer der weitesten Artillerietreffer der Seekriegsgeschichte. Das Flugdeck war zerstört, kein Flugzeug startete mehr. ' +
            'Ardent und Acasta nebelten den Träger ein und griffen an; beide sanken, doch ein Torpedo der Acasta riss die Scharnhorst am achteren Turm auf und zwang das Geschwader zur Rückkehr nach Trondheim. ' +
            'Glorious sank nach gut einer Stunde. Von über 1.500 Mann der drei britischen Schiffe überlebten nur rund 40.',
         env: { time: 'day', weather: 'clear' }, type: 'historic', playableShips: ['Scharnhorst'], recommendedShip: 'Scharnhorst',
         arena: 15000, timeLimit: 8 * 60, stars: 2,
         setup(w, shipKey) {
            islands(w, []);
            const S = w._script, key = w.difficulty.key;
            S.exit = zone(w, 12300, 6600, 1700, 'Kurs Scapa Flow', 'danger');
            S.deckHP = 0.62;                                   // flight deck wrecked below this
            S.launchAt = key === 'hard' ? 140 : key === 'easy' ? 200 : 165;
            S.glo = add(w, 'ArkRoyal', 'enemy', P(-6600, 1400), 0.27, {
               name: 'HMS Glorious', telegraph: 4, speedKn: 12, hpMult: w.difficulty.botHP * 0.95,
               ai: { passive: true, route: [P(3000, 4000), P(S.exit.x, S.exit.y)], routeIdx: 0 },
            });
            for (const t of ['tb', 'db', 'ft']) S.glo.air[t].max = S.glo.air[t].hangar = t === 'tb' ? 5 : 0;   // five Swordfish aboard
            const me = add(w, shipKey, 'player', P(-4200, -7400), 1.25, { isPlayer: true, telegraph: 4 });
            // only read by the autopilot (tests): cut the corner and run alongside her
            me.ai.huntId = S.glo.id; me.ai.press = true;
            me.ai.route = [P(-1500, 500), P(4500, 2500), P(10500, 4800)]; me.ai.routeIdx = 0;
            S.gnei = add(w, 'Gneisenau', 'player', P(-5100, -8000), 1.25, { name: 'Gneisenau', telegraph: 4, dmgMult: 0.3, ai: { escortIdPlayer: true } });
            S.ardent = add(w, 'Jervis', 'enemy', P(-6000, 300), -1.2, { name: 'HMS Ardent', telegraph: 4, dmgMult: w.difficulty.botDmg * 0.9, ai: { huntId: me.id, press: true } });
            S.acasta = add(w, 'Jervis', 'enemy', P(-6900, 500), 0.27, { name: 'HMS Acasta', telegraph: 4, dmgMult: w.difficulty.botDmg * 0.9, ai: { escortId: S.glo.id } });
            S.dds = [S.ardent, S.acasta];
            S.smokeT = 6; S.tick = 0;
            later(S, 3, () => radio(w, 'Admiral Marschall', 'Flugzeugträger, Peilung Südwest! Feuererlaubnis – jede Salve auf das Flugdeck, bevor er Flugzeuge in die Luft bringt.'));
            later(S, 14, () => radio(w, 'Ausguck', 'Ein Zerstörer nebelt den Träger ein – der andere dreht auf uns zu!', 'warn'));
            later(S, S.launchAt - 45, () => {
               if (S.glo.alive && !S.deck) radio(w, 'B-Dienst', 'Auf der Glorious werden Swordfish an Deck gebracht – das Flugdeck muss weg!', 'warn');
            });
            later(S, S.launchAt, () => this._swordfish(w, S));
            objective(w, 'sink', 'Versenken Sie die Glorious, bevor sie entkommt (Zustand 100 %)');
            objective(w, 'deck', `Zerstören Sie das Flugdeck, bevor Swordfish starten (unter ${pct(S.deckHP)} %)`, { optional: true });
            objective(w, 'dds', 'Versenken Sie beide Zerstörer (0/2)', { optional: true });
            w.score = { kind: 'kills', player: 0, enemy: 0, target: 3 };
         },
         // Swordfish take off while the deck holds; later flights follow every 80 s
         _swordfish(w, S) {
            const g = S.glo, me = w.player;
            if (!g.alive || S.deck || w.phase !== 'playing') return;
            g.air.deckT = 0;
            if (me && me.alive && canLaunch(w, g, 'tb') && launchSquadron(w, g, 'tb', { kind: 'strike', targetId: me.id, pos: { x: me.pos.x, y: me.pos.y } })) {
               if (!S.flown) {
                  S.flown = true;
                  setObj(w, 'deck', 'failed');
                  radio(w, 'Flakleiter', 'Swordfish gestartet! Torpedoflieger im Anflug – Flak frei, hart abdrehen!', 'warn');
               }
            }
            later(S, w.time + 80, () => this._swordfish(w, S));
         },
         _charge(w, S) {
            const a = S.acasta, me = w.player;
            if (S.charge || !a.alive || !me) return;
            S.charge = true;
            a.ai.escortId = null; a.ai.huntId = me.id; a.ai.press = true;
            radio(w, 'Ausguck', 'Der zweite Zerstörer bricht aus dem Nebel – Acasta läuft zum Torpedoangriff an!', 'warn');
         },
         update(w, dt, S) {
            const g = S.glo;
            if (!g.alive || w.phase !== 'playing') return;
            const f = g.hp / g.maxHP;
            // boilers coming on line: 10 kn at first sight, 23 kn seven minutes later
            const top = S.boiler ? 15 : 23;
            g.maxSpeedKn = Math.min(top, 10 + Math.max(0, w.time - 20) / 400 * 13);
            if (!S.deck && !S.flown && f < S.deckHP) {
               S.deck = true;
               setObj(w, 'deck', 'done', 'Flugdeck der Glorious zerstört');
               radio(w, 'Artillerieoffizier', 'Treffer im Flugdeck! Hangar brennt – von dort startet nichts mehr.');
            }
            if (!S.boiler && f < 0.35) {
               S.boiler = true;
               radio(w, 'Ausguck', 'Glorious verliert Fahrt und krängt – Treffer im Kesselraum!');
            }
            // smoke: the Acasta screens the carrier until she turns to attack
            if ((S.smokeT -= dt) <= 0) {
               S.smokeT = 4;
               if (S.acasta.alive && !S.charge && g.detected) S.acasta.useConsumable(w, 'smoke');
            }
            if (!S.charge && (w.time > 150 || !S.ardent.alive)) {
               if (S.chargeAt == null) S.chargeAt = w.time + (S.ardent.alive ? 0 : 15);
               if (w.time >= S.chargeAt) this._charge(w, S);
            }
            if ((S.tick -= dt) <= 0) {
               S.tick = 1;
               const km = Math.max(0, (dist(g.pos, S.exit) - S.exit.r) / 1000).toFixed(1).replace('.', ',');
               objText(w, 'sink', `Versenken Sie die Glorious, bevor sie entkommt (Zustand ${pct(f)} %, noch ${km} km)`);
               if (!S.near && dist(g.pos, S.exit) < 6000) { S.near = true; radio(w, 'Admiral Marschall', 'Sie läuft uns davon! Alles, was die Rohre hergeben!', 'warn'); }
            }
            if (inZone(g, S.exit)) {
               w.removeShip(g, 'escaped');
               setObj(w, 'sink', 'failed');
               w.end(false, 'Die Glorious ist entkommen – ihr Notruf holt die Home Fleet heran.');
            }
         },
         onSink(w, ship, killer, S) {
            if (S.dds.includes(ship)) {
               const n = S.dds.filter(d => !d.alive).length;
               w.score.player = n + (S.glo.alive ? 0 : 1);
               objText(w, 'dds', `Versenken Sie beide Zerstörer (${n}/2)`);
               if (n >= 2) setObj(w, 'dds', 'done');
               else if (ship === S.ardent) radio(w, 'Ausguck', 'Ardent kentert! Die Acasta steht noch im Nebel beim Träger.');
            } else if (ship === S.glo) {
               w.score.player = S.dds.filter(d => !d.alive).length + 1;
               setObj(w, 'sink', 'done', 'Glorious versenkt');
               if (!S.flown) setObj(w, 'deck', 'done');
               radio(w, 'Admiral Marschall', 'Der Träger kentert. An alle: Gut gemacht – Kurs Trondheim.');
               w.end(true, 'Die Glorious ist versenkt – der einzige Flugzeugträger, der je der Artillerie von Schlachtschiffen zum Opfer fiel.');
            }
         },
         timeout(w) {
            setObj(w, 'sink', 'failed');
            w.end(false, 'Die Glorious ist entkommen – ihr Notruf holt die Home Fleet heran.');
         },
      },
   ];
}
