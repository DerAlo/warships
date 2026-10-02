// tests/playwright3d.audio.mjs -- measures the 3D mode's sound instead of listening to it.
// Part A renders every sound through the real mixing desk (game3d/audio.js) in an
// OfflineAudioContext and checks level, spectrum and duration. Part B plays the 16-ship fleet
// battle with a live AudioContext, taps the output and checks voice cap, frame time and console.
// A few WAV files are written to tests/shots/ (gitignored) for listening.
// Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8781   then   URL3D=http://localhost:8781/index-3d.html node tests/playwright3d.audio.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:8781/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const errors = [], results = [], wavs = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const db = v => (v > 0 ? +(20 * Math.log10(v)).toFixed(1) : -999);

const gpu = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: [...gpu, '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
async function waitFor(fn, timeout = 8000, step = 50) {
   const t0 = Date.now();
   while (Date.now() - t0 < timeout) { if (await ev(fn)) return true; await wait(step); }
   return false;
}

await page.goto(URL, { waitUntil: 'load' });
await wait(600);

// ------------------------------------------------------------------ part A: offline measurements
// window.__au.run(steps, seconds, wav) renders a scenario and returns its measurements.
// steps: [[time, method, ...args]] executed at that context time on a fresh Audio instance.
await ev(async () => {
   const { Audio, MAX_VOICES, MAX_SOURCES } = await import('/game3d/audio.js');
   const SR = 48000;
   function fft(re, im) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
         let bit = n >> 1;
         for (; j & bit; bit >>= 1) j ^= bit;
         j ^= bit;
         if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let len = 2; len <= n; len <<= 1) {
         const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
         for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
               const a = i + k, b = a + len / 2;
               const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
               re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
               const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
            }
         }
      }
   }
   function analyse(L, R) {
      const n = L.length;
      let peak = 0, sum = 0, bad = 0;
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++) {
         const l = L[i], r = R[i];
         if (!Number.isFinite(l) || !Number.isFinite(r)) { bad++; continue; }
         const a = Math.max(Math.abs(l), Math.abs(r));
         if (a > peak) peak = a;
         sum += (l * l + r * r) / 2; m[i] = (l + r) / 2;
      }
      // audible span: first / last 20 ms window above -50 dBFS RMS
      const w = 960, thr = 0.00316 * 0.00316;
      let first = -1, last = -1;
      for (let i = 0; i + w <= n; i += w) {
         let e = 0;
         for (let k = i; k < i + w; k++) e += m[k] * m[k];
         if (e / w > thr) { if (first < 0) first = i; last = i + w; }
      }
      // spectrum of the whole sound
      let N = 1; while (N < n) N <<= 1;
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < n; i++) re[i] = m[i];
      fft(re, im);
      let tot = 0, lo = 0, hi = 0, cen = 0, maxP = 0, maxK = 0;
      const pw = new Float64Array(N / 2), hz = SR / N;
      for (let k = 1; k < N / 2; k++) {
         const p = re[k] * re[k] + im[k] * im[k], f = k * hz;
         pw[k] = p; tot += p; cen += p * f;
         if (f < 120) lo += p;
         if (f > 2000) hi += p;
         if (p > maxP) { maxP = p; maxK = k; }
      }
      // share of the energy within +-12 Hz of the strongest partial: ~1 for a pure sine
      let tone = 0; const span = Math.max(2, Math.round(12 / hz));
      for (let k = Math.max(1, maxK - span); k <= Math.min(N / 2 - 1, maxK + span); k++) tone += pw[k];
      let lr = 0; for (let i = 0; i < n; i++) lr += L[i] * L[i] - R[i] * R[i];
      return { peak, rms: Math.sqrt(sum / n), bad, start: first < 0 ? -1 : first / SR, dur: first < 0 ? 0 : (last - first) / SR, end: last / SR,
         low: tot ? lo / tot : 0, high: tot ? hi / tot : 0, centroid: tot ? cen / tot : 0, tone: tot ? tone / tot : 0, toneHz: maxK * hz,
         balance: sum ? lr / (2 * sum) : 0 };
   }
   function wav16(L, R, upTo) {
      const n = Math.min(L.length, Math.ceil(upTo * SR)), b = new DataView(new ArrayBuffer(44 + n * 4));
      const str = (o, s) => { for (let i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
      str(0, 'RIFF'); b.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 2, true);
      b.setUint32(24, SR, true); b.setUint32(28, SR * 4, true); b.setUint16(32, 4, true); b.setUint16(34, 16, true); str(36, 'data'); b.setUint32(40, n * 4, true);
      for (let i = 0; i < n; i++) {
         b.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
         b.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
      }
      const u = new Uint8Array(b.buffer); let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      return btoa(s);
   }
   // one shared buffer cache: the synth is deterministic, re-rendering per scenario is wasted time
   const cache = new Map();
   async function run(steps, seconds, wav = false, setup = null) {
      const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
      const a = new Audio();
      if (setup) for (const s of setup) a[s[0]](...s.slice(1));   // settings made before the first gesture
      a.init(ctx);
      if (!a.ctx) throw new Error('audio init failed');
      const own = a._buf.bind(a);
      a._buf = name => { let b = cache.get(name); if (!b) { b = own(name); cache.set(name, b); } return b; };
      let maxVoices = 0;
      const byT = new Map();
      for (const s of steps) { const t = Math.round(s[0] * SR / 128) * 128 / SR; if (t > seconds - 0.02) continue; if (!byT.has(t)) byT.set(t, []); byT.get(t).push(s); }
      const exec = list => { for (const s of list) a[s[1]](...s.slice(2)); maxVoices = Math.max(maxVoices, a.stats().voices); };
      for (const [t, list] of byT) {
         if (t <= 0) exec(list);
         else ctx.suspend(t).then(() => { exec(list); ctx.resume(); });
      }
      const buf = await ctx.startRendering();
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      const res = analyse(L, R);
      res.stats = a.stats(); res.maxVoices = maxVoices;
      if (wav) res.wav = wav16(L, R, Math.min(seconds, res.end + 0.3));
      return res;
   }
   window.__au = { run, MAX_VOICES, MAX_SOURCES };
});
const run = async (name, steps, seconds, { wav = false, setup = null } = {}) => {
   const r = await ev(([steps, seconds, wav, setup]) => window.__au.run(steps, seconds, wav, setup), [steps, seconds, wav, setup]);
   if (r.wav) { const f = `${OUT}/audio-${name}.wav`; writeFileSync(f, Buffer.from(r.wav, 'base64')); wavs.push(f); delete r.wav; }
   return r;
};
const line = r => `peak ${db(r.peak)} dBFS  rms ${db(r.rms)}  dur ${r.dur.toFixed(2)} s  <120Hz ${(r.low * 100).toFixed(0)}%  >2kHz ${(r.high * 100).toFixed(1)}%  centroid ${r.centroid.toFixed(0)} Hz`;
const sane = (name, r) => check(`${name}: audible, finite, below 0 dBFS`, r.bad === 0 && r.peak > 0.02 && r.peak < 0.999, line(r));

