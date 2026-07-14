export function canAccessMatchAssignment(
  callerUid: string,
  clientId: unknown,
  callerRecord: Record<string, unknown> | undefined,
): boolean {
  return clientId === callerUid ||
    callerRecord?.userType === "admin" ||
    callerRecord?.isAdmin === true;
}
