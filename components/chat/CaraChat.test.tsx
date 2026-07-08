import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';

// U4 Evia chat tab (docs/plans/2026-07-02-001-feat-cara-web-chat-phone-login-plan.md):
// unified-thread rendering, optimistic send + reconcile, designed states.

const hoisted = vi.hoisted(() => ({
  messagesCallback: null as null | ((msgs: any[]) => void),
  sendCaraMessage: vi.fn(async (..._args: any[]): Promise<any> => ({ status: 'ok', available: true })),
  clearCaraThreadUnread: vi.fn(async () => {}),
  navigate: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  dbService: {
    caraThreadId: () => 'cara_uid-1',
    subscribeToMessages: vi.fn((_threadId: string, cb: (msgs: any[]) => void) => {
      hoisted.messagesCallback = cb;
      cb([]);
      return () => {};
    }),
    subscribeToCaraThread: vi.fn(() => () => {}),
    clearCaraThreadUnread: hoisted.clearCaraThreadUnread,
    sendCaraMessage: hoisted.sendCaraMessage,
  },
  authService: {
    getCurrentUser: () => ({ uid: 'uid-1' }),
  },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => hoisted.navigate,
}));

vi.mock('../../context/CareConnexContext', () => ({
  useCareConnex: () => ({ currentUser: { uid: 'uid-1', userType: 'client' } }),
}));

vi.mock('../client/ClientNavigation', () => ({ ClientNavigation: () => null }));
vi.mock('../caregiver/CaregiverTopNav', () => ({ CaregiverTopNav: () => null }));

import { CaraChat } from './CaraChat';

const pushMessages = (msgs: any[]) => act(() => { hoisted.messagesCallback?.(msgs); });

const sendFromComposer = async (text: string) => {
  fireEvent.change(screen.getByLabelText('Message Evia'), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Send message'));
  });
};

describe('CaraChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.messagesCallback = null;
    hoisted.sendCaraMessage.mockResolvedValue({ status: 'ok', available: true });
  });

  it('renders mixed SMS and web turns in order with correct bubble sides', () => {
    render(<CaraChat userType="client" />);
    pushMessages([
      { id: 'm1', text: 'hi cara', senderId: 'uid-1', timestamp: '9:00 AM', source: 'cara_sms' },
      { id: 'm2', text: 'hey! how can I help?', senderId: 'cara', timestamp: '9:01 AM', source: 'cara_sms' },
      { id: 'm3', text: 'book maria for friday', senderId: 'uid-1', timestamp: '9:02 AM', source: 'cara_web' },
    ]);

    const log = screen.getByRole('log');
    const bubbles = Array.from(log.querySelectorAll('.max-w-\\[80\\%\\]'));
    expect(bubbles.map((b) => b.textContent)).toEqual([
      expect.stringContaining('hi cara'),
      expect.stringContaining('hey! how can I help?'),
      expect.stringContaining('book maria for friday'),
    ]);
    // Evia bubble sits left (justify-start), user bubbles right (justify-end)
    expect(bubbles[1].parentElement?.className).toContain('justify-start');
    expect(bubbles[0].parentElement?.className).toContain('justify-end');
  });

  it('send shows an optimistic bubble and reconciles without duplicating when the mirrored doc arrives', async () => {
    render(<CaraChat userType="client" />);
    await sendFromComposer('book maria');

    expect(screen.getAllByText('book maria')).toHaveLength(1); // optimistic bubble

    const clientMessageId = hoisted.sendCaraMessage.mock.calls[0][1];
    pushMessages([
      { id: 'm1', text: 'book maria', senderId: 'uid-1', timestamp: '9:00 AM', clientMessageId },
    ]);

    expect(screen.getAllByText('book maria')).toHaveLength(1); // reconciled, not duplicated
  });

  it('rateLimited removes the optimistic bubble, shows a notice, and restores the draft', async () => {
    hoisted.sendCaraMessage.mockResolvedValue({ status: 'rateLimited', available: true, rateLimited: true });
    render(<CaraChat userType="client" />);
    await sendFromComposer('spam');

    // No bubble in the conversation log — the text went back to the composer
    expect(screen.getByRole('log').textContent).not.toContain('spam');
    expect((screen.getByLabelText('Message Evia') as HTMLTextAreaElement).value).toBe('spam');
    expect(screen.getByText(/wait a moment/i)).toBeTruthy();
  });

  it('notSetUp switches to the get-started state with CTA and no composer', async () => {
    hoisted.sendCaraMessage.mockResolvedValue({ status: 'notSetUp', available: false });
    render(<CaraChat userType="client" />);
    await sendFromComposer('hello');

    expect(screen.getByText('Meet Evia')).toBeTruthy();
    expect(screen.queryByLabelText('Message Evia')).toBeNull();
    fireEvent.click(screen.getByText('Get set up with Evia'));
    expect(hoisted.navigate).toHaveBeenCalledWith('/start');
  });

  it('agent failure marks the bubble failed; retry reuses the same clientMessageId', async () => {
    hoisted.sendCaraMessage.mockRejectedValueOnce(new Error('internal'));
    render(<CaraChat userType="client" />);
    await sendFromComposer('hi cara');

    const retry = screen.getByText(/tap to retry/i);
    expect(retry).toBeTruthy();
    const firstId = hoisted.sendCaraMessage.mock.calls[0][1];

    hoisted.sendCaraMessage.mockResolvedValueOnce({ status: 'ok', available: true });
    await act(async () => { fireEvent.click(retry); });

    expect(hoisted.sendCaraMessage.mock.calls[1][1]).toBe(firstId);
    expect(screen.getAllByText('hi cara')).toHaveLength(1);
  });

  it('a message arriving via the listener (an SMS turn) renders without reload', () => {
    render(<CaraChat userType="client" />);
    pushMessages([{ id: 'm1', text: 'sent from my phone', senderId: 'uid-1', timestamp: '9:00 AM' }]);
    expect(screen.getByText('sent from my phone')).toBeTruthy();
  });

  it('clears the unread counter on mount', () => {
    render(<CaraChat userType="client" />);
    expect(hoisted.clearCaraThreadUnread).toHaveBeenCalled();
  });

  it('empty-but-loaded thread shows the welcome state with suggestion chips', () => {
    render(<CaraChat userType="client" />);
    pushMessages([]);
    expect(screen.getByText(/Say hi/)).toBeTruthy();
    fireEvent.click(screen.getByText('Find me a caregiver for weekday mornings'));
    expect((screen.getByLabelText('Message Evia') as HTMLTextAreaElement).value)
      .toBe('Find me a caregiver for weekday mornings');
  });
});
