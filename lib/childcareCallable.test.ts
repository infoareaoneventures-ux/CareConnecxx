import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  httpsCallable: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('firebase/functions', () => ({
  httpsCallable: hoisted.httpsCallable,
}));

vi.mock('./firebase', () => ({
  childcareFunctions: { project: 'test' },
  functions: undefined,
}));

import { childcareCallable } from './childcareCallable';

beforeEach(() => {
  hoisted.httpsCallable.mockReset();
  hoisted.invoke.mockReset();
  hoisted.httpsCallable.mockReturnValue(hoisted.invoke);
  hoisted.invoke.mockResolvedValue({ data: { success: true } });
});

describe('childcareCallable', () => {
  it('requests limited-use tokens only for guarded mutations', async () => {
    await childcareCallable('createChildProfile')({ child: 'payload' });
    expect(hoisted.httpsCallable).toHaveBeenCalledWith(
      expect.anything(),
      'v1-createChildProfile',
      expect.objectContaining({ limitedUseAppCheckTokens: true }),
    );

    hoisted.httpsCallable.mockClear();
    await childcareCallable('getChildProfile')({ childId: 'child-1' });
    expect(hoisted.httpsCallable).toHaveBeenCalledWith(
      expect.anything(),
      'v1-getChildProfile',
      expect.objectContaining({ limitedUseAppCheckTokens: false }),
    );
  });

  it('recreates a guarded callable once on explicit replay denial with the same payload', async () => {
    const payload = { childId: 'child-1', idempotencyKey: 'idem-1' };
    hoisted.invoke
      .mockRejectedValueOnce({ details: { code: 'app_check_replay' } })
      .mockResolvedValueOnce({ data: { success: true } });

    await expect(childcareCallable('updateChildProfile')(payload)).resolves.toEqual({
      data: { success: true },
    });
    expect(hoisted.httpsCallable).toHaveBeenCalledTimes(2);
    expect(hoisted.invoke).toHaveBeenNthCalledWith(1, payload);
    expect(hoisted.invoke).toHaveBeenNthCalledWith(2, payload);
  });

  it('does not retry business or transport failures', async () => {
    hoisted.invoke.mockRejectedValueOnce({ code: 'functions/permission-denied' });
    await expect(childcareCallable('updateChildProfile')({})).rejects.toMatchObject({
      code: 'functions/permission-denied',
    });
    expect(hoisted.httpsCallable).toHaveBeenCalledTimes(1);
  });
});
