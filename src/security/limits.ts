export class LimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitExceededError';
  }
}

export function assertHtmlSize(html: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > maxBytes) {
    throw new LimitExceededError(`HTML body exceeds limit (${bytes} > ${maxBytes} bytes)`);
  }
}

export function assertContentSize(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) {
    throw new LimitExceededError(`Rendered content exceeds limit (${bytes} > ${maxBytes} bytes)`);
  }
}

export function assertPageCount(pages: number, maxPages: number): void {
  if (pages > maxPages) {
    throw new LimitExceededError(`Page count exceeds limit (${pages} > ${maxPages})`);
  }
}
