// "A card before a booking request" (UI list: families could book with no card, and the charge then failed after the
// care provider had already worked). Used by the site's Send Booking; Evia's booking text makes the same check.
import { getClientPaymentMethodStatus, getCardSetupUrl } from './stripeService';
import { getActingContext } from './api';
import { askConfirm } from '../utils/confirmDialog';
import { reportError } from '../utils/reportError';

/** True when the booking may go ahead. With no card it offers Stripe's "Add a card" form and returns false. */
export async function ensureCardOnFile(returnPath: string = '/client/posts'): Promise<boolean> {
  // A relative acting for the family can't add the family's card (payment links go to the account holder).
  if (getActingContext()) return true;
  let hasCard = true;
  try {
    hasCard = (await getClientPaymentMethodStatus()).hasCard;
  } catch (e) {
    // A failed check must not stop a booking (the visit payment path still reports a missing card).
    reportError(e, { where: 'ensureCardOnFile: status check' });
    return true;
  }
  if (hasCard) return true;
  const ok = await askConfirm({
    title: 'Add a card first',
    message: "A card is needed before a booking request can go to your care provider. It's only charged after a visit, when you approve the hours.",
    confirmLabel: 'Add a card',
    cancelLabel: 'Not now',
  });
  if (!ok) return false;
  try {
    window.location.assign(await getCardSetupUrl(returnPath));
  } catch (e) {
    reportError(e, { where: 'ensureCardOnFile: open card form', toast: "We couldn't open the card form. Please try again." });
  }
  return false;
}
