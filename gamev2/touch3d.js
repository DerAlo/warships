// game3d/touch3d.js — touch controls for tablets and phones (landscape). Only switched on when the
// device has a coarse pointer or the first real touch arrives; the mouse/keyboard path is untouched.
//
// The overlay never runs gameplay code of its own: it drives the same abstract input state the
// keyboard and mouse fill (Input3D: virtual key taps/holds, mouse.dx/dy, mouse.down/clicked, wheel
// notches), so main3d.js, airui.js, subui.js and shellcam.js react exactly as to the keys. The
// two absolute controls (telegraph lever, rudder) call main3d's setTelegraph / setRudder.
//
// Cost: pointer handlers only add numbers; the DOM is touched when the visibility changes and in
// a 5 Hz refresh that writes a class or text only when its value changed (no reads of layout).
//
// main3d.js: new TouchUi({ input, canvas, api }) ; per frame touch.frame(dt, playing).
// api.state() -> see main3d touchState(); api.setTelegraph(n); api.setRudder(n).

const LOOK_GAIN = 1.25;          // camera px per finger px (mouse px equivalent)
const PINCH_GAIN = 5;            // wheel notches per e-fold of finger distance
const REFRESH = 0.2;             // s between state refreshes of the buttons
const TELE_STEPS = [4, 3, 2, 1, 0, -1];
const TELE_TXT = { 4: 'Voll', 3: '3/4', 2: '1/2', 1: '1/4', 0: 'Stopp', '-1': 'Zurück' };
const RUD_TXT = { '-2': 'hart Bb', '-1': 'halb Bb', 0: 'mittschiffs', 1: 'halb Stb', 2: 'hart Stb' };
const AIR_TYPES = [['1', 'tb', 'Anti&shy;Schiff-Jet'], ['2', 'db', 'Mehrzweck-Jet'], ['3', 'ft', 'Jagdjet']];
// keep in step with the media queries of CSS below
const MQ_COMPACT = '(max-height: 480px)';                        // phone held sideways
const MQ_NARROW = '(max-height: 480px) and (max-width: 899px)';  // ... and a short one: consumables go left
const MQ_UPRIGHT = '(orientation: portrait) and (max-width: 600px)';
const MORE_OPEN = 5;             // s the phone's "more" fold stays open
const OBJ_SHOW = 8;              // s the phone shows the objectives after a change
const LATE_PLATES =['sub-panel', 'asw-panel', 'ops-panel', 'air-panel', 'aa-panel'];   // built by subui / airui on demand
const LATE_BOTTOM = 'mx-sys';                                            // built by missileui on the first start

