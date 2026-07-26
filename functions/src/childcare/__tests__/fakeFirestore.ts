// Minimal injectable Firestore fake for childcare U4 tests (pattern:
// jurisdictionPolicy.test.ts, extended with set/create/update, where-queries,
// and transactions). Deliberately tiny — only the surface the U4 modules use.

export interface FakeDb {
  db: any;
  docs: Map<string, Record<string, unknown>>;
  seed(path: string, data: Record<string, unknown>): void;
  get(path: string): Record<string, unknown> | undefined;
}

class AlreadyExistsError extends Error {
  code = 6;
  constructor(path: string) {
    super(`Document already exists: ${path}`);
  }
}

export function makeFakeDb(initial: Record<string, Record<string, unknown>> = {}): FakeDb {
  const docs = new Map<string, Record<string, unknown>>(Object.entries(initial));

  function deepMerge(prev: any, data: any): any {
    const out: any = { ...(prev ?? {}) };
    for (const [k, v] of Object.entries(data ?? {})) {
      const prevVal = out[k];
      const both =
        v !== null && typeof v === "object" && !Array.isArray(v) &&
        prevVal !== null && typeof prevVal === "object" && !Array.isArray(prevVal);
      out[k] = both ? deepMerge(prevVal, v) : v;
    }
    return out;
  }

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({
      exists: docs.has(path),
      id: path.split("/").pop(),
      data: () => docs.get(path),
    }),
    set: async (data: any, opts?: { merge?: boolean }) => {
      docs.set(path, opts?.merge ? deepMerge(docs.get(path), data) : { ...data });
    },
    create: async (data: any) => {
      if (docs.has(path)) throw new AlreadyExistsError(path);
      docs.set(path, { ...data });
    },
    update: async (data: any) => {
      if (!docs.has(path)) throw new Error(`No document to update: ${path}`);
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (collPath: string): any => {
    const filters: Array<{ field: string; value: unknown }> = [];
    const ref: any = {
      doc: (id?: string) => makeDocRef(`${collPath}/${id ?? `auto-${docs.size}`}`),
      where: (field: string, _op: string, value: unknown) => {
        filters.push({ field, value });
        return ref;
      },
      orderBy: () => ref,
      limit: () => ref,
      get: async () => {
        const rows = [...docs.entries()]
          .filter(([p]) => {
            const parts = p.split("/");
            return parts.slice(0, -1).join("/") === collPath;
          })
          .filter(([, d]) => filters.every((f) => (d as any)[f.field] === f.value))
          .map(([p, d]) => ({
            id: p.split("/").pop(),
            data: () => d,
            ref: makeDocRef(p),
          }));
        return { empty: rows.length === 0, size: rows.length, docs: rows };
      },
    };
    return ref;
  };

  const db: any = {
    collection: (name: string) => makeCollRef(name),
    runTransaction: async (fn: (tx: any) => Promise<any>) => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => { void ref.set(data, opts); },
        update: (ref: any, data: any) => { void ref.update(data); },
      };
      return fn(tx);
    },
  };

  return {
    db,
    docs,
    seed: (path, data) => { docs.set(path, data); },
    get: (path) => docs.get(path),
  };
}
