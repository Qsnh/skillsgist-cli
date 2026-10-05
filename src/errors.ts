export class CliError extends Error {
  readonly showUsage: boolean;

  constructor(message: string, options: { showUsage?: boolean } = {}) {
    super(message);
    this.name = "CliError";
    this.showUsage = options.showUsage ?? false;
  }
}
