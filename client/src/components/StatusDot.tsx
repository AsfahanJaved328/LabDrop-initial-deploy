type Tone = "warn" | "signal" | "good" | "bad" | "muted";

const toneDot: Record<Tone, string> = {
  warn: "bg-(--color-warn)",
  signal: "bg-(--color-signal)",
  good: "bg-(--color-good)",
  bad: "bg-(--color-bad)",
  muted: "bg-(--color-ink-muted)",
};

export function StatusDot({
  tone,
  pulse = false,
  children,
}: {
  tone: Tone;
  pulse?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-(--color-ink-muted)">
      <span className="relative flex h-2 w-2">
        {pulse && (
          <span className={`absolute inline-flex h-full w-full rounded-full ${toneDot[tone]} opacity-60 animate-pulse-ring`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${toneDot[tone]}`} />
      </span>
      {children}
    </span>
  );
}
