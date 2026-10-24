import { formatBytes } from "../lib/protocol";
import { ProgressBar } from "./ProgressBar";

export type FileRowState = "pending" | "active" | "done" | "error" | "cancelled";

const stateLabel: Record<FileRowState, string> = {
  pending: "Waiting",
  active: "Transferring",
  done: "Complete",
  error: "Failed",
  cancelled: "Cancelled",
};

export function FileRow({
  name,
  size,
  fraction,
  state,
  note,
  action,
}: {
  name: string;
  size: number;
  fraction: number;
  state: FileRowState;
  note?: string;
  action?: { label: string; onClick: () => void };
}) {
  const tone = state === "error" ? "bad" : state === "done" ? "good" : "signal";
  return (
    <div className="rounded-lg border border-(--color-line) bg-(--color-paper-raised) px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-(--color-ink)">{name}</p>
          <p className="mt-0.5 text-xs text-(--color-ink-muted)">
            {formatBytes(size)} · {note ?? stateLabel[state]}
          </p>
        </div>
        {action && (
          <button
            onClick={action.onClick}
            className="shrink-0 text-xs font-medium text-(--color-ink-muted) hover:text-(--color-bad)"
          >
            {action.label}
          </button>
        )}
      </div>
      {(state === "active" || state === "pending") && (
        <div className="mt-2">
          <ProgressBar fraction={fraction} tone={tone} />
        </div>
      )}
    </div>
  );
}
