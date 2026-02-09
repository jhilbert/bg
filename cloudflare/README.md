# Cloudflare Rendezvous Signaling

This Worker provides lightweight signaling for WebRTC PvP rooms.

## Routes
- `GET /health`
- `GET /rooms`
- `GET /ws/:room` (WebSocket upgrade)

## Protocol
Client sends:
- `{ "type": "signal", "payload": { "kind": "offer" | "answer" | "ice-candidate", ... } }`
- `{ "type": "set-name", "name": "Player name" }`
- `{ "type": "room-state", "payload": { ...game snapshot... } }`

Server sends:
- `joined`: role assignment (`host` first, `guest` second)
  - includes latest `roomState` snapshot when available
- `peer-joined`
- `peer-left`
- `peer-name`
- `signal`: relayed payload from the other peer
- `error`

Room capacity is 2 peers.
The room directory lists only active rooms and includes current player names.

## Deploy
```bash
cd cloudflare
wrangler deploy
```
