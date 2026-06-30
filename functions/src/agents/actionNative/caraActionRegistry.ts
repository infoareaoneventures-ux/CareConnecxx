import type { CaraActionCaller, CaraActionDefinition, CaraActionRole } from "./caraActionTypes";

export class CaraActionRegistry {
  private readonly actions = new Map<string, CaraActionDefinition>();

  register<TInput, TOutput>(action: CaraActionDefinition<TInput, TOutput>): CaraActionDefinition<TInput, TOutput> {
    if (this.actions.has(action.name)) {
      throw new Error(`CaraActionRegistry: duplicate action ${action.name}`);
    }
    this.actions.set(action.name, action as CaraActionDefinition);
    return action;
  }

  get(name: string): CaraActionDefinition | undefined {
    return this.actions.get(name);
  }

  list(): CaraActionDefinition[] {
    return Array.from(this.actions.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  visibleFor(opts: { caller: CaraActionCaller; role: CaraActionRole }): CaraActionDefinition[] {
    return this.list().filter(action => {
      if (action.adminOnly && opts.role !== "admin") return false;
      if (action.allowedRoles?.length && !action.allowedRoles.includes(opts.role)) return false;
      if (opts.caller === "sms_agent" || opts.caller === "mcp") return action.modelVisible;
      if (opts.caller === "web_chat") return action.webVisible;
      if (opts.caller === "admin") return true;
      return !action.adminOnly;
    });
  }

  assertHealthy(maxModelVisible = 40): void {
    const modelVisible = this.list().filter(action => action.modelVisible);
    if (modelVisible.length > maxModelVisible) {
      throw new Error(`CaraActionRegistry: model-visible action surface too large (${modelVisible.length}/${maxModelVisible})`);
    }

    for (const action of this.list()) {
      if (!action.readOnly && !action.outputSchema) {
        throw new Error(`CaraActionRegistry: mutating action ${action.name} is missing outputSchema`);
      }
      if (action.publicAllowed && !action.readOnly) {
        throw new Error(`CaraActionRegistry: public action ${action.name} must be readOnly`);
      }
      if (action.adminOnly && action.publicAllowed) {
        throw new Error(`CaraActionRegistry: admin-only action ${action.name} cannot be public`);
      }
    }
  }
}

export const caraActionRegistry = new CaraActionRegistry();
