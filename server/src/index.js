// Watch Sync relay: one Durable Object per room, at most MAX_PEERS people
// (a Worker variable, 2 by default).
// Uses the WebSocket Hibernation API so idle rooms are not billed for duration.
import { DurableObject } from "cloudflare:workers";

const DEFAULT_MAX_PEERS = 2;
const CODE_RE = /^[A-Z0-9]{4,64}$/;
const CLIENT_RE = /^[a-z0-9-]{8,64}$/;
// Clients ping every 20 s; a socket silent for this long is a ghost (half-open).
const STALE_MS = 60000;
const REPLACED = 4000; // close code: the same install connected again

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!match) return new Response("watch-sync relay", { status: 200 });

    const code = match[1].toUpperCase();
    if (!CODE_RE.test(code)) return new Response("bad room code", { status: 400 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    return stub.fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const id = new URL(request.url).searchParams.get("id") || "";
    const clientId = CLIENT_RE.test(id) ? id : "";
    const now = Date.now();

    // Free seats held by this same install (extension reloaded, browser
    // restarted) or by ghosts that stopped pinging, before counting.
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() || {};
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const lastSeen = Math.max(meta.joinedAt || 0, lastPing ? lastPing.getTime() : 0);
      const sameInstall = clientId && meta.clientId === clientId;
      if (sameInstall || now - lastSeen > STALE_MS) {
        this.drop(ws, sameInstall ? REPLACED : 1001, sameInstall ? "replaced" : "stale");
      }
    }

    const max = Number.parseInt(this.env.MAX_PEERS, 10) || DEFAULT_MAX_PEERS;
    const peers = this.live();
    if (peers.length >= max) {
      return new Response("room full", { status: 409 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const peerId = crypto.randomUUID().slice(0, 8);
    server.serializeAttachment({ peerId, clientId, joinedAt: now });
    this.ctx.acceptWebSocket(server);

    server.send(JSON.stringify({ type: "welcome", peerId, peers: peers.length + 1 }));
    this.broadcast(server, { type: "peer-joined", peerId, peers: peers.length + 1 });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 4096) return;
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    data.from = this.peerIdOf(ws);
    data.serverTs = Date.now();
    this.broadcast(ws, data);
  }

  async webSocketClose(ws, code) {
    // Sockets we dropped ourselves were already announced in drop().
    if ((ws.deserializeAttachment() || {}).dropped) return;
    this.left(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, "closed");
    } catch {}
  }

  async webSocketError(ws) {
    if ((ws.deserializeAttachment() || {}).dropped) return;
    this.left(ws);
  }

  drop(ws, code, reason) {
    ws.serializeAttachment({ ...(ws.deserializeAttachment() || {}), dropped: true });
    try {
      ws.close(code, reason);
    } catch {}
    this.left(ws);
  }

  left(ws) {
    this.broadcast(ws, { type: "peer-left", peerId: this.peerIdOf(ws), peers: this.othersThan(ws) });
  }

  peerIdOf(ws) {
    return (ws.deserializeAttachment() || {}).peerId || "";
  }

  // Sockets we closed can linger in getWebSockets() until the close completes.
  live() {
    return this.ctx.getWebSockets().filter((w) => w.readyState === 1); // 1 = OPEN
  }

  othersThan(ws) {
    return this.live().filter((w) => w !== ws).length;
  }

  broadcast(sender, data) {
    const text = JSON.stringify(data);
    for (const ws of this.live()) {
      if (ws === sender) continue;
      try {
        ws.send(text);
      } catch {}
    }
  }
}
