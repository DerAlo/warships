// game3d/audiosynth.js — offline sound synthesis for the 3D mode. Pure JS, no Web Audio and no
// assets: every sound of the game is rendered once into a Float32Array by a "recipe" (layers of
// filtered noise, pitch-swept sines, modal metal resonators, band-limited saws) and then played
// back as an AudioBuffer by audio.js. Recipes are deterministic (seeded RNG), so the measurements
// in tests/playwright3d.audio.mjs are reproducible.
//
//   render(name, sr) -> { ch: [Float32Array, ...], sr }   // sr may be half the requested rate
//   SOUND_NAMES                                           // every recipe name
//   impulse(sr)      -> [L, R]                            // open-sea reverb impulse response
const TAU = Math.PI * 2;
const LP = 0, BP = 1, HP = 2;

function mulberry(seed) {
   let a = seed >>> 0;
   return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
   };
}
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// ---------------------------------------------------------------- sources
function white(n, r) { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = r() * 2 - 1; return x; }
function pink(n, r) {
   const x = new Float32Array(n);
   let b0 = 0, b1 = 0, b2 = 0;
   for (let i = 0; i < n; i++) {
      const w = r() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
      x[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
   }
   return x;
}
function brown(n, r) {
   const x = new Float32Array(n);
   let last = 0;
   for (let i = 0; i < n; i++) { last = (last + 0.02 * (r() * 2 - 1)) / 1.02; x[i] = last * 3.5; }
   return x;
}
// sine with an exponentially settling pitch (f0 -> f1, time constant tauP) and an amplitude envelope
function sweep(n, sr, f0, f1, tauP, env) {
   const x = new Float32Array(n);
   let ph = 0;
   for (let i = 0; i < n; i++) {
      const t = i / sr;
      ph += TAU * (f1 + (f0 - f1) * Math.exp(-t / tauP)) / sr;
      x[i] = Math.sin(ph) * env(t);
   }
   return x;
}
// band-limited (polyBLEP) sawtooth; f is a number or a function of time
function saw(n, sr, f, env) {
   const x = new Float32Array(n), fn = typeof f === 'function' ? f : null;
   let ph = 0;
   for (let i = 0; i < n; i++) {
      const t = i / sr, dt = (fn ? fn(t) : f) / sr;
      ph += dt; if (ph >= 1) ph -= 1;
      let v = 2 * ph - 1;
      if (ph < dt) { const u = ph / dt; v -= u + u - u * u - 1; }
      else if (ph > 1 - dt) { const u = (ph - 1) / dt; v -= u * u + u + u + 1; }
      x[i] = v * (env ? env(t) : 1);
   }
   return x;
}
// sum of decaying sines: parts = [[freq, tau, amp], ...]; glide > 0 starts every partial sharp
function modal(n, sr, parts, r, glide = 0, glideTau = 0.05) {
   const x = new Float32Array(n);
   for (const [f, tau, a] of parts) {
      if (f > sr * 0.45) continue;
      let ph = r() * TAU;
      const m = Math.min(n, Math.floor(tau * 9 * sr));
      for (let i = 0; i < m; i++) {
         const t = i / sr;
         ph += TAU * f * (1 + glide * Math.exp(-t / glideTau)) / sr;
         x[i] += Math.sin(ph) * a * Math.exp(-t / tau);
      }
   }
   return x;
}
// smooth random control signal 0..1 changing `rate` times per second
function lfn(n, sr, rate, r) {
   const x = new Float32Array(n), step = Math.max(1, Math.floor(sr / rate));
   let a = r(), b = r();
   for (let i = 0; i < n; i++) {
      const k = i % step;
      if (k === 0 && i > 0) { a = b; b = r(); }
      const u = k / step, s = u * u * (3 - 2 * u);
      x[i] = a + (b - a) * s;
   }
   return x;
}

// ---------------------------------------------------------------- processors (in place)
// Zero-delay state-variable filter (stable under fast cutoff modulation). f: Hz or function(t).
function svf(x, sr, mode, f, q = 0.707) {
   const k = 1 / q, fn = typeof f === 'function' ? f : null, top = sr * 0.45;
   let g = Math.tan(Math.PI * Math.max(8, Math.min(top, fn ? fn(0) : f)) / sr);
   let a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2, ic1 = 0, ic2 = 0;
   for (let i = 0; i < x.length; i++) {
      if (fn && (i & 15) === 0) {
         g = Math.tan(Math.PI * Math.max(8, Math.min(top, fn(i / sr))) / sr);
         a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
      }
      const v3 = x[i] - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
      x[i] = mode === LP ? v2 : mode === BP ? k * v1 : x[i] - k * v1 - v2;
   }
   return x;
}
function shape(x, sr, env) { for (let i = 0; i < x.length; i++) x[i] *= env(i / sr); return x; }
function mul(x, m, lo = 0, hi = 1) { for (let i = 0; i < x.length; i++) x[i] *= lo + (hi - lo) * m[i]; return x; }
function peakOf(x) { let p = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; } return p; }
function norm(x, peak = 0.9) { const p = peakOf(x); if (p > 1e-9) { const g = peak / p; for (let i = 0; i < x.length; i++) x[i] *= g; } return x; }
function drive(x, k) { const d = Math.tanh(k); for (let i = 0; i < x.length; i++) x[i] = Math.tanh(k * x[i]) / d; return x; }
function mix(out, x, gain = 1, at = 0) {
   const n = Math.min(x.length, out.length - at);
   for (let i = 0; i < n; i++) out[at + i] += x[i] * gain;
   return out;
}
// normalise a layer to peak 1, then mix it at `gain`, `at` seconds in
function lay(out, sr, x, gain, at = 0) { return mix(out, norm(x, 1), gain, Math.floor(at * sr)); }
function fade(x, sr, a = 0.001, b = 0.04) {
   const na = Math.min(x.length, Math.floor(a * sr)), nb = Math.min(x.length, Math.floor(b * sr));
   for (let i = 0; i < na; i++) x[i] *= i / na;
   for (let i = 0; i < nb; i++) x[x.length - 1 - i] *= i / nb;
   return x;
}
// seamless loop: the last `xf` seconds are cross-faded into the head (equal power)
function loopable(x, sr, xf) {
   const m = Math.floor(xf * sr), n = x.length - m, out = new Float32Array(n);
   for (let i = 0; i < n; i++) out[i] = x[i];
   for (let i = 0; i < m; i++) {
      const u = i / m;
      out[i] = x[i] * Math.sin(u * Math.PI / 2) + x[n + i] * Math.cos(u * Math.PI / 2);
   }
   return out;
}
const ar = (a, tau) => t => (t < a ? t / a : Math.exp(-(t - a) / tau));
const dec = tau => t => Math.exp(-t / tau);
const expo = (a, b, tau) => t => b + (a - b) * Math.exp(-t / tau);
const bell = dur => t => (t < 0 || t > dur ? 0 : Math.sin(Math.PI * t / dur));

// ---------------------------------------------------------------- building blocks
// sparse short noise bursts between t0 and t1 (debris, crackle, falling water)
function ticks(n, sr, r, count, t0, t1, tau, fade2 = 0) {
   const x = new Float32Array(n), m = Math.floor(tau * 6 * sr);
   for (let c = 0; c < count; c++) {
      const u = r(), at = Math.floor((t0 + (t1 - t0) * u * (fade2 ? u : 1)) * sr), a = (0.3 + 0.7 * r()) * (fade2 ? 1 - u * 0.8 : 1);
      for (let i = 0; i < m && at + i < n; i++) x[at + i] += (r() * 2 - 1) * a * Math.exp(-i / (tau * sr));
   }
   return x;
}
// inharmonic plate/hull resonances
const METAL = [1, 1.59, 2.14, 2.83, 3.61, 4.4, 5.31, 6.72, 8.23, 10.1];
function metal(n, sr, r, base, count, tau, glide = 0) {
   const parts = [];
   for (let i = 0; i < count; i++) parts.push([base * METAL[i] * (0.97 + 0.06 * r()), tau * (0.45 + 0.75 * r()) / (1 + i * 0.28), (0.45 + 0.55 * r()) / (1 + i * 0.22)]);
   return modal(n, sr, parts, r, glide);
}
// crunch of tearing steel: a burst train of band-passed noise
function crunch(n, sr, r, f, span, bursts) {
   const x = white(n, r);
   svf(x, sr, BP, f, 0.8);
   const at = [];
   for (let i = 0; i < bursts; i++) at.push(r() * span);
   return shape(x, sr, t => { let e = 0; for (const a of at) if (t >= a) e += Math.exp(-(t - a) / 0.018); return e; });
}
// brass-like note: two detuned saws through a low-pass that opens with the amplitude
function brass(n, sr, f, env, bright = 1) {
   const vib = t => 1 + (t > 0.3 ? 0.003 * Math.sin(TAU * 5.1 * t) : 0);
   const a = saw(n, sr, t => f * 1.0025 * vib(t), env), b = saw(n, sr, t => f * 0.9975 * vib(t), env);
   mix(a, b, 1);
   svf(a, sr, LP, t => 160 + 1900 * bright * Math.pow(Math.max(0, env(t)), 1.5), 0.9);
   return a;
}
// groaning steel: a slowly gliding saw plus friction noise through two wandering resonances
function groan(sr, r, dur, f0, f1) {
   const n = Math.floor(dur * sr), w = lfn(n, sr, 3, r);
   const src = saw(n, sr, t => (f0 + (f1 - f0) * t / dur) * (0.96 + 0.08 * w[Math.min(n - 1, Math.floor(t * sr))]), null);
   mix(src, pink(n, r), 3);
   const env = t => Math.pow(Math.sin(Math.PI * Math.min(1, t / dur)), 0.7);
   const a = Float32Array.from(src), b = Float32Array.from(src);
   const k1 = 3 + r() * 2, k2 = 7 + r() * 2.5;
   svf(a, sr, BP, t => (f0 + (f1 - f0) * t / dur) * k1, 9);
   svf(b, sr, BP, t => (f0 + (f1 - f0) * t / dur) * k2, 11);
   mix(a, b, 0.6);
   return shape(a, sr, env);
}
function bubbles(n, sr, r, count, t0, t1) {
   const x = new Float32Array(n);
   for (let c = 0; c < count; c++) {
      const at = Math.floor((t0 + (t1 - t0) * r()) * sr), dur = 0.035 + r() * 0.09, m = Math.floor(dur * sr);
      const f = 260 + r() * 800, a = 0.3 + 0.7 * r();
      let ph = 0;
      for (let i = 0; i < m && at + i < n; i++) {
         const u = i / m;
         ph += TAU * f * (1 + 0.45 * u) / sr;
         x[at + i] += Math.sin(ph) * Math.sin(Math.PI * u) * a;
      }
   }
   return x;
}

