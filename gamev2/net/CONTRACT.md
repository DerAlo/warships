# Multiplayer contract (modern mode, `gamev2/net`)

Serverless multiplayer for the 3D mode. No own server and no account anywhere: the players find
each other over public, registration-free MQTT brokers; game data flows directly between the
browsers (WebRTC data channel) where that works and through the same brokers, encrypted, where
it does not.
First mode: **co-op against bots**. PvP comes later and must stay possible.

Two work areas meet at the interfaces below. Do not change an interface without updating this file.

## Model: host-authoritative

- The host's browser runs the one real `World` (bots included). Remote players take the place of
  allied bots; the host applies their commands to their ships.
- A client builds a `World` from the same `start` data (same seed, so islands, roster and ship ids
  match) but never simulates ships: it is a **replica** fed by host snapshots, interpolated for
  rendering. `world.player` on a client is that client's own ship, so renderer, HUD, camera,
  minimap and audio keep reading the world as they do today.
- Sides stay `'player'` / `'enemy'` relative to the local player. In co-op all humans are
  `'player'`. Keep the snapshot decoding in one place so a later PvP client can swap sides there.
- Pause, photo mode and kill-cam slow motion never stop the simulation in a net game.
- If the host leaves or its connection is lost, a successor named by the host takes over and the
  match goes on (see "Host migration"); only without a successor it ends for everybody with a
  clear message.

## Transport (`gamev2/net/transport.js`)

Documented in the file header. `makeMemoryHub()` is for node tests, `makeLocalTransport()`
(BroadcastChannel) for browser tests and two tabs on one machine. The real transport is
`makeRoomTransport()` in `relay.js`; it implements the same interface.

What the real transport guarantees, and what not:

- Every peer is reachable over the brokers ("relay") as soon as both have joined the room. A
  WebRTC data channel ("direct", `transport_rtc.js`, signalling over Nostr relays via Trystero,
  STUN only) is tried beside it and used for the peers where it comes up. The route is per peer
  and may change in both directions during a match; nothing is lost or reordered by a change.
- All channels are ordered per peer and free of duplicates. All channels are reliable **except
  `snap`, `cmd` and `mig`**: those carry complete states, so over the relay only the newest counts
  — a lost one is not repeated and one that arrives after a newer one is dropped. (The messages
  are built for that: a snapshot and a migration state are full states with a tick, a command
  repeats its unacknowledged actions.) A new game channel that needs every message must not be added to `LATEST` in
  `relay.js`.
- Brokers are QoS 0 and public: the transport publishes to all connected brokers, deduplicates,
  asks again for missing reliable messages, and paces brokers that limit the message rate. With
  only a rate-limited broker left (`gap` in `mqtt.js`, today broker.emqx.io: 10 messages/s) the
  client receives about 7.5 snapshots/s instead of 20 — every client, also with 3 clients: on
  such a broker one publish on the room topic carries a bundle for each waiting peer, each sealed
  for its receiver as below (`[0][sender id length][sender id][count]` then per receiver
  `[id length][id][length u32][iv][ciphertext]`).
- Measured load with 4 players over the relay only: host upload ~63 kB/s, ~100 publishes/s
  spread over the brokers; each client ~22 kB/s down (see ARCHITECTURE.md, "3 and 4 players").
- Relayed traffic is AES-GCM encrypted with a key derived from the room password. A game
  without password uses a key derived from the public room id: obscurity, not secrecy.
- Extras beyond the interface (optional, absent on the test transports): `link(id)` ->
  `{ via: 'direct' | 'relay', rtt }`, `onRoute(fn(id, via))`, `stats()`. The session transport
  passes `link` and `stats` through.

## Session: the hand-over from matchmaking to the game

When the host starts the match, every peer's lobby code calls `startNetGame(session)`
(exported hook, installed by `main3d.js` as `window.__startNetGame` too):

```js
session = {
   transport,                 // Transport, already connected to the room
   mode: 'coop',              // 'coop' | 'pvp'
   mission: 'standard',       // mission id
   difficulty: 'normal',      // 'easy' | 'normal' | 'hard'
   seed: 123456789,           // uint32 chosen by the host
   players: [                 // host first; order = slot order
      { id: 'peerId', name: 'Kapitän Müller', ship: 'Bismarck' },   // PvP: plus team: 1 | 2
   ],
   onEnd(result) {},          // called once when the match is over or aborted:
                              // { aborted: bool, reason: string, victory: bool|null }
}
```