const CSS = `
body.touch { overscroll-behavior: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
body.touch canvas#scene3d { touch-action: none; }
#touch-ui { position: absolute; inset: 0; z-index: 6; pointer-events: none; touch-action: none; font-family: var(--font); color: var(--hud);
   --tu-s: 1; --sl: env(safe-area-inset-left, 0px); --sr: env(safe-area-inset-right, 0px); --sb: env(safe-area-inset-bottom, 0px); --st: env(safe-area-inset-top, 0px);
   -webkit-tap-highlight-color: transparent; }
#touch-ui > * { pointer-events: auto; touch-action: none; }
.tu-btn { position: absolute; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
   width: 56px; height: 56px; border-radius: 50%; border: 2px solid var(--panel-edge); background: rgba(17, 20, 21, .5);
   color: var(--hud); font: 700 10px/1.05 var(--font); letter-spacing: .6px; text-transform: uppercase; text-align: center; text-shadow: 0 1px 2px rgba(0,0,0,.8); }
.tu-btn svg { width: 22px; height: 22px; flex: none; }
.tu-btn.on { border-color: var(--gold); color: var(--gold); background: color-mix(in srgb, var(--gold) 18%, rgba(17,20,21,.55)); }
.tu-btn.press { filter: brightness(1.5); transform: scale(.94); }
.tu-btn.off { opacity: .35; }
#tu-fire { right: calc(18px + var(--sr)); bottom: calc(18px + var(--sb)); width: 104px; height: 104px; border: 3px solid var(--signal-hi);
   background: radial-gradient(circle, rgba(179,53,42,.55), rgba(125,34,25,.4)); font: 700 15px var(--font-cond); letter-spacing: 2px; color: var(--flag-w); }
#tu-fire.press { background: radial-gradient(circle, rgba(210,70,52,.85), rgba(125,34,25,.7)); }
#tu-scope { right: calc(132px + var(--sr)); bottom: calc(18px + var(--sb)); }
#tu-lock { right: calc(132px + var(--sr)); bottom: calc(86px + var(--sb)); }
#tu-free { right: calc(198px + var(--sr)); bottom: calc(18px + var(--sb)); }
#tu-col { position: absolute; right: calc(42px + var(--sr)); bottom: calc(132px + var(--sb)); display: flex; flex-direction: column-reverse; gap: 8px; pointer-events: none; }
#tu-col .tu-btn, #tu-bar .tu-btn { position: relative; pointer-events: auto; }
#tu-bar { position: absolute; left: 50%; bottom: calc(16px + var(--sb)); transform: translateX(-50%); display: flex; gap: 6px; pointer-events: none; }
#tu-bar .tu-btn { width: 96px; height: 50px; border-radius: 3px; font-size: 11px; }
.tu-sys { position: absolute; top: calc(6px + var(--st)); left: 50%; transform: translateX(-50%); display: flex; gap: 8px; }
.tu-sys .tu-btn { position: relative; width: 48px; height: 48px; border-radius: 3px; }
/* telegraph lever (left edge) and rudder track (bottom left) */
#tu-tele { position: absolute; left: calc(14px + var(--sl)); bottom: calc(16px + var(--sb)); width: 64px; padding: 4px 0; display: flex; flex-direction: column;
   border: 1px solid var(--panel-edge); background: rgba(17, 20, 21, .5); border-radius: 3px; }
#tu-tele .tu-kn { font: 700 13px var(--mono); text-align: center; color: #fff; padding: 2px 0 4px; border-bottom: 1px solid var(--panel-edge); }
#tu-tele .tu-st { height: 40px; display: flex; align-items: center; justify-content: center; font: 600 11px var(--mono); color: #8d8676; border-top: 1px solid rgba(255,255,255,.05); }
#tu-tele .tu-st.on { color: var(--ink); background: var(--gold); font-weight: 700; }
#tu-tele.squad .tu-st { display: none; }
#tu-tele .tu-sq { display: none; height: 92px; align-items: center; justify-content: center; font: 700 11px var(--font); letter-spacing: 1px; text-transform: uppercase; color: var(--hud); }
#tu-tele.squad .tu-sq { display: flex; } #tu-tele .tu-sq.press { color: var(--ink); background: var(--gold); }
#tu-rud { position: absolute; left: calc(88px + var(--sl)); bottom: calc(16px + var(--sb)); width: 212px; height: 56px;
   border: 1px solid var(--panel-edge); background: rgba(17, 20, 21, .5); border-radius: 3px; }
#tu-rud .tu-tr { position: absolute; left: 22px; right: 22px; top: 25px; height: 2px; background: rgba(255,255,255,.25); }
#tu-rud .tu-nt { position: absolute; top: 19px; width: 2px; height: 14px; margin-left: -1px; background: rgba(255,255,255,.35); }
#tu-rud .tu-th { position: absolute; top: 12px; width: 28px; height: 28px; margin-left: -14px; border-radius: 50%; background: var(--gold); box-shadow: 0 0 0 2px rgba(0,0,0,.4); transition: left .12s; }
#tu-rud .tu-rl { position: absolute; left: 0; right: 0; bottom: 2px; text-align: center; font: 600 10px var(--font); color: var(--gold); letter-spacing: 1px; text-transform: uppercase; }
#tu-rud .tu-lr { position: absolute; top: 4px; font: 700 9px var(--font); color: var(--hud-dim); letter-spacing: 1px; }
/* The instrument plates make room for the controls. TouchUi._arrange() regroups them (hud.js finds them by
   id, so moving them is free): a left column (situation, ship strip, sub / air group, orders, own ships), a
   right column (minimap, lock, enemy ships, loss reports) and a bottom stack (hit tally, turret schematic,
   consumables, ammunition). The columns end above the controls and clip what does not fit (the low-priority
   plates come last and shrink first), so nothing can run into the lever, the rudder or the fire cluster. */
body.touch { --tu-hud: .8; --tu-map: .7; }
body.touch #hint-line, body.touch #nav, body.touch #free-look, body.touch .kb, body.touch .ckey { display: none !important; }
body.touch #topbar, body.touch #bottom-left, body.touch #bottom-center, body.touch #bottom-right { display: none; }
#tu-hud-l, #tu-hud-r { position: absolute; display: flex; flex-direction: column; gap: 6px; overflow: hidden; pointer-events: none; }
#tu-hud-l { left: calc(10px + env(safe-area-inset-left, 0px)); top: calc(8px + env(safe-area-inset-top, 0px)); bottom: calc(298px + env(safe-area-inset-bottom, 0px)); align-items: flex-start; }
#tu-hud-r { right: calc(8px + env(safe-area-inset-right, 0px)); top: calc(8px + env(safe-area-inset-top, 0px)); bottom: calc(332px + env(safe-area-inset-bottom, 0px)); align-items: flex-end; }
body.touch #tu-hud-l > *, body.touch #tu-hud-r > * { position: static; transform: none; margin: 0; flex-shrink: 0; zoom: var(--tu-hud); }
body.touch #objectives, body.touch #roster-ally, body.touch #roster-enemy, body.touch #killfeed { flex-shrink: 1; min-height: 0; overflow: hidden; }
body.touch #roster-ally, body.touch #roster-enemy { display: none; justify-content: flex-start; }
body.touch #roster-ally::before { text-align: left; }
body.touch #roster-enemy, body.touch #roster-enemy::before { justify-content: flex-end; text-align: right; }
body.touch #killfeed { width: auto; max-width: 330px; }
body.touch #tu-hud-r > #minimap-wrap { zoom: var(--tu-map); pointer-events: auto; cursor: pointer; }
/* phone: the target card sits under the system buttons (TouchUi._arrange) */
#tu-hud-t { position: absolute; top: calc(60px + env(safe-area-inset-top, 0px)); right: calc(116px + env(safe-area-inset-right, 0px)); display: flex; flex-direction: column; align-items: flex-end; pointer-events: none; }
body.touch #tu-hud-t > * { position: static; transform: none; margin: 0; zoom: var(--tu-hud); }
/* while a finger aims on the sea the info plates step back */
#tu-hud-l, #tu-hud-r, #tu-hud-t { transition: opacity .25s; }
body.touch.tu-aim #tu-hud-l, body.touch.tu-aim #tu-hud-r, body.touch.tu-aim #tu-hud-t { opacity: .3; }
#tu-more { display: none; }
/* ship card: a compact hull-points strip */
body.touch #ship-card { width: 250px; padding: 5px 10px 6px; display: grid; grid-template-columns: 1fr auto; grid-template-areas: "head head" "bar text"; align-items: center; column-gap: 8px; row-gap: 3px; }
body.touch #ship-card .sc-head { grid-area: head; }
body.touch #ship-card .hp-bar { grid-area: bar; }
body.touch #hp-text { grid-area: text; margin-top: 0; font-size: 12px; gap: 4px; }
body.touch #silhouette, body.touch #ship-type { display: none; }
/* bottom stack */
#tu-hud-b { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(16px + env(safe-area-inset-bottom, 0px)); display: grid; justify-items: center; align-items: end; gap: 8px;
   grid-template-columns: 84px auto 84px; grid-template-areas: ". tally ." "tsch cons ." ". sys ." ". weapons ."; pointer-events: none; }
body.touch #mx-sys { grid-area: sys; pointer-events: auto; touch-action: none; }
body.touch #mx-sys > div[data-key] { min-width: 44px; justify-content: center; flex-direction: column; gap: 1px; align-items: flex-start; }
body.touch.tu-squad #mx-sys { display: none; }
#tu-tsch { grid-area: tsch; width: 84px; height: 84px; }
body.touch #tally { grid-area: tally; max-width: 360px; max-height: 80px; overflow: hidden; }
body.touch #cons { grid-area: cons; pointer-events: auto; touch-action: none; }
body.touch #weapons { grid-area: weapons; pointer-events: auto; touch-action: none; }
body.touch .tu-press { filter: brightness(1.6); }
body.touch .wslot { width: 112px; padding-left: 30px; }
body.touch .wslot .wname { padding-right: 14px; font-size: 11px; letter-spacing: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
body.touch .wslot .wbar { left: 30px; }
body.touch .wslot .wicon { left: 5px; }
body.touch.tu-cv #weapons, body.touch.tu-cv #tu-tsch, body.touch.tu-squad #weapons, body.touch.tu-squad #cons, body.touch.tu-squad #tu-tsch { display: none; }
body.touch.tu-cv #tu-hud-b { bottom: calc(74px + env(safe-area-inset-bottom, 0px)); }
body.touch #air-panel .ap-keys, body.touch #sub-panel .sp-keys { display: none; }
body.touch #help-panel { pointer-events: auto; touch-action: pan-y; max-height: calc(100% - 70px); overflow: auto; top: calc(50% + 24px); }
body.touch #help-panel .tu-help { display: block; }
body.touch #torp-alert { top: calc(50% - 96px); }
/* first-start note (_hint) */
#tu-hint { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; padding: 16px; overflow: auto;
   background: rgba(8, 10, 11, .78); font-family: var(--font); color: var(--hud); }
.tu-hint-card { max-width: 460px; width: 100%; margin: auto; padding: 18px 20px 16px; background: rgba(17, 20, 21, .96); border: 1px solid var(--panel-edge); border-top: 3px solid var(--gold); border-radius: 3px; }
.tu-hint-k { font: 700 11px var(--font); letter-spacing: 2px; text-transform: uppercase; color: var(--gold); }
.tu-hint-card h2 { margin: 4px 0 10px; font: 700 22px var(--font-cond); letter-spacing: 1px; text-transform: uppercase; color: #fff; }
.tu-hint-card p { margin: 0 0 10px; font-size: 14px; line-height: 1.45; color: var(--hud); }
.tu-hint-card b { color: var(--gold); }
.tu-hint-card label { display: flex; align-items: center; gap: 10px; min-height: 44px; margin: 4px 0 8px; font-size: 14px; color: var(--hud-dim); }
.tu-hint-card input { width: 20px; height: 20px; accent-color: var(--gold); }
.tu-hint-card button { width: 100%; min-height: 48px; border: 0; border-radius: 3px; background: var(--gold); color: var(--ink); font: 700 15px var(--font); letter-spacing: 1.5px; text-transform: uppercase; }
@media (max-height: 480px) { .tu-hint-card { max-width: 620px; padding: 12px 16px; } .tu-hint-card h2 { font-size: 18px; margin-bottom: 6px; } .tu-hint-card p { font-size: 13px; margin-bottom: 6px; } .tu-hint-card label { margin: 0 0 4px; } }
/* phone held upright: no room for a battle */
#tu-rotate { display: none; position: fixed; inset: 0; z-index: 30; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 24px;
   background: rgba(10, 12, 13, .9); font: 600 19px var(--font); letter-spacing: 1px; color: var(--hud); text-align: center; }
#tu-rotate svg { width: 72px; height: 72px; color: var(--gold); }
#tu-rotate span { font-size: 13px; color: var(--hud-dim); letter-spacing: .5px; }
@media (min-height: 700px) {
   #touch-ui { --tu-s: 1.15; }
   body.touch { --tu-map: .8; --tu-hud: .9; }
   body.touch #roster-ally, body.touch #roster-enemy { display: flex; }
   #tu-hud-l { bottom: calc(322px + env(safe-area-inset-bottom, 0px)); }
   #tu-hud-r { bottom: calc(380px + env(safe-area-inset-bottom, 0px)); }
   #tu-tele .tu-st { height: 44px; }
   #tu-fire { width: 124px; height: 124px; }
   #tu-scope, #tu-lock { right: calc(156px + var(--sr)); }
   #tu-lock { bottom: calc(92px + var(--sb)); }
   #tu-free { right: calc(222px + var(--sr)); }
   #tu-col { bottom: calc(160px + var(--sb)); right: calc(52px + var(--sr)); }
   .tu-btn { width: 62px; height: 62px; }
}
/* phone held sideways (incl. browser bars): only the essentials, every control a thumb's reach from an edge */
@media (max-height: 480px) {
   body.touch { --tu-hud: .72; --tu-map: .45; }
   .tu-btn { width: 48px; height: 48px; font-size: 9px; letter-spacing: .3px; }
   .tu-btn svg { width: 20px; height: 20px; }
   #tu-fire { width: 88px; height: 88px; right: calc(14px + var(--sr)); bottom: calc(14px + var(--sb)); font-size: 14px; }
   #tu-scope { right: calc(108px + var(--sr)); bottom: calc(14px + var(--sb)); }
   #tu-lock { right: calc(108px + var(--sr)); bottom: calc(70px + var(--sb)); }
   #tu-free { right: calc(162px + var(--sr)); bottom: calc(14px + var(--sb)); }
   #tu-col { flex-direction: row-reverse; right: calc(14px + var(--sr)); bottom: calc(126px + var(--sb)); }
   #tu-rud { left: calc(86px + var(--sl)); width: 180px; bottom: calc(14px + var(--sb)); }
   .tu-sys { left: auto; right: calc(116px + var(--sr)); transform: none; }
   #tu-hud-l { left: calc(86px + env(safe-area-inset-left, 0px)); top: calc(6px + env(safe-area-inset-top, 0px)); bottom: calc(80px + env(safe-area-inset-bottom, 0px)); }
   #tu-hud-r { top: calc(6px + env(safe-area-inset-top, 0px)); bottom: calc(182px + env(safe-area-inset-bottom, 0px)); }
   body.touch #tu-hud-l > #cons { margin-top: auto; zoom: 1; flex-wrap: wrap; gap: 6px; max-width: 210px; }
   body.touch #mission-name { display: none; }
   /* fewer buttons: map (the minimap opens it too), overview, help, AA and secondaries fold out of "..." */
   #tu-more { display: flex; }
   body.touch:not(.tu-more) #tu-map, body.touch:not(.tu-more) #tu-board, body.touch:not(.tu-more) #tu-help,
   body.touch:not(.tu-more) #tu-sec, body.touch:not(.tu-more) #tu-aa { display: none; }
   /* phone: the orders get their own band in the middle (the left column has no room for four long lines and
      would clip them); the radio banner is narrowed so it never runs into the columns beside it */
   #tu-hud-o { position: absolute; top: calc(8px + env(safe-area-inset-top, 0px)); left: calc(284px + env(safe-area-inset-left, 0px)); width: 330px; pointer-events: none; }
   body.touch #tu-hud-o > #objectives { position: static; width: 358px; zoom: var(--tu-hud); }   /* ends left of the target card */
   body.touch:has(#mx-threat:not(.hidden)) #tu-hud-o { display: none; }   /* an incoming salvo takes the band */
   /* notices stack under the minimap (TouchUi._arrange), clear of the reticle, the target marker and the ship
      labels: the newest three, the oldest clipped first. They stay readable while a finger aims. */
   body.touch #tu-hud-r > #msgs { zoom: 1; width: auto; max-width: 286px; max-height: 96px; align-items: flex-end; justify-content: flex-end; overflow: hidden; }
   body.touch #tu-hud-r > #msgs:empty { display: none; }
   body.touch #msgs .msg:nth-last-child(n+4) { display: none; }
   body.touch .msg, body.touch .msg.radio { max-width: 286px; font-size: 12px; }
   body.touch #tu-hud-r > * { transition: opacity .25s; }
   body.touch.tu-aim #tu-hud-r { opacity: 1; }
   body.touch.tu-aim #tu-hud-r > :not(#msgs) { opacity: .3; }
   body.touch #ops-panel .ops-plate { min-height: 58px; box-sizing: border-box; }   /* a 40 px tap target at this zoom */
   body.touch #objectives { transition: opacity .6s; }
   body.touch #objectives:not(.tu-fresh) { opacity: 0; }
   body.touch #scorebox { width: 250px; padding: 4px 10px 5px; grid-template-columns: auto 1fr; grid-template-areas: "timer score" "caps caps"; }
   body.touch .score-row { margin-top: 0; }
   body.touch #caps-row { margin-top: 4px; }
   #tu-hud-b { left: calc(304px + env(safe-area-inset-left, 0px)); transform: none; bottom: calc(14px + env(safe-area-inset-bottom, 0px)); grid-template-columns: auto; grid-template-areas: "sys" "weapons"; justify-items: start; gap: 5px; }
   body.touch #mx-sys { display: grid; grid-template-columns: repeat(3, auto); }
   body.touch #mx-sys #mx-layers { grid-column: 1 / -1; grid-row: 1; min-height: 22px; border-right: 0; border-bottom: 1px solid rgba(255,255,255,.07); }
   body.touch #mx-sys #mx-layers .mx-l { display: none; }
   body.touch.tu-chart #mx-sys { display: none; }   /* the chart needs the room */
   #tu-tsch { display: none; }   /* the turret schematic would sit on the reticle: the ready count there has to do */
   body.touch .wslot { width: 52px; padding: 0; }
   body.touch .wslot .wname, body.touch .wslot .wstat { display: none; }
   body.touch .wslot .wkey { left: 4px; top: 3px; }
   body.touch .wslot .wicon { left: 16px; top: 14px; }
   body.touch .wslot .wbar { left: 6px; right: 6px; bottom: 4px; }
   #tu-bar { left: calc(276px + var(--sl)); transform: none; bottom: calc(14px + var(--sb)); gap: 4px; }
   #tu-bar .tu-btn { width: 64px; height: 48px; font-size: 9px; }
   body.touch.tu-cv #tu-free { right: calc(14px + var(--sr)); }
   body.touch.tu-cv #tu-hud-b { left: calc(484px + env(safe-area-inset-left, 0px)); bottom: calc(14px + env(safe-area-inset-bottom, 0px)); }
}
@media (max-height: 480px) and (min-width: 900px) {
   #tu-hud-b { grid-template-columns: auto auto; grid-template-areas: "sys sys" "cons weapons"; }
}
/* tablet held upright: the system buttons move under the minimap, the bottom stack above the rudder */
@media (orientation: portrait) and (min-width: 601px) {
   .tu-sys { left: auto; right: calc(8px + var(--sr)); transform: none; top: calc(16px + 220px * var(--tu-map) + var(--st)); }
   body.touch #tu-hud-r > #minimap-wrap { margin-bottom: calc(64px / var(--tu-map)); }
   #tu-hud-l { bottom: calc(470px + env(safe-area-inset-bottom, 0px)); }
   #tu-hud-b { bottom: calc(170px + env(safe-area-inset-bottom, 0px)); grid-template-columns: auto; grid-template-areas: "tally" "tsch" "cons" "sys" "weapons"; }
   #tu-bar { bottom: calc(170px + var(--sb)); }
   body.touch.tu-cv #tu-hud-b { bottom: calc(228px + env(safe-area-inset-bottom, 0px)); }
}
@media (orientation: portrait) and (max-width: 600px) {
   #touch-ui > * { display: none !important; }
   #touch-ui > #tu-rotate { display: flex !important; }
   body.touch #hud { visibility: hidden; }
}
`;

