const ROOM_PREFIX = "room:";
const ROOM_STALE_AFTER_MS = 1000 * 60 * 60 * 6;
const ROOM_STATE_KEY = "room_state";

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function normalizeRoomCode(value) {
  const normalized = (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40);
  return normalized.length >= 4 ? normalized : "";
}

function normalizePlayerName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 22);
}

function normalizeRole(role) {
  return role === "guest" ? "guest" : "host";
}

function normalizePlayers(rawPlayers) {
  if (!Array.isArray(rawPlayers)) return [];
  const byRole = new Map();
  for (const entry of rawPlayers) {
    if (!entry || typeof entry !== "object") continue;
    const role = normalizeRole(entry.role);
    if (byRole.has(role)) continue;
    byRole.set(role, {
      role,
      name: normalizePlayerName(entry.name),
    });
  }
  const players = ["host", "guest"].map((role) => byRole.get(role)).filter(Boolean);
  return players.slice(0, 2);
}

function normalizeRoomStatePayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  if (!Array.isArray(rawPayload.board) || rawPayload.board.length !== 24) return null;
  if (!rawPayload.bar || typeof rawPayload.bar !== "object") return null;
  if (!rawPayload.off || typeof rawPayload.off !== "object") return null;
  if (!Array.isArray(rawPayload.dice)) return null;
  if (!Array.isArray(rawPayload.diceOwners)) return null;
  if (!Array.isArray(rawPayload.remainingDice)) return null;

  return {
    board: rawPayload.board,
    bar: rawPayload.bar,
    off: rawPayload.off,
    turn: rawPayload.turn === "ai" ? "ai" : "player",
    dice: rawPayload.dice,
    diceOwners: rawPayload.diceOwners,
    remainingDice: rawPayload.remainingDice,
    awaitingRoll: rawPayload.awaitingRoll === true,
    openingRollPending: rawPayload.openingRollPending === true,
    showNoMoveDice: rawPayload.showNoMoveDice === true,
    gameOver: rawPayload.gameOver === true,
    winnerSide: rawPayload.winnerSide === "ai" ? "ai" : (rawPayload.winnerSide === "player" ? "player" : ""),
    resignedBySide: rawPayload.resignedBySide === "ai" ? "ai" : (rawPayload.resignedBySide === "player" ? "player" : ""),
    senderSide: rawPayload.senderSide === "ai" ? "ai" : "player",
    senderName: normalizePlayerName(rawPayload.senderName || ""),
    message: String(rawPayload.message || "").slice(0, 220),
  };
}

function isWebSocketUpgrade(request) {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value || "");
  } catch {
    return "";
  }
}

export class RoomDirectory {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  toStorageKey(roomId) {
    return `${ROOM_PREFIX}${roomId}`;
  }

  async upsertRoom(roomId, players, updatedAt = Date.now()) {
    const normalizedPlayers = normalizePlayers(players);
    if (normalizedPlayers.length === 0) {
      await this.state.storage.delete(this.toStorageKey(roomId));
      return null;
    }
    const record = {
      roomId,
      playerCount: normalizedPlayers.length,
      players: normalizedPlayers,
      updatedAt,
    };
    await this.state.storage.put(this.toStorageKey(roomId), record);
    return record;
  }

  async removeRoom(roomId) {
    await this.state.storage.delete(this.toStorageKey(roomId));
  }

