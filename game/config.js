// game/config.js — the single source of truth for numbers.
// Units: meters, radians, m/s, seconds. World: X+ = east, Y+ = south, angle 0 = +x (east), CCW positive.
import { TAU, DEG } from './utils.js';

// ============ WORLD ============
export const WORLD = {
   ARENA: 3800,                 // half-extent; coords in [-3800, 3800]. Tight enough that a
                                // fleeing ship can't cross the map and stall the match forever.
   SHELL_SPEED_MAIN: 650,       // m/s
   SHELL_SPEED_SEC: 600,
   TORP_SPEED: 40,              // m/s
   TORP_RANGE: 1000,           // fizzes past this
   MIN_THROTTLE: 0.35,        // ships keep "way"; turns stay readable
   REPAIR_RATE: 0.03,          // HP fraction/s when out of danger
   SMOKE_RADIUS: 400,
   SMOKE_DURATION: 8,          // default emission time when a class doesn't configure one
   SMOKE_LIFE: 22,             // s a laid cloud stays opaque -- long enough to actually fight from
   DETECT_CONE: 40 * DEG,      // gun must roughly face target to fire
   THREAT_RANGE: 500,          // enemy shell within => "under fire"
   LOW_HP: 0.40,              // -> retreat
   CRIT_HP: 0.18,            // -> forced retreat / smoke
   REEF_SPEED_CAP: 0.5,       // shallow water hard-caps speed to this fraction of max
   SIM_DT: 1 / 60,
};