The game owns the transport channels `cmd`, `snap`, `evt`, `sync`, `mig`. Matchmaking owns
`room`, `chat`. After `onEnd` the lobby shows the room again (the transport stays connected) or
the list.

On the host the session transport also has `onRejoin(fn(oldId, newId))`: the lobby calls it when
a former captain of the running match is back (see "Rejoin"); from then on `newId` is a member
and `oldId` is not. The game moves that player's slot to `newId`.

Host migration adds (all optional for the game, absent on old lobbies):

- `session.onSuccessor(id)`: the game on the host names (or changes) its successor.
- `session.onHost(id)`: on every peer, `id` runs the match from now on (also on the successor
  itself, with its own id).
- The session transport's `hostId` / `isHost` follow the host: the game calls `_setHost(id)` on a
  migration, and `_add(ids)` on the new host for the players the old host knew under other ids
  (rejoined captains). The room transport (`relay.js`) has an assignable `hostId` and
  `setAdmit(fn)` for the lobby of a new host.
- The transport may have `heardAny(exceptId)`: ms since anything (pings included) came from any
  peer of the room but `exceptId`, `null` when nobody else is there. `relay.js` has it, the
  session transport passes it through; the game uses it to tell a lost host from a lost self.
- `onEnd(result)` of the old host after a hand-over carries `handover: true` (and
  `aborted: true`): the lobby leaves the room but keeps the seat for a rejoin.

## Co-op rules (`gamev2/net/coop.js`, owned by the netcode side)

```js
coopSlots(missionId)               // max human players incl. host (0 = mission not playable in co-op)
coopRoles(missionId, difficulty)   // historical operations: [{ cls, name }] per slot, [] otherwise
coopExcluded()                     // { missionId: German reason } of the missions kept out on purpose
```

Matchmaking uses them for the mission picker, the player limit and the room. In a mission with
free ship choice every player picks a ship from their own unlocked ships (local career profile);
duplicates are allowed. A historical operation (`fixedShips`) prescribes the ships: slot 0 (the
host) commands the mission's own ship, the flagship; slot i takes the i-th allied ship the
mission brings, biggest type first (BB, CA, CL, DD, SS), equal types in spawn order; transports
and scripted ships (convoy, route) stay bots. The host lobby sets every player's `ship` to the
slot's class (the player cannot choose, and needs no unlock for it); the game takes the mission's
ship object itself (name, script role, AI orders for when the captain drops) and sets its damage
cut back to full strength. The operation is lost when the flagship sinks.

Kept out: `training` (exercise for one captain, no allied ship), `laststand` (the Bismarck fights
alone), `wahoo` (one US boat, no allied ship). Today's limits (measured with `coopSlots`):
rheinuebung 2 (Bismarck, Prinz Eugen), wolfpack 3, guadalcanal / nordkap / cerberus / vian /
barents / narvik / matapan / dakar / spartivento 4.

Carriers sail in every net game (co-op, historical operations, PvP), as captains' ships and as
bots: `validClass` / `allowedShips` take the mission's `playableShips` as they are, CV bots can be
replaced by a captain (the AI keeps the carrier role when the captain leaves) and random battles
roll bot carriers as in singleplayer. The host runs the air war (`updateAir`); a captain orders
his carrier with the air actions of `cmd` (see "Wire protocol"), the host checks every one: only
a squadron of the sender's own ship, in the air, flown by him where that matters (`B`, `c.air`),
wanted heading clamped to +-1.3 rad of the flight's heading, throttle to -1..1. Measured (node
test, 7v7 standard battle with 2 carrier captains + bot carriers, 2 clients, 120 s, 11.7 flights
in the air on average): 30.5 kB/s download per client (without carriers 24.1, before this change
26.9), 1.6 kB/s upload, host upload 48.1 kB/s. Browser (local transport, 3 captains, 3 flights):
21.5 kB/s per client, host upload 33.1 kB/s.

## PvP rules (`gamev2/net/pvp.js`)

```js
PVP_MAX = 4, TEAM_MAX = 3          // captains per match / per team
pvpMissions()                      // the battles PvP offers: standard, domination
pvpSlots(missionId)                // captains a PvP mission takes (0 = not in PvP)
```

