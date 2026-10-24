import {
  BUFFERED_AMOUNT_HIGH_WATERMARK,
  BUFFERED_AMOUNT_LOW_WATERMARK,
  CHUNK_SIZE,
  encode,
  tryDecode,
  type FileDescriptor,
} from "./protocol";

export interface SenderCallbacks {
  onChannelOpen?: () => void;
  onDecision?: (accepted: boolean) => void;
  onFileProgress?: (id: string, sentBytes: number) => void;
  onFileComplete?: (id: string) => void;
  onAllComplete?: () => void;
  onCancelledByPeer?: () => void;
  onError?: (message: string) => void;
}

export interface QueuedFile {
  id: string;
  file: File;
}

/** Waits until the data channel has drained below the low watermark. */
function waitForDrain(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount <= BUFFERED_AMOUNT_HIGH_WATERMARK) return Promise.resolve();
  return new Promise((resolve) => {
    const onLow = () => {
      channel.removeEventListener("bufferedamountlow", onLow);
      resolve();
    };
    channel.addEventListener("bufferedamountlow", onLow);
  });
}

export class FileSender {
  private channel: RTCDataChannel;
  private cancelled = false;
  private queue: QueuedFile[];
  private callbacks: SenderCallbacks;

  constructor(pc: RTCPeerConnection, queue: QueuedFile[], callbacks: SenderCallbacks) {
    this.queue = queue;
    this.callbacks = callbacks;
    this.channel = pc.createDataChannel("file-transfer", { ordered: true });
    this.channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_WATERMARK;
    this.channel.binaryType = "arraybuffer";

    this.channel.onopen = () => {
      this.callbacks.onChannelOpen?.();
      const files: FileDescriptor[] = this.queue.map(({ id, file }) => ({
        id,
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
      }));
      this.channel.send(encode({ t: "batch-meta", files }));
    };

    this.channel.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const msg = tryDecode(event.data);
      if (!msg) return;
      if (msg.t === "batch-decision") {
        this.callbacks.onDecision?.(msg.accept);
        if (msg.accept) void this.sendAll();
      } else if (msg.t === "cancel") {
        this.cancelled = true;
        this.callbacks.onCancelledByPeer?.();
      }
    };

    this.channel.onerror = () => this.callbacks.onError?.("The connection to the computer dropped.");

    this.channel.onclose = () => {
      if (!this.cancelled) {
        this.cancelled = true;
        this.callbacks.onError?.("The connection to the computer was lost before the transfer finished.");
      }
    };
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    try {
      this.channel.send(encode({ t: "cancel" }));
    } catch {
      // channel may already be closed - nothing more to do
    }
  }

  private async sendAll() {
    for (const { id, file } of this.queue) {
      if (this.cancelled) return;
      await this.sendOne(id, file);
    }
    if (!this.cancelled) {
      this.channel.send(encode({ t: "batch-done" }));
      this.callbacks.onAllComplete?.();
    }
  }

  private async sendOne(id: string, file: File) {
    try {
      this.channel.send(encode({ t: "file-start", id }));
      let offset = 0;
      while (offset < file.size) {
        if (this.cancelled) return;
        await waitForDrain(this.channel);
        if (this.cancelled || this.channel.readyState !== "open") return;
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();
        this.channel.send(buffer);
        offset += buffer.byteLength;
        this.callbacks.onFileProgress?.(id, offset);
      }
      this.channel.send(encode({ t: "file-end", id, size: file.size }));
      this.callbacks.onFileComplete?.(id);
    } catch {
      // Channel closed mid-send (network drop, peer navigated away, etc).
      // onclose/onerror above will already have reported this to the UI.
    }
  }
}
