export function ProgressBar({ fraction, tone = "signal" }: { fraction: number; tone?: "signal" | "good" | "bad" }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  const color =
    tone === "good" ? "bg-(--color-good)" : tone === "bad" ? "bg-(--color-bad)" : "bg-(--color-signal)";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/5">
      <div
        className={`h-full rounded-full ${color} transition-[width] duration-200 ease-out`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
