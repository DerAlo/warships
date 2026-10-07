// gamev2/missions_special_b.js — special operations of the modern mode, second set (fictional
// present-day scenarios):
//    hijack     Golf von Aden – Entführt: stop a hijacked gas tanker by boarding it alongside; it must
//               not take heavy hits (it explodes, blast.js)
//    evac       Evakuierung: hold a station off the pier of a harbour town, slow, while boats bring people
//               out in lifts with a time window each; then escort the ferry with the rest out past the mole
//    bastion    Arktis – Bastion: find a ballistic-missile submarine in its guarded patrol area, shadow it from astern
//               without being located (detection meter), then leave; weapons stay locked unless the mission releases them
// Each definition has the shape of missions.js DEFS; H = missionHelpers. Everything a mission keeps
// between ticks lives in world._script (S) as plain data and refers to ships by id (co-op swaps bot
// hulls for human captains after setup, world.replaceShip keeps the id).
// Convention of the mission files: merchant ships are protected, never targets. The hijacked tanker
// sails on the opposing side (the hijackers steer it) but carries `noTarget`, so no AI ever fires at
// it; only a human captain can hit it, and the mission tells him what happens then.
// Balance: SPECIAL_B_TUNE holds the knobs per mission and difficulty (tests/v2.missions.specialb.test.mjs
// measures them with the bot captain of tests/v2.missions.specialb.captain.mjs).
import { addSite } from './sites.js';
import { addBlast } from './blast.js';
import { obstacleRadiusAt, obstacleT } from './utils.js';

export const SPECIAL_B_TUNE = {
   hijack: {
      // kn: speed of the tanker (its arrival is the clock) · boats: boats that come out at the captains ·
      // msl: how many of them carry Kowsar missiles (the others, the guard and the wave: rockets and guns) ·
      // guard: boats that stay at the tanker · wave/waveAt: second pack from the coast · boom: share of the
      // tanker's hull that may be lost before it explodes · board: s alongside · batN/batAt: missiles of the
      // shore battery and the tanker's distance to the anchorage (m) at which it opens fire
      easy: { ally: 0.6, kn: 12.5, boats: 4, msl: 1, guard: 1, wave: 2, waveAt: 300, boom: 0.45, board: 15, batN: 4, batAt: 6500 },
      normal: { ally: 0.4, kn: 14, boats: 11, msl: 11, guard: 3, wave: 3, waveAt: 250, boom: 0.35, board: 45, batN: 8, batAt: 8500 },
      hard: { ally: 0.3, kn: 15.5, boats: 10, msl: 8, guard: 3, wave: 4, waveAt: 200, boom: 0.25, board: 47, batN: 12, batAt: 10500 },
   },
   evac: {
      // lifts: boat lifts to take aboard · miss: lifts that may be missed · first: s until the first window opens ·
      // win: s a window stays open · load: s on station a lift takes · gap: s between two windows · waves: boats that
      // come down the coast when lift 1, 2, 3 opens · fin: boats that go for the ferry when it casts off · msl: how many
      // boats of each pack carry Kowsar missiles · batN / batSalvo / batInt: the shore battery (missiles, per salvo,
      // s between salvos) · batAt: lift at whose opening it goes live · ferry: hull factor of the ferry
      easy: { ally: 0.6, lifts: 3, miss: 1, first: 70, win: 95, load: 35, gap: 25, waves: [1, 2, 2], fin: 2, msl: 0, batN: 4, batSalvo: 1, batInt: 40, batAt: 2, ferry: 1.3 },
      normal: { ally: 0.4, lifts: 3, miss: 1, first: 65, win: 80, load: 45, gap: 25, waves: [2, 3, 4], fin: 4, msl: 1, batN: 8, batSalvo: 2, batInt: 32, batAt: 2, ferry: 0.93 },
      hard: { ally: 0.3, lifts: 3, miss: 0, first: 65, win: 90, load: 45, gap: 20, waves: [2, 3, 4], fin: 4, msl: 1, batN: 12, batSalvo: 2, batInt: 26, batAt: 2, ferry: 1.04 },
   },
   bastion: {
      // trail: s to hold the trailing position · kn: speed of the missile boat · held / seen: % per s the meter rises while
      // a sonar holds the boat / while it is sighted · caught: % per s while she hears it during a check astern · noise: %
      // per s for running loud near a listener · cool: % per s it falls when nothing hears (slow: mistakes add up) ·
      // listen / listenFor: s between two checks astern and their length · warn: s the sonar team announces a check
      // ahead · frig: speed of the frigates (kn) · guard: a hunter boat patrols before the way out · hunt: share of the
      // trail at which the hunter picks up the trail and weapons are released against it (0 = never)
      easy: { trail: 60, kn: 6, held: 5, caught: 8, seen: 9, noise: 1.5, cool: 1, listen: 70, listenFor: 12, warn: 8, frig: 10, guard: 0, hunt: 0 },
      normal: { trail: 80, kn: 6, held: 8, caught: 15, seen: 14, noise: 2.5, cool: 0.5, listen: 40, listenFor: 16, warn: 5, frig: 12, guard: 1, hunt: 0 },
      hard: { trail: 100, kn: 6, held: 11, caught: 16, seen: 18, noise: 3.5, cool: 0.4, listen: 40, listenFor: 18, warn: 5, frig: 14, guard: 1, hunt: 0.5 },
   },
};
// Shadowing (bastion): the trailing position lies min..max m from the missile boat inside arc rad either side of dead
// astern (its own sonar is deaf there). Its sonar reaches bow m ahead and abeam and aft m astern, scaled with the
// shadower's noise; while it checks astern the blind arc is gone and only a boat at telegraph 1/4 or less stays unheard.
// hear: m at which the sonar team classifies it. The speed rules follow the telegraph, so they read the same in both
// boats (share of the boat's top speed submerged): creep = up to 1/4, fast = more than 1/2, both also at periscope depth, where a boat runs faster (loud near a listener, near m).
export const TRAIL = { min: 1200, max: 2800, arc: 50 * Math.PI / 180, bow: 3600, aft: 700, creep: 0.33, hear: 5000, fast: 0.62, near: 6500, frig: 3000, sub: 2200 };
// why the detection meter rises, as shown in the objective
const WHY = { listen: 'sie horcht, Sie sind zu schnell', close: 'zu dicht am Heck', bow: 'vor ihrem Sonar, nicht achteraus', fast: 'zu schnell im Kielwasser',
   held: 'ein Wachschiff hört Sie', ping: 'das Jagd-U-Boot hält Sie im Sonar', seen: 'Sehrohr gesichtet', noise: 'zu laut nahe der Wachschiffe' };
// Evacuation (evac): a lift is loaded while a captain's ship lies inside the pickup zone (r m) at no more
// than slowKn kn and no armed boat stands within clear m of it; people per lift, people the ferry takes.
export const EVAC = { r: 800, slowKn: 6, clear: 1500, people: 40, ferry: 320 };
// Boarding alongside (hijack): within NEAR m of the tanker, speed within DV kn of its own, no armed
// boat within CLEAR m of it. The tanker's blast when it is hit too hard.
export const BOARD = { near: 500, dv: 5, clear: 1500, hint: 3000 };
const GAS_R = { destroyed: 600, heavy: 1300, shock: 2400 };

