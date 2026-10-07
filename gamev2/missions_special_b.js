// gamev2/missions_special_b.js — special operations of the modern mode, second set (fictional
// present-day scenarios):
//    hijack     Golf von Aden – Entführt: stop a hijacked gas tanker by boarding it alongside; it must
//               not take heavy hits (it explodes, blast.js)
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
};
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
   ];
   return defs;
}
