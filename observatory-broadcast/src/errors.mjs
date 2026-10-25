/**
 * One error type for everything the operator can act on. `code` is stable (tests and scripts branch on it),
 * `hint` says what to do next, `exitCode` is what the CLI exits with:
 *   1 failure, 2 precondition missing (tooling/config), 3 approval refused, 4 URL refused.
 */
export class ObsError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ hint?: string, exitCode?: number, details?: unknown }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = "ObsError";
    this.code = code;
    this.hint = opts.hint;
    this.exitCode = opts.exitCode ?? 1;
    this.details = opts.details;
  }
}
