import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import AccountDeletedPage from './AccountDeletedPage';
import { DeleteAccountConsequences } from '../ui/DeleteAccountConsequences';

describe('AccountDeletedPage', () => {
  it('says plainly that the account was deleted and the person is signed out, with a way back', () => {
    render(<MemoryRouter><AccountDeletedPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Your account has been deleted' })).toBeTruthy();
    expect(screen.getByText(/signed out/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the home page' }).getAttribute('href')).toBe('/');
  });
});

describe('DeleteAccountConsequences — what the window now says before confirming', () => {
  it('names the membership, visits and conversations for both roles, and unpaid hours for a care provider', () => {
    const { unmount } = render(<DeleteAccountConsequences role="caregiver" />);
    expect(screen.getByText(/membership is cancelled/i)).toBeTruthy();
    expect(screen.getByText(/upcoming visits are cancelled and each family is told/i)).toBeTruthy();
    expect(screen.getByText(/hours that haven't been paid yet/i)).toBeTruthy();
    expect(screen.getByText(/conversations are closed/i)).toBeTruthy();
    unmount();
    render(<DeleteAccountConsequences role="client" />);
    expect(screen.getByText(/each care provider is told/i)).toBeTruthy();
    expect(screen.getByText(/open job posts are taken down/i)).toBeTruthy();
  });
});