Two teams of human captains; the free places of both fleets are bots, so the fleets are always
even (1v1, 2v2, 2v1 plus a bot, ...). Still host-authoritative: the host's team sails as the
World's side `'player'`, the other team as `'enemy'`; a client of the other team turns its World
round (`setup.flipSides`) and reads every side on the wire through `codec.localSide(side, flip)`.
Bots fight at difficulty `normal` whatever the lobby said. The match is over when every captain of
one team is sunk (or the mission ends otherwise: domination points, time); a captain who leaves
hands the ship to the AI and the match goes on. Rewards and progression as in co-op, each team
from its own objectives. Historical operations stay co-op only. Ship choice: the mission's
`playableShips` (`validClass` / `allowedShips`), as in co-op.

Fairness: each team gets its own `snap` and `evt` stream. A snapshot carries only the ships the
receiving team may see: its own, the spotted ones of the other team, and wrecks
(`codec.visibleTo`). Events about a ship the team cannot see are dropped (shells it fires,
effects on it, spotting events); torpedoes are announced to the other team only once they are
visible (`T` with the current position and `it[7]` = distance already run), log lines, objective
texts, kill feed and the end reason are mirrored for team 2. Sonar contacts go to the host's team
only. Squadrons follow the same rule (`air.squadVisibleTo`): the other team gets a flight only
while one of its ships (within `AIR.seeByShip`, 8 km) or planes (`AIR.seeByPlane`, 4 km) sees it;
events about a hidden flight (its bombs, launches, losses, effects) are dropped; its aerial
torpedoes follow the torpedo rule above. Measured (node test, 2v2, 3 clients, 90 s): 11 to 13 kB/s download per client, host upload
37 kB/s; encoding the snapshots of both teams costs 7 to 8 µs per snapshot tick instead of 4. Over
the relay (browser test, 2v2, 42 s, ships mostly unspotted): 7.6 kB/s per client, 23 kB/s host
upload, about 325 bytes per snapshot for either team.

## Game side behaviour (`gamev2/net/game.js`)

- `startNetGame(session)` returns at once; the match starts after the handshake below.
- `session.onEnd(result)` is called exactly once per peer: after the results screen ("Zur Lobby"),
  when the player leaves through the pause menu (`aborted: true`), or when the host is gone / the
  match never started (`aborted: true`, `reason` = the German text shown to the player).
- The game never calls `transport.leave()`; it replaces its channel handlers with no-ops on quit.
- A client accepts `snap`/`evt`/`sync`/`mig` only from the current host (the session's
  `hostId`, later the peer that announced itself with `host`); the host accepts `cmd` and `sync`
  only from ids in `session.players`. The host does not trust `players[i].ship`: a class the
  mission does not allow falls back to the mission's recommended ship.
- No snapshot for 5 s while the match runs counts as "connection to host lost" (then host
  migration, see below).
- Every message stays far below 16 kB (snapshot of a 7v7 about 0.6 kB, plus 21 bytes per flight
  in the air, at most 64 flights; event batches split at 60 items), except `mig`: about 11–13 kB
  in a 7v7 with carriers (measured 12.1 kB, 10.8 kB without carriers). Neither route limits the size (Trystero
  splits data-channel messages into 16 kB chunks, the brokers take far more).

## Host migration

