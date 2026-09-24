// tests/playwright.shots.mjs — headless self-test of the 2D campaign build: mission select, briefing,
// the full control pass in "Freies Gefecht", three+ campaign missions (night, carrier, storm, boss),
// end screen with stars + progress in localStorage, survival mode. Catches console errors, takes screenshots.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL || 'http://localhost:5173/';
const OUT = 'tests/shots';
const KEY = 'warships2d.progress.v1';
mkdirSync(OUT, { recursive: true });

const errors = [];
let exitCode = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) exitCode = 1; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

// a real keystroke spans at least one frame (press() can land down+up inside one rAF)
async function tap(key, hold = 80) {
   await page.keyboard.down(key);
   await page.waitForTimeout(hold);
   await page.keyboard.up(key);
   await page.waitForTimeout(60);
}
const P = (fn, arg) => page.evaluate(fn, arg);
const visible = (sel) => page.locator(sel).isVisible();
const progress = () => P((k) => JSON.parse(localStorage.getItem(k) || 'null'), KEY);

async function startMission(id) {
   await page.click(`.mcard[data-id="${id}"]`);
   await page.waitForTimeout(120);
   await page.click('#btn-play');
   await page.waitForTimeout(500);
}
// drive ahead for a while so the scene fills with contacts
async function cruise(ms) {
   await page.keyboard.down('w');
   await page.mouse.move(1000, 300);
   await page.waitForTimeout(ms);
   await page.keyboard.up('w');
}
async function waitEnd() {
   await page.locator('#end').waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
   await page.waitForTimeout(1100);   // let the star pop animation finish
}

// ---------------- 1) fresh menu: mission select ----------------
await page.goto(URL, { waitUntil: 'load' });
await P(() => { try { localStorage.clear(); } catch { } });
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1000);
check(await visible('#menu'), 'menu visible');
const cards = await page.locator('.mcard').count();
check(cards === 11, `11 mission cards (9 missions + survival + skirmish), got ${cards}`);
check(await page.locator('.mcard[data-id="m1"].locked').count() === 0, 'mission 1 unlocked');
check(await page.locator('.mcard[data-id="m2"].locked').count() === 1, 'mission 2 locked on a fresh profile');
check(/0\s*\/\s*27/.test(await page.locator('#star-total').textContent()), 'star total 0 / 27');
check(/Jungfernfahrt/.test(await page.locator('#brief-title').textContent()), 'mission 1 preselected in the briefing');
await page.click('.mcard[data-id="m2"]');
check(/Jungfernfahrt/.test(await page.locator('#brief-title').textContent()), 'locked card cannot be selected');
await page.screenshot({ path: OUT + '/01-menu.png' });

// ---------------- 2) howto ----------------
await page.click('#btn-how');
await page.waitForTimeout(200);
check(await visible('#howto'), 'howto visible');
const how = await page.locator('#howto').textContent();
check(!/Karte zoomen|Minimap-Fokus/.test(how), 'no map-zoom control listed');
check(/halten/.test(how) && /AP/.test(how) && /Wasserbomben/.test(how), 'howto lists hold-ripple, AP/HE, depth charges');
await page.screenshot({ path: OUT + '/02-howto.png' });
await page.click('#btn-how-close');

// ---------------- 3) Freies Gefecht: full control pass ----------------
await page.click('.chip[data-diff="normal"]');
await startMission('skirmish');
check(await visible('#hud'), 'hud visible after start');
check(/Freies Gefecht/.test(await page.locator('#mission-title').textContent()), 'skirmish title in HUD');
const pips = await page.locator('#turret-pips .pip').count();
check(pips === 4, `4 turret pips (got ${pips})`);

// zoom is fixed: wheel and M must not change it
const z0 = await P(() => window.__game.cam.zoom);
await page.mouse.move(900, 300);
await page.mouse.wheel(0, 600);
await tap('m');
await page.waitForTimeout(200);
check(z0 === await P(() => window.__game.cam.zoom), 'camera zoom fixed');

// ammo switch
await tap('2');
check(await P(() => window.__game.world.player.ammo) === 'HE', 'key 2 loads HE');
check(await page.locator('#ammo-he.sel').count() === 1, 'HUD shows HE selected');
await tap('1');
check(await P(() => window.__game.world.player.ammo) === 'AP', 'key 1 loads AP');

// drive + click salvo + hold ripple
await page.keyboard.down('w');
await page.keyboard.down('d');
await page.waitForTimeout(3000);
const shots0 = await P(() => window.__game.world.player.shotsFired);
await page.mouse.down({ button: 'left' });
await page.waitForTimeout(3500);
await page.mouse.up({ button: 'left' });
check(await P(() => window.__game.world.player.shotsFired) > shots0, 'main battery fired');
await page.screenshot({ path: OUT + '/03-combat.png' });
await page.keyboard.up('d');

