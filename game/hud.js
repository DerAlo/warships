// game/hud.js — DOM HUD: ship panel, weapons (ammo, turret pips, launchers, secondaries),
// consumables, visibility state, ribbons + damage counter, log, siren. Cheap per-frame updates.
import { clamp01 } from './utils.js';

const $ = (id) => document.getElementById(id);

// hit outcome -> [ribbon text, css class]
const RIBBON = {
   CITADEL: ['ZITADELLE!', 'cit'], PEN: ['DURCHSCHLAG', 'pen'], HE: ['DURCHSCHLAG', 'pen'],
   RICOCHET: ['ABPRALLER', 'ric'], OVERPEN: ['ÜBERDURCHSCHLAG', 'over'], SEC: ['SEKUNDÄR', 'pen'],
   TORP: ['TORPEDOTREFFER', 'cit'],
};
const RIBBON_LIFE = 2.8;    // s a ribbon stays after its last increment
const RIBBON_MAX = 5;
const CONS_KEYS = ['repair', 'dc', 'smoke', 'boost'];

export class Hud {
   constructor() {
      this.el = {
         hud: $('hud'), log: $('log'), statusLine: $('status-line'), objectives: $('objectives'),
         visStatus: $('vis-status'), anchorStatus: $('anchor-status'),
         speedReadout: $('speed-readout'), headingReadout: $('heading-readout'),
         hpFill: $('hp-fill'), hpText: $('hp-text'), speedFill: $('speed-fill'), knText: $('kn-text'),
         modFire: $('mod-fire'), modFlood: $('mod-flood'), modRepair: $('mod-repair'),
         ammoAP: $('ammo-ap'), ammoHE: $('ammo-he'), pips: $('turret-pips'),
         tlPort: $('tl-port'), tlStbd: $('tl-stbd'), torpSpread: $('torp-spread'), secLine: $('sec-line'),
         ribbons: $('ribbons'), dmgTotal: $('dmg-total'),
         siren: $('siren'),
      };
      this.cons = {};
      for (const k of CONS_KEYS) {
         const root = $('cons-' + k);
         this.cons[k] = { root, fill: root.querySelector('i'), chg: root.querySelector('.chg'), st: root.querySelector('.st'), cls: '' };
      }
      this.reset();
   }

   // per-match state (called from startGame)
   reset() {
      this._lastLogLen = 0;
      this._sirenOn = false;
      this._pipShip = null;
      this._ribbons = [];
      this._dmgShown = -1;
      if (this.el.ribbons) this.el.ribbons.innerHTML = '';
   }

   show(on) { this.el.hud.classList.toggle('hidden', !on); }

   // World events -> ribbons + hit markers (world._hitMarks is drawn by render.js)
   onEvents(world, evs) {
      const p = world.player;
      if (!p) return;
      for (const ev of evs) {
         if (ev.kind === 'hit' && ev.shooter === p) {
            const r = RIBBON[ev.outcome];
            if (r) this._ribbon(r[0], r[1]);
            if (ev.fire) this._ribbon('BRAND', 'fire');
            if (ev.flood) this._ribbon('FLUTUNG', 'flood');
            if (ev.outcome !== 'SEC') {
               (world._hitMarks || (world._hitMarks = [])).push({ pos: ev.pos, age: 0, outcome: ev.outcome, big: ev.outcome === 'CITADEL' || ev.outcome === 'TORP' });
            }
         } else if (ev.kind === 'sink' && ev.by === p && ev.ship !== p) {
            this._ribbon('VERSENKT', 'kill');
         }
      }
   }

   _ribbon(text, cls) {
      // WoWs-style stacking: a repeat of the same ribbon bumps its counter instead of a new row
      let r = this._ribbons.find(x => x.text === text);
      if (!r) {
         const el = document.createElement('div');
         el.className = 'ribbon ' + cls;
         this.el.ribbons.prepend(el);
         r = { text, el, n: 0, t: 0 };
         this._ribbons.push(r);
         while (this._ribbons.length > RIBBON_MAX) this._ribbons.shift().el.remove();
      }
      r.n++;
      r.t = 0;
      r.el.classList.remove('fade');
      r.el.innerHTML = '';
      r.el.append(text);
      if (r.n > 1) { const b = document.createElement('b'); b.textContent = '×' + r.n; r.el.append(b); }
   }

