import {
  httpsCallable,
  type HttpsCallableOptions,
  type HttpsCallableResult,
} from 'firebase/functions';
import {
  childcareFunctions,
  functions as compatFunctions,
} from './firebase';

export type ChildcareAppCheckLevel = 'standard' | 'limited-use';

const standard = 'standard' as const;
const limited = 'limited-use' as const;

/**
 * Browser-side mirror of the server policy. The static policy audit fails when
 * either side adds, removes, or reclassifies a callable without updating both.
 */
export const CHILDCARE_CLIENT_APPCHECK_POLICY = {
  createHousehold: limited,
  inviteHouseholdAdult: limited,
  acceptHouseholdInvite: limited,
  grantGuardianAuthority: limited,
  updateAuthorityScopes: limited,
  revokeGuardianAuthority: limited,
  getMyHouseholdState: standard,
  createChildProfile: limited,
  updateChildProfile: limited,
  appendChildSafetyVersion: limited,
  getChildProfile: standard,
  listMyChildren: standard,
  requestChildDataExport: limited,
  requestChildDataDeletion: limited,
  getLifecycleRequestStatus: standard,
  createChildFileUploadIntent: limited,
  confirmChildFileUpload: limited,
  getChildFileDeliveryReference: limited,
  createChildcareIdentitySession: limited,
  consumeChildcareIdentityCallback: limited,
  upsertChildcareVerticalProfile: limited,
  getMyChildcareProviderState: standard,
  acceptChildcarePolicy: limited,
  startChildcareScreening: limited,
  approveChildcareProvider: limited,
  suspendChildcareProvider: limited,
  createChildcareJobPost: limited,
  updateChildcareJobPost: limited,
  closeChildcareJobPost: limited,
  listMyChildcareJobs: standard,
  listEligibleChildcareJobs: standard,
  applyToChildcareJob: limited,
  requestChildcareInterview: limited,
  requestChildcareBooking: limited,
  acceptChildcareBooking: limited,
  declineChildcareBooking: limited,
  cancelChildcareBooking: limited,
  requestChildcareBookingChange: limited,
  respondChildcareBookingChange: limited,
  substituteChildcareCaregiver: limited,
  checkInChildcareShift: limited,
  checkOutChildcareShift: limited,
  getChildcareBookingSafety: standard,
  acceptChildcareApplication: limited,
  rejectChildcareApplication: limited,
  listMyChildcareBookings: standard,
  getChildcareBooking: standard,
  listChildcareJobApplications: standard,
  listHouseholdMembers: standard,
  setupChildcareBookingPayment: limited,
  requestChildcareRefund: limited,
  submitChildcareReview: limited,
  listChildcareReviewModerationQueue: standard,
  moderateChildcareReview: limited,
  openChildcareConversation: standard,
  sendChildcareMessage: standard,
  listMyChildcareConversations: standard,
  getChildcareConversationMessages: standard,
  markChildcareConversationRead: standard,
  getChildcareBookingCoordination: standard,
  createChildcareIncident: limited,
  listChildcareIncidents: standard,
  getChildcareIncidentDetail: standard,
  updateChildcareIncidentStatus: limited,
  assignChildcareIncident: limited,
  applyChildcareIncidentAction: limited,
  resolveChildcareAuthorityDispute: limited,
  markProviderRedactionComplete: limited,
  getChildcareOperatorObject: limited,
  appCheckReplayProbe: limited,
} as const satisfies Record<string, ChildcareAppCheckLevel>;

export type ChildcareCallableName = keyof typeof CHILDCARE_CLIENT_APPCHECK_POLICY;
export type ChildcareCallableWireName = `v1-${ChildcareCallableName}`;

function logicalName(name: ChildcareCallableName | ChildcareCallableWireName): ChildcareCallableName {
  return (name.startsWith('v1-') ? name.slice(3) : name) as ChildcareCallableName;
}

export function childcareCallable<Input = unknown, Output = unknown>(
  name: ChildcareCallableName | ChildcareCallableWireName,
  options: Omit<HttpsCallableOptions, 'limitedUseAppCheckTokens'> = {},
): (data: Input) => Promise<HttpsCallableResult<Output>> {
  const logical = logicalName(name);
  const level = CHILDCARE_CLIENT_APPCHECK_POLICY[logical];
  if (!level) throw new Error(`Unclassified childcare callable: ${name}`);
  const wireName: ChildcareCallableWireName = `v1-${logical}`;

  if (childcareFunctions) {
    // Captured into a const so the narrowing survives inside the closure below
    // (childcareFunctions is a mutable module binding).
    const functionsHandle = childcareFunctions;
    const callableOptions: HttpsCallableOptions = {
      ...options,
      limitedUseAppCheckTokens: level === 'limited-use',
    };
    const invoke = () =>
      httpsCallable<Input, Output>(functionsHandle, wireName, callableOptions);
    return async (data: Input) => {
      try {
        return await invoke()(data);
      } catch (error) {
        const details =
          error && typeof error === 'object' && 'details' in error
            ? (error as { details?: unknown }).details
            : undefined;
        const replay =
          details &&
          typeof details === 'object' &&
          'code' in details &&
          (details as { code?: unknown }).code === 'app_check_replay';
        if (level !== 'limited-use' || !replay) throw error;
        // The first request was rejected before its handler. Recreate the
        // callable so the SDK mints a fresh limited-use token and retry the
        // exact same payload (including its existing idempotency key) once.
        return invoke()(data);
      }
    };
  }

  // Unit-test compatibility for existing firebase compat mocks. Production
  // always initializes the modular handle above.
  if (compatFunctions) {
    return compatFunctions.httpsCallable(wireName) as unknown as (
      data: Input,
    ) => Promise<HttpsCallableResult<Output>>;
  }

  throw new Error('Firebase Functions is not configured');
}

export async function callChildcare<Input = unknown, Output = unknown>(
  name: ChildcareCallableName | ChildcareCallableWireName,
  data: Input,
): Promise<HttpsCallableResult<Output>> {
  return childcareCallable<Input, Output>(name)(data);
}
