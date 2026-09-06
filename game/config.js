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
   SMOKE_DURATION: 8,
   SMOKE_CD: 25,
   DETECT_CONE: 40 * DEG,      // gun must roughly face target to fire
   THREAT_RANGE: 500,          // enemy shell within => "under fire"
   LOW_HP: 0.40,              // -> retreat
   CRIT_HP: 0.18,            // -> forced retreat / smoke
   REEF_SPEED_CAP: 0.5,       // shallow water hard-caps speed to this fraction of max
   SIM_DT: 1 / 60,
};

// ============ SHIP CLASSES ============
// Every class is one mover + a weapons loadout. Player (Bismarck) is beefier than the enemy BB.
// gunRange / torpRange are effective engagement distances (m). salvo = shells fired together.
export const SHIPS = {
   DD: {
      key: 'DD', name: 'Zerstörer', color: '#6f8a9c',
      hp: 650, maxSpeed: 27, turnRate: 0.22, detect: 3200, prefRange: 550, flankDeg: 60, armor: 70,
      main: { guns: 4, caliber: 105, dmg: 70, reload: 3.0, range: 850, type: 'HE', ap: 0, vShell: 600 },
      torp: { tubes: 6, dmg: 1200, speed: 40, range: 1000, salvo: 2, cd: 12 },
      fire: 0.5, // smoke chance when pressured
   },
   LC: {
      key: 'LC', name: 'Kleinkreuzer', color: '#5f7f9a',
      hp: 1500, maxSpeed: 21, turnRate: 0.16, detect: 2800, prefRange: 900, flankDeg: 55, armor: 120,
      main: { guns: 6, caliber: 152, dmg: 95, reload: 5.0, range: 1200, type: 'AP', ap: 140, vShell: 620 },
      torp: null,
      fire: 0.25,
   },
   HC: {
      key: 'HC', name: 'Schwerkreuzer', color: '#4d6b86',
      hp: 2400, maxSpeed: 18.5, turnRate: 0.13, detect: 2800, prefRange: 1150, flankDeg: 55, armor: 150,
      main: { guns: 10, caliber: 203, dmg: 140, reload: 6.0, range: 1400, type: 'AP', ap: 200, vShell: 640 },
      torp: null,
      fire: 0.2,
   },
   EB: {
      key: 'EB', name: 'Feindes Linienschiff', color: '#8a5a4a',
      hp: 3800, maxSpeed: 15.5, turnRate: 0.10, detect: 2900, prefRange: 1450, flankDeg: 45, armor: 240,
      main: { guns: 6, caliber: 356, dmg: 320, reload: 8.0, range: 1650, type: 'AP', ap: 300, vShell: 650 },
      torp: null,
      reactionMult: 1.2, // heavier = slower to commit
   },
   Bismarck: {
      key: 'Bismarck', name: 'Bismarck', color: '#3a4a55',
      hp: 5200, maxSpeed: 18, turnRate: 0.11, detect: 2600, prefRange: 0, flankDeg: 0, armor: 260,
      main: { guns: 8, caliber: 283, dmg: 300, reload: 7.5, range: 1800, type: 'AP', ap: 280, vShell: 650, salvoAssist: 3.0 },
      sec:  { guns: 16, caliber: 105, dmg: 40, reload: 2.0, range: 1100, type: 'HE', ap: 0, vShell: 600 },
      aa:   { guns: 20, dps: 200, range: 700, reload: 0.15 },
      torp: null, // Bismarck historically had no torpedoes; 'T' fires a special overload salvo instead
      boost: { mult: 1.35, dur: 2.5, cd: 12 },
      isPlayer: true,
   },
};

