// game3d/menu3d.js — WoWs-port-like mission + ship picker and the post-battle results screen.
// Self-contained UI component: injects its own <style>, renders into the #menu / #end overlays
// and hands the chosen { mission, ship, difficulty } to main3d via callbacks. Reads the menu
// data the sim exports (MISSIONS, SHIP_STATS, SHIPS) and never touches the running world.
import { MISSIONS, getMission, opStars } from './missions.js';
import { SHIPS, SHIP_STATS, PLAYABLE, shipStats } from './config.js';
import { loadProfile, saveProfile, defaultProfile, UNLOCK_XP, MODULES, SKILLS, captainLevel, skillPointsFree, isUnlocked, canUnlock,
   unlockShip, moduleTier, moduleCost, buyModule, learnSkill, respecSkills, grantRewards, loadoutFor, applyLoadout } from './progress3d.js';
import { classSvg } from './hud.js';

const TYPE_LABEL = {
   training: 'Übung', annihilation: 'Vernichtung', domination: 'Herrschaft', escort: 'Geleitschutz',
   historic: 'Historisch', survival: 'Überleben', raid: 'Handelskrieg',
};
const TIME_LABEL = { day: 'Tag', dawn: 'Morgengrauen', dusk: 'Abenddämmerung', night: 'Nacht' };
const WEATHER_LABEL = { clear: 'Klar', overcast: 'Bewölkt', rain: 'Regen', storm: 'Sturm' };
const DIFFS = [['easy', 'Einfach'], ['normal', 'Normal'], ['hard', 'Schwer']];
const RATING_LABEL = [
   ['firepower', 'Feuerkraft'], ['survivability', 'Überlebensfähigkeit'], ['mobility', 'Manövrierbarkeit'],
   ['concealment', 'Tarnung'], ['torpedoes', 'Torpedos'],
];
const RIBBON_ORDER = ['kill', 'citadel', 'pen', 'overpen', 'he', 'sec', 'torp', 'fire', 'flood', 'ricochet', 'shatter', 'spotted', 'cap'];
const ESCAPE_LABEL = { arrived: 'angekommen', retreated: 'abgelaufen', escaped: 'entkommen' };
const STORE_KEY ='warships3d.progress.v1';

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
const MEDAL = ['', 'Bronzeorden', 'Silberorden', 'Goldorden'];
const stars = (n) => '<span class="m3-stars">' + [1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}">★</i>`).join('') + '</span>';

// Side-view silhouette straight from the sim's hull config (bow to the right), scaled so the
// line-up shows the real size differences between a destroyer and a battleship.
function silhouetteSvg(key, w = 190, h = 58) {
   const c = SHIPS[key];
   if (!c) return '';
   const H = c.hull, L = H.L, maxL = 255;
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
   return `<svg class="m3-sil" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line class="wl" x1="0" x2="${w}" y1="${wl}" y2="${wl}"/><g>${p}</g></svg>`;
}

// ---------------------------------------------------------------- persistence (per viewer)
function loadProgress() {
   try { const j = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); if (j && typeof j === 'object') return j; } catch (e) { /* private mode */ }
   return { missions: {}, xp: 0, credits: 0, sel: null };
}
function saveProgress(p) { try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ } }

