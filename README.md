# Bismarck — Offline Naval Combat

A World-of-Warships-style naval combat game with German warships of 1939–45 and
AI-controlled opponents (and allies), offline only. Vanilla JS, no build
step. Two ways to play, each with its own simulation core (2D: `game/`, 3D: `game3d/`,
see `game3d/ARCHITECTURE.md`):

- **2D** (`index.html`) — top-down Canvas 2D view with a fixed camera (no
  zoom; the minimap is the overview):
  - **Campaign** of 9 missions in three chapters (convoy hunt, escort, night
    action, storm, carrier strike, …) with briefings, objectives and a 3-star
    rating, plus an endless **Survival** mode with waves and a saved record.
  - **Boss battles** close every chapter: *Schlachtkreuzer Hood* (m3),
    *Schlachtschiff Rodney* (m6) and the *Leviathan* (m9) — oversized unique
    silhouettes, a boss HP bar and 3 attack phases that switch as the hull
    drops (barrage rings, torpedo fan with red warning lanes, smoke +
    reposition, announced rapid-fire salvos, called-in escorts). Easier/harder
    difficulties stretch/shorten the telegraphs. Each boss kill awards a chapter
    medal: +5 % hull for the Bismarck in the campaign.
  - **Daily challenge** (📅 card): one battle per calendar day, generated from
    a seed of the local date — same map, same three waves and the same daily
    modifier (fog, storm, double enemies, torpedoes only, glass cannons) for
    everyone that day. Score = sunk ships + time bonus + remaining hull +
    accuracy; a local top 10 per day (with name entry and yesterday's best)
    is kept in `localStorage`.
  - **Gunnery:** AP vs HE shells — AP into a broadside scores citadels, steep
    angles ricochet; HE is reliable damage and sets fires. Click for a full
    salvo, hold to ripple-fire turret by turret.
  - **Torpedo spread** (narrow / wide fan), secondary battery focus, flak
    against aircraft.
  - **Consumables:** repair party, damage control, smoke screen, engine
    boost, depth charges, star shells.
  - **Realistic smoke** that blocks vision (not shells) — firing the main
    battery gives away your position through gun bloom.
  - **New enemy types:** torpedo-boat swarms, submarines (hydrophone pings),
    transports, carriers with torpedo / dive-bomber squadrons, coastal
    batteries, mines.
  - **Ribbons** and floating damage numbers for hits, citadels, fires and
    kills; end screen with detailed stats.

  2D controls:

  | Key | Action |
  |---|---|
  | W / S | Throttle up / down |
  | A / D | Rudder left / right |
  | Mouse | Aim turrets |
  | Left click | Full salvo · hold = turret by turret |
  | 1 / 2 | AP / HE shells |
  | Right click | Focus secondary battery on target |
  | T | Hold = aim torpedo fan, release = launch |
  | Q | Torpedo fan narrow / wide |
  | R | Repair party (heal hull) |
  | E | Damage control (extinguish fires / stop flooding) |
  | F | Smoke screen |
  | Shift | Engine boost |
  | C | Depth charges (vs. submarines) |
  | G | Star shell at cursor (night) |
  | Space | Anchor turn (hold: brake + tighter turn) |
  | P / Esc | Pause |

  Boss fights need no extra keys: turn bow-on into the red torpedo lanes, change
  course when the barrage rings or the rapid-fire warning appear.

- **3D** (`index-3d.html`) — a singleplayer *World of Warships*: real 3D ships
  (Three.js, vendored locally under `vendor/three/` — no CDN, still fully offline).
  - **Missions:** Übungsgefecht (training), Standardgefecht (7 vs 7),
    Herrschaft (domination, three capture points), Geleitzug (convoy escort),
    Letztes Gefecht, Nachtgefecht (destroyer night action), Handelskrieg
    (commerce raid), Sperrriegel (hold a fjord entrance against three waves —
    three ships through and the harbour is lost), Rückzugsgefecht (rearguard:
    cover the crippled Gneisenau until she reaches the fjord) and
    Flottenschlacht (8 vs 8, sink the enemy battle line before yours is gone),
    each with briefing and objectives.
  - **Historische Operationen:** Unternehmen Rheinübung (Bismarck vs Hood and
    Prince of Wales at dawn), Nachtschlacht vor Guadalcanal (Washington vs
    Kirishima and Long-Lance destroyers), Schlacht am Nordkap (Duke of York
    runs down Scharnhorst in an Arctic storm), Unternehmen Cerberus (Channel
    Dash: take Scharnhorst through mines and the Harwich destroyers into the
    North Sea), Vians Nachtangriff (HMS Cossack's flotilla torpedoes the
    crippled Bismarck at night), Schlacht in der Barentssee (HMS Sheffield
    drives Admiral Hipper off convoy JW 51B) and Überfall auf Narvik (HMS Hardy
    raids the harbour, then fights her way back out of the fjord). Each op has
    fixed ships, an intro
    briefing, scripted radio traffic, multi-stage objectives, a debrief with the
    historical outcome and a medal (1–3 stars, saved locally).
  - **Playable ships:** Bismarck (battleship), Admiral Hipper (heavy cruiser),
    Nürnberg (light cruiser) and Z 23 (destroyer), each with its own guns,
    torpedoes and consumables.
  - **Career (Karriere):** every battle/op pays XP (EP) and credits
    (Kreditpunkte) — base, win bonus, damage, kills, spotting, objectives,
    survival, × difficulty — itemised on the results screen. Bismarck and
    Hipper are free; Nürnberg (7 500 EP) and Z 23 (11 000 EP) are researched
    with XP (ops keep their fixed ships). Credits buy 3 tiers of five modules
    per ship (Hauptbatterie, Antrieb, Ruderanlage, Rumpf, Feuerleitung; ≤ 10 %
    each), captain levels from lifetime XP give points for eleven skills
    (Vorbereitung, Brandschutz, Adrenalinrausch, Tarnexperte …; free respec).
    The 4-point top skill "Manuelle Steuerung der Sekundärbewaffnung" makes the
    secondaries fire only at the Ctrl+click target (none set = silent) with
    55 % (battleships) / 35 % (heavy cruisers) / 30 % (light cruisers) less
    dispersion.
    Saved locally (`warships3d.profile.v1`), "Profil zurücksetzen" in the
    Kapitän panel. Code: `game3d/progress3d.js`.
  - **WoWs scale:** 1 unit = 1 m, maps 16–28 km across, WoWs-like gun ranges,
    shell flight times, spotting/detectability and time-compressed movement.
    Turret traverse is a real gate on firing — only loaded turrets that have
    slewed onto the aim point fire.
  - **Graphics:** animated sea with wakes, sky with time of day and weather
    (dawn, dusk, night, rain, storm), distance haze, island relief, smoke
    screens, muzzle flashes, splashes, fires and flooding. Some missions have a
    weather front that rolls in mid-battle ("Sturmfront zieht auf"): the sky and
    fog darken, rain sets in, waves build, visibility and spotting drop and
    dispersion rises slightly. At night, muzzle flashes light up their
    surroundings and star shells hang over newly spotted enemies. Sunk ships
    list and go down, leaving smoke and a fading oil slick.
  - **Submarines (U-Boote):** six boats — U 96 (Typ VII C, tier 6), U 505
    (Typ IX C, tier 8), HMS Triton (T class, 6), USS Gato (8), I-19 (Typ B1, 7)
    and S-13 (Serie IX-bis, 7). Three depth states, F deeper / G up, a change
    takes 5–9 s:
    *Aufgetaucht* — full speed, deck gun, battery recharges, visible like a
    small destroyer. *Sehrohrtiefe* — 70 % speed, torpedoes from the bow/stern
    tubes (±28° arcs), periscope view through the zoom ladder (circular mask,
    bearing tape, range marks); only spotted within about 1.8 km (the periscope
    feather, less when creeping) or for 14 s after a salvo; shells do half
    damage, torpedoes and ramming hit in full. *Getaucht* — half speed, immune
    to shells, torpedoes and ramming, cannot be sighted, cannot fire; the boat
    sees nothing and only hears ships as hydrophone bearing lines (6 km); the
    battery drains about twice as fast. An empty battery forces the boat up
    until it has recharged to 15 %.
    **ASW:** every surface ship has passive sonar against submerged boats
    (destroyers 3 km, light cruisers 2.4 km, heavier ships 1.2–1.5 km; a slow
    or deep boat is heard at about half that). A contact shows as a pulsing
    ring on screen and map; the boat gets "SONAR-ORTUNG". Destroyers and light
    cruisers carry depth charges (G, 6 or 4 per pattern, 24/32 s reload): the
    only weapon that reaches a deep boat (full damage within 45 m, fading out
    at 135 m). Bot destroyers run down a contact and drop on it, bot capital
    ships turn away from a known boat and zigzag. About 40 % of the random
    battles have one boat per side (always when you sail one); the mission
    *Geleitzugschlacht* puts you in U 96 against
    an escorted convoy. Code: `game3d/submarine.js`, `game3d/ai_sub.js`,
    `game3d/subui.js`.
  - **Aircraft carriers (Flugzeugträger):** Graf Zeppelin (DE, tier 7), Akagi
    (JP, 7), Shōkaku (JP, 8), Ark Royal (UK, 6), Illustrious (UK, 7),
    Enterprise (US, 7), Essex (US, 8) and Béarn (FR, 5), each with its
    historical torpedo bomber, dive bomber and fighter (e.g. TBD Devastator,
    SBD Dauntless, F4F Wildcat on Enterprise). Hangar per type; a squadron of
    6 bombers (4 fighters) takes off one at a time from the deck, flies on
    limited fuel (200 s), attacks in flights of 3 (two runs per squadron),
    returns, lands and needs about 18 s of servicing; planes shot down are
    replaced slowly (one per ~40 s per type). Planes spot for their team
    (60 % of a ship's surface detectability, at most 8 km).
    **Playing a carrier:** 1/2/3 pick the plane type, E launches the squadron
    and switches to it (E again: back to the ship, the squadron flies on and
    picks a target). In the squadron: A/D or the mouse steer, W/S speed (boost
    is limited), mouse wheel camera distance. Hold the left button for the
    attack run — torpedo bombers show a fan that narrows, dive bombers an
    ellipse that shrinks — and release to drop; F recalls. Fighters patrol
    where you click and engage enemy squadrons. The carrier's own dual-purpose
    guns still fire from the ship view.
    **Anti-aircraft fire:** every ship has flak by class, era and navy
    (long-range heavy guns, 37–40 mm mid band, 20 mm close band), shown as
    bursts around the planes; squadrons lose planes one by one. Key 4 shifts
    the flak to port or starboard (stronger there, weaker on the other side).
    Bot ships under air attack turn into the run and stay close to their
    group; bot carriers send strikes at spotted targets and keep fighters
    over the fleet. About 30 % of the random battles have one carrier per side
    (singleplayer only); the historical operation *Schlacht um Midway* puts
    you on Enterprise against the four carriers of the Kido Butai. Carriers
    and aircraft are not available in co-op yet. Code: `game3d/air.js`,
    `game3d/ai_air.js`, `game3d/airui.js`, `game3d/air3d.js`.
  - **Kill camera:** a short cut (about 2 s) to a ship you just sank. Any key or
    click skips it. It never starts during danger, stops as soon as you take
    fire, and can be turned off in the pause menu ("Versenkungs-Kamera").
  - **Shell camera (Geschoss-Kamera):** rides along the shell of your latest
    main-battery salvo that lands closest to the aim point, holds ~0.8 s on the
    splash or hit, then returns to the normal view. Pause menu setting: *Aus*,
    *Mit Taste* (default: B follows the salvo in flight, else the next one) or
    *Jede Salve* (every salvo with ≥ 2.5 s flight time). Any key or click returns
    early; a torpedo warning, a hit on you or a kill cam ends it at once. The
    guns hold fire while it runs, the battle does not slow down. Code:
    `game3d/shellcam.js`.
  - **Sound:** synthesized effects, alert tones ("Torpedos voraus!", "Feuer an
    Bord!", "Wassereinbruch!", "Zitadelle getroffen!", "Gegner versenkt") and
    music that follows the combat (calm, spotted, heavy fire, low health).
    Music and effects volume are set in the pause menu and saved.
  - **Controls (WoWs-style):** fixed centre crosshair with lead ruler and
    turret readiness display.

  | Key | Action |
  |-----|--------|
  | W / S | Engine telegraph one step up / down |
  | A / D | Rudder one step port / starboard |
  | Q | Rudder amidships |
  | Mouse | Bearing (sideways) and range (up/down) |
  | Left click | Fire (only loaded, trained turrets) |
  | Mouse wheel | Zoom ladder: camera distance → binoculars 2× / 4× / 8× / 16× |
  | Shift | Binoculars on/off (last magnification) |
  | C / right click | Free camera (turrets keep the target) |
  | 1 / 2 | HE / AP shells |
  | 3 | Torpedoes · press 3 again: narrow/wide spread |
  | X | Lock / release target |
  | Ctrl + left click | Secondary battery priority target (orange brackets); again or on open sea: clear. Never fires the main battery |
  | L | Lead marker on/off (red diamond: always on screen while an enemy is in sight; edge arrow when the lead point is outside the view, dashed "zu weit" beyond range, pale "außer Sicht" for a target lost a moment ago; green in torpedo mode) |
  | R / T | Damage control / repair party |
  | F / G | Submarine: one depth step down / up (Aufgetaucht → Sehrohrtiefe → Getaucht) |
  | G | Destroyer / light cruiser: drop a depth-charge pattern over the stern |
  | Y / U | Special consumables (boost, smoke …) |
  | M / Tab | Tactical map / scoreboard |
  | H | Controls help |
  | B | Shell camera: follow the salvo in flight, else the next one |
  | P / Esc | Pause |
  | O | Photo mode: pauses the game, free camera (drag + mouse wheel), no HUD · O / Esc: back |

**Play it here:** https://deralo.github.io/warships/ · 3D: https://deralo.github.io/warships/index-3d.html

## Run locally

```
npm start
```

Then open http://localhost:5173 (2D) or http://localhost:5173/index-3d.html (3D).

## Tests

```
node --test tests/sim.test.mjs       # headless 2D simulation tests
node --test tests/missions.test.mjs  # headless 2D campaign checks (every mission, win/lose, stars, survival)
node tests/play.mjs 50               # balance check: N free battles per difficulty
node tests/play.mjs missions 10      # balance check: every campaign mission + survival
node tests/playwright.shots.mjs      # 2D browser self-test + screenshots
node tests/playwright2d.missions.mjs # 2D browser play-test of every mission + survival
node tests/playwright3d.shots.mjs    # 3D browser self-test + screenshots
node --test tests/sim3d.test.mjs     # headless 3D simulation tests (ballistics, AI, missions, career)
node --test tests/missions3d.test.mjs # 3D second mission batch: loads, win and lose paths, 4-min AI runs
node tests/balance3d.mjs strait,cerberus normal 4  # 3D balance: AI-captained win rate per mission/difficulty
node tests/playwright3d.newmissions.mjs # 3D browser smoke test of the second mission batch (menu, briefing, HUD, result)
node --test tests/lead3d.test.mjs    # 3D lead marker maths
node --test tests/sub3d.test.mjs     # 3D submarines: depth states, battery, sonar, depth charges, bot behaviour
node tests/playwright3d.subs.mjs     # 3D browser smoke test of the submarine class (needs the dev server)
node --test tests/zoom3d.test.mjs    # 3D mouse-wheel zoom / binoculars ladder
node tests/playwright3d.zoom.mjs     # 3D browser check of the wheel zoom
node tests/playwright3d.missions.mjs # 3D browser play-test of every mission
node tests/perf3d.mjs                # 3D draw calls + GPU memory across restarts
```
