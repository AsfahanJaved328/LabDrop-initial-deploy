/**
 * The wire protocol spoken over the WebRTC DataChannel once two browsers
 * are connected. The signaling server never sees any of this - it only
 * ever relays SDP/ICE data to set the connection up.
 *
 * Framing: JSON control messages (strings) are interleaved with raw
 * binary ArrayBuffer chunks. Because RTCDataChannel is ordered and
 * reliable by default, the receiver can treat "chunks between file-start
 * and file-end" as that file's contiguous bytes with no extra framing.
 */

export const CHUNK_SIZE = 64 * 1024; // 64 KiB - safe across Chrome/Firefox/Safari
export const BUFFERED_AMOUNT_HIGH_WATERMARK = 8 * 1024 * 1024; // pause sending above this
export const BUFFERED_AMOUNT_LOW_WATERMARK = 1 * 1024 * 1024; // resume sending below this

const envMaxMb = Number(import.meta.env?.VITE_MAX_FILE_SIZE_MB);
export const MAX_FILE_SIZE_BYTES =
  (Number.isFinite(envMaxMb) && envMaxMb > 0 ? envMaxMb : 500) * 1024 * 1024;

export interface FileDescriptor {
  id: string;
  name: string;
  size: number;
  mimeType: string;
}

export type ControlMessage =
  | { t: "batch-meta"; files: FileDescriptor[] }
  | { t: "batch-decision"; accept: boolean }
  | { t: "file-start"; id: string }
  | { t: "file-end"; id: string; size: number }
  | { t: "cancel"; id?: string }
  | { t: "batch-done" };

export function encode(msg: ControlMessage): string {
  return JSON.stringify(msg);
}

export function tryDecode(raw: string): ControlMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.t === "string") {
      return parsed as ControlMessage;
    }
  } catch {
    // not JSON - callers should only hit this path for string messages anyway
  }
  return null;
}

/** Sanitize a filename before ever using it for a download or on-screen display. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() || "file";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, "_").trim();
  return cleaned.slice(0, 180) || "file";
}

/**
 * A short, unique-enough id for a queued/in-flight file.
 *
 * crypto.randomUUID() is spec'd as secure-context-only, which means it
 * throws on a plain http:// origin - including the LAN-IP dev URL
 * (http://192.168.x.x:5173) this project's own README tells you to scan
 * from a phone for local testing. This avoids that trap everywhere ids
 * are generated, with no behavior change in production (which is HTTPS).
 */
export function genId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID && window.isSecureContext) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${exp === 0 ? value : value.toFixed(1)} ${units[exp]}`;
}
