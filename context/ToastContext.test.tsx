import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { ToastProvider, useToastActions, useToasts } from './ToastContext';

describe('ToastProvider — a toast re-renders only what reads the list', () => {
  it('a component that only adds toasts does NOT re-render when one appears; the container does', () => {
    let actionRenders = 0, listRenders = 0;
    let api: ReturnType<typeof useToastActions> | null = null;
    const Actor: React.FC = () => { actionRenders++; api = useToastActions(); return <span>actor</span>; };
    const Container: React.FC = () => { listRenders++; const t = useToasts(); return <ul>{t.map((x) => <li key={x.id}>{x.message}</li>)}</ul>; };
    render(<ToastProvider><Actor /><Container /></ToastProvider>);
    const a0 = actionRenders, l0 = listRenders;

    act(() => { api!.addToast('Saved', 'success'); });
    act(() => { api!.addToast('Failed', 'error'); });

    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(actionRenders).toBe(a0);        // the ~40 screens that only call addToast are untouched
    expect(listRenders).toBeGreaterThan(l0); // only the container updates
  });

  it('the actions are the same functions on every render (stable)', () => {
    const seen: unknown[] = [];
    const Probe: React.FC = () => { seen.push(useToastActions().addToast); return null; };
    const { rerender } = render(<ToastProvider><Probe /></ToastProvider>);
    rerender(<ToastProvider><Probe /></ToastProvider>);
    expect(new Set(seen).size).toBe(1);
  });

  it('removeToast removes just that toast', () => {
    let api: ReturnType<typeof useToastActions> | null = null;
    let list: ReturnType<typeof useToasts> = [];
    const Both: React.FC = () => { api = useToastActions(); list = useToasts(); return <ul>{list.map((x) => <li key={x.id}>{x.message}</li>)}</ul>; };
    render(<ToastProvider><Both /></ToastProvider>);
    act(() => { api!.addToast('One', 'info'); api!.addToast('Two', 'info'); });
    expect(list.map((t) => t.message)).toEqual(['One', 'Two']);
    act(() => { api!.removeToast(list[0].id); });
    expect(list.map((t) => t.message)).toEqual(['Two']);
    expect(screen.queryByText('One')).toBeNull();
  });
});