// --- main guns by calibre (own guns, full salvo)
const g406 = await run('gun-406-own', [[0.05, 'mainGun', 406, 9, 0]], 9, { wav: true });
const g203 = await run('gun-203-own', [[0.05, 'mainGun', 203, 8, 0]], 9, { wav: true });
const g127 = await run('gun-127-own', [[0.05, 'mainGun', 127, 6, 0]], 9, { wav: true });
sane('406 mm salvo', g406); sane('203 mm salvo', g203); sane('127 mm salvo', g127);
check('406 mm: substantial energy below 120 Hz', g406.low > 0.35, `${(g406.low * 100).toFixed(0)}%`);
check('406 mm: tail longer than 1.5 s', g406.dur > 1.5, `${g406.dur.toFixed(2)} s`);
check('calibres differ: spectral centroid 406 < 203 < 127', g406.centroid < g203.centroid * 0.8 && g203.centroid < g127.centroid * 0.8,
   `${g406.centroid.toFixed(0)} / ${g203.centroid.toFixed(0)} / ${g127.centroid.toFixed(0)} Hz`);
check('calibres differ: duration 406 > 203 > 127', g406.dur > g203.dur * 1.15 && g203.dur > g127.dur * 1.15,
   `${g406.dur.toFixed(2)} / ${g203.dur.toFixed(2)} / ${g127.dur.toFixed(2)} s`);
