// game3d/audio.js — sound of the 3D mode. No assets: every sound is synthesised offline by
// audiosynth.js into an AudioBuffer (once, cached) and played through a small mixing desk:
//
//   one-shots -> channel (low-pass, gain, stereo pan, reverb send) -> world bus --+
//   sea / wind / rain / engine / bow wash / fire loops ------------> world bus --+-> under-water
//   convolution reverb (synthesised open-sea impulse response) -----------------+   low-pass
//        -> bus compressor -> fx volume --+
//   interface + own-boat sounds ----------+-> master -> limiter -> soft clip -> speakers
//   music (drone, brass pad, timpani) ----+
//
// Voices: a fixed pool of channels (MAX_VOICES) with priorities; a salvo is ONE channel fed by
// several staggered barrel buffers, so 16 ships firing need 16 channels. Buffer sources are capped
// too (MAX_SOURCES). Nothing is allocated per frame: the per-frame update* calls only move
// AudioParams, and only when the target changed.
//
// The AudioContext is created/resumed on the first user gesture (autoplay rules); before that
// every call is a silent no-op. init(ctx) also accepts an OfflineAudioContext (tests).
//
// Distance cues: other ships' guns/splashes are delayed by a TIME-COMPRESSED speed of sound
// (d / 1500 m/s, capped), muffled by a distance low-pass, sent deeper into the reverb, and guns
// cross-fade from the close "crack + thump" buffers to a soft rolling "far boom".
import { render, impulse, SOUND_NAMES, GUN_CLASSES } from './audiosynth.js';

const SOUND_SPEED = 1500;   // m/s -- compressed like the sim's ship speeds, real 343 feels laggy
const WORLD_VOICES = 32, DIRECT_VOICES = 8;
export const MAX_VOICES = WORLD_VOICES + DIRECT_VOICES;
export const MAX_SOURCES = 110;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const FAR_OF = [0, 0, 1, 2, 2], FAR_RATE = [1.15, 1, 1, 1.1, 0.92];

// music: D minor, low register. [drone, voice1, voice2, voice3, timpani rate]
const CHORDS = [
   [36.71, 73.42, 110.0, 174.61, 1],        // Dm
   [29.14, 58.27, 116.54, 146.83, 0.794],   // Bb
   [49.0, 98.0, 116.54, 146.83, 0.667],     // Gm
   [27.5, 82.41, 110.0, 164.81, 0.749],     // A (open fifth)
   [36.71, 73.42, 110.0, 174.61, 1],        // Dm
   [49.0, 98.0, 116.54, 146.83, 0.667],     // Gm
   [29.14, 58.27, 116.54, 174.61, 0.794],   // Bb
   [27.5, 82.41, 110.0, 138.59, 0.749],     // A (major third: dominant tension)
];
// timpani gain per eighth note over two bars, per music level (0 calm .. 3 low HP)
const TIMP = [
   null,
   [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0],
   [0.8, 0, 0, 0, 0, 0, 0.4, 0, 0.6, 0, 0, 0, 0.35, 0, 0.4, 0],
   [0.8, 0.45, 0, 0, 0.7, 0.4, 0, 0, 0.8, 0.45, 0, 0, 0.7, 0.4, 0, 0.3],
];
const CELLO = [1, 1, 1.5, 1, 1, 1, 1.189, 1];   // ostinato: root root fifth root root root m3 root
const BPM = [0, 50, 60, 72];
const PAD_GAIN = [0.075, 0.095, 0.11, 0.115], PAD_CUT = [380, 520, 760, 680], CHORD_SEC = [14, 12, 8, 6.67];

export class Audio {
   constructor() {
      this.ctx = null;
      this.muted = false;
      this.volume = 0.8;
      this.musicVol = 0.5;       // settings: music bus 0..1
      this.sfxVol = 1;           // settings: effects bus (guns, alerts, sea, engine) 0..1
      this._bufs = new Map();
      this._loops = new Map();
      this._last = new Map();
      this._srcN = 0; this._srcPeak = 0; this._dropped = 0; this._stolen = 0; this._played = 0;
      this._lx = 0; this._ly = 0; this._yaw = 0; this._hasL = false;
      this._sub = false;
      this._d = { delay: 0, gain: 1, cutoff: 20000, send: 0.3 };
      this._mLevel = -2; this._nextStep = 0; this._step = 0; this._chord = 0; this._nextChord = 0;
      this._thunderT = 0; this._splT = -1; this._splN = 0;
      this._onEnd = () => { this._srcN--; };
   }

