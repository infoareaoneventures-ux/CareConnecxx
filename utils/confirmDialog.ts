// One branded "are you sure?" box for the whole site, replacing the browser's grey window.confirm.
//   if (!(await askConfirm('Cancel this interview?'))) return;
//   if (!(await askConfirm({ message: 'Delete…', confirmLabel: 'Delete', destructive: true }))) return;
// <ConfirmDialogHost /> (mounted once in App) shows it; with no host mounted (tests, SSR) it resolves false.
export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button (cancel / delete / remove). */
  destructive?: boolean;
}

export interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

type Listener = (p: PendingConfirm) => void;
let listener: Listener | null = null;

export function registerConfirmHost(fn: Listener | null): void {
  listener = fn;
}

/** A button label that fits the question: "Cancel this…" → "Yes, cancel", "Delete…" → "Delete", else "Yes". */
export function defaultConfirmLabel(message: string): { label: string; destructive: boolean } {
  const m = message.trim().toLowerCase();
  if (/^(cancel|decline|skip|block|delete|remove|deactivate)\b/.test(m)) {
    const verb = m.match(/^(cancel|decline|skip|block|delete|remove|deactivate)/)![1];
    return { label: verb === 'delete' || verb === 'remove' || verb === 'deactivate' || verb === 'block' ? verb[0].toUpperCase() + verb.slice(1) : `Yes, ${verb}`, destructive: true };
  }
  return { label: 'Yes', destructive: false };
}

export function askConfirm(input: string | ConfirmOptions): Promise<boolean> {
  const opts: ConfirmOptions = typeof input === 'string' ? { message: input } : input;
  const fallback = defaultConfirmLabel(opts.message);
  return new Promise<boolean>((resolve) => {
    if (!listener) { resolve(false); return; }
    listener({
      ...opts,
      confirmLabel: opts.confirmLabel ?? fallback.label,
      cancelLabel: opts.cancelLabel ?? 'Not now',
      destructive: opts.destructive ?? fallback.destructive,
      resolve,
    });
  });
}
