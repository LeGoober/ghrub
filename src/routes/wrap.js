/**
 * Forward a rejected async handler to Express's error middleware.
 *
 * Express 4 only routes errors passed to next(). It does not inspect the return
 * value of a handler, so a rejected promise from an awaited DB call would be an
 * unhandled rejection: the request hangs until the browser gives up, and the
 * "Something broke" page in server.js never renders. Every async route in this
 * app is wrapped, so a Neon hiccup shows the friendly 500 instead of a spinner
 * that never resolves.
 */
export const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
