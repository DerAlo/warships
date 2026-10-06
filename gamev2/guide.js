// gamev2/guide.js — "Waffenkunde": what every weapon and system of the modern mode is for, as
//    - a reference sheet over the menu / the pause card (openGuide; entries a ship carries come first),
//    - the tooltips of the weapon slots and the helicopter plate (slotTip),
//    - one notice per weapon and session when it is selected for the first time (hints.frame).
// Local UI only: nothing here touches the sim or the net. Ranges are read from config.js / helo.js,
// so the texts follow the balance.
import { MISSILES, CIWS, SENSOR, DEFENCE, SHIPS } from './config.js';
import { HELO } from './helo.js';

const touch = () => typeof document !== 'undefined' && !!document.body?.classList.contains('touch');
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kmN = (m) => (Math.round(m / 100) / 10).toString().replace('.', ',');
const km = (m) => kmN(m) + ' km';
const pct = (x) => Math.round(x * 100) + ' %';
// "18–30 km" over a list of metres
const span = (list) => { const a = Math.min(...list), b = Math.max(...list); return a === b ? km(a) : kmN(a) + '–' + km(b); };
const ofKind = (f) => Object.values(MISSILES).filter(f);
const R_SSM = span(ofKind(m => m.kind === 'ssm' && m.range > 10000).map(m => m.range));
const R_CRUISE = span(ofKind(m => m.kind === 'cruise').map(m => m.range));
const R_AREA = span(ofKind(m => m.cls === 'area').map(m => m.range));
const R_POINT = span(ofKind(m => m.cls === 'point').map(m => m.range));
const R_CIWS = span(Object.values(CIWS).map(c => c.range));
const R_SEEKER = span(ofKind(m => m.kind === 'ssm' && m.range > 10000).map(m => m.seeker));

const W = (c) => c?.weapons || {};
const ssmOf = (c) => W(c).ssm?.length ? MISSILES[W(c).ssm[0].type] : null;
const cruiseOf = (c) => W(c).cruise ? MISSILES[W(c).cruise.type] : null;
const cons = (c, k) => !!c?.consumables?.some(x => x.key === k);

