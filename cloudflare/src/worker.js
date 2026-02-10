const ROOM_PREFIX = "room:";
const NAME_PREFIX = "name:";
const ROOM_STALE_AFTER_MS = 1000 * 60 * 60 * 24;
const NAME_STALE_AFTER_MS = 1000 * 60 * 60 * 24;
const ROOM_EMPTY_CLEANUP_AFTER_MS = 1000 * 60 * 60 * 24;
const ROOM_STATE_KEY = "room_state";
const ROOM_EMPTY_AT_KEY = "room_empty_at";
const ROOM_ID_KEY = "room_id";

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

function normalizeClientId(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 64);
}

function normalizeNameKey(value) {
  const name = normalizePlayerName(value);
  return name ? name.toLowerCase() : "";
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
  const syncSeq = Number.isInteger(rawPayload.syncSeq) && rawPayload.syncSeq >= 0
    ? rawPayload.syncSeq
    : 0;

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
    syncSeq,
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

  toNameStorageKey(nameKey) {
    return `${NAME_PREFIX}${nameKey}`;
  }

  async readActiveNameRecord(rawName) {
    const name = normalizePlayerName(rawName);
    if (!name) {
      return { name: "", nameKey: "", record: null };
    }
    const nameKey = normalizeNameKey(name);
    const storageKey = this.toNameStorageKey(nameKey);
    const existing = await this.state.storage.get(storageKey);
    if (!existing) {
      return { name, nameKey, record: null };
    }
    const updatedAt = Number.isFinite(existing?.updatedAt) ? existing.updatedAt : 0;
    if (!updatedAt || Date.now() - updatedAt > NAME_STALE_AFTER_MS) {
      await this.state.storage.delete(storageKey);
      return { name, nameKey, record: null };
    }
    return { name, nameKey, record: existing };
  }

  async getNameStatus(rawName, rawClientId = "") {
    const clientId = normalizeClientId(rawClientId);
    const { name, record } = await this.readActiveNameRecord(rawName);
    if (!name) {
      return { ok: false, error: "Invalid player name." };
    }
    if (!record) {
      return {
        ok: true,
        name,
        exists: false,
        available: true,
        ownedByRequester: false,
        claimable: false,
      };
    }
    const ownerClientId = normalizeClientId(record.ownerClientId || "");
    const ownedByRequester = Boolean(clientId) && ownerClientId === clientId;
    return {
      ok: true,
      name: normalizePlayerName(record.name || name),
      exists: true,
      available: ownedByRequester,
      ownedByRequester,
      claimable: !ownedByRequester,
    };
  }

  async reserveName(rawName, rawClientId, rawRoomId = "", claim = false) {
    const clientId = normalizeClientId(rawClientId);
    if (!clientId) {
      return { ok: false, error: "Missing client id.", reason: "missing-client" };
    }
    const roomId = normalizeRoomCode(rawRoomId || "");
    const { name, nameKey, record: existing } = await this.readActiveNameRecord(rawName);
    if (!name || !nameKey) {
      return { ok: false, error: "Invalid player name.", reason: "invalid-name" };
    }

    const ownerClientId = normalizeClientId(existing?.ownerClientId || "");
    const ownedByRequester = Boolean(existing) && ownerClientId === clientId;
    if (existing && !ownedByRequester && claim !== true) {
      return {
        ok: false,
        reason: "taken",
        name: normalizePlayerName(existing.name || name),
      };
    }

    const now = Date.now();
    await this.state.storage.put(this.toNameStorageKey(nameKey), {
      name,
      nameKey,
      ownerClientId: clientId,
      roomId,
      updatedAt: now,
      claimedAt: existing && !ownedByRequester
        ? now
        : (Number.isFinite(existing?.claimedAt) ? existing.claimedAt : now),
    });
    return {
      ok: true,
      name,
      claimed: Boolean(existing && !ownedByRequester),
    };
  }

  async releaseName(rawName, rawClientId) {
    const clientId = normalizeClientId(rawClientId);
    const { name, nameKey, record: existing } = await this.readActiveNameRecord(rawName);
    if (!name || !nameKey) {
      return { ok: false, error: "Invalid player name.", reason: "invalid-name" };
    }
    if (!clientId) {
      return { ok: false, error: "Missing client id.", reason: "missing-client" };
    }
    if (!existing) {
      return { ok: true, released: false };
    }
    const ownerClientId = normalizeClientId(existing.ownerClientId || "");
    if (ownerClientId !== clientId) {
      return { ok: false, error: "Name is owned by another client.", reason: "not-owner" };
    }
    await this.state.storage.delete(this.toNameStorageKey(nameKey));
    return { ok: true, released: true };
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

    if (pathname.startsWith("/names/")) {
      const requestedName = normalizePlayerName(decodePathSegment(pathname.slice(7)));
      if (!requestedName) {
        return json({ error: "Invalid player name." }, 400);
      }

      if (request.method === "GET") {
        const clientId = normalizeClientId(
          url.searchParams.get("client") || url.searchParams.get("clientId") || "",
        );
        const status = await this.getNameStatus(requestedName, clientId);
        return json(status, status.ok ? 200 : 400);
      }

      if (request.method === "PUT") {
        let payload;
        try {
          payload = await request.json();
        } catch {
          return json({ error: "Invalid JSON payload." }, 400);
        }
        const result = await this.reserveName(
          requestedName,
          payload?.clientId,
          payload?.roomId,
          payload?.claim === true,
        );
        if (!result.ok && result.reason === "taken") {
          return json(result, 409);
        }
        return json(result, result.ok ? 200 : 400);
      }

      if (request.method === "DELETE") {
        const clientId = normalizeClientId(
          url.searchParams.get("client") || url.searchParams.get("clientId") || "",
        );
        const result = await this.releaseName(requestedName, clientId);
        return json(result, result.ok ? 200 : 409);
      }
    }

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

  getDirectoryStub() {
    if (!this.env?.ROOM_DIRECTORY) return null;
    const directoryObjectId = this.env.ROOM_DIRECTORY.idFromName("global");
    return this.env.ROOM_DIRECTORY.get(directoryObjectId);
  }

  async syncDirectory(roomId) {
    const directoryStub = this.getDirectoryStub();
    if (!directoryStub) return;
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

  async reserveName(name, clientId, roomId, claim = false) {
    const normalizedName = normalizePlayerName(name);
    const normalizedClientId = normalizeClientId(clientId);
    if (!normalizedName) {
      return { ok: false, reason: "invalid-name", error: "Invalid player name." };
    }
    if (!normalizedClientId) {
      return { ok: false, reason: "missing-client", error: "Missing client id." };
    }
    const directoryStub = this.getDirectoryStub();
    if (!directoryStub) {
      return { ok: true, name: normalizedName, claimed: false };
    }
    const targetUrl = `https://directory/names/${encodeURIComponent(normalizedName)}`;
    const response = await directoryStub.fetch(new Request(targetUrl, {
      method: "PUT",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        clientId: normalizedClientId,
        roomId,
        claim: claim === true,
      }),
    }));
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (response.status === 409) {
      return {
        ok: false,
        reason: "taken",
        name: normalizePlayerName(payload?.name || normalizedName),
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: "error",
        error: payload?.error || `Name reservation failed (${response.status}).`,
      };
    }
    return {
      ok: true,
      name: normalizePlayerName(payload?.name || normalizedName),
      claimed: payload?.claimed === true,
    };
  }

  async releaseName(name, clientId) {
    const normalizedName = normalizePlayerName(name);
    const normalizedClientId = normalizeClientId(clientId);
    if (!normalizedName || !normalizedClientId) return;
    const directoryStub = this.getDirectoryStub();
    if (!directoryStub) return;
    const targetUrl = new URL(`https://directory/names/${encodeURIComponent(normalizedName)}`);
    targetUrl.searchParams.set("client", normalizedClientId);
    await directoryStub.fetch(new Request(targetUrl.toString(), { method: "DELETE" }));
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

  async forceEndRoomState() {
    await this.ensureRoomStateLoaded();
    const payload = this.roomState?.payload;
    if (!payload || payload.gameOver === true) return;
    await this.persistRoomState({
      ...payload,
      gameOver: true,
      winnerSide: "",
      resignedBySide: "",
      awaitingRoll: false,
      remainingDice: [],
      diceOwners: [],
      message: "Game ended because all players left the room.",
    });
  }

  async markRoomEmpty(roomId) {
    const now = Date.now();
    await this.state.storage.put(ROOM_ID_KEY, roomId);
    await this.state.storage.put(ROOM_EMPTY_AT_KEY, now);
    await this.state.storage.setAlarm(now + ROOM_EMPTY_CLEANUP_AFTER_MS);
  }

  async clearRoomEmptyMarker(roomId = "") {
    if (roomId) {
      await this.state.storage.put(ROOM_ID_KEY, roomId);
    }
    await this.state.storage.delete(ROOM_EMPTY_AT_KEY);
    if (this.sessions.size > 0) {
      try {
        await this.state.storage.deleteAlarm();
      } catch {
        // No alarm scheduled.
      }
    }
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

  async assignSessionName(sessionId, roomId, rawName, { claim = false } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, reason: "session-missing", error: "Session is no longer active." };
    }
    const nextName = normalizePlayerName(rawName || "");
    const currentName = normalizePlayerName(session.name || "");
    if (!nextName) {
      if (currentName) {
        await this.releaseName(currentName, session.clientId);
      }
      session.name = "";
      this.sessions.set(sessionId, session);
      return { ok: true, changed: currentName !== "", name: "" };
    }

    const reservation = await this.reserveName(nextName, session.clientId, roomId, claim);
    if (!reservation.ok) {
      return reservation;
    }

    const finalName = normalizePlayerName(reservation.name || nextName);
    const changed = currentName.toLowerCase() !== finalName.toLowerCase();
    if (changed && currentName) {
      await this.releaseName(currentName, session.clientId);
    }
    session.name = finalName;
    this.sessions.set(sessionId, session);
    return {
      ok: true,
      changed,
      name: finalName,
      claimed: reservation.claimed === true,
    };
  }

  async handleSessionMessage(sessionId, roomId, role, server, rawData) {
    let parsed;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      this.send(server, { type: "error", message: "Invalid JSON payload." });
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (parsed?.type === "set-name") {
      const result = await this.assignSessionName(
        sessionId,
        roomId,
        parsed?.name || "",
        { claim: parsed?.claim === true },
      );
      if (!result.ok && result.reason === "taken") {
        this.send(server, {
          type: "name-conflict",
          requestedName: normalizePlayerName(parsed?.name || ""),
        });
        return;
      }
      if (!result.ok) {
        this.send(server, {
          type: "error",
          message: result.error || "Could not update player name.",
        });
        return;
      }
      const currentSession = this.sessions.get(sessionId);
      this.send(server, {
        type: "name-updated",
        name: currentSession?.name || "",
        claimed: result.claimed === true,
      });
      if (result.changed) {
        this.broadcast(
          {
            type: "peer-name",
            role,
            name: currentSession?.name || "",
          },
          sessionId,
        );
      }
      await this.syncDirectory(roomId);
      return;
    }

    if (parsed?.type === "room-state") {
      await this.persistRoomState(parsed.payload);
      if (session.name && session.clientId) {
        void this.reserveName(session.name, session.clientId, roomId, false);
      }
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
      await this.persistRoomState(parsed.payload.state || parsed.payload.payload || null);
    }
    if (session.name && session.clientId) {
      void this.reserveName(session.name, session.clientId, roomId, false);
    }
    await this.syncDirectory(roomId);
  }

  async closeSession(sessionId, roomId) {
    if (!this.sessions.has(sessionId)) return;
    this.sessions.delete(sessionId);
    const players = this.serializePlayers();
    this.broadcast({
      type: "peer-left",
      peerCount: this.sessions.size,
      players,
    });
    if (this.sessions.size === 0) {
      await this.forceEndRoomState();
      await this.markRoomEmpty(roomId);
    } else {
      await this.clearRoomEmptyMarker(roomId);
    }
    await this.syncDirectory(roomId);
  }

  async alarm() {
    if (this.sessions.size > 0) return;
    const emptyAt = await this.state.storage.get(ROOM_EMPTY_AT_KEY);
    if (!Number.isFinite(emptyAt)) return;
    const expiresAt = emptyAt + ROOM_EMPTY_CLEANUP_AFTER_MS;
    if (Date.now() < expiresAt) {
      await this.state.storage.setAlarm(expiresAt);
      return;
    }
    await this.state.storage.delete([ROOM_STATE_KEY, ROOM_EMPTY_AT_KEY]);
    this.roomState = null;
    this.roomStateLoaded = true;
    const roomId = normalizeRoomCode(await this.state.storage.get(ROOM_ID_KEY) || "");
    if (roomId) {
      await this.syncDirectory(roomId);
    }
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
    await this.state.storage.put(ROOM_ID_KEY, roomId);

    const role = this.assignRole();
    if (!role) {
      return json({ error: "Room is full (max 2 peers)." }, 409);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const sessionId = crypto.randomUUID();
    const requestedName = normalizePlayerName(url.searchParams.get("name") || "");
    const rawClientId = normalizeClientId(
      url.searchParams.get("client") || url.searchParams.get("clientId") || "",
    );
    const clientId = rawClientId || normalizeClientId(sessionId);
    this.sessions.set(sessionId, {
      socket: server,
      role,
      name: "",
      clientId,
    });

    if (this.sessions.size === 1) {
      await this.clearRoomEmptyMarker(roomId);
    }

    let nameConflict = "";
    if (requestedName) {
      const result = await this.assignSessionName(
        sessionId,
        roomId,
        requestedName,
        { claim: false },
      );
      if (!result.ok && result.reason === "taken") {
        nameConflict = normalizePlayerName(result.name || requestedName);
      }
    }

    server.addEventListener("message", (event) => {
      void this.handleSessionMessage(sessionId, roomId, role, server, event.data);
    });

    server.addEventListener("close", () => {
      void this.closeSession(sessionId, roomId);
    });

    server.addEventListener("error", () => {
      void this.closeSession(sessionId, roomId);
    });

    const players = this.serializePlayers();
    const localSession = this.sessions.get(sessionId);
    this.send(server, {
      type: "joined",
      roomId,
      role,
      peerCount: this.sessions.size,
      players,
      localName: localSession?.name || "",
      roomState: this.roomState?.payload || null,
    });

    if (nameConflict) {
      this.send(server, {
        type: "name-conflict",
        requestedName: nameConflict,
      });
    }

    this.broadcast(
      {
        type: "peer-joined",
        peerCount: this.sessions.size,
        players,
      },
      sessionId,
    );

    await this.syncDirectory(roomId);

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

    if (url.pathname.startsWith("/names/")) {
      const directoryObjectId = env.ROOM_DIRECTORY.idFromName("global");
      const directoryStub = env.ROOM_DIRECTORY.get(directoryObjectId);
      const targetUrl = `https://directory${url.pathname}${url.search}`;
      return directoryStub.fetch(new Request(targetUrl, request));
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
          names: "GET|PUT|DELETE /names/:name",
          websocket: "GET /ws/:room",
          health: "GET /health",
        },
      },
      200,
    );
  },
};
