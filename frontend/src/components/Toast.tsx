import { AlertCircle, CheckCircle2, X } from "lucide-react";

export interface ToastMessage {
  id: number;
  kind: "success" | "error" | "info";
  title: string;
  detail?: string;
}

interface ToastProps {
  toast: ToastMessage | null;
  onDismiss: () => void;
}

export function Toast({ toast, onDismiss }: ToastProps) {
  if (!toast) return null;

  const iconColor =
    toast.kind === "success"
      ? "text-ok"
      : toast.kind === "error"
        ? "text-danger"
        : "text-accent";

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-xl border border-border-strong bg-surface-elevated px-4 py-3 shadow-2xl"
    >
      {toast.kind === "error" ? (
        <AlertCircle className={`mt-0.5 h-4 w-4 shrink-0 ${iconColor}`} />
      ) : (
        <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${iconColor}`} />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-ink-primary">{toast.title}</p>
        {toast.detail && (
          <p className="mt-0.5 text-xs text-ink-secondary">{toast.detail}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded p-0.5 text-ink-muted hover:text-ink-primary cursor-pointer"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
