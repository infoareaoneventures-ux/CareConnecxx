// LangSmith tracing must never ship conversations to a vendor by accident (2026-11-09, fix plan Wave 2).
//
// The AI clients and the inbound webhook are wrapped for LangSmith. When tracing is on, EVERY prompt and reply —
// care needs, notes, addresses, names — is sent to LangSmith, which is not on the list of providers approved to
// receive health information. Whether it is on in production could not be confirmed from the code, so the code
// decides: tracing is switched OFF unless someone deliberately sets LANGSMITH_ALLOW_PHI_TRACING=true (for a
// masked/approved setup or a local eval). Importing this module applies the policy; it is idempotent.
const TRACING_FLAGS = ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING"] as const;

let warned = false;

/** Turns tracing off when it is requested without the explicit acknowledgment. Returns true when it switched something off. */
export function enforceTracingPolicy(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LANGSMITH_ALLOW_PHI_TRACING === "true") return false;
  let switchedOff = false;
  for (const flag of TRACING_FLAGS) {
    if ((env[flag] ?? "").toLowerCase() === "true") {
      env[flag] = "false";
      switchedOff = true;
    }
  }
  if (switchedOff && !warned) {
    warned = true;
    console.warn("[tracingGuard] LangSmith tracing was requested but is OFF: conversations contain health information. Set LANGSMITH_ALLOW_PHI_TRACING=true only for an approved, masked setup.");
  }
  return switchedOff;
}

enforceTracingPolicy();
