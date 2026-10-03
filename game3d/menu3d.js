// game3d/menu3d.js — the port (orders, briefing, ship dossier, fleet register) and the battle report.
// Self-contained UI component: injects its own <style>, renders into the #menu / #end overlays
// and hands the chosen { mission, ship, difficulty } to main3d via callbacks. Reads the menu
// data the sim exports (MISSIONS, SHIP_STATS, SHIPS) and never touches the running world.
import { MISSIONS, getMission, opStars } from './missions.js';
import { SHIPS, SHIP_STATS, PLAYABLE, shipStats, NATIONS, NATION_SHORT } from './config.js';
import { loadProfile, saveProfile, defaultProfile, UNLOCK_XP, UNLOCK_CREDITS, unlockNeeds, MODULES, SKILLS, captainLevel, skillPointsFree, isUnlocked, canUnlock,
   unlockShip, moduleTier, moduleCost, buyModule, learnSkill, respecSkills, grantRewards, loadoutFor, applyLoadout } from './progress3d.js';
import { classSvg } from './hud.js';
import { logoSvg } from './theme.js';

const TYPE_LABEL = {
   training: 'Übung', annihilation: 'Vernichtung', domination: 'Seeraum', escort: 'Geleitschutz',
   historic: 'Historisch', survival: 'Überleben', raid: 'Handelskrieg',
   defense: 'Verteidigung', delay: 'Nachhut', fleet: 'Flottenschlacht', breakout: 'Durchbruch',
   torpedo: 'Torpedoangriff', harbour: 'Hafenüberfall',
};
const TIME_LABEL = { day: 'Tag', dawn: 'Morgengrauen', dusk: 'Abenddämmerung', night: 'Nacht' };
const WEATHER_LABEL = { clear: 'Klar', overcast: 'Bewölkt', rain: 'Regen', storm: 'Sturm' };
const DIFFS = [['easy', 'Einfach'], ['normal', 'Normal'], ['hard', 'Schwer']];
const RATING_LABEL = [
   ['firepower', 'Feuerkraft'], ['survivability', 'Überlebensfähigkeit'], ['mobility', 'Manövrierbarkeit'],
   ['concealment', 'Tarnung'], ['torpedoes', 'Torpedos'], ['antiAir', 'Flugabwehr'],
];
const RIBBON_ORDER = ['kill', 'citadel', 'pen', 'overpen', 'he', 'sec', 'torp', 'fire', 'flood', 'ricochet', 'shatter', 'spotted', 'cap'];
const ESCAPE_LABEL = { arrived: 'angekommen', retreated: 'abgelaufen', escaped: 'entkommen' };
const STORE_KEY ='warships3d.progress.v1';
const CLASS_ORDER = { CV: 0, BB: 1, CA: 2, CL: 3, DD: 4, SS: 5 };
const natOf = (k) => SHIPS[k]?.hull?.nation || 'de';
// register tabs: two-letter codes (the full navy name is the tooltip)
const NAT_CODE = { de: 'DE', uk: 'GB', us: 'US', jp: 'JP', fr: 'FR', it: 'IT', su: 'SU' };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtInt = (n) => Math.round(n || 0).toLocaleString('de-DE');
// module tier effects as short German text, e.g. "−5 % Nachladen · −4 % Streuung"
const FX_LABEL = { reload: 'Nachladen', disp: 'Streuung', speed: 'Tempo', accel: 'Beschl.', rudder: 'Ruder', hp: 'HP', range: 'Reichweite' };
const modFx = (tier) => Object.entries(tier || {}).map(([k, v]) => `${v < 0 ? '−' : '+'}${Math.round(Math.abs(v) * 100)} % ${FX_LABEL[k] || k}`).join(' · ');
const mmss = (s) => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

// ---------------------------------------------------------------- icons (inline SVG, no assets)
const ICON = {
   day: '<circle cx="12" cy="12" r="4.6"/><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></g>',
   dawn: '<path d="M5 17a7 7 0 0 1 14 0Z"/><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 20h20M12 4v3M4.5 9.5l2 1.6M19.5 9.5l-2 1.6"/></g>',
   dusk: '<path d="M5 17a7 7 0 0 1 14 0Z" opacity=".75"/><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 20h20M12 7V4M9.5 5.5 12 8l2.5-2.5"/></g>',
   night: '<path d="M15.5 3.2a8.6 8.6 0 1 0 5.3 13.9A7 7 0 0 1 15.5 3.2Z"/>',
   clear: '<circle cx="12" cy="12" r="3" opacity=".0"/>',
   overcast: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.7A3.7 3.7 0 0 1 17.3 18.5Z"/>',
   rain: '<path d="M7 14.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.7 3.7 3.7 0 0 1-.5 7.3Z"/><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/></g>',
   storm: '<path d="M7 13.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.7 3.7 3.7 0 0 1-.5 7.3Z"/><path d="M12.5 12.5 9.5 17.5h3l-1.5 4.5 4.5-6h-3l1.5-3.5Z" fill="#ffd166"/>',
   lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2"/>',
   clock: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5.3l3.4 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
   map: '<path d="M3 6.5 8.5 4l7 2.5L21 4v13.5L15.5 20l-7-2.5L3 20Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8.5 4v13.5M15.5 6.5V20" stroke="currentColor" stroke-width="1.4"/>',
   check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
};
const icon = (k, size = 18) => `<svg class="m3-ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor">${ICON[k] || ''}</svg>`;
const MEDAL = ['', 'Bronzene Spange', 'Silberne Spange', 'Goldene Spange'];
const stars = (n) => '<span class="m3-stars">' + [1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}">★</i>`).join('') + '</span>';

// Side-view silhouette straight from the sim's hull config (bow to the right), scaled so the
// line-up shows the real size differences between a destroyer and a battleship.
function silhouetteSvg(key, w = 190, h = 58) {
   const c = SHIPS[key];
   if (!c) return '';
   const H = c.hull, L = H.L, maxL = 272;
   const s = (w - 8) / maxL * Math.max(0.62, 1);
   const len = L * s, x0 = (w - len) / 2, wl = h * 0.7;
   const X = (x) => x0 + (x + L / 2) * s;                  // ship-local metres -> px
   const deck = Math.max(4, H.deckH * s * 0.9), draft = Math.max(2.5, (H.draft || 6) * s * 0.9);
   const bowRise = deck * 0.45;
   let p = `<path class="hull" d="M${X(-L / 2).toFixed(1)} ${(wl - deck).toFixed(1)} L${X(L * 0.3).toFixed(1)} ${(wl - deck).toFixed(1)} `
      + `Q${X(L * 0.46).toFixed(1)} ${(wl - deck - bowRise * 0.6).toFixed(1)} ${X(L / 2).toFixed(1)} ${(wl - deck - bowRise).toFixed(1)} `
      + `L${X(L * 0.45).toFixed(1)} ${(wl + draft).toFixed(1)} L${X(-L * 0.46).toFixed(1)} ${(wl + draft).toFixed(1)} `
      + `Q${X(-L / 2).toFixed(1)} ${(wl + draft * 0.2).toFixed(1)} ${X(-L / 2).toFixed(1)} ${(wl - deck).toFixed(1)}Z"/>`;
   const top = wl - deck;
   if (H.sup) {
      const sx = H.sup.x, sl = H.sup.len, sh = H.sup.h * s * 0.8;
      p += `<rect x="${X(sx - sl / 2).toFixed(1)}" y="${(top - sh * 0.55).toFixed(1)}" width="${(sl * s).toFixed(1)}" height="${(sh * 0.55 + 0.5).toFixed(1)}"/>`;
      // conning tower + mast at the front of the superstructure
      const tx = sx + sl * 0.28;
      p += `<rect x="${X(tx - sl * 0.1).toFixed(1)}" y="${(top - sh).toFixed(1)}" width="${(sl * 0.2 * s).toFixed(1)}" height="${(sh * 0.5).toFixed(1)}"/>`;
      p += `<rect x="${(X(tx) - 0.7).toFixed(1)}" y="${(top - sh * 1.55).toFixed(1)}" width="1.4" height="${(sh * 0.6).toFixed(1)}"/>`;
   }
   for (const f of H.funnels || []) {
      const fh = f.h * s * 0.95, fw = Math.max(2.4, f.r * 2 * s);
      p += `<rect x="${(X(f.x) - fw / 2).toFixed(1)}" y="${(top - fh).toFixed(1)}" width="${fw.toFixed(1)}" height="${fh.toFixed(1)}" rx="1"/>`;
   }
   const m = c.main, tw = Math.max(3.5, m.caliber * 0.03 * s * 3.2), th = Math.max(2.2, tw * 0.42);
   for (const t of m.turrets) {
      const x = X(t.off.x), aft = t.off.x < 0;
      const raised = m.turrets.some(o => o !== t && Math.sign(o.off.x) === Math.sign(t.off.x) && Math.abs(o.off.x) > Math.abs(t.off.x));
      const y = top - th - (raised ? th * 0.9 : 0);
      if (raised) p += `<rect x="${(x - tw * 0.35).toFixed(1)}" y="${(y + th).toFixed(1)}" width="${(tw * 0.7).toFixed(1)}" height="${(th * 0.9 + 0.5).toFixed(1)}"/>`;
      p += `<rect x="${(x - tw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${tw.toFixed(1)}" height="${th.toFixed(1)}" rx="1"/>`;
      const bl = tw * 0.9, by = y + th * 0.4;
      p += `<rect x="${(aft ? x - tw / 2 - bl : x + tw / 2).toFixed(1)}" y="${by.toFixed(1)}" width="${bl.toFixed(1)}" height="1.1"/>`;
   }
   return `<svg class="m3-sil" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet"><line class="wl" x1="0" x2="${w}" y1="${wl}" y2="${wl}"/><g>${p}</g></svg>`;
}