// ---------------------------------------------------------------- guns
// h: 0 = 127 mm ... 1 = 406 mm. One barrel, heard close: crack + falling-pitch body + blast.
function gunShot(sr, r, h) {
   const n = Math.floor((0.6 + 1.15 * h) * sr), out = new Float32Array(n), j = 0.94 + 0.12 * r();
   const c = white(Math.floor(0.15 * sr), r);
   svf(c, sr, HP, 2700 - 1400 * h, 0.7); shape(c, sr, dec(0.005 + 0.012 * h));
   lay(out, sr, c, 1.0 - 0.15 * h);
   const s = white(Math.floor(0.4 * sr), r);
   svf(s, sr, BP, (1500 - 750 * h) * j, 0.9); shape(s, sr, dec(0.022 + 0.04 * h));
   lay(out, sr, s, 1.0);
   const body = sweep(n, sr, (178 - 90 * h) * j, 64 - 32 * h, 0.04 + 0.075 * h, ar(0.002, 0.08 + 0.38 * h));
   lay(out, sr, drive(body, 2.4), 0.6 + 1.15 * h);
   if (h > 0.4) lay(out, sr, sweep(n, sr, 60, 29, 0.25, ar(0.012, 0.22 + 0.4 * h)), 0.85 * h);
   const bl = pink(n, r);
   svf(bl, sr, LP, expo(7500 - 2600 * h, 240, 0.045 + 0.14 * h), 0.7); shape(bl, sr, ar(0.001, 0.065 + 0.28 * h));
   lay(out, sr, bl, 1.3);
   const bark = white(n, r);
   svf(bark, sr, BP, (340 - 160 * h) * j, 1.4); shape(bark, sr, ar(0.003, 0.1 + 0.22 * h));
   lay(out, sr, bark, 1.0 - 0.3 * h);
   return fade(norm(drive(out, 1.5), 0.95), sr, 0.0003, 0.08);
}
// the long rumbling tail of a salvo rolling away over the water
function gunTail(sr, r, h) {
   const n = Math.floor((0.9 + 4.1 * h) * sr), out = new Float32Array(n);
   const x = brown(n, r);
   svf(x, sr, LP, expo(1500 - 1050 * h, 270 - 180 * h, 0.4 + 0.7 * h), 0.7);
   mul(x, lfn(n, sr, 5.5 - 2.5 * h, r), 0.4, 1.3); shape(x, sr, ar(0.05, 0.2 + 1.27 * h));
   lay(out, sr, x, 1);
   const air = pink(n, r);
   svf(air, sr, BP, 700 - 380 * h, 0.6); mul(air, lfn(n, sr, 4, r), 0.3, 1); shape(air, sr, ar(0.04, 0.22 + 0.98 * h));
   lay(out, sr, air, 0.5 - 0.2 * h);
   const echoes = 2 + Math.round(3 * h);
   for (let k = 0; k < echoes; k++) {
      const at = 0.12 + r() * (0.25 + 1.15 * h);
      const th = sweep(Math.floor(0.7 * sr), sr, 130 - 78 * h, 60 - 30 * h, 0.08, ar(0.012, 0.07 + 0.21 * h));
      lay(out, sr, th, 0.55 * Math.exp(-at / 0.7), at);
   }
   return fade(norm(out, 0.9), sr, 0.002, 0.25);
}
// a salvo heard from kilometres away: no crack, a soft thump and a long roll
function farBoom(sr, r, s) {
   const n = Math.floor((3.2 + 2.6 * s) * sr), out = new Float32Array(n);
   const th = () => sweep(Math.floor(1.6 * sr), sr, 78 - 30 * s, 36 - 8 * s, 0.12, ar(0.03, 0.4 + 0.5 * s));
   lay(out, sr, th(), 1);
   const extra = 2 + Math.round(2 * s);
   for (let k = 0; k < extra; k++) lay(out, sr, th(), 0.75 - k * 0.13, 0.07 + r() * 0.2 + k * 0.13);
   const x = brown(n, r);
   svf(x, sr, LP, expo(300, 95, 1.0), 0.7); mul(x, lfn(n, sr, 3.5, r), 0.35, 1.3); shape(x, sr, ar(0.15, 0.95 + 1.3 * s));
   lay(out, sr, x, 1.0);
   const mid = pink(n, r);
   svf(mid, sr, BP, 380, 0.7); mul(mid, lfn(n, sr, 6, r), 0.2, 1); shape(mid, sr, ar(0.06, 0.5 + 0.4 * s));
   lay(out, sr, mid, 0.3);
   svf(out, sr, LP, 1100, 0.7);
   return fade(norm(out, 0.9), sr, 0.004, 0.3);
}

