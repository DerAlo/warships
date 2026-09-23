// game/director.js — mission runtime on top of the World: timed/conditional waves, tutorial hints,
// exit zones, objectives, win/lose, the 1-3 star rating and the endless survival mode.
// Active only for missions with `objectives` (missions.js); the default skirmish stays on the
// legacy "sink everything" rule in state.js.
import { dist } from './utils.js';
import { survivalWave, SURV_POINTS } from './missions.js';

const fmtTime = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

export class Director {
   constructor(world, mission) {
      this.w = world;
      this.m = mission;
      this.waves = (mission.waves || []).map((wv, i) => ({ ...wv, idx: i, done: false }));
      this.hints = (mission.hints || []).slice().sort((a, b) => a.at - b.at);
      this.hintIdx = 0;
      this.banner = null;                 // {text, t, kind} -- big centred HUD line
      this.objectives = (mission.objectives || []).map(o => ({ ...o, state: 'active', progress: '' }));
      this.survival = !!mission.survival;
      this.wave = 0;
      this.score = 0;
      this.breakT = this.survival ? 3 : 0; // survival: countdown to the next wave
      this.inBreak = this.survival;
   }

   // ---------- helpers ----------
   enemiesAlive() { return this.w.bots.some(b => b.alive); }
   pendingWaves() { return this.waves.filter(wv => !wv.done); }
   // ships the objectives count: already spawned ones plus those still waiting in a wave
   _tagged(tag, side) {
      const list = side === 'enemy' ? this.w.bots : this.w.allies;
      return list.filter(s => !tag || s.tag === tag);
   }
   _pendingTagged(tag, key = 'bots') {
      let n = 0;
      for (const wv of this.pendingWaves()) for (const b of wv[key] || []) if (!tag || b.tag === tag) n++;
      return n;
   }
   say(text, kind = 'warn', dur = 6) {
      this.banner = { text, t: dur, kind };
      this.w.log(null, text, kind);
   }

   // ---------- per-tick ----------
   update(dt) {
      const w = this.w;
      if (this.banner) { this.banner.t -= dt; if (this.banner.t <= 0) this.banner = null; }
      while (this.hintIdx < this.hints.length && w.time >= this.hints[this.hintIdx].at) {
         this.say(this.hints[this.hintIdx++].text, 'info', 7);
      }
      if (this.survival) this._survival(dt);
      else this._waves();
      this._exits();
   }

   _waves() {
      const w = this.w;
      let fired = false;
      for (const wv of this.waves) {
         if (wv.done) continue;
         let go = false;
         if (wv.at != null && w.time >= wv.at) go = true;
         else if (wv.when === 'cleared' && !this.enemiesAlive()) go = true;
         else if (wv.when === 'hp') {
            const s = w.bots.find(b => b.tag === wv.tag);
            if (!s || !s.alive) { wv.done = true; continue; }  // trigger ship gone: wave never comes
            if (s.hp < s.maxHP * wv.below) go = true;
         }
         if (go) { this._spawnWave(wv); fired = true; break; }
      }
      // the map went quiet: bring the next wave forward instead of making the player wait
      if (!fired && !this.enemiesAlive()) {
         const next = this.waves.find(wv => !wv.done);
         if (next) this._spawnWave(next);
      }
   }

   _spawnWave(wv) {
      wv.done = true;
      for (const b of wv.bots || []) this.w.spawnBot(b, 'enemy');
      for (const a of wv.allies || []) this.w.spawnBot(a, 'player');
      if (wv.msg) this.say(wv.msg, 'warn', 6);
      this.w.emit({ kind: 'reinforce' });
   }

   // ships that reach their exit zone leave the map: escaped enemies / arrived friendlies
   _exits() {
      const w = this.w;
      for (const s of w.ships) {
         if (!s.alive || !s.exit || s.human) continue;
         if (dist(s.pos, s.exit) > s.exit.r) continue;
         s.alive = false;
         if (s.side === 'enemy') {
            s.escaped = true;
            w.log(null, `⚓ Entkommen: ${s.name}`, 'warn');
            w.emit({ kind: 'escaped', ship: s });
         } else {
            s.arrived = true;
            w.log(null, `✅ ${s.name} hat den Sammelpunkt erreicht`, 'kill');
            w.emit({ kind: 'arrived', ship: s });
         }
      }
   }

   // ---------- survival ----------
   _survival(dt) {
      const w = this.w;
      const p = w.player;
      if (this.inBreak) {
         this.breakT -= dt;
         if (this.breakT <= 0) {
            this.inBreak = false;
            this.wave++;
            const specs = survivalWave(this.wave, p.pos, (w.seed || 1) * 131 + this.wave * 7919);
            // later waves also get sturdier hulls so the budget growth is not the only escalation
            const hpMult = Math.min(1.8, 1 + 0.04 * (this.wave - 1));
            for (const s of specs) w.spawnBot({ ...s, hpMult }, 'enemy');
            this.say(`🌊 Welle ${this.wave}: ${specs.length} Feindschiffe`, 'warn', 5);
            w.emit({ kind: 'reinforce' });
         }
         return;
      }
      if (!this.enemiesAlive()) {
         const bonus = 100 * this.wave;
         this.score += bonus;
         // a breather: patch up part of the hull and top up the repair party
         const heal = p.maxHP * 0.12;
         p.hp = Math.min(p.maxHP, p.hp + heal);
         p.fires = []; p.floods = [];
         this.inBreak = true;
         this.breakT = 8;
         this.say(`🏁 Welle ${this.wave} überstanden · +${bonus} Punkte · Reparatur`, 'kill', 5);
         w.emit({ kind: 'waveClear', wave: this.wave });
      }
   }

