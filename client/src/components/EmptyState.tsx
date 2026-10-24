export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-dashed border-(--color-line-strong) px-4 py-8 text-center">
      <p className="text-sm font-medium text-(--color-ink)">{title}</p>
      <p className="mt-1 text-sm text-(--color-ink-muted)">{description}</p>
    </div>
  );
}