// ---------------------------------------------------------------- style
const CSS = `
.m3 { position:absolute; inset:0; z-index:20; display:flex; flex-direction:column; color:#e6f0fa; font-family:var(--font,"Segoe UI",sans-serif);
   background: radial-gradient(ellipse 70% 60% at 55% 38%, rgba(4,12,22,.08), rgba(3,8,14,.72) 70%, rgba(2,5,10,.92)); pointer-events:auto; user-select:none; }
.m3 * { box-sizing:border-box; }
.m3-ic { flex:none; vertical-align:middle; }
.m3-top { flex:none; height:66px; display:grid; grid-template-columns:1fr auto 1fr; align-items:center; padding:0 22px;
   background:linear-gradient(180deg, rgba(3,9,16,.96), rgba(3,9,16,.72)); border-bottom:1px solid rgba(150,190,230,.16); box-shadow:0 6px 24px rgba(0,0,0,.35); }
.m3-logo { font-weight:900; font-size:22px; letter-spacing:6px; color:#dbe9f7; text-shadow:0 0 18px rgba(90,160,230,.35); }
.m3-logo small { display:block; font-size:10.5px; letter-spacing:3px; color:#7f9bb5; font-weight:700; margin-top:1px; }
.m3-battle { pointer-events:auto; cursor:pointer; border:0; border-radius:4px; padding:12px 58px 11px; font:900 21px/1 var(--font,"Segoe UI"); letter-spacing:5px; color:#fff;
   background:linear-gradient(180deg,#f07a2c 0%,#d24f12 55%,#a8380b 100%); box-shadow:0 0 0 1px rgba(255,190,120,.45) inset, 0 6px 26px rgba(230,90,20,.45);
   text-shadow:0 1px 2px rgba(0,0,0,.5); transition:transform .12s, box-shadow .12s, filter .12s; }
.m3-battle:hover { transform:translateY(-1px); filter:brightness(1.1); box-shadow:0 0 0 1px rgba(255,210,150,.7) inset, 0 8px 34px rgba(240,110,30,.6); }
.m3-battle:disabled { filter:grayscale(1) brightness(.6); cursor:not-allowed; }
.m3-right { display:flex; justify-content:flex-end; align-items:center; gap:14px; }
.m3-diff { display:flex; gap:4px; background:rgba(0,0,0,.3); border:1px solid rgba(150,190,230,.16); border-radius:4px; padding:3px; }
.m3-diff button { cursor:pointer; border:0; border-radius:3px; padding:6px 12px; font:700 12px var(--font,"Segoe UI"); color:#8fa8bf; background:transparent; letter-spacing:.5px; }
.m3-diff button.sel { color:#fff; background:linear-gradient(180deg,#2f6ea8,#1f4d7a); box-shadow:0 0 12px rgba(70,150,230,.35); }
.m3-purse { display:flex; flex-direction:column; align-items:flex-end; font-size:12px; line-height:1.35; color:#9db4c8; font-variant-numeric:tabular-nums; }
.m3-purse b { color:#ffd479; font-weight:800; } .m3-purse b.xp { color:#8fd3ff; }
.m3-help { cursor:pointer; width:32px; height:32px; border-radius:50%; border:1px solid rgba(150,190,230,.3); background:rgba(0,0,0,.3); color:#cfe0f0; font:800 15px var(--font,"Segoe UI"); }
.m3-help:hover { border-color:#8fc3ff; color:#fff; }
.m3-main { flex:1; min-height:0; display:grid; grid-template-columns:330px 1fr 330px; gap:18px; padding:16px 22px 10px; }
.m3-col { min-height:0; display:flex; flex-direction:column; gap:8px; }
.m3-h { font-size:11px; letter-spacing:2.5px; font-weight:800; color:#7f9bb5; text-transform:uppercase; padding:2px 2px 4px; display:flex; justify-content:space-between; }
.m3-list { overflow:auto; display:flex; flex-direction:column; gap:6px; padding-right:4px; scrollbar-width:thin; scrollbar-color:#35506a transparent; }
.m3-mis { position:relative; cursor:pointer; padding:10px 12px 10px 14px; border-radius:4px; background:rgba(6,14,24,.78); border:1px solid rgba(150,190,230,.12);
   transition:background .12s, border-color .12s; }
.m3-mis:hover { background:rgba(14,30,48,.86); border-color:rgba(150,190,230,.3); }
.m3-mis.sel { background:linear-gradient(90deg, rgba(38,92,140,.85), rgba(14,34,56,.88)); border-color:#5aa0e0; box-shadow:0 0 18px rgba(70,150,230,.25); }
.m3-mis.sel::before { content:''; position:absolute; left:0; top:6px; bottom:6px; width:3px; border-radius:2px; background:#8fd3ff; }
.m3-mis .n { font-weight:800; font-size:14.5px; display:flex; align-items:center; gap:6px; }
.m3-mis .s { font-size:11.5px; color:#9db4c8; margin-top:2px; }
.m3-mis .row { display:flex; align-items:center; gap:8px; margin-top:6px; font-size:11px; color:#b6cadb; }
.m3-mis .tag { padding:1px 6px; border-radius:2px; background:rgba(255,255,255,.07); letter-spacing:.5px; font-weight:700; }
.m3-sec { margin:10px 2px 2px; padding-top:8px; border-top:1px solid rgba(214,178,94,.35); font-size:11px; letter-spacing:2.5px; font-weight:800; color:#d6b25e; text-transform:uppercase; }
.m3-mis.op { border-color:rgba(214,178,94,.22); }
.m3-medal { margin-left:auto; color:#d6b25e; font-weight:800; letter-spacing:1px; }
.m3-medal i { font-style:normal; opacity:.25; } .m3-medal i.on { opacity:1; }
.m3-op { position:absolute; inset:0; z-index:2; display:flex; align-items:center; justify-content:center; background:rgba(2,6,12,.72); }
.m3-op .box { max-width:620px; margin:16px; padding:24px 28px; border-radius:4px; background:linear-gradient(180deg, rgba(20,30,42,.97), rgba(8,14,22,.97)); border:1px solid rgba(214,178,94,.45); box-shadow:0 0 40px rgba(0,0,0,.6); }
.m3-op .k { font-size:11px; letter-spacing:3px; font-weight:800; color:#d6b25e; }
.m3-op .t { font-size:26px; font-weight:900; margin:4px 0 2px; }
.m3-op .st { color:#9db4c8; font-size:13px; }
.m3-op p { font-size:14px; line-height:1.6; color:#d4e0ec; margin:14px 0; }
.m3-op .fl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; font-size:12.5px; color:#b6cadb; }
.m3-op .fl b { color:#7f9bb5; font-size:11px; letter-spacing:1.5px; text-transform:uppercase; }
.m3-op .bt { display:flex; gap:10px; justify-content:flex-end; margin-top:18px; }
.m3-op button { cursor:pointer; border:1px solid rgba(150,190,230,.3); border-radius:3px; padding:9px 18px; font:800 13px var(--font,"Segoe UI"); letter-spacing:1.5px; color:#cfe0f0; background:rgba(0,0,0,.3); }
.m3-op button.pri { background:linear-gradient(180deg,#c9a14a,#8a6a24); color:#fff; border-color:#d6b25e; }
.m3-mis .done { margin-left:auto; color:#6dff9e; display:flex; align-items:center; gap:3px; font-weight:700; }
.m3-stars i { font-style:normal; color:rgba(255,255,255,.18); font-size:12px; } .m3-stars i.on { color:#ffc94a; }
.m3-brief { align-self:start; max-width:640px; justify-self:center; width:100%; padding:18px 22px; border-radius:4px;
   background:linear-gradient(180deg, rgba(4,10,18,.8), rgba(4,10,18,.5)); border:1px solid rgba(150,190,230,.12); }
.m3-brief .t { font-size:30px; font-weight:900; letter-spacing:1px; line-height:1.1; }
.m3-brief .st { color:#8fd3ff; font-size:13px; font-weight:700; letter-spacing:1px; margin-top:4px; }
.m3-brief .chips { display:flex; flex-wrap:wrap; gap:6px; margin:12px 0 10px; }
.m3-brief .chip3 { display:flex; align-items:center; gap:5px; font-size:12px; padding:4px 9px; border-radius:3px; background:rgba(255,255,255,.07); color:#d5e3f0; }
.m3-brief p { font-size:13.5px; line-height:1.55; color:#c9d8e6; }
.m3-ship { padding:14px 16px; border-radius:4px; background:rgba(6,14,24,.84); border:1px solid rgba(150,190,230,.14); overflow:auto; scrollbar-width:thin; }
.m3-ship .nm { font-size:24px; font-weight:900; letter-spacing:.5px; display:flex; align-items:center; gap:8px; }
.m3-ship .cl { font-size:12px; color:#9db4c8; margin:2px 0 10px; }
.m3-ship .bars { display:flex; flex-direction:column; gap:7px; margin:8px 0 12px; }
.m3-bar { font-size:11.5px; color:#b6cadb; }
.m3-bar .l { display:flex; justify-content:space-between; margin-bottom:2px; }
.m3-bar .b { height:5px; background:rgba(255,255,255,.08); border-radius:3px; overflow:hidden; }
.m3-bar .b i { display:block; height:100%; background:linear-gradient(90deg,#3f8fd8,#8fd3ff); border-radius:3px; }
.m3-kv { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; font-size:12px; }
.m3-kv span:nth-child(odd) { color:#8aa3ba; } .m3-kv span:nth-child(even) { text-align:right; color:#e6f0fa; font-variant-numeric:tabular-nums; }
.m3-cons { display:flex; flex-wrap:wrap; gap:5px; margin-top:10px; }
.m3-cons span { font-size:11px; padding:3px 7px; border-radius:3px; background:rgba(90,160,230,.14); color:#cfe6ff; }
.m3-car { flex:none; display:flex; justify-content:center; gap:10px; padding:10px 22px 16px; overflow-x:auto;
   background:linear-gradient(0deg, rgba(3,9,16,.97), rgba(3,9,16,.7)); border-top:1px solid rgba(150,190,230,.14); }
.m3-card { position:relative; cursor:pointer; flex:none; width:206px; padding:7px 8px 8px; border-radius:4px; background:rgba(10,22,36,.9);
   border:1px solid rgba(150,190,230,.14); transition:border-color .12s, background .12s, transform .12s; }
.m3-card:hover { border-color:rgba(150,190,230,.4); transform:translateY(-2px); }
.m3-card.sel { border-color:#8fd3ff; background:linear-gradient(180deg, rgba(40,96,146,.9), rgba(12,30,50,.94)); box-shadow:0 0 20px rgba(80,160,240,.3); }
.m3-card.off { cursor:not-allowed; opacity:.38; transform:none; }
.m3-card .hd { display:flex; align-items:center; gap:5px; font-size:13px; font-weight:800; }
.m3-card .hd .ty { margin-left:auto; font-size:10.5px; font-weight:700; color:#9db4c8; letter-spacing:1px; }
.m3-card .rec { position:absolute; top:-8px; right:8px; font-size:9.5px; font-weight:800; letter-spacing:1px; padding:1px 6px; border-radius:2px; background:#ffc94a; color:#1b1300; }
.m3-card .lk { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#cfe0f0; }
.m3-sil { display:block; margin:3px auto 0; }
.m3-sil .wl { stroke:rgba(120,180,230,.25); stroke-width:1; }
.m3-sil g { fill:#b9cde0; } .m3-card.sel .m3-sil g { fill:#eaf5ff; }
.m3 .cls { vertical-align:-1px; }
.m3-ally { color:#5dff8c; } .m3-enemy { color:#ff5a4d; }
@media (max-width: 1150px) { .m3-main { grid-template-columns:300px 1fr; } .m3-brief { display:none; } .m3-battle { padding:11px 30px; font-size:18px; } }
@media (max-height: 720px) { .m3-brief p { font-size:12.5px; } .m3-car { padding-bottom:10px; } }

/* ---------------- results ---------------- */
.m3r { position:absolute; inset:0; z-index:21; display:flex; flex-direction:column; color:#e6f0fa; font-family:var(--font,"Segoe UI",sans-serif);
   background:linear-gradient(180deg, rgba(2,6,12,.9), rgba(3,9,16,.82) 30%, rgba(2,6,12,.94)); pointer-events:auto; user-select:none; }
.m3r * { box-sizing:border-box; }
.m3r-head { flex:none; text-align:center; padding:26px 20px 14px; }
.m3r-title { font-size:64px; font-weight:900; letter-spacing:14px; line-height:1; text-indent:14px; }
.m3r.win .m3r-title { color:#ffd479; text-shadow:0 0 40px rgba(255,190,80,.45); }
.m3r.lose .m3r-title { color:#ff6a5a; text-shadow:0 0 40px rgba(255,80,60,.4); }
.m3r-reason { font-size:16px; color:#dbe7f2; margin-top:10px; }
.m3r-meta { font-size:12px; letter-spacing:2px; color:#7f9bb5; margin-top:6px; text-transform:uppercase; font-weight:700; }
.m3r-body { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.15fr); gap:18px; padding:6px 28px 10px; max-width:1400px; width:100%; margin:0 auto; }
.m3r-box { min-height:0; overflow:auto; padding:14px 16px; border-radius:4px; background:rgba(6,14,24,.8); border:1px solid rgba(150,190,230,.12); scrollbar-width:thin; }
.m3r-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; }
.m3r-st { padding:9px 10px; border-radius:3px; background:rgba(255,255,255,.045); }
.m3r-st b { display:block; font-size:21px; font-weight:800; font-variant-numeric:tabular-nums; }
.m3r-st span { font-size:11px; color:#8aa3ba; letter-spacing:.5px; }
.m3r-st.hl b { color:#8fd3ff; }
.m3r-rib { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
.m3r-rib div { font-size:11.5px; padding:4px 8px; border-radius:2px; background:linear-gradient(180deg,#2c4a66,#1b3048); border:1px solid rgba(150,200,240,.25); }
.m3r-rib div b { color:#ffd479; margin-left:4px; }
.m3r-obj { margin-top:12px; font-size:12.5px; display:flex; flex-direction:column; gap:4px; }
.m3r-hist { margin-top:12px; padding:10px 12px; border-left:3px solid #d6b25e; background:rgba(214,178,94,.07); font-size:12.5px; line-height:1.5; color:#d4e0ec; }
.m3r-hist b { display:block; font-size:11px; letter-spacing:2px; color:#d6b25e; margin-bottom:4px; }
.m3r-medal { font-size:13px; font-weight:800; color:#d6b25e; letter-spacing:1px; margin-top:10px; }
.m3r-obj .done { color:#8dffb0; } .m3r-obj .failed { color:#ff8f82; } .m3r-obj .active { color:#c9d8e6; }
.m3r-teams { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.m3r-teams table { width:100%; border-collapse:collapse; font-size:12px; }
.m3r-teams td { padding:4px 5px; border-bottom:1px solid rgba(255,255,255,.05); white-space:nowrap; }
.m3r-teams td.n { overflow:hidden; text-overflow:ellipsis; max-width:130px; }
.m3r-teams td.d { text-align:right; font-variant-numeric:tabular-nums; color:#c9d8e6; }
.m3r-teams tr.dead td { color:#6f7f8f; } .m3r-teams tr.dead td.n { text-decoration:line-through; }
.m3r-teams tr.me td { color:#fff; font-weight:800; background:rgba(90,160,230,.12); }
.m3r-foot { flex:none; display:flex; align-items:center; justify-content:center; gap:34px; padding:14px 20px 22px;
   background:linear-gradient(0deg, rgba(3,9,16,.97), rgba(3,9,16,.6)); border-top:1px solid rgba(150,190,230,.14); }
.m3r-earn { display:flex; gap:26px; }
.m3r-earn div { text-align:center; } .m3r-earn b { display:block; font-size:28px; font-weight:900; font-variant-numeric:tabular-nums; }
.m3r-earn .xp b { color:#8fd3ff; } .m3r-earn .cr b { color:#ffd479; } .m3r-earn span { font-size:11px; letter-spacing:2px; color:#7f9bb5; font-weight:700; }
.m3r-btns { display:flex; gap:10px; }
.m3r-btn { cursor:pointer; border:1px solid rgba(150,190,230,.3); border-radius:4px; padding:12px 24px; font:800 14px var(--font,"Segoe UI"); letter-spacing:1.5px;
   color:#e6f0fa; background:linear-gradient(180deg,#2d3a48,#1b2430); transition:filter .12s, transform .12s; }
.m3r-btn:hover { filter:brightness(1.2); transform:translateY(-1px); }
.m3r-btn.pri { border-color:rgba(255,190,120,.5); background:linear-gradient(180deg,#f07a2c,#b8420e); color:#fff; }
/* career: captain button, locked cards, module + skill panels, reward breakdown */
.m3-capt { cursor:pointer; position:relative; border:1px solid rgba(214,178,94,.45); border-radius:3px; padding:7px 10px; background:rgba(0,0,0,.3); color:#d6b25e; font:800 12px var(--font,"Segoe UI"); letter-spacing:1.5px; }
.m3-capt:hover { border-color:#d6b25e; color:#fff; } .m3-capt b { color:#fff; margin-left:3px; }
.m3-capt i { position:absolute; top:-7px; right:-7px; min-width:16px; height:16px; border-radius:8px; background:#ffc94a; color:#1b1300; font:900 10.5px/16px var(--font,"Segoe UI"); font-style:normal; letter-spacing:0; }
.m3-card.lock .lk { flex-direction:column; gap:2px; background:rgba(4,10,18,.5); font-size:12px; font-weight:800; color:#8fd3ff; letter-spacing:.5px; }
.m3-prog { margin-top:12px; padding-top:10px; border-top:1px solid rgba(150,190,230,.12); }
.m3-mod { display:grid; grid-template-columns:92px 32px 1fr auto; align-items:center; gap:6px; font-size:11.5px; padding:3px 0; }
.m3-mod .n { color:#b6cadb; font-weight:700; } .m3-mod .fx { color:#8fd3ff; font-size:10.5px; } .m3-mod .max { color:#7f9bb5; font-size:10.5px; font-weight:800; letter-spacing:1px; }
.m3-pips { display:flex; gap:2px; } .m3-pips i { width:9px; height:5px; border-radius:1px; background:rgba(255,255,255,.12); } .m3-pips i.on { background:#ffd479; }
.m3-buy { cursor:pointer; border:1px solid rgba(214,178,94,.5); border-radius:3px; padding:3px 8px; background:rgba(60,44,10,.5); color:#ffd479; font:800 11px var(--font,"Segoe UI"); font-variant-numeric:tabular-nums; }
.m3-buy:hover:not(:disabled) { filter:brightness(1.25); } .m3-buy:disabled { opacity:.4; cursor:not-allowed; }
.m3-buy.big { width:100%; padding:9px; font-size:13px; letter-spacing:1.5px; color:#cfeaff; border-color:rgba(143,211,255,.5); background:rgba(20,60,100,.5); }
.m3-prog .hint { font-size:11px; color:#8aa3ba; margin-top:5px; text-align:center; }
.m3-op .box.cap { max-width:760px; }
.m3-op .box.cap .m3-bar { margin-top:10px; }
.m3-skills { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:14px 0 4px; }
.m3-op .m3-skill { position:relative; text-align:left; padding:8px 30px 8px 10px; letter-spacing:0; font-weight:400; display:flex; flex-direction:column; gap:2px; }
.m3-skill b { font-size:13px; color:#e6f0fa; } .m3-skill span { font-size:11px; color:#9db4c8; }
.m3-skill i { position:absolute; top:8px; right:9px; font-style:normal; font-weight:900; color:#ffd479; }
.m3-op .m3-skill.on { border-color:#8fd3ff; background:rgba(40,96,146,.55); cursor:default; }
.m3-op .m3-skill:disabled { opacity:.4; cursor:not-allowed; }
.m3-op button.warn { border-color:rgba(230,110,90,.5); color:#ffb4a4; }
.m3-confirm { margin-top:12px; padding:10px 12px; border:1px solid rgba(230,110,90,.5); border-radius:3px; background:rgba(60,14,10,.5); font-size:12.5px; color:#ffd8cf; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.m3-confirm span { flex:1; min-width:200px; }
.m3r-rw { margin-top:12px; }
.m3r-rw table { width:100%; border-collapse:collapse; font-size:12px; margin-top:2px; font-variant-numeric:tabular-nums; }
.m3r-rw td { padding:2px 4px; color:#b6cadb; } .m3r-rw td.xp { text-align:right; color:#8fd3ff; } .m3r-rw td.cr { text-align:right; color:#ffd479; }
.m3r-rw tr.sum td { border-top:1px solid rgba(150,190,230,.2); font-weight:800; color:#e6f0fa; }
@media (max-width: 1000px) { .m3r-body { grid-template-columns:1fr; overflow:auto; } .m3r-title { font-size:44px; } .m3r-foot { flex-wrap:wrap; gap:14px; } }
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
   // keep the selection valid: allowed in this mission and unlocked (op ships are never locked)
   _fixShip() {
      const allowed = this._allowed();
      const ok = (k) => allowed.includes(k) && isUnlocked(this.profile, k);
      if (ok(this.ship)) return;
      const rec = getMission(this.mission)?.recommendedShip;
      this.ship = ok(rec) ? rec : (allowed.find(ok) || allowed[0]);
   }
   // loadout snapshot main3d hands to the World for the player ship
   loadout(ship) { return loadoutFor(this.profile, ship); }
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
      if (!opts && !isUnlocked(this.profile, o.ship)) return;     // locked ship is only selected for viewing
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
            <div class="bt"><button data-op="back">ZURÜCK</button><button class="pri" data-op="go">IN DIE SCHLACHT</button></div>
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
      el.innerHTML = `<div class="box cap">
            <div class="k">KAPITÄN · FERTIGKEITEN</div>
            <div class="t">Stufe ${cl.level}</div>
            <div class="st">${fmtInt(pf.totalXp)} EP gesamt · ${cl.next ? `nächste Stufe bei ${fmtInt(cl.next)} EP` : 'Höchststufe erreicht'} · <b class="pts">${free}</b> freie Punkte · ${pf.battles} Gefechte</div>
            <div class="m3-bar"><div class="b"><i style="width:${pct}%"></i></div></div>
            <div class="m3-skills">${SKILLS.map(s => {
               const has = pf.skills.includes(s.key);
               return `<button class="m3-skill ${has ? 'on' : ''}" data-skill="${s.key}" ${!has && s.cost > free ? 'disabled' : ''}><b>${esc(s.name)}</b><span>${esc(s.desc)}</span><i>${s.cost}</i></button>`;
            }).join('')}</div>
            <div class="bt"><button class="warn" data-cap="reset">PROFIL ZURÜCKSETZEN</button><span style="flex:1"></span>
               <button data-cap="respec" ${pf.skills.length ? '' : 'disabled'}>UMSCHULEN</button><button class="pri" data-cap="close">FERTIG</button></div>
            ${confirm ? `<div class="m3-confirm"><span>Wirklich zurücksetzen? EP, Kreditpunkte, erforschte Schiffe, Module und Fertigkeiten gehen verloren. Orden und Missionssiege bleiben erhalten.</span>
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
      const shipLocked = !isUnlocked(pf, k0), cl = captainLevel(pf.totalXp), free = skillPointsFree(pf);
      const prog = !S ? '' : shipLocked ? `<div class="m3-prog">
            <div class="m3-h"><span>Forschung</span><span>${fmtInt(pf.xp)} EP verfügbar</span></div>
            <button class="m3-buy big" data-act="unlock" ${canUnlock(pf, k0) ? '' : 'disabled'}>ERFORSCHEN · ${fmtInt(UNLOCK_XP[k0])} EP</button>
            ${canUnlock(pf, k0) ? '' : `<div class="hint">Noch ${fmtInt(UNLOCK_XP[k0] - pf.xp)} EP benötigt</div>`}</div>`
         : `<div class="m3-prog"><div class="m3-h"><span>Module</span><span>${fmtInt(pf.credits)} Kr.</span></div>
            ${MODULES.map(d => {
               const t = moduleTier(pf, k0, d.key), c = moduleCost(pf, k0, d.key);
               return `<div class="m3-mod"><span class="n">${d.name}</span><span class="m3-pips">${d.tiers.map((_, i) => `<i class="${i < t ? 'on' : ''}"></i>`).join('')}</span>
                  <span class="fx">${t ? modFx(d.tiers[t - 1]) : ''}</span>
                  ${c ? `<button class="m3-buy" data-mod="${d.key}" ${pf.credits >= c ? '' : 'disabled'} title="Stufe ${t + 1}: ${modFx(d.tiers[t])}">${fmtInt(c)}</button>` : '<span class="max">MAX</span>'}</div>`;
            }).join('')}</div>`;
      const medal = (n) => `<span class="m3-medal" title="Orden">${[1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}">✦</i>`).join('')}</span>`;
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
         <div class="t">${esc(m.name)}</div>
         <div class="st">${esc(m.subtitle)}</div>
         <div class="chips">
            <span class="chip3">${esc(TYPE_LABEL[m.type] || m.type)}</span>
            <span class="chip3">${envChip}</span>
            <span class="chip3">${icon('clock', 15)}${Math.round(m.timeLimit / 60)} min</span>
            <span class="chip3">${icon('map', 15)}${Math.round(m.arena * 2 / 1000)} × ${Math.round(m.arena * 2 / 1000)} km</span>
            <span class="chip3">Schwierigkeit ${stars(m.stars)}</span>
         </div>
         <p>${esc(m.briefing)}</p>`;
      const shipPanel = S ? `
         <div class="nm">${classSvg(S.type, 18)}${esc(S.name)}</div>
         <div class="cl">${esc(S.typeName)} · ${esc(S.className)}${S.nationName ? ' · ' + esc(S.nationName) : ''}</div>
         <div class="bars">${RATING_LABEL.map(([k, l]) => `<div class="m3-bar"><div class="l"><span>${l}</span><span>${S.ratings[k]}</span></div><div class="b"><i style="width:${S.ratings[k]}%"></i></div></div>`).join('')}</div>
         <div class="m3-kv">
            <span>Kampfkraft</span><span>${fmtInt(S.hp)} HP</span>
            <span>Hauptbatterie</span><span>${esc(S.main)}</span>
            <span>Reichweite</span><span>${String(S.rangeKm).replace('.', ',')} km</span>
            <span>Nachladen</span><span>${String(S.reload).replace('.', ',')} s · 180° in ${S.traverse180} s</span>
            <span>Sprenggranate</span><span>${fmtInt(S.heDmg)}</span>
            <span>Panzergranate</span><span>${fmtInt(S.apDmg)}</span>
            ${S.torp ? `<span>Torpedos</span><span>${S.torp.launchers}× ${Math.round(S.torp.tubes / S.torp.launchers)} · ${String(S.torp.rangeKm).replace('.', ',')} km · ${S.torp.speedKn} kn</span>` : ''}
            ${S.secRangeKm ? `<span>Sekundär</span><span>${String(S.secRangeKm).replace('.', ',')} km</span>` : ''}
            <span>Geschwindigkeit</span><span>${String(S.speedKn).replace('.', ',')} kn</span>
            <span>Tarnwert</span><span>${String(S.detectKm).replace('.', ',')} km</span>
            <span>Gürtelpanzer</span><span>${S.belt} mm</span>
            <span>Abmessungen</span><span>${S.lengthM} × ${String(S.beamM).replace('.', ',')} m</span>
         </div>
         <div class="m3-cons">${S.consumables.map(c => `<span>${esc(c)}</span>`).join('')}</div>${prog}` : '';
      // fixed op ships (Duke of York, Washington ...) join the row only while their operation is selected
      const cards = [...PLAYABLE, ...allowed.filter(k => !PLAYABLE.includes(k))].map(k => {
         const st = SHIP_STATS[k], ok = allowed.includes(k), lk = ok && !isUnlocked(pf, k);
         return `<div class="m3-card ${k === this.ship ? 'sel' : ''} ${ok ? '' : 'off'} ${lk ? 'lock' : ''}" data-ship="${esc(k)}" title="${ok ? (lk ? 'Gesperrt — mit EP erforschen' : '') : 'In dieser Mission nicht verfügbar'}">
            ${m.recommendedShip === k && ok ? '<span class="rec">EMPFOHLEN</span>' : ''}
            <div class="hd">${classSvg(st.type, 13)}<span>${esc(st.name)}</span><span class="ty">${esc(st.type)}</span></div>
            ${silhouetteSvg(k)}
            ${ok ? (lk ? `<div class="lk">${icon('lock', 20)}<span>${fmtInt(UNLOCK_XP[k])} EP</span></div>` : '') : `<div class="lk">${icon('lock', 26)}</div>`}
         </div>`;
      }).join('');
      this.root.innerHTML = `
         <div class="m3-top">
            <div class="m3-logo">WARSCHIFFE<small>3D · EINZELSPIELER-KAMPAGNE</small></div>
            <button class="m3-battle" data-act="battle" ${shipLocked ? 'disabled title="Schiff zuerst erforschen"' : ''}>GEFECHT!</button>
            <div class="m3-right">
               <div class="m3-purse"><span><b class="xp">${fmtInt(pf.xp)}</b> EP</span><span><b>${fmtInt(pf.credits)}</b> Kreditpunkte</span></div>
               <button class="m3-capt" data-act="captain" title="Kapitän &amp; Fertigkeiten">KAPITÄN<b>${cl.level}</b>${free > 0 ? `<i>${free}</i>` : ''}</button>
               <div class="m3-diff">${DIFFS.map(([k, l]) => `<button data-diff="${k}" class="${k === this.difficulty ? 'sel' : ''}">${l}</button>`).join('')}</div>
               <button class="m3-help" data-act="help" title="So kämpfst du">?</button>
            </div>
         </div>
         <div class="m3-main">
            <div class="m3-col"><div class="m3-h"><span>Missionen</span><span>${Object.values(pr.missions || {}).filter(x => x.won).length}/${MISSIONS.length}</span></div><div class="m3-list">${misList}</div></div>
            <div class="m3-brief">${brief}</div>
            <div class="m3-col"><div class="m3-h"><span>Schiff</span></div><div class="m3-ship">${shipPanel}</div></div>
         </div>
         <div class="m3-car">${cards}</div>`;
      this.root.querySelectorAll('[data-mis]').forEach(el => el.addEventListener('click', () => this.selectMission(el.dataset.mis)));
      this.root.querySelectorAll('[data-ship]').forEach(el => el.addEventListener('click', () => this.selectShip(el.dataset.ship)));
      this.root.querySelectorAll('[data-diff]').forEach(el => el.addEventListener('click', () => {
         this.difficulty = el.dataset.diff; this._remember(); this.render(); this.cb.onClick?.();
      }));
      this.root.querySelector('[data-act="battle"]').addEventListener('click', () => this.start());
      this.root.querySelector('[data-act="help"]').addEventListener('click', () => this.cb.onHowTo?.());
      this.root.querySelector('[data-act="captain"]').addEventListener('click', () => this._openCaptain());
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
   // extra: { ribbons: Map(kind -> count), ribbonNames }
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
         <table>${rw.lines.map(l => `<tr><td>${esc(l.label)}</td><td class="xp">${fmtInt(l.xp)} EP</td><td class="cr">${fmtInt(l.credits)} Kr.</td></tr>`).join('')}
         <tr class="sum"><td>Gesamt</td><td class="xp">${fmtInt(rw.xp)} EP</td><td class="cr">${fmtInt(rw.credits)} Kr.</td></tr></table>
         ${lvl1 > lvl0 ? `<div class="m3r-medal">Kapitän erreicht Stufe ${lvl1} · +${lvl1 - lvl0} Fertigkeitspunkt${lvl1 - lvl0 > 1 ? 'e' : ''}</div>` : ''}
         ${newShips.length ? `<div class="m3r-medal">Erforschbar: ${newShips.map(k => esc(SHIPS[k].name)).join(', ')}</div>` : ''}</div>`;
      const rec = pr.missions[opts.mission] || { won: false, best: 0, plays: 0 };
      rec.plays++; rec.won = rec.won || !!res.victory; rec.best = Math.max(rec.best, res.xp || 0);
      const isOp = m.group === 'ops', medal = isOp ? opStars(world) : 0;
      if (isOp) rec.stars = Math.max(rec.stars || 0, medal);
      pr.missions[opts.mission] = rec;
      saveProgress(pr);

      const tile = (v, l, hl) => `<div class="m3r-st ${hl ? 'hl' : ''}"><b>${v}</b><span>${l}</span></div>`;
      const acc = st.shotsFired ? Math.round((st.hits || 0) / st.shotsFired * 100) + ' %' : '—';
      const tiles = [
         tile(fmtInt(st.dmg), 'Schaden', true), tile(st.kills || 0, 'Versenkt', true), tile(st.citadels || 0, 'Zitadellen'),
         tile(st.fires || 0, 'Brände gelegt'), tile(st.floods || 0, 'Flutungen'), tile(`${st.hits || 0} / ${st.shotsFired || 0}`, 'Treffer / Schüsse'),
         tile(acc, 'Trefferquote'), tile(st.torpHits || 0, 'Torpedotreffer'), tile(fmtInt(st.spottingDmg), 'Aufklärungsschaden'),
         tile(fmtInt(st.tanked), 'Erhaltener Schaden'), tile(fmtInt(st.potential), 'Potenzieller Schaden'), tile(fmtInt(st.healed), 'Repariert'),
      ].join('');
      const rib = extra.ribbons ? RIBBON_ORDER.filter(k => extra.ribbons.get(k)).map(k => `<div>${esc(extra.ribbonNames?.[k] || k)}<b>×${extra.ribbons.get(k)}</b></div>`).join('') : '';
      const objs = (world.mission?.objectives || []).map(o => `<div class="${esc(o.state)}">${o.state === 'done' ? '✔' : o.state === 'failed' ? '✘' : '•'} ${esc(o.text)}</div>`).join('');
      const roster = world.roster || world.ships;
      const row = (s) => `<tr class="${s.alive ? '' : (s.escaped ? '' : 'dead')} ${s === p ? 'me' : ''}">
         <td class="${s.side === 'player' ? 'm3-ally' : 'm3-enemy'}">${classSvg(s.type || s.cfg?.hull?.type, 12)}</td><td class="n">${esc(s.name)}</td>
         <td class="d">${fmtInt(s.dmgDealt)}</td><td class="d">${s.kills || 0}</td>
         <td class="d">${s.alive ? fmtInt(s.hp) + ' HP' : s.escaped ? (ESCAPE_LABEL[s.escaped] || 'entkommen') : 'versenkt'}</td></tr>`;
      const head = '<tr><td></td><td></td><td class="d">Schaden</td><td class="d">Kills</td><td class="d">Status</td></tr>';
      const allies = roster.filter(s => s.side === 'player'), enemies = roster.filter(s => s.side !== 'player');
      const next = MISSIONS[(MISSIONS.findIndex(x => x.id === opts.mission) + 1) % MISSIONS.length];
      const win = !!res.victory;
      this.resRoot.className = 'm3r ' + (win ? 'win' : 'lose');
      this.resRoot.innerHTML = `
         <div class="m3r-head">
            <div class="m3r-title">${win ? 'SIEG' : 'NIEDERLAGE'}</div>
            <div class="m3r-reason">${esc(res.reason || '')}</div>
            <div class="m3r-meta">${esc(m.name)} · ${esc(p?.name || '')} · ${mmss(res.time ?? world.time)} · ${esc(DIFFS.find(d => d[0] === opts.difficulty)?.[1] || '')}</div>
         </div>
         <div class="m3r-body">
            <div class="m3r-box"><div class="m3-h"><span>Persönliche Leistung</span></div><div class="m3r-grid">${tiles}</div>
               ${rib ? `<div class="m3r-rib">${rib}</div>` : ''}${rwBox}${objs ? `<div class="m3r-obj">${objs}</div>` : ''}
               ${isOp && medal ? `<div class="m3r-medal">${'✦'.repeat(medal)} ${MEDAL[medal]} erhalten</div>` : ''}
               ${isOp && m.debrief ? `<div class="m3r-hist"><b>HISTORISCHER HINTERGRUND</b>${esc(m.debrief)}</div>` : ''}</div>
            <div class="m3r-box"><div class="m3r-teams">
               <div><div class="m3-h"><span class="m3-ally">Eigenes Team</span></div><table>${head}${allies.map(row).join('')}</table></div>
               <div><div class="m3-h"><span class="m3-enemy">Gegner</span></div><table>${head}${enemies.map(row).join('')}</table></div>
            </div></div>
         </div>
         <div class="m3r-foot">
            <div class="m3r-earn"><div class="xp"><b data-count="${res.xp || 0}">0</b><span>ERFAHRUNG</span></div><div class="cr"><b data-count="${res.credits || 0}">0</b><span>KREDITPUNKTE</span></div></div>
            <div class="m3r-btns">
               <button class="m3r-btn pri" data-act="again">NOCHMAL</button>
               <button class="m3r-btn" data-act="next">NÄCHSTE MISSION</button>
               <button class="m3r-btn" data-act="port">HAFEN</button>
            </div>
         </div>`;
      this.resRoot.querySelector('[data-act="again"]').addEventListener('click', () => { this.hideResults(); this.start(opts); });
      this.resRoot.querySelector('[data-act="next"]').addEventListener('click', () => {
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