check('calibres differ: low-end share 406 > 203 > 127', g406.low > g203.low && g203.low > g127.low,
   `${(g406.low * 100).toFixed(0)} / ${(g203.low * 100).toFixed(0)} / ${(g127.low * 100).toFixed(0)} %`);

// --- distance: delayed, quieter, muffled; panned by bearing
const far = await run('gun-406-12km', [[0.05, 'mainGun', 406, 9, 12000]], 10, { wav: true });
const mid = await run('gun-203-3km', [[0.05, 'mainGun', 203, 8, 3000]], 9, { wav: true });
sane('406 mm at 12 km', far); sane('203 mm at 3 km', mid);
check('distant shot arrives late (sound travel)', far.start > 2 && mid.start > 1.5 && g406.start < 0.2, `own ${g406.start.toFixed(2)} s, 3 km ${mid.start.toFixed(2)} s, 12 km ${far.start.toFixed(2)} s`);
check('distant shot has less high-frequency energy', far.high < g406.high * 0.25 && mid.high < g203.high * 0.6,
   `406: ${(g406.high * 100).toFixed(2)}% -> ${(far.high * 100).toFixed(3)}%, 203: ${(g203.high * 100).toFixed(2)}% -> ${(mid.high * 100).toFixed(2)}%`);
check('distant shot is quieter', far.rms < g406.rms * 0.5, `${db(g406.rms)} -> ${db(far.rms)} dB rms`);
const right = await run('pan-right', [[0.05, 'mainGun', 203, 8, 3000, { x: 0, y: 3000 }]], 6, { setup: [['setListener', 0, 0, 0]] });
const left = await run('pan-left', [[0.05, 'mainGun', 203, 8, 3000, { x: 0, y: -3000 }]], 6, { setup: [['setListener', 0, 0, 0]] });
check('stereo pan follows the bearing relative to the camera', right.balance < -0.2 && left.balance > 0.2, `starboard ${right.balance.toFixed(2)}, port ${left.balance.toFixed(2)} (L-R energy)`);

// --- impacts and world one-shots
const P = { x: 300, y: 0 };
const oneShots = {
   'splash-near': [['splash', 150, false, P], 4], 'splash-big-near': [['splash', 150, true, P], 5], 'splash-far': [['splash', 6000, true, P], 9],
   pen: [['impact', 'pen', 300, P], 4], citadel: [['impact', 'citadel', 300, P], 5], overpen: [['impact', 'overpen', 300, P], 4],
   ricochet: [['impact', 'ricochet', 300, P], 4], shatter: [['impact', 'shatter', 300, P], 4], he: [['impact', 'he', 300, P], 5],
   terrain: [['impact', 'terrain', 300, P], 4], 'torp-hit': [['impact', 'torpHit', 400, P], 8], detonation: [['impact', 'detonation', 800, P], 12],
   sink: [['sink', 500, P], 14], 'own-hit': [['hit', false, 'pen'], 4], 'own-hit-heavy': [['hit', true, 'citadel'], 5], 'own-hit-torp': [['hit', true, 'torp'], 8],
   'fire-start': [['fireStart'], 4], whistle: [['whistle', 0], 4], secondary: [['secondary', 0], 4], 'secondary-far': [['secondary', 5000, P], 9],
   'torp-launch': [['torpLaunch', 3], 5], reload: [['reloaded'], 3], 'explosion-big': [['explosion', true, 500, P], 8], thunder: [['alert', 'storm'], 10],
};
const WAV = new Set(['splash-big-near', 'pen', 'citadel', 'ricochet', 'torp-hit', 'detonation', 'sink', 'own-hit-heavy']);
const os = {};
for (const [name, [call, sec]] of Object.entries(oneShots)) {
   os[name] = await run(name, [[0.05, ...call]], sec, { wav: WAV.has(name) });
   sane(name, os[name]);
}
check('big splash is heavier than a small one', os['splash-big-near'].centroid < os['splash-near'].centroid && os['splash-big-near'].dur > os['splash-near'].dur,
   `${os['splash-big-near'].centroid.toFixed(0)} vs ${os['splash-near'].centroid.toFixed(0)} Hz, ${os['splash-big-near'].dur.toFixed(2)} vs ${os['splash-near'].dur.toFixed(2)} s`);