// ---------------------------------------------------------------- water + impacts
function splash(sr, r, big) {
   const n = Math.floor((big ? 2.7 : 1.6) * sr), out = new Float32Array(n);
   const slap = white(Math.floor(0.3 * sr), r);
   svf(slap, sr, LP, big ? 1200 : 1900, 0.7); shape(slap, sr, ar(0.002, 0.03));
   lay(out, sr, slap, 0.9);
   lay(out, sr, sweep(Math.floor(1.2 * sr), sr, big ? 72 : 98, big ? 31 : 46, 0.1, ar(0.006, big ? 0.26 : 0.12)), big ? 1.1 : 0.55);
   const col = pink(n, r);
   svf(col, sr, BP, t => 850 + 1900 * Math.min(1, t / (big ? 0.7 : 0.4)), 0.6); shape(col, sr, ar(big ? 0.22 : 0.11, big ? 0.7 : 0.34));
   lay(out, sr, col, 0.8);
   const back = white(n, r);
   svf(back, sr, HP, 2400, 0.7); mul(back, lfn(n, sr, 45, r), 0, 1); mul(back, lfn(n, sr, 31, r), 0, 1);
   const t0 = big ? 0.8 : 0.4;
   shape(back, sr, t => (t < t0 ? 0 : ar(0.3, big ? 0.75 : 0.45)(t - t0)));
   lay(out, sr, back, 0.4);
   return fade(norm(out, 0.9), sr, 0.0005, 0.2);
}
function explosionCore(out, sr, r, { f0, f1, tau, noiseF, noiseTau, at = 0, gain = 1 }) {
   const n = out.length - Math.floor(at * sr);
   lay(out, sr, drive(sweep(n, sr, f0, f1, tau * 0.4, ar(0.004, tau)), 2), gain, at);
   const b = pink(n, r);
   svf(b, sr, LP, expo(noiseF, 180, noiseTau * 0.5), 0.7); shape(b, sr, ar(0.002, noiseTau));
   lay(out, sr, b, gain * 1.1, at);
}
function pen(sr, r, cit) {
   const n = Math.floor((cit ? 2.6 : 1.5) * sr), out = new Float32Array(n);
   lay(out, sr, crunch(Math.floor(0.5 * sr), sr, r, cit ? 900 : 1300, 0.07, cit ? 6 : 4), 0.9);
   lay(out, sr, metal(n, sr, r, cit ? 118 : 190, 9, cit ? 0.5 : 0.26), 0.5);
   explosionCore(out, sr, r, { f0: cit ? 74 : 92, f1: cit ? 27 : 38, tau: cit ? 0.6 : 0.3, noiseF: cit ? 2600 : 1900, noiseTau: cit ? 0.5 : 0.28, at: 0.03 });
   if (cit) {
      explosionCore(out, sr, r, { f0: 60, f1: 26, tau: 0.5, noiseF: 1200, noiseTau: 0.45, at: 0.2, gain: 0.8 });
      const rum = brown(n, r);
      svf(rum, sr, LP, 240, 0.7); mul(rum, lfn(n, sr, 4, r), 0.3, 1); shape(rum, sr, ar(0.1, 0.7));
      lay(out, sr, rum, 0.5);
   }
   return fade(norm(drive(out, 1.5), 0.92), sr, 0.0005, 0.1);
}
function overpen(sr, r) {
   const n = Math.floor(0.55 * sr), out = new Float32Array(n);
   for (const at of [0, 0.038]) {
      const tk = white(Math.floor(0.08 * sr), r);
      svf(tk, sr, HP, 1800, 0.7); shape(tk, sr, dec(0.004));
      lay(out, sr, tk, at ? 0.6 : 0.9, at);
      lay(out, sr, metal(Math.floor(0.4 * sr), sr, r, at ? 380 : 450, 6, 0.07), at ? 0.45 : 0.6, at);
   }
   const whiff = white(n, r);
   svf(whiff, sr, BP, 2400, 0.8); shape(whiff, sr, ar(0.02, 0.09));
   lay(out, sr, whiff, 0.22, 0.03);
   return fade(norm(out, 0.85), sr, 0.0003, 0.05);
}
function ricochet(sr, r, v) {
   const n = Math.floor(0.65 * sr), out = new Float32Array(n), f = (v ? 1750 : 2150) * (0.95 + 0.1 * r());
   const gl = t => 0.56 + 0.44 * Math.exp(-t / 0.075);
   let ph = [0, 0, 0, 0];
   const ratio = [1, 1.47, 2.09, 2.56], amp = [1, 0.6, 0.4, 0.25];
   for (let i = 0; i < n; i++) {
      const t = i / sr, g = gl(t);
      let v2 = 0;
      for (let k = 0; k < 4; k++) { ph[k] += TAU * f * ratio[k] * g / sr; v2 += Math.sin(ph[k]) * amp[k] * Math.exp(-t / (0.2 / (1 + k * 0.5))); }
      out[i] = v2 * 0.45;
   }
   const z = white(n, r);
   svf(z, sr, BP, t => f * gl(t), 7); shape(z, sr, ar(0.002, 0.16));
   lay(out, sr, z, 0.5);
   const tk = white(Math.floor(0.05 * sr), r);
   svf(tk, sr, HP, 3000, 0.7); shape(tk, sr, dec(0.003));
   lay(out, sr, tk, 0.8);
   lay(out, sr, metal(Math.floor(0.3 * sr), sr, r, 310, 6, 0.06), 0.35);
   return fade(norm(out, 0.85), sr, 0.0003, 0.06);
}
function shatter(sr, r) {
   const n = Math.floor(0.7 * sr), out = new Float32Array(n);
   lay(out, sr, svf(crunch(Math.floor(0.4 * sr), sr, r, 3200, 0.06, 6), sr, HP, 1500, 0.7), 0.9);
   lay(out, sr, metal(Math.floor(0.4 * sr), sr, r, 880, 7, 0.05), 0.5);
   lay(out, sr, svf(ticks(n, sr, r, 26, 0.05, 0.55, 0.003, 1), sr, HP, 2000, 0.7), 0.5);
   lay(out, sr, sweep(Math.floor(0.3 * sr), sr, 130, 70, 0.04, ar(0.002, 0.05)), 0.4);
   return fade(norm(out, 0.85), sr, 0.0003, 0.06);
}
function heBurst(sr, r) {
   const n = Math.floor(1.4 * sr), out = new Float32Array(n);
   const c = white(Math.floor(0.1 * sr), r);
   svf(c, sr, HP, 2000, 0.7); shape(c, sr, dec(0.008));
   lay(out, sr, c, 0.9);
   const b = pink(n, r);
   svf(b, sr, LP, expo(9000, 480, 0.08), 0.7); shape(b, sr, ar(0.001, 0.2));
   lay(out, sr, b, 1.25);
   lay(out, sr, drive(sweep(n, sr, 112, 48, 0.07, ar(0.003, 0.2)), 2), 0.9);
   const fw = white(n, r);
   svf(fw, sr, BP, 700, 0.7); shape(fw, sr, ar(0.09, 0.4));
   lay(out, sr, fw, 0.3);
   lay(out, sr, svf(ticks(n, sr, r, 18, 0.1, 0.9, 0.004, 1), sr, BP, 2600, 0.8), 0.3);
   return fade(norm(drive(out, 1.4), 0.9), sr, 0.0003, 0.1);
}
function explosionBig(sr, r) {
   const n = Math.floor(3 * sr), out = new Float32Array(n);
   const c = white(Math.floor(0.12 * sr), r);
   svf(c, sr, HP, 1500, 0.7); shape(c, sr, dec(0.012));
   lay(out, sr, c, 0.8);
   explosionCore(out, sr, r, { f0: 84, f1: 29, tau: 0.6, noiseF: 5200, noiseTau: 0.5 });
   const rum = brown(n, r);
   svf(rum, sr, LP, expo(420, 110, 0.8), 0.7); mul(rum, lfn(n, sr, 4, r), 0.35, 1.2); shape(rum, sr, ar(0.08, 0.85));
   lay(out, sr, rum, 0.7);
   lay(out, sr, svf(ticks(n, sr, r, 24, 0.2, 1.8, 0.005, 1), sr, BP, 2200, 0.8), 0.22);
   return fade(norm(drive(out, 1.5), 0.92), sr, 0.0003, 0.2);
}
function terrain(sr, r) {
   const n = Math.floor(1.5 * sr), out = new Float32Array(n);
   lay(out, sr, drive(sweep(n, sr, 105, 46, 0.06, ar(0.003, 0.17)), 2), 1);
   const d = pink(n, r);
   svf(d, sr, LP, expo(2600, 320, 0.1), 0.7); shape(d, sr, ar(0.002, 0.24));
   lay(out, sr, d, 1);
   lay(out, sr, svf(ticks(n, sr, r, 40, 0.15, 1.2, 0.004, 1), sr, LP, 2800, 0.7), 0.4);
   return fade(norm(out, 0.9), sr, 0.0005, 0.1);
}
function torpHit(sr, r) {
   const n = Math.floor(4.6 * sr), out = new Float32Array(n);
   const c = white(Math.floor(0.08 * sr), r);
   svf(c, sr, LP, 3000, 0.7); shape(c, sr, dec(0.004));
   lay(out, sr, c, 0.6);
   lay(out, sr, drive(sweep(n, sr, 56, 22, 0.25, ar(0.008, 0.95)), 2.6), 1.5);
   const rum = brown(n, r);
   svf(rum, sr, LP, expo(520, 90, 0.4), 0.7); mul(rum, lfn(n, sr, 4, r), 0.4, 1.2); shape(rum, sr, ar(0.02, 1.1));
   lay(out, sr, rum, 1.0);
   lay(out, sr, metal(n, sr, r, 68, 8, 0.8), 0.3, 0.05);
   const col = pink(n, r);
   svf(col, sr, BP, t => 650 + 1600 * Math.min(1, t / 1.1), 0.6); shape(col, sr, ar(0.38, 1.0));
   lay(out, sr, col, 0.6, 0.15);
   const fall = white(n, r);
   svf(fall, sr, HP, 2000, 0.7); mul(fall, lfn(n, sr, 40, r), 0, 1); shape(fall, sr, t => (t < 1.3 ? 0 : ar(0.5, 1.0)(t - 1.3)));
   lay(out, sr, fall, 0.3);
   return fade(norm(drive(out, 1.4), 0.93), sr, 0.0005, 0.3);
}
// The scripted large detonation heard across the water (blast3d.js / audio.blast): no sharp crack
// survives the distance. A pressure thump, then half a minute of rolling, slowly darkening rumble
// with late echoes off the sea.
function megaBlast(sr, r) {
   const n = Math.floor(16 * sr), out = new Float32Array(n);
   lay(out, sr, drive(sweep(n, sr, 46, 15, 1.1, ar(0.012, 3.4)), 3.2), 1.7);
   const b = pink(n, r);
   svf(b, sr, LP, expo(2600, 90, 0.7), 0.7); shape(b, sr, ar(0.004, 1.6));
   lay(out, sr, drive(norm(b, 1), 2.2), 1.2);
   for (let k = 0; k < 9; k++) {
      const at = 0.5 + r() * 7.5;
      explosionCore(out, sr, r, { f0: 58 - 3 * k, f1: 22, tau: 0.7, noiseF: 620, noiseTau: 0.6, at, gain: 0.7 * Math.exp(-at / 4.2) });
   }
   const rum = brown(n, r);
   svf(rum, sr, LP, expo(260, 48, 4.5), 0.7); mul(rum, lfn(n, sr, 2.2, r), 0.4, 1.3); shape(rum, sr, ar(0.2, 5.5));
   lay(out, sr, rum, 1.5);
   return fade(norm(drive(out, 1.5), 0.95), sr, 0.002, 2.5);
}
function detonation(sr, r) {
   const n = Math.floor(7 * sr), out = new Float32Array(n);
   for (const at of [0, 0.075]) {
      const c = white(Math.floor(0.2 * sr), r);
      svf(c, sr, HP, 1200, 0.7); shape(c, sr, dec(0.016));
      lay(out, sr, c, 0.9, at);
   }
   const b = pink(n, r);
   svf(b, sr, LP, expo(8000, 150, 0.3), 0.7); shape(b, sr, ar(0.002, 0.9));
   lay(out, sr, drive(norm(b, 1), 2), 1.3);
   lay(out, sr, drive(sweep(n, sr, 62, 20, 0.5, ar(0.005, 1.6)), 2.8), 1.6);
   for (let k = 0; k < 5; k++) {
      const at = 0.35 + r() * 2.4;
      explosionCore(out, sr, r, { f0: 86 - 6 * k, f1: 34, tau: 0.35, noiseF: 1400, noiseTau: 0.32, at, gain: 0.75 * Math.exp(-at / 1.8) });
   }
   const rum = brown(n, r);
   svf(rum, sr, LP, expo(420, 70, 1.5), 0.7); mul(rum, lfn(n, sr, 3.5, r), 0.35, 1.3); shape(rum, sr, ar(0.05, 2.2));
   lay(out, sr, rum, 1.0);
   lay(out, sr, metal(n, sr, r, 150, 10, 1.2), 0.22, 0.1);
   lay(out, sr, svf(ticks(n, sr, r, 60, 0.3, 4.5, 0.006, 1), sr, BP, 1900, 0.8), 0.2);
   return fade(norm(drive(out, 1.6), 0.95), sr, 0.0003, 0.5);
}
function sink(sr, r) {
   const dur = 9, n = Math.floor(dur * sr), out = new Float32Array(n);
   for (let k = 0; k < 6; k++) {
      const f0 = 52 + r() * 80, d = 1.1 + r() * 1.8;
      lay(out, sr, groan(sr, r, d, f0, f0 * (0.7 + r() * 0.55)), 0.75 - k * 0.05, 0.1 + k * 1.15 + r() * 0.5);
   }
   const w = pink(n, r);
   svf(w, sr, BP, t => 500 + 900 * Math.sin(Math.PI * t / dur), 0.5); mul(w, lfn(n, sr, 2.5, r), 0.45, 1);
   shape(w, sr, t => Math.pow(Math.sin(Math.PI * Math.min(1, t / dur)), 0.8) * (t < 3 ? t / 3 : 1));
   lay(out, sr, w, 0.8);
   const low = brown(n, r);
   svf(low, sr, LP, 220, 0.7); mul(low, lfn(n, sr, 2, r), 0.4, 1); shape(low, sr, ar(0.4, 4.5));
   lay(out, sr, low, 0.8);
   lay(out, sr, bubbles(n, sr, r, 110, 1.2, 8.4), 0.32);
   for (let k = 0; k < 3; k++) lay(out, sr, svf(sweep(Math.floor(1.2 * sr), sr, 72, 30, 0.12, ar(0.01, 0.3)), sr, LP, 300, 0.7), 0.7 - k * 0.12, 0.6 + k * 1.9 + r());
   return fade(norm(out, 0.9), sr, 0.05, 1.2);
}
// own ship takes a hit: heard from inside the hull
function ownHit(sr, r, big) {
   const n = Math.floor((big ? 2.3 : 1.2) * sr), out = new Float32Array(n);
   lay(out, sr, metal(n, sr, r, big ? 92 : 150, 9, big ? 0.75 : 0.36), 0.75);
   lay(out, sr, crunch(Math.floor(0.4 * sr), sr, r, big ? 1000 : 1500, 0.05, big ? 5 : 3), 0.7);
   lay(out, sr, drive(sweep(n, sr, big ? 74 : 96, big ? 29 : 42, 0.06, ar(0.003, big ? 0.42 : 0.18)), 2.4), big ? 1.3 : 0.9);
   const b = pink(n, r);
   svf(b, sr, LP, expo(3200, 300, 0.06), 0.7); shape(b, sr, ar(0.002, big ? 0.3 : 0.15));
   lay(out, sr, b, 0.9);
   if (big) lay(out, sr, svf(ticks(n, sr, r, 22, 0.2, 1.6, 0.006, 1), sr, BP, 1500, 0.8), 0.25);
   return fade(norm(drive(out, 1.4), 0.92), sr, 0.0003, 0.12);
}
function whistle(sr, r) {
   const dur = 1.35, n = Math.floor(dur * sr), out = new Float32Array(n);
   const f = t => 720 + 2000 / (1 + Math.exp((t - 0.95) / 0.1));
   const a = white(n, r), b = white(n, r);
   svf(a, sr, BP, f, 6); svf(b, sr, BP, t => f(t) * 1.52, 4);
   mix(a, b, 0.45);
   shape(a, sr, t => (t < 1.1 ? Math.pow(t / 1.1, 2.2) : Math.exp(-(t - 1.1) / 0.06)));
   lay(out, sr, a, 1);
   return fade(norm(out, 0.8), sr, 0.02, 0.03);
}
function torpLaunch(sr, r) {
   const n = Math.floor(1.8 * sr), out = new Float32Array(n);
   const air = white(n, r);
   svf(air, sr, BP, expo(3600, 850, 0.14), 0.8); shape(air, sr, ar(0.005, 0.19));
   lay(out, sr, air, 1);
   lay(out, sr, sweep(Math.floor(0.5 * sr), sr, 145, 60, 0.05, ar(0.003, 0.08)), 0.65);
   lay(out, sr, metal(Math.floor(0.5 * sr), sr, r, 235, 5, 0.08), 0.3);
   const sl = white(Math.floor(0.6 * sr), r);
   svf(sl, sr, LP, 2000, 0.7); shape(sl, sr, ar(0.004, 0.05));
   lay(out, sr, sl, 0.5, 0.36);
   const ws = pink(n, r);
   svf(ws, sr, BP, 1250, 0.6); shape(ws, sr, ar(0.06, 0.32));
   lay(out, sr, ws, 0.5, 0.37);
   return fade(norm(out, 0.85), sr, 0.0005, 0.1);
}
function reloadClank(sr, r) {
   const n = Math.floor(0.75 * sr), out = new Float32Array(n);
   lay(out, sr, metal(Math.floor(0.5 * sr), sr, r, 212, 7, 0.12), 0.8);
   lay(out, sr, sweep(Math.floor(0.3 * sr), sr, 125, 70, 0.03, ar(0.002, 0.05)), 0.6);
   lay(out, sr, metal(Math.floor(0.55 * sr), sr, r, 158, 7, 0.18), 1, 0.16);
   lay(out, sr, sweep(Math.floor(0.3 * sr), sr, 105, 58, 0.03, ar(0.002, 0.07)), 0.7, 0.16);
   const tk = white(Math.floor(0.1 * sr), r);
   shape(tk, sr, dec(0.005));
   lay(out, sr, tk, 0.4); lay(out, sr, tk, 0.4, 0.16);
   svf(out, sr, LP, 1500, 0.7);
   return fade(norm(out, 0.8), sr, 0.0005, 0.08);
}
function thunder(sr, r) {
   const n = Math.floor(6 * sr), out = new Float32Array(n);
   lay(out, sr, svf(crunch(Math.floor(1.2 * sr), sr, r, 900, 0.45, 7), sr, LP, 2400, 0.7), 0.7);
   const rum = brown(n, r);
   svf(rum, sr, LP, expo(650, 80, 1.5), 0.7);
   const m = lfn(n, sr, 3, r);
   for (let i = 0; i < n; i++) rum[i] *= Math.pow(m[i], 1.5) * 1.6 + 0.2;
   shape(rum, sr, ar(0.25, 2.0));
   lay(out, sr, rum, 1);
   return fade(norm(out, 0.85), sr, 0.02, 0.6);
}