// ---------------------------------------------------------------- persistence (per viewer)
function loadProgress() {
   try { const j = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); if (j && typeof j === 'object') return j; } catch (e) { /* private mode */ }
   return { missions: {}, xp: 0, credits: 0, sel: null };
}
function saveProgress(p) { try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ } }

// ---------------------------------------------------------------- style
const CSS = `
/* Port "Kartenhaus" (colours and type: the tokens in index-3d.html). A navy masthead with a brass
   double rule; orders as paper index cards on the left; the briefing sheet, the ship dossier and
   the order bar (opponent strength + AUSLAUFEN) in the middle; the fleet register on the right. */
.m3 { position:absolute; inset:0; z-index:20; display:flex; flex-direction:column; color:var(--ink); font-family:var(--font); --cls-bar:var(--paper-2);
   background:linear-gradient(90deg, rgba(9,15,19,.88), rgba(9,15,19,.42) 25%, rgba(9,15,19,.26) 50%, rgba(9,15,19,.42) 75%, rgba(9,15,19,.88));
   pointer-events:auto; user-select:none; }
.m3 * { box-sizing:border-box; }
.m3-ic { flex:none; vertical-align:middle; }
.m3 .cls { vertical-align:-1px; }
.m3-top { flex:none; height:64px; display:flex; align-items:center; gap:18px; padding:0 20px; color:var(--paper);
   background:var(--navy); border-bottom:3px double var(--brass); box-shadow:0 8px 24px rgba(0,0,0,.35); }
.m3-left { flex:1; min-width:0; display:flex; align-items:center; gap:10px; }
.m3-logo { margin-right:16px; }
.m3-logo .ks-logo svg { height:38px; } .m3-logo .ks-logo .wm b { font-size:23px; }
.m3-capt { cursor:pointer; position:relative; height:34px; border:1px solid rgba(226,189,110,.42); padding:0 12px; background:transparent; color:var(--brass-hi);
   font:600 12px var(--font); letter-spacing:2px; white-space:nowrap; }
.m3-capt:hover { background:var(--navy-2); color:var(--paper); }
.m3-capt b { display:inline-block; margin-left:8px; padding:1px 6px; background:var(--brass); color:var(--navy); font-weight:700; letter-spacing:0; }
.m3-capt i { position:absolute; top:-8px; right:-8px; min-width:18px; height:18px; border-radius:50%; background:var(--signal); color:var(--flag-w);
   font:700 10.5px/18px var(--font); font-style:normal; letter-spacing:0; text-align:center; box-shadow:0 0 0 2px var(--navy); }
.m3-right { display:flex; justify-content:flex-end; align-items:center; gap:14px; }
.m3-purse { display:flex; font:600 10px var(--font); letter-spacing:2px; text-transform:uppercase; color:var(--hud-dim); font-variant-numeric:tabular-nums; }
.m3-purse span { display:flex; flex-direction:column; align-items:flex-end; gap:2px; padding:0 14px; border-left:1px solid rgba(226,189,110,.3); }
.m3-purse b { font:600 17px/1 var(--font); letter-spacing:.5px; color:var(--paper); }
.m3-help { cursor:pointer; flex:none; width:34px; height:34px; border-radius:50%; border:1px solid rgba(226,189,110,.5); background:transparent; color:var(--brass-hi);
   font:italic 700 17px var(--font-serif); }
.m3-help:hover { background:var(--navy-2); color:var(--paper); }

.m3-main { flex:1; min-height:0; display:grid; grid-template-columns:300px minmax(0,1fr) 340px; gap:20px; padding:16px 20px; }
.m3-col, .m3-mid, .m3-dock { min-width:0; min-height:0; display:flex; flex-direction:column; gap:8px; }
.m3-mid { gap:14px; padding-top:4px; }
.m3-h { font:600 10.5px var(--font); letter-spacing:2.5px; color:var(--ink-2); text-transform:uppercase; padding:0 0 4px; margin-bottom:4px;
   display:flex; justify-content:space-between; gap:10px; border-bottom:1px solid var(--ink-2); }
.m3-col > .m3-h, .m3-dock > .m3-h { color:var(--brass-hi); border-color:rgba(226,189,110,.45); margin-bottom:0; text-shadow:0 1px 2px rgba(0,0,0,.8); }

/* orders: paper index cards, the selected one pulled out with a signal-red edge */
.m3-list { overflow-y:auto; overflow-x:hidden; display:flex; flex-direction:column; gap:5px; padding:2px 12px 4px 0; scrollbar-width:thin; scrollbar-color:var(--brass) transparent; }
.m3-mis { position:relative; flex:none; cursor:pointer; padding:7px 10px 7px 15px; background:var(--paper-2); border:1px solid var(--paper-edge); color:var(--ink);
   transition:transform .12s, background .12s; }
.m3-mis::before { content:''; position:absolute; left:0; top:0; bottom:0; width:5px; background:var(--ink-3); opacity:.3; }
.m3-mis:hover { background:var(--paper); transform:translateX(3px); }
.m3-mis.sel { background:var(--paper); transform:translateX(10px); border-color:var(--ink-2); box-shadow:0 5px 16px rgba(0,0,0,.45); }
.m3-mis.sel::before { background:var(--signal); opacity:1; }
.m3-mis.op::before { background:var(--brass); opacity:1; }
.m3-mis .n { font:600 14.5px/1.2 var(--font); display:flex; align-items:center; gap:6px; }
.m3-mis .s { font:italic 12px/1.3 var(--font-serif); color:var(--ink-2); margin-top:1px; }
.m3-mis .row { display:flex; align-items:center; gap:7px; margin-top:4px; font-size:11px; color:var(--ink-2); }
.m3-mis .tag { padding:0 5px; border:1px solid currentColor; font:600 9.5px/15px var(--font); letter-spacing:1.2px; text-transform:uppercase; color:var(--signal-lo); }
.m3-mis .done { margin-left:auto; color:var(--seal); display:flex; align-items:center; gap:3px; font:700 10px var(--font); letter-spacing:1px; text-transform:uppercase; }
.m3-sec { margin:12px 0 2px; padding:7px 2px 0; border-top:3px double var(--brass); font:600 10.5px var(--font); letter-spacing:2.5px; color:var(--brass-hi);
   text-transform:uppercase; text-shadow:0 1px 2px rgba(0,0,0,.8); }
.m3-medal { margin-left:auto; color:var(--brass-lo); letter-spacing:1px; }
.m3-medal i { font-style:normal; opacity:.25; } .m3-medal i.on { opacity:1; }
.m3-stars { letter-spacing:1px; }
.m3-stars i { font-style:normal; font-size:9px; color:rgba(27,42,53,.22); } .m3-stars i.on { color:var(--signal); }

/* paper sheets: briefing and ship dossier (printed-form double rule inside the edge) */
.m3-brief, .m3-ship, .m3-op .box { color:var(--ink); background:var(--paper); border:1px solid var(--paper-edge);
   box-shadow:inset 0 0 0 5px var(--paper), inset 0 0 0 6px var(--paper-edge), 0 0 0 3px var(--navy), 0 0 0 4px rgba(180,138,60,.75), 0 14px 40px rgba(0,0,0,.45); }
.m3-brief { flex:none; max-height:40%; overflow:auto; padding:16px 24px 14px; scrollbar-width:thin; }
.m3-brief .k { font:600 10px var(--font); letter-spacing:3px; color:var(--signal-lo); text-transform:uppercase; }
.m3-brief .t { font:700 30px/1.05 var(--font-cond); letter-spacing:2px; text-transform:uppercase; margin-top:3px; }
.m3-brief .st { font:italic 14px/1.3 var(--font-serif); color:var(--ink-2); margin-top:3px; }
.m3-brief .chips { display:flex; flex-wrap:wrap; margin:10px 0 9px; border-top:1px solid var(--ink-2); border-bottom:1px solid var(--ink-2); }
.m3-brief .chip3 { display:flex; align-items:center; gap:5px; font:500 12px var(--font); padding:5px 12px 5px 0; margin-right:12px; border-right:1px solid var(--rule); white-space:nowrap; }
.m3-brief .chip3:last-child { border-right:0; }
.m3-brief p { font:14px/1.55 var(--font-serif); color:var(--ink); }
.m3-ship { flex:1; min-height:0; overflow:auto; scrollbar-width:thin; padding:16px 22px; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:0 26px; align-content:start; }
.m3-ship > div { min-width:0; }
.m3-ship .nm { font:700 30px/1.05 var(--font-cond); letter-spacing:1.5px; text-transform:uppercase; display:flex; align-items:center; gap:9px; }
.m3-ship .cl { font:500 12px/1.5 var(--font); color:var(--ink-2); margin:4px 0 8px; }
.m3-ship .cl b { color:var(--paper); background:var(--ink); padding:1px 6px; font-weight:600; letter-spacing:1px; }
.m3-ship .ds { font:italic 13px/1.45 var(--font-serif); color:var(--ink-2); margin:0 0 10px; }
.m3-ship .bars { display:flex; flex-direction:column; gap:6px; margin:6px 0 10px; }
.m3-bar { font:500 11.5px var(--font); color:var(--ink-2); }
.m3-bar .l { display:flex; justify-content:space-between; margin-bottom:3px; }
.m3-bar .l span:last-child { font-weight:700; color:var(--ink); font-variant-numeric:tabular-nums; }
.m3-bar .b { height:8px; background:rgba(27,42,53,.14);
   -webkit-mask:repeating-linear-gradient(90deg, #000 0 calc(10% - 2px), transparent calc(10% - 2px) 10%); mask:repeating-linear-gradient(90deg, #000 0 calc(10% - 2px), transparent calc(10% - 2px) 10%); }
.m3-bar .b i { display:block; height:100%; background:var(--navy-3); }
.m3-kv { display:grid; grid-template-columns:auto 1fr; font:12px var(--font); }
.m3-kv span { padding:3px 0; border-bottom:1px dotted rgba(27,42,53,.32); }
.m3-kv span:nth-child(odd) { color:var(--ink-2); padding-right:12px; }
.m3-kv span:nth-child(even) { text-align:right; color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums; }
.m3-cons { display:flex; flex-wrap:wrap; gap:5px; margin-top:10px; }
.m3-cons span { font:600 10px var(--font); letter-spacing:1px; padding:3px 7px; border:1px solid var(--ink-2); text-transform:uppercase; }
.m3-prog { margin-top:14px; }
.m3-mod { display:grid; grid-template-columns:92px 36px minmax(0,1fr) auto; align-items:center; gap:6px; font:11.5px var(--font); padding:3px 0; border-bottom:1px dotted rgba(27,42,53,.28); }
.m3-mod .n { font-weight:600; } .m3-mod .fx { color:var(--ink-2); font-size:10.5px; } .m3-mod .max { color:var(--seal); font-size:10px; font-weight:700; letter-spacing:1.5px; }
.m3-pips { display:flex; gap:3px; } .m3-pips i { width:8px; height:8px; border:1px solid var(--ink-2); transform:rotate(45deg); } .m3-pips i.on { background:var(--ink); }
.m3-buy { cursor:pointer; border:1px solid var(--ink-2); padding:3px 8px; background:var(--paper-2); color:var(--ink); font:600 11px var(--font); font-variant-numeric:tabular-nums; }
.m3-buy:hover:not(:disabled) { background:var(--ink); color:var(--paper); } .m3-buy:disabled { opacity:.4; cursor:not-allowed; }
.m3-buy.big { width:100%; padding:9px; font-size:12.5px; letter-spacing:1.5px; color:var(--paper); border-color:var(--navy); background:var(--navy-2); }
.m3-buy.big:hover:not(:disabled) { background:var(--navy); }
.m3-prog .hint { font:italic 12px/1.4 var(--font-serif); color:var(--signal-lo); margin-top:6px; text-align:center; }

/* order bar */
.m3-orders { flex:none; display:flex; align-items:stretch; gap:16px; min-height:58px; }
.m3-diff { flex:none; display:flex; align-items:center; padding-left:12px; background:var(--navy); border:1px solid rgba(226,189,110,.42); }
.m3-diff > span { font:600 9.5px var(--font); letter-spacing:2px; color:var(--hud-dim); text-transform:uppercase; margin-right:10px; }
.m3-diff button { cursor:pointer; align-self:stretch; border:0; border-left:1px solid rgba(226,189,110,.25); padding:0 14px; background:transparent; color:var(--hud-dim);
   font:600 12px var(--font); letter-spacing:1px; text-transform:uppercase; }
.m3-diff button:hover { color:var(--paper); }
.m3-diff button.sel { color:var(--navy); background:var(--brass-hi); }
.m3-battle { flex:1; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:16px; padding:0 28px; border:1px solid var(--signal-lo);
   font:700 26px/1 var(--font-cond); letter-spacing:9px; text-indent:9px; color:var(--flag-w); background:var(--signal);
   box-shadow:inset 0 0 0 3px var(--signal), inset 0 0 0 4px rgba(255,235,200,.55), 0 0 0 3px var(--navy), 0 0 0 4px var(--brass), 0 10px 30px rgba(0,0,0,.45);
   transition:filter .12s; }
.m3-battle::after { content:''; flex:none; width:28px; height:14px; background:currentColor; clip-path:polygon(0 36%,66% 36%,66% 0,100% 50%,66% 100%,66% 64%,0 64%); }
.m3-battle:hover { filter:brightness(1.12); }
.m3-battle:disabled { filter:grayscale(.9) brightness(.7); cursor:not-allowed; }

/* fleet register: one row per ship (tier plate, class glyph, name, type, side silhouette) */
.m3-tabs { flex:none; display:flex; gap:3px; }
.m3-tabs button { cursor:pointer; flex:1; min-width:0; height:34px; padding:0 2px; border:1px solid rgba(226,189,110,.32); background:rgba(19,33,43,.88); color:var(--hud-dim);
   display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; font:600 11px/1 var(--font); letter-spacing:.8px; text-transform:uppercase; white-space:nowrap; }
.m3-tabs button i { font:500 9px/1 var(--font); font-style:normal; letter-spacing:0; opacity:.75; }
.m3-tabs button:hover { color:var(--paper); }
.m3-tabs button.sel { background:var(--paper); color:var(--ink); border-color:var(--paper); box-shadow:inset 0 -3px 0 var(--signal); }
.m3-tabs button.dim { opacity:.45; }
.m3-car { flex:1; min-height:0; display:flex; flex-direction:column; gap:4px; overflow-y:auto; overflow-x:hidden; padding:2px 6px 2px 0; scrollbar-width:thin; scrollbar-color:var(--brass) transparent; }
.m3-nat { flex:none; padding:9px 2px 3px; font:600 10px var(--font); letter-spacing:2.5px; color:var(--brass-hi); text-transform:uppercase; border-bottom:1px solid rgba(226,189,110,.4); text-shadow:0 1px 2px rgba(0,0,0,.8); }
.m3-nat:first-child { padding-top:0; }
.m3-card { position:relative; cursor:pointer; flex:none; display:grid; grid-template-columns:minmax(0,1fr) 110px; align-items:center; gap:6px; min-height:42px; padding:3px 6px 3px 6px;
   background:var(--paper-2); border:1px solid var(--paper-edge); color:var(--ink); transition:background .12s; }
.m3-card.gs { margin-top:7px; }
.m3-card:hover { background:var(--paper); }
.m3-card.sel { background:var(--navy-2); border-color:var(--brass-hi); color:var(--paper); --cls-bar:var(--navy-2); box-shadow:inset 4px 0 0 var(--signal); }
.m3-card.off { cursor:not-allowed; opacity:.4; }
.m3-card .hd { display:flex; align-items:center; gap:7px; min-width:0; font:600 13px var(--font); white-space:nowrap; }
.m3-card .hd .tr { flex:none; width:24px; height:24px; display:flex; align-items:center; justify-content:center; font:700 13px/1 var(--font-cond); background:var(--ink); color:var(--paper); }
.m3-card.sel .hd .tr { background:var(--brass-hi); color:var(--navy); }
.m3-card .hd .nm2 { overflow:hidden; text-overflow:ellipsis; min-width:0; }
.m3-card .hd .ty { flex:none; margin-left:auto; font:500 10px var(--font); letter-spacing:1px; color:var(--ink-3); }
.m3-card.sel .hd .ty { color:var(--hud-dim); }
.m3-card .rec { position:absolute; right:5px; top:2px; z-index:1; font:700 8px/1 var(--font); letter-spacing:1.2px; color:var(--signal); }
.m3-card.sel .rec { color:var(--brass-hi); }
.m3-card .lk { position:absolute; inset:0; display:flex; align-items:center; justify-content:flex-end; padding-right:46px; color:var(--ink-2); }
.m3-card.lock .lk { left:auto; width:118px; padding:0 6px; display:grid; grid-template-columns:auto 1fr; align-content:center; column-gap:6px; background:var(--paper-3);
   font:600 10.5px/1.3 var(--font); color:var(--ink); }
.m3-card.lock .lk .m3-ic { grid-row:span 2; }
.m3-card.lock .lk .kr { color:var(--ink-2); }
.m3-card.sel.lock .lk { background:var(--navy-3); color:var(--paper); } .m3-card.sel.lock .lk .kr { color:var(--hud-dim); }
.m3-sil { display:block; width:100%; height:34px; }
.m3-sil .wl { stroke:rgba(27,42,53,.3); stroke-width:1; }
.m3-sil g { fill:var(--ink-2); }
.m3-card.sel .m3-sil g { fill:var(--paper); } .m3-card.sel .m3-sil .wl { stroke:rgba(235,227,207,.35); }
.m3-ally { color:var(--flag-b); } .m3-enemy { color:var(--signal); }

/* briefing of an operation and the commander sheet */
.m3-op { position:absolute; inset:0; z-index:2; display:flex; align-items:center; justify-content:center; background:var(--veil); }
.m3-op .box { max-width:640px; max-height:calc(100% - 32px); overflow:auto; margin:16px; padding:24px 30px; scrollbar-width:thin; }
.m3-op .k { font:600 10.5px var(--font); letter-spacing:3px; color:var(--signal-lo); }
.m3-op .t { font:700 34px/1.05 var(--font-cond); letter-spacing:2px; text-transform:uppercase; margin:4px 0 3px; }
.m3-op .st { font:italic 13.5px/1.4 var(--font-serif); color:var(--ink-2); }
.m3-op .st b.pts { font:700 13.5px var(--font); color:var(--signal); }
.m3-op p { font:14.5px/1.6 var(--font-serif); margin:14px 0; }
.m3-op .fl { display:grid; grid-template-columns:auto 1fr; gap:5px 14px; font:12.5px/1.4 var(--font); border-top:1px solid var(--ink-2); padding-top:10px; }
.m3-op .fl b { color:var(--ink-3); font:600 10px/1.9 var(--font); letter-spacing:1.5px; text-transform:uppercase; }
.m3-op .bt { display:flex; gap:10px; justify-content:flex-end; align-items:center; margin-top:18px; }
.m3-op button { cursor:pointer; border:1px solid var(--ink-2); padding:9px 18px; background:transparent; color:var(--ink); font:600 12.5px var(--font); letter-spacing:1.5px; }
.m3-op button:hover:not(:disabled) { background:var(--paper-2); }
.m3-op button.pri { background:var(--signal); color:var(--flag-w); border-color:var(--signal-lo); box-shadow:inset 0 0 0 2px var(--signal), inset 0 0 0 3px rgba(255,235,200,.5); }
.m3-op button.pri:hover { background:var(--signal); filter:brightness(1.1); }
.m3-op button.warn { border-color:var(--signal); color:var(--signal-lo); }
.m3-op .box.captbox { max-width:780px; }
.m3-op .box.captbox .m3-bar { margin-top:10px; }
.m3-skills { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:14px 0 4px; }
.m3-op .m3-skill { position:relative; text-align:left; padding:8px 36px 8px 10px; letter-spacing:0; display:flex; flex-direction:column; gap:2px; background:var(--paper-2); border-color:var(--paper-edge); }
.m3-skill b { font:600 13px var(--font); color:var(--ink); }
.m3-skill span { font:italic 12px/1.35 var(--font-serif); color:var(--ink-2); }
.m3-skill i { position:absolute; top:8px; right:9px; width:20px; height:20px; border:1.5px solid var(--ink-2); border-radius:50%; font:700 11px/17px var(--font); font-style:normal; text-align:center; color:var(--ink); }
.m3-op .m3-skill.top { grid-column:1 / -1; }
.m3-op .m3-skill.on { background:var(--navy-2); border-color:var(--navy); cursor:default; }
.m3-op .m3-skill.on b { color:var(--paper); } .m3-op .m3-skill.on span { color:var(--hud-dim); } .m3-op .m3-skill.on i { border-color:var(--brass-hi); color:var(--brass-hi); }
.m3-op .m3-skill:disabled { opacity:.45; cursor:not-allowed; }
.m3-confirm { margin-top:12px; padding:10px 12px; border:2px solid var(--signal); background:rgba(179,53,42,.08); font:12.5px/1.45 var(--font); color:var(--signal-lo); display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.m3-confirm span { flex:1; min-width:200px; }

@media (max-width: 1280px) {
   .m3-main { grid-template-columns:260px minmax(0,1fr) 300px; gap:14px; padding:14px; }
   .m3-ship { grid-template-columns:1fr; }
   .m3-logo .ks-logo .wm i { display:none; }
}
@media (max-width: 900px) {
   .m3-top { height:auto; flex-wrap:wrap; gap:8px; padding:8px 16px; }
   .m3-left { flex-wrap:wrap; }
   .m3-main { display:flex; flex-direction:column; overflow-y:auto; padding:12px 16px; }
   .m3-col, .m3-mid, .m3-dock { flex:none; }
   .m3-list { max-height:44vh; }
   .m3-mis.sel { transform:translateX(5px); }
   .m3-brief { max-height:none; }
   .m3-ship { flex:none; overflow:visible; }
   .m3-orders { flex-wrap:wrap; }
   .m3-diff { flex:1; min-height:44px; }
   .m3-battle { flex:1 1 100%; min-height:56px; }
   .m3-car { flex:none; max-height:none; overflow:visible; }
}
@media (max-height: 760px) { .m3-top { height:56px; } .m3-brief p { font-size:13px; } .m3-brief .t, .m3-ship .nm { font-size:26px; } }

/* ---------------- battle report: one paper sheet, the outcome as a rubber stamp ---------------- */
.m3r { position:absolute; inset:0; z-index:21; display:flex; align-items:center; justify-content:center; padding:18px; color:var(--ink); font-family:var(--font);
   --cls-bar:var(--paper); background:var(--veil); pointer-events:auto; user-select:none; }
.m3r * { box-sizing:border-box; }
.m3r-sheet { position:relative; width:min(1200px, 100%); max-height:100%; display:flex; flex-direction:column; background:var(--paper); border:1px solid var(--paper-edge);
   box-shadow:inset 0 0 0 6px var(--paper), inset 0 0 0 7px var(--paper-edge), 0 0 0 4px var(--navy), 0 0 0 5px var(--brass), 0 30px 80px rgba(0,0,0,.6); }
.m3r-head { flex:none; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:20px; margin:0 16px; padding:22px 16px 14px; border-bottom:3px double var(--ink-2); }
.m3r-doc { font:600 10.5px var(--font); letter-spacing:3px; color:var(--ink-3); text-transform:uppercase; }
.m3r-mis { font:700 30px/1.05 var(--font-cond); letter-spacing:2px; text-transform:uppercase; margin-top:3px; }
.m3r-reason { font:italic 16px/1.4 var(--font-serif); margin-top:6px; }
.m3r-meta { font:500 11.5px var(--font); letter-spacing:1.5px; color:var(--ink-2); text-transform:uppercase; margin-top:6px; }
.m3r-title { margin-right:10px; padding:9px 20px 7px; border:5px double currentColor; font:700 48px/1 var(--font-cond); letter-spacing:9px; text-indent:9px;
   transform:rotate(-7deg); opacity:.9; mix-blend-mode:multiply; }
.m3r.win .m3r-title { color:var(--seal); } .m3r.lose .m3r-title { color:var(--signal); }
.m3r-body { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.1fr); padding:12px 16px 6px; }
.m3r-box { min-height:0; overflow:auto; padding:6px 16px 10px; scrollbar-width:thin; }
.m3r-box + .m3r-box { border-left:1px solid var(--rule); }
.m3r-grid { display:grid; grid-template-columns:repeat(3, 1fr); border-top:1px solid var(--ink-2); }
.m3r-st { padding:7px 8px 6px; border-bottom:1px solid var(--rule); border-right:1px solid var(--rule); }
.m3r-st:nth-child(3n) { border-right:0; }
.m3r-st b { display:block; font:600 20px/1.15 var(--font); font-variant-numeric:tabular-nums; }
.m3r-st span { font:11px var(--font); color:var(--ink-2); }
.m3r-st.hl b { color:var(--signal-lo); }
.m3r-rib { display:flex; flex-wrap:wrap; gap:5px; margin-top:12px; }
.m3r-rib div { font:600 11px var(--font); padding:3px 16px 3px 9px; background:var(--paper-2); border-left:3px solid var(--ink-2);
   clip-path:polygon(0 0, 100% 0, calc(100% - 7px) 50%, 100% 100%, 0 100%); }
.m3r-rib div b { color:var(--signal-lo); margin-left:5px; }
.m3r-obj { margin-top:12px; font:12.5px/1.45 var(--font); display:flex; flex-direction:column; gap:3px; }
.m3r-obj .done { color:var(--seal); } .m3r-obj .failed { color:var(--signal); } .m3r-obj .active { color:var(--ink-2); }
.m3r-hist { margin-top:12px; padding:10px 12px; border-left:3px solid var(--brass); background:rgba(180,138,60,.1); font:italic 13px/1.5 var(--font-serif); }
.m3r-hist b { display:block; font:600 10px var(--font); font-style:normal; letter-spacing:2px; color:var(--brass-lo); margin-bottom:4px; }
.m3r-medal { font:600 13px var(--font); color:var(--brass-lo); letter-spacing:1px; margin-top:10px; }
.m3r-teams { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.m3r-teams table { width:100%; border-collapse:collapse; font:12px var(--font); }
.m3r-teams td { padding:4px; border-bottom:1px solid var(--rule); white-space:nowrap; }
.m3r-teams tr:first-child td { font-size:9.5px; letter-spacing:1px; text-transform:uppercase; color:var(--ink-3); border-bottom-color:var(--ink-2); }
.m3r-teams td.n { overflow:hidden; text-overflow:ellipsis; max-width:130px; }
.m3r-teams td.d { text-align:right; font-variant-numeric:tabular-nums; }
.m3r-teams tr.dead td { color:var(--ink-3); } .m3r-teams tr.dead td.n { text-decoration:line-through; }
.m3r-teams tr.me td { font-weight:700; background:rgba(241,194,50,.3); }
.m3r-foot { flex:none; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:16px 28px; margin:0 16px; padding:12px 16px 22px; border-top:3px double var(--ink-2); }
.m3r-earn { display:flex; gap:30px; }
.m3r-earn div { display:flex; align-items:baseline; gap:8px; }
.m3r-earn b { font:700 30px/1 var(--font-cond); font-variant-numeric:tabular-nums; }
.m3r-earn span { font:600 10.5px var(--font); letter-spacing:2px; color:var(--ink-2); }
.m3r-btns { display:flex; gap:10px; flex-wrap:wrap; }
.m3r-btn { cursor:pointer; border:1px solid var(--ink-2); padding:11px 22px; background:transparent; color:var(--ink); font:600 13px var(--font); letter-spacing:1.5px; transition:background .12s; }
.m3r-btn:hover { background:var(--paper-2); }
.m3r-btn.pri { background:var(--signal); color:var(--flag-w); border-color:var(--signal-lo); box-shadow:inset 0 0 0 2px var(--signal), inset 0 0 0 3px rgba(255,235,200,.5); }
.m3r-btn.pri:hover { background:var(--signal); filter:brightness(1.1); }
.m3r-rw { margin-top:14px; }
.m3r-note { font:600 12.5px var(--font); color:var(--seal); margin-top:8px; }
.m3r-rw table { width:100%; border-collapse:collapse; font:12px var(--font); margin-top:2px; font-variant-numeric:tabular-nums; }
.m3r-rw td { padding:2px 4px; color:var(--ink-2); } .m3r-rw td.xp, .m3r-rw td.cr { text-align:right; color:var(--ink); }
.m3r-rw tr.sum td { border-top:1px solid var(--ink-2); font-weight:700; color:var(--ink); }
@media (max-width: 1000px) {
   .m3r { padding:8px; }
   .m3r-body { grid-template-columns:1fr; overflow-y:auto; }
   .m3r-box { overflow:visible; } .m3r-box + .m3r-box { border-left:0; border-top:1px solid var(--rule); margin-top:8px; padding-top:12px; }
   .m3r-title { font-size:34px; }
}
@media (max-width: 620px) {
   .m3r-head { grid-template-columns:1fr; } .m3r-title { justify-self:start; }
   .m3r-teams { grid-template-columns:1fr; }
   .m3r-head, .m3r-foot, .m3r-body { margin:0 8px; padding-left:8px; padding-right:8px; }
}
`;

