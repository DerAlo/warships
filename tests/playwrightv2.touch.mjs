// tests/playwrightv2.touch.mjs -- the touch controls of V2 (index-v2.html) on a phone (844x390).
// Every control is exercised with real touch events (Playwright touchscreen / CDP touch drags) and
// timed in frames from the pointerdown: the command has to reach the world within a few frames and
// something on screen has to answer (a plate, a notice, the lever). One tap each: a control that
// needs a second tap or stays silent fails here.
// Covered: telegraph, rudder (tap and drag), weapon plates, fire, target lock (with and without a
// target), the chart with a cruise-missile target, helicopter, consumables, glass, free look, pause,
// and on the submarine: depth and the swimmer team.
// Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8839   then   URLV2=http://localhost:8839/index-v2.html node tests/playwrightv2.touch.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URLV2 || 'http://localhost:8839/index-v2.html';
const OUT = process.env.OUT || 'tests/shots';
const CMD_FRAMES = 4, FB_FRAMES = 12;
mkdirSync(OUT, { recursive: true });
const errors = [], results = [], notes = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const GPU = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: GPU });

async function open(tag, mission, ship) {
   const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
   const page = await ctx.newPage();
   page.on('console', m => { if (m.type() === 'error') errors.push(tag + ': ' + m.text().slice(0, 300)); });
   page.on('pageerror', e => errors.push(tag + ' PAGEERROR: ' + e.message + ' ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ')));
   page.on('requestfailed', r => errors.push(tag + ' REQUESTFAILED: ' + r.url()));
   await page.goto(URL + '?nohint', { waitUntil: 'load' });
   await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 30000 });
   await page.evaluate(o => window.__start({ mission: o.mission, ship: o.ship, difficulty: 'normal' }), { mission, ship });
   await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 30000 });
   await page.waitForTimeout(1800);
   // helpers in the page: message text, a frame watcher armed before a gesture
   await page.evaluate(() => {
      window.__msgs = () => [...document.querySelectorAll('#msgs .msg')].map(m => m.dataset.text || m.textContent).join(' | ');
      window.__arm = (pre, cmd, fb) => {
         const F = s => new Function('b', 'return (' + s + ')');
         const b = F(pre)(), fc = F(cmd), ff = F(fb);
         const w = window.__w = { f: -1, cmd: -1, fb: -1, done: false, b };
         window.addEventListener('pointerdown', () => { w.f = 0; }, { capture: true, once: true });
         let idle = 0;
         const tick = () => {
            if (w.f < 0) { if (++idle > 240) { w.done = true; return; } requestAnimationFrame(tick); return; }
            if (w.cmd < 0 && fc(b)) w.cmd = w.f;
            if (w.fb < 0 && ff(b)) w.fb = w.f;
            if ((w.cmd >= 0 && w.fb >= 0) || w.f >= 90) { w.done = true; return; }
            w.f++; requestAnimationFrame(tick);
         };
         tick();
      };
   });
   const cdp = await ctx.newCDPSession(page);
   const S = {
      page, ctx, tag,
      ev: (fn, arg) => page.evaluate(fn, arg),
      wait: ms => page.waitForTimeout(ms),
      shot: n => page.screenshot({ path: `${OUT}/v2-touch-${n}.png` }),
      mid: (sel, fx = 0.5, fy = 0.5) => page.evaluate(([s, fx, fy]) => {
         const e = document.querySelector(s); if (!e) return null; const q = e.getBoundingClientRect();
         if (!q.width || getComputedStyle(e).visibility === 'hidden' || e.classList.contains('hidden')) return null;
         return { x: q.left + q.width * fx, y: q.top + q.height * fy };
      }, [sel, fx, fy]),
      drag: async (a, b) => {
         const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
         await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(a.x, a.y) });
         for (let i = 1; i <= 6; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(a.x + (b.x - a.x) * i / 6, a.y + (b.y - a.y) * i / 6) }); await page.waitForTimeout(16); }
         await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      },
   };
   // One gesture, timed. pre: baseline expression (its value is `b` in cmd / fb); cmd: the command is in the
   // world / the control state; fb: something visible answered. at: selector, [selector, fx, fy], {x,y} or a function.
   S.act = async (name, at, pre, cmd, fb, opt = {}) => {
      const p = typeof at === 'function' ? null : at.x != null ? at : await (Array.isArray(at) ? S.mid(...at) : S.mid(at));
      if (typeof at !== 'function' && !p) { check(`${tag}: ${name}: control is on screen`, false, JSON.stringify(at)); return null; }
      await S.ev(([pre, cmd, fb]) => window.__arm(pre, cmd, fb), [pre, cmd, fb]);
      if (typeof at === 'function') await at(); else await page.touchscreen.tap(p.x, p.y);
      await page.waitForFunction(() => window.__w.done, null, { timeout: 8000 }).catch(() => {});
      const w = await S.ev(() => ({ cmd: window.__w.cmd, fb: window.__w.fb, f: window.__w.f }));
      await S.wait(opt.settle ?? 250);
      const msg = await S.ev(() => window.__msgs());
      const lim = opt.cmdFrames ?? CMD_FRAMES;
      check(`${tag}: ${name}: ${opt.cmdFrames ? 'follows the finger, there' : 'one tap reaches the game'} within ${lim} frames`, w.cmd >= 0 && w.cmd <= lim, `frame ${w.cmd}`);
      check(`${tag}: ${name}: visible answer within ${FB_FRAMES} frames`, w.fb >= 0 && w.fb <= FB_FRAMES, `frame ${w.fb}` + (opt.say ? '  notices: ' + msg.slice(-110) : ''));
      return w;
   };
   return S;
}

