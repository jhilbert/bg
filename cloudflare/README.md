# Cloudflare Rendezvous Signaling

This Worker provides lightweight signaling for WebRTC PvP rooms.

## Routes
- `GET /health`
- `GET /rooms`
- `GET|PUT|DELETE /names/:name`
- `GET /ws/:room` (WebSocket upgrade)

## Protocol
Client sends:
- `{ "type": "signal", "payload": { "kind": "offer" | "answer" | "ice-candidate", ... } }`
- `{ "type": "set-name", "name": "Player name", "claim": false }`
- `{ "type": "room-state", "payload": { ...game snapshot... } }`

Server sends:
- `joined`: role assignment (`host` first, `guest` second)
  - includes latest `roomState` snapshot when available
- `peer-joined`
- `peer-left`
- `peer-name`
- `name-updated`
- `name-conflict`
- `signal`: relayed payload from the other peer
- `error`

Room capacity is 2 peers.
The room directory lists only active rooms and includes current player names.
Room records and reserved names are cleaned up after 24 hours of inactivity.
When the last player leaves a room, the game is ended and the room state is purged after 24 hours if nobody returns.

## Deploy
```bash
cd cloudflare
wrangler deploy
```
