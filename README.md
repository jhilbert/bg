# bg
Backgammon single-player web app.

## Usage
- Open `index.html` locally in a browser.
- Click a stack to select a checker, then click a destination point to move.
- Use **Bear Off** to remove a selected checker once all of your pieces are in the home board.
- Use **Resign** to concede the current game (confirmation required).

## Versioning
- Version format: `VYYYY-MM-DD-N` (example: `V2026-02-08-1`).
- The same value is written to:
  - `index.html` CSS URL query (`style.css?v=...`)
  - `index.html` JS URL query (`script.js?v=...`)
  - `script.js` `COMMIT_VERSION` (shown top-right in UI)
- Auto-bump on every commit is enabled via Git hook path:
  - `core.hooksPath=.githooks`
- Manual bump (optional):
  - `./scripts/bump-version.sh`
  - or set explicitly: `./scripts/bump-version.sh V2026-02-08-3`

## Online PvP (WebRTC + Cloudflare Durable Objects signaling)
The app now uses a tiny rendezvous service for signaling (offer/answer + trickle ICE), fixed to:
- `https://bg-rendezvous.hilbert.workers.dev`

Players connect through a shared room list backed by Cloudflare Durable Objects.

### 1) For developers: deploy/update signaling service
- Install Wrangler: `npm i -g wrangler`
- Login: `wrangler login`
- Deploy from this repo:
  - `cd cloudflare`
  - `wrangler deploy`
- If the endpoint changes, update `SIGNALING_BASE_URL` in `script.js`.

### 2) Use the room flow in the UI
- Default mode is **Vs Computer**.
- Click **Rooms** in the top panel.
- In the modal, set your player name (optional but recommended).
- Click **Create New Room** to create a room and join it as host.
- Other players open the same modal, see active rooms, and click **Join** on rooms with one player.
- To leave your room, open **Rooms** and click **Leave** on your current room entry.
- Signaling and room directory state relay through Durable Objects; WebRTC connects automatically.

## Bear off mode
- You can bear off only after all of your remaining checkers are in the home board (points 1-6 for the player). Checkers already borne off still count toward the total, so you can keep bearing off after the first one leaves the board.
- Select a checker on a home board point, then click **Bear Off**. The move will consume one die, just like a normal move.
- A die that matches the exact distance to off is always allowed. If the die is larger than needed, you can bear off only when there are no checkers on higher home points (closer to point 6).
