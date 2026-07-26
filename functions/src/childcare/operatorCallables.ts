import * as functions from "firebase-functions/v1";
import { requireAnyOperatorScope } from "../admin/requireOperatorScope";
import { childcareOnCall } from "./appCheckPolicy";
import {
  CHILDCARE_OPERATOR_RESOURCE_POLICY,
  isChildcareOperatorResourceType,
  readChildcareOperatorObject,
} from "./operatorAccess";

function permissionDenied(): functions.https.HttpsError {
  return new functions.https.HttpsError(
    "permission-denied",
    "You do not have permission to perform this action.",
  );
}

/**
 * Exact-object operator read. There is intentionally no generic list/query
 * endpoint: sanitized queues have dedicated callables, while child-bearing
 * detail always requires one object, one scoped grant, one structured reason,
 * recent authentication, and a successfully persisted security audit row.
 */
export const getChildcareOperatorObject = childcareOnCall(
  "getChildcareOperatorObject",
  async (data, context) => {
    const resourceType = String(data?.resourceType ?? "").trim();
    const objectRef = String(data?.objectRef ?? "").trim();
    const reasonCode = String(data?.reasonCode ?? "").trim();
    if (
      !isChildcareOperatorResourceType(resourceType) ||
      !/^[a-z0-9_.:-]{1,256}$/i.test(objectRef)
    ) {
      throw permissionDenied();
    }
    const policy = CHILDCARE_OPERATOR_RESOURCE_POLICY[resourceType];
    if (!policy.reasonCodes.includes(reasonCode)) throw permissionDenied();

    const { scope } = await requireAnyOperatorScope(context, policy.scopes, {
      recentAuth: true,
      access: {
        action: `operator_read:${resourceType}`,
        objectRef,
        reason: reasonCode,
      },
    });
    const projection = await readChildcareOperatorObject({
      resourceType,
      objectRef,
    });
    if (!projection) throw permissionDenied();
    return {
      success: true,
      resourceType,
      objectRef,
      scope,
      projection,
    };
  },
);