const enemyAhead = S => S.ev(() => {
   const w = window.__world(), p = w.player;
   const foes = w.ships.filter(s => s.alive && s.side !== p.side), T = foes.find(s => !s.sub) || foes[0];   // a surface ship if there is one
   if (!T) return null;
   const put = () => { T.pos.x = p.pos.x + Math.cos(p.heading) * 5000; T.pos.y = p.pos.y + Math.sin(p.heading) * 5000; T.detected = true; T.visible = true; T.spotted = true;
      if (T.depth > 0 || T.depthTarget > 0) { T.depth = 0; T.depthTarget = 0; } };   // a boat that dives would drop its marker
   put(); clearInterval(window.__keep); window.__keep = setInterval(() => { if (T.alive && p.alive) put(); }, 50);
   window.__setAim(0, 5000);
   return T.name || T.id;
});
const keepAlive = S => S.ev(() => { clearInterval(window.__hp); window.__hp = setInterval(() => { const p = window.__world()?.player; if (p && p.alive && p.maxHP) p.hp = p.maxHP; }, 200); });
const TELE = `[...document.querySelectorAll('#tu-tele .tu-st')].map(e => e.className).join(',')`;
const SEL = `[...document.querySelectorAll('#weapons .wslot')].map(e => e.className).join(',')`;

