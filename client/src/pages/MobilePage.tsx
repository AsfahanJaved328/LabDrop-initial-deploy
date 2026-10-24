import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { getSocket } from "../lib/socket";
import { createPeerConnection } from "../lib/webrtc";
import { runAsOfferer } from "../lib/signaling";
import { FileSender, type QueuedFile } from "../lib/sender";
import { MAX_FILE_SIZE_BYTES, formatBytes, genId } from "../lib/protocol";
import { Button } from "../components/Button";
import { StatusDot } from "../components/StatusDot";
import { FileRow, type FileRowState } from "../components/FileRow";

type Phase =
  | "joining"
  | "invalid"
  | "picking"
  | "connecting"
  | "awaiting-approval"
  | "sending"
  | "done"
  | "rejected"
  | "cancelled"
  | "error";

interface Picked {
  id: string;
  file: File;
  state: FileRowState;
  fraction: number;
}

export default function MobilePage() {
  const { sessionId = "" } = useParams();
  const [phase, setPhase] = useState<Phase>("joining");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const senderRef = useRef<FileSender | null>(null);
  const cleanupSignalRef = useRef<(() => void) | null>(null);

  const teardownPeer = useCallback(() => {
    cleanupSignalRef.current?.();
    cleanupSignalRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    senderRef.current = null;
  }, []);

  useEffect(() => {
    const socket = getSocket();

    socket.emit("join-session", { sessionId }, (res: { ok: boolean; error?: string }) => {
      if (!res.ok) {
        setJoinError(res.error || "Couldn't join this session.");
        setPhase("invalid");
        return;
      }
      setPhase("picking");
    });

    const onSessionEnded = () => {
      teardownPeer();
      setMessage("The computer ended this session.");
      setPhase("invalid");
    };
    socket.on("session-ended", onSessionEnded);

    return () => {
      socket.off("session-ended", onSessionEnded);
      teardownPeer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  function onFilesChosen(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const incoming = Array.from(fileList);
    const tooBig = incoming.filter((f) => f.size > MAX_FILE_SIZE_BYTES);
    if (tooBig.length > 0) {
      setMessage(
        `${tooBig.length === 1 ? tooBig[0].name : `${tooBig.length} files`} over the ${Math.round(
          MAX_FILE_SIZE_BYTES / (1024 * 1024)
        )} MB limit for this session ${tooBig.length === 1 ? "was" : "were"} skipped.`
      );
    }
    const ok = incoming.filter((f) => f.size <= MAX_FILE_SIZE_BYTES);
    setPicked((prev) => [
      ...prev,
      ...ok.map((file) => ({ id: genId(), file, state: "pending" as FileRowState, fraction: 0 })),
    ]);
  }

  function removePicked(id: string) {
    setPicked((prev) => prev.filter((p) => p.id !== id));
  }

  function upsertPicked(id: string, patch: Partial<Picked>) {
    setPicked((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function send() {
    if (picked.length === 0) return;
    setMessage(null);
    setPhase("connecting");

    const socket = getSocket();
    const pc = createPeerConnection();
    pcRef.current = pc;

    const queue: QueuedFile[] = picked.map(({ id, file }) => ({ id, file }));

    const sender = new FileSender(pc, queue, {
      onChannelOpen: () => setPhase("awaiting-approval"),
      onDecision: (accepted) => {
        if (accepted) {
          setPhase("sending");
        } else {
          setPhase("rejected");
          teardownPeer();
        }
      },
      onFileProgress: (id, sentBytes) => {
        const total = queue.find((q) => q.id === id)?.file.size || 1;
        upsertPicked(id, { state: "active", fraction: sentBytes / total });
      },
      onFileComplete: (id) => upsertPicked(id, { state: "done", fraction: 1 }),
      onAllComplete: () => {
        setPhase("done");
        teardownPeer();
      },
      onCancelledByPeer: () => {
        setPhase("cancelled");
        setMessage("The computer cancelled the transfer.");
        teardownPeer();
      },
      onError: (msg) => {
        setPhase("error");
        setMessage(msg);
        teardownPeer();
      },
    });
    senderRef.current = sender;

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        setPhase("error");
        setMessage("Couldn't connect to the computer. Make sure you're on the same network and try again.");
        teardownPeer();
      }
    };

    cleanupSignalRef.current = runAsOfferer(pc, socket);
  }

  function cancel() {
    senderRef.current?.cancel();
    teardownPeer();
    setPhase("cancelled");
  }

  function resetToPicking() {
    setPicked([]);
    setMessage(null);
    setPhase("picking");
  }

  const totalSize = picked.reduce((sum, p) => sum + p.file.size, 0);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-5 py-8">
      <header className="mb-8 flex items-center gap-2.5">
        <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="var(--color-signal)" />
          <path d="M9 21.5V10.5h3.2l5.6 7.7v-7.7H21v11h-3.2l-5.6-7.7v7.7H9Z" fill="var(--color-paper-raised)" />
        </svg>
        <span className="text-base font-semibold tracking-tight">LabDrop</span>
      </header>

      {phase === "joining" && (
        <p className="text-sm text-(--color-ink-muted)">Connecting to the computer…</p>
      )}

      {phase === "invalid" && (
        <div className="rounded-xl border border-(--color-bad) bg-(--color-bad-soft) p-5 text-sm text-(--color-bad)">
          {message || joinError}
        </div>
      )}

      {phase !== "joining" && phase !== "invalid" && (
        <>
          <div className="mb-5 flex items-center justify-between">
            <h1 className="text-xl font-semibold text-(--color-ink)">Send to computer</h1>
            {phase === "picking" && <StatusDot tone="good">Connected</StatusDot>}
            {(phase === "connecting" || phase === "awaiting-approval") && (
              <StatusDot tone="signal" pulse>
                {phase === "connecting" ? "Connecting…" : "Waiting for approval"}
              </StatusDot>
            )}
            {phase === "sending" && <StatusDot tone="signal">Sending</StatusDot>}
            {phase === "done" && <StatusDot tone="good">Done</StatusDot>}
            {(phase === "rejected" || phase === "cancelled" || phase === "error") && (
              <StatusDot tone="bad">Stopped</StatusDot>
            )}
          </div>

          {message && (
            <div className="mb-4 rounded-lg border border-(--color-line) bg-(--color-paper-raised) px-4 py-3 text-sm text-(--color-ink-muted)">
              {message}
            </div>
          )}

          {phase === "awaiting-approval" && (
            <p className="mb-4 text-sm text-(--color-ink-muted)">
              Ask whoever is at the computer to approve the incoming transfer.
            </p>
          )}

          {phase === "rejected" && (
            <div className="mb-4 rounded-lg border border-(--color-bad) bg-(--color-bad-soft) px-4 py-3 text-sm text-(--color-bad)">
              The computer rejected this transfer.
            </div>
          )}

          {picked.length === 0 && phase === "picking" && (
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-(--color-line-strong) px-4 py-10 text-center transition-colors hover:border-(--color-signal)">
              <span className="text-sm font-medium text-(--color-ink)">Choose files</span>
              <span className="text-xs text-(--color-ink-muted)">Photos, documents, anything from your phone</span>
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => onFilesChosen(e.target.files)}
              />
            </label>
          )}

          {picked.length > 0 && (
            <div className="space-y-2">
              {picked.map((p) => (
                <FileRow
                  key={p.id}
                  name={p.file.name}
                  size={p.file.size}
                  fraction={p.fraction}
                  state={p.state}
                  action={
                    phase === "picking" ? { label: "Remove", onClick: () => removePicked(p.id) } : undefined
                  }
                />
              ))}
            </div>
          )}

          <div className="mt-6 flex flex-col gap-2">
            {phase === "picking" && picked.length > 0 && (
              <>
                <label className="text-center text-xs text-(--color-ink-muted)">
                  {picked.length} file{picked.length === 1 ? "" : "s"} · {formatBytes(totalSize)}
                </label>
                <Button onClick={send}>Send to computer</Button>
                <label className="cursor-pointer text-center text-sm text-(--color-ink-muted) underline-offset-2 hover:underline">
                  Add more files
                  <input type="file" multiple className="hidden" onChange={(e) => onFilesChosen(e.target.files)} />
                </label>
              </>
            )}

            {(phase === "connecting" || phase === "awaiting-approval" || phase === "sending") && (
              <Button variant="secondary" onClick={cancel}>
                Cancel
              </Button>
            )}

            {(phase === "done" || phase === "rejected" || phase === "cancelled" || phase === "error") && (
              <Button onClick={resetToPicking}>Send more files</Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