// torpedo fan
await tap('q');
check(await P(() => window.__game.world.player.torpSpread) === 'wide', 'Q toggles torpedo spread');
const abeam = await P(() => {
   const g = window.__game, p = g.world.player, a = p.heading + Math.PI / 2;
   return g.cam.w2s({ x: p.pos.x + Math.cos(a) * 900, y: p.pos.y + Math.sin(a) * 900 });
});
await page.mouse.move(abeam.x, abeam.y);
await page.waitForTimeout(150);
await page.keyboard.down('t');
await page.waitForTimeout(400);
check(await P(() => window.__game.world._torpPreview) === true, 'holding T shows the fan');
await page.screenshot({ path: OUT + '/04-torp-fan.png' });
await page.keyboard.up('t');
await page.waitForTimeout(150);
check(await P(() => window.__game.world.player.launchers.filter(l => l.cd > 0).length) >= 1, 'releasing T launched torpedoes');

// consumables incl. depth charges; flare is night-only
await tap('f');
await tap('Shift');
await page.waitForTimeout(300);
const cons = await P(() => { const c = window.__game.world.player.cons; return { smoke: c.smoke.active || c.smoke.charges < 3, boost: c.boost.active }; });
check(cons.smoke, 'F lays smoke');
check(cons.boost, 'SHIFT engages boost');
const dc0 = await P(() => window.__game.world.player.cons.dcharge.charges);
await tap('c');
check(await P(() => window.__game.world.player.cons.dcharge.charges) < dc0, 'C rolls depth charges');
check(await page.locator('#cons-flare.off').count() === 1, 'flare slot disabled by day');
await page.keyboard.up('w');
await page.keyboard.down('s');
await page.waitForTimeout(2400);
await page.keyboard.up('s');
await page.screenshot({ path: OUT + '/05-smoke.png' });
await tap('e');
await tap('r');
await page.mouse.click(200, 700, { button: 'right' });   // RMB on water clears secondary focus

// battle
await page.keyboard.down('w');
await page.mouse.move(1000, 250);
await page.mouse.down({ button: 'left' });
await page.waitForTimeout(9000);
await page.mouse.up({ button: 'left' });
await page.keyboard.up('w');
await page.screenshot({ path: OUT + '/06-battle.png' });
const st = await P(() => { const w = window.__game.world; return { t: +w.time.toFixed(1), hit: w.player.shotsHit, dmg: Math.round(w.player.dmgDealt), hp: Math.round(w.player.hp) }; });
console.log('     skirmish state:', JSON.stringify(st));
check(st.t > 15, 'sim advanced');

// pause shows objectives; quit returns to the menu
if (await visible('#end')) await page.click('#btn-again'), await page.waitForTimeout(400);
await tap('p');
await page.waitForTimeout(250);
check(await visible('#pause'), 'pause overlay');
check(/versenk/.test(await page.locator('#pause-obj').textContent()), 'pause lists the objective');
await page.screenshot({ path: OUT + '/07-pause.png' });
await page.click('#btn-quit');
await page.waitForTimeout(300);
check(await visible('#menu'), 'quit returns to mission select');

// ---------------- 4) mission 1: briefing, objectives, win -> stars -> next ----------------
await page.click('.mcard[data-id="m1"]');
await page.waitForTimeout(150);
await page.screenshot({ path: OUT + '/08-briefing.png' });
await startMission('m1');
check(/Jungfernfahrt/.test(await page.locator('#mission-title').textContent()), 'm1 title in HUD');
check(await page.locator('#objectives .obj').count() >= 1, 'm1 objective rows');
await cruise(2500);
check(await page.locator('#banner.on').count() === 1, 'm1 shows the tutorial banner');
await cruise(3500);
await page.screenshot({ path: OUT + '/09-m1.png' });
await P(() => window.__game.world._win('🏆 Testsieg'));
await waitEnd();
check(await visible('#end'), 'end screen after win');
check(/SIEG/.test(await page.locator('#end-title').textContent()), 'end title SIEG');
const starsOn = await page.locator('#end-stars span.on').count();
check(starsOn >= 1, `stars awarded (${starsOn})`);
check(await visible('#btn-next'), 'Nächste Mission offered after a win');
const prog1 = await progress();
check(prog1 && prog1.stars && prog1.stars.m1 === starsOn, 'stars saved to localStorage');
await page.screenshot({ path: OUT + '/10-end-win.png' });
await page.click('#btn-next');
await page.waitForTimeout(500);
check(/Konvoi-Jagd/.test(await page.locator('#mission-title').textContent()), 'Nächste Mission starts m2');
await cruise(2500);
await P(() => window.__game.world._lose('💀 Testniederlage'));
await waitEnd();
check(/NIEDERLAGE/.test(await page.locator('#end-title').textContent()), 'end title NIEDERLAGE after loss');
check(!(await visible('#btn-next')), 'no next button after a loss');
await page.screenshot({ path: OUT + '/11-end-loss.png' });
await page.click('#btn-menu');
await page.waitForTimeout(300);
check(await page.locator('.mcard[data-id="m2"].locked').count() === 0, 'm2 unlocked after winning m1');
check(await page.locator('.mcard[data-id="m3"].locked').count() === 1, 'm3 still locked');