// One entry per weapon / system. has(cfg): the ship carries it. key: desktop, tap: touch.
// what = what it is for, how = how to use it, vs = what counters it (or what it counters).
export const GUIDE = [
   { id: 'gun', name: 'Geschütz', key: '1 · Leertaste / Linksklick', tap: 'Feld Geschütz, dann Feuerknopf', has: c => c.main?.guns > 0,
      what: 'Schnellfeuerkanone für alles in Sichtweite: Boote, Korvetten, beschädigte Schiffe, Landstellungen an der Küste. Kurze Reichweite (7,5–9,5 km), wenig Schaden pro Treffer, aber unbegrenzt Munition.',
      how: 'Wie im Hauptspiel über die Bildmitte zielen und vorhalten.',
      vs: 'Gegen große Schiffe nur die Notlösung, wenn die Flugkörper verschossen sind.' },
   { id: 'ssm', name: 'Seezielflugkörper', key: '2 · Ziel erfassen: X', tap: 'Feld antippen, Ziel erfassen, Feuerknopf', has: c => W(c).ssm?.length > 0,
      what: `Harpoon, RBS15, Oniks, YJ-18 und ihre Verwandten: die Hauptwaffe gegen Schiffe jenseits der Geschützreichweite (${R_SSM}). Der Flugkörper fliegt dicht über dem Wasser zum Ziel und schaltet ${R_SEEKER} davor seinen Suchkopf ein.`,
      how: 'Ziel mit X erfassen oder anvisieren und starten. „Ziel erfasst“ heißt: er fliegt dieses Schiff an. Ohne Feuerleitlösung geht er als Peilungsschuss in Blickrichtung hinaus und nimmt das erste Schiff, das sein Suchkopf findet – auch ein eigenes.',
      vs: 'Die Luftabwehr des Ziels schießt einzelne Flugkörper ab, Täuschkörper und Störsender lenken sie ab. Deshalb Salven schießen: mehrere kurz nacheinander überlasten die Abwehr. Überschall-Flugkörper (Oniks, Granit, Wulkan, YJ-18, Kalibr) kommen eher durch. Inseln versperren den Weg.' },
   { id: 'cruise', name: 'Marschflugkörper', key: '3 öffnet die Lagekarte', tap: 'Feld antippen, dann Ziel auf der Karte', has: c => !!W(c).cruise,
      what: `Tomahawk, Kalibr-NK, CJ-10: Waffe gegen Land. Trifft Landstellungen (Küstenbatterie, Flugabwehr, Radar, Flugplatz, Bunker, Startrampe) und Schiffe vor Anker aus ${R_CRUISE} Entfernung und fliegt dabei über Inseln hinweg. Fahrende Schiffe trifft er nicht.`,
      how: 'Auf der Lagekarte eine Landstellung oder einen Punkt wählen; der gestrichelte Ring ist die Reichweite. U-Boote starten ihn bis Sehrohrtiefe.',
      vs: `Langsam und gut zu sehen: Flugabwehr-Stellungen und Schiffe in der Nähe des Ziels schießen ihn ab. Erst die Flugabwehr ausschalten oder mehrere auf dasselbe Ziel schicken. Wirkt im Umkreis von ${DEFENCE.cruiseBlast} m.` },
   { id: 'rockets', name: 'Raketenwerfer', key: '4', tap: 'Feld antippen, dann Feuerknopf', has: c => !!W(c).rockets,
      what: 'Ungelenkte Raketen der Schnellboote: eine ganze Salve auf den Zielpunkt, nur auf kurze Entfernung (rund 3 km). Streut stark – gut gegen stehende oder langsame Ziele und Landstellungen.',
      how: 'Zielpunkt mit dem Fadenkreuz oder auf der Lagekarte wählen und feuern. Danach lädt der Werfer lange nach.',
      vs: 'Lässt sich nicht abschießen, aber ein schnelles Ziel fährt aus der Salve heraus.' },
   { id: 'torp', name: 'Torpedos', key: '5 · nochmals 5: Fächer eng / weit', tap: 'Feld antippen (nochmals: Fächer), Feuerknopf', has: c => !!c.torp,
      what: 'Schwere Torpedos tragen in diesem Modus nur die U-Boote: 6–10 km Laufstrecke, ein Treffer versenkt eine Korvette und verkrüppelt einen Zerstörer.',
      how: 'Bug auf das Ziel drehen, vorhalten wie im Hauptspiel, Fächer eng für ein Ziel, weit für eine Gruppe.',
      vs: 'Der Abschuss von Sehrohrtiefe verrät das Boot für einige Sekunden. Aktivsonar und Hubschrauber finden dich danach schneller.' },
   { id: 'lock', name: 'Zielerfassung', key: 'X', tap: 'Knopf Ziel am Feuerknopf', has: () => true,
      what: 'Legt das Schiff unter dem Fadenkreuz als Ziel fest. Die Tafel oben zeigt Entfernung, Fahrt und Zustand. Seezielflugkörper fliegen das erfasste Ziel an, auch wenn du woanders hinsiehst.',
      how: 'Anvisieren und X drücken; nochmals X löst das Ziel.',
      vs: 'Für einen gezielten Schuss brauchst du eine Feuerleitlösung (volle Raute): Radar an und nah genug.' },
   { id: 'sam', name: 'Luftabwehr-Flugkörper', key: 'schießt selbst · Doktrin: V', tap: 'schießt selbst · Feld Luftabwehr', has: c => W(c).sam?.length > 0,
      what: `Schießen anfliegende Flugkörper, Jets und Hubschrauber ab. Bereichsabwehr (SM-2, Aster 30, S-300F, HQ-9; ${R_AREA}) schützt auch die Nachbarn, Nahbereichsabwehr (ESSM, RAM, CAMM, HQ-10; ${R_POINT}) nur das eigene Schiff und was dicht daneben fährt.`,
      how: 'Die Abwehr arbeitet von allein. Über der Waffenleiste stehen Magazine und Feuerleitkanäle: jeder Kanal bekämpft ein Ziel zur gleichen Zeit, jeder Schuss kostet einen Flugkörper.',
      vs: 'Ist das Magazin leer oder sind alle Kanäle belegt, kommt der Rest durch. Radar aus heißt: nur RAM und ähnliche Wärmesucher schießen noch.' },
   { id: 'ciws', name: 'Nahbereichsschutz', key: 'schießt selbst', tap: 'schießt selbst', has: c => !!W(c).ciws,
      what: `Phalanx, Goalkeeper, AK-630, Kaschtan, Typ 730: Maschinenkanonen als letzte Schicht auf ${R_CIWS}. Sie brauchen keine Munition aus dem Magazin.`,
      how: 'Nichts zu tun. Jede Kanone bekämpft ein Ziel zur gleichen Zeit.',
      vs: 'Gegen Überschall-Flugkörper nur halb so wirksam – die Zeit reicht kaum.' },
   { id: 'doctrine', name: 'Doktrin und Vorrangziel', key: 'V · T', tap: 'Felder Luftabwehr und Vorrang', has: c => W(c).sam?.length > 0,
      what: 'Feuer frei: die Abwehr schießt auf alles in Reichweite und deckt so den Verband. Selbstschutz: nur was auf dich zufliegt – spart das Magazin. Feuer halten: die Flugkörper bleiben im Magazin.',
      how: 'V schaltet durch. T setzt den anfliegenden Flugkörper in Blickrichtung als Vorrangziel, nochmals T hebt es auf.',
      vs: '' },
   { id: 'decoy', name: 'Täuschkörper', key: 'F (U-Boot: N)', tap: 'Feld Düppel', has: c => cons(c, 'decoy'),
      what: `Eine Düppelwolke neben dem Schiff, die ${SENSOR.DECOY_LIFE} Sekunden lang Suchköpfe auf sich zieht. Lenkt einen Unterschall-Flugkörper in etwa ${pct(DEFENCE.decoyPk)} der Fälle ab, einen Überschall-Flugkörper in ${pct(DEFENCE.decoyPkSuper)}.`,
      how: `Erst werfen, wenn der Flugkörper nah ist (unter 5 km, rote Pfeile am Fadenkreuz) – vorher sucht er noch gar nicht. Eine Wolke hält höchstens ${DEFENCE.decoyCap} Flugkörper auf.`,
      vs: 'Wärmesucher wie die NSM fallen selten darauf herein.' },
   { id: 'jammer', name: 'Störsender', key: 'J', tap: 'Feld EloKa', has: c => cons(c, 'jammer'),
      what: `Stört ${SHIPS.Braunschweig.consumables.find(x => x.key === 'jammer')?.dur || 30} Sekunden lang: feindliche Radare sehen dich und Schiffe im Umkreis von ${km(SENSOR.JAM_R)} erst auf ${pct(SENSOR.JAM_RADAR)} ihrer Reichweite, Suchköpfe erfassen erst auf die halbe Entfernung.`,
      how: 'Einschalten, wenn Flugkörper anfliegen oder du unerkannt näher heran willst.',
      vs: 'Der Sender strahlt selbst: jeder Gegner peilt dich über ESM, solange er läuft.' },
   { id: 'radar', name: 'Radar, EMCON und ESM', key: 'R', tap: 'Feld Radar', has: c => !!c.radar,
      what: `Das Radar sieht Schiffe auf 19–27 km und liefert auf ${pct(SENSOR.FC)} davon die Feuerleitlösung für gezielte Flugkörper. Tief fliegende Flugkörper sieht es erst am Radarhorizont (rund 10 km).`,
      how: 'R schaltet es aus (EMCON): du strahlst nicht und siehst nur noch mit der Optik und über ESM, den Empfänger für fremde Radarstrahlung.',
      vs: `Ein laufendes Radar wird auf das ${String(SENSOR.ESM).replace('.', ',')}-Fache seiner Reichweite gepeilt – der Gegner weiß, wo du bist, bevor du ihn siehst. Kontakte: „?“ = nur Peilung, hohle Raute = gesichtet, volle Raute = Feuerleitlösung.` },
   { id: 'stealth', name: 'Tarnung', key: '', tap: '', has: c => (c.stealth ?? 1) < 1,
      what: 'Schiffe mit kleiner Radarsignatur (Korvetten, Schnellboote, neue Zerstörer) werden vom Radar deutlich später erfasst. Der Tarnwert im Hafen ist die Entfernung, auf die man dich mit bloßem Auge sieht.',
      how: 'Mit Radar aus heranfahren, starten, abdrehen.',
      vs: 'Wer schießt, ist weiter zu sehen. Die Lampe an der Schiffstafel zeigt, ob der Feind dich gesichtet hat.' },
   { id: 'helo', name: 'Bordhubschrauber', key: 'I · bei offener Lagekarte: I, dann Punkt anklicken', tap: 'Feld Hubschrauber antippen · bei offener Lagekarte: Feld, dann Punkt', has: c => !!c.helo,
      what: `Der Hubschrauber jagt U-Boote – gegen Schiffe und Flugkörper kann er nichts. Er fliegt ${km(HELO.screen)} voraus, senkt sein Tauchsonar ins Wasser und findet getauchte Boote im Umkreis von ${km(HELO.dipRange)}, die dein Schiff nicht hört. Auf einen Kontakt wirft er einen seiner ${HELO.torps} U-Jagd-Torpedos.`,
      how: `Start voraus mit I, nochmals I ruft ihn zurück. Bei offener Lagekarte schickst du ihn an einen Punkt, an dem du ein Boot vermutest. Der Treibstoff reicht ${Math.round(HELO.fuel / 60)} Minuten, dann kehrt er von selbst zurück und wird neu klargemacht.`,
      vs: 'Lohnt sich nur, wenn der Gegner U-Boote hat. Ein einziger Luftabwehr-Flugkörper holt ihn herunter: nicht über feindliche Schiffe schicken.' },
   { id: 'asw', name: 'U-Jagd vom Schiff', key: 'G', tap: 'Knopf U-Jagd-Torpedo / Wasserbomben', has: c => !!W(c).asw,
      what: `Das Sonar des Schiffs hört getauchte Boote nur auf wenige Kilometer. Auf einen Sonarkontakt startet G einen leichten U-Jagd-Torpedo (bis ${km(4500)}), der das Boot selbst sucht und nur U-Boote trifft; ohne Kontakt fallen Wasserbomben über das Heck.`,
      how: 'Ein schnelles Boot ist laut und wird früher gehört. Der Hubschrauber findet das Boot, das Schiff oder der Hubschrauber bekämpft es.',
      vs: 'Wasserbomben wirken nur, wenn du fast über dem Boot bist.' },
   { id: 'hydro', name: 'Aktivsonar', key: 'N', tap: 'Feld Sonar', has: c => cons(c, 'hydro'),
      what: 'Sendet eine Minute lang Schallimpulse: zeigt getauchte Boote und Torpedos in der Umgebung, auch wenn sie schleichen.',
      how: 'Einschalten, wenn du ein U-Boot in der Nähe vermutest oder Torpedos gemeldet werden.',
      vs: 'Nur wenige Ladungen und eine lange Pause dazwischen.' },
   { id: 'sub', name: 'U-Boot', key: 'F tiefer · G höher', tap: 'Tiefenknöpfe', has: c => !!c.sub,
      what: 'Getaucht bist du für Radar und Auge unsichtbar und für Flugkörper unerreichbar. Auf Sehrohrtiefe siehst du durch das Sehrohr und schießt Torpedos und Marschflugkörper – tiefer geht beides nicht mehr. Ganz getaucht erreichen dich nur noch Wasserbomben und U-Jagd-Torpedos, du selbst hörst aber nur noch Peilungen.',
      how: 'Getaucht läuft die Batterie leer (Atom-U-Boote nicht); aufgetaucht lädt sie. Wer schleicht, wird kaum gehört.',
      vs: 'Deine Gegner sind Hubschrauber mit Tauchsonar, U-Jagd-Torpedos, Wasserbomben und andere U-Boote. Nach einem Torpedoschuss sofort tiefer gehen und den Kurs ändern.' },
   { id: 'seal', name: 'Kommandotrupp', key: 'K', tap: 'Feld Kommandotrupp', has: c => !!c.sub?.seal,
      what: 'Kampfschwimmer, die in manchen Einsätzen einen Punkt an Land erledigen (Radar sprengen, Ziel markieren).',
      how: 'Nah an den Einsatzpunkt, fast stoppen, höchstens Sehrohrtiefe, dann K. Nach der Arbeit kommt der Trupp zurück: wieder langsam auf Sehrohrtiefe warten.',
      vs: 'Bleibt ein feindliches Schiff in der Nähe, wird der Trupp entdeckt.' },
   { id: 'air', name: 'Trägerjets', key: '1–3 Typ · E Start / übernehmen · F Rückruf', tap: 'Staffelfelder antippen', has: c => !!c.air,
      what: 'Anti-Schiff-Jets tragen Seezielflugkörper und schießen sie beim Abwurf als Peilungsschuss in Flugrichtung – am besten aus über 12 km Abstand, außerhalb der Nahbereichsabwehr. Mehrzweck-Jets werfen Lenkbomben auf Schiffe und Landstellungen, müssen dafür aber über das Ziel. Jagdjets schießen feindliche Flugzeuge und Hubschrauber ab und decken den Verband.',
      how: 'Typ wählen, mit E starten und die Staffel selbst fliegen: Linksklick halten = Zielanflug, loslassen = Abwurf. Jagdjets richten mit einem Klick eine Patrouille voraus ein. Der Treibstoff ist knapp; die Staffel kehrt von selbst um.',
      vs: 'Bereichsabwehr (SM-2, S-300F, HQ-9) holt Jets auf über 20 km herunter. Erst Schiffe mit schwacher Luftabwehr angreifen oder von mehreren Seiten kommen.' },
   { id: 'sites', name: 'Landstellungen', key: '', tap: '', has: () => false,
      what: 'In manchen Einsätzen stehen Küstenbatterien, Flugabwehr, Radar, Flugplätze, Bunker und Startrampen an Land. Sie sehen, schießen und starten Flugkörper wie Schiffe.',
      how: 'Mit Marschflugkörpern, Lenkbomben der Mehrzweck-Jets oder aus der Nähe mit Geschütz und Raketen bekämpfen.',
      vs: '' },
   { id: 'repair', name: 'Schadensabwehr und Notreparatur', key: 'Y · U', tap: 'Felder Leck und Rep', has: () => true,
      what: 'Schadensabwehr löscht Brände und stoppt Wassereinbrüche nach einem Treffer. Notreparatur stellt einen Teil des Rumpfs wieder her.',
      how: 'Schadensabwehr erst drücken, wenn die Salve vorbei ist – sonst brennt es gleich wieder.',
      vs: '' },
];
const byId = Object.fromEntries(GUIDE.map(e => [e.id, e]));