check('far splash is muffled and late', os['splash-far'].high < os['splash-big-near'].high * 0.3 && os['splash-far'].start > 2);
check('ricochet is brighter than a penetration', os.ricochet.centroid > os.pen.centroid * 1.3, `${os.ricochet.centroid.toFixed(0)} vs ${os.pen.centroid.toFixed(0)} Hz`);
check('magazine detonation: long and bass-heavy', os.detonation.dur > 4 && os.detonation.low > 0.3, line(os.detonation));
check('torpedo hit: bass-heavy', os['torp-hit'].low > 0.3 && os['torp-hit'].dur > 1.5, line(os['torp-hit']));
check('sinking: long groan', os.sink.dur > 5, `${os.sink.dur.toFixed(1)} s`);

// --- interface: short, quiet, never a bare sine
const ui = {
   'ui-click': [['uiClick'], 0.5], 'ui-lock': [['lock'], 0.7], 'ui-denied': [['denied'], 0.7], 'ui-ammo': [['ammoSwitch'], 0.9],
   'ribbon-pen': [['ribbon', 'pen'], 0.7], 'ribbon-ricochet': [['ribbon', 'ricochet'], 0.7], 'ribbon-citadel': [['ribbon', 'citadel'], 1.2], 'ribbon-kill': [['ribbon', 'kill'], 2.5],
   radio: [['radio'], 1.2], 'torp-ping': [['torpWarning'], 1.3], 'alert-torp': [['alert', 'torp'], 3.5], 'alert-fire': [['alert', 'fire'], 2.5],
   'alert-flood': [['alert', 'flood'], 3], 'alert-citadel': [['alert', 'citadel'], 2], 'alert-spotted': [['spottedAlarm'], 2.5],
   'objective-done': [['objective', 'done'], 3.5], 'objective-failed': [['objective', 'failed'], 3.5], 'objective-new': [['objective', 'new'], 2.5],
   'cons-smoke': [['consumable', 'smoke'], 3.5], 'cons-boost': [['consumable', 'boost'], 3.5], 'cons-repair': [['consumable', 'repair'], 3.5],
   'cons-radar': [['consumable', 'radar'], 3.5], 'cons-hydro': [['consumable', 'hydro'], 3.5],
};
const UIWAV = new Set(['ui-click', 'ui-lock', 'alert-torp', 'alert-fire', 'objective-done']);
let uiLoud = 0;
for (const [name, [call, maxDur]] of Object.entries(ui)) {
   const r = await run(name, [[0.05, ...call]], 6, { wav: UIWAV.has(name) });
   uiLoud = Math.max(uiLoud, r.peak);
   check(`${name}: short (< ${maxDur} s), not a pure sine, below 0 dBFS`, r.bad === 0 && r.peak > 0.01 && r.peak < 0.999 && r.dur > 0 && r.dur < maxDur && r.tone < 0.6,
      `dur ${r.dur.toFixed(2)} s  strongest partial ${(r.tone * 100).toFixed(0)}% at ${r.toneHz.toFixed(0)} Hz  peak ${db(r.peak)} dBFS`);
}
check('interface stays below the guns', uiLoud < g406.peak, `loudest UI ${db(uiLoud)} dBFS vs 406 mm ${db(g406.peak)} dBFS`);
for (const [name, v] of [['victory', true], ['defeat', false]]) {
   const r = await run(name, [[0.05, 'endCue', v]], 12, { wav: true });
   check(`${name} cue: audible, slow, not a pure sine`, r.bad === 0 && r.peak > 0.02 && r.peak < 0.999 && r.dur > 2.5 && r.tone < 0.6, line(r) + `  partial ${(r.tone * 100).toFixed(0)}%`);
}

