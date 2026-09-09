// game/audio.js — procedural Web Audio: cannon booms, splashes, fire, engine hum, siren.
// No assets. Everything is synthesized from noise + oscillators. Starts on first user gesture.
export class Audio {
   constructor() {
      this.ctx = null;
      this.master = null;
      this.engineOsc = null;
      this.engineGain = null;
      this.muted = false;
   }

   // must be called from a user gesture (click on "ABFERTIGEN")
   init() {
      if (this.ctx) return;
      try {
         this.ctx = new (window.AudioContext || window.webkitAudioContext)();
         this.master = this.ctx.createGain();
         this.master.gain.value = 0.55;
         this.master.connect(this.ctx.destination);
         this._noiseBuf = this._makeNoise(2);
         // engine hum: low sawtooth through a lowpass, gain follows throttle
         this.engineOsc = this.ctx.createOscillator();
         this.engineOsc.type = 'sawtooth';
         this.engineOsc.frequency.value = 40;
         const lp = this.ctx.createBiquadFilter();
         lp.type = 'lowpass'; lp.frequency.value = 160;
         this.engineGain = this.ctx.createGain();
         this.engineGain.gain.value = 0;
         this.engineOsc.connect(lp); lp.connect(this.engineGain); this.engineGain.connect(this.master);
         this.engineOsc.start();
      } catch (e) { /* audio unavailable — game runs silent */ }
   }

   _makeNoise(sec) {
      const len = Math.floor(this.ctx.sampleRate * sec);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return buf;
   }

   setMuted(m) {
      this.muted = m;
      if (this.master) this.master.gain.value = m ? 0 : 0.55;
   }

   // continuous: call each frame with player speed/throttle; pass muted=true while paused/ended
   updateEngine(speed, maxSpeed, muted = false) {
      if (!this.ctx) return;
      const k = Math.abs(speed) / (maxSpeed || 18);
      const t = this.ctx.currentTime;
      this.engineOsc.frequency.setTargetAtTime(34 + k * 46, t, 0.1);
      this.engineGain.gain.setTargetAtTime(muted ? 0 : 0.02 + k * 0.075, t, 0.15);
   }

   // browsers suspend the context when the tab was hidden — bring it back on focus
   resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

   _noiseHit(dur, freq, gain, type = 'lowpass') {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuf;
      const f = this.ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(t); src.stop(t + dur + 0.05);
   }

   _tone(freq, dur, gain, type = 'sine', slideTo = null) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + dur + 0.05);
   }

   // ---- one-shots ----
   // count = how many barrels/shells fired in this salvo. A single shot and a full broadside
   // both used to sound identical -- layering a few slightly-staggered extra booms (and a
   // louder first hit) sells "many guns firing at once" without needing per-shot audio nodes.
   cannon(big = false, count = 1) {
      const weight = 0.7 + 0.3 * Math.min(count, 4);
      this._noiseHit(big ? 0.9 : 0.5, big ? 300 : 500, (big ? 0.8 : 0.45) * weight);
      this._tone(big ? 55 : 70, big ? 0.7 : 0.4, (big ? 0.5 : 0.3) * weight, 'sine', 30);
      for (let i = 1; i < Math.min(count, 4); i++) {
         const delay = i * 35 + Math.random() * 25;
         setTimeout(() => this._noiseHit(big ? 0.7 : 0.35, (big ? 300 : 500) * (0.9 + Math.random() * 0.2), big ? 0.55 : 0.3), delay);
      }
   }
   splash() { this._noiseHit(0.45, 900, 0.22, 'bandpass'); }
   bounce() { this._noiseHit(0.3, 1400, 0.3, 'highpass'); this._tone(220, 0.15, 0.12, 'triangle', 120); }
   explosion(big = false) {
      this._noiseHit(big ? 1.4 : 0.7, 220, big ? 1.0 : 0.55);
      this._tone(45, big ? 1.0 : 0.5, 0.5, 'sine', 24);
   }
   hit() { this._noiseHit(0.35, 700, 0.4); this._tone(110, 0.25, 0.25, 'square', 60); }
   fireStart() { this._noiseHit(0.8, 1800, 0.15, 'bandpass'); }
   torpLaunch() { this._noiseHit(0.6, 500, 0.3, 'lowpass'); this._tone(180, 0.5, 0.15, 'sine', 90); }
   siren() { this._tone(660, 0.5, 0.12, 'sine', 880); setTimeout(() => this._tone(880, 0.5, 0.12, 'sine', 660), 480); }
   sink() {
      this._noiseHit(2.2, 160, 0.9);
      this._tone(60, 1.8, 0.5, 'sine', 20);
   }
   uiClick() { this._tone(880, 0.06, 0.1, 'triangle'); }
}