// Tooltip of a weapon slot / plate: purpose first, then the key (hud.js sets it as title).
export function slotTip(id, cfg) {
   const s = ssmOf(cfg), c = cruiseOf(cfg);
   switch (id) {
      case 'gun': return 'Geschütz (1): gegen alles in Sichtweite, kurze Reichweite, unbegrenzt Munition.\nFeuer: Leertaste / Linksklick';
      case 'ssm': return `${s?.name || 'Seezielflugkörper'} (2): Flugkörper gegen Schiffe jenseits der Geschützreichweite, bis ${km(s?.range || 20000)}.\nZiel erfassen (X) oder anvisieren und feuern; ohne Feuerleitlösung Peilungsschuss in Blickrichtung.\nDie Luftabwehr des Ziels kann ihn abschießen – Salven kommen eher durch.` + (W(cfg).ssm?.length > 1 ? '\n2 erneut: Typ wechseln' : '');
      case 'cruise': return `${c?.name || 'Marschflugkörper'} (3): gegen Landstellungen und Schiffe vor Anker, bis ${km(c?.range || 70000)}. Fahrende Schiffe trifft er nicht.\nÖffnet die Lagekarte: Landstellung oder Punkt ${touch() ? 'antippen' : 'anklicken'}.`;
      case 'rockets': return `Raketenwerfer (4): ungelenkte Salve auf kurze Entfernung, bis ${km(W(cfg).rockets?.range || 3200)}. Streut stark.\nSalve auf den Zielpunkt oder einen Punkt der Lagekarte.`;
      case 'torp': return `Torpedos (5): schwere Treffer gegen Schiffe, bis ${km(cfg?.torp?.range || 8000)}. Vorhalten wie im Hauptspiel.\n5 erneut: Fächer eng / weit`;
      case 'helo': return `Bordhubschrauber (I): jagt U-Boote mit Tauchsonar (${km(HELO.dipRange)}) und ${HELO.torps} U-Jagd-Torpedos. Gegen Schiffe wirkungslos.\nI: Start voraus / Rückruf · bei offener Lagekarte: I, dann Punkt wählen.`;
   }
   return '';
}