const ICON = {
   pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>',
   map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/></svg>',
   board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
   help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 9a3 3 0 1 1 4 2.8c-.7.3-1 1-1 1.7V15"/><circle cx="12" cy="18.5" r=".6" fill="currentColor"/></svg>',
   more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>',
   scope: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="14" r="4"/><circle cx="17" cy="14" r="4"/><path d="M10 12h4M5 10l2-5h3M19 10l-2-5h-3"/></svg>',
   lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/></svg>',
   free: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
   rotate: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="17" y="6" width="14" height="24" rx="2"/><rect x="10" y="27" width="28" height="15" rx="2" stroke-dasharray="3 3"/><path d="M38 14a12 12 0 0 1 2 10l-3-2M40 24l2-3"/></svg>',
};

function el(tag, id, cls, html) {
   const e = document.createElement(tag);
   if (id) e.id = id;
   if (cls) e.className = cls;
   if (html) e.innerHTML = html;
   return e;
}
const setCls = (e, c, on) => { if (!e) return; const k = '_c' + c; on = !!on; if (e[k] !== on) { e[k] = on; e.classList.toggle(c, on); } };
const setText = (e, s) => { if (e && e._txt !== s) { e._txt = s; e.textContent = s; } };
const setLeft = (e, v) => { if (e && e._left !== v) { e._left = v; e.style.left = v; } };

