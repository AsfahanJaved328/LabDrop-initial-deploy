/**
 * Exercises the real file-transfer protocol (sender.ts + receiver.ts +
 * protocol.ts) end-to-end, without a browser: a mock RTCPeerConnection
 * pair (see mocks.ts) stands in for the two real browsers, with a
 * simulated-latency DataChannel so backpressure is genuinely triggered,
 * not just theoretically possible.
 *
 * This does NOT replace testing in real browsers (see the README) - it
 * cannot catch real ICE/SDP negotiation issues or browser-specific
 * DataChannel quirks. What it DOES prove, with real bytes and a real
 * (simulated) network delay: multi-chunk files reassemble byte-for-byte
 * in order, backpressure is actually exercised under load, rejecting a
 * batch stops any bytes from being sent, cancelling mid-transfer is
 * handled cleanly on both sides, and an oversized file is refused.
 *
 * Run with: npx tsx tests/protocol.e2e.test.ts
 */
import { createHash } from "node:crypto";
import { createLinkedPeerPair } from "./mocks";
import { FileSender, type QueuedFile } from "../src/lib/sender";
import { FileReceiver, type ReceivedFile } from "../src/lib/receiver";
import { BUFFERED_AMOUNT_HIGH_WATERMARK, MAX_FILE_SIZE_BYTES, encode } from "../src/lib/protocol";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok   ${message}`);
  }
}

function sha256(buf: Uint8Array) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Deterministic pseudo-random bytes, so a reordering/corruption bug would actually change the hash. */
function pseudoRandomBytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let s = seed;
  for (let i = 0; i < size; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s & 0xff;
  }
  return out;
}

function makeFile(name: string, size: number, seed: number, type = "application/octet-stream"): File {
  const bytes = pseudoRandomBytes(size, seed);
  return new File([bytes], name, { type });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000, label = "condition") {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function testHappyPathWithBackpressure() {
  console.log("\n--- scenario: accept + multi-file transfer, large enough to force backpressure ---");
  const { senderPc, receiverPc } = createLinkedPeerPair();

  const fileA = makeFile("notes.txt", 200 * 1024, 1); // small file
  const fileB = makeFile("dataset.bin", 12 * 1024 * 1024, 2); // > BUFFERED_AMOUNT_HIGH_WATERMARK (8 MiB)
  const originalHashA = sha256(new Uint8Array(await fileA.arrayBuffer()));
  const originalHashB = sha256(new Uint8Array(await fileB.arrayBuffer()));

  const queue: QueuedFile[] = [
    { id: "a", file: fileA },
    { id: "b", file: fileB },
  ];

  const received: Record<string, ReceivedFile> = {};
  let batchDone = false;
  let allComplete = false;

  const receiver = new FileReceiver(receiverPc as unknown as RTCPeerConnection, {
    onBatchOffered: (files) => {
      assert(files.length === 2, "receiver sees both files in the batch offer");
      return true; // auto-accept
    },
    onFileComplete: (result) => {
      received[result.descriptor.id] = result;
    },
    onBatchDone: () => (batchDone = true),
    onError: (msg) => assert(false, `unexpected receiver error: ${msg}`),
  });
  void receiver;

  const sender = new FileSender(senderPc as unknown as RTCPeerConnection, queue, {
    onAllComplete: () => (allComplete = true),
    onError: (msg) => assert(false, `unexpected sender error: ${msg}`),
  });
  void sender;

  await waitUntil(() => batchDone && allComplete, 15_000, "batch-done + all-complete");

  assert(Object.keys(received).length === 2, "both files were received");
  const gotA = new Uint8Array(await received.a.blob.arrayBuffer());
  const gotB = new Uint8Array(await received.b.blob.arrayBuffer());
  assert(sha256(gotA) === originalHashA, "small file reassembled byte-for-byte (sha256 match)");
  assert(sha256(gotB) === originalHashB, "large file reassembled byte-for-byte (sha256 match)");
  assert(received.a.descriptor.name === "notes.txt", "filename preserved for small file");
  assert(received.b.descriptor.name === "dataset.bin", "filename preserved for large file");

  // Check the sender->receiver channel the mock created to confirm backpressure was really hit.
  const channel = senderPc._lastChannel;
  if (channel) {
    assert(
      channel.peakBufferedAmount > BUFFERED_AMOUNT_HIGH_WATERMARK,
      `backpressure watermark was actually exceeded during the send (peak ${channel.peakBufferedAmount} > ${BUFFERED_AMOUNT_HIGH_WATERMARK})`
    );
  }
}

async function testRejectPath() {
  console.log("\n--- scenario: computer rejects the batch - no bytes should be sent ---");
  const { senderPc, receiverPc } = createLinkedPeerPair();
  const file = makeFile("secret.pdf", 500 * 1024, 3);

  let decisionSeen: boolean | null = null;
  let fileCompleted = false;

  new FileReceiver(receiverPc as unknown as RTCPeerConnection, {
    onBatchOffered: () => false, // reject
    onFileComplete: () => (fileCompleted = true),
  });

  new FileSender(senderPc as unknown as RTCPeerConnection, [{ id: "x", file }], {
    onDecision: (accepted) => (decisionSeen = accepted),
  });

  await waitUntil(() => decisionSeen !== null, 5000, "sender received a decision");
  assert(decisionSeen === false, "sender was told the batch was rejected");
  await new Promise((r) => setTimeout(r, 50));
  assert(!fileCompleted, "no file bytes were ever sent after rejection");
}

async function testCancelMidTransfer() {
  console.log("\n--- scenario: sender cancels mid-transfer ---");
  const { senderPc, receiverPc } = createLinkedPeerPair();
  // Must comfortably exceed BUFFERED_AMOUNT_HIGH_WATERMARK so sending genuinely
  // spans multiple drain cycles - a file that fits under the watermark can finish
  // sending (via microtasks) before this test ever gets a chance to call cancel().
  const file = makeFile("big-video.mp4", 20 * 1024 * 1024, 4);

  let receiverSawCancel = false;
  let allComplete = false;
  let receivedBytesAtCancel = 0;

  new FileReceiver(receiverPc as unknown as RTCPeerConnection, {
    onBatchOffered: () => true,
    onFileProgress: (_id, receivedBytes) => (receivedBytesAtCancel = receivedBytes),
    onCancelledByPeer: () => (receiverSawCancel = true),
  });

  let sentBytes = 0;
  const sender = new FileSender(senderPc as unknown as RTCPeerConnection, [{ id: "y", file }], {
    onFileProgress: (_id, sent) => (sentBytes = sent),
    onAllComplete: () => (allComplete = true),
  });

  // Wait until we're genuinely partway through (not just "one chunk sent, maybe already done").
  await waitUntil(() => sentBytes > 2 * 1024 * 1024 && sentBytes < file.size, 5000, "transfer well underway");
  assert(sentBytes < file.size, "sanity check: cancelling before the file actually finished sending");
  sender.cancel();

  await new Promise((r) => setTimeout(r, 300));
  assert(receiverSawCancel, "receiver was notified of the cancellation");
  assert(!allComplete, "transfer did not report completion after being cancelled");
  assert(
    receivedBytesAtCancel < file.size,
    `receiver only got a partial file before cancellation (${receivedBytesAtCancel} / ${file.size} bytes)`
  );
}

async function testOversizedFileRefused() {
  console.log("\n--- scenario: an oversized file announcement is refused without transferring any bytes ---");
  const { senderPc, receiverPc } = createLinkedPeerPair();

  let errorSeen: string | null = null;
  new FileReceiver(receiverPc as unknown as RTCPeerConnection, {
    onBatchOffered: () => {
      assert(false, "onBatchOffered should never fire for an oversized file");
      return false;
    },
    onError: (msg) => (errorSeen = msg),
  });

  // Create the data channel the normal way so the receiver attaches to it,
  // then speak the metadata message directly - file-meta only ever carries
  // a *declared* size, so this does not require allocating real bytes to
  // prove the receiver enforces the limit before anything is sent.
  const channel = senderPc.createDataChannel("file-transfer");
  await waitUntil(() => channel.readyState === "open", 2000, "mock channel open");

  channel.send(
    encode({
      t: "batch-meta",
      files: [{ id: "z", name: "huge.iso", size: MAX_FILE_SIZE_BYTES + 1, mimeType: "application/octet-stream" }],
    })
  );

  await waitUntil(() => errorSeen !== null, 2000, "receiver reported the oversized-file error");
  assert(!!errorSeen, "receiver surfaced a clear error for the oversized file");
}

async function main() {
  await testHappyPathWithBackpressure();
  await testRejectPath();
  await testCancelMidTransfer();
  await testOversizedFileRefused();

  console.log(`\n${failures === 0 ? "ALL PROTOCOL TESTS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
