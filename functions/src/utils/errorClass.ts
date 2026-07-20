export function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