// ============ SHIP CLASSES ============
// Every class is one mover + a weapons loadout. Player (Bismarck) is beefier than the enemy BB.
// turretSlew (rad/s) = how fast turrets rotate to track the aim point. Speeds are deliberately
// arcade-high with unchanged turn rates, which is what makes the anchor turn (Space) matter.
//
// Per-class data is the single hook for new ship types (torpedo boats, subs, carriers, coastal
// batteries...):
//   L / beam   hull footprint (m) -> hit boxes, citadel band, proximity spotting, rendering
//   turrets    [{x, guns}] along the keel; x > 0 trains from the bow, x < 0 from the stern,
//              each can swing HANDLING.turretArc either side of that home direction
//   main.ammo  optional {AP:{...}, HE:{...}} shell types; without it `main` is the only shell
//   torp       optional; `launchers` = side mounts with firing arcs (deg, + = starboard),
//              without them a centreline mount that can fire in any direction
//   cons       consumables {repair, dc, smoke, boost} with charges / dur / cd
//   ai         behaviour profile read by ai.js (role, leash, smoke use, hidden-target tactics)
//   detect     concealment (m): enemies inside this radius spot the ship (WoWs model); smoke
//              hides it anyway unless they are inside its proximity radius
//   sight      optional cap on the ship's own spotting range; stealth optional detect multiplier
export const SHIPS = {
   DD: {
      key: 'DD', name: 'Zerstörer', color: '#6f8a9c', L: 120, beam: 13,
      hp: 975, maxSpeed: 141, turnRate: 0.36, turretSlew: 1.2, detect: 1450, prefRange: 550, flankDeg: 60, armor: 70,
      main: { guns: 2, caliber: 105, dmg: 70, reload: 1.8, range: 850, type: 'HE', ap: 0, vShell: 600, fire: 0.06 },
      turrets: [ { x: 36, guns: 1 }, { x: -36, guns: 1 } ],
      // a launch every ~25 s with a 3-fish fan: a real threat, but one a moving target can dodge
      torp: { tubes: 3, dmg: 900, speed: 200, range: 1150, salvo: 3, cd: 25, spread: 4 * DEG },
      cons: { smoke: { charges: 2, dur: 8, cd: 30 }, dc: { charges: 2, dur: 5, cd: 40 } },
      ai: { role: 'torpedo', commitTime: 130, smokeChance: 0.5, smokeHP: 0.75, huntHidden: true, torpSmoke: true },
   },
   LC: {
      key: 'LC', name: 'Kleinkreuzer', color: '#5f7f9a', L: 170, beam: 18,
      hp: 2250, maxSpeed: 108, turnRate: 0.27, turretSlew: 0.95, detect: 1900, prefRange: 900, flankDeg: 55, armor: 120,
      main: { guns: 6, caliber: 152, dmg: 95, reload: 3.1, range: 1200, type: 'HE', ap: 140, vShell: 620,
         ammo: { AP: { type: 'AP', dmg: 95, ap: 140, fire: 0 }, HE: { type: 'HE', dmg: 70, ap: 0, fire: 0.08 } } },
      turrets: [ { x: 50, guns: 2 }, { x: 32, guns: 2 }, { x: -48, guns: 2 } ],
      torp: null,
      cons: { smoke: { charges: 1, dur: 8, cd: 40 }, dc: { charges: 2, dur: 5, cd: 40 } },
      ai: { role: 'cruiser', commitTime: 150, smokeChance: 0.25, smokeHP: 0.6, smokeFire: true, reposition: true },
   },
   HC: {
      key: 'HC', name: 'Schwerkreuzer', color: '#4d6b86', L: 205, beam: 22,
      hp: 3600, maxSpeed: 90, turnRate: 0.23, turretSlew: 0.75, detect: 2150, prefRange: 1150, flankDeg: 55, armor: 150,
      main: { guns: 10, caliber: 203, dmg: 140, reload: 4.4, range: 1400, type: 'AP', ap: 200, vShell: 640,
         ammo: { AP: { type: 'AP', dmg: 140, ap: 200, fire: 0 }, HE: { type: 'HE', dmg: 95, ap: 0, fire: 0.10 } } },
      turrets: [ { x: 64, guns: 2 }, { x: 44, guns: 2 }, { x: -38, guns: 2 }, { x: -56, guns: 2 }, { x: -76, guns: 2 } ],
      torp: null,
      cons: { dc: { charges: 2, dur: 5, cd: 40 } },
      ai: { role: 'cruiser', commitTime: 170, reposition: true },
   },
   EB: {
      key: 'EB', name: 'Feindes Linienschiff', color: '#8a5a4a', L: 251, beam: 36,
      hp: 5700, maxSpeed: 75, turnRate: 0.18, turretSlew: 0.58, detect: 2500, prefRange: 1450, flankDeg: 45, armor: 240,
      main: { guns: 6, caliber: 356, dmg: 290, reload: 5.4, range: 1650, type: 'AP', ap: 300, vShell: 650 },
      turrets: [ { x: 66, guns: 3 }, { x: -66, guns: 3 } ],
      torp: null,
      cons: { dc: { charges: 3, dur: 6, cd: 40 } },
      reactionMult: 1.2, // heavier = slower to commit
      ai: { role: 'battleship', commitTime: 200, holdThrottle: 0.55 },
   },
   Bismarck: {
      key: 'Bismarck', name: 'Bismarck', color: '#3a4a55', L: 251, beam: 36,
      hp: 7800, maxSpeed: 90, turnRate: 0.21, turretSlew: 0.62, detect: 2400, prefRange: 0, flankDeg: 0, armor: 285,
      // Two shell types. AP: citadels on broadside targets, ricochets off angled ones,
      // over-pens thin hulls. HE: lower but reliable damage + fires -- the answer to destroyers
      // and bow-on battleships. Switching (1/2) costs `switchTime` of reload on loaded turrets.
      main: { guns: 8, caliber: 283, reload: 4.8, range: 1800, vShell: 650, switchTime: 2.0,
         dmg: 300, type: 'AP', ap: 280,
         ammo: {
            AP: { type: 'AP', dmg: 300, ap: 280, fire: 0 },
            HE: { type: 'HE', dmg: 175, ap: 0, fire: 0.14 },
         } },
      turrets: [ { x: 78, guns: 2 }, { x: 56, guns: 2 }, { x: -52, guns: 2 }, { x: -74, guns: 2 } ],
      sec:  { guns: 16, caliber: 105, dmg: 40, reload: 1.3, range: 1100, type: 'HE', ap: 0, vShell: 600, fire: 0.03, burst: 4 },
      aa:   { guns: 20, dps: 200, vsShip: 10, range: 700, reload: 0.15 },
      // Port + starboard launchers with independent reloads. A launcher only fires into its own
      // beam arc, so a torpedo attack means presenting a side to the target.
      torp: { tubes: 3, dmg: 1900, speed: 192, range: 1350, salvo: 3, cd: 30,
         launchers: [
            { id: 'port', label: 'BB', side: -1, arcMin: -155, arcMax: -25 },
            { id: 'stbd', label: 'StB', side: 1, arcMin: 25, arcMax: 155 },
         ] },
      // charges (Infinity = unlimited); cd starts once the active phase ends
      cons: {
         repair: { charges: 4, dur: 16, cd: 45, rate: 0.009 }, // heals from the restorable pool
         dc:     { charges: Infinity, dur: 8, cd: 35 },         // extinguish/pump out + immunity
         smoke:  { charges: 3, dur: 8, cd: 40 },
         boost:  { charges: Infinity, dur: 4, cd: 16, mult: 1.3 },
      },
      isPlayer: true,
   },
};

