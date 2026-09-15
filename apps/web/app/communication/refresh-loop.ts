/** One serial reader per mounted chat page. Inbox errors must not starve the
 * selected conversation; visibility and write operations can pause both. */
export function createCommunicationRefreshLoop(input: {
  canRun(): boolean;
  readInbox(): Promise<void>;
  readThread(): Promise<void>;
  onError(scope: 'inbox' | 'thread', error: unknown): void;
  onBusy(busy: boolean): void;
  intervalMs: number;
}) {
  let stopped = false,
    again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => void wake(), ms);
  };
  const wake = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    clearTimeout(timer);
    if (running) {
      again = true;
      return running;
    }
    if (!input.canRun()) {
      schedule(input.intervalMs);
      return Promise.resolve();
    }
    running = Promise.resolve().then(async () => {
      input.onBusy(true);
      try {
        try {
          await input.readInbox();
        } catch (error) {
          if (!stopped) input.onError('inbox', error);
        }
        if (!stopped && input.canRun()) {
          try {
            await input.readThread();
          } catch (error) {
            if (!stopped) input.onError('thread', error);
          }
        }
      } finally {
        running = null;
        input.onBusy(false);
        schedule(again ? 0 : input.intervalMs);
        again = false;
      }
    });
    return running;
  };
  return {
    wake,
    idle: () => running ?? Promise.resolve(),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
