# Multiplayer contract (branch `feat/3d-multiplayer`)

Serverless multiplayer for the 3D mode. No own server: browsers connect directly (WebRTC data
channels); public, registration-free infrastructure is used only to find each other.
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
(BroadcastChannel) for browser tests and two tabs on one machine. The real WebRTC transport
implements the same interface.

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

## Co-op rules (`game3d/net/coop.js`, owned by the netcode side)

```js
coopSlots(missionId)   // max human players incl. host (0 = mission not playable in co-op)
```

Matchmaking uses it for the mission picker and the player limit. Every player picks a ship from
their own unlocked ships (local career profile); duplicates are allowed. Missions that prescribe
ships (`fixedShips`) are not offered in co-op for now.

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
| `start` | host -> each client | `v, mission, difficulty, seed, classes, loadouts, names, self` (slot index) |
| `refuse` | host -> client | not in the player list, too late, or `why: 'version'` |
| `abort` | host -> all | host left before the end |
| `bye` | client -> host | client left; its ship goes back to the AI |
| `st` | host -> all, 4 Hz | tick, time left, kills, score, caps, weather; objectives/zones when changed; sonar contacts; roster damage/kills at 1 Hz |
| `me` | host -> each client, 1 Hz | that player's statistics |
| `own` | host -> one client | log line for the own ship only (fire / flooding on board) |
| `end` | host -> each client | `victory`, `reason`, that player's final statistics and rewards |

The host waits up to 8 s for every player's `hello` (missing ones stay bots); a client that sees
no `start` within 15 s gives up.

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
- `?net=local` in the URL switches lobby and transport to BroadcastChannel (no network) so the
  whole flow is testable with two pages of one browser context.
