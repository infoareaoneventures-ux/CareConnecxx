# Agent-Native Attribution

Evia adapts a narrow framework slice from BuilderIO Agent-Native for Evia's local action runtime.

- Source: `https://github.com/BuilderIO/agent-native`
- Package reference reviewed: `@agent-native/core`
- License: MIT for `packages/core`
- Local usage: adapted action-contract concepts and a localized derivative of `packages/core/src/agent/tool-call-journal.ts`

The full Agent-Native runtime is intentionally not an Evia launch dependency.
Evia keeps Firebase Functions, Firestore, Linq, MCP tools, and the existing React app as the runtime architecture.
