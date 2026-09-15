export class GreetingRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Only a confirmed pre-write busy response may be retried automatically. */
export async function waitForGreeting<T>(
  request: (signal: AbortSignal) => Promise<T>,
  options: {
    signal: AbortSignal;
    onWait: (seconds: number) => void;
    maxWaitMs?: number;
    pollMs?: number;
  },
): Promise<T> {
  const started = Date.now();
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  while (true) {
    options.signal.throwIfAborted();
    try {
      return await request(options.signal);
    } catch (error) {
      options.signal.throwIfAborted();
      if (!(error instanceof GreetingRequestError) || error.code !== 'busy')
        throw error;
      const elapsed = Date.now() - started;
      if (elapsed >= maxWaitMs)
        throw new GreetingRequestError(
          'BOSS 仍在处理其他操作，本次操作未执行。参考消息已保留，请稍后再次点击应用或重新读取。',
          'busy',
        );
      options.onWait(Math.ceil(elapsed / 1000));
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(options.signal.reason);
        };
        const timer = setTimeout(
          () => {
            options.signal.removeEventListener('abort', abort);
            resolve();
          },
          Math.min(options.pollMs ?? 2500, maxWaitMs - elapsed),
        );
        options.signal.addEventListener('abort', abort, { once: true });
      });
      if (Date.now() - started >= maxWaitMs)
        throw new GreetingRequestError(
          'BOSS 仍在处理其他操作，本次操作未执行。参考消息已保留，请稍后再次点击应用或重新读取。',
          'busy',
        );
    }
  }
}
