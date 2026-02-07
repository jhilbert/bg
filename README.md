# bg
Backgammon single-player web app.

## Usage
- Open `index.html` locally in a browser.
- Click a stack to select a checker, then click a destination point to move.
- Use **Bear Off** to remove a selected checker once all of your pieces are in the home board.
- Use **Save**/**Load** to persist the current game state in local storage.

## Online PvP (WebRTC, no server)
- Switch mode to **Online PvP (WebRTC)**.
- Host clicks **Create Invite** and sends the generated URL (`?offer=...`) to the guest.
- Guest pastes/opens that URL and clicks **Apply Code** to generate an answer URL (`?answer=...`).
- Guest sends the answer URL back to host.
- Host pastes the answer URL and clicks **Apply Code**.
- After connection, game state sync runs directly peer-to-peer over a WebRTC DataChannel.

## Bear off mode
- You can bear off only after all of your remaining checkers are in the home board (points 1-6 for the player). Checkers already borne off still count toward the total, so you can keep bearing off after the first one leaves the board.
- Select a checker on a home board point, then click **Bear Off**. The move will consume one die, just like a normal move.
- A die that matches the exact distance to off is always allowed. If the die is larger than needed, you can bear off only when there are no checkers on higher home points (closer to point 6).
