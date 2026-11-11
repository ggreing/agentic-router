/** Error thrown by textkit functions for invalid arguments or templates. */
export class TextkitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextkitError';
  }
}
