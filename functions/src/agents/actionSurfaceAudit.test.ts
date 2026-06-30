import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCaraAction } from "./actionNative/defineCaraAction";
import { CaraActionRegistry } from "./actionNative/caraActionRegistry";

describe("Cara action surface audit", () => {
  it("keeps admin-only actions out of client model-visible surfaces", () => {
    const registry = new CaraActionRegistry();
    registry.register(defineCaraAction({
      name: "admin_retry_linq_delivery",
      description: "Retry failed Linq delivery",
      inputSchema: z.object({ ledgerId: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      readOnly: false,
      modelVisible: false,
      webVisible: false,
      adminOnly: true,
      publicAllowed: false,
      run: async () => ({ ok: true }),
    }));
    registry.register(defineCaraAction({
      name: "send_setup_link",
      description: "Send setup link",
      inputSchema: z.object({ clientId: z.string() }),
      outputSchema: z.object({ sent: z.boolean() }),
      readOnly: false,
      modelVisible: true,
      webVisible: true,
      adminOnly: false,
      publicAllowed: false,
      allowedRoles: ["client", "admin"],
      run: async () => ({ sent: true }),
    }));

    expect(registry.visibleFor({ caller: "sms_agent", role: "client" }).map(a => a.name)).toEqual(["send_setup_link"]);
    expect(registry.visibleFor({ caller: "admin", role: "admin" }).map(a => a.name)).toEqual([
      "admin_retry_linq_delivery",
      "send_setup_link",
    ]);
  });

  it("rejects public writes and oversized model-visible catalogs", () => {
    const registry = new CaraActionRegistry();
    registry.register(defineCaraAction({
      name: "public_write",
      description: "Unsafe public write",
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      readOnly: false,
      modelVisible: true,
      webVisible: true,
      adminOnly: false,
      publicAllowed: true,
      run: async () => ({ ok: true }),
    }));

    expect(() => registry.assertHealthy()).toThrow(/public action .* must be readOnly/);
    expect(() => registry.assertHealthy(0)).toThrow(/model-visible action surface too large/);
  });
});