// ============ VISION / SMOKE ============
// Smoke blocks SIGHT, not projectiles. A ship inside or behind a cloud is unspotted unless an
// enemy is inside its proximity radius; firing the main battery "blooms" the shooter for a few
// seconds out to a caliber-dependent medium range. A ship sitting in smoke can still see OUT
// (there are no allied spotters in a 1-vs-fleet fight, so blinding the smoker would make smoke
// useless for the player).
export const VISION = {
   proxLengths: 2.5, proxMin: 300, proxMax: 700,         // proximity reveal = 2.5 hull lengths
   bloomTime: 6,                                         // s revealed after a main-battery salvo
   bloomPerCaliber: 5.5, bloomMin: 800, bloomMax: 1700,  // bloom range (m) = caliber(mm) * 5.5
   smokeEdge: 0.9,        // opaque fraction of a cloud's radius
   ghostTime: 15,         // s a "last known position" ghost stays on screen
   blindWindow: 12,       // s the AI keeps area-firing at a target it lost
   blindSpread: 4.0,      // dispersion multiplier for blind fire
   blindReloadMult: 2.2,  // blind fire cadence: reload x this
   blindMaxExtrap: 2.0,   // s of dead reckoning from the last seen course
   searchAfter: 10,       // s after losing contact before hunters move in on the smoke
};

// ============ WEAPON HANDLING ============
export const HANDLING = {
   alignTolPlayer: 3 * DEG,   // a player turret fires only once it points within this of the aim
   alignTolBot: 20 * DEG,
   turretArc: 145 * DEG,      // half-arc each turret can train away from its home direction
   rippleGap: 0.35,           // s between turrets in hold-to-ripple fire
   clickHold: 0.22,           // s: LMB held longer than this turns click-salvo into ripple fire
   torpSpread: { narrow: 2.5 * DEG, wide: 8 * DEG }, // angle between adjacent torpedoes
   // Plunging fire: a main-battery shell is only low enough to strike a hull (or an island) in the
   // last `hitWindow` of its flight, then splashes a little past the aim point. So shells arc over
   // ships (and rocks) in between, and a miss lands visibly instead of flying on across the map.
   hitWindow: 0.35,
   overshoot: 0.08,
   rangeSigma: 0.025,         // 1-sigma range dispersion as a fraction of the aimed range
   maxAimMult: 1.05,          // the player can't fire at points beyond range * this
};

// ============ DIFFICULTY ============
// Rider multipliers on bot accuracy / HP / damage. One-knob presets. sigmaDeg only scales the
// *bots'* aim; the player's dispersion is fixed.
export const DIFFICULTY = {
   easy:   { reactionTime: 1.6, leadQuality: 0.30, sigmaDeg: 2.2,  salvoMult: 0.6, detectMult: 0.8,  botHP: 0.8,  botDmg: 0.7 },
   normal: { reactionTime: 0.9, leadQuality: 0.70, sigmaDeg: 0.55, salvoMult: 1.0, detectMult: 1.0,  botHP: 1.0,  botDmg: 0.72 },
   hard:   { reactionTime: 0.30, leadQuality: 1.0,  sigmaDeg: 0.2,  salvoMult: 1.15, detectMult: 1.15, botHP: 1.2,  botDmg: 1.0 },
};

// ============ ENCOUNTER ============
// Default mission: one wave, 5 bots, Bismarck at origin facing +x (east). Spawn ring 2000 m so the
// first shots come quickly. `new World(diff, seed, mission)` can override bots/pressure/obstacles.
export const ENCOUNTER = {
   ring: 2000,
   bots: [
      { cls: 'EB', bearing: 0 },          // dead ahead — the duel
      { cls: 'HC', bearing: 110 * DEG },  // right flank / rear
      { cls: 'LC', bearing: -110 * DEG }, // left flank / rear
      { cls: 'DD', bearing: 55 * DEG },   // front-right, pounce
      { cls: 'DD', bearing: -55 * DEG },  // front-left, pounce
   ],
   // Optional pressure wave at 60s if any enemy survives:
   pressureAt: 60,
   pressure: [ { cls: 'DD', bearing: 30 * DEG }, { cls: 'DD', bearing: -30 * DEG } ],
};

