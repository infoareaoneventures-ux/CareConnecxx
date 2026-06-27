// Test-only stub for `firebase-functions/v1`, which lives under
// functions/node_modules and is aliased here so Vitest (running at the repo
// root) can resolve it in every module's static import graph.
//
// Unlike a blanket no-op proxy, this stub implements the handful of v1 builders
// the codebase uses to DEFINE functions at module load. `onCall`/`onRequest`
// return the handler unchanged so a test can invoke the exported function
// directly (e.g. `stripeWebhook(req, res)`); the trigger builders are chainable
// no-ops that also return the handler. Backend tests that need real/observable
// behavior still mock `firebase-functions/v1` explicitly with `vi.mock`, which
// overrides this stub.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (...args: any[]) => any;

// onCall/onRequest/onRun/onWrite/... all hand the wrapped handler straight back
// so tests can call the resulting CloudFunction as a plain function.
const identity = (handler: AnyHandler): AnyHandler => handler;

export class HttpsError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message?: string, details?: unknown) {
    super(message);
    this.name = "HttpsError";
    this.code = code;
    this.details = details;
  }
}

export const https = {
  onCall: identity,
  onRequest: identity,
  HttpsError,
};

const documentBuilder = () => ({
  onWrite: identity,
  onCreate: identity,
  onUpdate: identity,
  onDelete: identity,
});

export const firestore = {
  document: documentBuilder,
};

const scheduleBuilder = () => {
  const builder: Record<string, unknown> = {
    onRun: identity,
    timeZone: () => builder,
    retryConfig: () => builder,
  };
  return builder;
};

export const pubsub = {
  schedule: scheduleBuilder,
  topic: () => ({ onPublish: identity }),
};

export const auth = {
  user: () => ({ onCreate: identity, onDelete: identity }),
};

export const config = () => ({} as Record<string, unknown>);

// runWith(opts) / region(...) are chainable and expose the same builders.
const namespace: Record<string, unknown> = {
  https,
  firestore,
  pubsub,
  auth,
  config,
};
namespace.runWith = () => namespace;
namespace.region = () => namespace;

export const runWith = (): Record<string, unknown> => namespace;
export const region = (): Record<string, unknown> => namespace;

export default namespace;
export const __esModule = true;
