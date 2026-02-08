function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
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

export class RendezvousRoom {
  constructor(state) {
    this.state = state;
    this.sessions = new Map();
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

  closeSession(sessionId) {
    if (!this.sessions.has(sessionId)) return;
    this.sessions.delete(sessionId);
    this.broadcast({ type: "peer-left", peerCount: this.sessions.size });
  }

  async fetch(request) {
    if (!isWebSocketUpgrade(request)) {
      return json({ error: "Expected WebSocket upgrade." }, 426);
    }

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
    this.sessions.set(sessionId, { socket: server, role });

    server.addEventListener("message", (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        this.send(server, { type: "error", message: "Invalid JSON payload." });
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
    });

    server.addEventListener("close", () => {
      this.closeSession(sessionId);
    });

    server.addEventListener("error", () => {
      this.closeSession(sessionId);
    });

    this.send(server, {
      type: "joined",
      roomId,
      role,
      peerCount: this.sessions.size,
    });

    this.broadcast({ type: "peer-joined", peerCount: this.sessions.size }, sessionId);

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname.startsWith("/ws/")) {
      const roomId = normalizeRoomCode(decodePathSegment(url.pathname.slice(4)));
      if (!roomId) {
        return json({ error: "Invalid room id." }, 400);
      }

      const roomObjectId = env.RENDEZVOUS.idFromName(roomId);
      const roomStub = env.RENDEZVOUS.get(roomObjectId);

      return roomStub.fetch(new Request(`https://room/${roomId}`, request));
    }

    return json(
      {
        service: "bg-rendezvous",
        routes: {
          websocket: "GET /ws/:room",
          health: "GET /health",
        },
      },
      200,
    );
  },
};