// ---------------------------------------------------------------- surface ship
{
   const S = await open('burke', 'hormus', 'Burke');
   const T = 'burke';
   await keepAlive(S);
   check(`${T}: touch controls are up`, await S.ev(() => window.__touch().shown));

   // telegraph: every step by one tap
   const steps = await S.ev(() => [...document.querySelectorAll('#tu-tele .tu-st')].map(e => +e.dataset.n));
   const cur = await S.ev(() => window.__ctl().telegraph);
   for (const n of steps.filter(n => n !== cur).slice(0, 3).concat([cur]))
      await S.act(`telegraph step ${n}`, `#tu-tele .tu-st[data-n="${n}"]`, TELE, `window.__ctl().telegraph === ${n}`, `${TELE} !== b`);

   // rudder: a tap on the track, then a drag across it; the ship turns
   await S.act('rudder tap hard starboard', ['#tu-rud', 0.93, 0.5], `document.querySelector('#tu-rud .tu-th').style.left`, `window.__ctl().rudder === 2`, `document.querySelector('#tu-rud .tu-th').style.left !== b`);
   const h0 = await S.ev(() => window.__shipHdg());
   await S.wait(2500);
   const h1 = await S.ev(() => window.__shipHdg());
   check(`${T}: the ship turns after the rudder tap`, Math.abs(h1 - h0) > 0.005, `heading ${h0.toFixed(3)} -> ${h1.toFixed(3)}`);
   const ra = await S.mid('#tu-rud', 0.9, 0.5), rb = await S.mid('#tu-rud', 0.08, 0.5);
   await S.act('rudder drag to hard port', () => S.drag(ra, rb), `0`, `window.__ctl().rudder === -2`, `/Hart|BB|Bb|Back/i.test(document.querySelector('#tu-rud .tu-rl').textContent) || parseFloat(document.querySelector('#tu-rud .tu-th').style.left) < 30`, { settle: 300, cmdFrames: 40 });   // the drag itself takes about 20 frames
   await S.act('rudder tap midships', ['#tu-rud', 0.5, 0.5], `document.querySelector('#tu-rud .tu-th').style.left`, `window.__ctl().rudder === 0`, `document.querySelector('#tu-rud .tu-th').style.left !== b`);

   // weapon plates
   const slots = await S.ev(() => [...document.querySelectorAll('#weapons .wslot')].map(e => ({ key: e.dataset.key, id: e.dataset.id || '', cls: e.className, h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) })));
   console.log('INFO weapon plates: ' + JSON.stringify(slots));
   check(`${T}: weapon plates are 40 px or more`, slots.length > 0 && slots.every(s => s.h >= 40 && s.w >= 40), slots.map(s => s.w + 'x' + s.h).join(' '));
   const MODE = { 1: 'main', 2: 'ssm', 3: 'cruise', 4: 'rockets', 5: 'torp' };
   for (const s of slots.filter(s => s.key !== '3' && MODE[s.key]).reverse())
      await S.act(`weapon plate ${s.key} (${MODE[s.key]})`, `#weapons .wslot[data-key="${s.key}"]`, SEL, `window.__weaponSel() === '${MODE[s.key]}'`, `${SEL} !== b`);

   // target lock: nothing near the crosshair first, then a ship ahead
   const mk = await S.ev(() => { window.__setAim(Math.PI, 8000); return window.__ctl().lockId; });
   await S.wait(700);
   if (mk == null && await S.mid('#tu-lock'))
      await S.act('lock button with no target in view (expected: a visible refusal)', '#tu-lock', `window.__msgs()`, `true`, `window.__msgs() !== b`, { say: true });
   const tgt = await enemyAhead(S);
   check(`${T}: a hostile ship to lock`, !!tgt, String(tgt));
   await S.wait(900);
   await S.act('lock button on a ship ahead', '#tu-lock', `0`, `window.__ctl().lockId != null`, `!document.getElementById('lock-panel').classList.contains('hidden')`);
   await S.shot('burke-locked');

   // fire: the guns on the locked ship
   await S.act('weapon plate 1 (main)', `#weapons .wslot[data-key="1"]`, SEL, `window.__weaponSel() === 'main'`, `true`);
   await S.wait(4000);   // turrets train
   const tur = await S.ev(() => window.__turrets());
   console.log('INFO turrets: ' + JSON.stringify(tur));
   await S.act('fire button (guns)', '#tu-fire', `window.__fired().shots`, `window.__fired().shots > b`, `window.__turrets().some(t => t.state !== 'ready') || window.__world().shells?.length > 0`);
   // anti-ship missile at the locked ship
   if (slots.some(s => s.key === '2')) {
      await S.act('weapon plate 2 (ssm)', `#weapons .wslot[data-key="2"]`, SEL, `window.__weaponSel() === 'ssm'`, `${SEL} !== b`);
      await S.act('fire button (anti-ship missile)', '#tu-fire', `window.__msgs()`, `window.__msgs() !== b`, `window.__msgs() !== b`, { say: true });
   }
   await S.act('lock button again releases the target', '#tu-lock', `0`, `window.__ctl().lockId == null`, `document.getElementById('lock-panel').classList.contains('hidden')`);

   // chart: the minimap opens and closes it
   await S.act('minimap opens the chart', '#minimap-wrap', `0`, `window.__ctl().mapOpen === true`, `true`);
   await S.shot('burke-chart');
   const closer = await S.ev(() => ['#tu-map', '#minimap-wrap', '#tu-more'].map(s => { const e = document.querySelector(s); const r = e?.getBoundingClientRect(); return { s, vis: !!r && r.width > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none', top: r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(s) != null }; }));
   console.log('INFO chart open, ways back: ' + JSON.stringify(closer));
   const back = closer.find(c => c.vis && c.top && c.s !== '#tu-more');
   check(`${T}: the open chart has a one-tap way back`, !!back, JSON.stringify(closer));
   if (back) await S.act(`${back.s} closes the chart`, back.s, `0`, `window.__ctl().mapOpen === false`, `true`);
   else await S.ev(() => { /* fall back so the run continues */ });

   // cruise missile: plate 3 opens the chart, one tap on the chart launches
   if (slots.some(s => s.key === '3')) {
      if (await S.ev(() => window.__ctl().mapOpen)) await S.act('fold: chart closes', '#minimap-wrap', `0`, `window.__ctl().mapOpen === false`, `true`);
      await S.act('weapon plate 3 opens the chart for a cruise missile', `#weapons .wslot[data-key="3"]`, `window.__msgs()`, `window.__weaponSel() === 'cruise' && window.__ctl().mapOpen`, `window.__msgs() !== b`, { say: true });
      const fireTxt = await S.ev(() => document.getElementById('tu-fire').textContent);
      console.log('INFO fire button reads: ' + fireTxt);
      // a point on the chart well clear of the plates: the middle of the screen, a little off the ship
      const pt = await S.ev(() => { const x = innerWidth / 2 + 46, y = innerHeight / 2 - 40; return { x, y, tag: document.elementFromPoint(x, y)?.tagName }; });
      check(`${T}: the chart point is free of plates`, pt.tag === 'CANVAS', pt.tag);
      await S.act('tap on the chart sends a cruise missile', pt, `window.__msgs()`, `window.__msgs() !== b`, `window.__msgs() !== b`, { say: true, settle: 500 });
      const said = await S.ev(() => window.__msgs());
      check(`${T}: the cruise missile left on that one tap`, /gestartet/.test(said), said.slice(-120));
      await S.shot('burke-cruise');
      await S.act('weapon plate 3 again closes the chart', `#weapons .wslot[data-key="3"]`, `0`, `window.__ctl().mapOpen === false`, `true`);
      await S.act('fire button in cruise mode opens the chart', '#tu-fire', `0`, `window.__ctl().mapOpen === true`, `true`);
      await S.act('weapon plate 1 (main) from the chart', `#weapons .wslot[data-key="1"]`, SEL, `window.__weaponSel() === 'main'`, `${SEL} !== b`);
      check(`${T}: choosing the guns on the cruise chart puts the chart away`, !(await S.ev(() => window.__ctl().mapOpen)));
   } else notes.push('burke: no cruise missile plate');

   // helicopter plate
   const helo = await S.mid('#ops-panel [data-key="I"]');
   if (helo) {
      await S.act('helicopter plate', '#ops-panel [data-key="I"]', `window.__msgs() + document.querySelector('#ops-panel [data-key="I"]').textContent`, `true`, `window.__msgs() + document.querySelector('#ops-panel [data-key="I"]').textContent !== b`, { say: true, settle: 600 });
      console.log('INFO helicopter plate reads: ' + await S.ev(() => document.querySelector('#ops-panel [data-key="I"]').textContent.replace(/\s+/g, ' ').trim()));
      await S.shot('burke-helo');
   } else notes.push('burke: no helicopter plate on screen');

   // consumables
   const cons = await S.ev(() => [...document.querySelectorAll('#cons .cslot')].map(e => ({ slot: e.dataset.slot, w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) })));
   console.log('INFO consumables: ' + JSON.stringify(cons) + ' ' + JSON.stringify(await S.ev(() => window.__cons())));
   if (cons.length) {
      const c = cons[cons.length - 1];
      await S.act(`consumable plate ${c.slot}`, `#cons .cslot[data-slot="${c.slot}"]`, `JSON.stringify(window.__cons()) + window.__msgs()`, `JSON.stringify(window.__cons()) + window.__msgs() !== b`, `JSON.stringify(window.__cons()) + window.__msgs() !== b`, { say: true });
   }

   // glass, free look, pause
   await S.act('glass on', '#tu-scope', `0`, `window.__ctl().bino === true`, `document.getElementById('tu-scope').classList.contains('on') || window.__ctl().bino`);
   await S.act('glass off', '#tu-scope', `0`, `window.__ctl().bino === false`, `true`);
   await S.act('free look on', '#tu-free', `0`, `window.__ctl().freeLook === true`, `document.getElementById('tu-free').classList.contains('on')`);
   await S.act('free look off', '#tu-free', `0`, `window.__ctl().freeLook === false`, `!document.getElementById('tu-free').classList.contains('on')`);
   // look: a swipe over the sea turns the view
   const y0 = await S.ev(() => window.__aim().targetYaw);
   await S.drag({ x: 380, y: 150 }, { x: 480, y: 150 }); await S.wait(200);
   const y1 = await S.ev(() => window.__aim().targetYaw);
   check(`${T}: a swipe over the sea turns the view`, Math.abs(y1 - y0) > 0.02, `${y0.toFixed(3)} -> ${y1.toFixed(3)}`);
   await S.act('pause button', '#tu-pause', `0`, `window.__phase() === 'paused'`, `!!document.querySelector('.overlay:not(.hidden)')`);
   await S.shot('burke-pause');
   await S.ctx.close();
}

// ---------------------------------------------------------------- submarine
{
   const S = await open('u212', 'pipeline', 'U212');
   const T = 'u212';
   await keepAlive(S);
   const d0 = await S.ev(() => window.__world().player.depthTarget ?? 0);
   const dive = await S.mid('#tu-dive'), up = await S.mid('#tu-up');
   console.log('INFO depth target at start: ' + d0 + ' dive button: ' + !!dive + ' up button: ' + !!up);
   if (up && d0 > 0) await S.act('up button', '#tu-up', `window.__world().player.depthTarget`, `window.__world().player.depthTarget < b`, `true`);
   if (await S.mid('#tu-dive')) await S.act('dive button', '#tu-dive', `window.__world().player.depthTarget ?? 0`, `(window.__world().player.depthTarget ?? 0) > b`, `true`);
   const steps = await S.ev(() => [...document.querySelectorAll('#tu-tele .tu-st')].map(e => +e.dataset.n));
   const cur = await S.ev(() => window.__ctl().telegraph);
   const n = steps.find(n => n !== cur);
   await S.act(`telegraph step ${n}`, `#tu-tele .tu-st[data-n="${n}"]`, TELE, `window.__ctl().telegraph === ${n}`, `${TELE} !== b`);
   const team = await S.mid('#ops-panel [data-key="K"]');
   if (team) {
      await S.act('swimmer team plate', '#ops-panel [data-key="K"]', `window.__msgs() + document.querySelector('#ops-panel [data-key="K"]').textContent`, `true`, `window.__msgs() + document.querySelector('#ops-panel [data-key="K"]').textContent !== b`, { say: true, settle: 600 });
      console.log('INFO team plate reads: ' + await S.ev(() => document.querySelector('#ops-panel [data-key="K"]').textContent.replace(/\s+/g, ' ').trim()));
   } else notes.push('u212: no swimmer team plate on screen');
   const slots = await S.ev(() => [...document.querySelectorAll('#weapons .wslot')].map(e => e.dataset.key));
   console.log('INFO submarine weapon plates: ' + slots.join(','));
   await S.act('fire button (torpedoes)', '#tu-fire', `window.__fired().torps + '|' + window.__msgs()`, `window.__fired().torps + '|' + window.__msgs() !== b`, `window.__fired().torps + '|' + window.__msgs() !== b`, { say: true });
   await S.shot('u212');
   await S.ctx.close();
}

await browser.close();
const bad = results.filter(r => !r.ok);
for (const n of notes) console.log('NOTE ' + n);
for (const e of errors) console.log('CONSOLE ' + e);
console.log(`${results.length - bad.length}/${results.length} checks passed, console errors: ${errors.length}`);
process.exit(bad.length || errors.length ? 1 : 0);