// ---------------- 5) later missions with an unlocked profile ----------------
await P((k) => localStorage.setItem(k, JSON.stringify({ stars: { m1: 3, m2: 2, m3: 2, m4: 1, m5: 1, m6: 1, m7: 1, m8: 1 }, survivalBest: {}, difficulty: 'normal' })), KEY);
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(800);
check(await page.locator('.mcard[data-id="m9"].locked').count() === 0, 'injected progress unlocks m9');
check(/12\s*\/\s*27/.test(await page.locator('#star-total').textContent()), 'star total reflects saved progress');

await startMission('m4');
check(await P(() => !!window.__game.world.env.night), 'm4 is a night mission');
check(await page.locator('#cons-flare.off').count() === 0, 'flare slot active at night');
await cruise(5000);
await tap('g');
await page.waitForTimeout(600);
check(await P(() => window.__game.world.flares.length) >= 1, 'G fires a star shell');
await page.screenshot({ path: OUT + '/12-m4-night.png' });
await tap('Escape'); await page.waitForTimeout(150);
await page.click('#btn-quit'); await page.waitForTimeout(250);

await startMission('m6');
await cruise(4000);
const planes = await P(async () => {
   const w = window.__game.world;
   if (!w.aircraft.length) {   // force a strike into view so the screenshot shows aircraft
      const air = await import('/game/air.js');
      const cv = w.bots.find(b => b.cls === 'CV');
      if (cv) { const sq = air.launchSquadron(w, cv, w.player, 'dive', 4); sq.pos = { x: w.player.pos.x + 600, y: w.player.pos.y - 250 }; }
   }
   return w.bots.some(b => b.cls === 'CV');
});
check(planes, 'm6 fields a carrier');
await page.waitForTimeout(1500);
check(await P(() => window.__game.world.aircraft.length) > 0, 'aircraft airborne in m6');
await page.screenshot({ path: OUT + '/13-m6-carrier.png' });
await tap('Escape'); await page.waitForTimeout(150);
await page.click('#btn-quit'); await page.waitForTimeout(250);

await startMission('m7');
check(await P(() => !!window.__game.world.env.storm), 'm7 is a storm mission');
await cruise(5000);
await page.screenshot({ path: OUT + '/14-m7-storm.png' });
await tap('Escape'); await page.waitForTimeout(150);
await page.click('#btn-quit'); await page.waitForTimeout(250);

await startMission('m9');
check(await P(() => window.__game.world.allies.length) === 2, 'm9 has two allied escorts');
await cruise(4000);
await P(() => { const w = window.__game.world, b = w.bots.find(x => x.cls === 'BOSS'); if (b) w.addBarrage(b, w.player.pos, b.cfg.barrage, 5); });
await page.waitForTimeout(800);
check(await P(() => window.__game.world.barrages.length) > 0, 'boss barrage telegraphed');
await page.screenshot({ path: OUT + '/15-m9-boss.png' });
await tap('Escape'); await page.waitForTimeout(150);
await page.click('#btn-quit'); await page.waitForTimeout(250);

// ---------------- 6) survival ----------------
await startMission('survival');
check(/Welle/.test(await page.locator('#objectives').textContent()), 'survival shows the wave counter');
await cruise(4000);
await page.screenshot({ path: OUT + '/16-survival.png' });
await P(() => { const w = window.__game.world; w.director.score = 1234; w._lose('💀 Test'); });
await waitEnd();
check(/WELLE/.test(await page.locator('#end-title').textContent()), 'survival end screen shows the wave');
const prog2 = await progress();
check(prog2 && prog2.survivalBest && prog2.survivalBest.normal && prog2.survivalBest.normal.score === 1234, 'survival record saved');
await page.screenshot({ path: OUT + '/17-survival-end.png' });
await page.click('#btn-menu');
await page.waitForTimeout(300);
check(/W1/.test(await page.locator('.mcard[data-id="survival"]').textContent()), 'survival card shows the best wave');

// ---------------- console error report ----------------
if (errors.length) {
   console.log('\nCONSOLE ERRORS (' + errors.length + '):');
   for (const e of errors.slice(0, 20)) console.log('  -', e);
   exitCode = 1;
} else {
   console.log('\nno console errors ✔');
}
await browser.close();
process.exit(exitCode);