function injectStyle() {
   if (document.getElementById('menu3d-style')) return;
   const st = document.createElement('style');
   st.id = 'menu3d-style';
   st.textContent = CSS;
   document.head.appendChild(st);
}

// ---------------------------------------------------------------- component
export class Menu3D {
   // root: the #menu overlay; resultsRoot: the #end overlay.
   // cb: { onStart({mission, ship, difficulty}), onPort() (leave the finished match), onHowTo(), onClick() (ui sound) }
   constructor(root, resultsRoot, cb = {}) {
      injectStyle();
      this.root = root; this.resRoot = resultsRoot; this.cb = cb;
      this.progress = loadProgress();
      this.profile = loadProfile();      // career: XP, credits, unlocks, modules, skills (progress3d.js)
      const sel = this.progress.sel || {};
      this.mission = getMission(sel.mission) ? sel.mission : MISSIONS[0].id;
      this.difficulty = ['easy', 'normal', 'hard'].includes(sel.difficulty) ? sel.difficulty : 'normal';
      this.ship = SHIPS[sel.ship] ? sel.ship : null;
      this._fixShip();
      this.nation = natOf(this.ship);      // carousel tab: a nation key or 'all'
      this.root.className = 'm3 hidden';
      this.root.innerHTML = '';
      this.resRoot.className = 'm3r hidden';
      this.resRoot.innerHTML = '';
      this._onKey = (e) => {
         if (this.root.classList.contains('hidden')) return;
         if (this._cap) { if (e.code === 'Escape') { e.preventDefault(); this._closeCaptain(); } return; }
         if (this._intro) {
            if (e.code === 'Enter') { e.preventDefault(); this._launch(); }
            else if (e.code === 'Escape') { e.preventDefault(); this._closeIntro(); }
            return;
         }
         if (e.code === 'Enter') { e.preventDefault(); this.start(); }
         else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
            e.preventDefault();
            const i = MISSIONS.findIndex(m => m.id === this.mission);
            const j = (i + (e.code === 'ArrowDown' ? 1 : -1) + MISSIONS.length) % MISSIONS.length;
            this.selectMission(MISSIONS[j].id);
         }
      };
      window.addEventListener('keydown', this._onKey);
      this.render();
   }

   get selection() { return { mission: this.mission, ship: this.ship, difficulty: this.difficulty }; }
   _allowed(mid = this.mission) { return getMission(mid)?.playableShips || PLAYABLE; }
   // ships a mission prescribes (historical operations) are always available, researched or not
   _unlocked(k, mid = this.mission) { return isUnlocked(this.profile, k) || (() => { const m = getMission(mid); return !!m?.fixedShips && m.playableShips.includes(k); })(); }
   // keep the selection valid: allowed in this mission and unlocked (op ships are never locked)
   _fixShip() {
      const allowed = this._allowed();
      const ok = (k) => allowed.includes(k) && this._unlocked(k);
      if (ok(this.ship)) return;
      const rec = getMission(this.mission)?.recommendedShip;
      this.ship = ok(rec) ? rec : (allowed.find(ok) || allowed[0]);
      if (this.nation !== 'all') this.nation = natOf(this.ship);
   }
   selectNation(n) {
      if (n !== 'all' && !NATIONS.includes(n)) return;
      this.nation = n; this.render(); this.cb.onClick?.();
   }
   // loadout snapshot main3d hands to the World for the player ship
   loadout(ship) { return loadoutFor(this.profile, ship); }
   _saveProfile() { saveProfile(this.profile); }
   _remember() { this.progress.sel = this.selection; saveProgress(this.progress); }

   // back to port: main3d drops the finished world first (onPort ends in show())
   _toPort() { this.hideResults(); if (this.cb.onPort) this.cb.onPort(); else this.show(); }
   show() { this.hideResults(); this.render(); this.root.classList.remove('hidden'); }
   hide() { this._closeIntro(); this._closeCaptain(); this.root.classList.add('hidden'); }
   hideResults() { this.resRoot.classList.add('hidden'); cancelAnimationFrame(this._countRaf); }

   selectMission(id) {
      if (!getMission(id)) return;
      this.mission = id; this._fixShip(); this._remember(); this.render(); this.cb.onClick?.();
   }
   selectShip(key) {
      if (!this._allowed().includes(key)) return;
      this.ship = key; this._remember(); this.render(); this.cb.onClick?.();
   }
   start(opts) {
      const o = opts || this.selection;
      if (!opts && !this._unlocked(o.ship, o.mission)) return;     // locked ship is only selected for viewing
      this._remember();
      // historical operations open with a briefing screen (skipped on "NOCHMAL")
      if (!opts && getMission(o.mission)?.group === 'ops') { this._openIntro(getMission(o.mission)); return; }
      this.cb.onStart?.({ mission: o.mission, ship: o.ship, difficulty: o.difficulty || this.difficulty });
   }
   _launch() { this._closeIntro(); this.cb.onStart?.({ ...this.selection }); }
   _closeIntro() { if (this._intro) { this._intro.remove(); this._intro = null; } }
   _openIntro(m) {
      this._closeIntro();
      const el = document.createElement('div');
      el.className = 'm3-op';
      el.innerHTML = `<div class="box">
            <div class="k">HISTORISCHE OPERATION</div>
            <div class="t">${esc(m.name)}</div>
            <div class="st">${esc(m.subtitle)} · ${esc(TIME_LABEL[m.env.time] || m.env.time)} · ${esc(WEATHER_LABEL[m.env.weather] || m.env.weather)}</div>
            <p>${esc(m.briefing)}</p>
            ${m.fleet ? `<div class="fl"><b>Eigene Kräfte</b><span>${esc(m.fleet.own)}</span><b>Gegner</b><span>${esc(m.fleet.foe)}</span></div>` : ''}
            <div class="bt"><button data-op="back">ZURÜCK</button><button class="pri" data-op="go">AUSLAUFEN</button></div>
         </div>`;
      el.querySelector('[data-op="back"]').addEventListener('click', () => { this._closeIntro(); this.cb.onClick?.(); });
      el.querySelector('[data-op="go"]').addEventListener('click', () => this._launch());
      this.root.appendChild(el);
      this._intro = el;
      this.cb.onClick?.();
   }

   // ------------------------------------------------------------ captain (skills, respec, profile reset)
   _closeCaptain() { if (this._cap) { this._cap.remove(); this._cap = null; } this._capConfirm = false; }
   _openCaptain(keepConfirm = false) {
      const confirm = keepConfirm && this._capConfirm;
      this._closeCaptain();
      this._capConfirm = confirm;
      const pf = this.profile, cl = captainLevel(pf.totalXp), free = skillPointsFree(pf);
      const pct = cl.next ? Math.round((pf.totalXp - cl.cur) / (cl.next - cl.cur) * 100) : 100;
      const el = document.createElement('div');
      el.className = 'm3-op m3-cap';
      el.innerHTML = `<div class="box captbox">
            <div class="k">KOMMANDANT · LEHRGÄNGE</div>
            <div class="t">Stufe ${cl.level}</div>
            <div class="st">${fmtInt(pf.totalXp)} EP gesamt · ${cl.next ? `nächste Stufe bei ${fmtInt(cl.next)} EP` : 'Höchststufe erreicht'} · <b class="pts">${free}</b> freie Lehrgangspunkte · ${pf.battles} Gefechte</div>
            <div class="m3-bar"><div class="b"><i style="width:${pct}%"></i></div></div>
            <div class="m3-skills">${SKILLS.map(s => {
               const has = pf.skills.includes(s.key);
               return `<button class="m3-skill ${has ? 'on' : ''}${s.top ? ' top' : ''}" data-skill="${s.key}" ${!has && s.cost > free ? 'disabled' : ''}><b>${esc(s.name)}</b><span>${esc(s.desc)}</span><i>${s.cost}</i></button>`;
            }).join('')}</div>
            <div class="bt"><button class="warn" data-cap="reset">PROFIL ZURÜCKSETZEN</button><span style="flex:1"></span>
               <button data-cap="respec" ${pf.skills.length ? '' : 'disabled'}>NEU VERTEILEN</button><button class="pri" data-cap="close">FERTIG</button></div>
            ${confirm ? `<div class="m3-confirm"><span>Wirklich zurücksetzen? EP, Mark, in Dienst gestellte Schiffe, Umbauten und Lehrgänge gehen verloren. Spangen und Einsatzsiege bleiben erhalten.</span>
               <button data-cap="no">ABBRECHEN</button><button class="warn" data-cap="yes">ZURÜCKSETZEN</button></div>` : ''}
         </div>`;
      const act = (sel, fn) => el.querySelector(sel)?.addEventListener('click', () => { fn(); this.cb.onClick?.(); });
      el.querySelectorAll('[data-skill]').forEach(b => b.addEventListener('click', () => {
         if (learnSkill(pf, b.dataset.skill)) { this._saveProfile(); this.render(); this.cb.onClick?.(); }
      }));
      act('[data-cap="respec"]', () => { if (respecSkills(pf)) { this._saveProfile(); this.render(); } });
      act('[data-cap="close"]', () => this._closeCaptain());
      act('[data-cap="reset"]', () => { this._capConfirm = true; this._openCaptain(true); });
      act('[data-cap="no"]', () => { this._capConfirm = false; this._openCaptain(); });
      act('[data-cap="yes"]', () => {
         this.profile = defaultProfile(); this._saveProfile();
         delete this.progress.xp; delete this.progress.credits; saveProgress(this.progress);
         this._closeCaptain(); this._fixShip(); this.render();
      });
      this.root.appendChild(el);
      this._cap = el;
   }

   render() {
      const m = getMission(this.mission) || MISSIONS[0];
      const pf = this.profile, k0 = this.ship;
      // stats as they will sail: modules + captain skills applied (same pipeline as the sim)
      const S = SHIPS[k0] ? shipStats(k0, applyLoadout(SHIPS[k0], loadoutFor(pf, k0))) : null;
      const allowed = this._allowed();
      const pr = this.progress;
      const shipLocked = !this._unlocked(k0), cl = captainLevel(pf.totalXp), free = skillPointsFree(pf);
      const need = shipLocked ? unlockNeeds(pf, k0) : null, crCost = UNLOCK_CREDITS[k0] || 0;
      const needTxt = need ? [need.req ? `Erfordert ${SHIPS[need.req]?.name || need.req}` : '', need.xp ? `Noch ${fmtInt(need.xp)} EP benötigt` : '',
         need.credits ? `Noch ${fmtInt(need.credits)} Mark benötigt` : ''].filter(Boolean).join(' · ') : '';
      const prog = !S ? '' : shipLocked ? `<div class="m3-prog">
            <div class="m3-h"><span>Indienststellung</span><span>${fmtInt(pf.xp)} EP · ${fmtInt(pf.credits)} Mark</span></div>
            <button class="m3-buy big" data-act="unlock" ${canUnlock(pf, k0) ? '' : 'disabled'}>IN DIENST STELLEN · ${fmtInt(UNLOCK_XP[k0])} EP${crCost ? ` · ${fmtInt(crCost)} Mark` : ''}</button>
            ${needTxt ? `<div class="hint">${esc(needTxt)}</div>` : ''}</div>`
         : `<div class="m3-prog"><div class="m3-h"><span>Umbauten</span><span>${fmtInt(pf.credits)} Mark</span></div>
            ${MODULES.map(d => {
               const t = moduleTier(pf, k0, d.key), c = moduleCost(pf, k0, d.key);
               return `<div class="m3-mod"><span class="n">${d.name}</span><span class="m3-pips">${d.tiers.map((_, i) => `<i class="${i < t ? 'on' : ''}"></i>`).join('')}</span>
                  <span class="fx">${t ? modFx(d.tiers[t - 1]) : ''}</span>
                  ${c ? `<button class="m3-buy" data-mod="${d.key}" ${pf.credits >= c ? '' : 'disabled'} title="Stufe ${t + 1}: ${modFx(d.tiers[t])}">${fmtInt(c)}</button>` : '<span class="max">VOLL</span>'}</div>`;
            }).join('')}</div>`;
      const medal = (n) => `<span class="m3-medal" title="Spangen">${[1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}">◆</i>`).join('')}</span>`;
      const misItem = (x) => {
         const rec = pr.missions?.[x.id], done = rec?.won, op = x.group === 'ops';
         return `<div class="m3-mis ${op ? 'op' : ''} ${x.id === m.id ? 'sel' : ''}" data-mis="${esc(x.id)}">
            <div class="n">${esc(x.name)}</div>
            <div class="s">${esc(x.subtitle)}</div>
            <div class="row"><span class="tag">${esc(TYPE_LABEL[x.type] || x.type)}</span>${icon(x.env.time, 15)}${x.env.weather !== 'clear' ? icon(x.env.weather, 15) : ''}
               ${stars(x.stars)}${op ? medal(rec?.stars || 0) : done ? `<span class="done">${icon('check', 13)}Sieg</span>` : ''}</div>
         </div>`;
      };
      const ops = MISSIONS.filter(x => x.group === 'ops');
      const misList = MISSIONS.filter(x => x.group !== 'ops').map(misItem).join('') +
         (ops.length ? `<div class="m3-sec">Historische Operationen</div>${ops.map(misItem).join('')}` : '');
      const envChip = `${icon(m.env.time, 16)}${esc(TIME_LABEL[m.env.time] || m.env.time)} · ${esc(WEATHER_LABEL[m.env.weather] || m.env.weather)}`;
      const brief = `
         <div class="k">Einsatzbefehl · ${esc(TYPE_LABEL[m.type] || m.type)}</div>
         <div class="t">${esc(m.name)}</div>
         <div class="st">${esc(m.subtitle)}</div>
         <div class="chips">
            <span class="chip3">${esc(TYPE_LABEL[m.type] || m.type)}</span>
            <span class="chip3">${envChip}</span>
            <span class="chip3">${icon('clock', 15)}${Math.round(m.timeLimit / 60)} min</span>
            <span class="chip3">${icon('map', 15)}${Math.round(m.arena * 2 / 1000)} × ${Math.round(m.arena * 2 / 1000)} km</span>
            <span class="chip3">Anspruch ${stars(m.stars)}</span>
         </div>
         <p>${esc(m.briefing)}</p>`;
      const shipPanel = S ? `<div>
         <div class="nm">${classSvg(S.type, 18)}${esc(S.name)}</div>
         <div class="cl">${S.tier ? `<b>Stufe ${S.tier}</b> · ` : ''}${esc(S.typeName)} · ${esc(S.className)}${S.nationName ? ' · ' + esc(S.nationName) : ''}</div>
         ${S.desc ? `<p class="ds">${esc(S.desc)}</p>` : ''}
         <div class="bars">${RATING_LABEL.map(([k, l]) => `<div class="m3-bar"><div class="l"><span>${l}</span><span>${S.ratings[k]}</span></div><div class="b"><i style="width:${S.ratings[k]}%"></i></div></div>`).join('')}</div>
         <div class="m3-cons">${S.consumables.map(c => `<span>${esc(c)}</span>`).join('')}</div></div>
         <div><div class="m3-kv">
            <span>Kampfkraft</span><span>${fmtInt(S.hp)} HP</span>
            <span>Hauptbatterie</span><span>${esc(S.main)}</span>
            <span>Reichweite</span><span>${String(S.rangeKm).replace('.', ',')} km</span>
            <span>Nachladen</span><span>${String(S.reload).replace('.', ',')} s · 180° in ${S.traverse180} s</span>
            <span>Sprenggranate</span><span>${fmtInt(S.heDmg)}</span>
            <span>Panzergranate</span><span>${fmtInt(S.apDmg)}</span>
            ${S.torp ? `<span>Torpedos</span><span>${S.torp.launchers}× ${Math.round(S.torp.tubes / S.torp.launchers)} · ${String(S.torp.rangeKm).replace('.', ',')} km · ${S.torp.speedKn} kn</span>` : ''}
            ${S.secRangeKm ? `<span>Mittelartillerie</span><span>${String(S.secRangeKm).replace('.', ',')} km</span>` : ''}
            ${S.air ? ['tb', 'db', 'ft'].map(t => `<span>${esc(S.air[t].name)}</span><span>${S.air[t].hangar} im Hangar · Staffel ${S.air[t].squad}</span>`).join('') : ''}
            ${S.aaKm ? `<span>Flugabwehr</span><span>${String(S.aaKm).replace('.', ',')} km · ${S.aaDps} Schaden/s</span>` : ''}
            <span>Geschwindigkeit</span><span>${String(S.speedKn).replace('.', ',')} kn</span>
            <span>Tarnwert</span><span>${String(S.detectKm).replace('.', ',')} km</span>
            <span>Gürtelpanzer</span><span>${S.belt} mm</span>
            <span>Abmessungen</span><span>${S.lengthM} × ${String(S.beamM).replace('.', ',')} m</span>
         </div>
         ${prog}</div>` : '';
      // fixed op ships (Duke of York, Washington ...) join the row only while their operation is selected
      // the port line-up: one tab per navy, each sorted by class (BB, CA, CL, DD) and tier
      const roster = [...PLAYABLE, ...allowed.filter(k => !PLAYABLE.includes(k))];
      const byNat = {};
      for (const n of NATIONS) byNat[n] = roster.filter(k => natOf(k) === n).sort((a, c) =>
         (CLASS_ORDER[SHIP_STATS[a].type] ?? 9) - (CLASS_ORDER[SHIP_STATS[c].type] ?? 9) || SHIP_STATS[a].tier - SHIP_STATS[c].tier);
      const tab = this.nation === 'all' || NATIONS.includes(this.nation) ? this.nation : natOf(k0);
      const card = (k, i, list) => {
         const st = SHIP_STATS[k], ok = allowed.includes(k), lk = ok && !this._unlocked(k), cr = UNLOCK_CREDITS[k] || 0;
         const gs = i > 0 && SHIP_STATS[list[i - 1]].type !== st.type;
         return `<div class="m3-card ${k === this.ship ? 'sel' : ''} ${ok ? '' : 'off'} ${lk ? 'lock' : ''} ${gs ? 'gs' : ''}" data-ship="${esc(k)}" title="${ok ? (lk ? 'Noch nicht in Dienst — mit EP und Mark in Dienst stellen' : esc(st.typeName + ' · Stufe ' + st.tier)) : 'In dieser Mission nicht verfügbar'}">
            ${m.recommendedShip === k && ok ? '<span class="rec">VORGESCHLAGEN</span>' : ''}
            <div class="hd"><span class="tr">${st.tier}</span>${classSvg(st.type, 13)}<span class="nm2">${esc(st.name)}</span><span class="ty">${esc(st.type)}</span></div>
            ${silhouetteSvg(k)}
            ${ok ? (lk ? `<div class="lk">${icon('lock', 18)}<span>${fmtInt(UNLOCK_XP[k])} EP</span>${cr ? `<span class="kr">${fmtInt(cr)} Mark</span>` : ''}</div>` : '') : `<div class="lk">${icon('lock', 26)}</div>`}
         </div>`;
      };
      const cards = tab === 'all'
         ? NATIONS.filter(n => byNat[n].length).map(n => `<div class="m3-nat">${esc(NATION_SHORT[n])}</div>` + byNat[n].map(card).join('')).join('')
         : byNat[tab].map(card).join('');
      const tabs = [...NATIONS.filter(n => byNat[n].length), 'all'].map(n => {
         const list = n === 'all' ? roster : byNat[n], have = list.filter(k => isUnlocked(pf, k)).length;
         const dim = n !== 'all' && !list.some(k => allowed.includes(k));
         return `<button data-nat="${n}" class="${n === tab ? 'sel' : ''} ${dim ? 'dim' : ''}" title="${n === 'all' ? 'Alle Marinen' : esc(NATION_SHORT[n])}">${n === 'all' ? 'Alle' : NAT_CODE[n] || esc(n)}<i>${have}/${list.length}</i></button>`;
      }).join('');
      const oldCar = this.root.querySelector('.m3-car'), keepScroll = oldCar && this._carTab === tab ? oldCar.scrollTop : null;
      this._carTab = tab;
      const inService = PLAYABLE.filter(k => isUnlocked(pf, k)).length;
      this.root.innerHTML = `
         <div class="m3-top">
            <div class="m3-left"><div class="m3-logo">${logoSvg('Hafen · Einzelspieler')}</div>
               <button class="m3-capt" data-act="captain" title="Kommandant &amp; Lehrgänge">KOMMANDANT<b>${cl.level}</b>${free > 0 ? `<i>${free}</i>` : ''}</button>
               <button class="m3-capt" data-act="mp" title="Gemeinsam mit anderen Spielern über das Internet">MEHRSPIELER</button></div>
            <div class="m3-right">
               <div class="m3-purse"><span><b class="xp">${fmtInt(pf.xp)}</b>EP</span><span><b>${fmtInt(pf.credits)}</b>Mark</span></div>
               <button class="m3-help" data-act="help" title="So kämpfst du">?</button>
            </div>
         </div>
         <div class="m3-main">
            <div class="m3-col"><div class="m3-h"><span>Einsatzbefehle</span><span>${Object.values(pr.missions || {}).filter(x => x.won).length}/${MISSIONS.length} erfüllt</span></div><div class="m3-list">${misList}</div></div>
            <div class="m3-mid">
               <div class="m3-brief">${brief}</div>
               <div class="m3-ship">${shipPanel}</div>
               <div class="m3-orders">
                  <div class="m3-diff"><span>Gegner</span>${DIFFS.map(([k, l]) => `<button data-diff="${k}" class="${k === this.difficulty ? 'sel' : ''}">${l}</button>`).join('')}</div>
                  <button class="m3-battle" data-act="battle" ${shipLocked ? 'disabled title="Schiff zuerst in Dienst stellen"' : ''}>AUSLAUFEN</button>
               </div>
            </div>
            <div class="m3-dock"><div class="m3-h"><span>Flottenliste</span><span>${inService}/${PLAYABLE.length} in Dienst</span></div><div class="m3-tabs">${tabs}</div><div class="m3-car">${cards}</div></div>
         </div>`;
      const car = this.root.querySelector('.m3-car');
      if (keepScroll !== null) car.scrollTop = keepScroll;
      else car.querySelector('.m3-card.sel')?.scrollIntoView?.({ block: 'nearest' });
      this.root.querySelectorAll('[data-nat]').forEach(el => el.addEventListener('click', () => this.selectNation(el.dataset.nat)));
      this.root.querySelectorAll('[data-mis]').forEach(el => el.addEventListener('click', () => this.selectMission(el.dataset.mis)));
      this.root.querySelectorAll('[data-ship]').forEach(el => el.addEventListener('click', () => this.selectShip(el.dataset.ship)));
      this.root.querySelectorAll('[data-diff]').forEach(el => el.addEventListener('click', () => {
         this.difficulty = el.dataset.diff; this._remember(); this.render(); this.cb.onClick?.();
      }));
      this.root.querySelector('[data-act="battle"]').addEventListener('click', () => this.start());
      this.root.querySelector('[data-act="help"]').addEventListener('click', () => this.cb.onHowTo?.());
      this.root.querySelector('[data-act="captain"]').addEventListener('click', () => this._openCaptain());
      // the multiplayer screen (and everything network-related) is only loaded on demand
      this.root.querySelector('[data-act="mp"]').addEventListener('click', () => {
         this.cb.onClick?.();
         import('./mpui.js').then(m => m.openMultiplayer(this)).catch(e => console.warn('multiplayer: could not load', e));
      });
      this.root.querySelector('[data-act="unlock"]')?.addEventListener('click', () => {
         if (unlockShip(pf, k0)) { this._saveProfile(); this.render(); this.cb.onClick?.(); }
      });
      this.root.querySelectorAll('[data-mod]').forEach(el => el.addEventListener('click', () => {
         if (buyModule(pf, k0, el.dataset.mod)) { this._saveProfile(); this.render(); this.cb.onClick?.(); }
      }));
      if (this._cap) this._openCaptain(true);
      const selEl = this.root.querySelector('.m3-mis.sel');
      if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: 'nearest' });
   }

   // ------------------------------------------------------------ results
   // world: the finished World; opts: the { mission, ship, difficulty } it was started with;
   // extra: { ribbons: Map(kind -> count), ribbonNames, net: true after a net game (back to the lobby only) }
   showResults(world, opts, extra = {}) {
      const res = world.result || { victory: world.phase === 'won', reason: '', xp: 0, credits: 0 };
      const st = res.stats || world.stats || {};
      const p = world.player;
      const m = getMission(opts.mission) || { name: world.mission?.name || 'Gefecht' };
      // bookkeeping: career totals + per-mission best
      const pr = this.progress;
      delete pr.xp; delete pr.credits;            // career totals live in the profile now (progress3d.js)
      pr.missions = pr.missions || {};
      // career: book the earnings once per finished world
      const pf = this.profile, rw = res.rewards || { xp: res.xp || 0, credits: res.credits || 0, mult: 1, lines: [] };
      const lvl0 = captainLevel(pf.totalXp).level, canBefore = PLAYABLE.filter(k => canUnlock(pf, k));
      if (!world._careerBooked) { world._careerBooked = true; grantRewards(pf, rw); this._saveProfile(); }
      const lvl1 = captainLevel(pf.totalXp).level, newShips = PLAYABLE.filter(k => canUnlock(pf, k) && !canBefore.includes(k));
      const rwBox = `<div class="m3r-rw"><div class="m3-h"><span>Belohnung</span><span>${rw.mult && rw.mult !== 1 ? 'Schwierigkeit ×' + String(rw.mult).replace('.', ',') : ''}</span></div>
         <table>${rw.lines.map(l => `<tr><td>${esc(l.label)}</td><td class="xp">${fmtInt(l.xp)} EP</td><td class="cr">${fmtInt(l.credits)} Mark</td></tr>`).join('')}
         <tr class="sum"><td>Gesamt</td><td class="xp">${fmtInt(rw.xp)} EP</td><td class="cr">${fmtInt(rw.credits)} Mark</td></tr></table>
         ${lvl1 > lvl0 ? `<div class="m3r-note">Kommandant erreicht Stufe ${lvl1} · +${lvl1 - lvl0} Lehrgangspunkt${lvl1 - lvl0 > 1 ? 'e' : ''}</div>` : ''}
         ${newShips.length ? `<div class="m3r-note">Kann in Dienst gestellt werden: ${newShips.map(k => esc(SHIPS[k].name)).join(', ')}</div>` : ''}</div>`;
      const rec = pr.missions[opts.mission] || { won: false, best: 0, plays: 0 };
      rec.plays++; rec.won = rec.won || !!res.victory; rec.best = Math.max(rec.best, res.xp || 0);
      const isOp = m.group === 'ops', medal = isOp ? opStars(world) : 0;
      if (isOp) rec.stars = Math.max(rec.stars || 0, medal);
      pr.missions[opts.mission] = rec;
      saveProgress(pr);

      const tile = (v, l, hl) => `<div class="m3r-st ${hl ? 'hl' : ''}"><b>${v}</b><span>${l}</span></div>`;
      const acc = st.shotsFired ? Math.round((st.hits || 0) / st.shotsFired * 100) + ' %' : '—';
      const tiles = [
         tile(fmtInt(st.dmg), 'Schaden', true), tile(st.kills || 0, 'Versenkt', true), tile(st.citadels || 0, 'Zitadelltreffer'),
         tile(st.fires || 0, 'Brände gelegt'), tile(st.floods || 0, 'Wassereinbrüche'), tile(`${st.hits || 0} / ${st.shotsFired || 0}`, 'Treffer / Schüsse'),
         tile(acc, 'Trefferquote'), tile(st.torpHits || 0, 'Torpedotreffer'), tile(fmtInt(st.spottingDmg), 'Schaden an gemeldeten Zielen'),
         tile(fmtInt(st.tanked), 'Erhaltener Schaden'), tile(fmtInt(st.potential), 'Unter Feuer (Schaden)'), tile(fmtInt(st.healed), 'Repariert'),
      ].join('');
      const rib = extra.ribbons ? RIBBON_ORDER.filter(k => extra.ribbons.get(k)).map(k => `<div>${esc(extra.ribbonNames?.[k] || k)}<b>×${extra.ribbons.get(k)}</b></div>`).join('') : '';
      const objs = (world.mission?.objectives || []).map(o => `<div class="${esc(o.state)}">${o.state === 'done' ? '✔' : o.state === 'failed' ? '✘' : '•'} ${esc(o.text)}</div>`).join('');
      const roster = world.roster || world.ships;
      const row = (s) => `<tr class="${s.alive ? '' : (s.escaped ? '' : 'dead')} ${s === p ? 'me' : ''}">
         <td class="${s.side === 'player' ? 'm3-ally' : 'm3-enemy'}">${classSvg(s.type || s.cfg?.hull?.type, 12)}</td><td class="n">${esc(s.name)}</td>
         <td class="d">${fmtInt(s.dmgDealt)}</td><td class="d">${s.kills || 0}</td>
         <td class="d">${s.alive ? fmtInt(s.hp) + ' HP' : s.escaped ? (ESCAPE_LABEL[s.escaped] || 'entkommen') : 'versenkt'}</td></tr>`;
      const head = '<tr><td></td><td></td><td class="d">Schaden</td><td class="d">Versenkt</td><td class="d">Status</td></tr>';
      const allies = roster.filter(s => s.side === 'player'), enemies = roster.filter(s => s.side !== 'player');
      const next = MISSIONS[(MISSIONS.findIndex(x => x.id === opts.mission) + 1) % MISSIONS.length];
      const win = !!res.victory;
      // PvP: the winning team and every human captain of both teams
      const pv = res.pvp && Array.isArray(res.pvp.pl) ? res.pvp : null;
      const pvRow = (r) => `<tr class="${r[4] ? '' : 'dead'} ${r[0] === p?.captain ? 'me' : ''}"><td class="${r[1] === pv.my ? 'm3-ally' : 'm3-enemy'}">T${r[1]}</td><td class="n">${esc(r[0])}</td>
         <td class="d">${fmtInt(r[2])}</td><td class="d">${r[3]}</td><td class="d">${r[4] ? 'schwimmt' : 'versenkt'}</td></tr>`;
      const pvBox = pv ? `<div class="m3-h" data-pvp-win="${pv.win}"><span>Kapitäne · Team ${pv.win} gewinnt</span></div>
         <table data-pvp>${head}${[...pv.pl].sort((x, y) => (x[1] === pv.my ? 0 : 1) - (y[1] === pv.my ? 0 : 1) || y[2] - x[2]).map(pvRow).join('')}</table>` : '';
      this.resRoot.className = 'm3r ' + (win ? 'win' : 'lose');
      this.resRoot.innerHTML = `
         <div class="m3r-sheet">
         <div class="m3r-head">
            <div>
               <div class="m3r-doc">Gefechtsbericht</div>
               <div class="m3r-mis">${esc(m.name)}</div>
               <div class="m3r-reason">${pv ? `Team ${pv.win} gewinnt${pv.my ? ` · du warst in Team ${pv.my}` : ''} · ` : ''}${esc(res.reason || '')}</div>
               <div class="m3r-meta">${esc(p?.name || '')} · Dauer ${mmss(res.time ?? world.time)} · Gegner ${esc(DIFFS.find(d => d[0] === opts.difficulty)?.[1] || '')}</div>
            </div>
            <div class="m3r-title">${win ? 'SIEG' : 'NIEDERLAGE'}</div>
         </div>
         <div class="m3r-body">
            <div class="m3r-box"><div class="m3-h"><span>Eigene Leistung</span></div><div class="m3r-grid">${tiles}</div>
               ${rib ? `<div class="m3r-rib">${rib}</div>` : ''}${rwBox}</div>
            <div class="m3r-box">${pvBox}<div class="m3r-teams" ${pv ? 'style="margin-top:14px"' : ''}>
               <div><div class="m3-h"><span class="m3-ally">${pv ? 'Eigenes Team' : 'Eigener Verband'}</span></div><table>${head}${allies.map(row).join('')}</table></div>
               <div><div class="m3-h"><span class="m3-enemy">Gegner</span></div><table>${head}${enemies.map(row).join('')}</table></div>
            </div>
               ${objs ? `<div class="m3-h" style="margin-top:14px"><span>Einsatzziele</span></div><div class="m3r-obj" style="margin-top:4px">${objs}</div>` : ''}
               ${isOp && medal ? `<div class="m3r-medal">${'◆'.repeat(medal)} ${MEDAL[medal]} verliehen</div>` : ''}
               ${isOp && m.debrief ? `<div class="m3r-hist"><b>HISTORISCHER HINTERGRUND</b>${esc(m.debrief)}</div>` : ''}</div>
         </div>
         <div class="m3r-foot">
            <div class="m3r-earn"><div class="xp"><b data-count="${res.xp || 0}">0</b><span>ERFAHRUNG</span></div><div class="cr"><b data-count="${res.credits || 0}">0</b><span>MARK</span></div></div>
            <div class="m3r-btns">${extra.net ? `
               <button class="m3r-btn pri" data-act="port">ZUR LOBBY</button>` : `
               <button class="m3r-btn pri" data-act="again">NOCHMAL</button>
               <button class="m3r-btn" data-act="next">NÄCHSTER EINSATZ</button>
               <button class="m3r-btn" data-act="port">ZUM HAFEN</button>`}
            </div>
         </div>
         </div>`;
      this.resRoot.querySelector('[data-act="again"]')?.addEventListener('click', () => { this.hideResults(); this.start(opts); });
      this.resRoot.querySelector('[data-act="next"]')?.addEventListener('click', () => {
         this.hideResults();
         this.mission = next.id;
         this._fixShip();
         this._remember();
         this._toPort();
      });
      this.resRoot.querySelector('[data-act="port"]').addEventListener('click', () => this._toPort());
      // count-up of the earnings
      const nums = [...this.resRoot.querySelectorAll('[data-count]')];
      const t0 = performance.now();
      const tick = () => {
         const k = Math.min(1, (performance.now() - t0) / 1400), e = 1 - Math.pow(1 - k, 3);
         for (const n of nums) n.textContent = fmtInt(+n.dataset.count * e);
         if (k < 1) this._countRaf = requestAnimationFrame(tick);
      };
      tick();
      this.root.classList.add('hidden');
      this.resRoot.classList.remove('hidden');
   }
}
