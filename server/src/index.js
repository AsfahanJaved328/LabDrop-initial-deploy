import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createServer } from "node:http";
import { Server } from "socket.io";

import { sessionManager, DEFAULT_TTL_MS } from "./sessionManager.js";
import { createRateLimiter } from "./socketRateLimit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 4000);
const NODE_ENV = process.env.NODE_ENV || "development";
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173").split(",").map((value) => value.trim()).filter(Boolean);
const CLIENT_DIST = path.join(__dirname, "../../client/dist");
const LAN_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?$/i;

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (CLIENT_ORIGINS.includes(origin)) return true;
  return LAN_ORIGIN_RE.test(origin);
}

const app = express();

// --- Security headers -------------------------------------------------
app.use(
  helmet({
    // The app ships no inline scripts of its own; Vite's build output is
    // hashed/external, so a conservative default CSP is fine here. If you
    // add third-party embeds, loosen this deliberately instead of removing it.
    contentSecurityPolicy: NODE_ENV === "production" ? undefined : false,
  })
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin not allowed by CORS"));
    },
    methods: ["GET", "POST"],
  })
);

app.use(express.json({ limit: "16kb" })); // signaling payloads are tiny; file bytes never hit HTTP

// --- HTTP rate limiting -------------------------------------------------
const httpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(httpLimiter);

// --- Health check ---------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: sessionManager.size(), env: NODE_ENV });
});

// --- Serve the built frontend in production -------------------------
if (NODE_ENV === "production") {
  app.use(express.static(CLIENT_DIST));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
}

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin not allowed by CORS"));
    },
    methods: ["GET", "POST"],
  },
  // Sessions are short-lived and stateless-ish; no need for long reconnection windows.
  connectionStateRecovery: {
    maxDisconnectionDuration: 15 * 1000,
  },
});

// --- Per-IP rate limits on the signaling events that could be abused ---
const allowCreateSession = createRateLimiter({ windowMs: 60 * 1000, max: 10 });
const allowJoinAttempt = createRateLimiter({ windowMs: 60 * 1000, max: 20 });
const allowSignal = createRateLimiter({ windowMs: 10 * 1000, max: 200 });

function clientIp(socket) {
  // Trust the first hop only if you put LabDrop behind a known proxy (Railway does this safely).
  return socket.handshake.headers["x-forwarded-for"]?.split(",")[0]?.trim() || socket.handshake.address;
}

function roomFor(sessionId) {
  return `session:${sessionId}`;
}

io.on("connection", (socket) => {
  const ip = clientIp(socket);

  // A computer requests a brand-new, short-lived transfer session.
  socket.on("create-session", (_payload, ack) => {
    if (typeof ack !== "function") return;
    if (!allowCreateSession(ip)) {
      return ack({ ok: false, error: "Too many sessions created. Please wait a minute and try again." });
    }
    const session = sessionManager.createSession(socket.id);
    socket.join(roomFor(session.id));
    socket.data.role = "computer";
    socket.data.sessionId = session.id;
    ack({ ok: true, sessionId: session.id, expiresAt: session.expiresAt, ttlMs: DEFAULT_TTL_MS });
  });

  // A phone, having scanned the QR code, asks to join that session.
  socket.on("join-session", (payload, ack) => {
    if (typeof ack !== "function") return;
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    if (!allowJoinAttempt(ip)) {
      return ack({ ok: false, error: "Too many join attempts. Please wait a minute and try again." });
    }
    if (!/^[a-f0-9]{32}$/.test(sessionId)) {
      return ack({ ok: false, error: "That link looks invalid. Ask the computer for a fresh QR code." });
    }
    const session = sessionManager.attachMobile(sessionId, socket.id);
    if (!session) {
      return ack({ ok: false, error: "This session has expired, ended, or already has a sender connected." });
    }
    socket.join(roomFor(sessionId));
    socket.data.role = "mobile";
    socket.data.sessionId = sessionId;
    ack({ ok: true, sessionId });
    socket.to(roomFor(sessionId)).emit("peer-joined", { peerId: socket.id });
  });

  // Relay WebRTC offer/answer/ICE candidates between the two peers in a session.
  // The server never looks at file contents - it only shuttles connection setup data.
  socket.on("webrtc-signal", (payload) => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !payload || typeof payload !== "object") return;
    if (!allowSignal(ip)) return;
    const session = sessionManager.touch(sessionId);
    if (!session) return;
    socket.to(roomFor(sessionId)).emit("webrtc-signal", { from: socket.id, data: payload.data });
  });

  // Lightweight activity ping so an in-progress transfer keeps the session alive.
  socket.on("keep-alive", () => {
    if (socket.data.sessionId) sessionManager.touch(socket.data.sessionId);
  });

  // The computer explicitly ends the session (button press) or disconnects.
  socket.on("end-session", (_payload, ack) => {
    const sessionId = socket.data.sessionId;
    if (sessionId && socket.data.role === "computer") {
      sessionManager.end(sessionId);
      io.to(roomFor(sessionId)).emit("session-ended", { reason: "ended-by-computer" });
      io.socketsLeave(roomFor(sessionId));
    }
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("disconnect", () => {
    const result = sessionManager.detachSocket(socket.id);
    if (!result) return;
    const { session, role } = result;
    if (role === "computer") {
      io.to(roomFor(session.id)).emit("session-ended", { reason: "computer-disconnected" });
    } else {
      io.to(roomFor(session.id)).emit("peer-left", { reason: "mobile-disconnected" });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`LabDrop signaling server listening on :${PORT} [${NODE_ENV}]`);
});
