import type { CaraActionDefinition } from "./caraActionTypes";

export function defineCaraAction<TInput, TOutput>(
  action: CaraActionDefinition<TInput, TOutput>,
): CaraActionDefinition<TInput, TOutput> {
  if (!action?.name?.trim()) throw new Error("defineCaraAction: name is required");
  if (!action?.description?.trim()) throw new Error(`defineCaraAction(${action?.name ?? "unknown"}): description is required`);
  if (!action.inputSchema) throw new Error(`defineCaraAction(${action.name}): inputSchema is required`);
  if (!action.outputSchema) throw new Error(`defineCaraAction(${action.name}): outputSchema is required`);
  if (typeof action.run !== "function") throw new Error(`defineCaraAction(${action.name}): run is required`);

  return {
    ...action,
    readOnly: action.readOnly === true,
    modelVisible: action.modelVisible !== false,
    webVisible: action.webVisible !== false,
    adminOnly: action.adminOnly === true,
    publicAllowed: action.publicAllowed === true,
  };
}
