// A safety net that gives EVERY pop-up on the site the basics of an accessible dialog, without rewriting
// each of the ~40 hand-built windows (fix plan Wave 5):
//   • role="dialog" + aria-modal on the window, so a screen reader announces it as a pop-up
//   • the page behind it stops scrolling while one is open
//   • Escape closes it (by pressing its own close button, else by clicking its backdrop)
//   • icon-only buttons (close, previous/next, edit…) get a spoken name from their icon
// New code should still label its own buttons; utils/dialogA11y.test.ts documents the net.
const OVERLAY = '.fixed.inset-0';
const ICON_LABELS: Record<string, string> = {
  x: 'Close',
  'x-circle': 'Close',
  'chevron-left': 'Previous',
  'chevron-right': 'Next',
  'arrow-left': 'Back',
  'arrow-right': 'Next',
  pencil: 'Edit',
  'pencil-line': 'Edit',
  edit: 'Edit',
  'edit-2': 'Edit',
  'edit-3': 'Edit',
  'trash-2': 'Delete',
  trash: 'Delete',
  menu: 'Menu',
  search: 'Search',
  bell: 'Notifications',
  heart: 'Favorite',
  plus: 'Add',
  send: 'Send',
  paperclip: 'Attach a file',
  'more-horizontal': 'More options',
  'more-vertical': 'More options',
  'ellipsis': 'More options',
  'ellipsis-vertical': 'More options',
  'chevron-down': 'Expand',
  'chevron-up': 'Collapse',
  settings: 'Settings',
  'log-out': 'Sign out',
  phone: 'Call',
  eye: 'Show',
  'eye-off': 'Hide',
};

function isModalOverlay(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const cls = el.className?.toString?.() ?? '';
  if (cls.includes('pointer-events-none')) return false;
  if (el.hasAttribute('data-no-dialog')) return false;
  // A dim backdrop with a panel inside it (a loader or the app shell is not a pop-up).
  const dims = /bg-(black|slate-900|ink-900|gray-900)\/|backdrop-blur|bg-black\b/.test(cls);
  return dims && el.children.length > 0;
}

export function labelIconButtons(root: ParentNode): void {
  root.querySelectorAll('button:not([aria-label]):not([aria-labelledby]):not([title])').forEach((btn) => {
    if ((btn.textContent ?? '').trim().length > 0) return;
    const svg = btn.querySelector('svg');
    if (!svg) return;
    const cls = (svg.getAttribute('class') ?? '').split(/\s+/);
    for (const c of cls) {
      const m = c.match(/^lucide-(.+)$/);
      if (m && ICON_LABELS[m[1]]) { btn.setAttribute('aria-label', ICON_LABELS[m[1]]); return; }
    }
  });
}

export function openOverlays(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll(OVERLAY)).filter(isModalOverlay);
}

function annotate(overlay: HTMLElement): void {
  const panel = (overlay.firstElementChild as HTMLElement | null) ?? overlay;
  if (!panel.hasAttribute('role')) panel.setAttribute('role', 'dialog');
  if (!panel.hasAttribute('aria-modal')) panel.setAttribute('aria-modal', 'true');
  if (!panel.hasAttribute('aria-label') && !panel.hasAttribute('aria-labelledby')) {
    const heading = panel.querySelector('h1,h2,h3');
    if (heading?.textContent) panel.setAttribute('aria-label', heading.textContent.trim().slice(0, 80));
  }
}

/** Closes the top-most pop-up: its own close button if it has one, else its backdrop. Returns whether it did. */
export function closeTopOverlay(root: ParentNode = document): boolean {
  const overlays = openOverlays(root);
  const top = overlays[overlays.length - 1];
  if (!top) return false;
  const close = top.querySelector<HTMLElement>('button[aria-label="Close"], button[aria-label="Cancel"], button[aria-label="Close dialog"]');
  (close ?? top).click();
  return true;
}

export function installDialogA11y(doc: Document = document): () => void {
  let lockedPrev: string | null = null;
  const sync = () => {
    const overlays = openOverlays(doc);
    overlays.forEach(annotate);
    labelIconButtons(doc);
    const body = doc.body;
    if (overlays.length > 0 && lockedPrev === null) {
      lockedPrev = body.style.overflow;
      body.style.overflow = 'hidden';
    } else if (overlays.length === 0 && lockedPrev !== null) {
      body.style.overflow = lockedPrev;
      lockedPrev = null;
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) closeTopOverlay(doc);
  };
  const obs = new MutationObserver(sync);
  obs.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener('keydown', onKey);
  sync();
  return () => {
    obs.disconnect();
    doc.removeEventListener('keydown', onKey);
    if (lockedPrev !== null) { doc.body.style.overflow = lockedPrev; lockedPrev = null; }
  };
}
