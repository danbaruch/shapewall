// `extra`: more fields for the error object the client reads (a refusal that
// asks for a passkey says which rule asked: { stepUp }).
export class HttpError extends Error {
  constructor(status, code, message, extra = null) {
    super(message)
    this.statusCode = status
    this.code = code
    this.extra = extra
  }
}
