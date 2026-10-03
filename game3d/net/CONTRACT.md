# Multiplayer contract (branch `feat/3d-multiplayer`)

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
- If the host leaves, the match ends for everybody with a clear message.

## Transport (`game3d/net/transport.js`)

Documented in the file header. `makeMemoryHub()` is for node tests, `makeLocalTransport()`
(BroadcastChannel) for browser tests and two tabs on one machine. The real transport is
`makeRoomTransport()` in `relay.js`; it implements the same interface.

What the real transport guarantees, and what not:

- Every peer is reachable over the brokers ("relay") as soon as both have joined the room. A
  WebRTC data channel ("direct", `transport_rtc.js`, signalling over Nostr relays via Trystero,
  STUN only) is tried beside it and used for the peers where it comes up. The route is per peer
  and may change in both directions during a match; nothing is lost or reordered by a change.
- All channels are ordered per peer and free of duplicates. All channels are reliable **except
  `snap` and `cmd`**: those carry complete states, so over the relay only the newest counts — a
  lost one is not repeated and one that arrives after a newer one is dropped. (Both messages are
  built for that: a snapshot is a full state with a tick, a command repeats its unacknowledged
  actions.) A new game channel that needs every message must not be added to `LATEST` in
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
   mode: 'coop',              // later 'pvp'
   mission: 'standard',       // mission id
   difficulty: 'normal',      // 'easy' | 'normal' | 'hard'
   seed: 123456789,           // uint32 chosen by the host
   players: [                 // host first; order = slot order
      { id: 'peerId', name: 'Kapitän Müller', ship: 'Bismarck' },
   ],
   onEnd(result) {},          // called once when the match is over or aborted:
                              // { aborted: bool, reason: string, victory: bool|null }
}
```

The game owns the transport channels `cmd`, `snap`, `evt`, `sync`. Matchmaking owns `room`,
`chat`. After `onEnd` the lobby shows the room again (the transport stays connected) or the list.

On the host the session transport also has `onRejoin(fn(oldId, newId))`: the lobby calls it when
a former captain of the running match is back (see "Rejoin"); from then on `newId` is a member
and `oldId` is not. The game moves that player's slot to `newId`.

## Co-op rules (`game3d/net/coop.js`, owned by the netcode side)

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

Carriers stay out of net games until the snapshot carries aircraft: `validClass` and
`allowedShips` drop carrier classes, `replaceableBots` skips CV bots, and every net World is built
with `coop: true`, which keeps bot carriers off the roster (`updateAir` returns early with
`world.net` set).

## Game side behaviour (`game3d/net/game.js`)

- `startNetGame(session)` returns at once; the match starts after the handshake below.
- `session.onEnd(result)` is called exactly once per peer: after the results screen ("Zur Lobby"),
  when the player leaves through the pause menu (`aborted: true`), or when the host is gone / the
  match never started (`aborted: true`, `reason` = the German text shown to the player).
- The game never calls `transport.leave()`; it replaces its channel handlers with no-ops on quit.
- A client accepts `snap`/`evt`/`sync` only from `transport.hostId`; the host accepts `cmd` and
  `sync` only from ids in `session.players`. The host does not trust `players[i].ship`: a class
  the mission does not allow falls back to the mission's recommended ship.
- No snapshot for 5 s while the match runs counts as "connection to host lost".
- Every message stays far below 16 kB (snapshot of a 7v7 about 0.6 kB, event batches split at
  60 items).

## Wire protocol (version `NET_VERSION`)

`sync` (JSON objects, `k` = kind):

| k | direction | content |
|---|---|---|
| `hello` | client -> host, every 0.3 s until started | `v`, `loadout` (own career modules/skills) |
| `start` | host -> each client | `v, mission, difficulty, seed, classes, loadouts, names, self` (slot index); `rejoin: 1` when the match is already running |
| `more` | host -> returning client | `n`: `n` items (see `evt`) of the ships that entered the match after the start and still exist |
| `resync` | host -> returning client, after `more` | `b` first event batch it gets, `t` tick, `kc`, `ro` roster `[id, dmg, kills, alive, hpFrac, escaped]`, `obj`, `zn`, `tp` live torpedoes `[T item, visible]`, `sm` smoke `[x, y, r, maxR, life, side, ownerId]`, `me` own statistics, `tg` own `[telegraph, rudder]` |
| `refuse` | host -> client | not in the player list, too late, or `why: 'version'` |
| `abort` | host -> all | host left before the end |
| `bye` | client -> host | client left; its ship goes back to the AI |
| `st` | host -> all, 4 Hz | tick, time left, kills, score, caps, weather; objectives/zones when changed; sonar contacts; roster damage/kills at 1 Hz |
| `me` | host -> each client, 1 Hz | that player's statistics |
| `own` | host -> one client | log line for the own ship only (fire / flooding on board) |
| `end` | host -> each client | `victory`, `reason`, that player's final statistics and rewards |

The host waits up to 8 s for every player's `hello` (missing ones stay bots); a client that sees
no `start` within 15 s gives up.

A `hello` while the match runs is answered only for a slot the lobby has moved with `onRejoin`:
`start` with `rejoin: 1`, `more`, `resync`, then snapshots and events like everybody else; the
AI lets go of the ship. The client shows the match only after `resync` (so its controls start at
the ship's telegraph, not at stop) and gives up after 15 s without it.

`cmd` (client -> host, JSON array): `[seq, telegraph, rudder, aimX, aimY, lockId, actBase,
actions]`. `actions` are the not yet acknowledged one-shot actions of `command.js`, numbered from
`actBase`; the host executes each once and acknowledges the count in every snapshot.

`snap` (host -> client, binary, see the header of `codec.js`): tick, action ack, command echo, all
ships, then the receiver's own-ship detail.

`evt` (host -> all, JSON `[batchSeq, tick, items]`), items by first element: `e` world event,
`s`/`x` shell spawn / removal, `T`/`X` torpedo spawn / removal, `v` torpedo visibility, `f`
effect, `k` smoke, `l` log line, `n`/`r` ship spawn / removal.

## Matchmaking

- A filterable list of open games; a game can be protected by a password.
- Listing entry: `{ id, name, host, mode, mission, difficulty, players, max, locked, state:
  'lobby'|'running', v: NET_VERSION }`. Entries with another `v` are shown as incompatible.
- Player name lives in `localStorage['warships3d.net.name']`.
- Discovery needs no connection between the players: hosts publish their entry on a lobby topic
  of the brokers (on request `who`, on change, and every 4 s; an entry not refreshed for 13 s is
  dropped). The knock (password proof) and its answer go to per-peer topics. All of this is
  public, plain JSON and unauthenticated; the lobby treats it as untrusted input.
- Room state from the host: `{ t: 'state', room, players: [{ id, name, ship, ready, via }] }`;
  `via` is how that player is connected to the host (`'direct'`, `'relay'` or `''`), shown in the
  room as "direkt" / "über Relay". A missing direct connection is not an error.
- **Rejoin.** At the start the host sends every client `{ t: 'seat', seat, token }` (room
  channel, i.e. encrypted, to that player only). The client keeps `{ room, hostId, seat, token,
  key, mission, name, at }` in `sessionStorage['warships3d.net.rejoin']` (per tab: survives a
  reload, not a closed tab; dropped after 3 h, on a regular end, a kick or a closed room). While
  the match runs the list shows that game with "ZURÜCKKEHREN" (the room view: "ZURÜCK INS
  GEFECHT"). The knock then is `{ room, v, seat, proof }` with `proof = SHA-256("knock:" + token +
  ":" + room + ":" + peerId)`; no password needed, the seat's token is the secret. Unknown seat,
  wrong proof or no running match: `{ ok: false, why: 'norejoin' }`. After the room `hello` the
  host gives the seat to the new peer id, calls `onRejoin(oldId, newId)` and sends it the room
  state, the `start` of the match (player ids as they are now, `back: 1`) and its seat again.
  Only the newest holder of a seat is in the match.
- `?net=local` in the URL switches lobby and transport to BroadcastChannel (no network) so the
  whole flow is testable with two pages of one browser context. `?net=relay` uses the brokers
  only and never tries WebRTC.
- External services (lists in `mqtt.js` and `transport_rtc.js`; re-test when multiplayer stops
  finding anybody): MQTT over WSS at HiveMQ (mqtt-dashboard.com / broker.hivemq.com),
  test.mosquitto.org and broker.emqx.io — one reachable broker shared by both players is enough;
  for the direct route additionally public Nostr relays and the STUN servers of Trystero's
  defaults. There is no TURN server.
