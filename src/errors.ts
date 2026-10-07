export class CliError extends Error {
  readonly showUsage: boolean;

  constructor(message: string, options: { showUsage?: boolean } = {}) {
    super(message);
    this.name = "CliError";
    this.showUsage = options.showUsage ?? false;
  }
}

export function errorMessage(err: unknown): string {
  return (err instanceof Error && err.message) || String(err);
}