export function specialMissionsB(H) {
   const { P, add, objective, setObj, objText, later, radio, zone, inZone, islands, SHIPS } = H;
   const tune = (w, id) => { const T = SPECIAL_B_TUNE[id]; return T[w.difficultyKey] || T.normal; };
   const human = (s) => !!(s && (s.isPlayer || s.human));
   // co-op: human captains beyond the first (world.net is set after setup, so ask at the event, not in setup)
   const noMsl = (b) => { b.mag.kowsar = 0; return b; };
   const extraCaptains = (w) => Math.max(0, (w.net && w.net.humans ? w.net.humans.length : 1) - 1);
   const live = (w, id) => { const s = w.shipById(id); return s && s.alive ? s : null; };
   const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
   const mmss = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
   const lim = (w) => ` (Zeitlimit ${mmss((defs.find(d => d.id === w.mission.id) || {}).timeLimit || 0)})`;
   const KN = 2.6;      // config WORLD.KN_TO_MS
   // radio line that may come back, at most every `gap` seconds (key: a field of S)
   function nag(w, S, key, gap, from, text, level) {
      if (w.time < (S[key] || 0)) return;
      S[key] = w.time + gap;
      radio(w, from, text, level);
   }

   const defs = [
      // --------------------------------------------------------------------- Golf von Aden – Entführt
      {
         id: 'hijack', group: 'ops', name: 'Golf von Aden – Entführt', subtitle: 'Sondereinsatz · Gastanker längsseits entern',
         briefing: 'Bewaffnete haben den Flüssiggastanker LNG Castor gekapert und laufen mit ihm auf die Küste von Ras Dhahab zu. ' +
            'Ein Rudel bewaffneter Schnellboote deckt ihn, vor dem Ankerplatz steht eine Küstenbatterie. Erreicht der Tanker ' +
            'die Hoheitsgewässer, ist die Besatzung verloren. Stoppen Sie ihn vorher: Schlagen Sie die Boote mit dem Geschütz ' +
            'zurück, gehen Sie dann längsseits – näher als 500 m, Fahrt an den Tanker angeglichen – und halten Sie die Position, ' +
            'bis das Enterkommando übergesetzt hat. ACHTUNG: Der Tanker ist voll beladen. Keine Flugkörper und keine Torpedos ' +
            'in seiner Nähe, kein Geschützfeuer auf seinen Rumpf – nach wenigen schweren Treffern explodiert er und reißt ' +
            'alles im Umkreis von zwei Kilometern mit.',
         debrief: 'Das Enterkommando hat die Brücke genommen, die Besatzung der LNG Castor ist frei und unverletzt. ' +
            'Der Tanker läuft unter Geleit zurück in den Golf.',
         fleet: { own: 'Flaggschiff, 1 Korvette', foe: 'Schnellbootrudel, 1 Küstenbatterie' },
         env: { time: 'dusk', weather: 'clear' }, type: 'ops', playableShips: ['Sachsen', 'Braunschweig', 'Burke', 'Daring'],
         recommendedShip: 'Sachsen', arena: 20000, timeLimit: 720, stars: 2,
         setup(w, shipKey) {
            const S = w._script; S.shipKey = shipKey; const T = tune(w, 'hijack');
            islands(w, [
               { c: P(15500, 11500), r: 3200, height: 300, seed: 83, lobes: 6, elong: 2.4, rot: -0.75, rough: 0.6, name: 'Ras Dhahab' },
               { c: P(-13500, -13000), r: 900, height: 110, seed: 87, lobes: 4, rough: 0.5 },
            ]);
            const flag = add(w, shipKey, 'player', P(-3500, 10500), -Math.PI / 2, { isPlayer: true });
            const corv = add(w, shipKey === 'Braunschweig' ? 'Sachsen' : 'Braunschweig', 'player', P(-5600, 11400), -Math.PI / 2,
               { name: shipKey === 'Braunschweig' ? 'Hessen' : 'Magdeburg', dmgMult: T.ally, telegraph: 3, ai: { escortId: flag.id } });
            S.own = [flag.id, corv.id];
            // the tanker: steered by the hijackers along its route to the anchorage, never a target for any AI
            S.goal = zone(w, 8800, 5200, 1700, 'Hoheitsgewässer', 'danger');
            const start = P(-9500, -6500), mid = P(-500, -1500);
            const tk = add(w, 'LNG', 'enemy', start, Math.atan2(mid.y - start.y, mid.x - start.x),
               { name: 'LNG Castor', speedKn: T.kn, hpMult: 1, telegraph: 4, ai: { passive: true, convoy: true, route: [mid, P(S.goal.x, S.goal.y)] } });
            tk.noTarget = true;
            S.tankId = tk.id; S.tankHP = tk.maxHP; S.kn = T.kn;
            S.board = 0; S.shown = -1; S.dmgShown = 0; S.phase = 0; S.sunk = 0;
            // the pack: `boats` come out at the captains once they close in, `guard` stay at the tanker
            S.boats = []; S.guards = []; S.msl = T.msl;      // only `msl` boats of the pack carry anti-ship missiles
            const hdg = tk.heading, c = Math.cos(hdg), s = Math.sin(hdg);
            for (let i = 0; i < T.boats + T.guard; i++) {
               const guard = i < T.guard, f = guard ? 250 - i * 350 : 900 - (i - T.guard) * 300, r = (i % 2 ? 1 : -1) * (guard ? 320 : 650 + i * 60);
               const b = add(w, 'Boghammar', 'enemy', P(start.x + f * c - r * s, start.y + f * s + r * c), hdg, { telegraph: 2, ai: { escortId: tk.id } });
               if (guard || S.msl-- <= 0) b.mag.kowsar = 0;
               (guard ? S.guards : S.boats).push(b.id);
            }
            S.total = T.boats + T.guard;
            // the shore battery: silent and not located until the tanker comes near the anchorage
            const isl = w.obstacles[0], a = Math.atan2(S.goal.y - isl.c.y, S.goal.x - isl.c.x);
            S.batId = addSite(w, 'battery', 'enemy', P(isl.c.x + Math.cos(a) * 1500, isl.c.y + Math.sin(a) * 1500),
               { name: 'Küstenbatterie Ras Dhahab', hidden: true, radarOn: false, delay: 1e9, ssm: { type: 'noor', n: T.batN } }).id;
            objective(w, 'board', `Entern Sie die LNG Castor, bevor sie die Hoheitsgewässer erreicht: längsseits unter ${BOARD.near} m, Fahrt angleichen, ${T.board} s halten` + lim(w));
            objective(w, 'gas', `Der Tanker darf nicht explodieren: keine Flugkörper, kein Feuer auf den Rumpf (Schaden 0 % – Explosion ab ${Math.round(T.boom * 100)} %)`);
            objective(w, 'boats', `Versenken Sie alle Schnellboote (0/${S.total})`, { optional: true });
            objective(w, 'clean', 'Kein einziger Treffer auf dem Tanker', { optional: true });
            w._script.onBlast = (ww, b) => { if (b.id === S.boomId) { setObj(ww, 'gas', 'failed'); ww.end(false, 'Die LNG Castor ist explodiert – die Besatzung konnte nicht gerettet werden.'); } };
            later(S, 4, () => radio(w, 'Flottenkommando', `Die LNG Castor läuft mit ${String(T.kn).replace('.', ',')} Knoten auf Ras Dhahab zu und erreicht die Hoheitsgewässer in etwa ${Math.round(S.eta / 60)} Minuten. Danach können wir nichts mehr tun. Schneiden Sie ihr den Weg ab.`));
            later(S, 13, () => radio(w, 'Flottenkommando', `Waffenbeschränkung: Der Tanker ist voll beladen. Keine Flugkörper, keine Torpedos, kein Geschützfeuer auf seinen Rumpf – ab ${Math.round(T.boom * 100)} % Schaden explodiert er und zerstört alles im Umkreis von zwei Kilometern. Die Schnellboote bekämpfen Sie mit dem Geschütz.`, 'warn'));
            later(S, 24, () => radio(w, 'Enterkommando', `Wir stehen bereit. Bringen Sie uns längsseits: näher als ${BOARD.near} m, Fahrt wie der Tanker. Solange Boote am Tanker stehen, können wir nicht übersetzen.`));
            later(S, T.waveAt, () => {
               const t = live(w, S.tankId);
               if (!t || S.phase >= 2) return;
               const n = T.wave + extraCaptains(w) * 2, made = [];
               for (let i = 0; i < n; i++) made.push(noMsl(add(w, 'Boghammar', 'enemy', P(S.goal.x + 1500 + (i % 2) * 500, S.goal.y - 1200 + i * 450), Math.PI, { minDist: 5000, telegraph: 4, ai: { huntId: S.own[i % S.own.length], press: true } })).id);
               S.boats.push(...made); S.total += n;
               objText(w, 'boats', `Versenken Sie alle Schnellboote (${S.sunk}/${S.total})`);
               radio(w, 'Lagezentrum', `${n} weitere Schnellboote laufen von der Küste aus, dem Tanker entgegen.`, 'warn');
            });
            // arrival of the tanker, measured along its route (the radio and the objective name it)
            S.eta = (dist(start, mid) + dist(mid, S.goal) - S.goal.r) / (T.kn * KN);
         },
         // co-op: the flagship must survive and two ships draw the pack, so one boat less carries missiles
         coop(w, S, humans) {
            if (humans.length < 2) return;
            for (let i = S.boats.length - 1; i >= 0; i--) { const b = live(w, S.boats[i]); if (b && b.mag.kowsar) { b.mag.kowsar = 0; break; } }
         },
         update(w, dt, S) {
            const t = live(w, S.tankId), T = tune(w, 'hijack');
            if (!t || S.phase >= 2) return;
            t.noTarget = true;
            // the rule of the mission: damage on the tanker (fires are put out by its crew, so only hits count)
            if (t.fires.length) t.fires.length = 0;
            if (t.floods.length) t.floods.length = 0;
            const lost = 1 - t.hp / S.tankHP;
            if (lost > S.dmgShown + 0.005) {
               const first = S.dmgShown === 0, pct = Math.round(lost * 100), max = Math.round(T.boom * 100);
               S.dmgShown = lost;
               setObj(w, 'clean', 'failed');
               objText(w, 'gas', `Der Tanker darf nicht explodieren: keine Flugkörper, kein Feuer auf den Rumpf (Schaden ${pct} % – Explosion ab ${max} %)`);
               if (lost >= T.boom) {
                  S.phase = 2;
                  S.boomId = addBlast(w, { x: t.pos.x, y: t.pos.y, r: GAS_R, delay: 2.5, label: 'Gastanker explodiert' }).id;
                  radio(w, 'Enterkommando', 'Die Tanks sind aufgerissen – Gas tritt aus, der Tanker geht hoch!', 'warn');
                  return;
               }
               if (first) radio(w, 'Flottenkommando', `Treffer auf dem Tanker! Feuer einstellen – Schaden ${pct} %, ab ${max} % explodiert er.`, 'warn');
               else if (lost >= T.boom * 0.6) nag(w, S, 'nagDmg', 8, 'Flottenkommando', `Letzte Warnung: Tankerschaden ${pct} %, Explosion ab ${max} %. Kein Schuss mehr in seine Richtung!`, 'warn');
            }
            if (inZone(t, S.goal)) { S.phase = 2; setObj(w, 'board', 'failed'); w.end(false, 'Die LNG Castor hat die Hoheitsgewässer erreicht – die Entführer sind mit Schiff und Besatzung entkommen.'); return; }
            // who is where: the nearest human captain to the tanker, boats at the tanker
            let near = null, nd = Infinity, boatsAt = 0;
            for (const s of w.ships) {
               if (!s.alive) continue;
               const d = dist(s.pos, t.pos);
               if (s.side === 'player') { if (human(s) && !s.sub && d < nd) { nd = d; near = s; } }
               else if (s !== t && d < BOARD.clear) boatsAt++;
            }
            // the pack comes out when a captain closes in
            if (S.phase === 0 && nd < 7500) {
               S.phase = 1;
               let k = 0;
               for (const id of S.boats) { const b = live(w, id); if (b) { b.ai.escortId = null; b.ai.huntId = S.own[k++ % S.own.length]; b.ai.press = true; b.setTelegraph(4); } }
               radio(w, 'Lagezentrum', `Die Schnellboote lösen sich vom Tanker und laufen Sie an – ${S.guards.length} bleiben als Wache bei ihm. Geschütz frei auf die Boote, aber achten Sie auf Ihr Schussfeld: Der Tanker steht dahinter.`, 'warn');
            }
            // the shore battery covers the last miles
            if (!S.batOn && dist(t.pos, S.goal) < T.batAt) {
               S.batOn = true;
               const b = w.sites.find(x => x.id === S.batId);
               if (b && b.alive) {
                  b.radarOn = true; b.detected = b.targetable = true; b.nextT = 12;
                  radio(w, 'Luftlage', 'Die Küstenbatterie von Ras Dhahab geht auf Sendung – der Tanker ist in ihrer Deckung. Rechnen Sie mit Flugkörpern von Land: Abwehr frei, Täuschkörper bereit.', 'warn');
               }
            }
            for (const k of [120, 60]) {
               const left = (dist(t.pos, S.goal) - S.goal.r) / Math.max(1, t.speed);
               if (left <= k && (S.etaSaid || 999) > k) { S.etaSaid = k; radio(w, 'Lagezentrum', `Der Tanker erreicht die Hoheitsgewässer in ${k === 120 ? 'zwei Minuten' : 'einer Minute'} – entern Sie jetzt!`, 'warn'); }
            }
            // boarding alongside
            if (!near || nd > BOARD.hint) { if (S.board > 0) S.board = Math.max(0, S.board - dt * 0.5); }
            else {
               if (!S.hinted) { S.hinted = true; radio(w, 'Enterkommando', `Tanker voraus. Gehen Sie auf unter ${BOARD.near} m heran und gleichen Sie die Fahrt an – er läuft ${String(S.kn).replace('.', ',')} Knoten. Der Fortschritt steht im Auftrag.`); }
               const dv = Math.abs(near.speed - t.speed) / KN;
               if (nd > BOARD.near) { S.board = Math.max(0, S.board - dt * 0.5); if (nd < 1200 && !boatsAt) nag(w, S, 'nagFar', 20, 'Enterkommando', `Noch ${Math.round(nd)} m – wir brauchen unter ${BOARD.near} m.`); }
               else if (boatsAt) nag(w, S, 'nagBoats', 15, 'Enterkommando', `Wir können nicht übersetzen: ${boatsAt === 1 ? 'Ein Wachboot steht' : boatsAt + ' Boote stehen'} noch am Tanker. Versenken Sie ${boatsAt === 1 ? 'es' : 'sie'} mit dem Geschütz – vorsichtig!`, 'warn');
               else if (dv > BOARD.dv) nag(w, S, 'nagDv', 12, 'Enterkommando', near.speed > t.speed ? 'Zu schnell – nehmen Sie Fahrt weg, wir kommen so nicht hinüber.' : 'Zu langsam – der Tanker läuft uns davon, mehr Fahrt!');
               else {
                  if (S.board === 0) radio(w, 'Enterkommando', `Längsseits. Wir setzen über – halten Sie Abstand und Fahrt ${T.board} Sekunden.`);
                  S.board += dt;
               }
            }
            const sec = Math.floor(S.board);
            if (sec !== S.shown) {
               S.shown = sec;
               objText(w, 'board', `Entern Sie die LNG Castor, bevor sie die Hoheitsgewässer erreicht: längsseits unter ${BOARD.near} m, Fahrt angleichen (${Math.min(sec, T.board)}/${T.board} s)` + lim(w));
            }
            if (S.board >= T.board) {
               S.phase = 2;
               t.ai.anchored = true; t.setTelegraph(0);
               setObj(w, 'board', 'done'); setObj(w, 'gas', 'done');
               if (S.dmgShown === 0) setObj(w, 'clean', 'done');
               if (S.sunk >= S.total) setObj(w, 'boats', 'done');
               radio(w, 'Enterkommando', 'Brücke genommen, Maschine gestoppt. Die Besatzung ist frei – niemand verletzt.');
               w.end(true, 'Die LNG Castor ist geentert, die Besatzung ist frei.');
            }
         },
         onSiteDestroyed(w, site, by, S) { if (site.id === S.batId) radio(w, 'Lagezentrum', 'Die Küstenbatterie ist ausgeschaltet.'); },
         onSink(w, ship, killer, S) {
            if (ship.id === S.tankId) { if (!S.boomId) { S.phase = 2; setObj(w, 'gas', 'failed'); w.end(false, 'Die LNG Castor ist gesunken – die Besatzung konnte nicht gerettet werden.'); } return; }
            if (ship.side === 'player') {
               if (!w.ships.some(s => s.alive && s.side === 'player' && human(s) && !s.sub)) w.end(false, 'Ihr Schiff ist verloren – niemand kann das Enterkommando mehr an den Tanker bringen.');
               return;
            }
            S.sunk++;
            objText(w, 'boats', `Versenken Sie alle Schnellboote (${S.sunk}/${S.total})`);
            if (S.sunk >= S.total && w.time > tune(w, 'hijack').waveAt) setObj(w, 'boats', 'done');
         },
         timeout(w) { w.end(false, 'Die Zeit ist abgelaufen – die LNG Castor ist in den Hoheitsgewässern verschwunden.'); },
      },
      // --------------------------------------------------------------------- Evakuierung
      // The rule: people come aboard only while a captain's ship lies in the pickup zone off the pier, slow,
      // and no armed boat is near. Every lift has a window; a window that closes before the lift is aboard is a
      // missed lift. S.stage: 0 waiting for the next window, 1 window open, 2 the ferry is under way, 3 over.
      {
         id: 'evac', group: 'ops', name: 'Evakuierung', subtitle: 'Sondereinsatz · Station halten am Pier, Fähre hinausgeleiten',
         briefing: 'Die Hafenstadt Porto Calvera liegt unter Beschuss aus dem Hinterland, am Pier warten Hunderte Zivilisten. ' +
            'Beiboote bringen sie in drei Transporten zu Ihnen hinaus – aber nur, solange Ihr Schiff in der Aufnahmezone vor dem Pier liegt, ' +
            'höchstens 6 Knoten läuft und kein bewaffnetes Boot in der Nähe steht. Jeder Transport hat ein Zeitfenster: Ist es zu, bevor alle an Bord sind, ' +
            'gilt er als verpasst. Zwischen den Transporten greifen Schnellboote entlang der Küste an, eine Küstenbatterie im Hinterland schießt Flugkörper ' +
            'auf alles, was am Pier liegt – wehren Sie sie ab oder schalten Sie die Stellung aus. Die Übrigen nimmt die Fähre Calvera Star auf: ' +
            'Geleiten Sie sie zuletzt an der Mole vorbei auf die offene See. Verloren ist der Einsatz, wenn zu viele Transporte verpasst werden, ' +
            'die Fähre sinkt oder Ihr Schiff verloren geht.',
         debrief: 'Die Calvera Star hat die offene See erreicht, die Menschen von Porto Calvera sind in Sicherheit. ' +
            'Entschieden hat die Geduld auf Station: stillliegen, während ringsum geschossen wird.',
         fleet: { own: 'Flaggschiff, 1 Korvette · Fähre Calvera Star (zu schützen)', foe: 'Schnellbootrudel, 1 Küstenbatterie' },
         env: { time: 'dusk', weather: 'overcast' }, type: 'ops', playableShips: ['Sachsen', 'Braunschweig', 'Burke', 'Daring'],
         recommendedShip: 'Sachsen', arena: 14000, timeLimit: 720, stars: 2,
         setup(w, shipKey) {
            const S = w._script, T = tune(w, 'evac');
            islands(w, [{ c: P(12200, 0), r: 3600, height: 420, seed: 131, lobes: 6, elong: 2, rot: Math.PI / 2, rough: 0.5, name: 'Porto Calvera' }]);
            const isl = w.obstacles[0], cx = isl.c.x - obstacleRadiusAt(isl, Math.PI);      // the coast west of the town
            // (sim y grows south.) The coast is not straight: the mole and the ferry's berth are measured from the coast at their own y
            const coastX = (y) => { const q = P(isl.c.x, y); while (obstacleT(isl, q) < 1) q.x -= 20; return q.x; };
            islands(w, [{ c: P(coastX(-2900) - 320, -2900), r: 380, height: 14, seed: 137, lobes: 3, elong: 3, rot: 0, rough: 0.2, name: 'Mole' }]);
            S.zone = zone(w, cx - 1500, 0, EVAC.r, 'Aufnahmezone');
            S.exit = zone(w, cx - 8200, -2600, 1300, 'Offene See');
            const flag = add(w, shipKey, 'player', P(cx - 6200, 1500), 0, { isPlayer: true, telegraph: 3 });
            const corv = add(w, shipKey === 'Braunschweig' ? 'Sachsen' : 'Braunschweig', 'player', P(cx - 7000, 2600), 0,
               { name: shipKey === 'Braunschweig' ? 'Hessen' : 'Magdeburg', dmgMult: T.ally, telegraph: 3 });
            const ferry = add(w, 'Container', 'player', P(cx - 650, 900), Math.PI, { name: 'Calvera Star', speedKn: 17, hpMult: T.ferry, telegraph: 0, ai: { passive: true, anchored: true } });
            // her berth: bow to the sea, 450 m off the pier just south of the pickup zone (add() keeps ships a kilometre off a coast)
            ferry.pos.y = 1150; ferry.pos.x = coastX(1150) - 450;
            corv.ai.escortId = ferry.id;
            S.own = [flag.id, corv.id]; S.ferryId = ferry.id; S.ferryHP = ferry.maxHP;
            S.route = [P(cx - 3600, -700), P(S.exit.x, S.exit.y)];
            S.stage = 0; S.lift = 0; S.nextAt = T.first; S.winEnd = 0; S.load = 0; S.done = 0; S.missed = 0; S.aboard = 0; S.shown = '';
            S.boats = []; S.sunk = 0; S.total = 0; S.hurt = false;
            // the shore battery up the coast: silent and not located until its lift
            S.batId = addSite(w, 'battery', 'enemy', P(isl.c.x - 300, isl.c.y + 520),      // sites.js moves it out to the south-western coast
               { name: 'Küstenbatterie Calvera', hidden: true, radarOn: false, delay: 1e9, salvo: T.batSalvo, interval: T.batInt, ssm: { type: 'noor', n: T.batN } }).id;
            objective(w, 'lifts', this.liftText(w, S, T));
            objective(w, 'ferry', 'Geleiten Sie die Fähre Calvera Star an der Mole vorbei auf die offene See – sie darf nicht sinken');
            objective(w, 'all', 'Kein Transport wird verpasst', { optional: true });
            objective(w, 'hull', 'Die Fähre verliert höchstens ein Fünftel ihres Rumpfes', { optional: true });
            w.score = { kind: 'count', player: 0, enemy: 0, target: T.lifts * EVAC.people + EVAC.ferry };
            later(S, 4, () => radio(w, 'Flottenkommando', `Porto Calvera wird geräumt. Laufen Sie in die Aufnahmezone vor dem Pier: Der erste von ${T.lifts} Transporten legt in ${Math.round((T.first - 4) / 10) * 10} Sekunden ab.`));
            later(S, 14, () => radio(w, 'Hafenkapitän', `Die Boote kommen nur zu Ihnen, wenn Sie in der Zone liegen und höchstens ${EVAC.slowKn} Knoten laufen. Jedes Fenster bleibt ${T.win} Sekunden offen, ein Transport braucht ${T.load}. ${T.miss ? 'Mehr als einen Transport dürfen wir nicht verpassen' : 'Wir dürfen keinen einzigen Transport verpassen'} – und die Fähre darf nicht sinken.`, 'warn'));
         },
         liftText(w, S, T) {
            const n = Math.min(T.lifts, S.lift + (S.stage === 1 ? 0 : 1)), left = S.stage === 1 ? Math.max(0, S.winEnd - w.time) : Math.max(0, S.nextAt - w.time);
            const head = S.stage === 1 ? `Transport ${n}/${T.lifts}: ${Math.min(EVAC.people, Math.floor(S.load / T.load * EVAC.people))}/${EVAC.people} an Bord, Fenster noch ${mmss(left)}`
               : S.stage === 0 ? `Transport ${n}/${T.lifts} legt in ${mmss(left)} ab` : `${S.done}/${T.lifts} Transporte an Bord`;
            return `Nehmen Sie die Transporte auf: in der Aufnahmezone, höchstens ${EVAC.slowKn} kn – ${head} · verpasst ${S.missed} (erlaubt ${T.miss})` + lim(w);
         },
         // a pack of boats down the coast, alternately from the north and the south, at the ferry
         wave(w, S, n, T, text) {
            n += extraCaptains(w);
            const side = (S.waveN = (S.waveN || 0) + 1) % 2 ? 1 : -1;
            for (let i = 0; i < n; i++) {
               const b = add(w, 'Boghammar', 'enemy', P(S.zone.x - 1800 - i * 450, side * (10800 + (i % 2) * 500)), -side * Math.PI / 2,
                  { minDist: 6500, telegraph: 4, ai: { huntId: i % 2 ? S.own[0] : S.ferryId, press: true } });
               if (i >= T.msl) b.mag.kowsar = 0;
               S.boats.push(b.id);
            }
            S.total += n;
            radio(w, 'Lagezentrum', `${n === 1 ? 'Ein Schnellboot läuft' : n + ' Schnellboote laufen'} von ${side > 0 ? 'Süden' : 'Norden'} die Küste herunter${text || ''}.`, 'warn');
         },
         update(w, dt, S) {
            if (S.stage >= 3) return;
            const T = tune(w, 'evac'), f = live(w, S.ferryId);
            if (!f) return;
            if (!S.hurt && f.hp < S.ferryHP * 0.8) { S.hurt = true; setObj(w, 'hull', 'failed'); radio(w, 'Calvera Star', 'Wir nehmen Treffer! Halten Sie uns die Boote und die Flugkörper vom Leib.', 'warn'); }
            if (S.stage === 2) {
               if (inZone(f, S.exit)) {
                  S.stage = 3;
                  setObj(w, 'ferry', 'done');
                  if (!S.missed) setObj(w, 'all', 'done');
                  if (!S.hurt) setObj(w, 'hull', 'done');
                  radio(w, 'Calvera Star', 'Wir sind frei von der Küste. Danke für das Geleit.');
                  w.end(true, `Porto Calvera ist geräumt: ${S.aboard} Menschen bei Ihnen an Bord, ${EVAC.ferry} auf der Fähre.`);
               }
               return;
            }
            if (S.stage === 0) {
               if (w.time >= S.nextAt) {
                  S.stage = 1; S.lift++; S.load = 0; S.winEnd = w.time + T.win; S.said = 0;
                  radio(w, 'Hafenkapitän', `Transport ${S.lift} legt ab – ${EVAC.people} Menschen. Das Fenster ist ${T.win} Sekunden offen.`);
                  if (T.waves[S.lift - 1]) this.wave(w, S, T.waves[S.lift - 1], T);
                  if (S.lift === T.batAt) {
                     const b = w.sites.find(x => x.id === S.batId);
                     if (b && b.alive) {
                        b.radarOn = true; b.detected = b.targetable = true; b.nextT = 14;
                        later(S, w.time + 5, () => radio(w, 'Luftlage', 'Eine Küstenbatterie südlich der Stadt geht auf Sendung und nimmt den Pier unter Feuer. Abwehr frei – oder schalten Sie die Stellung mit Geschütz oder Marschflugkörpern aus.', 'warn'));
                     }
                  }
               }
            } else {
               // on station? a captain's ship in the zone, slow, and no armed boat near the pier
               let inside = null, slow = null, boats = 0;
               for (const s of w.ships) {
                  if (!s.alive) continue;
                  if (s.side !== 'player') { if (dist(s.pos, S.zone) < EVAC.clear) boats++; continue; }
                  if (!human(s) || s.sub || !inZone(s, S.zone)) continue;
                  inside = s;
                  if (Math.abs(s.speed) <= EVAC.slowKn * KN) slow = s;
               }
               if (slow && !boats) {
                  if (S.load === 0) radio(w, 'Hafenkapitän', 'Die Boote sind bei Ihnen längsseits. Bleiben Sie so liegen.');
                  S.load += dt;
               } else if (boats) nag(w, S, 'nagBoats', 15, 'Hafenkapitän', `${boats === 1 ? 'Ein bewaffnetes Boot steht' : boats + ' bewaffnete Boote stehen'} vor dem Pier – so können unsere Boote nicht übersetzen. Versenken Sie ${boats === 1 ? 'es' : 'sie'}!`, 'warn');
               else if (inside) nag(w, S, 'nagFast', 12, 'Hafenkapitän', `Zu schnell – die Boote kommen nicht längsseits. Höchstens ${EVAC.slowKn} Knoten.`, 'warn');
               else if (w.time > S.winEnd - T.win + 12) nag(w, S, 'nagFar', 20, 'Hafenkapitän', 'Die Boote warten: Wir brauchen Sie in der Aufnahmezone vor dem Pier.', 'warn');
               const full = S.load >= T.load;
               if (!full && S.winEnd - w.time <= 20 && !S.said) { S.said = 1; radio(w, 'Hafenkapitän', 'Noch 20 Sekunden, dann müssen die Boote zurück an den Pier!', 'warn'); }
               if (full || w.time >= S.winEnd) {
                  const got = full ? EVAC.people : Math.floor(S.load / T.load * EVAC.people);
                  S.aboard += got; w.score.player = S.aboard;
                  if (full) { S.done++; radio(w, 'Wachoffizier', `Transport ${S.lift} ist an Bord – ${S.aboard} Menschen insgesamt.`); }
                  else {
                     S.missed++; setObj(w, 'all', 'failed');
                     if (S.missed > T.miss) {
                        S.stage = 3; setObj(w, 'lifts', 'failed');
                        w.end(false, `Zu viele Transporte verpasst (${S.missed} von ${T.lifts}) – die Menschen am Pier konnten nicht mehr geholt werden.`);
                        return;
                     }
                     radio(w, 'Hafenkapitän', `Transport ${S.lift} verpasst – die Boote mussten umkehren${got ? ', nur ' + got + ' Menschen sind bei Ihnen' : ''}. ${T.miss - S.missed ? 'Noch einen dürfen wir verlieren.' : 'Einen weiteren dürfen wir nicht verlieren!'}`, 'warn');
                  }
                  S.stage = 0; S.nextAt = w.time + T.gap;
                  if (S.lift >= T.lifts) {
                     // the ferry casts off with the rest
                     S.stage = 2;
                     setObj(w, 'lifts', 'done');
                     f.ai.anchored = false; f.ai.convoy = true; f.ai.route = S.route.map(p => P(p.x, p.y)); f.ai.routeIdx = 0; f.setTelegraph(4);
                     w.score.player = S.aboard + EVAC.ferry;
                     radio(w, 'Calvera Star', `Wir haben die letzten ${EVAC.ferry} an Bord und werfen los. Bringen Sie uns an der Mole vorbei auf die offene See.`);
                     this.wave(w, S, T.fin, T, ' – sie wollen die Fähre vor der Mole abfangen');
                  }
               }
            }
            const txt = this.liftText(w, S, T);
            if (txt !== S.shown) { S.shown = txt; objText(w, 'lifts', txt); }
         },
         onSiteDestroyed(w, site, by, S) { if (site.id === S.batId) radio(w, 'Lagezentrum', 'Die Küstenbatterie ist ausgeschaltet.'); },
         onSink(w, ship, killer, S) {
            if (ship.id === S.ferryId) { S.stage = 3; setObj(w, 'ferry', 'failed'); w.end(false, 'Die Fähre Calvera Star ist gesunken.'); return; }
            if (ship.side === 'player') {
               if (!w.ships.some(s => s.alive && s.side === 'player' && human(s) && !s.sub)) w.end(false, 'Ihr Schiff ist verloren – niemand kann die Menschen von Porto Calvera mehr aufnehmen.');
               return;
            }
            S.sunk++;
         },
         timeout(w) { w.end(false, 'Die Zeit ist abgelaufen – die Fähre hat die offene See nicht erreicht.'); },
      },
      // --------------------------------------------------------------------- Arktis – Bastion
      // S.stage: 0 searching, 1 contact (shadowing), 2 enough data (leave), 3 over. S.meter 0..100: located at 100.
      {
         id: 'bastion', group: 'ops', name: 'Arktis – Bastion', subtitle: 'Sondereinsatz · Raketen-U-Boot beschatten, unentdeckt bleiben',
         briefing: 'An der Eiskante liegt das geschützte Patrouillengebiet eines Raketen-U-Boots – die Bastion. Fregatten mit Schleppsonar ' +
            'und ein Jagd-U-Boot decken es. Spüren Sie den Raketenträger Wolchow auf und beschatten Sie ihn: getaucht, ' +
            '1,2 bis 2,8 Kilometer genau achteraus – dort ist sein eigenes Sonar taub. Halten Sie die Position, bis genug Geräuschdaten ' +
            'aufgezeichnet sind, und laufen Sie dann zum Ablaufpunkt. Die Ortungsgefahr steht im Auftrag, mit dem Grund, warum sie steigt: ' +
            'vor oder neben dem Raketenträger hört Sie sein Sonar, die Wachschiffe hören Sie auf bis zu 3 Kilometer, mit mehr als ' +
            'halber Fahrt sind Sie in ihrer Nähe zu laut, und am Sehrohr werden Sie gesichtet. Von Zeit zu Zeit horcht der ' +
            'Raketenträger nach achtern – das Sonar meldet es vorher: Dann höchstens Fahrtstufe 1/4, bis er fertig ist. ' +
            'Bei 100 % sind Sie geortet, der Einsatz ist verloren. ' +
            'Waffen sind gesperrt: Ein Schuss ohne Freigabe beendet den Einsatz. Der Raketenträger ist niemals ein Ziel.',
         debrief: 'Die Geräuschsignatur der Wolchow ist aufgezeichnet, in der Bastion hat niemand etwas bemerkt. ' +
            'Entschieden hat nicht eine Waffe, sondern die Fahrtstufe: langsam genug, um unhörbar zu bleiben, schnell genug, um dranzubleiben.',
         fleet: { own: '1 Jagd-U-Boot · 1 Schwesterboot als Sicherung am Ablaufpunkt', foe: 'Raketen-U-Boot Wolchow (kein Ziel), 2 Fregatten, 1 Jagd-U-Boot' },
         env: { time: 'dusk', weather: 'fog' }, type: 'stealth', playableShips: ['U212', 'Virginia'], recommendedShip: 'U212',
         arena: 15000, timeLimit: 720, stars: 3,
         setup(w, shipKey) {
            const S = w._script, T = tune(w, 'bastion');
            // (sim y grows south.) the ice edge in the north: two low, flat barriers
            islands(w, [
               { c: P(-2500, -12200), r: 2300, height: 22, seed: 151, lobes: 5, elong: 3.2, rot: 0.08, rough: 0.35, name: 'Eiskante' },
               { c: P(9800, -10800), r: 1700, height: 18, seed: 157, lobes: 4, elong: 2.4, rot: -0.3, rough: 0.35, name: 'Eiskante Ost' },
            ]);
            // the captain starts on her quarter, south of her track (the frigates run north of it), the way out behind him
            S.exit = zone(w, 1200, 8600, 1500, 'Ablaufpunkt');
            add(w, shipKey, 'player', P(3600, 6600), -2.8, { isPlayer: true, depth: 2, telegraph: 2 });
            // the sister boat lies stopped at the way out and never fires (co-op: the second captain's boat)
            add(w, shipKey, 'player', P(2100, 8900), -2.8, { name: shipKey === 'U212' ? 'U 32' : 'USS Texas', depth: 2, telegraph: 0, ai: { anchored: true } });
            // the missile boat: west along the ice edge, then north-west; never fights, never listens with the engine's
            // sonar (the script models its sonar with the blind arc astern)
            // she zigzags down her first leg (drawn from the seed), then turns north-west for the ice
            const start = P(800, 1200), zig = (k) => P(800 - 7300 * k + 0.48 * (w.rng() - 0.5) * 1500, 1200 + 4000 * k + 0.88 * (w.rng() - 0.5) * 1500);
            const route = [zig(0.35), zig(0.62), zig(0.85), P(-6500, 5200), P(-9200, 0)];
            const t = add(w, 'Kilo', 'enemy', start, Math.atan2(route[0].y - start.y, route[0].x - start.x),
               { name: 'Wolchow', depth: 2, speedKn: T.kn / 0.85, hpMult: 2, telegraph: 4, ai: { passive: true, route } });
            t.noTarget = true; t.sonarDeafT = 1e9;
            S.tgtId = t.id;
            // (where a frigate stands on its first leg is drawn from the seed)
            const loop = (name, pts, kn, k = w.rng()) => add(w, 'Gorschkow', 'enemy', P(pts[0].x + (pts[1].x - pts[0].x) * k, pts[0].y + (pts[1].y - pts[0].y) * k),
               Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x), { name, speedKn: kn, telegraph: 4, ai: { passive: true, patrol: pts, patrolIdx: 1 } });
            // two racetracks north of her track: Bravo 3.5 km off it, Alfa beyond
            S.frig = [loop('Fregatte Alfa', [P(500, -4300), P(-7500, -4900), P(-7500, -6100), P(500, -5500)], T.frig).id,
               loop('Fregatte Bravo', [P(-900, -1900), P(-6200, 1000), P(-6600, 300), P(-1300, -2600)], T.frig).id];
            // the hunter boat circles between the track and the way out
            S.guardLoop = [P(-4600, 6400), P(-900, 5600), P(-1900, 9600)];
            const gk = w.rng(), g0 = P(S.guardLoop[0].x + (S.guardLoop[1].x - S.guardLoop[0].x) * gk, S.guardLoop[0].y + (S.guardLoop[1].y - S.guardLoop[0].y) * gk);
            S.guardId = T.guard ? add(w, 'Kilo', 'enemy', g0, -0.2, { name: 'Jagd-U-Boot Ladoga', depth: 2, speedKn: 7, ai: { passive: true, route: [S.guardLoop[1], S.guardLoop[2], S.guardLoop[0]] } }).id : 0;
            S.area = zone(w, -2600, 3000, 4200, 'Patrouillengebiet');
            S.stage = 0; S.why = ''; S.whyT = 0; S.meter = 0; S.peak = 0; S.trail = 0; S.tick = 0; S.shown = ''; S.listenAt = 0; S.listenEnd = 0; S.released = false; S.sunk = 0;
            objective(w, 'find', 'Spüren Sie den Raketenträger Wolchow im Patrouillengebiet auf' + lim(w));
            objective(w, 'trail', this.trailText(S, T));
            objective(w, 'exit', 'Laufen Sie danach unentdeckt zum Ablaufpunkt ab');
            objective(w, 'fire', 'Waffen gesperrt – kein Schuss ohne Freigabe, der Raketenträger ist nie ein Ziel');
            objective(w, 'ghost', 'Die Ortungsgefahr bleibt unter 50 %', { optional: true });
            w.score = { kind: 'count', player: 0, enemy: 0, target: 100 };
            later(S, 4, () => radio(w, 'Flottenkommando', `Sie stehen am Rand der Bastion. Der Raketenträger Wolchow läuft mit ${T.kn} Knoten nach Südwesten durch das Patrouillengebiet. Finden Sie ihn, hängen Sie sich ${T.trail} Sekunden achteraus an – und lassen Sie sich nicht orten.`));
            later(S, 14, () => radio(w, 'Flottenkommando', 'Waffen sind gesperrt. Ein Schuss ohne Freigabe beendet den Einsatz, und der Raketenträger ist niemals ein Ziel.', 'warn'));
            later(S, 26, () => radio(w, 'Sonar', `Zwei Fregatten mit Schleppsonar laufen nördlich ihres Kurses Streife${T.guard ? ', ein Jagd-U-Boot kreist vor dem Ablaufpunkt' : ''}. Gestoppt hören uns die Fregatten auf ${String(TRAIL.frig / 2000).replace('.', ',')} Kilometer, bei voller Fahrt auf ${TRAIL.frig / 1000} – Abstand halten. Mit mehr als halber Fahrt sind wir in ihrer Nähe ohnehin zu laut.`));
         },
         trailText(S, T) {
            const m = Math.floor(S.meter / 10) * 10, sec = Math.min(T.trail, Math.floor(S.trail / 10) * 10);
            return `Beschatten Sie die Wolchow getaucht,${String(TRAIL.min / 1000).replace('.', ',')}–${String(TRAIL.max / 1000).replace('.', ',')} km achteraus: ${sec}/${T.trail} s · Ortungsgefahr ${S.meter >= 100 ? 100 : m} %` +
               (S.why ? ` – steigt: ${WHY[S.why]}` : '') + (S.listening ? ` · SIE HORCHT – höchstens Fahrtstufe 1/4!` : '');
         },
         update(w, dt, S) {
            if (S.stage >= 3) return;
            const T = tune(w, 'bastion'), t = live(w, S.tgtId);
            // the captains' boats (the sister boat at the way out counts only once a second captain sails it)
            const boats = w.ships.filter(b => b.alive && b.side === 'player' && b.sub && human(b));
            // co-op: the boats of the other captains (placed after setup) start deep as well
            if (!S.init) { S.init = true; S.shots = {}; for (const b of boats) { if (w.time < 2) b.depthTarget = b.depthF = b.depth = 2; } }
            // the rule of the weapons: any shot before the release ends the mission
            if (!S.released) for (const b of boats) {
               if (S.shots[b.id] === undefined) S.shots[b.id] = b.lastTorpFire;
               if (b.lastTorpFire !== S.shots[b.id] || (w.missiles || []).some(m => m.ownerId === b.id)) {
                  S.stage = 3; setObj(w, 'fire', 'failed');
                  w.end(false, 'Schuss ohne Freigabe – die Bastion ist alarmiert, der Einsatz ist gescheitert.');
                  return;
               }
            }
            if (!t) return;
            const hunters = [...S.frig, S.guardId].map(i => i && live(w, i)).filter(Boolean);
            for (const o of hunters) if (!(S.released && o.id === S.guardId)) o.sonarDeafT = 1e9;
            t.battery = 1; t.pingT = -999; t.noTarget = true;      // it neither tires nor reacts to being heard
            const g = S.guardId ? live(w, S.guardId) : null;
            if (g) {
               g.battery = 1;
               if (!S.released) { g.pingT = -999; if (g.ai.route && g.ai.routeIdx >= g.ai.route.length - 1 && dist(g.pos, g.ai.route[g.ai.route.length - 1]) < 800) g.ai.routeIdx = 0; }
            }
            if ((S.tick -= dt) > 0) return;
            const step = 0.5; S.tick += step;
            // ---- the check astern: announced, then for listenFor s the blind arc is gone
            S.listening = S.stage === 1 && w.time >= S.listenAt && w.time < S.listenEnd;
            if (S.stage === 1 && w.time >= S.listenEnd) {
               S.listenAt = w.time + T.listen * (0.75 + 0.5 * w.rng()); S.listenEnd = S.listenAt + T.listenFor; S.warnedListen = false;
            }
            if (S.stage === 1 && !S.warnedListen && S.listenAt - w.time <= T.warn) {
               S.warnedListen = true;
               radio(w, 'Sonar', `Die Wolchow dreht ihr Sonar nach achtern – in ${T.warn} Sekunden horcht sie ${T.listenFor} Sekunden lang. Höchstens Fahrtstufe 1/4, bis sie fertig ist!`, 'warn');
            }
            // ---- who hears the boats: the worst case over all captains feeds the meter
            const hx = Math.cos(t.heading), hy = Math.sin(t.heading);
            let rate = -T.cool, why = '', inBand = false, nearest = Infinity;
            for (const b of boats) {
               const f = Math.abs(b.speed) / KN / (b.maxSpeedKn * b.sub.deepSpeed), d = dist(b.pos, t.pos);      // speed as a share of the telegraph
               const cosA = d > 1 ? ((b.pos.x - t.pos.x) * hx + (b.pos.y - t.pos.y) * hy) / d : 1, astern = cosA < -Math.cos(TRAIL.arc);
               const loud = 0.5 + 0.5 * Math.min(1, f);
               nearest = Math.min(nearest, d);
               let r = -T.cool, y = '';
               if (S.listening ? d < TRAIL.bow * Math.min(1, Math.max(0, (f - TRAIL.creep) / 0.15)) || d < TRAIL.aft * loud : d < (astern && f <= TRAIL.fast ? TRAIL.aft : TRAIL.bow) * loud) { r = S.listening ? T.caught : T.held; y = S.listening ? 'listen' : !astern ? 'bow' : f > TRAIL.fast ? 'fast' : 'close'; }
               else if (hunters.some(o => !(S.released && o.id === S.guardId) && dist(o.pos, b.pos) < (o.id === S.guardId ? TRAIL.sub : TRAIL.frig) * loud)) { r = T.held; y = 'held'; }
               else if (w.time - b.pingT < 1.2) { r = T.held; y = 'ping'; }      // the released hunter boat pings (hard)
               else if (f > TRAIL.fast && w.ships.some(o => o.alive && o.side === 'enemy' && o !== t && dist(o.pos, b.pos) < TRAIL.near)) { r = T.noise * Math.min(2, (f - TRAIL.fast) / 0.25 + 0.5); y = 'noise'; }
               // a periscope is sighted from a frigate's bridge, not by the boat that hunts it
               if (b.detected && b.depth < 2 && S.frig.some(i => { const o = live(w, i); return o && dist(o.pos, b.pos) < TRAIL.frig; })) { r = T.seen; y = 'seen'; }
               if (r > rate) { rate = r; why = y; }
               if (astern && d >= TRAIL.min && d <= TRAIL.max && b.depth > 0) inBand = true;
            }
            S.meter = Math.max(0, Math.min(100, S.meter + rate * step));
            S.peak = Math.max(S.peak, S.meter);
            w.score.player = Math.round(S.meter);
            // the reason stays in the objective for a few seconds after the meter stops rising (no flicker at a limit)
            if (!(why && rate > 0) && S.why && w.time > S.whyT) S.why = '';
            if (why && rate > 0) {
               S.why = why; S.whyT = w.time + 4;
               nag(w, S, 'nag_' + why, 25, 'Sonar', why === 'listen' ? 'Sie hört uns! Fahrt heraus – höchstens Fahrtstufe 1/4, solange sie horcht.'
                  : why === 'close' ? 'Zu dicht – wir laufen ihr in die Schraube. Abstand über einen Kilometer!'
                  : why === 'bow' ? 'Wir stehen vor ihrem Sonar. Nur genau achteraus ist sie taub – zurück ins Kielwasser!'
                  : why === 'fast' ? 'Zu schnell – mit mehr als halber Fahrt hört sie uns auch im Kielwasser.'
                  : why === 'held' ? 'Ein Wachschiff hält uns im Sonar. Fahrt heraus und Abstand gewinnen!'
                  : why === 'ping' ? 'Das Jagd-U-Boot hält uns im Sonar! Auf Sehrohrtiefe und Torpedos los, bevor es uns meldet – oder abhängen.'
                  : why === 'seen' ? 'Sehrohr gesichtet! Sofort tief gehen.'
                  : 'Wir sind zu laut. Höchstens halbe Fahrt, solange Wachschiffe in der Nähe stehen.', 'warn');
            }
            if (S.peak >= 50 && !S.half) { S.half = true; setObj(w, 'ghost', 'failed'); radio(w, 'Sonar', 'Ortungsgefahr über 50 % – die Wachschiffe suchen bereits. Bei 100 % haben sie uns.', 'warn'); }
            if (S.meter >= 100) {
               S.stage = 3; setObj(w, S.trail >= T.trail ? 'exit' : 'trail', 'failed');
               w.end(false, 'Das Boot wurde geortet – die Bastion ist alarmiert, der Einsatz ist gescheitert.');
               return;
            }
            // ---- the chain: find, shadow, leave
            if (S.stage === 0 && nearest < TRAIL.hear) {
               S.stage = 1; setObj(w, 'find', 'done');
               S.listenAt = w.time + T.listen * (0.75 + 0.5 * w.rng()); S.listenEnd = S.listenAt + T.listenFor;
               S.tz = zone(w, t.pos.x, t.pos.y, 800, 'Folgeposition');
               radio(w, 'Sonar', `Kontakt: ein großes Boot, sieben Blätter, ${T.kn} Knoten – das ist die Wolchow. Die Folgeposition steht auf der Karte: genau achteraus, ${String(TRAIL.min / 1000).replace('.', ',')} bis ${String(TRAIL.max / 1000).replace('.', ',')} Kilometer.`);
            }
            if (S.tz) {      // the marked trailing position follows the boat (coarse steps: co-op sends zones on change)
               const k = (TRAIL.min + TRAIL.max) / 2;
               S.tz.x = Math.round((t.pos.x - hx * k) / 50) * 50; S.tz.y = Math.round((t.pos.y - hy * k) / 50) * 50;
            }
            if (S.stage === 1) {
               if (inBand) {
                  if (!S.onStation) { S.onStation = true; radio(w, 'Sonar', 'Wir stehen in ihrem Kielwasser. Aufzeichnung läuft – Position halten.'); }
                  S.trail += step;
               }
               // hard: the hunter boat picks up the trail and floods its tubes – weapons are released against it alone
               if (T.hunt && g && !S.released && S.trail >= T.trail * T.hunt) {
                  S.released = true;
                  g.sonarDeafT = 0; g.ai.passive = false; g.ai.route = null; g.ai.huntId = boats.length ? boats.reduce((a, b) => dist(b.pos, g.pos) < dist(a.pos, g.pos) ? b : a).id : null; g.ai.press = true;
                  objText(w, 'fire', 'Waffen frei gegen das Jagd-U-Boot Ladoga – nur gegen dieses, der Raketenträger ist nie ein Ziel');
                  radio(w, 'Sonar', 'Torpedorohre werden geflutet – das Jagd-U-Boot Ladoga hat unsere Spur!', 'warn');
                  radio(w, 'Flottenkommando', 'Waffen frei gegen das Jagd-U-Boot – nur gegen dieses. Der Raketenträger und die Fregatten bleiben gesperrt.', 'warn');
               }
               if (S.trail >= T.trail) {
                  S.stage = 2; setObj(w, 'trail', 'done');
                  w.mission.zones.splice(w.mission.zones.indexOf(S.tz), 1); S.tz = null;
                  radio(w, 'Sonar', 'Genug Daten, die Signatur ist im Kasten. Fallen Sie zurück und laufen Sie leise zum Ablaufpunkt.');
               }
            } else if (S.stage === 2 && boats.length && boats.every(b => inZone(b, S.exit))) {
               S.stage = 3;
               setObj(w, 'exit', 'done'); setObj(w, 'fire', 'done');
               if (S.peak < 50) setObj(w, 'ghost', 'done');
               w.end(true, S.peak < 50 ? 'Die Wolchow ist vermessen – in der Bastion hat niemand etwas bemerkt.' : 'Die Wolchow ist vermessen. Die Wachschiffe ahnen allerdings, dass jemand hier war.');
               return;
            }
            const txt = this.trailText(S, T);
            if (txt !== S.shown) { S.shown = txt; objText(w, 'trail', txt); }
         },
         onSink(w, ship, killer, S) {
            if (S.stage >= 3) return;
            if (ship.side === 'player') {
               if (!w.ships.some(b => b.alive && b.side === 'player' && human(b))) { S.stage = 3; w.end(false, 'Ihr Boot ist verloren.'); }
               return;
            }
            if (ship.id === S.guardId && S.released) { S.sunk++; radio(w, 'Sonar', 'Das Jagd-U-Boot ist versenkt. Weiter – leise.'); return; }
            S.stage = 3; setObj(w, 'fire', 'failed');
            w.end(false, ship.id === S.tgtId ? 'Der Raketenträger Wolchow ist gesunken – das war nie der Auftrag.' : `${ship.name} ist versenkt worden – die Bastion ist alarmiert, der Einsatz ist gescheitert.`);
         },
         timeout(w) { w.end(false, 'Die Zeit ist abgelaufen – das Boot hat den Ablaufpunkt nicht erreicht.'); },
      },
   ];
   return defs;
}