// --- submarine interface
const subs = { 'sub-dive': [['subDive'], 8], 'sub-surface': [['subSurface'], 8], 'sonar-ping': [['sonarPing', 0], 8], 'sonar-ping-far': [['sonarPing', 3000], 9],
   'depth-charge': [['depthCharge', 200], 9], 'depth-charge-far': [['depthCharge', 3000], 10] };
const sb = {};
for (const [name, [call, sec]] of Object.entries(subs)) { sb[name] = await run(name, [[0.05, ...call]], sec, { wav: !name.endsWith('far') }); sane(name, sb[name]); }
check('depth charge: deep and muffled, weaker with distance', sb['depth-charge'].low > 0.4 && sb['depth-charge-far'].rms < sb['depth-charge'].rms * 0.6, line(sb['depth-charge']));
check('sonar ping at distance: later and quieter', sb['sonar-ping-far'].start > 1.5 && sb['sonar-ping-far'].rms < sb['sonar-ping'].rms * 0.7);
const subm = await run('gun-203-3km-submerged', [[0.05, 'mainGun', 203, 8, 800]], 8, { setup: [['setSubmerged', true]], wav: true });
const surf = await run('gun-203-800m', [[0.05, 'mainGun', 203, 8, 800]], 8);
check('setSubmerged(true) muffles the world', subm.high < surf.high * 0.1 && subm.peak > 0.005, `>2 kHz ${(surf.high * 100).toFixed(2)}% -> ${(subm.high * 100).toFixed(4)}%`);
const subSafe = await ev(async () => {
   const { Audio } = await import('/game3d/audio.js');
   const a = new Audio();   // no context yet: every call must be a silent no-op
   try { a.subDive(); a.subSurface(); a.sonarPing(500); a.sonarPing(); a.depthCharge(900); a.depthCharge(); a.setSubmerged(true); a.setSubmerged(false); a.setSubmerged(true);
      a.mainGun(406, 9, 0); a.impact('pen', 10); a.updateEngine(1, 2, false); a.updateAmbient(0.5, false, 'storm', 2); a.updateMusic(2); a.setVolumes(0.3, 0.4); a.setMuted(true);
      a.init(new OfflineAudioContext(2, 4800, 48000)); a.subDive(); a.setSubmerged(false); a.sonarPing(NaN); a.depthCharge(-5); return 'ok';
   } catch (e) { return String(e); }
});
check('submarine methods are safe before init and with odd arguments', subSafe === 'ok', subSafe);

// --- stress: 16 ships fire together twice, shells land, own salvo on top
const stress = [];
const cals = [406, 380, 356, 305, 203, 203, 152, 152, 127, 127, 127, 150, 283, 406, 203, 127];
for (let round = 0; round < 3; round++) {
   const t0 = 0.05 + round * 1.2;
   cals.forEach((c, i) => stress.push([t0 + (i % 4) * 0.011, 'mainGun', c, 8, 800 + i * 700, { x: Math.cos(i) * (800 + i * 700), y: Math.sin(i) * (800 + i * 700) }]));
   stress.push([t0, 'mainGun', 406, 9, 0]);
   for (let i = 0; i < 24; i++) stress.push([t0 + 0.3 + (i % 6) * 0.021, 'splash', 100 + i * 150, i % 2 === 0, { x: 200 - i * 30, y: 100 + i * 150 }]);
   for (let i = 0; i < 8; i++) stress.push([t0 + 0.4, 'impact', ['pen', 'he', 'ricochet', 'citadel', 'torpHit', 'detonation', 'overpen', 'shatter'][i], 200 + i * 300, { x: 300, y: i * 100 }, true]);
   stress.push([t0 + 0.45, 'hit', true, 'citadel'], [t0 + 0.45, 'alert', 'torp'], [t0 + 0.5, 'ribbon', 'citadel']);
}
const st = await run('stress-16-ships', stress, 12, { wav: true, setup: [['setListener', 0, 0, 0.4]] });
const caps = await ev(() => ({ v: window.__au.MAX_VOICES, s: window.__au.MAX_SOURCES }));
check('16 ships firing at once: no clipping, finite', st.bad === 0 && st.peak < 0.999 && st.peak > 0.2, line(st));
check('16 ships firing at once: voice cap holds', st.maxVoices <= caps.v && st.stats.peakSources <= caps.s,
   `voices ${st.maxVoices}/${caps.v}, sources peak ${st.stats.peakSources}/${caps.s}, played ${st.stats.played}, stolen ${st.stats.stolen}, dropped ${st.stats.dropped}`);

