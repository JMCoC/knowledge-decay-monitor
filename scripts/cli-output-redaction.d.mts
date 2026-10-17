export interface CliOutputRedactionOptions {
  maxLines?: number;
  maxChars?: number;
}

export function redactCliOutput(text: string, options?: CliOutputRedactionOptions): string;