export function isCoarse() {
   try { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
}

export class TouchUi {
   constructor({ input, canvas, api }) {
      this.input = input; this.canvas = canvas; this.api = api;
      this.on = false;              // touch mode (overlay may still be hidden outside a battle)
      this.shown = false;
      this.dom = null;
      this.t = 0;
      this.st = null;               // last state snapshot (api.state())
      this.look = new Map();        // pointerId -> { x, y } fingers on the sea
      this.pinch = 0;               // last finger distance of a two-finger pinch (0 = none)
      this.held = new Set();        // virtual keys held by a button
      this.board = false;
      this.more = false;            // phone: the "more" fold is open
      this.moreT = 0;               // s until it closes by itself
      this.objTxt = null;           // last objectives text, and s since it changed
      this.objT = 0;
      if (typeof window === 'undefined') return;
      if (isCoarse()) this.enable();
      // a laptop with a touch screen: the first real touch switches the overlay on
      window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && !this.on) this.enable(); }, { capture: true, passive: true });
      window.addEventListener('touchstart', () => { if (!this.on) this.enable(); }, { capture: true, passive: true });
   }

   enable() {
      if (this.on || typeof document === 'undefined') return;
      this.on = true;
      this.input.touchMode = true;
      this._build();
      document.body.classList.add('touch');
      this._hint();
      // iOS Safari ignores user-scalable=no: no page pinch-zoom while the battle runs
      document.addEventListener('gesturestart', (e) => { if (this.shown) e.preventDefault(); }, { passive: false });
   }

   // ------------------------------------------------------------------ DOM
   _build() {
      if (this.dom) return;
      const st = el('style'); st.textContent = CSS; document.head.appendChild(st);
      const root = el('div', 'touch-ui', 'hidden');
      const btn = (id, cls, html, parent = root) => { const b = el('div', id, 'tu-btn' + (cls ? ' ' + cls : ''), html); parent.appendChild(b); return b; };
      const sys = el('div', null, 'tu-sys'); root.appendChild(sys);
      const bPause = btn('tu-pause', '', ICON.pause, sys);
      const bMap = btn('tu-map', '', ICON.map, sys);
      const bBoard = btn('tu-board', '', ICON.board, sys);
      const bHelp = btn('tu-help', '', ICON.help, sys);
      const bMore = btn('tu-more', '', ICON.more, sys);   // phone: folds out map / overview / help / AA / secondaries

      const tele = el('div', 'tu-tele', null, '<div class="tu-kn">0 kn</div>'
         + TELE_STEPS.map(n => `<div class="tu-st" data-n="${n}">${TELE_TXT[n]}</div>`).join('')
         + '<div class="tu-sq" data-k="W">Schneller</div><div class="tu-sq" data-k="S">Langsamer</div>');
      root.appendChild(tele);
      const rud = el('div', 'tu-rud', null, '<span class="tu-lr" style="left:6px">BB</span><span class="tu-lr" style="right:6px">STB</span><i class="tu-tr"></i>'
         + [0, 1, 2, 3, 4].map(i => `<i class="tu-nt" style="left:calc(22px + (100% - 44px) * ${i / 4})"></i>`).join('')
         + '<i class="tu-th" style="left:50%"></i><span class="tu-rl">mittschiffs</span>');
      root.appendChild(rud);

      const fire = btn('tu-fire', '', 'Feuer');
      const scope = btn('tu-scope', '', ICON.scope + 'Glas');
      const lock = btn('tu-lock', '', ICON.lock + 'Ziel');
      const free = btn('tu-free', '', ICON.free + 'Frei');
      const col = el('div', 'tu-col'); root.appendChild(col);
      const bar = el('div', 'tu-bar'); root.appendChild(bar);
      const ctx = {
         sec: btn('tu-sec', '', 'Sek.<br>Ziel', col),
         asw: btn('tu-asw', '', 'Wasser&shy;bomben', col),
         aa: btn('tu-aa', '', 'Luftabw.<br><span>aus</span>', col),   // carriers: AA sector
         dive: btn('tu-dive', '', '▼<br>Tiefer', col),
         up: btn('tu-up', '', '▲<br>Auf', col),
         launch: btn('tu-launch', '', 'Start', col),
         ship: btn('tu-ship', '', 'Schiff', col),
         recall: btn('tu-recall', '', 'Rück&shy;ruf', col),
      };
      ctx.aaV = ctx.aa.querySelector('span');
      const air = AIR_TYPES.map(([k, t, n]) => { const b = btn(null, '', n, bar); b.dataset.k = k; b.dataset.t = t; return b; });
      root.appendChild(el('div', 'tu-rotate', null, ICON.rotate + 'Bitte Gerät quer halten<span>Das Gefecht braucht die Breite des Bildschirms.</span>'));
      const host = document.getElementById('app') || document.body;
      host.appendChild(root);
      this.dom = { root, bPause, bMap, bBoard, bHelp, bMore, tele, kn: tele.querySelector('.tu-kn'), steps: [...tele.querySelectorAll('.tu-st')],
         rud, thumb: rud.querySelector('.tu-th'), rudL: rud.querySelector('.tu-rl'), fire, scope, lock, free, ctx, air };

      // help: a touch section in front of the key list
      const help = document.querySelector('#help-panel .controls-grid');
      if (help && !document.querySelector('#help-panel .tu-help')) {
         const h = el('div', null, 'tu-help', TOUCH_HELP_HTML);
         h.style.display = 'none';
         help.parentNode.insertBefore(h, help);
      }

      // ---- wiring
      const tap = (b, k) => this._press(b, () => this.input.virtualTap(k));
      tap(bPause, 'P'); tap(bMap, 'M'); tap(bHelp, 'H');
      this._press(bMore, () => this._more(!this.more));
      // the fold closes by itself: soon after map / overview / help, a while after AA / secondaries (tapped repeatedly)
      for (const b of [bMap, bBoard, bHelp]) b.addEventListener('pointerup', () => { if (this.more) this.moreT = Math.min(this.moreT, 0.6); });
      for (const b of [ctx.sec, ctx.aa]) b.addEventListener('pointerup', () => { if (this.more) this.moreT = MORE_OPEN; });
      this._press(bBoard, () => { this.board = !this.board; this.input.virtualKey('TAB', this.board); setCls(bBoard, 'on', this.board); });
      tap(scope, 'SHIFT'); tap(lock, 'X');
      this._press(free, () => { const on = !this.held.has('C'); this._hold('C', on); setCls(free, 'on', on); });
      this._press(ctx.sec, () => { this.input.mouse.ctrlClicks++; });   // = Ctrl+click: secondary target
      tap(ctx.asw, 'G'); tap(ctx.aa, '4'); tap(ctx.dive, 'F'); tap(ctx.up, 'G');
      tap(ctx.launch, 'E'); tap(ctx.ship, 'E'); tap(ctx.recall, 'F');
      for (const b of air) tap(b, b.dataset.k);
      // fire: LMB semantics (hold = keep firing / carrier attack run, release = drop)
      this._press(fire, () => { this.input.mouse.down = true; this.input.mouse.clicked = true; },
         () => { this.input.mouse.down = false; });
      // telegraph lever: absolute steps on the ship, held W / S in the squadron view
      this._drag(tele, (e, phase) => {
         if (this.st?.squad) {
            const r = this._rect(tele, phase === 'down');
            const k = phase === 'up' ? null : e.clientY < r.top + r.h * 0.55 ? 'W' : 'S';
            this._hold('W', k === 'W'); this._hold('S', k === 'S');
            for (const q of tele.querySelectorAll('.tu-sq')) setCls(q, 'press', q.dataset.k === k);
            return;
         }
         if (phase === 'up') return;
         const r = this._rect(tele, phase === 'down');
         const steps = this.dom.steps, top = r.top + (r.h - steps.length * r.stepH), i = Math.floor((e.clientY - top) / r.stepH);
         const n = TELE_STEPS[Math.max(0, Math.min(TELE_STEPS.length - 1, i))];
         if (n !== this.st?.tele) { this.api.setTelegraph(n); if (this.st) this.st.tele = n; this._paintTele(n); }
      });
      // rudder track: absolute position on the ship, held A / D (springs back) in the squadron view
      this._drag(rud, (e, phase) => {
         const r = this._rect(rud, phase === 'down');
         const f = (e.clientX - r.left - 22) / Math.max(1, r.w - 44);
         if (this.st?.squad) {
            const k = phase === 'up' ? 0 : f < 0.4 ? -1 : f > 0.6 ? 1 : 0;
            this._hold('A', k < 0); this._hold('D', k > 0);
            this._paintRudder(k * 2);
            return;
         }
         if (phase === 'up') return;
         const n = Math.max(-2, Math.min(2, Math.round(f * 4 - 2)));
         if (n !== this.st?.rudder) { this.api.setRudder(n); if (this.st) this.st.rudder = n; this._paintRudder(n); }
      });
      // HUD plates that double as buttons: weapon slots and consumables
      const plates = (box, sel, key) => {
         if (!box) return;
         box.addEventListener('pointerdown', (e) => {
            const s = e.target.closest?.(sel);
            if (!s || !this.shown) return;
            e.preventDefault(); e.stopPropagation();
            const k = key(s);
            if (k) this.input.virtualTap(k);
            s.classList.add('tu-press'); setTimeout(() => s.classList.remove('tu-press'), 120);
         });
      };
      plates(document.getElementById('weapons'), '.wslot', s => s.dataset.key);
      plates(document.getElementById('cons'), '.cslot', s => s.dataset.slot);
      // radar, air-defence doctrine and priority target: the plates of missileui.js (built on the first start)
      plates(document.getElementById('hud'), '#mx-sys [data-key]', s => s.dataset.key);
      // helicopter and swimmer team: the plates of opsui.js (I / K)
      plates(document.getElementById('hud'), '#ops-panel [data-key]', s => s.dataset.key);
      // no synthetic mouse events, double-tap zoom or long-press menu from the controls
      root.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
      root.addEventListener('contextmenu', (e) => e.preventDefault());

      // ---- the sea: one finger = look / aim, two fingers = pinch zoom
      const cv = this.canvas;
      cv.addEventListener('touchstart', (e) => { if (this.shown && e.cancelable) e.preventDefault(); }, { passive: false });
      cv.addEventListener('pointerdown', (e) => {
         if (e.pointerType !== 'touch' || !this.shown) return;
         try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
         this.look.set(e.pointerId, { x: e.clientX, y: e.clientY });
         this.pinch = this.look.size === 2 ? this._spread() : 0;
         setCls(document.body, 'tu-aim', true);   // the info plates fade while a finger aims
         this.input.virtualTap('_TOUCH');   // "any key": skips the kill / shell camera, nothing else reads it
      });
      cv.addEventListener('pointermove', (e) => {
         const f = this.look.get(e.pointerId);
         if (!f) return;
         const dx = e.clientX - f.x, dy = e.clientY - f.y;
         f.x = e.clientX; f.y = e.clientY;
         if (this.look.size >= 2) {
            const d = this._spread();
            if (this.pinch > 0 && d > 0) this.input.mouse.wheel -= Math.log(d / this.pinch) * PINCH_GAIN;
            this.pinch = d;
            return;
         }
         this.input.mouse.dx += dx * LOOK_GAIN;
         this.input.mouse.dy += dy * LOOK_GAIN;
      });
      const lift = (e) => {
         if (!this.look.delete(e.pointerId)) return;
         this.pinch = this.look.size === 2 ? this._spread() : 0;
         if (!this.look.size) setCls(document.body, 'tu-aim', false);
      };
      cv.addEventListener('pointerup', lift);
      cv.addEventListener('pointercancel', lift);
      this._arrange();
   }

   // One-time note on the first touch start: the game is made for mouse and keyboard. Shown again on
   // the next visit unless "nicht mehr anzeigen" is ticked (api.hint() / api.hintDone(forever)).
   _hint() {
      if (!this.api.hint?.() || document.getElementById('tu-hint')) return;
      const box = el('div', 'tu-hint', null, `<div class="tu-hint-card" role="dialog" aria-labelledby="tu-hint-t">
         <div class="tu-hint-k">Touch-Steuerung</div>
         <h2 id="tu-hint-t">Gebaut für Maus und Tastatur</h2>
         <p>Am Touchscreen ist alles spielbar, aber Zielen geht langsamer und ungenauer. Gegen menschliche Gegner ist das ein deutlicher Nachteil.</p>
         <p><b>Zielhilfe:</b> Tippe <b>Ziel</b>, um einen Gegner zu erfassen. Das Fadenkreuz folgt dann dem Vorhalt, Wischen korrigiert. Feuern, Munition und Streuung bleiben bei dir. Im PvP ist sie aus, im Pausenmenü abschaltbar.</p>
         <label><input type="checkbox" id="tu-hint-never"> Nicht mehr anzeigen</label>
         <button type="button" id="tu-hint-ok">Verstanden</button></div>`);
      document.body.appendChild(box);
      const ok = box.querySelector('#tu-hint-ok');
      ok.addEventListener('click', () => { this.api.hintDone?.(box.querySelector('#tu-hint-never').checked); box.remove(); });
   }

   // Regroup the HUD plates for touch (see the CSS note above). Runs on build, when the phone turns or
   // the window crosses a size step, and once more when subui / airui build their panels.
   _arrange() {
      const $ = (id) => document.getElementById(id);
      const hud = $('hud');
      if (!hud) return;
      if (!this.cols) {
         const box = (id) => { const e = el('div', id); hud.appendChild(e); return e; };
         this.cols = { l: box('tu-hud-l'), r: box('tu-hud-r'), b: box('tu-hud-b'), t: box('tu-hud-t'), o: box('tu-hud-o') };
         this.cols.b.appendChild(el('div', 'tu-tsch'));     // room for hud3d's turret schematic
         this.mq = { compact: matchMedia(MQ_COMPACT), narrow: matchMedia(MQ_NARROW), upright: matchMedia(MQ_UPRIGHT) };
         this.mq.compact.addEventListener?.('change', () => this._arrange());
         this.mq.narrow.addEventListener?.('change', () => this._arrange());
         // turned upright in the middle of a battle: hold the game until the phone is sideways again
         this.mq.upright.addEventListener?.('change', (e) => { if (e.matches && this.shown) this.input.virtualTap('P'); });
         // the minimap is a button for the full chart
         $('minimap-wrap')?.addEventListener('pointerdown', (e) => {
            if (!this.shown) return;
            e.preventDefault(); e.stopPropagation();
            this.input.virtualTap('M');
         });
      }
      const { l, r, b, t, o } = this.cols;
      const compact = this.mq.compact.matches, narrow = this.mq.narrow.matches;
      const put = (col, ids) => { for (const id of ids) { const e = id && $(id); if (e) col.appendChild(e); } };
      put(l, ['scorebox', 'ship-card', ...LATE_PLATES, !compact && 'objectives', 'roster-ally', narrow && 'cons']);
      put(r, ['minimap-wrap', compact && 'msgs', !compact && 'lock-panel', compact && 'tally', 'roster-enemy', 'killfeed']);
      // phone: the notices leave the middle of the screen; anywhere else they go back to their place in the HUD
      const msgs = $('msgs');
      if (!compact && msgs && msgs.parentNode !== hud) hud.insertBefore(msgs, $('torp-alert'));
      put(t, [compact && 'lock-panel']);
      put(o, [compact && 'objectives']);      // phone: the target card under the system buttons, clear of the fire cluster
      put(b, [!compact && 'tally', 'tu-tsch', !narrow && 'cons', LATE_BOTTOM, 'weapons']);
      this.late = [...LATE_PLATES, LATE_BOTTOM].filter(id => !$(id));
   }

   _spread() {
      const [a, b] = [...this.look.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
   }
   // layout read once per gesture (on the first touch), never per frame
   _rect(node, fresh) {
      if (fresh || !node._r) {
         const r = node.getBoundingClientRect();
         const st = node.querySelector('.tu-st');
         node._r = { left: r.left, top: r.top, w: r.width, h: r.height - 4, stepH: st ? st.getBoundingClientRect().height : 34 };
      }
      return node._r;
   }
   _press(b, down, up) {
      const h = (e) => {
         e.preventDefault(); e.stopPropagation();
         if (!this.shown) return;
         try { b.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
         b.classList.add('press');
         down?.(e);
      };
      const u = () => { b.classList.remove('press'); up?.(); };
      b.addEventListener('pointerdown', h);
      b.addEventListener('pointerup', u);
      b.addEventListener('pointercancel', u);
   }
   _drag(node, fn) {
      let id = null;
      node.addEventListener('pointerdown', (e) => {
         e.preventDefault(); e.stopPropagation();
         if (!this.shown || id != null) return;
         id = e.pointerId;
         try { node.setPointerCapture(id); } catch (err) { /* ignore */ }
         fn(e, 'down');
      });
      node.addEventListener('pointermove', (e) => { if (e.pointerId === id) fn(e, 'move'); });
      const end = (e) => { if (e.pointerId !== id) return; id = null; fn(e, 'up'); };
      node.addEventListener('pointerup', end);
      node.addEventListener('pointercancel', end);
   }
   _more(on) {
      this.more = !!on; this.moreT = MORE_OPEN;
      setCls(document.body, 'tu-more', this.more);
      setCls(this.dom?.bMore, 'on', this.more);
   }
   _hold(k, on) {
      if (on === this.held.has(k)) return;
      if (on) this.held.add(k); else this.held.delete(k);
      this.input.virtualKey(k, on);
   }
   _releaseAll() {
      for (const k of [...this.held]) this._hold(k, false);
      if (this.board) { this.board = false; this.input.virtualKey('TAB', false); setCls(this.dom?.bBoard, 'on', false); }
      setCls(this.dom?.free, 'on', false);
      this.look.clear(); this.pinch = 0;
      setCls(document.body, 'tu-aim', false);
      this._more(false);
      this.input.mouse.down = false;
      if (this.dom) for (const b of this.dom.root.querySelectorAll('.press')) b.classList.remove('press');
   }

   // ------------------------------------------------------------------ per frame
   frame(dt, playing) {
      if (!this.on) return;
      if (playing !== this.shown) {
         this.shown = playing;
         setCls(this.dom.root, 'hidden', !playing);
         if (!playing) this._releaseAll();
         this.t = REFRESH; this.objT = 0;
      }
      if (!playing) return;
      this.t += dt;
      if (this.t < REFRESH) return;
      this.t = 0;
      this._refresh(this.api.state());
   }

   _paintTele(n) { for (const s of this.dom.steps) setCls(s, 'on', Number(s.dataset.n) === n); }
   _paintRudder(n) {
      setLeft(this.dom.thumb, `calc(22px + (100% - 44px) * ${(n + 2) / 4})`);
      setText(this.dom.rudL, RUD_TXT[n] ?? '');
   }

   _refresh(s) {
      const d = this.dom;
      this.st = s;
      if (!s) return;
      if (this.late?.length && this.late.some(id => document.getElementById(id))) this._arrange();
      const body = document.body;
      // (held open while the map, the overview or the help is up: its button closes it again)
      if (this.more && !(s.map || s.help || this.board) && (this.moreT -= REFRESH) <= 0) this._more(false);
      // phone: the objectives show for a while after each change, then fade (CSS, compact only)
      const obj = document.getElementById('objectives'), ot = obj ? obj.textContent : '';
      if (ot !== this.objTxt) { this.objTxt = ot; this.objT = 0; } else this.objT += REFRESH;
      setCls(obj, 'tu-fresh', this.objT < OBJ_SHOW);
      setCls(body, 'tu-cv', s.cv && !s.squad);
      setCls(body, 'tu-squad', s.squad);
      setCls(body, 'tu-chart', s.map);
      setCls(d.tele, 'squad', s.squad);
      if (!s.squad) {
         // the squadron view closed under a held finger: its held keys must not step the ship's helm
         for (const k of ['W', 'S', 'A', 'D']) this._hold(k, false);
         this._paintTele(s.tele); this._paintRudder(s.rudder);
      }
      setText(d.kn, s.squad ? 'Staffel' : s.kn + ' kn');
      setCls(d.bMap, 'on', s.map);
      setCls(d.bHelp, 'on', s.help);
      setCls(d.scope, 'on', s.bino);
      setCls(d.lock, 'on', s.lock);
      setCls(d.fire, 'off', !s.alive || (s.cv && !s.squad));
      const ship = s.alive && !s.squad;
      setCls(d.scope, 'hidden', !ship || s.cv || s.deep);
      setCls(d.lock, 'hidden', !ship || s.cv);
      setCls(d.free, 'hidden', !ship);
      setCls(d.fire, 'hidden', !s.alive || (s.cv && !s.squad));
      if (!ship && this.held.has('C')) { this._hold('C', false); setCls(d.free, 'on', false); }
      else setCls(d.free, 'on', s.free);
      const c = d.ctx;
      setCls(c.sec, 'hidden', !ship || !s.sec || s.cv);
      setCls(c.sec, 'on', s.secTarget);
      setCls(c.asw, 'hidden', !ship || !s.asw);
      if (this._ltt !== !!s.ltt) { this._ltt = !!s.ltt; c.asw.innerHTML = s.ltt ? 'U-Jagd-<br>Torpedo' : 'Wasser&shy;bomben'; }
      setCls(c.aa, 'hidden', !ship || !s.aa || s.sub || s.net);
      setText(d.ctx.aaV, s.aaFocus < 0 ? 'Bb' : s.aaFocus > 0 ? 'Stb' : 'aus');
      setCls(c.aa, 'on', s.aaFocus !== 0);
      setCls(c.dive, 'hidden', !ship || !s.sub);
      setCls(c.up, 'hidden', !ship || !s.sub);
      setCls(c.dive, 'off', s.sub && s.depthTarget >= 2);
      setCls(c.up, 'off', s.sub && s.depthTarget <= 0);
      setCls(c.launch, 'hidden', !ship || !s.cv || s.net);
      setText(c.launch, s.sqActive ? 'Über­nehmen' : 'Start');
      setCls(c.ship, 'hidden', !s.squad);
      setCls(c.recall, 'hidden', !s.squad || s.sqHome);
      for (const b of d.air) {
         setCls(b, 'hidden', !s.cv || s.squad || s.net);
         setCls(b, 'on', b.dataset.t === s.airSel);
      }
      setText(d.fire, s.squad ? (s.sqType === 'ft' ? 'Patrouille' : 'Angriff') : s.mode === 'cruise' ? (s.map ? 'Ziel' : 'Karte') : s.mode === 'ssm' || s.mode === 'rockets' ? 'Start' : 'Feuer');
   }
}

const TOUCH_HELP_HTML = `<div class="sb-title" style="font-size:13px">Touch-Steuerung</div>
<div class="controls-grid" style="margin:0 0 12px">
   <div><span class="k">Hebel links</span><span class="d">Maschinentelegraf: Stufe antippen oder ziehen</span></div>
   <div><span class="k">Ruderleiste</span><span class="d">Ruder Backbord ↔ Steuerbord, bleibt stehen</span></div>
   <div><span class="k">Wischen</span><span class="d">Peilung (seitlich) und Entfernung (hoch/runter)</span></div>
   <div><span class="k">Zwei Finger</span><span class="d">Auseinander/zusammen: Zoom bis ins Fernglas</span></div>
   <div><span class="k">Feuer / Start</span><span class="d">Gewählte Waffe auslösen · Staffel: halten = Anflug, loslassen = Abwurf</span></div>
   <div><span class="k">Glas · Ziel · Frei</span><span class="d">Optik an/aus · Ziel erfassen · freie Kamera</span></div>
   <div><span class="k">Zielhilfe</span><span class="d">Erfasstes Ziel: das Fadenkreuz folgt dem Vorhalt, Wischen korrigiert (nicht im PvP, im Pausenmenü abschaltbar)</span></div>
   <div><span class="k">Waffenleiste</span><span class="d">Geschütz, Seezielflugkörper, Marschflugkörper, Raketen, Torpedos antippen · nochmals: Flugkörpertyp bzw. Torpedofächer</span></div>
   <div><span class="k">Seezielflugkörper</span><span class="d">Ziel erfassen oder anvisieren, dann Start · ohne Ziel: Peilungsschuss in Blickrichtung</span></div>
   <div><span class="k">Marschflugkörper</span><span class="d">Antippen öffnet die Lagekarte · Punkt oder Landstellung auf der Karte antippen</span></div>
   <div><span class="k">Radar · Luftabwehr · Vorrang</span><span class="d">Felder über der Waffenleiste antippen: Radar an/aus (EMCON) · Doktrin wechseln · anfliegenden Flugkörper in Blickrichtung zum Vorrangziel machen</span></div>
   <div><span class="k">Runde Felder</span><span class="d">Schadensabwehr, Notreparatur, Täuschkörper, Störsender</span></div>
   <div><span class="k">Träger</span><span class="d">Flugzeugtyp, Start/Übernehmen · Staffel: Leiste links = Kurs, Hebel = Tempo, Schiff, Rückruf</span></div>
   <div><span class="k">U-Boot</span><span class="d">▼ Tiefer / ▲ Auf · U-Jagd-Schiffe: U-Jagd-Torpedo bzw. Wasserbomben</span></div>
   <div><span class="k">Hubschrauber</span><span class="d">Feld antippen: Start voraus / Rückruf · bei offener Lagekarte: Feld, dann Punkt auf der Karte antippen</span></div>
   <div><span class="k">Kommandotrupp</span><span class="d">U-Boot nahe am Einsatzpunkt, langsam, höchstens auf Sehrohrtiefe: Feld antippen · zur Aufnahme zum Trupp zurück</span></div>
   <div><span class="k">Knopfleiste oben</span><span class="d">Pause · Lagekarte · Übersicht · Hilfe · am Handy klappt ⋯ Karte, Übersicht, Hilfe, Luftabwehr und Sek.-Ziel aus</span></div>
   <div><span class="k">Minikarte</span><span class="d">Antippen: große Lagekarte</span></div>
</div>`;