// ============ DIFFICULTY ============
// Rider multipliers on bot accuracy / HP / damage. One-knob presets.
// Retuned after tightening player shell dispersion + fixing movement/pursuit (a real
// player -- and the headless test pilot -- now closes distance and lands hits far more
// reliably on EVERY difficulty, since sigmaDeg only scales the *bots'* aim, not the
// player's). Without compensating here the curve went nearly flat (~90/86/82% win rate).
// botDmg/sigmaDeg pushed harder on normal/hard to restore real separation.
export const DIFFICULTY = {
   easy:   { reactionTime: 1.6, leadQuality: 0.30, sigmaDeg: 2.2,  salvoMult: 0.6, detectMult: 0.8,  botHP: 0.8,  botDmg: 0.6 },
   normal: { reactionTime: 0.9, leadQuality: 0.70, sigmaDeg: 0.55, salvoMult: 1.0, detectMult: 1.0,  botHP: 1.0,  botDmg: 1.15 },
   hard:   { reactionTime: 0.30, leadQuality: 1.0,  sigmaDeg: 0.2,  salvoMult: 1.3, detectMult: 1.15, botHP: 1.2,  botDmg: 1.6 },
};

// ============ ENCOUNTER ============
// One wave, 5 bots. Bismarck at origin facing +x (east). Spawn ring radius 2600 m.
// All enemies visible but out of firing reach at t=0 — you close on the duel.
export const ENCOUNTER = {
   ring: 2600,
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
// Islands are solid rock (ships bounce off, shells/torps detonate on impact) and block
// line of sight for aiming; reefs are shallow water (slow you down, no LOS block).
// Placed across the MIDDLE of the arena -- where the actual brawl happens -- with >=700m
// clearance to every bot/player spawn point (ai.js's obstacle-avoidance kicks in within
// 300m, so anything closer than that plus travel distance would shove a bot off its
// approach vector before the fight even starts). Real cover: duck the Bismarck behind
// one to break a citadel angle, or use them to screen a torpedo run.
export const OBSTACLES = [
   { kind: 'island', c: { x: -1082, y: 389 },  r: 450, irregular: true },
   { kind: 'island', c: { x: 731,   y: -796 }, r: 380, irregular: true },
   { kind: 'island', c: { x: -539,  y: -842 }, r: 260, irregular: true },
   { kind: 'island', c: { x: 260,   y: 966 },  r: 300, irregular: true },
   { kind: 'reef',   c: { x: 1071,  y: 307 },  r: 320 },
   { kind: 'reef',   c: { x: -605,  y: 1478 }, r: 280 },
   { kind: 'reef',   c: { x: -6,    y: -1569 },r: 240 },
];

// ============ COMBAT / DAMAGE MODEL ============
// Bouncing shells + citadel = the core WoWs "feel". Retuning shells never cascades.
export const COMBAT = {
   // penetration: pPen = 1/(1+exp(-margin/0.18)); margin = (pen - armor)/armor
   // pen = shell.ap * (0.45 + 0.55 * glance)  where glance = clamp(incidence/45deg,0,1)
   penK: 0.18,
   overPen: 1.2,       // margin > 1.2 => through-and-through, dmg x0.5, no citadel
   // citadel: central fraction of length, full beam
   citadelLen: 0.40,
   citadelMult: 1.35,  // a citadel hit does this x base damage
   concentration: {    // when a salvo concentrates in the citadel: bonus
      minShells: 4, mult: 1.5, // up to +50% bonus for concentration
   },
   // damage types
   fire: { perModule: 220, max: 4, spread: 6, spreadP: 0.5 },  // 220 HP/s/module, can jump modules
   flood: { perModule: 120, max: 3, slow: 0.06 },             // 120 HP/s, -6% top speed per flood
   torpCentralMult: 1.30,  // central third of the hull on a torpedo
   // shell impact: a hit that bounces does 0 but splashes; a penetration that misses citadel is "grazed"
   grazeMult: 0.4,        // a penetrating non-citadel hit still does this fraction
   // fire/flood ignition chance on a penetrating citadel hit
   igniteFire: 0.10,
   igniteFlood: 0.06,
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
// How many shells per main salvo the player/bot can "concentrate" — used for concentration bonus.
export const TUNE = {
   waveHeight: 0.05,      // 0..1 sea roughness
   timeOfDay: 0.75,       // 0..1 day cycle (0.75 = late afternoon, golden)
   fogDist: 2600,         // m; beyond this, fade to horizon color
   shellLife: 8,         // s before a stray shell despawns
   maxProjectiles: 400,
   maxParticles: 1400,
};