// ---------------------------------------------------------------- interface
const tick = (sr, r, f = 2200, tau = 0.003) => shape(svf(white(Math.floor(tau * 12 * sr), r), sr, BP, f, 1.2), sr, dec(tau));
function uiClick(sr, r) {
   const n = Math.floor(0.1 * sr), out = new Float32Array(n);
   lay(out, sr, tick(sr, r), 0.7);
   lay(out, sr, modal(n, sr, [[310, 0.018, 1], [520, 0.012, 0.6], [1150, 0.006, 0.4]], r), 0.8);
   return fade(svf(norm(out, 0.7), sr, LP, 5000, 0.7), sr, 0.0002, 0.02);
}
function uiLock(sr, r) {
   const n = Math.floor(0.38 * sr), out = new Float32Array(n);
   lay(out, sr, tick(sr, r), 0.6);
   lay(out, sr, modal(n, sr, [[392, 0.09, 1], [588, 0.07, 0.95], [1046, 0.05, 0.5], [1340, 0.04, 0.35], [196, 0.06, 0.4]], r), 0.75, 0.07);
   lay(out, sr, tick(sr, r, 1500, 0.004), 0.4, 0.07);
   return fade(svf(norm(out, 0.7), sr, LP, 3200, 0.7), sr, 0.0002, 0.04);
}
function uiDenied(sr, r) {
   const n = Math.floor(0.32 * sr), out = new Float32Array(n);
   for (const at of [0, 0.11]) {
      lay(out, sr, modal(Math.floor(0.2 * sr), sr, [[138, 0.035, 1], [196, 0.03, 0.8], [277, 0.02, 0.5]], r), 0.9, at);
      lay(out, sr, shape(svf(white(Math.floor(0.08 * sr), r), sr, LP, 600, 0.7), sr, dec(0.012)), 0.6, at);
   }
   return fade(norm(out, 0.7), sr, 0.0005, 0.03);
}
function uiAmmo(sr, r) {
   const n = Math.floor(0.5 * sr), out = new Float32Array(n);
   for (const at of [0, 0.05, 0.1]) lay(out, sr, tick(sr, r, 1800, 0.004), 0.5, at);
   lay(out, sr, modal(Math.floor(0.32 * sr), sr, [[180, 0.09, 1], [265, 0.07, 0.7], [430, 0.05, 0.5], [910, 0.03, 0.3]], r), 0.9, 0.18);
   lay(out, sr, shape(svf(white(Math.floor(0.2 * sr), r), sr, LP, 900, 0.7), sr, dec(0.03)), 0.6, 0.18);
   return fade(norm(out, 0.7), sr, 0.0003, 0.04);
}
function ribbonTick(sr, r, parts, len, glide = 0) {
   const n = Math.floor(len * sr), out = new Float32Array(n);
   lay(out, sr, modal(n, sr, parts, r, glide, 0.03), 0.9);
   lay(out, sr, tick(sr, r, 2600, 0.002), 0.45);
   return fade(norm(out, 0.65), sr, 0.0002, 0.03);
}
function ribbonCitadel(sr, r) {
   const n = Math.floor(0.65 * sr), out = new Float32Array(n);
   const p = [[196, 0.25, 1], [293, 0.2, 0.6], [466, 0.15, 0.45], [740, 0.08, 0.25]];
   lay(out, sr, modal(n, sr, p, r), 0.9); lay(out, sr, modal(n, sr, p, r), 0.7, 0.09);
   lay(out, sr, tick(sr, r, 1400, 0.004), 0.5); lay(out, sr, tick(sr, r, 1400, 0.004), 0.4, 0.09);
   lay(out, sr, sweep(Math.floor(0.3 * sr), sr, 110, 60, 0.04, ar(0.003, 0.07)), 0.6);
   return fade(norm(out, 0.7), sr, 0.0003, 0.08);
}
function timpani(sr, r, f = 73.42) {
   const n = Math.floor(2.2 * sr), out = new Float32Array(n);
   lay(out, sr, modal(n, sr, [[f, 1.0, 1], [f * 1.5, 0.75, 0.7], [f * 1.99, 0.45, 0.45], [f * 2.44, 0.32, 0.3], [f * 2.89, 0.22, 0.2]], r, 0.035, 0.06), 1);
   lay(out, sr, shape(svf(white(Math.floor(0.15 * sr), r), sr, LP, 900, 0.7), sr, dec(0.012)), 0.5);
   const air = brown(n, r);
   svf(air, sr, LP, 260, 0.7); shape(air, sr, ar(0.01, 0.5));
   lay(out, sr, air, 0.12);
   return fade(norm(out, 0.9), sr, 0.0005, 0.3);
}
const swell = (a, hold, rel) => t => (t < a ? t / a : t < hold ? 1 : Math.exp(-(t - hold) / rel));
function chord(sr, len, notes) {
   const n = Math.floor(len * sr), out = new Float32Array(n);
   for (const [f, at, dur, g, br] of notes) {
      const m = Math.min(n - Math.floor(at * sr), Math.floor((dur + 1.6) * sr));
      if (m > 0) mix(out, brass(m, sr, f, swell(0.09 + 0.1 * (dur > 1 ? 1 : 0), dur, 0.35), br ?? 1), g, Math.floor(at * sr));
   }
   return out;
}
function ribbonKill(sr, r) {
   const out = chord(sr, 1.5, [[73.42, 0, 0.5, 0.5, 0.8], [110, 0, 0.5, 0.4, 0.8]]);
   lay(out, sr, timpani(sr, r), 2.0);
   return fade(norm(out, 0.75), sr, 0.001, 0.3);
}
function radio(sr, r) {
   const n = Math.floor(0.42 * sr), out = new Float32Array(n);
   const sq = white(n, r);
   svf(sq, sr, BP, 2300, 1.6);
   shape(sq, sr, t => (t < 0.1 ? Math.min(1, t / 0.004) * Math.min(1, (0.1 - t) / 0.01) : t > 0.17 && t < 0.25 ? 0.6 * Math.min(1, (t - 0.17) / 0.004) * Math.min(1, (0.25 - t) / 0.01) : 0));
   lay(out, sr, sq, 0.6);
   lay(out, sr, tick(sr, r, 900, 0.005), 0.8); lay(out, sr, tick(sr, r, 700, 0.005), 0.6, 0.26);
   return fade(norm(out, 0.6), sr, 0.0005, 0.03);
}
// ship's alarm gong: `strikes` hits of a muted bell, `gap` seconds apart
function gong(sr, r, base, strikes, gap, tau) {
   const n = Math.floor((strikes * gap + tau * 5) * sr), out = new Float32Array(n);
   const p = [[base, tau, 1], [base * 0.5, tau, 0.45], [base * 2.0, tau * 0.8, 0.85], [base * 2.76, tau * 0.6, 0.75], [base * 4.07, tau * 0.4, 0.5], [base * 5.4, tau * 0.28, 0.3]];
   for (let k = 0; k < strikes; k++) {
      lay(out, sr, modal(Math.floor(tau * 7 * sr), sr, p, r, 0.004, 0.02), 0.9, k * gap);
      lay(out, sr, tick(sr, r, base * 3, 0.004), 0.35, k * gap);
   }
   return fade(svf(norm(out, 0.75), sr, LP, 3600, 0.7), sr, 0.0005, 0.1);
}
// reed horn blasts (klaxon/buzzer): detuned saw pair through two formants
function horn(sr, r, f1, f2, blasts, len, gap, fa, fb) {
   const n = Math.floor((blasts * (len + gap) + 0.2) * sr), out = new Float32Array(n), m = Math.floor((len + 0.1) * sr);
   const env = t => Math.min(1, t / 0.03) * (t < len ? 1 : Math.exp(-(t - len) / 0.03));
   for (let k = 0; k < blasts; k++) {
      const s = saw(m, sr, f1, env);
      mix(s, saw(m, sr, f2, env), 1);
      const a = Float32Array.from(s), b = Float32Array.from(s);
      svf(a, sr, BP, fa, 3); svf(b, sr, BP, fb, 4); svf(s, sr, LP, 900, 0.7);
      mix(a, b, 0.7); mix(a, s, 0.35);
      lay(out, sr, a, 1, k * (len + gap));
   }
   return out;
}
function alertFlood(sr, r) {
   const out = horn(sr, r, 155, 157.3, 2, 0.34, 0.13, 480, 1100);
   const g = brown(out.length, r);
   svf(g, sr, LP, 520, 0.7); mul(g, lfn(out.length, sr, 9, r), 0.2, 1);
   lay(out, sr, g, 0.4);
   lay(out, sr, bubbles(out.length, sr, r, 16, 0.05, 0.9), 0.25);
   return fade(norm(out, 0.7), sr, 0.002, 0.1);
}
function alertSpotted(sr, r) {
   const n = Math.floor(0.6 * sr), out = new Float32Array(n);
   lay(out, sr, sweep(n, sr, 185, 108, 0.12, ar(0.01, 0.13)), 0.7);
   mix(out, brass(n, sr, 146.83, swell(0.03, 0.2, 0.1), 1.4), 0.45);
   mix(out, brass(n, sr, 220, swell(0.03, 0.2, 0.1), 1.4), 0.4);
   mix(out, brass(n, sr, 233.08, swell(0.03, 0.2, 0.1), 1.2), 0.25);
   lay(out, sr, tick(sr, r, 1300, 0.004), 0.4);
   return fade(norm(out, 0.7), sr, 0.001, 0.08);
}
function objective(sr, r, kind) {
   // done: rising fourth; failed: falling semitone into a low fifth; new: one soft note
   const notes = kind === 'done' ? [[110, 0, 0.2, 0.6], [146.83, 0.22, 0.55, 0.7], [220, 0.22, 0.55, 0.3]]
      : kind === 'failed' ? [[146.83, 0, 0.25, 0.6], [138.59, 0.27, 0.7, 0.7], [69.3, 0.27, 0.7, 0.5]]
      : [[110, 0, 0.35, 0.6], [164.81, 0, 0.35, 0.3]];
   const out = chord(sr, kind === 'new' ? 1.0 : 1.5, notes);
   lay(out, sr, tick(sr, r, 1000, 0.004), 0.25);
   return fade(norm(out, 0.65), sr, 0.001, 0.25);
}
function endCue(sr, r, victory) {
   const D = 73.42;
   const notes = victory
      ? [[D / 2, 0, 4.2, 0.7, 0.6], [D, 0, 1.5, 0.6], [D * 1.5, 0, 1.5, 0.5], [D * 2, 0.5, 1.2, 0.35],
         [D, 1.7, 2.6, 0.6, 1.2], [D * 1.5, 1.7, 2.6, 0.5, 1.2], [D * 2, 1.7, 2.6, 0.45, 1.2], [D * 2.52, 1.7, 2.6, 0.38, 1.2], [D * 3, 2.2, 2.1, 0.25, 1.2]]
      : [[D / 2, 0, 4.6, 0.7, 0.5], [D, 0, 1.6, 0.6, 0.7], [D * 1.5, 0, 1.6, 0.45, 0.7], [D * 2.378, 0, 1.6, 0.4, 0.7],
         [D * 0.944, 1.9, 2.8, 0.6, 0.6], [D * 1.189, 1.9, 2.8, 0.45, 0.6], [D * 1.888, 1.9, 2.8, 0.4, 0.6], [D * 1.414, 2.6, 2.1, 0.25, 0.5]];
   const out = chord(sr, 6.4, notes);
   norm(out, 0.7);
   const tp = timpani(sr, r);
   if (victory) {
      for (let k = 0; k < 9; k++) mix(out, tp, 0.12 + k * 0.035, Math.floor((0.85 + k * 0.09) * sr));
      mix(out, tp, 0.8, Math.floor(1.7 * sr)); mix(out, tp, 0.5, 0);
   } else {
      mix(out, tp, 0.7, 0); mix(out, tp, 0.55, Math.floor(1.9 * sr)); mix(out, tp, 0.35, Math.floor(3.3 * sr));
   }
   return fade(norm(out, 0.85), sr, 0.002, 0.8);
}
function cello(sr, r) {
   const n = Math.floor(0.55 * sr);
   const x = brass(n, sr, 73.42, swell(0.012, 0.09, 0.09), 0.55);
   lay(x, sr, tick(sr, r, 500, 0.006), 0.15);
   return fade(norm(x, 0.8), sr, 0.001, 0.1);
}