   _tickRibbons(dt) {
      for (let i = this._ribbons.length - 1; i >= 0; i--) {
         const r = this._ribbons[i];
         r.t += dt;
         if (r.t > RIBBON_LIFE) r.el.classList.add('fade');
         if (r.t > RIBBON_LIFE + 0.5) { r.el.remove(); this._ribbons.splice(i, 1); }
      }
   }

   update(world, dt = 1 / 60) {
      const p = world.player;
      if (!p) return;
      const e = this.el;
      this._tickRibbons(dt);

      // ship panel
      const hpFrac = clamp01(p.hp / p.maxHP);
      e.hpFill.style.width = (hpFrac * 100).toFixed(1) + '%';
      e.hpText.textContent = Math.round(Math.max(0, p.hp)) + ' / ' + Math.round(p.maxHP);
      const kn = p.speedKnots;
      e.knText.textContent = Math.round(kn) + ' kn';
      e.speedReadout.textContent = Math.round(kn) + ' kn';
      e.speedFill.style.width = (clamp01(Math.abs(p.speed) / p.maxSpeed) * 100).toFixed(1) + '%';
      let deg = Math.round((p.heading * 180 / Math.PI) % 360);
      if (deg < 0) deg += 360;
      e.headingReadout.textContent = deg + '°';

      // damage modules
      e.modFire.textContent = '🔥 Brand ×' + p.fires.length;
      e.modFire.classList.toggle('fire', p.fires.length > 0);
      e.modFire.classList.toggle('disabled', p.fires.length === 0);
      e.modFlood.textContent = '💧 Flut ×' + p.floods.length;
      e.modFlood.classList.toggle('flood', p.floods.length > 0);
      e.modFlood.classList.toggle('disabled', p.floods.length === 0);
      const rep = p.cons.repair;
      e.modRepair.textContent = '🔧 Heilbar ' + Math.round(p.healable);
      e.modRepair.classList.toggle('disabled', !(rep && rep.active) && p.healable < 1);

      this._weapons(p);
      this._consumables(p);

      // running damage counter
      const dmg = Math.round(p.dmgDealt);
      if (dmg !== this._dmgShown) { this._dmgShown = dmg; e.dmgTotal.textContent = dmg.toLocaleString('de-DE'); }

      // status line
      const aliveBots = world.bots.filter(b => b.alive).length;
      e.objectives.textContent = `Ziele: ${world.killCount} / ${world.bots.length} versenkt`;
      let line;
      if (!p.alive) line = '💀 Die Bismarck ist gesunken';
      else if (world.nearestThreat(p) < 500) line = '⚠ UNTER FEUER!';
      else if (p.hp < p.maxHP * 0.4) line = '🔴 Rumpf kritisch — absetzen & reparieren';
      else if (aliveBots === 0) line = '🏆 Sieg!';
      else if (world.time < 20) line = 'Feindliche Flotte voraus — Position beziehen';
      else line = `Der Kampf ist im Gange — ${aliveBots} Feind${aliveBots === 1 ? '' : 'e'} aktiv`;
      e.statusLine.textContent = line;
      this._visibility(p);
      e.anchorStatus.classList.toggle('hidden', !(p.alive && p.anchorOut));

      // siren when under fire
      const underFire = p.alive && world.nearestThreat(p) < 500;
      if (underFire !== this._sirenOn) {
         this._sirenOn = underFire;
         e.siren.classList.toggle('on', underFire);
         if (underFire && world.audio) world.audio.siren();
      }

      this._syncLog(world);
   }

   // Is the player seen, and why: the smoke/bloom states are what make smoke play readable.
   _visibility(p) {
      let text, cls;
      if (!p.alive) { text = ''; cls = ''; }
      else if (p.visible && p.visReason === 'bloom') { text = '🔥 SICHTBAR (Mündungsfeuer)'; cls = 'bloom'; }
      else if (p.visible && p.visReason === 'prox') { text = '👁 GESICHTET (Nahbereich)'; cls = 'spotted'; }
      else if (p.visible) { text = '👁 GESICHTET'; cls = 'spotted'; }
      else if (p.inSmokeNow) { text = '🌫 IM NEBEL — VERBORGEN'; cls = 'smoke'; }
      else { text = 'UNENTDECKT'; cls = 'stealth'; }
      const v = this.el.visStatus;
      if (v.textContent !== text) v.textContent = text;
      if (v.className !== cls) v.className = cls;
   }

