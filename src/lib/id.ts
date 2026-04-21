import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const nano = customAlphabet(alphabet, 21);

export function newJobId(): string {
  return `job_${nano()}`;
}

export function newRequestId(): string {
  return nano();
}

export function newApiKey(): { plaintext: string; id: string } {
  const id = `ak_${nano()}`;
  const plaintext = `${id}.${nano()}${nano()}`;
  return { plaintext, id };
}
