// game3d/mpui.js — the multiplayer screen: game list with filters, create/join dialogs and the
// room (players, ship picker, ready, chat). Pure UI on top of game3d/net/lobby.js.
// Loaded lazily by the port's MEHRSPIELER button (menu3d.js), so nothing here — and nothing
// network-related — runs in a singleplayer session. `?net=local` uses BroadcastChannel instead
// of the internet (two pages of one browser, for tests); `?net=relay` never tries a direct
// WebRTC connection and plays over the relay only.
import { Lobby, makeBackend, filterGames, coopMissions, ownShips, cleanName, MODES, DIFFICULTIES, NET_VERSION } from './net/lobby.js';
import { coopSlots } from './net/coop.js';
import { getMission } from './missions.js';
import { SHIP_STATS } from './config.js';
import { loadProfile } from './progress3d.js';
import { classSvg } from './hud.js';
import { logoSvg } from './theme.js';

const DIFF_LABEL = { easy: 'Einfach', normal: 'Normal', hard: 'Schwer' };
const MODE_LABEL = { coop: 'Koop', pvp: 'PvP' };
const TYPE_LABEL = {
   training: 'Übung', annihilation: 'Vernichtung', domination: 'Seeraum', escort: 'Geleitschutz', historic: 'Historisch', survival: 'Überleben',
   raid: 'Handelskrieg', defense: 'Verteidigung', delay: 'Nachhut', fleet: 'Flottenschlacht', breakout: 'Durchbruch', torpedo: 'Torpedoangriff', harbour: 'Hafenüberfall',
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const misName = (id) => getMission(id)?.name || id;
const LOCK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

const CSS = `
/* Lobby in the port's "Kartenhaus" style (tokens: index-3d.html :root). The masthead and the main
   button reuse the port's .m3-top/.m3-capt/.m3-battle rules; the body is a set of paper sheets on
   the dimmed sea: the filter sheet, the list of open games as ledger rows, the room's three sheets. */
.mp { position:absolute; inset:0; z-index:22; display:flex; flex-direction:column; color:var(--ink); font-family:var(--font); pointer-events:auto; --cls-bar:var(--paper);
   background:linear-gradient(90deg, rgba(9,15,19,.92), rgba(9,15,19,.66) 30%, rgba(9,15,19,.66) 70%, rgba(9,15,19,.92)); }
.mp * { box-sizing:border-box; }
.mp-top { flex:none; height:64px; display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:16px; padding:0 20px; user-select:none; color:var(--paper);
   background:var(--navy); border-bottom:3px double var(--brass); box-shadow:0 8px 24px rgba(0,0,0,.35); }
.mp-top .m3-logo .ks-logo svg { height:38px; } .mp-top .m3-logo .ks-logo .wm b { font-size:23px; }
.mp-top .m3-battle { flex:none; height:44px; min-width:270px; font-size:17px; }
.mp-left { display:flex; align-items:center; gap:18px; min-width:0; } .mp-right { display:flex; justify-content:flex-end; align-items:center; gap:14px; }
.mp-btn { cursor:pointer; border:1px solid var(--ink-2); padding:6px 12px; background:var(--paper); color:var(--ink); font:600 12px var(--font); letter-spacing:1.5px; white-space:nowrap; }
.mp-btn:hover:not(:disabled) { background:var(--navy); border-color:var(--navy); color:var(--paper); } .mp-btn:disabled { opacity:.4; cursor:not-allowed; }
.mp-btn.pri { border-color:var(--signal-lo); background:var(--signal); color:var(--flag-w); }
.mp-btn.pri:hover:not(:disabled) { background:var(--signal-hi); border-color:var(--signal-lo); }
.mp-btn.warn { border-color:var(--signal); color:var(--signal-lo); }
.mp-top .mp-btn { background:transparent; border-color:rgba(226,189,110,.42); color:var(--brass-hi); }
.mp-top .mp-btn:hover { background:var(--navy-2); color:var(--paper); }
.mp-net { font-size:11.5px; color:var(--hud-dim); text-align:right; line-height:1.35; white-space:nowrap; } .mp-net b { color:var(--ok); } .mp-net b.bad { color:var(--bad); }
.mp-body { flex:1; min-height:0; display:grid; gap:20px; padding:16px 20px 14px; }
.mp-body.list { grid-template-columns:290px minmax(0,1fr); } .mp-body.room { grid-template-columns:320px minmax(0,1fr) 300px; }
.mp-col { min-height:0; min-width:0; display:flex; flex-direction:column; gap:8px; }
.mp-h { flex:none; font:600 10.5px var(--font); letter-spacing:2.5px; color:var(--brass-hi); text-transform:uppercase; padding:2px 0 4px; display:flex; justify-content:space-between;
   border-bottom:1px solid rgba(226,189,110,.45); text-shadow:0 1px 2px rgba(0,0,0,.8); user-select:none; }
.mp-box { padding:14px 16px; background:var(--paper); border:1px solid var(--paper-edge); box-shadow:0 6px 18px rgba(0,0,0,.35); }
.mp-scroll { min-height:0; overflow:auto; scrollbar-width:thin; scrollbar-color:var(--brass) transparent; }
.mp label { display:block; font-size:10.5px; letter-spacing:1.5px; font-weight:600; color:var(--ink-2); text-transform:uppercase; margin:10px 0 4px; }
.mp label:first-child { margin-top:0; }
.mp input[type=text], .mp input[type=password], .mp select { width:100%; padding:7px 9px; border:1px solid var(--paper-edge); border-bottom:2px solid var(--ink-2); background:var(--flag-w); color:var(--ink);
   font:500 13px var(--font); outline:none; }
.mp input:focus, .mp select:focus { border-bottom-color:var(--signal); } .mp select option { background:var(--flag-w); color:var(--ink); }
.mp label.chk { display:flex; align-items:center; gap:8px; margin:8px 0 0; font-size:12.5px; letter-spacing:0; font-weight:500; color:var(--ink); text-transform:none; cursor:pointer; }
.mp label.chk input { accent-color:var(--signal); }
.mp-note { font-size:11.5px; line-height:1.5; color:var(--ink-2); } .mp-note b { color:var(--ink); }
.mp-warn { flex:none; padding:8px 12px; border:1px solid var(--brass); border-left:4px solid var(--signal); background:var(--paper-2); color:var(--ink); font-size:12.5px; line-height:1.45; }
.mp-seg { display:flex; border:1px solid var(--ink-2); width:max-content; max-width:100%; }
.mp-seg button { cursor:pointer; border:0; border-left:1px solid var(--ink-2); padding:5px 12px; font:600 12px var(--font); color:var(--ink-2); background:transparent; letter-spacing:.5px; }
.mp-seg button:first-child { border-left:0; }
.mp-seg button.sel { color:var(--paper); background:var(--navy); }
.mp-seg button:disabled { cursor:not-allowed; } .mp-seg button:disabled:not(.sel) { opacity:.5; } .mp-seg button small { font-weight:500; opacity:.8; margin-left:4px; }
.mp-games { display:flex; flex-direction:column; padding-right:6px; background:var(--paper); border:1px solid var(--paper-edge); box-shadow:0 6px 18px rgba(0,0,0,.35); }
.mp-grow, .mp-game { display:grid; grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) 62px minmax(0,1.2fr) 82px 64px 92px 118px; gap:10px; align-items:center; }
.mp-grow { flex:none; padding:0 18px 0 14px; font-size:10px; letter-spacing:1.5px; font-weight:600; color:var(--brass-hi); text-transform:uppercase; user-select:none; text-shadow:0 1px 2px rgba(0,0,0,.8); }
.mp-game { flex:none; padding:8px 12px 8px 14px; border-bottom:1px solid var(--rule); font-size:13px; color:var(--ink); }
.mp-game:nth-child(even) { background:rgba(27,42,53,.035); }
.mp-game:hover { background:var(--paper-2); box-shadow:inset 4px 0 0 var(--signal); }
.mp-game > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .mp-game .n { font-weight:700; font-size:14px; } .mp-game .n svg { color:var(--brass-lo); margin-right:5px; }
.mp-game .st { font-size:10.5px; font-weight:700; letter-spacing:1.5px; } .mp-game .st.lobby { color:var(--seal); } .mp-game .st.running { color:var(--brass-lo); } .mp-game .st.bad { color:var(--signal); }
.mp-game.off { opacity:.55; } .mp-game .mp-btn { justify-self:end; }
.mp-empty { padding:40px 20px; text-align:center; color:var(--ink-2); font-size:14px; line-height:1.6; background:var(--paper); }
.mp-ships .mp-empty { border:1px solid var(--paper-edge); }
.mp-player { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:2px 8px; align-items:center; padding:8px 10px; background:var(--paper); border:1px solid var(--paper-edge); color:var(--ink); }
.mp-player.me { background:var(--paper-2); box-shadow:inset 4px 0 0 var(--signal); --cls-bar:var(--paper-2); }
.mp-player .n { font-weight:700; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mp-player .n i { font-style:normal; font-size:9.5px; font-weight:700; letter-spacing:1px; padding:1px 5px; background:var(--navy); color:var(--paper); margin-left:6px; vertical-align:2px; }
.mp-player .n em { font-style:normal; font-size:9.5px; font-weight:600; letter-spacing:.5px; padding:0 5px; border:1px solid var(--brass); color:var(--brass-lo); margin-left:6px; vertical-align:2px; }
.mp-player .n em.direct { border-color:var(--seal); color:var(--seal); }
.mp-player .s { grid-column:1; font-size:12px; color:var(--ink-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .mp-player .s svg { margin-right:4px; }
.mp-player .r { grid-row:1 / span 2; grid-column:2; font-size:10.5px; font-weight:700; letter-spacing:1.5px; color:var(--ink-3); }
.mp-player .r.on { color:var(--seal); padding:1px 6px; border:1.5px solid var(--seal); }
.mp-player .k { grid-row:1 / span 2; grid-column:3; cursor:pointer; width:24px; height:24px; border:1px solid var(--signal); background:transparent; color:var(--signal); font:700 12px var(--font); }
.mp-player .k:hover { background:var(--signal); color:var(--flag-w); }
.mp-slot { padding:10px; border:1px dashed rgba(226,189,110,.4); color:var(--hud-dim); font-size:12px; text-align:center; }
.mp-set { display:grid; grid-template-columns:auto minmax(0,1fr); gap:8px 14px; align-items:center; font-size:13px; }
.mp-set > b { font-size:10.5px; font-weight:600; letter-spacing:1.5px; color:var(--ink-2); text-transform:uppercase; }
.mp-set select { width:auto; max-width:100%; }
.mp-title { font:700 24px/1.15 var(--font-serif); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .mp-title svg { color:var(--brass-lo); }
.mp-sub { color:var(--signal-lo); font-size:11.5px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; margin:4px 0 12px; padding-bottom:8px; border-bottom:1px solid var(--rule); }
.mp-brief { font:13px/1.55 var(--font-serif); color:var(--ink-2); margin-top:12px; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.mp-chat { flex:1; min-height:0; display:flex; flex-direction:column; padding:10px 12px; }
.mp-chat-log { flex:1; min-height:60px; overflow:auto; scrollbar-width:thin; font-size:13px; line-height:1.5; user-select:text; }
.mp-chat-line b { color:var(--flag-b); margin-right:6px; } .mp-chat-line.me b { color:var(--signal-lo); } .mp-chat-line.sys { color:var(--ink-3); font-style:italic; }
.mp-chat-in { flex:none; display:flex; gap:8px; margin-top:8px; }
.mp-ship { cursor:pointer; flex:none; display:flex; align-items:center; gap:7px; padding:6px 10px; background:var(--paper); border:1px solid var(--paper-edge); color:var(--ink); font-size:13px; font-weight:600; user-select:none; }
.mp-ship:hover { background:var(--paper-2); --cls-bar:var(--paper-2); }
.mp-ship.sel { background:var(--navy); border-color:var(--brass); color:var(--paper); --cls-bar:var(--navy); box-shadow:inset 4px 0 0 var(--signal); }
.mp-ship .tr { min-width:22px; padding:1px 0; text-align:center; font-size:11px; font-weight:700; background:var(--ink); color:var(--paper); }
.mp-ship.sel .tr { background:var(--brass); color:var(--navy); }
.mp-ship .ty { margin-left:auto; font-size:10.5px; color:var(--ink-3); letter-spacing:1px; } .mp-ship.sel .ty { color:var(--hud-dim); }
.mp-ships { display:flex; flex-direction:column; gap:4px; padding-right:6px; }
.mp-modal { position:absolute; inset:0; z-index:3; display:flex; align-items:center; justify-content:center; background:var(--veil); }
.mp-modal .box { width:460px; max-width:calc(100% - 32px); max-height:calc(100% - 32px); overflow:auto; padding:22px 26px; background:var(--paper); color:var(--ink);
   border:1px solid var(--paper-edge); outline:3px double var(--brass); outline-offset:-8px; box-shadow:0 18px 50px rgba(0,0,0,.6); }
.mp-modal .k { font-size:10.5px; letter-spacing:3px; font-weight:600; color:var(--signal-lo); margin-bottom:12px; padding-bottom:6px; border-bottom:1px solid var(--ink-2); }
.mp-modal p { font-size:13.5px; line-height:1.55; color:var(--ink); margin:0 0 6px; }
.mp-modal .bt { display:flex; gap:10px; justify-content:flex-end; margin-top:18px; }
.mp-modal .err { color:var(--signal); font-size:12.5px; margin-top:8px; min-height:16px; }
.mp-row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
@media (max-width: 1150px) { .mp-body.room { grid-template-columns:270px minmax(0,1fr) 240px; } .mp-grow, .mp-game { grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) minmax(0,1.2fr) 64px 92px 118px; } .mp-grow .c-mode, .mp-game .c-mode, .mp-grow .c-diff, .mp-game .c-diff { display:none; }
   .mp-top .m3-logo .ks-logo .wm i { display:none; } .mp-top .m3-battle { min-width:200px; } }
`;

let ui = null;
// entry point for the port button; menu: the Menu3D instance (hidden while this screen is open)
export function openMultiplayer(menu) {
   if (!ui) ui = new MpUI(menu);
   ui.open();
   return ui;
}

class MpUI {
   constructor(menu) {
      this.menu = menu;
      this.netMode = new URLSearchParams(location.search).get('net') || '';
      this.local = this.netMode === 'local';
      this.flt = { q: '', mode: '', mission: '', hideFull: false, hideLocked: false, hideRunning: false };
      this.backend = null; this.lobby = null; this.modal = null; this.view = ''; this.notice = ''; this.openedAt = 0;
      if (!document.getElementById('mpui-style')) {
         const st = document.createElement('style'); st.id = 'mpui-style'; st.textContent = CSS; document.head.appendChild(st);
      }
      this.root = document.createElement('div');
      this.root.className = 'mp hidden';
      (document.getElementById('app') || document.body).appendChild(this.root);
      // While the screen is visible it owns the keyboard: the port menu and the game listen on
      // window and must not react to Enter / arrow keys typed into the chat or a dialog.
      window.addEventListener('keydown', (e) => {
         if (this.root.classList.contains('hidden')) return;
         e.stopPropagation();
         if (e.code === 'Escape') { if (this.modal && !this.modal.dataset.forced) this._closeModal(); }
         else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
            if (this.modal) { e.preventDefault(); this.modal.querySelector('[data-ok]')?.click(); }
            else if (e.target?.matches?.('[data-chat]')) { e.preventDefault(); this._sendChat(); }
         }
      }, true);
      window.__mp = this;      // test / debug handle
   }
   get visible() { return !this.root.classList.contains('hidden'); }
   profile() { return this.menu?.profile || loadProfile(); }

   // ------------------------------------------------------------ open / close
   open() {
      this.menu?.hide();
      this.root.classList.remove('hidden');
      if (this.lobby) { this._show(this.lobby.room ? 'room' : 'list'); return; }
      this.openedAt = Date.now(); this.notice = '';
      this._show('list');
      this._connect();
      clearInterval(this._poll);
      this._poll = setInterval(() => { if (this.visible) this._renderNet(); }, 1000);
   }
   async _connect() {
      try {
         if (!this.backend) this.backend = await makeBackend(this.netMode);
         const lobby = new Lobby(this.backend, () => this.profile(), {
            onList: () => { if (this.view === 'list') this._renderGames(); },
            onRoom: () => { if (this.view === 'room') this._renderRoom(); else if (this.visible && this.lobby?.room) this._show('room'); },
            onChat: (line) => this._chatLine(line),
            onLeft: (reason, text) => { this._closeModal(); if (text) this.notice = text; if (this.visible) { this._show('list'); if (text) this._message('Spiel verlassen', text); } },
            onStart: (session) => this._startSession(session),
            onEnd: (result) => this._endSession(result),
         });
         this.lobby = lobby;
         this._renderTop();
         if (!lobby.name) this._askName(true);
         await lobby.open();
         this._renderGames();
      } catch (e) {
         console.warn('multiplayer: could not start', e);
         this.lobby = null;
         this._message('Mehrspieler nicht verfügbar', 'Das Mehrspieler-Modul konnte nicht gestartet werden. Besteht eine Internetverbindung?', () => this.close());
      }
   }
   // back to the port: withdraw the own game, leave the lobby, stop all network activity
   close() {
      clearInterval(this._poll);
      this._closeModal();
      this.lobby?.close(); this.lobby = null;
      this.root.classList.add('hidden');
      this.menu?.show();
   }

   // ------------------------------------------------------------ frame
   _show(view) {
      this.view = view;
      const room = view === 'room';
      this.root.innerHTML = `
         <div class="mp-top">
            <div class="mp-left"><div class="m3-logo">${logoSvg('Mehrspieler')}</div>
               <button class="mp-btn" data-act="back">${room ? '◂ SPIEL VERLASSEN' : '◂ ZUM HAFEN'}</button></div>
            <button class="m3-battle" data-act="main"></button>
            <div class="mp-right"><div class="mp-net"></div><button class="m3-capt" data-act="name" title="Spielername ändern"></button></div>
         </div>
         <div class="mp-body ${view}">${room ? this._roomSkeleton() : this._listSkeleton()}</div>`;
      const $ = (s) => this.root.querySelector(s);
      $('[data-act="back"]').addEventListener('click', () => { this._click(); if (room) this.lobby?.leaveRoom(); else this.close(); });
      $('[data-act="name"]').addEventListener('click', () => { this._click(); this._askName(false); });
      $('[data-act="main"]').addEventListener('click', () => this._main());
      if (room) {
         $('[data-send]').addEventListener('click', () => this._sendChat());
         for (const line of this.lobby.chat) this._chatLine(line);
         this._renderRoom();
      } else {
         this.root.querySelectorAll('[data-flt]').forEach(el => el.addEventListener(el.type === 'text' ? 'input' : 'change', () => {
            const k = el.dataset.flt;
            this.flt[k] = el.type === 'checkbox' ? el.checked : el.value;
            this._renderGames();
         }));
         this._renderGames();
      }
      if (this.modal) this.root.appendChild(this.modal);      // an open dialog survives the re-render
      this._renderTop();
   }
   _click() { this.menu?.cb?.onClick?.(); }
   _renderTop() {
      const nameBtn = this.root.querySelector('[data-act="name"]'), main = this.root.querySelector('[data-act="main"]');
      if (!nameBtn) return;
      nameBtn.innerHTML = `SPIELER<b>${esc(this.lobby?.name || '—')}</b>`;
      const lb = this.lobby, r = lb?.room;
      if (this.view === 'list') { main.textContent = 'SPIEL ERSTELLEN'; main.disabled = !lb; main.dataset.kind = 'create'; }
      else if (r && lb.isHost) {
         main.textContent = r.state === 'running' ? 'GEFECHT LÄUFT' : 'GEFECHT!'; main.disabled = !lb.canStart(); main.dataset.kind = 'start';
         main.title = main.disabled && r.state === 'lobby' ? 'Alle Mitspieler müssen bereit sein' : '';
      } else if (r) {
         const me = lb.me;
         main.textContent = r.state === 'running' ? 'GEFECHT LÄUFT' : me?.ready ? 'NICHT BEREIT' : 'BEREIT'; main.disabled = r.state !== 'lobby' || !me?.ship; main.dataset.kind = 'ready';
      }
      this._renderNet();
   }
   _renderNet() {
      const el = this.root.querySelector('.mp-net');
      if (!el) return;
      const lb = this.lobby;
      if (this.local) { el.innerHTML = '<b>Lokaler Testmodus</b><br>ohne Internet'; return; }
      if (!lb) { el.innerHTML = 'Verbinde …'; return; }
      const s = lb.status();
      el.innerHTML = `Vermittlung: <b class="${s.open ? '' : 'bad'}">${s.open}/${s.total}</b>${this.netMode === 'relay' ? '<br>nur über Relay' : ''}`;
      el.title = 'Öffentliche, anmeldefreie Vermittlungsdienste (MQTT), über die sich die Spieler finden. Kommt keine direkte Verbindung zustande, laufen auch die Spieldaten verschlüsselt darüber.';
      const dead = !s.open && Date.now() - this.openedAt > 8000;
      if (dead !== this._dead) { this._dead = dead; if (this.view === 'list') this._renderGames(); }
   }
   _main() {
      const kind = this.root.querySelector('[data-act="main"]').dataset.kind, lb = this.lobby;
      if (!lb) return;
      this._click();
      if (kind === 'create') this._askCreate();
      else if (kind === 'start') lb.start();
      else if (kind === 'ready') lb.setReady(!lb.me?.ready);
   }

   // ------------------------------------------------------------ list view
   _listSkeleton() {
      const f = this.flt, chk = (k, label) => `<label class="chk"><input type="checkbox" data-flt="${k}" ${f[k] ? 'checked' : ''}>${label}</label>`;
      return `
         <div class="mp-col">
            <div class="mp-h"><span>Filter</span></div>
            <div class="mp-box">
               <label>Suche</label><input type="text" data-flt="q" maxlength="40" placeholder="Spielname, Host, Mission" value="${esc(f.q)}">
               <label>Modus</label><select data-flt="mode"><option value="">Alle Modi</option>${MODES.map(([k, l]) => `<option value="${k}" ${f.mode === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
               <label>Mission</label><select data-flt="mission"><option value="">Alle Missionen</option>${coopMissions().map(m => `<option value="${esc(m.id)}" ${f.mission === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
               <div style="margin-top:12px">${chk('hideFull', 'Volle Spiele ausblenden')}${chk('hideLocked', 'Passwortgeschützte ausblenden')}${chk('hideRunning', 'Laufende Gefechte ausblenden')}</div>
            </div>
            <div class="mp-box mp-note mp-scroll">${this.local
               ? '<b>Lokaler Testmodus (?net=local):</b> Spiele werden nur zwischen Fenstern dieses Browsers gefunden, es gibt keine Internetverbindung.'
               : '<b>Ohne eigenen Server:</b> Die Spieler finden sich über öffentliche, anmeldefreie Vermittlungsdienste. Im Spiel verbinden sie sich möglichst direkt miteinander (WebRTC; Mitspieler können dabei deine IP-Adresse sehen). Blockiert ein Router die Direktverbindung, laufen die Spieldaten verschlüsselt über die Vermittlung (Relay) – das Spiel funktioniert trotzdem, mit etwas mehr Verzögerung.'}</div>
         </div>
         <div class="mp-col">
            <div class="mp-h"><span>Offene Spiele</span><span data-count></span></div>
            <div data-warn></div>
            <div class="mp-grow"><span>Spiel</span><span>Host</span><span class="c-mode">Modus</span><span>Mission</span><span class="c-diff">Stufe</span><span>Spieler</span><span>Status</span><span></span></div>
            <div class="mp-games mp-scroll" data-games></div>
         </div>`;
   }
   _renderGames() {
      const box = this.root.querySelector('[data-games]');
      if (!box) return;
      const lb = this.lobby, all = lb ? lb.list() : [], shown = filterGames(all, this.flt);
      this.root.querySelector('[data-count]').textContent = all.length === shown.length ? `${all.length}` : `${shown.length} von ${all.length}`;
      const warn = [];
      if (this._dead) warn.push('Kein Vermittlungsdienst erreichbar. Bitte Internetverbindung und Firewall prüfen; ohne Vermittlung können sich die Spieler nicht finden.');
      this.root.querySelector('[data-warn]').innerHTML = warn.map(w => `<div class="mp-warn" style="margin-bottom:6px">${esc(w)}</div>`).join('');
      if (!shown.length) {
         box.innerHTML = `<div class="mp-empty">${!lb || !lb.lt ? 'Verbinde mit dem Netz …' : all.length ? 'Kein Spiel entspricht den Filtern.' : 'Zurzeit sind keine Spiele offen.<br>Erstelle eines mit <b>SPIEL ERSTELLEN</b>.'}</div>`;
         return;
      }
      box.innerHTML = shown.map(g => {
         const bad = g.v !== NET_VERSION, full = g.players >= g.max, run = g.state === 'running';
         const st = bad ? ['bad', 'INKOMPATIBEL'] : run ? ['running', 'LÄUFT'] : full ? ['running', 'VOLL'] : ['lobby', 'OFFEN'];
         return `<div class="mp-game ${bad ? 'off' : ''}" data-id="${esc(g.id)}" data-host="${esc(g.hostId)}" ${bad ? 'title="Dieses Spiel wurde mit einer anderen Spielversion erstellt."' : ''}>
            <span class="n">${g.locked ? LOCK : ''}${esc(g.name)}</span><span>${esc(g.host)}</span><span class="c-mode">${esc(MODE_LABEL[g.mode] || g.mode)}</span>
            <span>${esc(misName(g.mission))}</span><span class="c-diff">${esc(DIFF_LABEL[g.difficulty] || g.difficulty)}</span><span>${g.players}/${g.max}</span>
            <span class="st ${st[0]}">${st[1]}</span>
            <button class="mp-btn" data-join="${esc(g.hostId)}" ${bad || full || run ? 'disabled' : ''}>BEITRETEN</button></div>`;
      }).join('');
      box.querySelectorAll('[data-join]').forEach(b => b.addEventListener('click', () => {
         const g = this.lobby?.list().find(x => x.hostId === b.dataset.join);
         if (!g) return;
         this._click();
         if (g.locked) this._askPassword(g); else this._join(g, '');
      }));
   }
   async _join(g, password, onError) {
      this._busy(`Verbinde mit „${g.name}“ …`);
      try {
         await this.lobby.join(g, password);
         this._closeModal();
         this._show('room');
      } catch (e) {
         const text = e?.code ? e.message : 'Beitritt fehlgeschlagen.';
         if (!e?.code) console.warn('multiplayer: join failed', e);
         if (onError && e?.code === 'password') onError(text); else this._message('Beitritt nicht möglich', text);
      }
   }

   // ------------------------------------------------------------ room view
   _roomSkeleton() {
      return `
         <div class="mp-col"><div class="mp-h"><span>Spieler</span><span data-pcount></span></div><div class="mp-col mp-scroll" data-players style="gap:6px"></div></div>
         <div class="mp-col">
            <div class="mp-box" data-settings style="flex:none"></div>
            <div class="mp-h" style="margin-top:4px"><span>Chat</span></div>
            <div class="mp-box mp-chat"><div class="mp-chat-log" data-log></div>
               <div class="mp-chat-in"><input type="text" data-chat maxlength="200" placeholder="Nachricht schreiben …" autocomplete="off"><button class="mp-btn" data-send>SENDEN</button></div></div>
         </div>
         <div class="mp-col"><div class="mp-h"><span>Dein Schiff</span><span data-scount></span></div><div class="mp-ships mp-scroll" data-ships></div></div>`;
   }
   _renderRoom() {
      const lb = this.lobby, r = lb?.room, $ = (s) => this.root.querySelector(s);
      if (!r || !$('[data-players]')) return;
      const host = lb.isHost, lobbyState = r.state === 'lobby';
      $('[data-pcount]').textContent = `${r.players.length}/${r.max}`;
      $('[data-players]').innerHTML = r.players.map(p => {
         const st = SHIP_STATS[p.ship];
         const ready = p.id === r.hostId ? ['on', 'HOST'] : p.ready ? ['on', 'BEREIT'] : ['', 'WARTET'];
         const via = lb.via(p.id);
         const route = via === 'direct' ? '<em class="direct" data-via="direct" title="Direkte Verbindung zum Host">direkt</em>'
            : via === 'relay' ? '<em data-via="relay" title="Keine direkte Verbindung zum Host: die Spieldaten laufen verschlüsselt über die Vermittlung. Das funktioniert, mit etwas mehr Verzögerung.">über Relay</em>' : '';
         return `<div class="mp-player ${p.id === lb.selfId ? 'me' : ''}" data-id="${esc(p.id)}">
            <span class="n">${esc(p.name)}${p.id === lb.selfId ? '<i>DU</i>' : ''}${route}</span>
            <span class="r ${ready[0]}">${ready[1]}</span>
            ${host && p.id !== lb.selfId ? `<button class="k" data-kick="${esc(p.id)}" title="Aus dem Spiel entfernen">✕</button>` : ''}
            <span class="s">${st ? `${classSvg(st.type, 12)}${esc(st.name)} · Stufe ${st.tier} ${esc(st.type)}` : 'kein Schiff gewählt'}</span></div>`;
      }).join('') + Array.from({ length: Math.max(0, r.max - r.players.length) }, () => '<div class="mp-slot">freier Platz</div>').join('');
      this.root.querySelectorAll('[data-kick]').forEach(b => b.addEventListener('click', () => { this._click(); lb.kick(b.dataset.kick); }));

      const m = getMission(r.mission), slots = coopSlots(r.mission);
      const edit = host && lobbyState;
      $('[data-settings]').innerHTML = `
         <div class="mp-title">${r.locked ? LOCK + ' ' : ''}${esc(r.name)}</div>
         <div class="mp-sub">${esc(MODE_LABEL[r.mode] || r.mode)} gegen Bots · ${r.locked ? 'passwortgeschützt' : 'offen für alle'}${lobbyState ? '' : ' · GEFECHT LÄUFT'}</div>
         <div class="mp-set">
            <b>Mission</b><span>${edit ? `<select data-cfg="mission">${coopMissions().map(x => `<option value="${esc(x.id)}" ${x.id === r.mission ? 'selected' : ''}>${esc(x.name)} — ${esc(TYPE_LABEL[x.type] || x.type)}</option>`).join('')}</select>`
               : `<span data-mission="${esc(r.mission)}">${esc(m?.name || r.mission)}${m ? ' — ' + esc(TYPE_LABEL[m.type] || m.type) : ''}</span>`}</span>
            <b>Schwierigkeit</b><span><div class="mp-seg">${DIFFICULTIES.map(d => `<button data-diff="${d}" class="${d === r.difficulty ? 'sel' : ''}" ${edit ? '' : 'disabled'}>${DIFF_LABEL[d]}</button>`).join('')}</div></span>
            <b>Spieler</b><span>${edit ? `<select data-cfg="max">${Array.from({ length: slots }, (_, i) => i + 1).filter(n => n >= r.players.length).map(n => `<option ${n === r.max ? 'selected' : ''}>${n}</option>`).join('')}</select>` : `max. ${r.max}`}
               ${host ? '' : '<span class="mp-note" style="margin-left:10px">Nur der Host ändert die Einstellungen.</span>'}</span>
         </div>
         ${m ? `<div class="mp-brief">${esc(m.briefing)}</div>` : ''}`;
      if (edit) {
         $('[data-cfg="mission"]').addEventListener('change', (e) => lb.configure({ mission: e.target.value }));
         $('[data-cfg="max"]').addEventListener('change', (e) => lb.configure({ max: Number(e.target.value) }));
         this.root.querySelectorAll('[data-diff]').forEach(b => b.addEventListener('click', () => { this._click(); lb.configure({ difficulty: b.dataset.diff }); }));
      }

      const own = ownShips(r.mission, this.profile()), mine = lb.me?.ship;
      $('[data-scount]').textContent = `${own.length} verfügbar`;
      $('[data-ships]').innerHTML = own.length ? own.map(k => {
         const st = SHIP_STATS[k];
         return `<div class="mp-ship ${k === mine ? 'sel' : ''}" data-ship="${esc(k)}" title="${esc(st.typeName || st.type)}"><span class="tr">${st.tier}</span>${classSvg(st.type, 13)}<span>${esc(st.name)}</span><span class="ty">${esc(st.type)}</span></div>`;
      }).join('') : '<div class="mp-empty">Für diese Mission hast du kein freigeschaltetes Schiff.</div>';
      if (lobbyState) this.root.querySelectorAll('[data-ship]').forEach(el => el.addEventListener('click', () => { this._click(); lb.setShip(el.dataset.ship); }));
      this._renderTop();
   }
   _chatLine(line) {
      const log = this.root.querySelector('[data-log]');
      if (!log) return;
      const el = document.createElement('div');
      el.className = 'mp-chat-line' + (line.id ? (line.id === this.lobby?.selfId ? ' me' : '') : ' sys');
      el.innerHTML = line.id ? `<b>${esc(line.name)}:</b>${esc(line.text)}` : esc(line.text);
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
   }
   _sendChat() {
      const inp = this.root.querySelector('[data-chat]');
      if (!inp || !inp.value.trim()) return;
      this.lobby?.sendChat(inp.value);
      inp.value = ''; inp.focus();
   }

   // ------------------------------------------------------------ match hand-over
   _startSession(session) {
      this._closeModal();
      // serialisable summary for tests and debugging
      window.__netLastSession = { mode: session.mode, mission: session.mission, difficulty: session.difficulty, seed: session.seed,
         players: session.players.map(p => ({ ...p })), selfId: session.transport.selfId, hostId: session.transport.hostId, isHost: session.transport.isHost };
      const start = typeof window.__startNetGame === 'function' ? window.__startNetGame : stubStartNetGame;
      this.root.classList.add('hidden');
      try { start(session); } catch (e) {
         console.warn('multiplayer: the game could not be started', e);
         session.onEnd({ aborted: true, reason: 'Das Gefecht konnte nicht gestartet werden.', victory: null });
      }
   }
   _endSession(result) {
      const lb = this.lobby;
      this.menu?.hide();
      this.root.classList.remove('hidden');
      this._show(lb?.room ? 'room' : 'list');
      if (lb?.room) this._chatLine({ id: '', text: result?.aborted ? `Gefecht abgebrochen${result.reason ? ': ' + result.reason : '.'}` : result?.victory ? 'Gefecht beendet: Sieg!' : 'Gefecht beendet: Niederlage.' });
      else if (this.notice) this._message('Spiel beendet', this.notice);
   }

   // ------------------------------------------------------------ dialogs
   _closeModal() { if (this.modal) { this.modal.remove(); this.modal = null; } }
   _modal(html, forced = false) {
      this._closeModal();
      const el = document.createElement('div');
      el.className = 'mp-modal';
      if (forced) el.dataset.forced = '1';
      el.innerHTML = `<div class="box">${html}</div>`;
      this.root.appendChild(el);
      this.modal = el;
      el.querySelector('[data-cancel]')?.addEventListener('click', () => { this._click(); this._closeModal(); });
      setTimeout(() => (el.querySelector('input[type=text],input[type=password]') || el.querySelector('[data-ok]'))?.focus(), 0);
      return el;
   }
   _message(title, text, then) {
      const el = this._modal(`<div class="k">${esc(title)}</div><p class="mp-msg">${esc(text)}</p><div class="bt"><button class="mp-btn pri" data-ok>OK</button></div>`);
      el.querySelector('[data-ok]').addEventListener('click', () => { this._closeModal(); then?.(); });
   }
   _busy(text) { this._modal(`<div class="k">BITTE WARTEN</div><p class="mp-busy">${esc(text)}</p>`, true); }
   _askName(first) {
      const cur = this.lobby?.name || '';
      const el = this._modal(`<div class="k">SPIELERNAME</div>
         <p>${first ? 'Unter welchem Namen sollen dich die anderen Spieler sehen?' : 'Neuer Name für den Mehrspielermodus:'}</p>
         <input type="text" data-f="pname" maxlength="20" value="${esc(cur || 'Kapitän ' + (100 + Math.floor(Math.random() * 900)))}">
         <div class="err"></div>
         <div class="bt">${first ? '' : '<button class="mp-btn" data-cancel>ABBRECHEN</button>'}<button class="mp-btn pri" data-ok>ÜBERNEHMEN</button></div>`, first);
      el.querySelector('input').select?.();
      el.querySelector('[data-ok]').addEventListener('click', () => {
         const n = cleanName(el.querySelector('input').value);
         if (!n) { el.querySelector('.err').textContent = 'Bitte einen Namen eingeben.'; return; }
         this.lobby?.setName(n);
         this._closeModal(); this._renderTop();
      });
   }
   _askPassword(g) {
      const el = this._modal(`<div class="k">PASSWORTGESCHÜTZTES SPIEL</div>
         <p>„${esc(g.name)}“ von ${esc(g.host)} ist mit einem Passwort geschützt.</p>
         <label>Passwort</label><input type="password" data-f="joinpw" maxlength="64" autocomplete="off">
         <div class="err"></div>
         <div class="bt"><button class="mp-btn" data-cancel>ABBRECHEN</button><button class="mp-btn pri" data-ok>BEITRETEN</button></div>`);
      el.querySelector('[data-ok]').addEventListener('click', () => {
         const pw = el.querySelector('input').value;
         if (!pw) { el.querySelector('.err').textContent = 'Bitte das Passwort eingeben.'; return; }
         this._join(g, pw, (text) => { this._askPassword(g); this.modal.querySelector('.err').textContent = text; });
      });
   }
   _askCreate() {
      const lb = this.lobby, missions = coopMissions();
      let mode = 'coop', diff = this.menu?.difficulty || 'normal';
      const startMission = missions.find(m => m.id === this.menu?.mission)?.id || missions.find(m => m.id === 'standard')?.id || missions[0]?.id;
      const el = this._modal(`<div class="k">SPIEL ERSTELLEN</div>
         <label>Name des Spiels</label><input type="text" data-f="name" maxlength="32" value="${esc('Spiel von ' + lb.name)}">
         <label>Modus</label><div class="mp-seg" data-seg="mode">${MODES.map(([k, l, on]) => `<button data-v="${k}" class="${k === mode ? 'sel' : ''}" ${on ? '' : 'disabled title="bald verfügbar"'}>${esc(l)}${on ? '' : '<small>(bald verfügbar)</small>'}</button>`).join('')}</div>
         <label>Mission</label><select data-f="mission">${missions.map(m => `<option value="${esc(m.id)}" ${m.id === startMission ? 'selected' : ''}>${esc(m.name)} — ${esc(TYPE_LABEL[m.type] || m.type)}</option>`).join('')}</select>
         <div class="mp-row2">
            <div><label>Schwierigkeit</label><div class="mp-seg" data-seg="diff">${DIFFICULTIES.map(d => `<button data-v="${d}" class="${d === diff ? 'sel' : ''}">${DIFF_LABEL[d]}</button>`).join('')}</div></div>
            <div><label>Max. Spieler</label><select data-f="max"></select></div>
         </div>
         <label>Passwort (optional)</label><input type="password" data-f="password" maxlength="64" autocomplete="new-password" placeholder="leer = offen für alle">
         <p class="mp-note" style="margin-top:8px">Mit Passwort kann nur beitreten, wer es kennt: Verbindungsaufbau und über Relay laufende Spieldaten werden damit verschlüsselt. Name, Mission und Spielerzahl bleiben in der Liste für alle sichtbar.</p>
         <div class="err"></div>
         <div class="bt"><button class="mp-btn" data-cancel>ABBRECHEN</button><button class="mp-btn pri" data-ok>ERSTELLEN</button></div>`);
      const f = (k) => el.querySelector(`[data-f="${k}"]`);
      const fillMax = () => { const n = coopSlots(f('mission').value), cur = Number(f('max').value) || n; f('max').innerHTML = Array.from({ length: n }, (_, i) => `<option ${i + 1 === Math.min(cur, n) ? 'selected' : ''}>${i + 1}</option>`).join(''); };
      fillMax();
      f('mission').addEventListener('change', fillMax);
      el.querySelectorAll('[data-seg="diff"] button').forEach(b => b.addEventListener('click', () => {
         diff = b.dataset.v; el.querySelectorAll('[data-seg="diff"] button').forEach(x => x.classList.toggle('sel', x === b));
      }));
      el.querySelector('[data-ok]').addEventListener('click', async () => {
         const opts = { name: f('name').value, mode, mission: f('mission').value, difficulty: diff, max: Number(f('max').value), password: f('password').value };
         this._busy('Spiel wird eröffnet …');
         try { await lb.host(opts); this._closeModal(); this._show('room'); }
         catch (e) { if (!e?.code) console.warn('multiplayer: hosting failed', e); this._message('Spiel erstellen', e?.code ? e.message : 'Das Spiel konnte nicht erstellt werden.'); }
      });
   }
}

// Stand-in until the netcode installs window.__startNetGame: logs the session and returns to the room.
function stubStartNetGame(session) {
   console.info('[net] __startNetGame is not installed; session:', JSON.stringify({ ...session, transport: undefined, onEnd: undefined }));
   setTimeout(() => session.onEnd({ aborted: true, reason: 'Das Netzspiel-Modul ist in dieser Version noch nicht enthalten.', victory: null }), 1200);
}