// --- ambience and music (per-frame updates driven at 20 Hz in context time)
const frames = (sec, calls) => { const s = []; for (let t = 0; t < sec; t += 0.05) for (const c of calls) s.push([t, ...c]); return s; };
const calm = await run('ambience-calm', frames(8, [['updateAmbient', 0.25, false, 'clear', 0], ['updateEngine', 3, 16, false, 0.25]]), 8, { setup: [['setVolumes', 0, 1]] });
const storm = await run('ambience-storm-full-ahead-burning', frames(10, [['updateAmbient', 0.95, false, 'storm', 2], ['updateEngine', 16, 16, false, 1]]), 10, { wav: true, setup: [['setVolumes', 0, 1]] });
sane('ambience, calm sea, slow ahead', calm); sane('ambience, storm, full ahead, two fires', storm);
check('storm is louder and brighter than a calm sea', storm.rms > calm.rms * 1.5 && storm.high > calm.high, `${db(calm.rms)} -> ${db(storm.rms)} dB rms, >2 kHz ${(calm.high * 100).toFixed(1)}% -> ${(storm.high * 100).toFixed(1)}%`);
check('ambience sits well below a gun salvo', calm.peak < g406.peak * 0.5 && storm.rms < 0.25, `calm peak ${db(calm.peak)} dBFS, storm rms ${db(storm.rms)} dB`);
const eng0 = await run('engine-stop', frames(5, [['updateEngine', 0, 16, false, 0]]), 5, { setup: [['setVolumes', 0, 1]] });
const eng1 = await run('engine-full', frames(5, [['updateEngine', 16, 16, false, 1]]), 5, { setup: [['setVolumes', 0, 1]], wav: true });
check('engine follows throttle and speed: louder and higher at full ahead', eng1.rms > eng0.rms * 1.4 && eng1.centroid > eng0.centroid * 1.1,
   `${db(eng0.rms)} -> ${db(eng1.rms)} dB rms, centroid ${eng0.centroid.toFixed(0)} -> ${eng1.centroid.toFixed(0)} Hz`);
const mus = {};
for (const lvl of [0, 2, 3]) {
   mus[lvl] = await run('music-level-' + lvl, frames(24, [['updateMusic', lvl]]), 24, { wav: lvl !== 0, setup: [['setVolumes', 1, 1]] });
   check(`music level ${lvl}: audible, dark (centroid < 500 Hz), below 0 dBFS`, mus[lvl].bad === 0 && mus[lvl].rms > 0.003 && mus[lvl].peak < 0.999 && mus[lvl].centroid < 500, line(mus[lvl]));
}
check('music intensifies with the battle', mus[2].rms > mus[0].rms * 1.2, `${db(mus[0].rms)} -> ${db(mus[2].rms)} -> ${db(mus[3].rms)} dB rms`);
const musOff = await run('music-volume-0', frames(8, [['updateMusic', 2]]), 8, { setup: [['setVolumes', 0, 1]] });
const sfxOff = await run('sfx-volume-0', [[0.05, 'mainGun', 406, 9, 0], [0.05, 'uiClick']], 5, { setup: [['setVolumes', 1, 0]] });
const muted = await run('muted', [[0.05, 'mainGun', 406, 9, 0]], 5, { setup: [['setMuted', true]] });
check('music volume 0 silences the music', musOff.peak < 1e-4, `peak ${musOff.peak.toExponential(1)}`);
check('effects volume 0 silences guns and interface', sfxOff.peak < 1e-4, `peak ${sfxOff.peak.toExponential(1)}`);
check('mute silences everything', muted.peak < 1e-4, `peak ${muted.peak.toExponential(1)}`);

