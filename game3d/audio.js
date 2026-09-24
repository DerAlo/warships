// game3d/audio.js — procedural Web Audio for the 3D mode. No assets: everything is synthesised
// from noise buffers and oscillators. The AudioContext is created/resumed on the first user
// gesture (autoplay rules); before that every call is a silent no-op.
//
// Distance cues: other ships' guns/splashes are delayed by a TIME-COMPRESSED speed of sound
// (d / 1500 m/s, capped) and muffled by a distance low-pass, so a far salvo reads as far.
const SOUND_SPEED = 1500;   // m/s -- compressed like the sim's ship speeds, real 343 feels laggy
const MAX_VOICES = 36;

export class Audio {
   constructor() {
      this.ctx = null;
      this.muted = false;
      this.volume = 0.7;
      this._voices = 0;
   }

   // Call from any user gesture; safe to call repeatedly.
   init() {
      if (this.ctx) { this.resume(); return; }
      try {
         const AC = window.AudioContext || window.webkitAudioContext;
         if (!AC) return;
         const ctx = this.ctx = new AC();
         this.comp = ctx.createDynamicsCompressor();
         this.comp.threshold.value = -14; this.comp.knee.value = 10; this.comp.ratio.value = 5;
         this.comp.attack.value = 0.004; this.comp.release.value = 0.25;
         this.master = ctx.createGain();
         this.master.gain.value = this.muted ? 0 : this.volume;
         this.comp.connect(this.master); this.master.connect(ctx.destination);
         this.sfx = ctx.createGain(); this.sfx.gain.value = 1; this.sfx.connect(this.comp);
         this.ui = ctx.createGain(); this.ui.gain.value = 0.55; this.ui.connect(this.master);
         this.amb = ctx.createGain(); this.amb.gain.value = 0; this.amb.connect(this.master);
         this._white = this._makeNoise(2.5, 'white');
         this._brown = this._makeNoise(4, 'brown');
         this._shaper = ctx.createWaveShaper();
         this._shaper.curve = this._driveCurve(2.2);
         this._shaper.connect(this.sfx);
         this._buildAmbient();
         this._buildEngine();
      } catch (e) { this.ctx = null; /* audio unavailable -- game runs silent */ }
   }

   resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }

   setMuted(m) {
      this.muted = m;
      if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
   }

   _makeNoise(sec, kind) {
      const len = Math.floor(this.ctx.sampleRate * sec);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
         const w = Math.random() * 2 - 1;
         if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
         else d[i] = w;
      }
      return buf;
   }

   _driveCurve(k) {
      const n = 1024, c = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
      return c;
   }

   // ---- continuous layers ----
   _buildAmbient() {
      const ctx = this.ctx;
      // sea: brown noise, low-passed, slow swell LFO on the gain
      const sea = ctx.createBufferSource(); sea.buffer = this._brown; sea.loop = true;
      const seaLp = ctx.createBiquadFilter(); seaLp.type = 'lowpass'; seaLp.frequency.value = 420;
      const seaG = ctx.createGain(); seaG.gain.value = 0.5;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.22;
      lfo.connect(lfoG); lfoG.connect(seaG.gain);
      sea.connect(seaLp); seaLp.connect(seaG); seaG.connect(this.amb);
      // wind: band-passed white noise with a wandering centre frequency
      const wind = ctx.createBufferSource(); wind.buffer = this._white; wind.loop = true;
      const wBp = ctx.createBiquadFilter(); wBp.type = 'bandpass'; wBp.frequency.value = 700; wBp.Q.value = 0.8;
      const wG = ctx.createGain(); wG.gain.value = 0.06;
      const wl = ctx.createOscillator(); wl.frequency.value = 0.07;
      const wlG = ctx.createGain(); wlG.gain.value = 260;
      wl.connect(wlG); wlG.connect(wBp.frequency);
      wind.connect(wBp); wBp.connect(wG); wG.connect(this.amb);
      sea.start(); lfo.start(); wind.start(); wl.start();
      this._windG = wG; this._seaLp = seaLp;
   }

   _buildEngine() {
      const ctx = this.ctx;
      this.engineOsc = ctx.createOscillator(); this.engineOsc.type = 'sawtooth'; this.engineOsc.frequency.value = 38;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 150;
      this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0;
      this.engineOsc.connect(lp); lp.connect(this.engineGain); this.engineGain.connect(this.sfx);
      this.engineOsc.start();
   }

   // Per frame: engine follows speed; ambient follows sea state. muted = paused/menu.
   updateEngine(speed, maxSpeed, muted = false) {
      if (!this.ctx) return;
      const k = Math.min(1.2, Math.abs(speed) / (maxSpeed || 18));
      const t = this.ctx.currentTime;
      this.engineOsc.frequency.setTargetAtTime(32 + k * 40, t, 0.2);
      this.engineGain.gain.setTargetAtTime(muted ? 0 : 0.018 + k * 0.05, t, 0.25);
   }
   updateAmbient(seaState = 0.4, muted = false) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      this.amb.gain.setTargetAtTime(muted ? 0.05 : 0.22 + seaState * 0.2, t, 0.6);
      this._windG.gain.setTargetAtTime(0.04 + seaState * 0.09, t, 1.0);
      this._seaLp.frequency.setTargetAtTime(300 + seaState * 400, t, 1.0);
   }

   // ---- building blocks ----
   _voice(dur) {
      if (!this.ctx || this._voices >= MAX_VOICES) return false;
      this._voices++;
      setTimeout(() => { this._voices--; }, (dur + 0.2) * 1000);
      return true;
   }
   _dist(d) {
      d = Math.max(0, d || 0);
      return { delay: Math.min(2.5, d / SOUND_SPEED), gain: 1 / (1 + d / 1800), cutoff: Math.max(350, 9000 / (1 + d / 900)) };
   }
   _noise(when, dur, { freq = 800, type = 'lowpass', q = 0.7, gain = 0.5, sweepTo = null, attack = 0.004, bus = null, buf = null, drive = false } = {}) {
      const ctx = this.ctx, t = ctx.currentTime + when;
      const src = ctx.createBufferSource(); src.buffer = buf || this._white;
      src.playbackRate.value = 0.9 + Math.random() * 0.2;
      const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
      f.frequency.setValueAtTime(freq, t);
      if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g);
      if (drive) { g.connect(this._shaper); } else g.connect(bus || this.sfx);
      src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
   }
   _tone(when, freq, dur, { gain = 0.3, type = 'sine', slideTo = null, attack = 0.003, bus = null } = {}) {
      const ctx = this.ctx, t = ctx.currentTime + when;
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(bus || this.sfx);
      o.start(t); o.stop(t + dur + 0.05);
   }
   // A filtered sub-bus for distant sounds (one per event, garbage-collected after use).
   _far(cutoff, gain) {
      const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
      const g = this.ctx.createGain(); g.gain.value = gain;
      f.connect(g); g.connect(this.sfx);
      return f;
   }

   // ---- one-shots ----
   // Main battery report. caliber in mm, count = barrels in this salvo, dist = metres from the
   // listener (0 = own guns: full punch, no delay).
   mainGun(caliber = 380, count = 1, dist = 0) {
      if (!this._voice(2.5)) return;
      const { delay, gain, cutoff } = this._dist(dist);
      const bus = dist > 0 ? this._far(cutoff, gain) : null;
      const heavy = Math.min(1, Math.max(0, (caliber - 100) / 320));
      const w = (0.75 + 0.25 * Math.min(count, 6) / 3) * (dist > 0 ? 0.8 : 1);
      // crack
      this._noise(delay, 0.09, { freq: 2500, type: 'highpass', gain: 0.35 * w, bus });
      // body: saturated low thump (the shared drive stage is wired to sfx once in init --
      // connecting it per salvo would leak a permanent route into every distant sub-bus)
      this._tone(delay, 58 + (1 - heavy) * 40, 0.55 + heavy * 0.4, { gain: 0.9 * w, slideTo: 26, bus });
      this._noise(delay, 0.5 + heavy * 0.3, { freq: 1400, sweepTo: 160, gain: 0.8 * w, drive: dist === 0 });
      // rolling tail
      this._noise(delay + 0.03, 1.4 + heavy * 1.2, { freq: 520, sweepTo: 90, gain: 0.45 * w, buf: this._brown, bus, attack: 0.05 });
      for (let i = 1; i < Math.min(count, 4); i++) {
         const dd = delay + i * 0.045 + Math.random() * 0.03;
         this._noise(dd, 0.7, { freq: 900 * (0.85 + Math.random() * 0.3), sweepTo: 140, gain: 0.35 * w, bus });
      }
   }
   // legacy name used by older call sites
   cannon(big = false, count = 1) { this.mainGun(big ? 380 : 150, count, 0); }

   secondary(dist = 0) {
      if (!this._voice(0.6)) return;
      const { delay, gain, cutoff } = this._dist(dist);
      const bus = this._far(Math.min(cutoff, 6000), gain * 0.7);
      this._noise(delay, 0.28, { freq: 1600, sweepTo: 300, gain: 0.45, bus });
      this._tone(delay, 120, 0.18, { gain: 0.25, slideTo: 60, bus });
   }

   // incoming shell passing close overhead
   whistle(when = 0) {
      if (!this._voice(1.2)) return;
      const f0 = 2200 + Math.random() * 500;
      this._tone(when, f0, 0.95, { gain: 0.07, type: 'sine', slideTo: 520, attack: 0.25 });
      this._noise(when, 0.95, { freq: f0, sweepTo: 500, type: 'bandpass', q: 6, gain: 0.12, attack: 0.3 });
   }

   splash(dist = 0, big = false) {
      if (!this._voice(1.0)) return;
      const { delay, gain, cutoff } = this._dist(dist);
      const bus = this._far(cutoff, gain);
      this._noise(delay, big ? 0.9 : 0.55, { freq: big ? 700 : 1100, type: 'bandpass', q: 0.9, gain: big ? 0.55 : 0.3, bus, attack: 0.01 });
      if (big) this._tone(delay, 70, 0.4, { gain: 0.35, slideTo: 35, bus });
   }

   // own ship takes a hit: metallic clang + crunch
   hit(big = false) {
      if (!this._voice(1.0)) return;
      for (const [f, g] of [[173, 0.2], [311, 0.14], [467, 0.1], [701, 0.07]]) this._tone(0, f * (0.95 + Math.random() * 0.1), big ? 0.9 : 0.5, { gain: g, type: 'triangle' });
      this._noise(0, 0.35, { freq: 1800, sweepTo: 400, gain: big ? 0.7 : 0.45 });
      this._tone(0, 60, 0.4, { gain: 0.5, slideTo: 30 });
   }

   explosion(big = false, dist = 0) {
      if (!this._voice(1.6)) return;
      const { delay, gain, cutoff } = this._dist(dist);
      const bus = this._far(cutoff, gain);
      this._noise(delay, big ? 1.5 : 0.7, { freq: 900, sweepTo: 120, gain: big ? 0.9 : 0.5, bus });
      this._tone(delay, 48, big ? 1.1 : 0.5, { gain: 0.5, slideTo: 22, bus });
   }

   // ribbon / hit-confirmation click (UI bus, not distance-attenuated)
   ribbon(kind = 'pen') {
      if (!this._voice(0.4)) return;
      const bus = this.ui;
      if (kind === 'citadel') {
         this._tone(0, 1318, 0.12, { gain: 0.3, type: 'triangle', bus });
         this._tone(0.07, 1760, 0.2, { gain: 0.3, type: 'triangle', bus });
      } else if (kind === 'kill') {
         this._tone(0, 660, 0.18, { gain: 0.3, type: 'square', bus });
         this._tone(0.09, 880, 0.18, { gain: 0.26, type: 'square', bus });
         this._tone(0.18, 1320, 0.35, { gain: 0.24, type: 'triangle', bus });
      } else if (kind === 'ricochet' || kind === 'shatter') {
         this._tone(0, 900, 0.1, { gain: 0.14, type: 'triangle', slideTo: 500, bus });
      } else {
         this._tone(0, 1480, 0.07, { gain: 0.22, type: 'triangle', bus });
      }
   }

   torpLaunch() {
      if (!this._voice(0.8)) return;
      this._noise(0, 0.25, { freq: 900, sweepTo: 300, gain: 0.35 });
      this._noise(0.08, 0.6, { freq: 400, type: 'bandpass', gain: 0.25 });
      this._tone(0.02, 160, 0.4, { gain: 0.15, slideTo: 70 });
   }

   // sonar-style warning ping (repeated by the caller while the threat persists)
   torpWarning() {
      if (!this._voice(1.4)) return;
      this._tone(0, 1250, 0.9, { gain: 0.16, type: 'sine', slideTo: 1150, bus: this.ui });
      this._tone(0.22, 1250, 0.9, { gain: 0.1, type: 'sine', slideTo: 1150, bus: this.ui });
   }

   spottedAlarm() {
      if (!this._voice(0.6)) return;
      this._tone(0, 740, 0.12, { gain: 0.16, type: 'square', bus: this.ui });
      this._tone(0.16, 740, 0.12, { gain: 0.16, type: 'square', bus: this.ui });
   }

   consumable(key = '') {
      if (!this._voice(1.6)) return;
      this._tone(0, 420, 0.22, { gain: 0.2, type: 'triangle', slideTo: 900, bus: this.ui });
      if (key === 'smoke') this._noise(0.05, 1.5, { freq: 3000, type: 'highpass', gain: 0.18, attack: 0.2 });
      else if (key === 'boost') this._tone(0.05, 60, 1.2, { gain: 0.25, type: 'sawtooth', slideTo: 140, attack: 0.3 });
      else if (key === 'repair' || key === 'damageControl') {
         this._tone(0.1, 520, 0.2, { gain: 0.12, type: 'square' });
         this._tone(0.3, 520, 0.2, { gain: 0.12, type: 'square' });
      } else this._tone(0.08, 1200, 0.5, { gain: 0.12, type: 'sine', slideTo: 1600, bus: this.ui });
   }

   denied() { if (this._voice(0.3)) this._tone(0, 180, 0.14, { gain: 0.14, type: 'square', bus: this.ui }); }
   ammoSwitch() { if (this._voice(0.5)) { this._tone(0, 300, 0.07, { gain: 0.2, type: 'square', bus: this.ui }); this._noise(0.05, 0.2, { freq: 1200, gain: 0.2 }); } }
   bounce() { if (this._voice(0.4)) { this._noise(0, 0.3, { freq: 1400, type: 'highpass', gain: 0.3 }); this._tone(0, 220, 0.15, { gain: 0.12, type: 'triangle', slideTo: 120 }); } }
   fireStart() { if (this._voice(0.9)) this._noise(0, 0.8, { freq: 1800, type: 'bandpass', gain: 0.15 }); }
   siren() { this.spottedAlarm(); }
   sink(dist = 0) {
      if (!this._voice(2.5)) return;
      const { delay, gain, cutoff } = this._dist(dist);
      const bus = this._far(cutoff, Math.max(0.35, gain));
      this._noise(delay, 2.2, { freq: 400, sweepTo: 80, gain: 0.9, buf: this._brown, bus, attack: 0.05 });
      this._tone(delay, 58, 1.8, { gain: 0.5, slideTo: 20, bus });
   }
   uiClick() { if (this._voice(0.2)) this._tone(0, 880, 0.06, { gain: 0.12, type: 'triangle', bus: this.ui }); }
   // mission radio message: squelch burst + two-tone chirp
   radio() {
      if (!this._voice(0.7)) return;
      this._noise(0, 0.12, { freq: 2600, type: 'bandpass', q: 1.5, gain: 0.12, bus: this.ui });
      this._tone(0.1, 1046, 0.09, { gain: 0.1, type: 'square', bus: this.ui });
      this._tone(0.2, 1318, 0.12, { gain: 0.1, type: 'square', bus: this.ui });
   }
}