// The one-time notice of a weapon (hud.msg, class 'tip'). Short enough for the phone's notice column.
function tipText(id, cfg) {
   const s = ssmOf(cfg), c = cruiseOf(cfg), t = touch();
   switch (id) {
      case 'ssm': return `${s?.name || 'Seezielflugkörper'}: Flugkörper gegen Schiffe außerhalb der Geschützreichweite, bis ${km(s?.range || 20000)}. Ziel ${t ? 'erfassen' : 'mit X erfassen'}, dann feuern. Die Luftabwehr des Ziels schießt einzelne ab – Salven kommen durch.`;
      case 'cruise': return `${c?.name || 'Marschflugkörper'}: gegen Landstellungen, bis ${km(c?.range || 70000)}. Auf der Lagekarte Stellung oder Punkt ${t ? 'antippen' : 'anklicken'}. Fahrende Schiffe trifft er nicht.`;
      case 'rockets': return `Raketen: ungelenkte Salve auf den Zielpunkt, nur bis ${km(W(cfg).rockets?.range || 3200)}. Gut gegen langsame Ziele und Landstellungen.`;
      case 'torp': return `Torpedos: bis ${km(cfg?.torp?.range || 8000)}, vorhalten wie im Hauptspiel. Der Schuss verrät das Boot kurz – danach tiefer gehen.`;
      case 'helo': return `Hubschrauber: jagt nur U-Boote – Tauchsonar und ${HELO.torps} Torpedos. ${t ? 'Feld HUBSCHRAUBER antippen' : 'I'}: Start voraus. Gegen Schiffe wirkungslos, Luftabwehr holt ihn herunter.`;
      case 'air': return `Träger: ${t ? 'Staffel wählen und starten' : '1–3 wählt die Staffel, E startet sie'}. Anti-Schiff-Jets gegen Schiffe, Mehrzweck-Jets gegen Land, Jagdjets gegen Flugzeuge.`;
      case 'sub': return `U-Boot: getaucht unsichtbar, aber die Batterie läuft leer. ${t ? 'Tiefenknöpfe' : 'F tiefer, G höher'}. Ganz getaucht siehst du nichts mehr, nur Peilungen.`;
   }
   return '';
}