   // ---------- sinks ----------
   onSink(ship) {
      const w = this.w;
      if (ship.side === 'enemy' && this.survival) this.score += SURV_POINTS[ship.cls] || 100;
      if (ship === w.player) {
         // mutual kill that completes the mission still counts as a win
         this.evaluate();
         if (w.phase === 'playing') w._lose(this.survival
            ? `💀 Die Bismarck ist gesunken — Welle ${this.wave}, ${this.score} Punkte`
            : '💀 Die Bismarck ist gesunken — Mission gescheitert.');
      } else if (ship.side === 'player' && ship.tag) {
         w.log(null, `⚠ Verloren: ${ship.name}`, 'warn');
      }
   }

   // ---------- objectives ----------
   evaluate() {
      const w = this.w;
      if (w.phase !== 'playing') return;
      let allDone = this.objectives.length > 0, failed = null;
      for (const o of this.objectives) {
         this._evalObjective(o);
         if (o.state === 'failed') failed = failed || o;
         if (o.state !== 'done') allDone = false;
      }
      if (failed) w._lose('❌ Mission gescheitert: ' + (failed.failText || failed.text));
      else if (allDone) w._win('🏆 Missionsziel erreicht — Sieg!');
   }

   _evalObjective(o) {
      const w = this.w;
      switch (o.type) {
         case 'sinkAll': {
            const total = w.bots.length + this._pendingTagged(null);
            const sunk = w.bots.filter(b => !b.alive && !b.escaped).length;
            o.progress = `${sunk}/${total}`;
            if (!this.enemiesAlive() && !this.pendingWaves().length) o.state = 'done';
            break;
         }
         case 'sink': {
            const ships = this._tagged(o.tag, 'enemy');
            const pend = this._pendingTagged(o.tag);
            const total = ships.length + pend;
            const need = o.count || total;
            const sunk = ships.filter(s => !s.alive && !s.escaped).length;
            const gone = ships.filter(s => s.escaped).length;
            o.progress = `${sunk}/${need}`;
            if (sunk >= need && (o.count || pend === 0)) o.state = 'done';
            else if (total - gone < need) { o.state = 'failed'; o.failText = 'Ziel entkommen'; }
            break;
         }
         case 'intercept': {
            // done once enough are sunk AND nobody is left under way (so "all of them" stays possible)
            const ships = this._tagged(o.tag, 'enemy');
            const total = ships.length + this._pendingTagged(o.tag);
            const sunk = ships.filter(s => !s.alive && !s.escaped).length;
            const esc = ships.filter(s => s.escaped).length;
            const running = ships.filter(s => s.alive).length;
            o.progress = `${sunk}/${o.need}` + (esc ? ` · ${esc} entkommen` : '');
            if (esc > total - o.need) { o.state = 'failed'; o.failText = 'Zu viele Transporter entkommen'; }
            else if (sunk >= o.need && running === 0) o.state = 'done';
            break;
         }
         case 'escort': {
            const ships = this._tagged(o.tag, 'player');
            const total = ships.length + this._pendingTagged(o.tag, 'allies');
            const arrived = ships.filter(s => s.arrived).length;
            const lost = ships.filter(s => !s.alive && !s.arrived).length;
            const running = ships.filter(s => s.alive).length;
            o.progress = `${arrived}/${o.need} am Ziel` + (lost ? ` · ${lost} verloren` : '');
            if (total - lost < o.need) { o.state = 'failed'; o.failText = 'Zu viele Transporter verloren'; }
            else if (arrived >= o.need && running === 0) o.state = 'done';
            break;
         }
         case 'survive': {
            o.progress = fmtTime(Math.max(0, o.time - w.time));
            if (w.time >= o.time) o.state = 'done';
            break;
         }
         case 'survival': {
            o.progress = `Welle ${this.wave} · ${this.score} Pkt`;
            break;
         }
      }
   }

   // ---------- rating ----------
   criteria() {
      const w = this.w, p = w.player;
      return (this.m.stars || []).map(c => {
         let ok = false, text = c.text;
         switch (c.type) {
            case 'hp':
               ok = p.alive && p.hp / p.maxHP >= c.min;
               text = text || `Rumpf mindestens ${Math.round(c.min * 100)} %`;
               break;
            case 'time':
               ok = w.time <= c.max;
               text = text || `Sieg in unter ${fmtTime(c.max)} min`;
               break;
            case 'allOf': {
               const en = w.bots.filter(s => s.tag === c.tag), al = w.allies.filter(s => s.tag === c.tag);
               ok = en.length ? en.every(s => !s.alive && !s.escaped) : al.every(s => s.arrived);
               break;
            }
            case 'stat': {
               const v = w.stats[c.key] || 0;
               ok = (c.min == null || v >= c.min) && (c.max == null || v <= c.max);
               break;
            }
            case 'alliesAlive':
               ok = w.allies.every(s => s.alive || s.arrived);
               text = text || 'Alle Verbündeten überleben';
               break;
         }
         return { text, ok };
      });
   }
   stars() {
      if (this.w.phase !== 'won') return 0;
      return Math.min(3, 1 + this.criteria().filter(c => c.ok).length);
   }

   // HUD snapshot
   view() {
      return {
         title: this.m.title,
         objectives: this.objectives.map(o => ({ text: o.text, progress: o.progress, state: o.state })),
         banner: this.banner,
         survival: this.survival ? { wave: this.wave, score: this.score, inBreak: this.inBreak, breakT: this.breakT } : null,
      };
   }
}