// ---------------------------------------------------------------- consumables
function consSmoke(sr, r) {
   const n = Math.floor(1.9 * sr), x = white(n, r);
   svf(x, sr, HP, 2800, 0.7); svf(x, sr, LP, 9000, 0.7); mul(x, lfn(n, sr, 12, r), 0.6, 1); shape(x, sr, ar(0.2, 0.6));
   const out = new Float32Array(n);
   lay(out, sr, x, 0.8); lay(out, sr, metal(Math.floor(0.3 * sr), sr, r, 300, 5, 0.05), 0.4);
   return fade(norm(out, 0.6), sr, 0.001, 0.2);
}
function consBoost(sr, r) {
   const n = Math.floor(1.5 * sr), out = new Float32Array(n);
   const env = swell(0.5, 0.8, 0.25);
   const a = saw(n, sr, t => 46 + 44 * Math.min(1, t / 0.9), env);
   svf(a, sr, LP, t => 180 + 700 * Math.min(1, t / 0.9), 1.2);
   lay(out, sr, a, 1);
   const w = white(n, r);
   svf(w, sr, BP, t => 500 + 1900 * Math.min(1, t / 1.0), 6); shape(w, sr, env);
   lay(out, sr, w, 0.3);
   return fade(norm(out, 0.7), sr, 0.002, 0.2);
}
function consRepair(sr, r) {
   const n = Math.floor(0.9 * sr), out = new Float32Array(n);
   lay(out, sr, metal(Math.floor(0.4 * sr), sr, r, 330, 7, 0.09), 0.8);
   lay(out, sr, metal(Math.floor(0.4 * sr), sr, r, 290, 7, 0.11), 0.8, 0.2);
   lay(out, sr, tick(sr, r, 1700, 0.004), 0.5); lay(out, sr, tick(sr, r, 1700, 0.004), 0.5, 0.2);
   const st = white(n, r);
   svf(st, sr, BP, 3500, 1); shape(st, sr, ar(0.03, 0.14));
   lay(out, sr, st, 0.3, 0.36);
   return fade(svf(norm(out, 0.65), sr, LP, 4500, 0.7), sr, 0.0005, 0.08);
}
function consRadar(sr, r) {
   const n = Math.floor(0.9 * sr), out = new Float32Array(n);
   const w = white(n, r);
   svf(w, sr, BP, t => 700 + 1700 * Math.min(1, t / 0.6), 9); shape(w, sr, swell(0.1, 0.5, 0.1));
   lay(out, sr, w, 0.8);
   lay(out, sr, tick(sr, r, 1400, 0.004), 0.5); lay(out, sr, tick(sr, r, 1400, 0.004), 0.5, 0.66);
   return fade(norm(out, 0.6), sr, 0.001, 0.1);
}

