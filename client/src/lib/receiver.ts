import {
  MAX_FILE_SIZE_BYTES,
  encode,
  sanitizeFilename,
  tryDecode,
  type FileDescriptor,
} from "./protocol";

export interface ReceivedFile {
  descriptor: FileDescriptor;
  blob: Blob;
}

export interface ReceiverCallbacks {
  /** Called when the phone announces what it wants to send; return true to accept, false to reject. */
  onBatchOffered?: (files: FileDescriptor[]) => Promise<boolean> | boolean;
  onFileStart?: (id: string) => void;
  onFileProgress?: (id: string, receivedBytes: number, totalBytes: number) => void;
  onFileComplete?: (result: ReceivedFile) => void;
  onBatchDone?: () => void;
  onCancelledByPeer?: () => void;
  onError?: (message: string) => void;
}

export class FileReceiver {
  private channel: RTCDataChannel | null = null;
  private descriptors = new Map<string, FileDescriptor>();
  private currentId: string | null = null;
  private currentChunks: ArrayBuffer[] = [];
  private currentBytes = 0;
  private callbacks: ReceiverCallbacks;

  constructor(pc: RTCPeerConnection, callbacks: ReceiverCallbacks) {
    this.callbacks = callbacks;
    pc.ondatachannel = (event) => this.attach(event.channel);
  }

  private attach(channel: RTCDataChannel) {
    this.channel = channel;
    channel.binaryType = "arraybuffer";

    channel.onmessage = (event) => {
      if (typeof event.data === "string") {
        void this.handleControl(event.data);
      } else {
        this.handleChunk(event.data as ArrayBuffer);
      }
    };

    channel.onerror = () => this.callbacks.onError?.("The connection to the phone dropped.");

    channel.onclose = () => {
      if (this.currentId) {
        this.callbacks.onError?.("The connection to the phone was lost before the transfer finished.");
        this.currentId = null;
        this.currentChunks = [];
        this.currentBytes = 0;
      }
    };
  }

  private send(msg: Parameters<typeof encode>[0]) {
    if (this.channel?.readyState === "open") this.channel.send(encode(msg));
  }

  private async handleControl(raw: string) {
    const msg = tryDecode(raw);
    if (!msg) return;

    if (msg.t === "batch-meta") {
      const oversized = msg.files.filter((f) => f.size > MAX_FILE_SIZE_BYTES);
      if (oversized.length > 0) {
        this.send({ t: "cancel" });
        this.callbacks.onError?.(
          `"${oversized[0].name}" is larger than the ${Math.round(
            MAX_FILE_SIZE_BYTES / (1024 * 1024)
          )} MB limit for this session.`
        );
        return;
      }
      for (const f of msg.files) {
        this.descriptors.set(f.id, { ...f, name: sanitizeFilename(f.name) });
      }
      const accepted = (await this.callbacks.onBatchOffered?.(msg.files)) ?? false;
      this.send({ t: "batch-decision", accept: accepted });
    } else if (msg.t === "file-start") {
      this.currentId = msg.id;
      this.currentChunks = [];
      this.currentBytes = 0;
      this.callbacks.onFileStart?.(msg.id);
    } else if (msg.t === "file-end") {
      if (this.currentId !== msg.id) return;
      const descriptor = this.descriptors.get(msg.id);
      if (!descriptor) return;
      if (this.currentBytes !== msg.size) {
        this.callbacks.onError?.(`"${descriptor.name}" arrived incomplete and was discarded.`);
      } else {
        const blob = new Blob(this.currentChunks, { type: descriptor.mimeType });
        this.callbacks.onFileComplete?.({ descriptor, blob });
      }
      this.currentId = null;
      this.currentChunks = [];
      this.currentBytes = 0;
    } else if (msg.t === "cancel") {
      this.currentId = null;
      this.currentChunks = [];
      this.currentBytes = 0;
      this.callbacks.onCancelledByPeer?.();
    } else if (msg.t === "batch-done") {
      this.callbacks.onBatchDone?.();
    }
  }

  private handleChunk(buffer: ArrayBuffer) {
    if (!this.currentId) return;
    this.currentChunks.push(buffer);
    this.currentBytes += buffer.byteLength;
    const descriptor = this.descriptors.get(this.currentId);
    this.callbacks.onFileProgress?.(this.currentId, this.currentBytes, descriptor?.size ?? 0);
  }

  reject() {
    this.send({ t: "batch-decision", accept: false });
  }
}

/** Triggers a browser download for a received file without navigating away. */
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
