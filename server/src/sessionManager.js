import crypto from "node:crypto";

/**
 * In-memory session store.
 *
 * LabDrop sessions are intentionally short-lived and never touch disk:
 * a session only ever holds socket ids, timestamps, and a random id —
 * never file contents (files move browser-to-browser over WebRTC).
 */

const SESSION_ID_BYTES = 16; // 128 bits of randomness -> not guessable/enumerable
const DEFAULT_TTL_MS = Number(process.env.SESSION_TTL_MINUTES || 15) * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

class SessionManager {
  constructor() {
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this._sweepTimer = setInterval(() => this._sweepExpired(), SWEEP_INTERVAL_MS);
    this._sweepTimer.unref?.();
  }

  createSession(computerSocketId) {
    const id = crypto.randomBytes(SESSION_ID_BYTES).toString("hex");
    const now = Date.now();
    const session = {
      id,
      computerSocketId,
      mobileSocketId: null,
      createdAt: now,
      expiresAt: now + DEFAULT_TTL_MS,
      status: "waiting", // waiting -> paired -> ended
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  /** Extend a session's life on real activity (peer joined, chunk flowing). */
  touch(id) {
    const session = this.get(id);
    if (!session) return null;
    session.expiresAt = Date.now() + DEFAULT_TTL_MS;
    return session;
  }

  attachMobile(id, mobileSocketId) {
    const session = this.get(id);
    if (!session) return null;
    if (session.mobileSocketId) return null; // already paired - one sender per session
    session.mobileSocketId = mobileSocketId;
    session.status = "paired";
    return session;
  }

  /** Remove a socket id from whichever role it holds; returns the session if it should end. */
  detachSocket(socketId) {
    for (const session of this.sessions.values()) {
      if (session.computerSocketId === socketId) {
        // The receiving computer left - the whole session is meaningless without it.
        this.sessions.delete(session.id);
        return { session, role: "computer" };
      }
      if (session.mobileSocketId === socketId) {
        session.mobileSocketId = null;
        session.status = "waiting";
        return { session, role: "mobile" };
      }
    }
    return null;
  }

  end(id) {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    return session || null;
  }

  _sweepExpired() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  size() {
    return this.sessions.size;
  }
}

export const sessionManager = new SessionManager();
export { DEFAULT_TTL_MS };
