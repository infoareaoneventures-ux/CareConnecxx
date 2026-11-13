import { describe, it, expect, vi } from 'vitest';
vi.mock('../lib/firebase', () => ({ db: null }));
import { computeCarePlanProgress } from './useOnboardingProgress';

describe('computeCarePlanProgress — reads what the setup questions saved', () => {
  const saved = { careRecipientFirstName: 'Rosy', city: 'Gilroy', careNeeds: ['Companionship'], emergencyContactName: 'Jo' };
  it('care needs saved on the job posting count at once (no wait for the Care Plan page to copy them)', () => {
    const r = computeCarePlanProgress(saved, null);
    expect(r.percent).toBe(80);               // everything but "Review your care plan"
    expect(r.hint).toBe('Review your care plan');
  });
  it('without care needs anywhere it still asks for them', () => {
    const r = computeCarePlanProgress({ ...saved, careNeeds: [] }, null);
    expect(r.hint).toBe('Select the types of care needed');
  });
  it('the Care Plan record still counts, and a reviewed plan is complete', () => {
    const r = computeCarePlanProgress({ careRecipientFirstName: 'Rosy', city: 'Gilroy' }, { recipientPlans: { a: { careNeeds: ['Meals'] } }, emergencyContacts: [{ name: 'Jo' }], carePlanReviewedAt: 1 });
    expect(r).toEqual({ percent: 100, hint: 'Care plan complete' });
  });
});