// First-use notices: one per weapon and page session, never two at once, none in the first seconds
// of a battle, none while the chart is open. MissileUi.fill calls hints.frame every frame with the
// player's ship, the weapon mode and whether the chart is open.
const TIP_SECS = 11, TIP_GAP = 14, MODE_TIP = { ssm: 'ssm', cruise: 'cruise', rockets: 'rockets', torp: 'torp' };
export const hints = {
   seen: new Set(), queue: [], nextT: 0, mode: null, shipKey: null, world: null,
   frame(hud, p, world, mode, chart = false) {
      if (!p || !p.alive || !hud || !world) return;
      const cfg = p.cfg, now = performance.now() / 1000;
      if (world !== this.world) { this.world = world; this.queue.length = 0; this.mode = mode; this.nextT = Math.max(this.nextT, now + 5); }
      this.shipKey = cfg.key;
      if (mode !== this.mode) { this.mode = mode; if (MODE_TIP[mode]) this._want(MODE_TIP[mode], true); }
      if (world.time > 5) {
         if (cfg.helo && !p.air) this._want('helo');
         if (p.air || cfg.air) this._want('air');
         if (cfg.sub) this._want('sub');
      }
      if (guideOpen) { if (!anyOpen('pause') && !anyOpen('menu')) closeGuide(); return; }
      if (chart) return;   // the notices lie over the open chart: wait until it is closed (its own line says what to do)
      if (!this.queue.length || now < this.nextT) return;
      const id = this.queue.shift(), text = tipText(id, cfg);
      if (!text) return;
      this.nextT = now + TIP_GAP;
      hud.msg(text, 'tip', TIP_SECS);
   },
   // a tip for the weapon in hand goes first
   _want(id, front = false) {
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (front) { this.queue.unshift(id); this.nextT = Math.min(this.nextT, performance.now() / 1000 + 0.4); } else this.queue.push(id);
   },
};