// ------------------------------------------------------------------ part B: live battle, 16 ships
await ev(() => window.__start({ difficulty: 'normal', mission: 'fleet', ship: 'Bismarck' }));
await waitFor(() => window.__phase() === 'playing', 8000);
await page.mouse.move(720, 405);
await page.mouse.down(); await wait(60); await page.mouse.up();   // user gesture: unlocks the AudioContext
const live = await ev(async () => {
   const w = window.__world(), a = w.audio;
   a.init(); a.resume();
   for (let i = 0; i < 40 && a.ctx?.state !== 'running'; i++) await new Promise(r => setTimeout(r, 50));
   if (!a.ctx) return null;
   const an = a.ctx.createAnalyser(); an.fftSize = 2048; a.out.connect(an);
   const buf = new Float32Array(2048);
   const T = window.__audioTap = { peak: 0, sum: 0, n: 0, bad: 0, maxVoices: 0, maxSources: 0, dt: [], on: true, barrage: false, last: performance.now() };
   const tick = () => {
      if (!T.on) return;
      const now = performance.now(); T.dt.push(now - T.last); T.last = now;
      an.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i += 2) { const v = buf[i]; if (!Number.isFinite(v)) T.bad++; else { const x = Math.abs(v); if (x > T.peak) T.peak = x; T.sum += v * v; T.n++; } }
      const s = a.stats(); if (s.voices > T.maxVoices) T.maxVoices = s.voices; if (s.sources > T.maxSources) T.maxSources = s.sources;
      requestAnimationFrame(tick);
   };
   requestAnimationFrame(tick);
   return { ships: w.ships.length, state: a.ctx.state, sr: a.ctx.sampleRate };
});
check('live battle: 16 ships, AudioContext running', live && live.ships >= 16 && live.state === 'running', live);
// full ahead, then let the fleets engage; fire the own guns whenever they are loaded
await page.keyboard.press('KeyW'); await page.keyboard.press('KeyW'); await page.keyboard.press('KeyW'); await page.keyboard.press('KeyW');
const aimAndFire = async () => {
   await ev(() => {
      const w = window.__world(), P = w?.player; if (!P?.alive) return;
      let best = null, bd = 1e9;
      for (const s of w.ships) { if (s.side === P.side || !s.alive) continue; const d = Math.hypot(s.pos.x - P.pos.x, s.pos.y - P.pos.y); if (d < bd) { bd = d; best = s; } }
      if (!best) return;
      let rel = Math.atan2(best.pos.y - P.pos.y, best.pos.x - P.pos.x) - P.heading; while (rel > Math.PI) rel -= 2 * Math.PI; while (rel < -Math.PI) rel += 2 * Math.PI;
      window.__setAim(rel, Math.min(bd, 18000));
   });
   await page.mouse.down(); await wait(60); await page.mouse.up();
};
for (let i = 0; i < 40; i++) {   // the fleets start far apart: give them up to 100 s to open fire
   await aimAndFire(); await wait(2500);
   if (i >= 8 && await ev(() => window.__world().audio.stats().played >= 14)) break;
}
const base = await ev(() => { const T = window.__audioTap, d = T.dt.slice(30).sort((x, y) => x - y); T.dt = []; return { med: d[d.length >> 1], p95: d[Math.floor(d.length * 0.95)], n: d.length,
   played: window.__world().audio.stats().played, peak: T.peak, fired: window.__fired().shots, loops: window.__world().audio._loops.size }; });
check('live battle: the game itself triggers sounds (own salvos, other ships, ambience loops)', base.played >= 8 && base.peak > 0.05 && base.fired > 0 && base.loops >= 3,
   `one-shots ${base.played}, own shells fired ${base.fired}, loops running ${base.loops}, output peak ${db(base.peak)} dBFS`);
