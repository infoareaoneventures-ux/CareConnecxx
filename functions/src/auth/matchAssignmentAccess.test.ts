import { describe, expect, it } from "vitest";
import { canAccessMatchAssignment } from "./matchAssignmentAccess";

describe("canAccessMatchAssignment", () => {
  it("allows the owning client", () => {
    expect(canAccessMatchAssignment("client-1", "client-1", {})).toBe(true);
  });

  it("allows both supported admin markers", () => {
    expect(canAccessMatchAssignment("admin-1", "client-1", { userType: "admin" })).toBe(true);
    expect(canAccessMatchAssignment("admin-2", "client-1", { isAdmin: true })).toBe(true);
  });

  it("denies a different non-admin user", () => {
    expect(canAccessMatchAssignment("client-2", "client-1", { userType: "client" })).toBe(false);
  });
});
