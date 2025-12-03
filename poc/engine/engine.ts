import { AnyAction, Delete, Set } from './action';
import { Store } from './store';

export class Engine {
  private readonly actions: AnyAction[] = [];

  private store = new Store();

  private reduce(action: AnyAction, store: Store): Store {
    if (Set.isMatch(action)) {
      return store.set(action.path, action.payload);
    } else if (Delete.isMatch(action)) {
      return store.delete(action.path);
    }

    return store;
  }

  public add(action: AnyAction): void {
    this.actions.push(action);
    this.store = this.reduce(action, this.store);
  }

  public serialize(): Record<string, unknown> {
    return this.store.serialize();
  }
}
