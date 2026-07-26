type Handler = (...args: any[]) => any;

function identity(_options: unknown, handler?: Handler): Handler {
  return handler ?? ((_event: unknown) => undefined);
}

export const onObjectFinalized = identity;
export const onMessagePublished = identity;
