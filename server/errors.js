// An error with an HTTP status, turned into a JSON answer by the error handler in index.js.
export class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
