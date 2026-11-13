import { describe, it, expect } from "vitest";
import { enforceTracingPolicy } from "../tracingGuard";

describe("enforceTracingPolicy — LangSmith never traces health conversations by accident", () => {
  it("switches every tracing flag off when tracing is requested without the acknowledgment", () => {
    const env = { LANGSMITH_TRACING: "true", LANGCHAIN_TRACING_V2: "TRUE", LANGSMITH_TRACING_V2: "false" } as NodeJS.ProcessEnv;
    expect(enforceTracingPolicy(env)).toBe(true);
    expect(env.LANGSMITH_TRACING).toBe("false");
    expect(env.LANGCHAIN_TRACING_V2).toBe("false");
  });

  it("leaves tracing alone only when LANGSMITH_ALLOW_PHI_TRACING=true was set on purpose", () => {
    const env = { LANGSMITH_TRACING: "true", LANGSMITH_ALLOW_PHI_TRACING: "true" } as NodeJS.ProcessEnv;
    expect(enforceTracingPolicy(env)).toBe(false);
    expect(env.LANGSMITH_TRACING).toBe("true");
  });

  it("does nothing when tracing was never requested", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(enforceTracingPolicy(env)).toBe(false);
  });
});
