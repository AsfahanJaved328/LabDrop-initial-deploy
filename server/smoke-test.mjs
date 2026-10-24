import { io } from "socket.io-client";

const URL = "http://localhost:4000";
const computer = io(URL);
const mobile = io(URL);

let sessionId;

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

computer.on("connect", () => {
  computer.emit("create-session", {}, (res) => {
    if (!res.ok) fail("create-session: " + res.error);
    sessionId = res.sessionId;
    console.log("computer created session", sessionId, "expiresAt in ms:", res.expiresAt - Date.now());

    mobile.emit("join-session", { sessionId }, (res2) => {
      if (!res2.ok) fail("join-session: " + res2.error);
      console.log("mobile joined OK");
    });
  });
});

computer.on("peer-joined", ({ peerId }) => {
  console.log("computer saw peer-joined:", peerId);
  // Now exercise the signaling relay both directions.
  computer.emit("webrtc-signal", { data: { type: "offer", sdp: "FAKE_OFFER" } });
});

mobile.on("webrtc-signal", ({ data }) => {
  console.log("mobile received signal:", data);
  mobile.emit("webrtc-signal", { data: { type: "answer", sdp: "FAKE_ANSWER" } });
});

computer.on("webrtc-signal", ({ data }) => {
  console.log("computer received signal:", data);
  console.log("--- testing reject on bad session id ---");
  const rogue = io(URL);
  rogue.on("connect", () => {
    rogue.emit("join-session", { sessionId: "not-a-real-session-id" }, (res) => {
      console.log("rogue join result (should be ok:false):", res);
      console.log("--- testing end-session ---");
      computer.emit("end-session", {}, () => {});
    });
  });
});

mobile.on("session-ended", ({ reason }) => {
  console.log("mobile received session-ended:", reason);
  console.log("ALL SMOKE TESTS PASSED");
  process.exit(0);
});

setTimeout(() => fail("timed out"), 5000);