  async listRooms() {
    const now = Date.now();
    const staleKeys = [];
    const list = await this.state.storage.list({ prefix: ROOM_PREFIX });
    const rooms = [];

    for (const [key, value] of list.entries()) {
      const roomId = normalizeRoomCode(value?.roomId || key.slice(ROOM_PREFIX.length));
      if (!roomId) {
        staleKeys.push(key);
        continue;
      }

      const normalizedPlayers = normalizePlayers(value?.players);
      const updatedAt = Number.isFinite(value?.updatedAt) ? value.updatedAt : 0;
      if (normalizedPlayers.length === 0 || now - updatedAt > ROOM_STALE_AFTER_MS) {
        staleKeys.push(key);
        continue;
      }

      rooms.push({
        roomId,
        playerCount: normalizedPlayers.length,
        players: normalizedPlayers,
        updatedAt,
        openSeat: normalizedPlayers.length === 1,
      });
    }

    if (staleKeys.length > 0) {
      await this.state.storage.delete(staleKeys);
    }

    rooms.sort((left, right) => {
      const delta = right.updatedAt - left.updatedAt;
      if (delta !== 0) return delta;
      return left.roomId.localeCompare(right.roomId);
    });

    return rooms;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname || "/";

    if (request.method === "GET" && pathname === "/rooms") {
      const rooms = await this.listRooms();
      return json({ rooms }, 200);
    }

    if (pathname.startsWith("/rooms/")) {
      const roomId = normalizeRoomCode(decodePathSegment(pathname.slice(7)));
      if (!roomId) {
        return json({ error: "Invalid room id." }, 400);
      }

      if (request.method === "PUT") {
        let payload;
        try {
          payload = await request.json();
        } catch {
          return json({ error: "Invalid JSON payload." }, 400);
        }

        const updatedAt = Number.isFinite(payload?.updatedAt) ? payload.updatedAt : Date.now();
        const record = await this.upsertRoom(roomId, payload?.players, updatedAt);
        return json({ ok: true, room: record }, 200);
      }

      if (request.method === "DELETE") {
        await this.removeRoom(roomId);
        return json({ ok: true }, 200);
      }
    }

    return json({ error: "Not found." }, 404);
  }
}

