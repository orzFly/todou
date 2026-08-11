/** A user-facing failure: printed as one line, optionally with a hint. */
export class CliError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}
