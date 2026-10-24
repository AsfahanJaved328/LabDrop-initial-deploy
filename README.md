# LabDrop

Scan a QR code on a shared lab computer, send files straight from your phone.
No account, no app install, no messaging service in the middle.

```
┌─────────────────┐        scan QR         ┌──────────────────┐
│  Lab computer    │ ─────────────────────▶ │   Student phone   │
│  (receiver UI)   │                        │   (sender UI)      │
└────────┬─────────┘                        └─────────┬─────────┘
         │     tiny signaling messages only            │
         └──────────────▶  Node/Express   ◀─────────────┘
                         + Socket.IO server
                      (creates/expires sessions,
                       relays WebRTC handshake)

         Once connected, file bytes flow computer ⇄ phone
         directly over a WebRTC DataChannel. The server
         never sees file contents.
```

## How it works

1. A student opens LabDrop on the lab computer. The browser asks the server
   for a new session; the server hands back a random, unguessable session id.
2. The computer shows a QR code encoding `https://your-app/upload/<sessionId>`.
3. The student scans it with their phone's camera, which opens that URL in
   their phone's browser - a normal webpage, no app required.
4. The phone tells the server it wants to join that session. The server
   checks the id is valid, not expired, and not already paired, then
   introduces the two browsers to each other.
5. The two browsers negotiate a direct **WebRTC DataChannel** (using the
   server only to exchange connection setup messages - SDP offer/answer and
   ICE candidates). Once that's up, the phone sends the computer a short
   description of the files it wants to send (names, sizes, types).
6. The computer shows an **accept/reject prompt**. Nothing transfers until
   the person at the computer approves it.
7. On accept, the phone streams the files to the computer in 64 KB chunks,
   directly over the DataChannel, with backpressure so a large file can't
   blow up either browser's memory. The computer shows live per-file progress
   and saves each finished file as a normal browser download.
8. Either side can cancel. The computer can end the session at any time,
   which immediately invalidates the QR code and disconnects the phone.
   Idle sessions also expire on their own (15 minutes by default).

## Project layout

```
labdrop/
├─ server/        Node + Express + Socket.IO signaling server (plain JS, ESM)
│  ├─ src/index.js           HTTP + Socket.IO server, security headers, rate limits
│  ├─ src/sessionManager.js  In-memory session store (create/expire/pair)
│  ├─ src/socketRateLimit.js Small per-IP rate limiter for socket events
│  └─ smoke-test.mjs         Signaling handshake smoke test (see Testing below)
└─ client/        React + Vite + TypeScript + Tailwind frontend
   └─ src/
      ├─ pages/ComputerPage.tsx   Receiver UI (QR code, incoming-transfer panel)
      ├─ pages/MobilePage.tsx    Sender UI (file picker, progress, cancel)
      ├─ lib/sender.ts / receiver.ts   Chunked DataChannel file-transfer protocol
      ├─ lib/signaling.ts        WebRTC offer/answer/ICE exchange over the socket
      ├─ lib/webrtc.ts           STUN/TURN configuration
      └─ lib/protocol.ts         Shared wire-format types, chunk size, size limits
```

The signaling server is plain JavaScript rather than TypeScript - for a
relay this small, skipping the build step keeps it simpler to read, run, and
deploy for a solo maintainer. Everything that benefits most from types (the
file-transfer state machine, the UI) is TypeScript.

## Running it locally

Requires Node 18+.

```bash
npm run install:all   # installs server/ and client/ dependencies
npm run dev            # runs both with live-reload, on :4000 (server) and :5173 (client)
```

Open `http://localhost:5173` on the computer. To test from a phone on the
same Wi-Fi, the terminal output from `npm run dev` will also show a
`http://<your-LAN-ip>:5173` address - use that instead of `localhost` when
scanning, since `localhost` on your laptop doesn't mean anything to your
phone. (Camera-based QR scanning on a real phone is the realistic way to
test this end-to-end; see **Testing** below for what has and hasn't been
verified in this environment.)

Copy `server/.env.example` to `server/.env` and `client/.env.example` to
`client/.env` if you want to override any defaults (session lifetime, max
file size, a TURN server - see below). Neither is required to run locally.

## Building for production

```bash
npm run build                      # builds client/dist
NODE_ENV=production npm start      # serves client/dist + runs the signaling server, both on one port
```

In production the Express server serves the built frontend itself, so
there's only one process and one port to deploy.

## Deploying (e.g. Railway)

