// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installDialogA11y, labelIconButtons } from './dialogA11y';

let off: (() => void) | null = null;
afterEach(() => { off?.(); off = null; document.body.innerHTML = ''; document.body.style.overflow = ''; });

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('dialog accessibility net', () => {
  it('marks a pop-up as a dialog, locks page scroll, and releases it when closed', async () => {
    off = installDialogA11y(document);
    document.body.innerHTML = '<div class="fixed inset-0 bg-black/40"><div><h2>Cancel interview</h2><button>OK</button></div></div>';
    await tick();
    const panel = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-label')).toBe('Cancel interview');
    expect(document.body.style.overflow).toBe('hidden');
    document.body.innerHTML = '';
    await tick();
    expect(document.body.style.overflow).toBe('');
  });

  it('Escape presses the close button of the top pop-up', async () => {
    off = installDialogA11y(document);
    document.body.innerHTML = '<div class="fixed inset-0 bg-black/40"><div><button aria-label="Close">x</button></div></div>';
    await tick();
    const onClose = vi.fn();
    document.querySelector('button')!.addEventListener('click', onClose);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape clicks the backdrop when the pop-up has no close button', async () => {
    off = installDialogA11y(document);
    document.body.innerHTML = '<div id="b" class="fixed inset-0 bg-black/50"><div>hello</div></div>';
    await tick();
    const onBackdrop = vi.fn();
    document.getElementById('b')!.addEventListener('click', onBackdrop);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onBackdrop).toHaveBeenCalled();
  });

  it('does not treat a loader or a non-dimmed fixed layer as a pop-up', async () => {
    off = installDialogA11y(document);
    document.body.innerHTML = '<div class="fixed inset-0 bg-white"><div>Loading</div></div>';
    await tick();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('names icon-only buttons from their icon and leaves labelled ones alone', () => {
    document.body.innerHTML = '<button id="a"><svg class="lucide lucide-x"></svg></button><button id="b" aria-label="Dismiss"><svg class="lucide lucide-x"></svg></button><button id="c">Save<svg class="lucide lucide-x"></svg></button><button id="d"><svg class="lucide lucide-pencil"></svg></button>';
    labelIconButtons(document);
    expect(document.getElementById('a')!.getAttribute('aria-label')).toBe('Close');
    expect(document.getElementById('b')!.getAttribute('aria-label')).toBe('Dismiss');
    expect(document.getElementById('c')!.hasAttribute('aria-label')).toBe(false);
    expect(document.getElementById('d')!.getAttribute('aria-label')).toBe('Edit');
  });
});
