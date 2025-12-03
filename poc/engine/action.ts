// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAction = Action<any>;

export interface Action<Payload> {
  type: string;
  path: string;
  payload: Payload;
}

export const Action = <Payload = never>(type: string) => {
  const factory = ((path: string, payload) => ({
    type,
    path,
    payload,
  })) as [Payload] extends [never]
    ? (path: string) => Action<never>
    : (path: string, payload: Payload) => Action<Payload>;
  return Object.assign(factory, {
    type,
    isMatch: (action: { type: string }): action is Action<Payload> =>
      action.type === type,
  });
};

export const Set = Action<unknown>('set');
export const Delete = Action('delete');