// ---------------------------------------------------------------- reference sheet
const CSS = `
.msg.tip { max-width: min(520px, 86vw); white-space: normal; text-align: left; font-size: 13px; font-weight: 500; line-height: 1.35; padding: 6px 14px;
   background: rgba(17,20,21,.78); border-left: 3px solid var(--gold); }
body.touch .msg.tip { font-size: 11.5px; line-height: 1.3; padding: 4px 9px; max-width: min(286px, calc(50vw - 92px)); }   /* small phones: clear of the reticle */
#guide { z-index: 25; }
#guide .card { width: min(900px, 96vw); text-align: left; padding: 22px 28px 20px; }
#guide .title { text-align: center; }
#guide .gd-sub { text-align: center; color: var(--ink-2); font-size: 13.5px; margin-top: 6px; }
#guide .gd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 22px; margin-top: 16px; }
#guide .gd-e { break-inside: avoid; padding: 8px 10px 9px; border: 1px solid var(--paper-edge); background: var(--paper-2); font: 13.5px/1.45 var(--font-serif); color: var(--ink); }
#guide .gd-e.on { border-left: 3px solid var(--signal); }
#guide .gd-h { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; font: 700 15px var(--font-cond); letter-spacing: 1px; text-transform: uppercase; }
#guide .gd-h i { font: 700 9.5px var(--font); font-style: normal; letter-spacing: 1.5px; color: var(--flag-w); background: var(--signal); padding: 1px 6px; }
#guide .gd-k { font: 600 11.5px var(--mono); color: var(--signal-lo); margin: 2px 0 4px; }
#guide .gd-e p { margin: 4px 0 0; }
#guide .gd-e p b { font-family: var(--font); font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--ink-2); }
#guide .gd-sec { grid-column: 1 / -1; font: 700 12px var(--font); letter-spacing: 2px; text-transform: uppercase; color: var(--ink-2); border-bottom: 1px solid var(--paper-edge); padding-bottom: 3px; margin-top: 6px; }
#guide button, #btn-how-guide, #btn-guide { pointer-events: auto; }
#btn-guide { cursor: pointer; border: 0; background: none; padding: 0; font: inherit; color: var(--signal-lo); text-decoration: underline; }
body.touch #btn-guide { min-height: 44px; padding: 0 8px; }
@media (max-width: 760px), (max-height: 480px) {
   #guide .card { padding: 12px 14px 14px; max-height: 96vh; }
   #guide .title { font-size: 22px !important; }
   #guide .gd-grid { grid-template-columns: 1fr; gap: 8px; margin-top: 10px; }
   #guide .gd-e { font-size: 13px; }
}
@media (max-height: 480px) and (min-width: 640px) { #guide .gd-grid { grid-template-columns: 1fr 1fr; gap: 8px 12px; } }
`;
let guideOpen = false, built = false;
const $ = (id) => document.getElementById(id);
const anyOpen = (id) => { const e = $(id); return !!e && !e.classList.contains('hidden'); };

