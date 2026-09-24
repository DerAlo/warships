// tests/shots-lab3d.mjs — fast model/FX screenshots on tests/gfx-lab.html (static fake world).
// Usage: node tests/shots-lab3d.mjs <view,...> [--env=time:weather:sea] [--fleet=A,B] [--islands] [--w=1280]
//   views: lineup | bow:<cls> | side:<cls> | aft:<cls> | q:<cls> (3/4 from astern) | top:<cls> | deck:<cls> | fx | fire | sea
//   LAB_URL=http://localhost:5185/tests/gfx-lab.html  SHOTS_OUT=tests/shots
const { chromium } = await import(process.env.PW_MODULE || 'playwright');
import { mkdirSync } from 'node:fs';

const BASE = process.env.LAB_URL || 'http://localhost:5185/tests/gfx-lab.html';
const OUT = process.env.SHOTS_OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const W = Number(opt('w', 1280)), H = Math.round(W * 9 / 16);
const views = (args.find(a => !a.startsWith('--')) || 'lineup').split(',');
const qs = new URLSearchParams({ env: opt('env', 'day:clear:0.35'), fleet: opt('fleet', 'all') });
if (args.includes('--islands')) qs.set('islands', '1');

const errors = [];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text().slice(0, 600)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(`${BASE}?${qs}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__lab && window.__lab.frames > 2, null, { timeout: 240000 });

for (const v of views) {
   const [kind, cls] = v.split(':');
   const ok = await page.evaluate(([kind, cls]) => {
      const L = window.__lab, R = L.R, w = L.world;
      const s = cls ? L.ships.find(x => x.cls === cls) : L.ships[0];
      if (!s) return false;
      const rec = R.ships.recs.get(s);
      const len = rec ? rec.d.L : 200;
      const P = s.pos, h = s.heading;
      const at = (a, d, y) => [P.x + Math.cos(h + a) * d, y, P.y + Math.sin(h + a) * d];
      let view = null;
      if (kind === 'lineup') {
         const n = L.ships.length, cy = (n - 1) * 45;
         view = { pos: [-420, 210, cy + 620], look: [10, 0, cy - 40], fov: 50 };
      } else if (kind === 'side') view = { pos: at(-1.35, len * 0.95, len * 0.12), look: [P.x, len * 0.05, P.y], fov: 42 };
      else if (kind === 'bow') view = { pos: at(-0.55, len * 0.62, len * 0.1), look: at(0, len * 0.08, len * 0.06), fov: 50 };
      else if (kind === 'aft') view = { pos: at(-2.2, len * 0.6, len * 0.14), look: at(Math.PI, len * 0.1, len * 0.06), fov: 50 };
      else if (kind === 'q') view = { pos: at(-2.5, len * 0.85, len * 0.24), look: at(0, len * 0.05, len * 0.06), fov: 45 };
      else if (kind === 'top') view = { pos: at(-1.2, len * 0.35, len * 0.55), look: [P.x, 0, P.y], fov: 55 };
      else if (kind === 'deck') view = { pos: at(-0.25, len * 0.62, len * 0.07), look: at(Math.PI, len * 0.1, len * 0.1), fov: 60 };
      else if (kind === 'fx' || kind === 'fire' || kind === 'sea') {
         const fx = R.fx, a = h - 1.5;
         const cx = P.x + Math.cos(a) * 420, cz = P.y + Math.sin(a) * 420, sx = -Math.sin(a), sz = Math.cos(a);
         if (kind === 'fx') {
            fx._splash(cx, cz, 380); fx._splash(cx + sx * 90, cz + sz * 90, 203); fx._splash(cx - sx * 80, cz - sz * 80, 127);
            fx._splash(cx + sx * 170 + Math.cos(a) * 60, cz + sz * 170 + Math.sin(a) * 60, 460, true);
            fx._explosion(cx - sx * 190, 12, cz - sz * 190, 380, true);
            window.__fxSim = 0.7;
            view = { pos: at(-1.5, 40, 22), look: [cx, 30, cz], fov: 50 };
         } else if (kind === 'fire') {
            s.fires = [{ t: 0 }, { t: 0 }, { t: 0 }]; window.__fxSim = 9;
            view = { pos: at(-1.3, len * 1.3, len * 0.18), look: [P.x, len * 0.12, P.y], fov: 50 };
         } else view = { pos: at(-1.5, 30, 12), look: at(-1.0, 1500, 20), fov: 60 };
      }
      if (!view) return false;
      R.debugView = view;
      R._applyDebugView(); R.camera.updateMatrixWorld();
      const n = Math.round((window.__fxSim || 0) * 20); window.__fxSim = 0;
      R.fx.timeScale = 1;
      for (let i = 0; i < n; i++) { R.time += 0.05; R.fx.update(w, 0.05, R.time, R.camera, R.ships); }
      R.fx.timeScale = n > 0 ? 0 : 1;
      L.frames = 0;
      return true;
   }, [kind, cls]);
   if (!ok) { console.log('skip', v); continue; }
   await page.waitForFunction(() => window.__lab.frames >= 2, null, { timeout: 240000 });
   const file = `${OUT}/lab-${v.replace(/:/g, '-')}${opt('env', '') ? '-' + opt('env', '').replace(/:/g, '_') : ''}.png`;
   await page.screenshot({ path: file, timeout: 240000 });
   console.log('shot', file);
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
process.exit(errors.some(e => !e.startsWith('warning')) ? 1 : 0);