// every ship of both fleets fires a full salvo at the same instant, four times, on top of the running battle
let barrageMs = 0;
for (let k = 0; k < 4; k++) {
   barrageMs = Math.max(barrageMs, await ev(() => {
      const w = window.__world(), P = w.player, a = w.audio, t0 = performance.now();
      for (const s of w.ships) {
         if (s === P) { a.mainGun(s.cfg?.main?.caliber || 380, 8, 0); continue; }
         const d = Math.hypot(s.pos.x - P.pos.x, s.pos.y - P.pos.y);
         a.mainGun(s.cfg?.main?.caliber || 203, 8, Math.max(1, d), s.pos);
         a.secondary(d, s.pos);
         for (let i = 0; i < 3; i++) a.splash(200 + i * 400, i === 0, { x: P.pos.x + 200 + i * 400, y: P.pos.y });
      }
      a.impact('detonation', 1500, { x: P.pos.x, y: P.pos.y + 1500 }); a.hit(true, 'citadel'); a.alert('torp');
      return performance.now() - t0;
   }));
   await wait(1500);
}
const during = await ev(() => { const T = window.__audioTap, d = T.dt.slice().sort((x, y) => x - y); T.dt = []; return { med: d[d.length >> 1], p95: d[Math.floor(d.length * 0.95)], max: d[d.length - 1] }; });
await wait(7000);   // the same battle without the extra barrage: is a slower frame the audio or the fight itself?
const tap = await ev(() => {
   const T = window.__audioTap; T.on = false;
   const d = T.dt.slice().sort((x, y) => x - y), s = window.__world().audio.stats();
   return { peak: T.peak, rms: Math.sqrt(T.sum / Math.max(1, T.n)), bad: T.bad, maxVoices: T.maxVoices, maxSources: T.maxSources, med: d[d.length >> 1], p95: d[Math.floor(d.length * 0.95)],
      max: d[d.length - 1], n: d.length, stats: s, phase: window.__phase(), music: window.__music() };
});
check('live battle: sound is produced, finite, below 0 dBFS', tap.bad === 0 && tap.peak > 0.05 && tap.peak < 0.999, `peak ${db(tap.peak)} dBFS, rms ${db(tap.rms)} dB over ${tap.n} frames`);
check('live battle: sounds were triggered by the game', tap.stats.played > 40, `played ${tap.stats.played}, stolen ${tap.stats.stolen}, dropped ${tap.stats.dropped}, buffers ${tap.stats.buffers}`);
check('live battle: voice cap holds with 16 ships firing', tap.maxVoices <= caps.v && tap.maxSources <= caps.s && tap.stats.peakSources <= caps.s,
   `voices max ${tap.maxVoices}/${caps.v}, sources max ${tap.stats.peakSources}/${caps.s}`);
const ref = Math.max(base.med, tap.med), ref95 = Math.max(base.p95, tap.p95);
check('live battle: frame time unaffected by the barrage', during.med <= Math.max(ref * 1.25, ref + 3) && during.p95 <= Math.max(ref95 * 1.5, ref95 + 8) && barrageMs < 4,
   `median/p95 ms: before ${base.med.toFixed(1)}/${base.p95.toFixed(1)}, barrage ${during.med.toFixed(1)}/${during.p95.toFixed(1)} (max ${during.max.toFixed(1)}), after ${tap.med.toFixed(1)}/${tap.p95.toFixed(1)}; triggering 16 ships costs ${barrageMs.toFixed(2)} ms on the main thread`);
// volume sliders reach the buses of the running game
const vol = await ev(async () => {
   const a = window.__world().audio;
   a.setVolumes(0.2, 0.35); await new Promise(r => setTimeout(r, 600));
   const r = { music: a.music.gain.value, sfx: a.fxOut.gain.value, mv: a.musicVol, sv: a.sfxVol };
   a.setVolumes(0.5, 1); return r;
});
check('music / effects volume settings reach their buses', Math.abs(vol.music - 0.2) < 0.02 && Math.abs(vol.sfx - 0.35) < 0.02 && vol.mv === 0.2 && vol.sv === 0.35, vol);

check('zero console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
console.log('\nWAV files:'); for (const f of wavs) console.log('  ' + f);
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
