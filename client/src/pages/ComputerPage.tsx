import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { getSocket } from "../lib/socket";
import { createPeerConnection } from "../lib/webrtc";
import { runAsAnswerer } from "../lib/signaling";
import { FileReceiver, downloadBlob, type ReceivedFile } from "../lib/receiver";
import { formatBytes, type FileDescriptor } from "../lib/protocol";
import { Button } from "../components/Button";
import { StatusDot } from "../components/StatusDot";
import { FileRow, type FileRowState } from "../components/FileRow";
import { EmptyState } from "../components/EmptyState";

type Phase = "connecting" | "ready" | "linking" | "connected" | "ended" | "error";

interface TransferRow {
  id: string;
  name: string;
  size: number;
  fraction: number;
  state: FileRowState;
  note?: string;
}

function shortCode(sessionId: string) {
  return `LAB-${sessionId.slice(0, 4).toUpperCase()}`;
}

export default function ComputerPage() {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingBatch, setPendingBatch] = useState<FileDescriptor[] | null>(null);
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [banner, setBanner] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const receiverRef = useRef<FileReceiver | null>(null);
  const decisionResolverRef = useRef<((accept: boolean) => void) | null>(null);
  const cleanupSignalRef = useRef<(() => void) | null>(null);

  const upsertRow = useCallback((id: string, patch: Partial<TransferRow>) => {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      if (idx === -1) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }, []);

  const teardownPeer = useCallback(() => {
    cleanupSignalRef.current?.();
    cleanupSignalRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    receiverRef.current = null;
  }, []);

  const startSession = useCallback(() => {
    setPhase("connecting");
    setErrorMessage(null);
    setPendingBatch(null);
    setRows([]);
    setBanner(null);
    teardownPeer();

    const socket = getSocket();
    socket.emit("create-session", {}, (res: { ok: boolean; sessionId?: string; expiresAt?: number; error?: string }) => {
      if (!res.ok || !res.sessionId) {
        setErrorMessage(res.error || "Could not start a session.");
        setPhase("error");
        return;
      }
      setSessionId(res.sessionId);
      setExpiresAt(res.expiresAt ?? null);
      setPhase("ready");
    });
  }, [teardownPeer]);

  // Boot: connect socket + create the first session.
  useEffect(() => {
    const socket = getSocket();

    const onPeerJoined = () => {
      setPhase("linking");
      const pc = createPeerConnection();
      pcRef.current = pc;

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") setPhase("connected");
        if (pc.connectionState === "failed") {
          setErrorMessage("Couldn't establish a direct connection to the phone (this campus network may block WebRTC without a TURN relay).");
          setPhase("error");
        }
      };

      receiverRef.current = new FileReceiver(pc, {
        onBatchOffered: (files) =>
          new Promise<boolean>((resolve) => {
            decisionResolverRef.current = resolve;
            setPendingBatch(files);
          }),
        onFileStart: (id) => upsertRow(id, { state: "active", fraction: 0 }),
        onFileProgress: (id, received, total) =>
          upsertRow(id, { fraction: total > 0 ? received / total : 0 }),
        onFileComplete: ({ descriptor, blob }: ReceivedFile) => {
          upsertRow(descriptor.id, { state: "done", fraction: 1 });
          downloadBlob(descriptor.name, blob);
        },
        onBatchDone: () => setBanner({ tone: "good", text: "Transfer complete. Files were saved to your downloads." }),
        onCancelledByPeer: () => {
          setRows((prev) => prev.map((r) => (r.state === "active" || r.state === "pending" ? { ...r, state: "cancelled" } : r)));
          setBanner({ tone: "bad", text: "The phone cancelled the transfer." });
        },
        onError: (message) => setBanner({ tone: "bad", text: message }),
      });

      cleanupSignalRef.current = runAsAnswerer(pc, socket);
    };

    const onPeerLeft = () => {
      teardownPeer();
      setPendingBatch(null);
      setPhase("ready");
      setBanner({ tone: "bad", text: "The phone disconnected." });
    };

    const onSessionEnded = (payload: { reason?: string }) => {
      teardownPeer();
      setPhase("ended");
      if (payload?.reason === "computer-disconnected") return;
    };

    socket.on("peer-joined", onPeerJoined);
    socket.on("peer-left", onPeerLeft);
    socket.on("session-ended", onSessionEnded);
    socket.on("connect_error", () => {
      setErrorMessage("Can't reach the LabDrop server. Check your connection and try again.");
      setPhase("error");
    });

    startSession();

    return () => {
      socket.off("peer-joined", onPeerJoined);
      socket.off("peer-left", onPeerLeft);
      socket.off("session-ended", onSessionEnded);
      teardownPeer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live countdown.
  useEffect(() => {
    if (!expiresAt) {
      setRemainingMs(null);
      return;
    }
    const tick = () => setRemainingMs(Math.max(0, expiresAt - Date.now()));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  function decide(accept: boolean) {
    if (!pendingBatch) return;
    if (accept) {
      setRows(
        pendingBatch.map((f) => ({ id: f.id, name: f.name, size: f.size, fraction: 0, state: "pending" as const }))
      );
    }
    decisionResolverRef.current?.(accept);
    decisionResolverRef.current = null;
    setPendingBatch(null);
  }

  function endSession() {
    const socket = getSocket();
    socket.emit("end-session", {}, () => {});
    teardownPeer();
    setPhase("ended");
  }

  const pageUrl =
    sessionId && typeof window !== "undefined" ? `${window.location.origin}/upload/${sessionId}` : "";

  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-6 py-10 sm:py-16">
      <header className="mb-10 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="var(--color-signal)" />
            <path d="M9 21.5V10.5h3.2l5.6 7.7v-7.7H21v11h-3.2l-5.6-7.7v7.7H9Z" fill="var(--color-paper-raised)" />
          </svg>
          <span className="text-lg font-semibold tracking-tight">LabDrop</span>
        </div>
        {sessionId && phase !== "ended" && (
          <Button variant="ghost" onClick={endSession}>
            End session
          </Button>
        )}
      </header>

      <main className="grid flex-1 gap-10 lg:grid-cols-[minmax(0,420px)_1fr]">
        {/* QR / broadcast panel */}
        <section className="rounded-2xl border border-(--color-line) bg-(--color-paper-raised) p-8">
          <h1 className="text-2xl font-semibold leading-snug text-(--color-ink)">
            Send files to this computer
          </h1>
          <p className="mt-2 text-sm text-(--color-ink-muted)">
            Scan this code with your phone's camera. No app or account needed.
          </p>

          <div className="mt-7 flex items-center justify-center">
            {phase === "connecting" && (
              <div className="flex h-56 w-56 items-center justify-center text-sm text-(--color-ink-muted)">
                Starting session…
              </div>
            )}

            {(phase === "ready" || phase === "linking" || phase === "connected") && pageUrl && (
              <div className="relative flex h-56 w-56 items-center justify-center">
                {phase === "ready" && (
                  <span className="absolute inset-0 rounded-full bg-(--color-signal) opacity-20 animate-pulse-ring" />
                )}
                <div className="relative rounded-xl border border-(--color-line) bg-white p-4">
                  <QRCodeSVG value={pageUrl} size={192} level="M" includeMargin={false} />
                </div>
              </div>
            )}

            {(phase === "error" || phase === "ended") && (
              <div className="flex h-56 w-56 flex-col items-center justify-center gap-4 text-center">
                <p className="text-sm text-(--color-ink-muted)">
                  {phase === "ended" ? "Session ended." : errorMessage}
                </p>
                <Button onClick={startSession}>Start a new session</Button>
              </div>
            )}
          </div>

          <div className="mt-7 flex flex-col items-center gap-2">
            {phase === "ready" && <StatusDot tone="warn" pulse>Waiting for a phone to scan</StatusDot>}
            {phase === "linking" && <StatusDot tone="signal" pulse>Connecting…</StatusDot>}
            {phase === "connected" && <StatusDot tone="good">Connected</StatusDot>}
            {phase === "ended" && <StatusDot tone="muted">Session ended</StatusDot>}
            {phase === "error" && <StatusDot tone="bad">Connection problem</StatusDot>}

            {sessionId && phase !== "ended" && (
              <p className="font-(family-name:--font-mono) text-xs text-(--color-ink-muted)">
                {shortCode(sessionId)}
                {remainingMs !== null && ` · expires in ${Math.ceil(remainingMs / 60000)} min`}
              </p>
            )}
          </div>
        </section>

        {/* Incoming transfer panel */}
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-(--color-ink-muted)">Incoming transfer</h2>

          {banner && (
            <div
              className={`rounded-lg border px-4 py-3 text-sm ${
                banner.tone === "good"
                  ? "border-(--color-good) bg-(--color-good-soft) text-(--color-good)"
                  : "border-(--color-bad) bg-(--color-bad-soft) text-(--color-bad)"
              }`}
            >
              {banner.text}
            </div>
          )}

          {pendingBatch && (
            <div className="rounded-xl border border-(--color-signal) bg-(--color-signal-soft) p-5">
              <p className="text-sm font-medium text-(--color-ink)">
                Your phone wants to send {pendingBatch.length} file{pendingBatch.length === 1 ? "" : "s"}
              </p>
              <ul className="mt-2 space-y-1 text-sm text-(--color-ink-muted)">
                {pendingBatch.map((f) => (
                  <li key={f.id} className="truncate">
                    {f.name} · {formatBytes(f.size)}
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex gap-2">
                <Button onClick={() => decide(true)}>Accept transfer</Button>
                <Button variant="secondary" onClick={() => decide(false)}>
                  Reject
                </Button>
              </div>
            </div>
          )}

          {!pendingBatch && rows.length === 0 && (
            <EmptyState
              title="Nothing incoming yet"
              description="Once a phone scans the code and sends files, they'll show up here with live progress."
            />
          )}

          <div className="space-y-2">
            {rows.map((row) => (
              <FileRow
                key={row.id}
                name={row.name}
                size={row.size}
                fraction={row.fraction}
                state={row.state}
                note={row.note}
              />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