The host names a **successor**: the first captain in slot order who is still in the match (a
rejoined captain counts under its new id). Everybody learns it from `st.hs`. The host sends the
successor alone a **full state** on the channel `mig` (latest wins) once a second, and at once
when the mission script changes its state (a phase, a flag) or when the host leaves on purpose.
It is a JSON object (`migrate.js`, `packWorld`): `t` tick, `tm` time, `nid` next id, `sh` every
ship with its internals (health, reloads, fires, floods, modules, consumables, turrets,
launchers, statistics, the bot AI's state), `st` every captain's statistics, `scr` the mission
script's state, `tn` its timers, `fr` the weather front, `tp` live torpedoes, `pl` the captains
`[peerId, slot, gone]`, `sq` the squadrons in the air, `ak` the key table of the bot AI states.
Measured (node test, 7v7, 120 s): 10.8 kB per message without carriers, 12.1 kB with two carrier
captains, bot carriers and 11.7 flights in the air on average (before the compact AI and squadron
rows: 13.4 kB without any aircraft); about that many kB/s to the successor, nothing more for the
others. Browser (standard battle, 3 captains): 11.5 kB per
message, about 10 kB/s.

The host is gone when it says `left` (it quit on purpose), when the transport reports it gone, or
after 5 s without a snapshot. Then:

1. The successor waits 0.25 s (a last full state of a leaving host may still be on the way).
   If the host fell silent (not `left`) and the successor heard nobody else of the room for 4 s
   either (`heardAny`), it is the one cut off: it does not take over and ends like the others in
   step 3 (its seat stays, see "Rejoin"). Otherwise it turns its replica World into the authoritative one (newest snapshot and events, completed by
   the newest full state; ships out of the snapshot run on by dead reckoning) and runs the host
   from there. Its own ship stays its own; the old host's ship goes to the AI. It announces
   `{ k: 'host', id, t, team }` on `sync` to everybody and the lobby moves the room and the listing
   to it (`session.onHost`).
2. Every other client shows "Verbindung zum Gastgeber verloren – ein anderer Spieler übernimmt
   …", then "Gastgeber gewechselt – <Name> führt das Gefecht weiter." and points its replica at
   the new host (PvP: a client of the new host's team now reads the sides as they are, the other
   team turned round). Messages of the successor that overtook the announcement are replayed.
   A `host` announcement that comes while the old host still sends snapshots (silent for less
   than 2 s) is held back, and believed once the old host is gone within 8 s; an announcement
   alone never takes a client away from a host it still hears.
3. Without an announcement within 8 s the match ends with "Verbindung zum Host verloren". A
   successor without any full state ends the match too, so does `abort` (a host without
   successor quitting).
4. A host that hears `host` from another peer (it was only cut off for a while) gives up with
   "Ein anderer Spieler hat das Gefecht übernommen." There is no vote; the newest announcement
   wins.

The host's page says goodbye when it is closed or reloaded (`pagehide` -> `quit()`: last full
state and `left`), so the successor runs the match after about 0.3 s (measured, browser, local
and relay); without the goodbye (crash, network) it takes the 5 s snapshot timeout plus 0.25 s
(measured 5.3 s).

The old host may come back as a captain: the lobby gave it a seat at the start like everybody
(see "Rejoin"); the new host's lobby holds the seats (room message `seats`).

What is lost in a migration (by design):

- Shells and depth charges in flight disappear (the console logs the count), so do falling bombs
  and the flak bookkeeping (the AA damage on a flight builds up again at the next AA tick).
  Torpedoes survive, aerial ones included.
- The bot AI keeps its state from the full state (up to 1 s old); long route lists that did not
  fit on the wire are re-planned. Squadrons in the air are carried over (position, planes, fuel,
  ammo, order, whether the captain flies it, the pilots' attack-run state), so are the carriers'
  decks (hangar, service queue, restock and deck timers, selected type); a flight whose carrier is
  gone is dropped (counted as `squads` in the log).
- Up to 1 s of what the successor could not see: reloads, fire and flooding timers, statistics,
  the positions of ships out of its sight (dead reckoning from the full state).
- Mission script timers that were set after the newest full state.
- PvP: the successor receives the whole state, the other team's hidden ships included (its game
  does not show them, but the data is in its browser).
- A host that was only cut off and comes back finds its match taken over (split brain resolved in
  favour of the new host).
- The direct-route (WebRTC) admission check of the new host is not set up again; newcomers come in
  over the relay as before.
- A chat line sent while the host changes may be lost.

## Wire protocol (version `NET_VERSION`)

`sync` (JSON objects, `k` = kind):

