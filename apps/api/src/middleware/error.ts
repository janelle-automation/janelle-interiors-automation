import type { NextFunction, Request, Response } from 'express';

/** Wrap an async route so thrown errors reach the error handler. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * A failure whose message is written for the person, not the log.
 *
 * Most errors are flattened to "Server error" on purpose: an exception
 * message can carry a query, a key or a whole request body. Some, though,
 * exist precisely to be read — an empty account, an expired credential —
 * and hiding those sends people hunting for a bug that is not there.
 */
export class UserFacingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'UserFacingError';
    this.status = status;
  }
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const message = err instanceof Error ? err.message : 'Unexpected error';

  // Malformed JSON body (from express.json) → 400, not 500.
  const e = err as { type?: string; status?: number; statusCode?: number };
  const type = e.type;
  const status = e.statusCode ?? e.status;
  if (type === 'entity.parse.failed' || (err instanceof SyntaxError && status === 400)) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  if (err instanceof UserFacingError) {
    return res.status(err.status).json({ error: err.message });
  }

  // In production, avoid leaking internals; log server-side.
  console.error('[api error]', err);
  res.status(500).json({ error: 'Server error', detail: message });
}
