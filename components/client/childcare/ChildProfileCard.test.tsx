// ChildProfileCard (plan 2026-07-22-002, U11) — secure child card.
//
// Pins: operational summary ONLY (label + age band + categories + safety
// indicator), no DOB/address/health in the DOM, long-name resilience, and
// accessible action labeling.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ChildProfileCard } from './ChildProfileCard';

const base = {
  childId: 'c1',
  displayLabel: 'Mia',
  ageBand: 'preschool',
  careCategories: ['babysitting', 'after_school_care'],
  safetyCurrentVersion: 0,
};

describe('ChildProfileCard', () => {
  it('renders label, age band, and categories', () => {
    render(<ChildProfileCard child={base} />);
    expect(screen.getByText('Mia')).toBeTruthy();
    expect(screen.getByText(/3–4 yrs/)).toBeTruthy();
    expect(screen.getByText(/Babysitting, After School Care/)).toBeTruthy();
  });

  it('shows the safety-needed indicator with remediation copy when no safety version exists', () => {
    render(<ChildProfileCard child={base} />);
    expect(screen.getByText(/Safety details needed/)).toBeTruthy();
    expect(screen.getByText(/add them so a confirmed caregiver/i)).toBeTruthy();
  });

  it('shows safety-on-file when a version exists', () => {
    render(<ChildProfileCard child={{ ...base, safetyCurrentVersion: 3 }} />);
    expect(screen.getByText('Safety details on file')).toBeTruthy();
  });

  it('exposes an accessible per-child action button that fires onManage', () => {
    const onManage = vi.fn();
    render(<ChildProfileCard child={base} onManage={onManage} />);
    const btn = screen.getByRole('button', { name: /Add safety details for Mia/ });
    fireEvent.click(btn);
    expect(onManage).toHaveBeenCalledWith('c1');
  });

  it('survives very long names without leaking layout (truncate class + title attr)', () => {
    const longName = 'Maximiliana-Alexandrina Wolfeschlegelsteinhausenbergerdorff The Third Of Sunnyvale';
    render(<ChildProfileCard child={{ ...base, displayLabel: longName }} />);
    const el = screen.getByText(longName);
    expect(el.className).toContain('truncate');
    expect(el.getAttribute('title')).toBe(longName);
  });

  it('never renders restricted fields even if extra data is smuggled onto the prop (R10)', () => {
    const smuggled = {
      ...base,
      // Fields outside the ChildSummary contract must not appear in the DOM.
      dateOfBirth: '2021-03-04',
      exactAddress: '123 Secret Lane',
      allergiesNote: 'peanuts',
    } as any;
    const { container } = render(<ChildProfileCard child={smuggled} />);
    expect(container.innerHTML).not.toContain('2021-03-04');
    expect(container.innerHTML).not.toContain('123 Secret Lane');
    expect(container.innerHTML).not.toContain('peanuts');
  });
});