LabDrop needs a host that supports **long-lived WebSocket connections**,
since Socket.IO signaling stays open for the life of a session. Railway
supports this; most purely-static hosts (e.g. GitHub Pages, a plain S3
bucket) do not, because there's no server process to hold the socket open.

1. Push this repo to GitHub and create a new Railway project from it.
2. Set these environment variables on the service:
   - `NODE_ENV=production`
   - `CLIENT_ORIGIN=https://<your-railway-domain>` (must match exactly - the
     server uses this both for CORS and for the Socket.IO handshake)
   - optionally `SESSION_TTL_MINUTES`, and the `VITE_*` variables from
     `client/.env.example` if you want a different file-size limit or a TURN
     server (Vite bakes `VITE_*` vars in at **build** time, so set them as
     build-time env vars, not just runtime ones)
3. Build command: `npm run install:all && npm run build`
4. Start command: `npm start`
5. Railway terminates HTTPS for you at the domain it gives you, which also
   gives you `wss://` for Socket.IO automatically - no extra config needed.
   Confirm `/health` returns `{"status":"ok", ...}` once deployed.

**Costs to know about:** Railway's free tier has limited monthly hours and
sleeps idle services; a signaling server that needs to stay reachable for
QR scans may need a paid tier for consistent uptime. This repo does not
include a TURN server - running one (e.g. via coturn or a hosted provider
like Twilio/Cloudflare/Metered) is a separate, paid piece of infrastructure
you'd add only if testing shows your network needs it (see next section).

## STUN, TURN, and university networks

WebRTC first tries to connect the two browsers **directly**, using STUN
(a free, lightweight Google service by default) just to discover each
side's public address. This works on most home networks and phone
hotspots.

**Locked-down networks - which includes a lot of university Wi-Fi - often
block that direct path.** When that happens, WebRTC needs a **TURN**
server to relay the (still end-to-end encrypted) connection instead. LabDrop
does not ship a TURN server, because running one costs ongoing bandwidth and
money that shouldn't be assumed for a student project. If you test on your
campus network and transfers fail to connect, that's very likely why - set
`VITE_TURN_URL` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` (see
`client/.env.example`) to point at a TURN server and rebuild.

This project does not and cannot guarantee that every transfer will be
direct, or that a free hosting tier plus STUN-only will work from every
network - that depends on firewalls outside this app's control.

## Security notes

- Session ids are 128 bits of `crypto.randomBytes` - not sequential, not
  guessable, and never logged.
- Sessions expire automatically (15 min idle by default) and are deleted
  the moment the computer ends them or disconnects.
- Only one phone can be paired to a session at a time; a second join
  attempt is rejected.
- The server only ever relays small JSON signaling messages (SDP/ICE) - file
  bytes travel directly between the two browsers over WebRTC and never touch
  the server or any disk.
- The receiving computer must explicitly **accept** a transfer before any
  file bytes are sent.
- Filenames are sanitized before being shown or used as a download name, to
  avoid path-traversal-style tricks from a malicious or buggy sender.
- Maximum file size is enforced on both ends (`VITE_MAX_FILE_SIZE_MB`); an
  oversized file is rejected with a clear message rather than silently
  truncated.
- Signaling endpoints are rate-limited per IP (session creation, join
  attempts, and the signal relay itself) to blunt spam/enumeration attempts.
- HTTP responses get standard security headers via `helmet`; CORS and the
  Socket.IO handshake are both locked to `CLIENT_ORIGIN`.
- No file content is ever logged, cached, or written to disk by the server.

This has **not** been audited by a security professional or penetration
tested - treat it as a solid-effort student project, not a guarantee of
bulletproof security. Don't use it for anything you wouldn't be comfortable
with classmates on the same network potentially probing.

## A known memory tradeoff (please read)

To keep the implementation approachable for a solo developer, the receiving
browser currently buffers each file's chunks in memory and assembles them
into a `Blob` once the file finishes, rather than streaming straight to
disk. In practice this is fine up to a few hundred MB on a modern laptop,
which is why the default limit is 500 MB - but it is not truly unbounded the
way writing to disk incrementally (via the File System Access API, Chrome
and Edge only) would be. If you need to raise the limit much higher, that
streaming-to-disk approach is the right next step and isn't implemented
here yet.

## A bug worth knowing about (and why it's fixed)

`crypto.randomUUID()` is spec'd as secure-context-only - it throws on a
plain `http://` origin. That includes the LAN-IP address
(`http://192.168.x.x:5173`) this README tells you to scan from a phone for
local testing, which would have broken file picking the first time anyone
actually followed that instruction. File/transfer ids are generated with a
small fallback (`genId()` in `lib/protocol.ts`) instead, with no behavior
change in production (which is HTTPS). Mentioned here rather than buried in
a commit message, since it's exactly the kind of thing that only shows up
once you try the "scan it with your actual phone" step this app is built
around.

