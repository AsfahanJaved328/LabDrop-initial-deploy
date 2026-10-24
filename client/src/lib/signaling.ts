import type { Socket } from "socket.io-client";

type SignalData =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit };

function sendSignal(socket: Socket, data: SignalData) {
  socket.emit("webrtc-signal", { data });
}

/** Phone side: creates the offer, applies the answer and any remote ICE candidates. */
export function runAsOfferer(pc: RTCPeerConnection, socket: Socket): () => void {
  const pending: RTCIceCandidateInit[] = [];
  let remoteSet = false;

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(socket, { type: "ice-candidate", candidate: e.candidate.toJSON() });
  };

  const onSignal = async ({ data }: { data: SignalData }) => {
    if (data.type === "answer") {
      await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      remoteSet = true;
      for (const candidate of pending.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    } else if (data.type === "ice-candidate") {
      if (remoteSet) await pc.addIceCandidate(data.candidate).catch(() => {});
      else pending.push(data.candidate);
    }
  };
  socket.on("webrtc-signal", onSignal);

  void (async () => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(socket, { type: "offer", sdp: offer.sdp! });
  })();

  return () => socket.off("webrtc-signal", onSignal);
}

/** Computer side: waits for the offer, answers it, applies remote ICE candidates. */
export function runAsAnswerer(pc: RTCPeerConnection, socket: Socket): () => void {
  const pending: RTCIceCandidateInit[] = [];
  let remoteSet = false;

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(socket, { type: "ice-candidate", candidate: e.candidate.toJSON() });
  };

  const onSignal = async ({ data }: { data: SignalData }) => {
    if (data.type === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
      remoteSet = true;
      for (const candidate of pending.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(socket, { type: "answer", sdp: answer.sdp! });
    } else if (data.type === "ice-candidate") {
      if (remoteSet) await pc.addIceCandidate(data.candidate).catch(() => {});
      else pending.push(data.candidate);
    }
  };
  socket.on("webrtc-signal", onSignal);

  return () => socket.off("webrtc-signal", onSignal);
}
