export function LoadingSkeleton({ className = "h-24 w-full" }: { className?: string }) {
  return <div className={`animate-pulse rounded-sm bg-ink-700/60 ${className}`} aria-hidden />;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-sm border border-red-500/30 bg-red-500/5 p-6 text-center">
      <p className="text-sm text-red-300">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-3 text-sm font-semibold text-moon-300 hover:text-moon-200">
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-sm border border-dashed border-ink-600 p-12 text-center">
      <h3 className="font-display text-xl text-paper">{title}</h3>
      <p className="mx-auto mt-2 max-w-sm text-sm text-paper/60">{body}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
