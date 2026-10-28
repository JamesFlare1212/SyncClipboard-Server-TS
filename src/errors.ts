export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class TransferError extends HttpError {
  constructor(message = "History transfer data failed validation.") {
    super(422, message);
  }
}

export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
