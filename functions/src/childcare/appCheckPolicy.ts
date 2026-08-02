import * as functions from "firebase-functions/v1";
import { getChildcareAppCheckConfig } from "../config/featureFlags";
import { requireAppCheck } from "./requireAppCheck";

export type ChildcareAppCheckLevel = "standard" | "limited-use";
export type ChildcareCallableCategory =
  | "read"
  | "low-risk"
  | "authority"
  | "child-record"
  | "file"
  | "booking"
  | "financial"
  | "operator"
  | "probe";

export interface ChildcareCallablePolicy {
  appCheck: ChildcareAppCheckLevel;
  category: ChildcareCallableCategory;
  exported: boolean;
}

const standard = (category: ChildcareCallableCategory = "read"): ChildcareCallablePolicy => ({
  appCheck: "standard",
  category,
  exported: true,
});
const limited = (category: ChildcareCallableCategory): ChildcareCallablePolicy => ({
  appCheck: "limited-use",
  category,
  exported: true,
});
const nonDeployedLimited = (
  category: ChildcareCallableCategory,
): ChildcareCallablePolicy => ({
  appCheck: "limited-use",
  category,
  exported: false,
});

export const CHILDCARE_APPCHECK_POLICY = {
  createHousehold: limited("authority"),
  inviteHouseholdAdult: limited("authority"),
  acceptHouseholdInvite: limited("authority"),
  grantGuardianAuthority: limited("authority"),
  updateAuthorityScopes: limited("authority"),
  revokeGuardianAuthority: limited("authority"),
  getMyHouseholdState: standard(),

  createChildProfile: limited("child-record"),
  updateChildProfile: limited("child-record"),
  appendChildSafetyVersion: limited("child-record"),
  getChildProfile: standard(),
  listMyChildren: standard(),
  requestChildDataExport: limited("child-record"),
  requestChildDataDeletion: limited("child-record"),
  getLifecycleRequestStatus: standard(),

  createChildFileUploadIntent: limited("file"),
  confirmChildFileUpload: limited("file"),
  getChildFileDeliveryReference: limited("file"),

  createChildcareIdentitySession: limited("child-record"),
  consumeChildcareIdentityCallback: limited("child-record"),

  upsertChildcareVerticalProfile: limited("child-record"),
  getMyChildcareProviderState: standard(),
  acceptChildcarePolicy: limited("child-record"),
  startChildcareScreening: limited("child-record"),
  approveChildcareProvider: limited("operator"),
  suspendChildcareProvider: limited("operator"),

  createChildcareJobPost: limited("child-record"),
  updateChildcareJobPost: limited("child-record"),
  closeChildcareJobPost: limited("child-record"),
  listMyChildcareJobs: standard(),
  listEligibleChildcareJobs: standard(),
  applyToChildcareJob: limited("child-record"),
  requestChildcareInterview: limited("child-record"),

  requestChildcareBooking: limited("booking"),
  acceptChildcareBooking: limited("booking"),
  declineChildcareBooking: limited("booking"),
  cancelChildcareBooking: limited("booking"),
  requestChildcareBookingChange: limited("booking"),
  respondChildcareBookingChange: limited("booking"),
  substituteChildcareCaregiver: limited("booking"),
  checkInChildcareShift: limited("booking"),
  checkOutChildcareShift: limited("booking"),
  getChildcareBookingSafety: standard(),
  acceptChildcareApplication: limited("booking"),
  rejectChildcareApplication: limited("booking"),

  listMyChildcareBookings: standard(),
  getChildcareBooking: standard(),
  listChildcareJobApplications: standard(),
  listHouseholdMembers: standard(),

  setupChildcareBookingPayment: limited("financial"),
  requestChildcareRefund: limited("financial"),
  submitChildcareReview: limited("child-record"),
  listChildcareReviewModerationQueue: standard("operator"),
  moderateChildcareReview: limited("operator"),

  openChildcareConversation: standard("low-risk"),
  sendChildcareMessage: standard("low-risk"),
  listMyChildcareConversations: standard(),
  getChildcareConversationMessages: standard(),
  markChildcareConversationRead: standard("low-risk"),
  getChildcareBookingCoordination: standard(),

  createChildcareIncident: limited("child-record"),
  listChildcareIncidents: standard("operator"),
  getChildcareIncidentDetail: standard("operator"),
  updateChildcareIncidentStatus: limited("operator"),
  assignChildcareIncident: limited("operator"),
  applyChildcareIncidentAction: limited("operator"),
  resolveChildcareAuthorityDispute: limited("operator"),
  markProviderRedactionComplete: limited("operator"),
  getChildcareOperatorObject: limited("operator"),
  flagChildcareReview: nonDeployedLimited("operator"),
  removeChildcareReview: nonDeployedLimited("operator"),

  appCheckReplayProbe: limited("probe"),
} as const satisfies Record<string, ChildcareCallablePolicy>;

export type ChildcareCallableName = keyof typeof CHILDCARE_APPCHECK_POLICY;

export function childcareCallablePolicy(
  name: string,
): ChildcareCallablePolicy {
  const policy = (CHILDCARE_APPCHECK_POLICY as Record<string, ChildcareCallablePolicy>)[name];
  if (!policy) throw new Error(`Unclassified childcare callable: ${name}`);
  return policy;
}

type CallableHandler = (
  data: any,
  context: functions.https.CallableContext,
) => any | Promise<any>;

/**
 * The only server wrapper for deployed childcare callables. It binds policy,
 * runtime enforcement, and limited-use token consumption at the function
 * definition boundary.
 */
export function childcareOnCall(
  name: ChildcareCallableName,
  handler: CallableHandler,
) {
  const policy = childcareCallablePolicy(name);
  const builder = policy.appCheck === "limited-use"
    ? functions.runWith({ consumeAppCheckToken: true })
    : functions;

  return builder.https.onCall(async (data, context) => {
    const config = await getChildcareAppCheckConfig();
    requireAppCheck(context, name, {
      mode: config.mode,
      rejectConsumed: policy.appCheck === "limited-use",
    });
    return handler(data, context);
  });
}

export function deployedChildcareCallableNames(): ChildcareCallableName[] {
  return Object.entries(CHILDCARE_APPCHECK_POLICY)
    .filter(([, policy]) => policy.exported)
    .map(([name]) => name as ChildcareCallableName)
    .sort();
}