export class RendezvousRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.roomState = null;
    this.roomStateLoaded = false;
  }

  assignRole() {
    const takenRoles = new Set();
    for (const session of this.sessions.values()) {
      takenRoles.add(session.role);
    }
    if (!takenRoles.has("host")) return "host";
    if (!takenRoles.has("guest")) return "guest";
    return null;
  }

  serializePlayers() {
    const players = [];
    for (const session of this.sessions.values()) {
      players.push({
        role: normalizeRole(session.role),
        name: normalizePlayerName(session.name),
      });
    }
    players.sort((left, right) => {
      if (left.role === right.role) return 0;
      return left.role === "host" ? -1 : 1;
    });
    return players.slice(0, 2);
  }

  async syncDirectory(roomId) {
    if (!this.env?.ROOM_DIRECTORY) return;
    const directoryObjectId = this.env.ROOM_DIRECTORY.idFromName("global");
    const directoryStub = this.env.ROOM_DIRECTORY.get(directoryObjectId);
    const targetUrl = `https://directory/rooms/${encodeURIComponent(roomId)}`;
    const players = this.serializePlayers();
    if (players.length === 0) {
      await directoryStub.fetch(new Request(targetUrl, { method: "DELETE" }));
      return;
    }
    await directoryStub.fetch(new Request(targetUrl, {
      method: "PUT",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        roomId,
        players,
        updatedAt: Date.now(),
      }),
    }));
  }

  async ensureRoomStateLoaded() {
    if (this.roomStateLoaded) return;
    this.roomStateLoaded = true;
    const stored = await this.state.storage.get(ROOM_STATE_KEY);
    const candidatePayload = stored?.payload || stored;
    const payload = normalizeRoomStatePayload(candidatePayload);
    if (!payload) {
      this.roomState = null;
      return;
    }
    this.roomState = {
      payload,
      updatedAt: Number.isFinite(stored?.updatedAt) ? stored.updatedAt : Date.now(),
    };
  }

  async persistRoomState(rawPayload) {
    const payload = normalizeRoomStatePayload(rawPayload);
    if (!payload) return false;
    this.roomState = {
      payload,
      updatedAt: Date.now(),
    };
    await this.state.storage.put(ROOM_STATE_KEY, this.roomState);
    return true;
  }

  send(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // Ignore send failures; close handlers will clean up stale sessions.
    }
  }

  broadcast(payload, exceptSessionId = null) {
    for (const [sessionId, session] of this.sessions) {
      if (sessionId === exceptSessionId) continue;
      this.send(session.socket, payload);
    }
  }

  closeSession(sessionId, roomId) {
    if (!this.sessions.has(sessionId)) return;
    this.sessions.delete(sessionId);
    const players = this.serializePlayers();
    this.broadcast({
      type: "peer-left",
      peerCount: this.sessions.size,
      players,
    });
    void this.syncDirectory(roomId);
  }

  async fetch(request) {
    if (!isWebSocketUpgrade(request)) {
      return json({ error: "Expected WebSocket upgrade." }, 426);
    }

    await this.ensureRoomStateLoaded();

    const url = new URL(request.url);
    const roomId = normalizeRoomCode(decodePathSegment(url.pathname.slice(1)));
    if (!roomId) {
      return json({ error: "Invalid room id." }, 400);
    }

    const role = this.assignRole();
    if (!role) {
      return json({ error: "Room is full (max 2 peers)." }, 409);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const sessionId = crypto.randomUUID();
    const playerName = normalizePlayerName(url.searchParams.get("name") || "");
    this.sessions.set(sessionId, { socket: server, role, name: playerName });

    server.addEventListener("message", (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        this.send(server, { type: "error", message: "Invalid JSON payload." });
        return;
      }

      if (parsed?.type === "set-name") {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        session.name = normalizePlayerName(parsed?.name || "");
        this.sessions.set(sessionId, session);
        this.send(server, { type: "name-updated", name: session.name });
        this.broadcast(
          {
            type: "peer-name",
            role,
            name: session.name,
          },
          sessionId,
        );
        void this.syncDirectory(roomId);
        return;
      }

      if (parsed?.type === "room-state") {
        void this.persistRoomState(parsed.payload);
        return;
      }

      if (parsed?.type !== "signal") {
        this.send(server, { type: "error", message: "Unsupported message type." });
        return;
      }

      this.broadcast(
        {
          type: "signal",
          fromRole: role,
          payload: parsed.payload,
        },
        sessionId,
      );
      if (parsed?.payload?.kind === "state-sync") {
        void this.persistRoomState(parsed.payload.state || parsed.payload.payload || null);
      }
      void this.syncDirectory(roomId);
    });

    server.addEventListener("close", () => {
      this.closeSession(sessionId, roomId);
    });

    server.addEventListener("error", () => {
      this.closeSession(sessionId, roomId);
    });

    const players = this.serializePlayers();
    this.send(server, {
      type: "joined",
      roomId,
      role,
      peerCount: this.sessions.size,
      players,
      roomState: this.roomState?.payload || null,
    });

    this.broadcast(
      {
        type: "peer-joined",
        peerCount: this.sessions.size,
        players,
      },
      sessionId,
    );

    void this.syncDirectory(roomId);

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200, headers: corsHeaders() });
    }

    if (url.pathname === "/rooms") {
      const directoryObjectId = env.ROOM_DIRECTORY.idFromName("global");
      const directoryStub = env.ROOM_DIRECTORY.get(directoryObjectId);
      return directoryStub.fetch(new Request("https://directory/rooms", request));
    }

    if (url.pathname.startsWith("/ws/")) {
      const roomId = normalizeRoomCode(decodePathSegment(url.pathname.slice(4)));
      if (!roomId) {
        return json({ error: "Invalid room id." }, 400);
      }

      const roomObjectId = env.RENDEZVOUS.idFromName(roomId);
      const roomStub = env.RENDEZVOUS.get(roomObjectId);
      const roomUrl = new URL(`https://room/${roomId}`);
      roomUrl.search = url.search;

      return roomStub.fetch(new Request(roomUrl.toString(), request));
    }

    return json(
      {
        service: "bg-rendezvous",
        routes: {
          rooms: "GET /rooms",
          websocket: "GET /ws/:room",
          health: "GET /health",
        },
      },
      200,
    );
  },
};