| k | direction | content |
|---|---|---|
| `hello` | client -> host, every 0.3 s until started | `v`, `loadout` (own career modules/skills) |
| `start` | host -> each client | `v, mission, difficulty, seed, classes, loadouts, names, self` (slot index); `rejoin: 1` when the match is already running; PvP: `teams` = lobby team (1 / 2) per slot, slot 0's team is the World's `'player'` side; `ht` = the current host's team when it is not slot 0's (after a host migration) |
| `more` | host -> returning client | `n`: `n` items (see `evt`) of the ships that entered the match after the start and still exist |
| `resync` | host -> returning client, after `more` | `b` first event batch it gets, `t` tick, `kc`, `ro` roster `[id, dmg, kills, alive, hpFrac, escaped]`, `obj`, `zn`, `tp` live torpedoes `[T item, visible]`, `sm` smoke `[x, y, r, maxR, life, side, ownerId]`, `me` own statistics, `tg` own `[telegraph, rudder]` |
| `refuse` | host -> client | not in the player list, too late, or `why: 'version'` |
| `abort` | host -> all | host without successor left before the end |
| `left` | host -> all | host left, the successor takes over |
| `host` | new host -> all | `id` (itself), `t` tick, `team` (PvP): it runs the match now |
| `bye` | client -> host | client left; its ship goes back to the AI |
| `st` | host -> all, 4 Hz | tick, time left, kills, score, caps, weather; objectives/zones when changed; sonar contacts; roster damage/kills at 1 Hz; `hs` the successor's peer id |
| `me` | host -> each client, 1 Hz | that player's statistics |
| `own` | host -> one client | log line for the own ship only (fire / flooding on board) |
| `end` | host -> each client | `victory`, `reason`, that player's final statistics and rewards; PvP: `pvp: { win, my, pl: [[name, team, dmg, kills, afloat]] }` (winning team, the receiver's team, every captain) |

The host waits up to 8 s for every player's `hello` (missing ones stay bots); a client that sees
no `start` within 15 s gives up.