// ============ MAP / OBSTACLES ============
// Islands are solid rock (ships bounce off, descending shells and torpedoes detonate on them);
// reefs are shallow water (slow you down, no cover). Placed across the middle of the arena with
// >=700m clearance to every spawn point.
export const OBSTACLES = [
   { kind: 'island', c: { x: -1082, y: 389 },  r: 450, irregular: true },
   { kind: 'island', c: { x: 731,   y: -796 }, r: 380, irregular: true },
   { kind: 'island', c: { x: -539,  y: -842 }, r: 260, irregular: true },
   { kind: 'island', c: { x: 260,   y: 966 },  r: 300, irregular: true },
   { kind: 'reef',   c: { x: 1071,  y: 307 },  r: 320 },
   { kind: 'reef',   c: { x: -1558, y: -1418 }, r: 280 },
   { kind: 'reef',   c: { x: -6,    y: -1569 },r: 240 },
];

// ============ COMBAT / DAMAGE MODEL ============
// Bouncing shells + citadel = the core WoWs "feel".
export const COMBAT = {
   // penetration: pPen = 1/(1+exp(-margin/penK)); margin = effAP/armor - 1,
   // effAP = ap * (1 - 0.5 * glance), glance = 1 - |cos(incidence)|
   penK: 0.18,
   // AP ricochet vs the belt: none below ricStart incidence, certain above ricAuto. Overmatch:
   // armour thinner than ap * overmatch can't deflect the shell at all (big guns vs destroyers).
   ricStart: 45 * DEG, ricAuto: 62 * DEG, overmatch: 0.35,
   overPen: 1.5,          // margin above this => through-and-through, no citadel
   overPenMult: 0.33,     // ...for a third of the shell's damage (thin hulls shrug off AP)
   citadelLen: 0.40,      // citadel = central fraction of the hull length
   citadelMult: 1.35,
   concentration: { minShells: 4, mult: 1.5 }, // salvo piling into the citadel within 1.5s
   grazeMult: 0.4,        // penetrating hit outside the citadel
   // HE doesn't bounce but heavy belts soak part of it: dmg * clamp(heBase - armor/heArmorDiv)
   heBase: 1.15, heArmorDiv: 500, heMin: 0.55,
   heFireDefault: 0.12,
   // Fire/flood are a fraction of the burning ship's max HP per second (times the igniter's
   // difficulty dmgMult) with a finite burn time: a flat 100 HP/s used to delete a destroyer in
   // 10s while barely tickling the Bismarck. Damage control (E) is the counter.
   fire: { rate: 0.004, dur: 30, max: 3, spread: 6, spreadP: 0.25 },
   flood: { rate: 0.006, dur: 25, max: 2, slow: 0.06 },
   torpCentralMult: 1.30, // central third of the hull on a torpedo
   torpFlood: 0.5,
   igniteFire: 0.05,      // extra fire chance on an AP citadel hit
   // what fraction of each damage type the repair party can later restore
   restorable: { citadel: 0.1, main: 0.5, secondary: 0.5, fire: 1.0, flood: 1.0, torpedo: 0.33, aa: 1.0, gun: 0.5 },
};

// ============ COLORS / PALETTE ============
export const PALETTE = {
   seaDeep: '#0e3350',
   seaMid: '#124062',
   seaShallow: '#1f5f86',
   foam: '#bfe3ff',
   sun: '#ffd48a',
   sunGlow: 'rgba(255,210,140,0.16)',
   skyTop: '#0a1830',
   skyHorizon: '#2a4a6a',
   ship: '#46555f',
   shipDark: '#2b363e',
   deck: '#5a6b74',
   fire: '#ff7a2d',
   fireCore: '#ffd24a',
   smoke: 'rgba(120,120,120,0.5)',
   enemy: '#c65a4a',
   friendly: '#4ad07a',
   danger: '#ff4d3d',
};

// ============ TUNING ============
export const TUNE = {
   waveHeight: 0.05,      // 0..1 sea roughness
   timeOfDay: 0.75,       // 0..1 day cycle (0.75 = late afternoon, golden)
   fogDist: 2600,         // m; beyond this, fade to horizon color
   shellLife: 8,         // s before a stray shell despawns
   maxProjectiles: 400,
   maxParticles: 1400,
   // Fixed camera: the view is sized so ~CAM_VIEW m fit in the half of the smaller screen
   // dimension, then the camera leans toward the cursor so the aimed-at side reaches past main
   // battery range. No zoom controls -- the minimap is the overview.
   camView: 1050,
   camLookMouse: 0.55,    // fraction of the cursor's screen offset the camera leans toward
   camLookMax: 720,       // m cap on that lean
   camLookHeading: 90,    // m of lean along the heading
};
