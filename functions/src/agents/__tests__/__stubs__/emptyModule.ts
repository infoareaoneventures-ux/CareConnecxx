// Test-only stub for backend-only npm packages that are installed under
// functions/node_modules but not at the repo root, where Vitest runs. Vite's
// static import-graph transform must resolve every bare specifier in a module's
// tree even when a test mocks the wrapper that uses it, so these otherwise
// unresolvable packages are aliased here. Backend tests that need real behavior
// from any of these mock it explicitly with vi.mock; this stub only keeps the
// transform from failing on unrelated transitive imports.
//
// A Proxy makes every named/default access return a no-op callable, so
// `import * as functions from "firebase-functions/v1"` and friends don't throw
// at evaluation time.
const noop = () => undefined;
const handler: ProxyHandler<any> = {
  get: (_t, prop) => {
    if (prop === "__esModule") return true;
    if (prop === "default") return proxy;
    return proxy;
  },
  apply: () => proxy,
  construct: () => ({}),
};
const proxy: any = new Proxy(noop, handler);

export default proxy;
export const __esModule = true;