// ---------------------------------------------------------------- submarine
function pingCore(sr, r, f, tau) {
   const n = Math.floor(tau * 7 * sr), x = new Float32Array(n);
   let p1 = 0, p2 = 0, p3 = 0;
   for (let i = 0; i < n; i++) {
      const t = i / sr, ff = f * (1 + 0.04 * Math.exp(-t / 0.012)), e = Math.min(1, t / 0.004) * Math.exp(-t / tau);
      p1 += TAU * ff / sr; p2 += TAU * ff * 1.006 / sr; p3 += TAU * ff * 2.01 / sr;
      x[i] = (Math.sin(p1) + 0.7 * Math.sin(p2) + 0.13 * Math.sin(p3) * Math.exp(-t / (tau * 0.4))) * e;
   }
   return norm(x, 1);
}
function sonar(sr, r, f = 1180, len = 5.2, tau = 0.3) {
   const n = Math.floor(len * sr), out = new Float32Array(n);
   const p = pingCore(sr, r, f, tau), dark = svf(Float32Array.from(p), sr, LP, f * 1.1, 0.7), darker = svf(Float32Array.from(p), sr, LP, f * 0.7, 0.7);
   mix(out, p, 1);
   for (let k = 0; k < 46; k++) {
      const at = 0.09 + Math.pow(r(), 1.4) * (len - 1.6), g = 0.42 * Math.exp(-at / 1.15) * (0.5 + 0.5 * r());
      mix(out, at < 1 ? dark : darker, g, Math.floor(at * sr));
   }
   return fade(norm(out, 0.8), sr, 0.001, 0.5);
}
function depthCharge(sr, r) {
   const n = Math.floor(6 * sr), out = new Float32Array(n);
   const c = white(Math.floor(0.06 * sr), r);
   shape(c, sr, dec(0.003));
   lay(out, sr, c, 0.5);
   lay(out, sr, drive(sweep(n, sr, 50, 20, 0.35, ar(0.006, 1.3)), 2.8), 1.5);
   [[0.32, 0.6], [0.58, 0.4], [0.8, 0.25]].forEach(([at, g]) => lay(out, sr, sweep(Math.floor(1.5 * sr), sr, 42, 24, 0.2, ar(0.02, 0.25)), g, at));
   const rum = brown(n, r);
   svf(rum, sr, LP, expo(320, 60, 1.0), 0.7); mul(rum, lfn(n, sr, 3, r), 0.4, 1.2); shape(rum, sr, ar(0.03, 1.8));
   lay(out, sr, rum, 1.0);
   lay(out, sr, bubbles(n, sr, r, 50, 0.6, 4.5), 0.12);
   svf(out, sr, LP, 520, 0.7);
   return fade(norm(drive(out, 1.5), 0.93), sr, 0.0005, 0.6);
}
// dive klaxon, two "ah-OO-gah" blasts: a motor-driven diaphragm spinning up, holding, running down
function klaxon(sr, r) {
   const one = 1.12, n = Math.floor((one * 2 + 0.35) * sr), out = new Float32Array(n), m = Math.floor(one * sr);
   const f = t => (t < 0.2 ? 150 + 300 * Math.pow(t / 0.2, 0.6) : t < 0.74 ? 450 + 6 * Math.sin(TAU * 7 * t) : 450 - 265 * Math.pow((t - 0.74) / (one - 0.74), 0.8));
   const env = t => Math.min(1, t / 0.025) * Math.min(1, (one - t) / 0.06);
   for (let k = 0; k < 2; k++) {
      const s = saw(m, sr, f, env);
      // rasp: the diaphragm rattles at half the tone frequency
      let ph = 0;
      for (let i = 0; i < m; i++) { ph += f(i / sr) * 0.5 / sr; s[i] *= 0.68 + 0.32 * (ph % 1 < 0.5 ? 1 : -0.4); }
      const a = Float32Array.from(s), b = Float32Array.from(s);
      svf(a, sr, BP, 980, 3.5); svf(b, sr, BP, 2350, 4.5); svf(s, sr, LP, 1300, 0.8);
      mix(a, b, 0.55); mix(a, s, 0.5);
      lay(out, sr, drive(norm(a, 1), 1.8), 1, k * (one + 0.16));
   }
   return fade(norm(out, 0.8), sr, 0.001, 0.05);
}
function ballastVent(sr, r) {
   const n = Math.floor(3.8 * sr), out = new Float32Array(n);
   const air = white(n, r);
   svf(air, sr, BP, expo(4200, 1200, 1.0), 0.7); mul(air, lfn(n, sr, 14, r), 0.7, 1); shape(air, sr, swell(0.05, 1.1, 0.8));
   lay(out, sr, air, 0.9);
   const w = brown(n, r);
   svf(w, sr, LP, 750, 0.7); mul(w, lfn(n, sr, 5, r), 0.4, 1); shape(w, sr, ar(0.5, 1.4));
   lay(out, sr, w, 0.9);
   lay(out, sr, bubbles(n, sr, r, 90, 0.3, 3.3), 0.35);
   return fade(norm(out, 0.8), sr, 0.005, 0.5);
}
function surfacing(sr, r) {
   const n = Math.floor(4.8 * sr), out = new Float32Array(n);
   const air = white(n, r);
   svf(air, sr, BP, t => 1500 + 2100 * Math.min(1, t / 1.6), 1); mul(air, lfn(n, sr, 16, r), 0.7, 1); shape(air, sr, swell(0.1, 1.7, 0.4));
   lay(out, sr, air, 0.8);
   const low = brown(n, r);
   svf(low, sr, LP, 380, 0.7); mul(low, lfn(n, sr, 4, r), 0.4, 1); shape(low, sr, swell(0.3, 2.2, 0.7));
   lay(out, sr, low, 0.8);
   lay(out, sr, bubbles(n, sr, r, 60, 0.2, 2.3), 0.3);
   const wash = pink(n, r);
   svf(wash, sr, BP, t => 600 + 1300 * Math.min(1, t / 0.6), 0.6); shape(wash, sr, ar(0.3, 0.95));
   lay(out, sr, wash, 1, 2.2);
   lay(out, sr, sweep(Math.floor(1.2 * sr), sr, 80, 36, 0.12, ar(0.02, 0.3)), 0.7, 2.25);
   const drip = white(n, r);
   svf(drip, sr, HP, 2500, 0.7); mul(drip, lfn(n, sr, 40, r), 0, 1); shape(drip, sr, t => (t < 2.6 ? 0 : ar(0.3, 0.9)(t - 2.6)));
   lay(out, sr, drip, 0.35);
   return fade(norm(out, 0.85), sr, 0.005, 0.5);
}

