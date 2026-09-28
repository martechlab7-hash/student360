/**
 * Code execution is delegated to an isolated, external sandbox (Judge0-compatible API, or an
 * equivalent gVisor/Firecracker service). Untrusted student code is NEVER executed on the
 * application or worker hosts. With no sandbox configured, coding submissions go to teacher review.
 */
import { config } from '../config.js';

export interface TestCase { input: string; expectedOutput: string; hidden?: boolean }
export interface RunResult { passed: number; total: number; results: { passed: boolean; status: string; timeMs?: number }[] }

export interface CodeRunner {
  run(language: string, code: string, tests: TestCase[]): Promise<RunResult>;
}

const JUDGE0_LANG: Record<string, number> = { python: 71, javascript: 63, java: 62, cpp: 54, c: 50, sql: 82 };

class Judge0Runner implements CodeRunner {
  constructor(private baseUrl: string, private token?: string) {}
  async run(language: string, code: string, tests: TestCase[]): Promise<RunResult> {
    const languageId = JUDGE0_LANG[language];
    if (!languageId) throw new Error(`Unsupported language ${language}`);
    const results: RunResult['results'] = [];
    for (const t of tests) {
      const res = await fetch(`${this.baseUrl}/submissions?base64_encoded=false&wait=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.token ? { 'x-auth-token': this.token } : {}) },
        body: JSON.stringify({ language_id: languageId, source_code: code, stdin: t.input, expected_output: t.expectedOutput,
          cpu_time_limit: 2, memory_limit: 128_000, enable_network: false }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`sandbox responded ${res.status}`);
      const body = (await res.json()) as { status?: { id: number; description: string }; time?: string };
      results.push({ passed: body.status?.id === 3, status: body.status?.description ?? 'unknown', timeMs: body.time ? Number(body.time) * 1000 : undefined });
    }
    return { passed: results.filter((r) => r.passed).length, total: results.length, results };
  }
}

let override: CodeRunner | null | undefined;
export function setCodeRunner(r: CodeRunner | null) { override = r; }

export function getCodeRunner(): CodeRunner | null {
  if (override !== undefined) return override;
  return config.CODE_SANDBOX_URL ? new Judge0Runner(config.CODE_SANDBOX_URL, config.CODE_SANDBOX_TOKEN) : null;
}
