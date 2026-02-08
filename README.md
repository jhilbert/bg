# bg
Backgammon single-player web app.

## Usage
- Open `index.html` locally in a browser.
- Click a stack to select a checker, then click a destination point to move.
- Use **Bear Off** to remove a selected checker once all of your pieces are in the home board.
- Use **Save**/**Load** to persist the current game state in local storage.

## Online PvP (WebRTC + Cloudflare Durable Objects signaling)
The app now uses a tiny rendezvous service for signaling (offer/answer + trickle ICE), fixed to:
- `https://bg-rendezvous.hilbert.workers.dev`

Players connect with a room link only; there is no signaling URL field in the UI.

### 1) For developers: deploy/update signaling service
- Install Wrangler: `npm i -g wrangler`
- Login: `wrangler login`
- Deploy from this repo:
  - `cd cloudflare`
  - `wrangler deploy`
- If the endpoint changes, update `SIGNALING_BASE_URL` in `script.js`.

### 2) Use the room flow in the UI
- Default mode is **Vs Computer**.
- Click **Play vs human** in the top panel.
- In the modal: host clicks **Create Room Link** and sends it to guest.
- Guest opens the link (or pastes room code/link in the modal and clicks **Join Room**).
- Once connected, the top-panel action changes to **LEAVE room**.
- Signaling relays through Durable Objects; WebRTC connects automatically.

## Bear off mode
- You can bear off only after all of your remaining checkers are in the home board (points 1-6 for the player). Checkers already borne off still count toward the total, so you can keep bearing off after the first one leaves the board.
- Select a checker on a home board point, then click **Bear Off**. The move will consume one die, just like a normal move.
- A die that matches the exact distance to off is always allowed. If the die is larger than needed, you can bear off only when there are no checkers on higher home points (closer to point 6).