function entryHtml(e, on) {
   const how = [touch() ? e.tap : e.key].filter(Boolean)[0];
   return `<div class="gd-e ${on ? 'on' : ''}" data-g="${e.id}"><div class="gd-h">${esc(e.name)}${on ? '<i>AN BORD</i>' : ''}</div>
      ${how ? `<div class="gd-k">${touch() ? '' : 'Taste '}${esc(how)}</div>` : ''}
      <p><b>Wofür</b> ${esc(e.what)}</p><p><b>So geht’s</b> ${esc(e.how)}</p>${e.vs ? `<p><b>Beachte</b> ${esc(e.vs)}</p>` : ''}</div>`;
}

function build() {
   if (built || typeof document === 'undefined') return;
   built = true;
   const st = document.createElement('style'); st.id = 'guide-css'; st.textContent = CSS; document.head.appendChild(st);
   const g = document.createElement('div');
   g.id = 'guide'; g.className = 'overlay hidden';
   g.innerHTML = '<div class="card"><div class="title" style="font-size:30px">Waffenkunde</div><div class="gd-sub"></div><div class="gd-grid"></div>'
      + '<div class="btn-row"><button class="play" id="btn-guide-close">Verstanden</button></div></div>';
   ($('app') || document.body).appendChild(g);
   g.querySelector('#btn-guide-close').addEventListener('click', closeGuide);
   // Esc / Enter close the sheet and do nothing else (not: resume the battle, cast off)
   window.addEventListener('keydown', (e) => {
      if (!guideOpen) return;
      if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'KeyP') { closeGuide(); }
      e.stopImmediatePropagation();
      if (e.code !== 'F5' && e.code !== 'F12') e.preventDefault();
   }, true);
   // entry points that live in the page markup: the how-to card and the pause card
   $('btn-how-guide')?.addEventListener('click', () => { $('howto')?.classList.add('hidden'); openGuide(); });
   $('btn-guide')?.addEventListener('click', () => openGuide());
}