## Testing

Run everything with `npm run test` from the repo root (needs the signaling
server running first - see below). What's covered by an automated check in
this repo, and genuinely passed in this environment:

- **`npm run test:smoke`** exercises the **signaling** path against a live
  server: creating a session, a phone joining it, relaying a fake WebRTC
  offer/answer in both directions, rejecting a join to a bogus/nonexistent
  session id, and ending a session (which notifies and disconnects the
  phone).
- **`npm run test:protocol`** runs the real `sender.ts`/`receiver.ts`/
  `protocol.ts` code against each other through a mock DataChannel pair
  (`client/tests/mocks.ts`) with a simulated network delay - no browser
  involved, but real bytes and real asynchrony. It proves, with actual
  SHA-256 checksums rather than assumptions: a multi-file, multi-megabyte
  batch reassembles **byte-for-byte identical** on the other end; sending
  genuinely **exceeds and recovers from the 8 MB backpressure watermark**
  under load (checked numerically, not just "it didn't crash"); rejecting a
  batch sends zero file bytes; cancelling mid-transfer stops the receiver
  with a demonstrably **partial** file, not a complete one; and an
  oversized file announcement is refused before any bytes move. This caught
  and fixed a real timing bug in an earlier draft of this very test (a file
  that finished sending before the test could call cancel on it) - a
  reminder that "the test passed" only means something once you've also
  seen it genuinely fail.
- The client type-checks (`tsc -b`), lints clean (`oxlint`, 0 warnings), and
  builds (`vite build`) with no errors.
- The production server was started and verified to serve the built app,
  including the `/upload/:sessionId` client-side route and static assets,
  and to answer `/health`.

To run the smoke test, start the server first in one terminal
(`npm run dev --prefix server` or `npm start`), then in another:
`npm run test:smoke`. `npm run test:protocol` needs no server running - it's
fully self-contained.

**What this environment genuinely could not verify** (no browser, camera,
or second physical device available to it), and that you should test
yourself before relying on this for real transfers:

- An actual WebRTC **connection negotiation** (ICE/SDP) between two real
  browsers. The protocol test above proves the *data* layer is correct once
  connected; it does not and cannot prove two real browsers will
  successfully connect on your network. That said, WebRTC's data-channel
  connection APIs (`RTCPeerConnection`, `RTCDataChannel`) are not
  secure-context-restricted the way `getUserMedia` is, and this app never
  calls `getUserMedia` (QR scanning uses the phone's native camera app, not
  a web API) - so testing over a plain `http://` LAN address, as the Running
  it locally section above describes, should work for this reason, but
  hasn't been confirmed against a real device here.
- Real QR code scanning with a phone camera.
- Behavior on an actual restrictive university network (whether STUN alone
  is enough, or whether you'll need TURN).
- Real-world memory behavior transferring a file near the configured size
  limit on an actual phone/laptop.
- Cross-browser quirks (Safari in particular is pickier about WebRTC and
  autoplay/download behavior than Chrome). I tried to get a real headless
  browser into this sandbox to close this gap (`apt-get install
  chromium-browser`) - it turned out to be a snap-only transitional package
  that needs `snapd`, which isn't available in this container, so that
  avenue was a dead end here. If you have Playwright set up locally, it
  would be the natural next step to close this gap for real.

**Recommended first real test, in order:** run `npm run dev`, open the
computer page on a laptop, scan the QR with your phone **on the same
Wi-Fi**, send a small file, confirm it downloads correctly and the contents
match. Then try a larger file, then try rejecting a transfer, then try
ending the session mid-transfer, before trusting it on a different network
or in production.

## Limitations / honest scope notes

- One sender per session at a time, by design (a lab computer is being used
  by one student at a time too).
- A batch of files is accepted or rejected as a whole, not file-by-file.
- No TURN server is bundled (see above) - this is the single most likely
  reason a transfer won't connect on a restrictive network.
- No persistent history: once a session ends, there's nothing left to look
  at. That's intentional for a shared-computer tool, not an oversight.