A `hello` while the match runs is answered only for a slot the lobby has moved with `onRejoin`:
`start` with `rejoin: 1`, `more`, `resync`, then snapshots and events like everybody else; the
AI lets go of the ship. The client shows the match only after `resync` (so its controls start at
the ship's telegraph, not at stop) and gives up after 15 s without it.

`cmd` (client -> host, JSON array): `[seq, telegraph, rudder, aimX, aimY, lockId, actBase,
actions, air?]`. `actions` are the not yet acknowledged one-shot actions of `command.js`, numbered
from `actBase`; the host executes each once and acknowledges the count in every snapshot. Air
actions (carriers; `sqId` must be a squadron of the sender's ship, else ignored): `['L', type]`
launch `tb`/`db`/`ft` flown by the captain, `['P', sqId]` take the controls, `['H', sqId]` hand it
back to the pilots, `['R', sqId]` recall, `['W', sqId, x, y]` fighters patrol a point, `['B',
sqId]` release the weapons (attack run, only a flight the captain flies); `['F', focus]` AA focus
-1 / 0 / +1 for every ship with AA. `air` (index 8, only while the captain flies a squadron):
`[sqId, wantedHeading, throttle -1|0|1, aiming 0|1]`; the host clamps it (see "Co-op rules"). The
client does not predict air actions; it waits for the snapshot.

`snap` (host -> client, binary, see the header of `codec.js`): tick, action ack, command echo, all
ships, the squadrons the receiver's team sees (`u8` count, 21 bytes each, +4 with a patrol
point: id, owner, type/state/side/aiming/flown bits, planes and armed, position, heading, wanted
heading, altitude, speed, aim time, flak on it), then the receiver's own-ship detail; for a
carrier (detail bit 16) also the deck timer, per type hangar / in service / max / next ready, and
per own flight in the air: fuel, boost, throttle, planes at launch, fighter ammo.

`evt` (host -> all, JSON `[batchSeq, tick, items]`), items by first element: `e` world event,
`s`/`x` shell spawn / removal, `T`/`X` torpedo spawn / removal (`T` = `[T, id, owner, x, y,
heading, tick, run?, air?]`, `air` = 1 for an aerial torpedo), `v` torpedo visibility, `f` effect
(no `flak` bursts: the clients draw them around a flight with flak on it), `b` falling bomb `[b,
x, y, sx, sy, salt, delay, heading, tick]`, `k` smoke, `l` log line, `n`/`r` ship spawn /
removal. In PvP every team has its own batch numbering and its own filtered items (see "PvP
rules"); a `T` that reaches the other team late carries the distance already run in `it[7]`.

`mig` (host -> successor only, JSON, latest wins): the full state, see "Host migration". The bot
AI of each ship is a value array in the order of the key table `ak` (`'~'` = key absent); a
ship's `air` is `[deckT, strikeT, sel, then per type tb, db, ft: hangar, max, restockT, [n, t,
...] service queue]`; a squadron in `sq` is a row `[id, owner, type, state, n, n0, armed, hp, x,
y, alt, altT, heading, want, speed, t, fuel, ammo, boost, patrolT, ditchT, human, order, center,
foeId, ai]` with `order` = 0 | `[kind 0 strike / 1 patrol, targetId, x, y, scout]`, `center` = 0 |
`[x, y]`, `ai` = 0 (as launched) | `[t, phase, errL, errPx, errPy, outT, dropR]`.

`NET_VERSION` is 2 since carriers joined (version 1 peers are listed as incompatible).

## Matchmaking

- A filterable list of open games; a game can be protected by a password.
- Listing entry: `{ id, name, host, mode, mission, difficulty, players, max, locked, state:
  'lobby'|'running', v: NET_VERSION }`. Entries with another `v` are shown as incompatible.
- Player name lives in `localStorage['warshipsv2.net.name']`.
- Discovery needs no connection between the players: hosts publish their entry on a lobby topic
  of the brokers (on request `who`, on change, and every 4 s; an entry not refreshed for 13 s is
  dropped). The knock (password proof) and its answer go to per-peer topics. All of this is
  public, plain JSON and unauthenticated; the lobby treats it as untrusted input.
- Modes: `coop` (Koop gegen Bots) and `pvp`. The list filter filters by mode.
- PvP room: every player has `team` (1 / 2); a newcomer joins the smaller team. A player asks for a
  team with `{ t: 'set', team }`; the host refuses it while `room.teamsLocked`, for a full team
  (`TEAM_MAX`) or outside the lobby. The host moves players, balances (latest joiners move, the
  teams end at most one apart) and locks the teams. Starting needs both teams non-empty. The
  `start` message's players carry `team`.
- Room state from the host: `{ t: 'state', room, players: [{ id, name, ship, ready, via, team }] }`
  (`room.teamsLocked` in PvP);
  `via` is how that player is connected to the host (`'direct'`, `'relay'` or `''`), shown in the
  room as "direkt" / "über Relay". A missing direct connection is not an error.
- **Rejoin.** At the start the host sends every client `{ t: 'seat', seat, token }` (room
  channel, i.e. encrypted, to that player only). The client keeps `{ room, hostId, seat, token,
  key, mission, name, at }` in `sessionStorage['warshipsv2.net.rejoin']` (per tab: survives a
  reload, not a closed tab; dropped after 3 h, on a regular end, a kick or a closed room). While
  the match runs the list shows that game with "ZURÜCKKEHREN" (the room view: "ZURÜCK INS
  GEFECHT"). The knock then is `{ room, v, seat, proof }` with `proof = SHA-256("knock:" + token +
  ":" + room + ":" + peerId)`; no password needed, the seat's token is the secret. Unknown seat,
  wrong proof or no running match: `{ ok: false, why: 'norejoin' }`. After the room `hello` the
  host gives the seat to the new peer id, calls `onRejoin(oldId, newId)` and sends it the room
  state, the `start` of the match (player ids as they are now, `back: 1`) and its seat again.
  Only the newest holder of a seat is in the match. The host keeps a seat of its own (it may
  come back after a host migration). The list finds a game to go back to by its room id, so a
  seat still works when the room has a new host.
- **Host migration (lobby side).** The host sends the successor `{ t: 'seats', seats: [[seat,
  origId, peerId, token, name, ship]], start, banned }` (room channel) when it is named and after
  every rejoin or kick. When the game reports the new host (`session.onHost`), every lobby
  moves `room.hostId`, the saved seat's `hostId` and drops the old host from the player list; a
  client sends the new host a room `hello`. The new host takes over seats, start message and
  banned peers, says "Gastgeber gewechselt – <Name> führt das Spiel weiter." in the room chat and
  publishes the listing (same room id, itself as host). While the match runs, the host leaving or
  `closed` does not drop a client from the room at once: the game decides (successor or over).
  A client whose match ended because the host was lost keeps its seat: it may have been the one
  cut off, and the list offers the way back while the game is listed as running.
- `?net=local` in the URL switches lobby and transport to BroadcastChannel (no network) so the
  whole flow is testable with two pages of one browser context. `?net=relay` uses the brokers
  only and never tries WebRTC.
- External services (lists in `mqtt.js` and `transport_rtc.js`; re-test when multiplayer stops
  finding anybody): MQTT over WSS at HiveMQ (mqtt-dashboard.com / broker.hivemq.com),
  test.mosquitto.org and broker.emqx.io — one reachable broker shared by both players is enough;
  for the direct route additionally public Nostr relays and the STUN servers of Trystero's
  defaults. There is no TURN server.

## Modern mode (V2) additions: `gamev2/net/v2.js`

Everything above is the netcode the modern mode inherited. This part is what it adds. Tests:
`tests/v2.net.test.mjs` (room helper `tests/v2.netutil.mjs`, in-memory hub only).

### Separation from the WW2 game

`NET_VERSION` is 2xx (now 201); the WW2 game counts 1, 2, ... A peer with another number is
refused (`refuse why:'version'`, text `TEXT.version`). Names on the wire and in storage are the
modern mode's own: discovery topic `ksv2/1`, relay `ksv2-relay:`, peer ids `ksv2-net-`, rooms
`ksv2-room:`, storage `warshipsv2.net.*`, test hook `__ksv2Rtc`. A unit test fails when a file in
`gamev2/net` contains one of the WW2 names.

### Rosters

Co-op: every captain sails a west ship (`PLAYABLE`, or the mission's `playableShips`), unlocked in
his career. PvP: lobby team 1 is the west bloc, lobby team 2 (`EAST_TEAM`) the east bloc
(`PLAYABLE_EAST`, no career unlock). `setup.teamShips(mission, team)`, `defaultShip`,
`validClass(mission, cls, team)`; the lobby mirrors it (`allowedShips / ownShips / pickShip` take the
team; the host re-fits a ship when a captain changes team). In PvP a human replaces the bot of the
nearest tier of his side, so both sides stay as strong as the mission built them.

### Snapshot (`snap`, 20 Hz): the V2 block

Behind the squadrons, before the own-ship detail. Always filtered for the receiver's side, in
co-op too: own missiles, every missile its side tracks (`m.detected`), SAMs and rockets of a
launcher it sees, air-to-air missiles of a squadron it sees; helicopters of the own side and the
ones seen.

| part | bytes | content |
|---|---|---|
| missiles | u16 n, n x 16 (+4) | u24 id, u8 type (`M_TYPES`), u8 f1 (kind `M_KINDS` 0..7, host side enemy 8, seeker 16, detected 32, seduced 64, aim point follows 128), u8 f2 (target kind `M_TKS` 0..7, engaged by 0..3 << 3, seeker on a decoy 32, ref is the seeker's lock 64), i16 x/2, i16 y/2, u8 heading, u8 altitude (sqrt scale), u8 speed/4, u24 ref (lock or target id, 0 = none); own side only: i16 tx/2, i16 ty/2 |
| helicopters | u8 n, n x 14 | u16 id, u16 owner, u8 bits (host side enemy 1, state `HELO_STATES` << 1, point mode 8, tracked by the other side 16), i16 x/2, i16 y/2, u8 heading, u8 altitude, u8 speed, u8 fuel, u8 torpedoes |
| ASW torpedoes | u8 n, n x 8 | u24 id, i16 x/2, i16 y/2, u8 heading: the homing torpedoes among the torpedoes the client knows (launched as a `T` item of kind 2) |

Limits `MAX_M` 320, `MAX_H` 32, `MAX_A` 64; a count above them or a short buffer: the snapshot is dropped.

Own V2 detail (u16 length first, then the classic own detail): radar / jammer, SAM doctrine,
selected anti-ship missile, priority target, time since the last launch, magazine per missile type,
SAM channels (target, missile, ready), CIWS targets, rocket and ASW tube timers, helicopter
(ready in, id when out), teams left / team out, seeker warning.

### Slow state (`sync k:'v2'`, 4 Hz, per team, only the parts that changed; all of it in `resync.v2`)

| key | rows |
|---|---|
| `sh` | ships: `[id, bits]`, radar 1, jammer 2, targetable (fire-control track) 4, ESM bearing 8 + `x, y, err, brg, by`. Own side all; other side the detected ones and those only ESM hears |
| `sn` | sites new to this team: `[id, kind, side, x, y, name, r, maxHp]` |
| `si` | sites: `[id, hp fraction, bits (alive 1, radar 2, detected 4, targetable 8), esm...]`; other side: only seen, heard or destroyed ones |
| `tp` | task points of the own side: `[id, x, y, kind, label, workTime, side, siteId, state, teamId]` |
| `tm` | special-forces teams of the own side: `[id, side, owner, task, x, y, state, men, work left, reason]` |
| `bl` | scripted blasts: `[id, x, y, rDestroyed, rHeavy, rShock, t0, done, label]` |
| `dc` | decoy clouds: `[id, side, ship, x, y, t0]`, own side or beside a ship that is seen |

### Events

All new events travel as `e` items like the old ones. In PvP `v2EventFor` decides first:
`vampire` only to the threatened side; `intercept`, helicopter, team, doctrine, ASW and seduction
events only to the side whose platform it is; launches (`ssmLaunch`, `cruiseLaunch`, `samLaunch`,
`aamLaunch`, `rockets`, `decoy`) to the own side and to a side that sees the launcher. Everything
else (hits, `siteHit`, `siteDestroyed`, `blast`) falls through to the general rules.

### Actions (client -> host, inside the command message as before)

`m id` missile at a tracked ship, `b bearing`, `M x y`, `q index` select type, `D doctrine`,
`p id|null` priority target, `r 0|1` radar, `k x y` / `K siteId` cruise missile, `o x y` rockets,
`c 'decoy'|'helo'` consumables, `h` recall / `h 0` screen / `h x y` send the helicopter, `S` put the
team ashore, `g` ASW torpedo (or depth charges). `command.cleanAction(ship, world, a)` is the host's
gate: unknown kinds, wrong arity or types, coordinates outside the map (clamped), a target that is
not a living ship / site / missile / squadron of the other side: dropped and counted
(`host.snapStats().rejected`). An action only ever applies to the sender's ship.
The client does not predict what only the host can make (a missile, a helicopter, a team, decoys):
`replica.act()` sends the order and returns 1; the result arrives with the snapshot. Doctrine and
radar are predicted.

### Host migration and rejoin

`migrate.packWorld` adds `v2` (`v2.packV2`): missiles, helicopters, teams, task points, blasts,
decoys as full rows, the sites' state; the ships' V2 fields ride in `SHIP_KEYS`. `restoreV2` puts
them back; missiles that the successor's newest snapshot no longer carried are dropped. A returning
captain gets the whole slow state in `resync.v2` and the missiles with the next snapshot.

### What the HUD and the renderer read on a client

The replica's World has the same arrays as the host's, filled from the wire:

- `world.missiles[]`: `id, side ('player' = own team), team, kind, type, x, y, px, py, alt, heading,
  speed, tk, target, tx, ty (own side only, else the current position), seekerOn, lock, lockDecoy,
  seduced, detected, eng, alive, net: true`. Not there: `ownerId` (null), `sqId`, `dmg`, `range`, `t`.
- `world.helos[]`: `id, side, ownerId, pos, alt, prev, heading, speed, state, mode, fuel, fuelMax,
  torps, alive, name, nation, net: true`. Not there: `goal`, the sonar timers.
- `world.sites[]`: real site objects (`addSite`) with `hp, alive, radarOn, detected, targetable,
  esmSeen`; a site of the other side exists only once the team has seen or heard it. Not there:
  magazines and SAM channels.
- `world.taskPoints[]`, `world.teams[]` (own side), `world.blasts[]` (`state 'armed' | 'done'`, `age`),
  `world.decoys[]` (`id, side, shipId, x, y, t0`).
- `world.torpedoes[]`: homing ASW torpedoes carry `asw: true` and follow the snapshots.
- every ship: `radarOn, jamming, targetable, esmSeen, heloOut, teamOut`; a ship that only ESM hears
  has `esmSeen` and no valid position.
- the own ship (`world.player`): `mag`, `samDoctrine`, `ssmSel`, `samPriority`, `lastSsmFire`, `samCh`,
  `ciwsTgt`, `rk.readyT`, `ltt { n, readyT }`, `heloT`, `heloOut`, `teamsLeft`, `teamOut`, `seekerWarn`:
  `ssmBlock`, `cruiseBlock`, `heloStatus`, `teamStatus`, `aswStatus`, `samStatus` work on it as on the
  host. Other ships' magazines and SAM channels are not sent.
