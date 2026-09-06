// game/hud.js — DOM HUD: ship panel, ammo bars, status, log, siren. Cheap per-frame updates.
import { clamp01 } from './utils.js';

const $ = (id) => document.getElementById(id);

export class Hud {
   constructor() {
      this.el = {
         hud: $('hud'), log: $('log'), statusLine: $('status-line'), objectives: $('objectives'),
         speedReadout: $('speed-readout'), headingReadout: $('heading-readout'),
         hpFill: $('hp-fill'), hpText: $('hp-text'), speedFill: $('speed-fill'), knText: $('kn-text'),
         modFire: $('mod-fire'), modFlood: $('mod-flood'), modRepair: $('mod-repair'),
         ammoMain: $('ammo-main'), ammoMainN: $('ammo-main-n'),
         ammoSec: $('ammo-sec'), ammoSecN: $('ammo-sec-n'),
         ammoTorp: $('ammo-torp'), ammoTorpN: $('ammo-torp-n'),
         ammoTurbo: $('ammo-turbo'), ammoTurboN: $('ammo-turbo-n'),
         siren: $('siren'),
      };
      this._lastLogLen = 0;
      this._sirenOn = false;
   }

   show(on) { this.el.hud.classList.toggle('hidden', !on); }

   update(world) {
      const p = world.player;
      if (!p) return;
      const e = this.el;

      // ship panel
      const hpFrac = clamp01(p.hp / p.maxHP);
      e.hpFill.style.width = (hpFrac * 100).toFixed(1) + '%';
      e.hpText.textContent = Math.round(hpFrac * 100) + '%';
      const kn = p.speedKnots;
      e.knText.textContent = Math.round(kn) + ' kn';
      e.speedReadout.textContent = Math.round(kn) + ' kn';
      e.speedFill.style.width = (clamp01(Math.abs(p.speed) / p.maxSpeed) * 100).toFixed(1) + '%';
      let deg = Math.round((p.heading * 180 / Math.PI) % 360);
      if (deg < 0) deg += 360;
      e.headingReadout.textContent = deg + '°';

      // damage modules
      e.modFire.textContent = '🔥 Fire ×' + p.fires.length;
      e.modFire.classList.toggle('fire', p.fires.length > 0);
      e.modFire.classList.toggle('disabled', p.fires.length === 0);
      e.modFlood.textContent = '💧 Flood ×' + p.floods.length;
      e.modFlood.classList.toggle('flood', p.floods.length > 0);
      e.modFlood.classList.toggle('disabled', p.floods.length === 0);
      e.modRepair.classList.toggle('disabled', !(p.repairT > 0 || p.repairTimer > 0));

      // ammo
      const mainReload = p.cfg.main.reload;
      const mainFrac = p.fireTimer > 0 ? 1 - p.fireTimer / mainReload : 1;
      e.ammoMain.style.width = (mainFrac * 100).toFixed(1) + '%';
      e.ammoMainN.textContent = mainFrac >= 1 ? 'READY' : p.fireTimer.toFixed(1) + 's';
      e.ammoMainN.className = 'n ' + (mainFrac >= 1 ? 'ready' : 'cool');

      if (p.cfg.sec) {
         const secFrac = p.secTimer > 0 ? 1 - p.secTimer / p.cfg.sec.reload : 1;
         e.ammoSec.style.width = (secFrac * 100).toFixed(1) + '%';
         e.ammoSecN.textContent = secFrac >= 1 ? 'READY' : p.secTimer.toFixed(1) + 's';
         e.ammoSecN.className = 'n ' + (secFrac >= 1 ? 'ready' : 'cool');
      } else {
         e.ammoSec.style.width = '0%'; e.ammoSecN.textContent = '—';
      }
      if (p.cfg.torp) {
         const tFrac = p.torpTimer > 0 ? 1 - p.torpTimer / p.cfg.torp.cd : 1;
         e.ammoTorp.style.width = (tFrac * 100).toFixed(1) + '%';
         e.ammoTorpN.textContent = tFrac >= 1 ? 'READY' : p.torpTimer.toFixed(1) + 's';
      } else {
         e.ammoTorp.style.width = '0%'; e.ammoTorpN.textContent = '—';
      }
      if (p.cfg.boost) {
         const bReady = !p.boost.active && p.boost.cd <= 0;
         const bFrac = p.boost.active ? 1 - p.boost.t / p.cfg.boost.dur
            : bReady ? 1 : 1 - p.boost.cd / p.cfg.boost.cd;
         e.ammoTurbo.style.width = (clamp01(bFrac) * 100).toFixed(1) + '%';
         e.ammoTurboN.textContent = p.boost.active ? 'AKTIV' : bReady ? 'READY' : p.boost.cd.toFixed(1) + 's';
         e.ammoTurboN.className = 'n ' + (bReady || p.boost.active ? 'ready' : 'cool');
      }

      // status line
      const aliveBots = world.bots.filter(b => b.alive).length;
      e.objectives.textContent = `Ziele: ${world.killCount} / ${world.bots.length} versenkt`;
      let line = 'Zur See';
      if (!p.alive) line = '💀 Die Bismarck ist gesunken';
      else if (world.nearestThreat(p) < 500) line = '⚠ UNTER FEUER!';
      else if (p.hp < p.maxHP * 0.4) line = '🔴 Rumpf kritisch — absetzen & reparieren';
      else if (aliveBots === 0) line = '🏆 Sieg!';
      else if (world.time < 20) line = 'Feindliche Flotte voraus — Position beziehen';
      else line = `Kampf in Gange — ${aliveBots} Feind${aliveBots === 1 ? '' : 'e'} aktiv`;
      e.statusLine.textContent = line;

      // siren when under fire
      const underFire = p.alive && world.nearestThreat(p) < 500;
      if (underFire !== this._sirenOn) {
         this._sirenOn = underFire;
         e.siren.classList.toggle('on', underFire);
         if (underFire && world.audio) world.audio.siren();
      }

      // log
      this._syncLog(world);
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