// ---------------------------------------------------------------- loops (ambience, engine)
function seaLoop(sr, r) {
   const dur = 10, xf = 1, n = Math.floor((dur + xf) * sr);
   const x = brown(n, r);
   svf(x, sr, LP, 650, 0.7); mul(x, lfn(n, sr, 0.9, r), 0.55, 1);
   norm(x, 0.8);
   const wash = pink(n, r);
   svf(wash, sr, BP, 1150, 0.5);
   const sw = lfn(n, sr, 0.42, r);
   for (let i = 0; i < n; i++) wash[i] *= Math.pow(sw[i], 2.2);
   lay(x, sr, wash, 0.55);
   return norm(loopable(x, sr, xf), 0.8);
}
function windLoop(sr, r) {
   const dur = 9, xf = 1, n = Math.floor((dur + xf) * sr);
   const x = pink(n, r), c = lfn(n, sr, 0.35, r);
   svf(x, sr, BP, t => 300 + 650 * c[Math.min(n - 1, Math.floor(t * sr))], 1.3);
   mul(x, lfn(n, sr, 0.6, r), 0.35, 1);
   const h = white(n, r), c2 = lfn(n, sr, 0.5, r);
   svf(h, sr, BP, t => 520 + 480 * c2[Math.min(n - 1, Math.floor(t * sr))], 14);
   const g = lfn(n, sr, 0.45, r);
   for (let i = 0; i < n; i++) h[i] *= Math.pow(g[i], 3);
   lay(x, sr, h, 0.5);
   return norm(loopable(x, sr, xf), 0.8);
}
function rainLoop(sr, r) {
   const dur = 5, xf = 0.5, n = Math.floor((dur + xf) * sr);
   const x = white(n, r);
   svf(x, sr, HP, 1700, 0.7); svf(x, sr, LP, 8500, 0.7); mul(x, lfn(n, sr, 2, r), 0.75, 1);
   norm(x, 0.6);
   lay(x, sr, svf(ticks(n, sr, r, 900, 0, dur + xf, 0.0015), sr, BP, 3200, 0.8), 0.5);
   return norm(loopable(x, sr, xf), 0.8);
}
function washLoop(sr, r) {
   const dur = 7, xf = 0.8, n = Math.floor((dur + xf) * sr);
   const x = pink(n, r);
   svf(x, sr, BP, 950, 0.5); mul(x, lfn(n, sr, 0.8, r), 0.55, 1);
   norm(x, 0.8);
   const low = brown(n, r);
   svf(low, sr, LP, 260, 0.7); mul(low, lfn(n, sr, 1.1, r), 0.5, 1);
   lay(x, sr, low, 0.6);
   return norm(loopable(x, sr, xf), 0.8);
}
// turbine + reduction gear + shaft: partials sit on multiples of 1/dur so the loop is seamless
function engineLoop(sr, r) {
   const dur = 4, n = Math.floor(dur * sr), x = new Float32Array(n);
   const parts = [[27.5, 1], [41.25, 0.5], [55, 0.8], [82.5, 0.55], [110, 0.35], [137.5, 0.22], [165, 0.2], [220, 0.1], [412.5, 0.035], [618.75, 0.02]];
   for (const [f, a] of parts) {
      const ph = r() * TAU;
      for (let i = 0; i < n; i++) x[i] += Math.sin(TAU * f * i / sr + ph) * a;
   }
   // blade-rate throb + machinery air
   for (let i = 0; i < n; i++) x[i] *= 0.8 + 0.2 * Math.sin(TAU * 6.75 * i / sr);
   norm(x, 0.8);
   const m = Math.floor((dur + 0.5) * sr), air = pink(m, r);
   svf(air, sr, BP, 230, 0.6);
   for (let i = 0; i < m; i++) air[i] *= 0.7 + 0.3 * Math.sin(TAU * 6.75 * i / sr);
   mix(x, norm(loopable(air, sr, 0.5), 1), 0.3);
   const wh = white(m, r);
   svf(wh, sr, BP, 1250, 14);
   mix(x, norm(loopable(wh, sr, 0.5), 1), 0.035);
   return norm(x, 0.8);
}
function fireLoop(sr, r) {
   const dur = 5, xf = 0.5, n = Math.floor((dur + xf) * sr);
   const x = svf(ticks(n, sr, r, 260, 0, dur + xf, 0.0018), sr, BP, 2400, 0.6);
   norm(x, 0.8);
   lay(x, sr, svf(ticks(n, sr, r, 40, 0, dur + xf, 0.006), sr, BP, 900, 0.8), 0.6);
   const roar = brown(n, r), fl = lfn(n, sr, 11, r);
   svf(roar, sr, LP, 480, 0.7); mul(roar, fl, 0.45, 1);
   lay(x, sr, roar, 0.75);
   const hiss = pink(n, r);
   svf(hiss, sr, BP, 1500, 0.5); mul(hiss, lfn(n, sr, 7, r), 0.4, 1);
   lay(x, sr, hiss, 0.25);
   return norm(loopable(x, sr, xf), 0.8);
}
// inside a submerged boat: electric motors and a creaking pressure hull
function subLoop(sr, r) {
   const dur = 10, n = Math.floor(dur * sr), x = new Float32Array(n);
   for (const [f, a] of [[50, 1], [100, 0.55], [150, 0.3], [200, 0.12], [300, 0.1], [620, 0.03]]) {
      const ph = r() * TAU;
      for (let i = 0; i < n; i++) x[i] += Math.sin(TAU * f * i / sr + ph) * a * (0.9 + 0.1 * Math.sin(TAU * 0.3 * i / sr));
   }
   norm(x, 0.5);
   const m = Math.floor((dur + 1) * sr), w = brown(m, r);
   svf(w, sr, LP, 210, 0.7); mul(w, lfn(m, sr, 0.7, r), 0.5, 1);
   mix(x, norm(loopable(w, sr, 1), 1), 0.35);
   for (const at of [1.1, 3.9, 6.3]) {
      const f0 = 60 + r() * 60;
      lay(x, sr, groan(sr, r, 0.9 + r() * 1.2, f0, f0 * (0.75 + r() * 0.5)), 0.3 + 0.15 * r(), at + r() * 0.6);
   }
   lay(x, sr, metal(Math.floor(0.6 * sr), sr, r, 420, 6, 0.1), 0.12, 8.3);
   return norm(x, 0.8);
}

// ---------------------------------------------------------------- modern mode (missiles)
// rocket motor lighting off and tearing away: crack, roar sweeping up, long hiss fading out
function mslLaunch(sr, r) {
   const n = Math.floor(2.6 * sr), out = new Float32Array(n);
   const roar = white(n, r);
   svf(roar, sr, BP, t => 420 + 2300 * Math.min(1, t / 0.35) * Math.exp(-t / 1.1), 0.7); shape(roar, sr, ar(0.03, 0.75));
   lay(out, sr, roar, 1);
   const low = brown(n, r);
   svf(low, sr, LP, 170, 0.7); shape(low, sr, ar(0.02, 0.5));
   lay(out, sr, low, 0.8);
   lay(out, sr, sweep(Math.floor(0.4 * sr), sr, 190, 70, 0.05, ar(0.002, 0.07)), 0.7);
   const hiss = white(n, r);
   svf(hiss, sr, BP, expo(5200, 1700, 0.6), 0.5); shape(hiss, sr, ar(0.12, 0.9));
   lay(out, sr, hiss, 0.4, 0.08);
   return fade(norm(drive(out, 1.4), 0.85), sr, 0.001, 0.3);
}
// rotary cannon: about 70 rounds a second melt into one tearing burr
function ciwsBurr(sr, r) {
   const dur = 0.95, n = Math.floor(dur * sr), out = new Float32Array(n), f = 72;
   const w = white(n, r);
   for (let i = 0; i < n; i++) { const ph = (i / sr * f) % 1; w[i] *= Math.exp(-ph * 7); }
   svf(w, sr, BP, 1500, 0.6);
   lay(out, sr, w, 1);
   const s = saw(n, sr, f, null);
   svf(s, sr, LP, 520, 0.8);
   lay(out, sr, s, 0.75);
   const b = brown(n, r);
   svf(b, sr, LP, 140, 0.7);
   lay(out, sr, b, 0.3);
   shape(out, sr, t => (t < 0.02 ? t / 0.02 : t > dur - 0.12 ? Math.max(0, (dur - t) / 0.12) : 1));
   return norm(drive(out, 1.6), 0.8);
}
// missile warning: two rising electronic notes, clear but soft-edged
function vampireTone(sr, r) {
   const n = Math.floor(0.86 * sr), out = new Float32Array(n);
   for (const at of [0, 0.4]) {
      const m = Math.floor(0.34 * sr), env = t => Math.min(1, t / 0.012) * Math.min(1, (0.34 - t) / 0.06);
      const a = sweep(m, sr, 590, 880, 0.16, env), b = sweep(m, sr, 1180, 1760, 0.16, env);
      mix(a, b, 0.22);
      mix(out, a, 1, Math.floor(at * sr));
   }
   const hz = white(n, r);
   svf(hz, sr, BP, 2400, 2); shape(hz, sr, t => 0.02);
   mix(out, hz, 1);
   return fade(norm(out, 0.6), sr, 0.002, 0.03);
}
// decoy mortars: two dull thumps, then the cloud fizzing open
function decoyPop(sr, r) {
   const n = Math.floor(1.3 * sr), out = new Float32Array(n);
   for (const at of [0, 0.13]) {
      lay(out, sr, sweep(Math.floor(0.3 * sr), sr, 210, 75, 0.04, ar(0.002, 0.06)), 0.9, at);
      const c = white(Math.floor(0.12 * sr), r);
      svf(c, sr, BP, 1700, 0.7); shape(c, sr, ar(0.001, 0.02));
      lay(out, sr, c, 0.5, at);
   }
   const fz = white(n, r);
   svf(fz, sr, BP, expo(6500, 3000, 0.4), 0.6); shape(fz, sr, t => (t < 0.3 ? 0 : Math.min(1, (t - 0.3) / 0.08) * Math.exp(-(t - 0.3) / 0.3)));
   lay(out, sr, fz, 0.3);
   return fade(norm(out, 0.8), sr, 0.001, 0.2);
}