// Opens the sheet. shipKey: the ship whose systems are listed first ("AN BORD"); default: the
// ship of the running battle, else the whole catalogue.
export function openGuide(shipKey) {
   build();
   const g = $('guide');
   if (!g) return;
   const key = shipKey || (anyOpen('pause') ? hints.shipKey : null), cfg = key ? SHIPS[key] : null;
   const on = cfg ? GUIDE.filter(e => e.has(cfg)) : [], off = GUIDE.filter(e => !on.includes(e));
   g.querySelector('.gd-sub').textContent = cfg ? 'Was die ' + cfg.name + ' an Bord hat, wofür es gut ist und was dagegen hilft.' : 'Wofür jede Waffe gut ist, wie du sie einsetzt und was dagegen hilft.';
   g.querySelector('.gd-grid').innerHTML = (cfg ? `<div class="gd-sec">An Bord der ${esc(cfg.name)}</div>` : '') + on.map(e => entryHtml(e, true)).join('')
      + (cfg && off.length ? '<div class="gd-sec">Was dir sonst begegnet</div>' : '') + off.map(e => entryHtml(e, false)).join('');
   g.classList.remove('hidden');
   g.querySelector('.card').scrollTop = 0;
   guideOpen = true;
}
export function closeGuide() { $('guide')?.classList.add('hidden'); guideOpen = false; }
export const guideEntry = (id) => byId[id];

if (typeof document !== 'undefined') {
   if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
}
