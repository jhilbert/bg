# Cloudflare Rendezvous Signaling

This Worker provides lightweight signaling for WebRTC PvP rooms.

## Routes
- `GET /health`
- `GET /ws/:room` (WebSocket upgrade)

## Protocol
Client sends:
- `{ "type": "signal", "payload": { "kind": "offer" | "answer" | "ice-candidate", ... } }`

Server sends:
- `joined`: role assignment (`host` first, `guest` second)
- `peer-joined`
- `peer-left`
- `signal`: relayed payload from the other peer
- `error`

Room capacity is 2 peers.

## Deploy
```bash
cd cloudflare
wrangler deploy
```
