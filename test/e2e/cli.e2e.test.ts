import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const REPO = path.resolve(__dirname, '..', '..');

describe('CLI: src/cli/htp.ts (e2e — uses Chromium)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'htp-cli-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('renders --html string to --out file', async () => {
    const out = path.join(tmp, 'a.pdf');
    const { stderr } = await exec(
      'npx',
      ['tsx', 'src/cli/htp.ts', '--quiet', '--html', '<h1>CLI</h1>', '--out', out],
      { cwd: REPO },
    );
    expect(stderr).toBe('');
    const buf = await fs.readFile(out);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(buf.byteLength).toBeGreaterThan(500);
  }, 60_000);

  it('reads HTML from stdin and writes JSON metadata when --json', async () => {
    const child = exec(
      'npx',
      ['tsx', 'src/cli/htp.ts', '--quiet', '--json'],
      { cwd: REPO, maxBuffer: 8 * 1024 * 1024 },
    );
    child.child.stdin?.write('<h1>From stdin</h1>');
    child.child.stdin?.end();
    const { stdout } = await child;
    const meta = JSON.parse(stdout) as { bytes: number; pages: number; sha256: string };
    expect(meta.pages).toBe(1);
    expect(meta.bytes).toBeGreaterThan(500);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it('exits with code 2 when both --url and --html are provided', async () => {
    let exitCode: number | undefined;
    let stderr = '';
    try {
      await exec(
        'npx',
        ['tsx', 'src/cli/htp.ts', '--quiet', '--url', 'https://example.com', '--html', '<p/>'],
        { cwd: REPO },
      );
    } catch (err) {
      exitCode = (err as { code: number }).code;
      stderr = (err as { stderr: string }).stderr;
    }
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/exactly one/);
  }, 30_000);

  it('exits with code 3 when SSRF blocks the URL', async () => {
    let exitCode: number | undefined;
    let stderr = '';
    try {
      await exec(
        'npx',
        ['tsx', 'src/cli/htp.ts', '--quiet', '--url', 'http://127.0.0.1:1/'],
        { cwd: REPO },
      );
    } catch (err) {
      exitCode = (err as { code: number }).code;
      stderr = (err as { stderr: string }).stderr;
    }
    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/private/);
  }, 30_000);
});
