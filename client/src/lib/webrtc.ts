/**
 * Builds the ICE server list for RTCPeerConnection.
 *
 * STUN (free, Google's public servers) lets two browsers discover their
 * public IP/port so they can try a direct connection. That works on most
 * home and phone-hotspot networks. University Wi-Fi and campus firewalls
 * very often block the direct (peer-to-peer) path outright - in that case
 * WebRTC needs a TURN server to relay the encrypted media/data instead.
 * LabDrop ships no TURN server by default (running one costs money/bandwidth);
 * set VITE_TURN_URL / VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL to add one.
 */
export function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];

  const turnUrl = import.meta.env.VITE_TURN_URL;
  const turnUsername = import.meta.env.VITE_TURN_USERNAME;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: turnUsername || undefined,
      credential: turnCredential || undefined,
    });
  }

  return servers;
}

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: getIceServers(),
    iceCandidatePoolSize: 4,
  });
}

export const hasTurnConfigured = Boolean(import.meta.env.VITE_TURN_URL);