   // Call from any user gesture; safe to call repeatedly. ctx: optional (Offline)AudioContext.
   init(ctx = null) {
      if (this.ctx) { this.resume(); return; }
      try {
         if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            ctx = new AC({ latencyHint: 'interactive' });
            this._live = true;
         }
         this.ctx = ctx;
         this._build(ctx);
         if (this._live) this._prewarm();
      } catch (e) { this.ctx = null; /* audio unavailable -- game runs silent */ }
   }

   _build(ctx) {
      // output stage: master volume -> brick-wall-ish limiter -> soft clip (never reaches 0 dBFS)
      const clip = ctx.createWaveShaper(), n = 4097, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
         const x = ((i / (n - 1)) * 2 - 1) * 2, a = Math.abs(x);
         curve[i] = a < 0.6 ? x : Math.sign(x) * (0.6 + 0.38 * Math.tanh((a - 0.6) / 0.38));
      }
      clip.curve = curve;
      this.out = clip;           // last node before the speakers (tests tap it)
      const pre = ctx.createGain(); pre.gain.value = 0.5;
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -3; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002; this.limiter.release.value = 0.12;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.limiter); this.limiter.connect(pre); pre.connect(clip); clip.connect(ctx.destination);
      // effects and music get their own volume buses (pause-menu sliders)
      this.fxOut = ctx.createGain(); this.fxOut.gain.value = this.sfxVol; this.fxOut.connect(this.master);
      this.music = ctx.createGain(); this.music.gain.value = this.musicVol; this.music.connect(this.master);
      // bus compressor: slow enough to let the crack of a gun through, then it clamps down and
      // ducks sea and engine for a moment -- that is what makes a salvo feel heavy
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -20; this.comp.knee.value = 8; this.comp.ratio.value = 3.5;
      this.comp.attack.value = 0.012; this.comp.release.value = 0.32;
      this.comp.connect(this.fxOut);
      // everything outside the hull passes this filter: wide open on the surface, shut under water
      this.worldLP = ctx.createBiquadFilter(); this.worldLP.type = 'lowpass'; this.worldLP.frequency.value = 20000; this.worldLP.Q.value = 0.5;
      this.worldG = ctx.createGain(); this.worldG.gain.value = 1;
      this.worldLP.connect(this.worldG); this.worldG.connect(this.comp);
      this.sfx = ctx.createGain(); this.sfx.gain.value = 1; this.sfx.connect(this.worldLP);
      this.amb = ctx.createGain(); this.amb.gain.value = 0; this.amb.connect(this.worldLP);
      this.ui = ctx.createGain(); this.ui.gain.value = 0.6; this.ui.connect(this.fxOut);
      // open-sea reverb
      const ir = impulse(ctx.sampleRate), irBuf = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
      irBuf.copyToChannel(ir[0], 0); irBuf.copyToChannel(ir[1], 1);
      this.reverb = ctx.createConvolver(); this.reverb.buffer = irBuf;
      this.revIn = ctx.createGain(); this.revIn.gain.value = 1;
      this.revOut = ctx.createGain(); this.revOut.gain.value = 1.6;
      this.revIn.connect(this.reverb); this.reverb.connect(this.revOut); this.revOut.connect(this.worldLP);
      // voice channels
      this._world = []; this._direct = [];
      for (let i = 0; i < WORLD_VOICES; i++) this._world.push(this._mkChan(this.sfx));
      for (let i = 0; i < DIRECT_VOICES; i++) this._direct.push(this._mkChan(this.ui));
      this._buildMusic();
      if (this._sub) this._applySub(0);
   }

   _mkChan(out) {
      const ctx = this.ctx;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 20000; lp.Q.value = 0.6;
      const g = ctx.createGain(), pan = ctx.createStereoPanner(), send = ctx.createGain();
      send.gain.value = 0;
      lp.connect(g); g.connect(pan); pan.connect(out); g.connect(send); send.connect(this.revIn);
      return { lp, g, pan, send, end: 0, prio: 0, srcs: [] };
   }

   resume() { if (this.ctx && this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume().catch(() => {}); }

   setMuted(m) {
      this.muted = m;
      if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
   }

   setVolumes(music, sfx) {
      this.musicVol = Math.max(0, Math.min(1, music));
      this.sfxVol = Math.max(0, Math.min(1, sfx));
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      this.music.gain.setTargetAtTime(this.musicVol, t, 0.05);
      this.fxOut.gain.setTargetAtTime(this.sfxVol, t, 0.05);
   }

   // Listener for stereo panning: position (sim metres) and camera yaw (sim angle of the view direction).
   setListener(x, y, yaw) { this._lx = x; this._ly = y; this._yaw = yaw; this._hasL = true; }

   // voices in use / diagnostics (tests, perf overlay)
   stats() {
      let v = 0;
      if (this.ctx) { const t = this.ctx.currentTime; for (const c of this._world) if (c.end > t) v++; for (const c of this._direct) if (c.end > t) v++; }
      return { voices: v, maxVoices: MAX_VOICES, sources: this._srcN, peakSources: this._srcPeak, maxSources: MAX_SOURCES,
         dropped: this._dropped, stolen: this._stolen, played: this._played, buffers: this._bufs.size, state: this.ctx?.state ?? 'none' };
   }

   // ---- buffers ----
   _buf(name) {
      let b = this._bufs.get(name);
      if (b) return b;
      const r = render(name, this.ctx.sampleRate);
      if (!r) return null;
      b = this.ctx.createBuffer(r.ch.length, r.ch[0].length, r.sr);
      for (let c = 0; c < r.ch.length; c++) b.copyToChannel(r.ch[c], c);
      this._bufs.set(name, b);
      return b;
   }
   // Render the whole library in small slices after the first gesture, so no buffer has to be
   // synthesised in the middle of a battle.
   _prewarm() {
      const first = ['uiClick', 'loopSea', 'loopWind', 'loopEngine', 'loopWash', 'timpani'];
      const todo = first.concat(SOUND_NAMES.filter(n => !first.includes(n)));
      const step = () => {
         if (!this.ctx) return;
         const t0 = performance.now();
         while (todo.length && performance.now() - t0 < 6) { try { this._buf(todo.shift()); } catch (e) { /* skip */ } }
         if (todo.length) setTimeout(step, 24);
      };
      setTimeout(step, 60);
   }

   // ---- voices ----
   _take(pool, prio, dur) {
      const now = this.ctx.currentTime;
      let best = null;
      for (const c of pool) if (c.end <= now) { best = c; break; }
      if (!best) {
         for (const c of pool) if (c.prio < prio && (!best || c.prio < best.prio || (c.prio === best.prio && c.end < best.end))) best = c;
         if (!best) { this._dropped++; return null; }
         this._stolen++;
         for (const s of best.srcs) { try { s.stop(); } catch (e) { /* already stopped */ } }
      }
      best.prio = prio; best.end = now + dur; best.srcs.length = 0;
      this._played++;
      return best;
   }
   _cfg(ch, gain, cutoff = 20000, pan = 0, send = 0) {
      const t = this.ctx.currentTime;
      ch.g.gain.cancelScheduledValues(t); ch.g.gain.setValueAtTime(gain, t);
      ch.lp.frequency.cancelScheduledValues(t); ch.lp.frequency.setValueAtTime(cutoff, t);
      ch.pan.pan.cancelScheduledValues(t); ch.pan.pan.setValueAtTime(pan, t);
      ch.send.gain.cancelScheduledValues(t); ch.send.gain.setValueAtTime(send, t);
   }
   _src(ch, name, when = 0, gain = 1, rate = 1) {
      if (this._srcN >= MAX_SOURCES) return;
      const buf = this._buf(name);
      if (!buf) return;
      const ctx = this.ctx, s = ctx.createBufferSource();
      s.buffer = buf; s.playbackRate.value = rate;
      if (gain !== 1) { const g = ctx.createGain(); g.gain.value = gain; s.connect(g); g.connect(ch.lp); } else s.connect(ch.lp);
      s.onended = this._onEnd;
      this._srcN++; if (this._srcN > this._srcPeak) this._srcPeak = this._srcN;
      ch.srcs.push(s);
      s.start(ctx.currentTime + when);
   }
   _len(name, rate = 1) { const b = this._buf(name); return b ? b.duration / rate : 0; }
   // simple one-shot: one buffer on one channel
   _one(pool, prio, name, gain, { cutoff = 20000, pan = 0, send = 0, when = 0, rate = 1 } = {}) {
      if (!this.ctx) return null;
      const ch = this._take(pool, prio, when + this._len(name, rate) + 0.1);
      if (!ch) return null;
      this._cfg(ch, gain, cutoff, pan, send);
      this._src(ch, name, when, 1, rate);
      return ch;
   }
   _uiPlay(name, gain = 0.5, rate = 1, prio = 5) { return this._one(this._direct, prio, name, gain, { rate }); }

   // distance model -> shared scratch object (no allocation)
   _dist(d) {
      d = Math.max(0, d || 0);
      const o = this._d;
      o.delay = Math.min(3, d / SOUND_SPEED);
      o.gain = 1 / (1 + d / 2500);
      o.cutoff = Math.max(280, 14000 / (1 + d / 800));
      o.send = Math.min(0.75, 0.3 + d / 20000);
      return o;
   }
   // stereo position from the bearing relative to the camera; close sources stay near the centre
   _pan(pos) {
      if (!pos || !this._hasL) return 0;
      const dx = pos.x - this._lx, dy = pos.y - this._ly, d = Math.hypot(dx, dy);
      if (d < 1) return 0;
      return clamp(Math.sin(Math.atan2(dy, dx) - this._yaw), -1, 1) * 0.85 * Math.min(1, d / 400);
   }
   _rnd(a, b) { return a + Math.random() * (b - a); }

   // ---- guns ----
   // Main battery report. caliber in mm, count = barrels in this salvo, dist = metres from the
   // listener (0 = own guns: full punch, no delay), pos = optional {x, y} of the firing ship.
   mainGun(caliber = 380, count = 1, dist = 0, pos = null) {
      if (!this.ctx) return;
      const gi = caliber < 140 ? 0 : caliber < 180 ? 1 : caliber < 250 ? 2 : caliber < 345 ? 3 : 4;
      const cls = GUN_CLASSES[gi], h = cls.h, own = dist <= 0;
      const rate = clamp(Math.sqrt(cls.cal / caliber), 0.86, 1.14);
      const D = this._dist(dist), delay = D.delay;
      const nearW = own ? 1 : 1 / (1 + (dist / 2200) ** 2), farW = 1 - nearW;
      const tailName = 'tail' + gi, farName = 'far' + FAR_OF[gi] + (Math.random() < 0.5 ? 'a' : 'b');
      const dur = delay + Math.max(this._len(tailName), farW > 0.05 ? this._len(farName) : 0) + 0.3;
      const ch = this._take(this._world, own ? 9 : h > 0.5 ? 5 : 4, dur);
      if (!ch) return;
      const salvo = 0.8 + 0.2 * Math.min(count, 9) / 3;
      this._cfg(ch, D.gain * (0.5 + 0.5 * h) * (own ? 1 : 0.95), own ? 20000 : D.cutoff, own ? 0 : this._pan(pos), own ? 0.1 + 0.26 * h : D.send * (0.6 + 0.4 * h));
      // barrels ripple: turret after turret, a few hundredths apart
      const nb = own ? Math.min(count, 6) : nearW > 0.08 ? Math.min(count, 3) : 0;
      let at = delay;
      for (let i = 0; i < nb; i++) {
         this._src(ch, 'gun' + gi + ((i + (Math.random() < 0.5 ? 1 : 0)) & 1 ? 'b' : 'a'), at, nearW * (i ? 0.52 : 0.8), rate * this._rnd(0.95, 1.05));
         at += 0.03 + 0.03 * h + Math.random() * 0.035;
      }
      if (nearW > 0.05) this._src(ch, tailName, delay + 0.02, nearW * (0.34 + 0.3 * h) * salvo, rate * this._rnd(0.95, 1.05));
      if (farW > 0.05) this._src(ch, farName, delay, farW * 1.15 * salvo, rate * FAR_RATE[gi] * this._rnd(0.94, 1.06));
   }
   // legacy name used by older call sites
   cannon(big = false, count = 1) { this.mainGun(big ? 380 : 150, count, 0); }

   secondary(dist = 0, pos = null) {
      if (!this.ctx) return;
      const D = this._dist(dist), far = dist > 2500;
      const ch = this._take(this._world, 2, D.delay + (far ? 3.2 : 1.0));
      if (!ch) return;
      this._cfg(ch, D.gain * 0.42, dist > 0 ? D.cutoff : 20000, this._pan(pos), D.send * 0.8);
      if (far) this._src(ch, 'far0a', D.delay, 0.8, this._rnd(1.25, 1.45));
      else this._src(ch, Math.random() < 0.5 ? 'gun0a' : 'gun0b', D.delay, 1, this._rnd(1.1, 1.22));
   }

   // incoming shell passing close overhead
   whistle(when = 0) { this._one(this._world, 3, 'whistle', 0.3, { when, pan: this._rnd(-0.6, 0.6), send: 0.25, rate: this._rnd(0.92, 1.1) }); }

   // ---- impacts ----
   splash(dist = 0, big = false, pos = null) {
      if (!this.ctx) return;
      // a salvo lands as one sheet of water: at most four splash voices per 80 ms
      const now = this.ctx.currentTime;
      if (now - this._splT > 0.08) { this._splT = now; this._splN = 0; }
      if (++this._splN > 4) return;
      const D = this._dist(dist);
      this._one(this._world, big ? 2 : 1, (big ? 'splashBig' : 'splash') + (Math.random() < 0.5 ? 'A' : 'B'), D.gain * (big ? 0.75 : 0.5),
         { cutoff: D.cutoff, pan: this._pan(pos), send: D.send, when: D.delay, rate: this._rnd(0.92, 1.08) });
   }

   // A hit somewhere in the world. kind: 'pen' 'citadel' 'overpen' 'ricochet' 'shatter' 'he' 'sec'
   // 'explosion' 'terrain' 'torpHit' 'detonation' 'torpLaunch'. big = heavy calibre.
   impact(kind, dist = 0, pos = null, big = false) {
      if (!this.ctx) return;
      let name, gain = 0.7, prio = 3, rate = this._rnd(0.95, 1.05);
      switch (kind) {
         case 'pen': name = 'pen'; if (big) rate *= 0.88; break;
         case 'citadel': name = 'citadel'; gain = 0.95; prio = 5; break;
         case 'overpen': name = 'overpen'; gain = 0.6; prio = 2; break;
         case 'ricochet': case 'bounce': name = Math.random() < 0.5 ? 'ricochetA' : 'ricochetB'; gain = 0.6; prio = 2; rate = this._rnd(0.85, 1.15) * (big ? 0.8 : 1); break;
         case 'shatter': name = 'shatter'; gain = 0.55; prio = 2; break;
         case 'he': name = 'he'; if (big) rate *= 0.85; break;
         case 'sec': name = 'he'; gain = 0.4; prio = 1; rate *= 1.25; break;
         case 'terrain': name = 'terrain'; gain = 0.6; prio = 1; break;
         case 'torpHit': case 'torp': name = 'torpHit'; gain = 1; prio = 7; break;
         case 'detonation': name = 'detonation'; gain = 1.1; prio = 8; break;
         case 'torpLaunch': if (dist > 2500) return; name = 'torpLaunch'; gain = 0.5; prio = 1; break;
         default: name = big ? 'explosionBig' : 'he'; gain = big ? 0.85 : 0.6; prio = big ? 4 : 2;
      }
      const D = this._dist(dist), loud = kind === 'detonation' ? Math.max(0.3, D.gain) : D.gain;
      this._one(this._world, prio, name, loud * gain, { cutoff: D.cutoff, pan: this._pan(pos), send: D.send, when: D.delay, rate });
   }
   explosion(big = false, dist = 0, pos = null) { this.impact('explosion', dist, pos, big); }
   bounce() { this.hit(false, 'ricochet'); }

   // own ship takes a hit, heard from inside the hull. type: the event type ('pen', 'torp', ...).
   hit(big = false, type = '') {
      if (!this.ctx) return;
      const pan = this._rnd(-0.35, 0.35);
      if (type === 'ricochet' || type === 'shatter') {
         this._one(this._world, 6, type === 'shatter' ? 'shatter' : 'ricochetA', 0.75, { pan, send: 0.25, rate: this._rnd(0.75, 0.9) });
         this._one(this._world, 5, 'hit', 0.35, { pan, send: 0.2, cutoff: 2500 });
         return;
      }
      if (type === 'overpen') { this._one(this._world, 6, 'overpen', 0.8, { pan, send: 0.2, rate: 0.85 }); this._one(this._world, 5, 'hit', 0.4, { pan, send: 0.2 }); return; }
      if (type === 'torp') this._one(this._world, 9, 'torpHit', 1, { pan, send: 0.35 });
      if (type === 'citadel') this._one(this._world, 8, 'citadel', 0.8, { pan, send: 0.3, rate: 0.92 });
      this._one(this._world, 8, big ? 'hitBig' : 'hit', big ? 1 : 0.8, { pan, send: 0.25, rate: this._rnd(0.94, 1.06) });
   }
   fireStart() { this._one(this._world, 4, 'fireStart', 0.5, { send: 0.2 }); }

   sink(dist = 0, pos = null) {
      if (!this.ctx) return;
      const D = this._dist(dist);
      this._one(this._world, 6, 'sink', Math.max(0.3, D.gain) * 0.9, { cutoff: Math.max(900, D.cutoff), pan: this._pan(pos), send: D.send, when: D.delay });
   }

   // ---- modern mode: missiles and their defences ----
   // A missile leaves its launcher. kind: 'ssm' | 'cruise' | 'sam' | 'aam' | 'rocket'; own = fired by the player.
   missileLaunch(kind = 'ssm', dist = 0, pos = null, own = false) {
      if (!this.ctx || dist > 14000) return;
      const D = this._dist(dist);
      const rate = (kind === 'sam' || kind === 'aam' ? 1.3 : kind === 'rocket' ? 1.55 : kind === 'cruise' ? 0.86 : 1) * this._rnd(0.95, 1.05);
      this._one(this._world, own ? 6 : 3, 'mslLaunch', D.gain * (own ? 0.8 : 0.6) * (kind === 'rocket' ? 0.6 : 1),
         { cutoff: D.cutoff, pan: this._pan(pos), send: D.send, when: D.delay, rate });
   }
   // close-in gun burst (the caller repeats it while the gun fires)
   ciws(dist = 0, pos = null) {
      if (!this.ctx || dist > 9000) return;
      const D = this._dist(dist);
      this._one(this._world, 4, 'ciws', D.gain * 0.5, { cutoff: D.cutoff, pan: this._pan(pos), send: D.send, when: D.delay, rate: this._rnd(0.97, 1.04) });
   }
   // a missile is shot down / a warhead goes off
   intercept(dist = 0, pos = null) {
      if (!this.ctx) return;
      const D = this._dist(dist);
      this._one(this._world, 3, 'he', D.gain * 0.6, { cutoff: D.cutoff, pan: this._pan(pos), send: D.send, when: D.delay, rate: this._rnd(1.25, 1.45) });
   }
   missileHit(dist = 0, pos = null, heavy = false) {
      if (!this.ctx) return;
      const D = this._dist(dist);
      this._one(this._world, 6, 'explosionBig', Math.max(0.12, D.gain), { cutoff: D.cutoff, pan: this._pan(pos), send: D.send, when: D.delay, rate: this._rnd(0.8, 0.9) * (heavy ? 0.85 : 1) });
   }
   decoys(dist = 0, pos = null) {
      if (!this.ctx || dist > 6000) return;
      const D = this._dist(dist);
      this._one(this._world, 4, 'decoyPop', D.gain * 0.7, { cutoff: D.cutoff, pan: this._pan(pos), send: D.send, when: D.delay });
   }
   // "Vampire": a missile is tracked coming in (repeated by the caller while it closes)
   vampire(urgent = false) { this._uiPlay('vampire', urgent ? 0.5 : 0.36, urgent ? 1.12 : 1, 8); }

   // ---- torpedoes ----
   // own launch: compressed air out of the tube, then the fish hits the water; n tubes ripple
   torpLaunch(n = 1) {
      if (!this.ctx) return;
      n = Math.max(1, Math.min(4, n | 0));
      const ch = this._take(this._world, 6, n * 0.22 + 2);
      if (!ch) return;
      this._cfg(ch, 0.7, 20000, 0, 0.25);
      for (let i = 0; i < n; i++) this._src(ch, 'torpLaunch', i * 0.22, i ? 0.7 : 1, this._rnd(0.94, 1.06));
   }

   // ---- bridge: interface, warnings, cues (direct bus, not distance-attenuated) ----
   uiClick() { this._uiPlay('uiClick', 0.4, this._rnd(0.96, 1.04), 1); }
   lock(on = true) { this._uiPlay('uiLock', 0.42, on ? 1 : 0.8, 2); }
   denied() { this._uiPlay('uiDenied', 0.5, 1, 2); }
   ammoSwitch() { this._uiPlay('uiAmmo', 0.5, 1, 2); }
   // muffled breech clank from the turrets: main battery loaded
   reloaded() { this._one(this._world, 2, 'reload', 0.3, { send: 0.15, rate: this._rnd(0.94, 1.06) }); }
   // ribbon / hit confirmation: restrained ticks, the hit itself is heard in the world
   ribbon(kind = 'pen') {
      if (kind === 'citadel') this._uiPlay('ribbonCitadel', 0.5, 1, 3);
      else if (kind === 'kill') this._uiPlay('ribbonKill', 0.6, 1, 6);
      else if (kind === 'torp') this._uiPlay('ribbonCitadel', 0.5, 0.8, 3);
      else if (kind === 'ricochet' || kind === 'shatter') this._uiPlay('ribbonRic', 0.3, kind === 'shatter' ? 0.8 : 1, 1);
      else if (kind === 'pen' || kind === 'he') this._uiPlay('ribbonPen', 0.38, 1, 2);
      else this._uiPlay('ribbonPen', 0.3, kind === 'overpen' ? 1.3 : 0.8, 1);
   }
   // repeated by the caller while torpedoes are inbound: two soft strokes of the alarm gong
   torpWarning() { this._uiPlay('torpPing', 0.4, 1, 5); }
   spottedAlarm() { this._uiPlay('alertSpotted', 0.5, 1, 5); }
   siren() { this.spottedAlarm(); }
   consumable(key = '') {
      const name = key === 'smoke' ? 'consSmoke' : key === 'boost' || key === 'speedBoost' ? 'consBoost' : key === 'repair' || key === 'damageControl' ? 'consRepair'
         : key === 'hydro' ? 'consHydro' : key === 'radar' ? 'consRadar' : 'uiLock';
      this._uiPlay(name, 0.5, 1, 4);
   }
   // mission radio message: squelch and key clicks
   radio() { this._uiPlay('radio', 0.42, 1, 3); }
   // objective update. kind: 'done' | 'failed' | 'new'
   objective(kind = 'new') { this._uiPlay(kind === 'done' ? 'objDone' : kind === 'failed' ? 'objFailed' : 'objNew', 0.5, 1, 6); }
   // end of battle: slow brass and timpani
   endCue(victory) { this._uiPlay(victory ? 'victory' : 'defeat', 0.75, 1, 9); }

   // warnings (HUD shows the German text). Ship's alarm gong, fire bell, reed horn -- no beeps.
   alert(kind) {
      switch (kind) {
         case 'torp': this._uiPlay('alertTorp', 0.55, 1, 8); break;      // "Torpedos voraus!": general alarm gong
         case 'fire': this._uiPlay('alertFire', 0.4, 1, 6); break;       // "Feuer an Bord!": rapid fire bell
         case 'flood': this._uiPlay('alertFlood', 0.5, 1, 6); break;     // "Wassereinbruch!": two horn blasts over gurgling water
         case 'citadel': this._uiPlay('alertCitadel', 0.42, 1, 6); break; // "Zitadelle getroffen!": damage-control buzzer
         case 'kill': break;                                              // the kill ribbon already plays the cue
         case 'storm': this._thunder(0.8); break;                         // front rolling in
         default: this._uiPlay('uiLock', 0.4, 1, 3);
      }
   }
   _thunder(gain) { this._one(this._world, 3, 'thunder', gain, { pan: this._rnd(-0.7, 0.7), send: 0.6, rate: this._rnd(0.8, 1.1) }); }

   // ---- submarine (called by the submarine gameplay code, each safe at any time) ----
   // dive klaxon (two "ahooga" blasts), then the ballast tanks vent
   subDive() {
      if (!this.ctx) return;
      this._uiPlay('klaxon', 0.5, 1, 8);
      this._one(this._direct, 7, 'ballast', 0.55, { when: 2.0 });
   }
   // tanks blown with high-pressure air, then the hull breaks the surface
   subSurface() { this._uiPlay('surfacing', 0.6, 1, 8); }
   // active sonar ping with a long watery echo; dist in metres to the pinging ship (0 = own)
   sonarPing(dist = 0) {
      if (!this.ctx) return;
      const d = Math.max(0, Number(dist) || 0);
      this._one(this._direct, 6, 'sonar', 0.5 / (1 + d / 2500), { when: Math.min(3, d / SOUND_SPEED), cutoff: Math.max(900, 16000 / (1 + d / 1500)), send: 0.3 });
   }
   // deep under-water explosion; dist in metres
   depthCharge(dist = 0) {
      if (!this.ctx) return;
      const d = Math.max(0, Number(dist) || 0);
      this._one(this._direct, 8, 'depthCharge', 1.1 / (1 + d / 1500), { when: Math.min(3, d / SOUND_SPEED), cutoff: Math.max(180, 900 / (1 + d / 1500)), send: 0.45,
         rate: this._rnd(0.92, 1.05) });
   }
   // while true the mix is heard from inside a submerged boat
   setSubmerged(on) {
      on = !!on;
      if (on === this._sub) return;
      this._sub = on;
      if (this.ctx) this._applySub(0.35);
   }
   _applySub(tc) {
      const t = this.ctx.currentTime, on = this._sub;
      if (tc > 0) {
         this.worldLP.frequency.setTargetAtTime(on ? 380 : 20000, t, tc);
         this.worldG.gain.setTargetAtTime(on ? 0.75 : 1, t, tc);
      } else { this.worldLP.frequency.value = on ? 380 : 20000; this.worldG.gain.value = on ? 0.75 : 1; }
      this._loopSet('loopSub', this.ui, on ? 0.28 : 0, 0.5, 1);
   }

   // ---- continuous layers ----
   // A looping buffer behind a gain; created on first use, then only its params move.
   _loopSet(name, dest, gain, tc, rate) {
      let l = this._loops.get(name);
      if (!l) {
         if (gain <= 0) return;
         const ctx = this.ctx, buf = this._buf(name);
         if (!buf) return;
         const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
         const g = ctx.createGain(); g.gain.value = 0;
         src.connect(g); g.connect(dest); src.start(ctx.currentTime, Math.random() * buf.duration * 0.8);
         l = { src, g, gain: -1, rate: 1 };
         this._loops.set(name, l);
      }
      if (Math.abs(l.gain - gain) > 0.002) { l.gain = gain; l.g.gain.setTargetAtTime(gain, this.ctx.currentTime, tc); }
      if (Math.abs(l.rate - rate) > 0.004) { l.rate = rate; l.src.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, 0.4); }
   }

   // Per frame: turbine hum and bow wash follow speed and throttle. muted = paused/menu.
   // throttle: optional commanded power 0..1 (the machinery spools up before the ship gathers way).
   updateEngine(speed, maxSpeed, muted = false, throttle = null) {
      if (!this.ctx) return;
      const k = Math.min(1.2, Math.abs(speed) / (maxSpeed || 18));
      const thr = throttle == null ? k : Math.min(1, Math.abs(throttle));
      const load = 0.6 * k + 0.4 * thr;
      this._loopSet('loopEngine', this.sfx, muted ? 0 : 0.075 + 0.13 * load, 0.3, 0.74 + 0.5 * load);
      this._loopSet('loopWash', this.amb, muted ? 0 : 0.2 * Math.pow(Math.min(1, k), 1.5), 0.5, 0.9 + 0.2 * k);
   }
   // Per frame: sea, wind and rain follow sea state and weather; fires = burning fires on the
   // player's ship (crackle).
   updateAmbient(seaState = 0.4, muted = false, weather = 'clear', fires = 0) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime, target = muted ? 0.15 : 1;
      if (this._ambT !== target) { this._ambT = target; this.amb.gain.setTargetAtTime(target, t, 0.6); }
      const storm = weather === 'storm', rain = weather === 'rain';
      this._loopSet('loopSea', this.amb, 0.13 + seaState * 0.24, 1, 0.9 + seaState * 0.25);
      this._loopSet('loopWind', this.amb, storm ? 0.3 : rain ? 0.16 : weather === 'overcast' ? 0.09 : 0.045 + seaState * 0.07, 1.5, storm ? 1.3 : rain ? 1.1 : 1);
      this._loopSet('loopRain', this.amb, storm ? 0.2 : rain ? 0.13 : 0, 1.5, 1);
      this._loopSet('loopFire', this.amb, muted ? 0 : Math.min(1, (fires || 0) / 2) * 0.38, 0.4, 1);
      if (storm && !muted) {
         if (this._thunderT <= 0) this._thunderT = t + 6 + Math.random() * 14;
         else if (t >= this._thunderT) { this._thunderT = t + 14 + Math.random() * 28; this._thunder(this._rnd(0.35, 0.7)); }
      }
   }

   // ---- dynamic music: dark and slow. A low drone, a brass-like pad that moves through a
   // D-minor progression, timpani and a low string ostinato when the fight heats up. ----
   _buildMusic() {
      const ctx = this.ctx;
      this._padF = ctx.createBiquadFilter(); this._padF.type = 'lowpass'; this._padF.frequency.value = 280; this._padF.Q.value = 0.9;
      this._padG = ctx.createGain(); this._padG.gain.value = 0;
      // the swell LFO modulates its own gain stage, so the pad is truly silent when _padG is 0
      this._swell = ctx.createGain(); this._swell.gain.value = 1;
      this._padF.connect(this._swell); this._swell.connect(this._padG); this._padG.connect(this.music);
      const c = CHORDS[0];
      this._mOsc = [];   // [osc, chord index, frequency factor]
      const add = (type, idx, mult, gain, det) => {
         const o = ctx.createOscillator(); o.type = type; o.frequency.value = c[idx] * mult; o.detune.value = det;
         const g = ctx.createGain(); g.gain.value = gain;
         o.connect(g); g.connect(this._padF); o.start();
         this._mOsc.push([o, idx, mult]);
      };
      add('sine', 0, 1, 0.3, 0); add('triangle', 0, 2, 0.2, 3);
      for (let v = 1; v <= 3; v++) { add('sawtooth', v, 1, 0.3 - v * 0.04, -6); add('sawtooth', v, 1, 0.3 - v * 0.04, 6); }
      // tension: a minor second grinding against the fifth, only at low HP
      const tense = ctx.createOscillator(); tense.type = 'sawtooth'; tense.frequency.value = 116.54;
      this._tenseG = ctx.createGain(); this._tenseG.gain.value = 0;
      tense.connect(this._tenseG); this._tenseG.connect(this._padF); tense.start();
      // slow swell: the pad breathes like long brass notes
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06;
      const lfoF = ctx.createGain(); lfoF.gain.value = 110;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.3;
      lfo.connect(lfoF); lfoF.connect(this._padF.frequency); lfo.connect(lfoG); lfoG.connect(this._swell.gain); lfo.start();
   }
   _mHit(name, when, gain, rate) {
      if (this._srcN >= MAX_SOURCES) return;
      const ctx = this.ctx, buf = this._buf(name);
      if (!buf) return;
      const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
      const g = ctx.createGain(); g.gain.value = gain;
      s.connect(g); g.connect(this.music);
      s.onended = this._onEnd; this._srcN++;
      s.start(when);
   }

   // level: -1 off (menu/pause), 0 calm, 1 enemies spotted, 2 heavy fire, 3 low HP.
   // Gains/filters only move on a level change; chords and hits are scheduled ~200 ms ahead.
   updateMusic(level) {
      if (!this.ctx || !this._padG) return;
      const ctx = this.ctx, t = ctx.currentTime;
      level = Math.max(-1, Math.min(3, level | 0));
      if (level !== this._mLevel) {
         this._mLevel = level;
         const on = level >= 0;
         this._padG.gain.setTargetAtTime(on ? PAD_GAIN[level] : 0, t, on ? 2 : 0.4);
         this._padF.frequency.setTargetAtTime(on ? PAD_CUT[level] : 220, t, 2.5);
         this._tenseG.gain.setTargetAtTime(level === 3 ? 0.11 : 0, t, 1.5);
         if (on && this._nextChord < t) this._nextChord = t + CHORD_SEC[level];
      }
      if (level < 0 || this.musicVol <= 0) { this._nextStep = 0; return; }
      // chord change: every voice glides to its new note
      if (t >= this._nextChord) {
         this._nextChord = t + CHORD_SEC[level];
         this._chord = (this._chord + 1) % CHORDS.length;
         const c = CHORDS[this._chord];
         for (const [o, idx, mult] of this._mOsc) o.frequency.setTargetAtTime(c[idx] * mult, t, 0.7);
      }
      const bpm = BPM[level];
      if (!bpm) { this._nextStep = 0; return; }
      if (this._nextStep < t) { this._nextStep = t + 0.05; this._step = 0; }
      const c = CHORDS[this._chord], pat = TIMP[level];
      while (this._nextStep < t + 0.2) {
         const s = this._step++ & 15, g = pat[s];
         if (g > 0) this._mHit('timpani', this._nextStep, g * 0.5, c[4]);
         if (level >= 2) this._mHit('cello', this._nextStep, (s & 1 ? 0.1 : 0.15), c[4] * CELLO[s & 7]);
         this._nextStep += 30 / bpm;
      }
   }
}
