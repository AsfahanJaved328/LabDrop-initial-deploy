import { io, type Socket } from "socket.io-client";

// In dev, Vite proxies /socket.io to the local server (see vite.config.ts).
// In production, the server serves the built client itself, so same-origin
// works there too. VITE_SERVER_URL lets you point at a separate backend
// origin if you ever split frontend/backend hosting.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || undefined;

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SERVER_URL, {
      autoConnect: true,
      transports: ["websocket", "polling"],
    });
  }
  return socket;
}
