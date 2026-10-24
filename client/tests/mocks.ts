/**
 * Minimal mock of RTCPeerConnection + RTCDataChannel, just enough to run
 * sender.ts/receiver.ts for real against each other in plain Node - no
 * browser, no actual network. This does NOT test real ICE/SDP negotiation
 * (that's standard browser plumbing, not this project's code); it tests
 * the thing this project actually implements: the chunking, backpressure,
 * accept/reject, cancel, and reassembly protocol.
 *
 * Network drain is simulated with a real (small) delay so backpressure
 * (bufferedAmount / bufferedAmountLowThreshold / 'bufferedamountlow') is
 * exercised exactly as it would be against a real DataChannel under load,
 * not short-circuited.
 */

type Listener = () => void;

export class MockDataChannel {
  binaryType: "arraybuffer" | "blob" = "blob";
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peakBufferedAmount = 0;

  onopen: Listener | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: Listener | null = null;
  onclose: Listener | null = null;

  private peer: MockDataChannel | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private drainDelayMs: number;

  constructor(drainDelayMs = 2) {
    this.drainDelayMs = drainDelayMs;
  }

  linkTo(peer: MockDataChannel) {
    this.peer = peer;
  }

  open() {
    this.readyState = "open";
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("MockDataChannel: send() on a channel that is not open");
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    this.bufferedAmount += size;
    this.peakBufferedAmount = Math.max(this.peakBufferedAmount, this.bufferedAmount);

    // Simulate the bytes actually leaving the wire after some latency,
    // same as a real DataChannel draining its send buffer over the network.
    setTimeout(() => {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - size);
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.dispatch("bufferedamountlow");
    }, this.drainDelayMs);

    queueMicrotask(() => this.peer?.onmessage?.({ data }));
  }

  addEventListener(type: string, cb: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  removeEventListener(type: string, cb: Listener) {
    this.listeners.get(type)?.delete(cb);
  }

  private dispatch(type: string) {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
  }
}

/** Just enough of RTCPeerConnection for sender.ts (createDataChannel) and receiver.ts (ondatachannel). */
export class MockPeerConnection {
  ondatachannel: ((event: { channel: MockDataChannel }) => void) | null = null;
  connectionState: RTCPeerConnectionState = "connected";
  onconnectionstatechange: Listener | null = null;
  /** Exposed purely so tests can inspect the channel (e.g. peakBufferedAmount). */
  _lastChannel: MockDataChannel | null = null;

  createDataChannel(_label: string, _opts?: unknown): MockDataChannel {
    return new MockDataChannel();
  }

  /** Mimics the far side receiving a channel the other peer created, like real WebRTC does. */
  deliverChannel(channel: MockDataChannel) {
    this.ondatachannel?.({ channel });
  }

  close() {
    this.connectionState = "closed";
  }
}

/** Builds a connected sender-pc/receiver-pc pair sharing one linked channel, mirroring real negotiation order. */
export function createLinkedPeerPair() {
  const senderPc = new MockPeerConnection();
  const receiverPc = new MockPeerConnection();

  const originalCreate = senderPc.createDataChannel.bind(senderPc);
  senderPc.createDataChannel = (label: string, opts?: unknown) => {
    const senderChannel = originalCreate(label, opts);
    const receiverChannel = new MockDataChannel();
    senderChannel.linkTo(receiverChannel);
    receiverChannel.linkTo(senderChannel);
    senderPc._lastChannel = senderChannel;
    // Both ends "open" once the (mock) connection is established.
    queueMicrotask(() => {
      senderChannel.open();
      receiverChannel.open();
      receiverPc.deliverChannel(receiverChannel);
    });
    return senderChannel;
  };

  return { senderPc, receiverPc };
}