   _weapons(p) {
      const e = this.el;
      e.ammoAP.classList.toggle('sel', p.ammo === 'AP');
      e.ammoHE.classList.toggle('sel', p.ammo === 'HE');

      // per-turret pips (built once per ship)
      if (this._pipShip !== p) {
         this._pipShip = p;
         e.pips.innerHTML = '';
         this._pips = p.turrets.map(t => {
            const el = document.createElement('div');
            el.className = 'pip';
            const fill = document.createElement('i');
            const lbl = document.createElement('span');
            lbl.textContent = t.name;
            el.append(fill, lbl);
            e.pips.append(el);
            return { el, fill, lbl, cls: '' };
         });
      }
      p.turrets.forEach((t, i) => {
         const pip = this._pips[i];
         const ready = t.cd <= 0;
         const frac = ready ? 1 : clamp01(1 - t.cd / (t.cdMax || 1));
         pip.fill.style.height = (frac * 100).toFixed(0) + '%';
         const cls = 'pip' + (ready ? ' ready' : '') + (ready && t.aligned ? ' bear' : '');
         if (cls !== pip.cls) { pip.cls = cls; pip.el.className = cls; }
         const txt = ready ? t.name : t.cd.toFixed(0);
         if (pip.lbl.textContent !== txt) pip.lbl.textContent = txt;
      });

      // torpedo launchers
      const T = p.cfg.torp;
      for (const [id, el] of [['port', e.tlPort], ['stbd', e.tlStbd]]) {
         const l = p.launchers.find(x => x.id === id);
         if (!l) { el.style.opacity = 0.3; continue; }
         const ready = l.cd <= 0;
         el.classList.toggle('ready', ready);
         el.firstElementChild.style.width = ((ready ? 1 : clamp01(1 - l.cd / T.cd)) * 100).toFixed(0) + '%';
         el.lastElementChild.textContent = ready ? l.label : `${l.label} ${Math.ceil(l.cd)}s`;
      }
      e.torpSpread.textContent = (p.torpSpread === 'wide' ? 'weit' : 'eng') + ' [Q]';

      // secondaries
      const tgt = p.secTarget;
      const focus = p.secFocus && p.secFocus.alive ? p.secFocus : null;
      e.secLine.textContent = focus ? `◎ ${focus.name}` : tgt ? `auto: ${tgt.name}` : 'frei';
      e.secLine.classList.toggle('focus', !!focus);
   }

   _consumables(p) {
      for (const k of CONS_KEYS) {
         const slot = this.cons[k];
         const c = p.cons[k];
         const st = p.consState(k);
         let cls = 'cons', txt = '', fill = 0;
         if (st === 'none') { cls += ' empty'; txt = '—'; }
         else if (st === 'active') { cls += ' active'; txt = Math.ceil(c.t) + ' s'; fill = clamp01(c.t / c.cfg.dur); }
         else if (st === 'empty') { cls += ' empty'; txt = 'leer'; }
         else if (st === 'cd') { txt = Math.ceil(c.cd) + ' s'; fill = clamp01(c.cd / c.cfg.cd); }
         else { cls += ' ready'; txt = 'bereit'; }
         if (slot.cls !== cls) { slot.cls = cls; slot.root.className = cls; }
         if (slot.st.textContent !== txt) slot.st.textContent = txt;
         slot.fill.style.height = (fill * 100).toFixed(0) + '%';
         const chg = !c ? '' : c.charges === Infinity ? '∞' : String(c.charges);
         if (slot.chg.textContent !== chg) slot.chg.textContent = chg;
      }
   }

   _syncLog(world) {
      const lines = world.logLines;
      if (lines.length === this._lastLogLen) return;
      const e = this.el.log;
      // rebuild only the tail (cheap enough at ≤60 lines)
      const start = Math.max(0, lines.length - 7);
      e.innerHTML = '';
      for (let i = start; i < lines.length; i++) {
         const l = document.createElement('div');
         l.className = 'l ' + lines[i].type;
         l.textContent = lines[i].text;
         e.appendChild(l);
      }
      this._lastLogLen = lines.length;
   }
}
