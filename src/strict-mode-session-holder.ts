interface DisposableExternalStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

export function createStrictModeSessionHolder<Session extends DisposableExternalStore>(session: Session) {
  let subscribers = 0;
  let disposeTimer: ReturnType<typeof setTimeout> | null = null;

  const subscribe = (listener: () => void) => {
    if (disposeTimer !== null) {
      clearTimeout(disposeTimer);
      disposeTimer = null;
    }
    subscribers += 1;
    let unsubscribe: () => void;
    try {
      unsubscribe = session.subscribe(listener);
    } catch (error) {
      subscribers -= 1;
      if (subscribers === 0) {
        session.dispose();
      }
      throw error;
    }
    let subscribed = true;

    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      unsubscribe();
      subscribers -= 1;
      if (subscribers === 0) {
        // StrictMode immediately resubscribes after its development-only cleanup replay.
        disposeTimer = setTimeout(() => {
          disposeTimer = null;
          if (subscribers === 0) {
            session.dispose();
          }
        }, 0);
      }
    };
  };

  return { session, subscribe };
}