// ---------------------------------------------------------------- registry
// div 2 = rendered at half the sample rate (dark material: tails, rumbles, loops).
const R = {};
const def = (name, div, make) => { R[name] = { div, make }; };
const stereo = fn => (sr, r) => [fn(sr, r), fn(sr, r)];
export const GUN_CLASSES = [{ cal: 127, h: 0.08 }, { cal: 152, h: 0.17 }, { cal: 203, h: 0.33 }, { cal: 305, h: 0.64 }, { cal: 406, h: 0.96 }];
GUN_CLASSES.forEach((g, i) => {
   def('gun' + i + 'a', 1, (sr, r) => gunShot(sr, r, g.h));
   def('gun' + i + 'b', 1, (sr, r) => gunShot(sr, r, g.h));
   def('tail' + i, 2, (sr, r) => gunTail(sr, r, g.h));
});
[0.1, 0.5, 1].forEach((s, i) => { def('far' + i + 'a', 2, (sr, r) => farBoom(sr, r, s)); def('far' + i + 'b', 2, (sr, r) => farBoom(sr, r, s)); });
def('splashA', 1, (sr, r) => splash(sr, r, false)); def('splashB', 1, (sr, r) => splash(sr, r, false));
def('splashBigA', 1, (sr, r) => splash(sr, r, true)); def('splashBigB', 1, (sr, r) => splash(sr, r, true));
def('pen', 1, (sr, r) => pen(sr, r, false)); def('citadel', 1, (sr, r) => pen(sr, r, true));
def('overpen', 1, overpen); def('ricochetA', 1, (sr, r) => ricochet(sr, r, 0)); def('ricochetB', 1, (sr, r) => ricochet(sr, r, 1));
def('shatter', 1, shatter); def('he', 1, heBurst); def('explosionBig', 1, explosionBig); def('terrain', 1, terrain);
def('torpHit', 1, torpHit); def('detonation', 1, detonation); def('megaBlast', 2, megaBlast); def('sink', 2, sink);
def('hit', 1, (sr, r) => ownHit(sr, r, false)); def('hitBig', 1, (sr, r) => ownHit(sr, r, true));
def('whistle', 1, whistle); def('torpLaunch', 1, torpLaunch); def('reload', 1, reloadClank); def('thunder', 2, thunder);
def('fireStart', 1, (sr, r) => {
   const n = Math.floor(1.5 * sr), out = new Float32Array(n), w = white(n, r);
   svf(w, sr, BP, t => 320 + 1300 * Math.min(1, t / 0.5), 0.7); shape(w, sr, ar(0.3, 0.45));
   lay(out, sr, w, 0.9);
   lay(out, sr, svf(ticks(n, sr, r, 30, 0.1, 1.3, 0.002), sr, BP, 2400, 0.7), 0.5);
   lay(out, sr, sweep(Math.floor(0.6 * sr), sr, 95, 55, 0.1, ar(0.05, 0.15)), 0.5);
   return fade(norm(out, 0.75), sr, 0.005, 0.2);
});
def('uiClick', 1, uiClick); def('uiLock', 1, uiLock); def('uiDenied', 1, uiDenied); def('uiAmmo', 1, uiAmmo); def('radio', 1, radio);
def('ribbonPen', 1, (sr, r) => ribbonTick(sr, r, [[640, 0.035, 1], [955, 0.03, 0.6], [1480, 0.02, 0.4]], 0.17));
def('ribbonRic', 1, (sr, r) => ribbonTick(sr, r, [[1250, 0.03, 1], [1840, 0.025, 0.6], [2700, 0.015, 0.4]], 0.13, 0.25));
def('ribbonCitadel', 1, ribbonCitadel); def('ribbonKill', 2, ribbonKill);
def('alertTorp', 1, (sr, r) => gong(sr, r, 392, 5, 0.2, 0.22));
def('torpPing', 1, (sr, r) => gong(sr, r, 330, 2, 0.19, 0.18));
def('alertFire', 1, (sr, r) => gong(sr, r, 830, 9, 0.085, 0.07));
def('alertFlood', 1, alertFlood);
def('alertCitadel', 1, (sr, r) => fade(norm(horn(sr, r, 233, 247, 2, 0.2, 0.09, 700, 1500), 0.7), sr, 0.002, 0.08));
def('alertSpotted', 1, alertSpotted);
def('objDone', 2, (sr, r) => objective(sr, r, 'done')); def('objFailed', 2, (sr, r) => objective(sr, r, 'failed')); def('objNew', 2, (sr, r) => objective(sr, r, 'new'));
def('victory', 2, (sr, r) => endCue(sr, r, true)); def('defeat', 2, (sr, r) => endCue(sr, r, false));
def('timpani', 2, (sr, r) => timpani(sr, r)); def('cello', 2, cello);
def('consSmoke', 1, consSmoke); def('consBoost', 2, consBoost); def('consRepair', 1, consRepair); def('consRadar', 1, consRadar);
def('consHydro', 1, (sr, r) => {
   // hydrophone switched on: relay click, water noise swelling in the headset, one soft ping
   const out = sonar(sr, r, 720, 1.8, 0.22), n = out.length;
   for (let i = 0; i < n; i++) out[i] *= 0.45;
   const w = pink(n, r);
   svf(w, sr, BP, expo(300, 900, 0.5), 0.8); mul(w, lfn(n, sr, 7, r), 0.5, 1); shape(w, sr, swell(0.25, 0.7, 0.3));
   lay(out, sr, w, 0.5);
   lay(out, sr, tick(sr, r, 1400, 0.004), 0.5);
   return fade(norm(out, 0.75), sr, 0.001, 0.3);
});
def('klaxon', 1, klaxon); def('ballast', 1, ballastVent); def('surfacing', 1, surfacing);
def('sonar', 1, (sr, r) => sonar(sr, r)); def('depthCharge', 2, depthCharge);
def('mslLaunch', 1, mslLaunch); def('ciws', 1, ciwsBurr); def('vampire', 1, vampireTone); def('decoyPop', 1, decoyPop);
def('loopSea', 2, stereo(seaLoop)); def('loopWind', 2, stereo(windLoop)); def('loopRain', 1, stereo(rainLoop));
def('loopWash', 2, stereo(washLoop)); def('loopEngine', 2, engineLoop); def('loopFire', 1, fireLoop); def('loopSub', 2, subLoop);

export const SOUND_NAMES = Object.keys(R);

export function render(name, sr) {
   const d = R[name];
   if (!d) return null;
   const rate = Math.round(sr / d.div);
   const res = d.make(rate, mulberry(hash(name)));
   return { ch: Array.isArray(res) ? res : [res], sr: rate };
}

// Open sea: no walls, so no dense early reflections -- a short pre-delay, a few slaps off the
// water and a long, dark, diffuse roll. High frequencies die first.
export function impulse(sr) {
   const len = 3.4, n = Math.floor(len * sr), out = [];
   for (let c = 0; c < 2; c++) {
      const r = mulberry(7331 + c * 97), x = white(n, r), pre = Math.floor((0.035 + c * 0.006) * sr);
      svf(x, sr, LP, expo(5200, 420, 0.55), 0.7);
      svf(x, sr, HP, 110, 0.7);
      for (let i = 0; i < n; i++) x[i] = i < pre ? 0 : x[i] * Math.min(1, (i - pre) / (0.05 * sr)) * Math.exp(-(i - pre) / (0.72 * sr));
      for (let k = 0; k < 5; k++) {
         const at = Math.floor((0.05 + r() * 0.24) * sr), g = (0.5 + 0.5 * r()) * (r() < 0.5 ? -1 : 1) * 2.5;
         for (let i = 0; i < 40 && at + i < n; i++) x[at + i] += g * (1 - i / 40) * (r() * 2 - 1);
      }
      out.push(fade(norm(x, 0.9), sr, 0, 0.4));
   }
   return out;
}
