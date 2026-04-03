import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXIT_CLEAN,
  EXIT_CONSISTENT_FAILURES,
  EXIT_INTERMITTENT_FAILURES,
  exitCodeForAssessment,
  runAnalyzer,
  scanHeuristics,
  summarizeRuns,
  type RunRecord,
} from '../scripts/test-flakiness.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    iteration: overrides.iteration ?? 1,
    success: overrides.success ?? true,
    failedAssertions: overrides.failedAssertions ?? [],
    failedSuites: overrides.failedSuites ?? [],
    suiteErrors: overrides.suiteErrors ?? [],
  };
}

describe('exitCodeForAssessment', () => {
  it('maps clean, intermittent, and consistent failures to stable exit codes', () => {
    expect(exitCodeForAssessment('clean')).toBe(EXIT_CLEAN);
    expect(exitCodeForAssessment('intermittent')).toBe(EXIT_INTERMITTENT_FAILURES);
    expect(exitCodeForAssessment('consistent-failures')).toBe(EXIT_CONSISTENT_FAILURES);
  });
});

describe('summarizeRuns', () => {
  it('returns a clean assessment when every run passes', () => {
    const summary = summarizeRuns(
      [createRunRecord({ iteration: 1 }), createRunRecord({ iteration: 2 })],
      [],
    );

    expect(summary.assessment).toBe('clean');
    expect(summary.failedRuns).toBe(0);
    expect(summary.uniqueFailingFiles).toBe(0);
    expect(summary.uniqueFailingTests).toBe(0);
  });

  it('marks partially failing assertions as intermittent', () => {
    const failure = {
      file: 'tests/example.test.ts',
      testName: 'example is flaky',
      failureMessages: ['boom'],
    };
    const summary = summarizeRuns(
      [
        createRunRecord({ iteration: 1, success: false, failedSuites: ['tests/example.test.ts'], failedAssertions: [failure] }),
        createRunRecord({ iteration: 2 }),
        createRunRecord({ iteration: 3, success: false, failedSuites: ['tests/example.test.ts'], failedAssertions: [failure] }),
      ],
      [],
    );

    expect(summary.assessment).toBe('intermittent');
    expect(summary.intermittentFiles).toEqual([
      { file: 'tests/example.test.ts', failedRuns: 2, totalRuns: 3 },
    ]);
    expect(summary.intermittentTests).toEqual([
      { file: 'tests/example.test.ts', testName: 'example is flaky', failedRuns: 2, totalRuns: 3 },
    ]);
  });

  it('treats suite-level failures without assertion details as consistent failures when every run fails', () => {
    const summary = summarizeRuns(
      [
        createRunRecord({
          iteration: 1,
          success: false,
          failedSuites: ['tests/setup.test.ts'],
          suiteErrors: ['tests/setup.test.ts: setup blew up'],
        }),
        createRunRecord({
          iteration: 2,
          success: false,
          failedSuites: ['tests/setup.test.ts'],
          suiteErrors: ['tests/setup.test.ts: setup blew up'],
        }),
      ],
      [],
    );

    expect(summary.assessment).toBe('consistent-failures');
    expect(summary.uniqueFailingFiles).toBe(1);
    expect(summary.uniqueFailingTests).toBe(0);
    expect(summary.suiteErrors).toEqual(['tests/setup.test.ts: setup blew up']);
  });
});

describe('scanHeuristics', () => {
  it('detects heuristic patterns from test files without ripgrep', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'flake-heuristics-'));
    tempDirs.push(rootDir);

    const testDir = join(rootDir, 'tests');
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, 'sample.test.ts'),
      `
        const now = new Date();
        const keys = Object.keys({ a: 1 });
        const formatted = value.toLocaleDateString();
      `,
    );

    const heuristics = scanHeuristics({
      runs: 2,
      rootDir,
      testDir,
      passThroughArgs: [],
    });

    expect(heuristics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'tests/sample.test.ts', category: 'date-time' }),
        expect.objectContaining({ file: 'tests/sample.test.ts', category: 'ordering' }),
        expect.objectContaining({ file: 'tests/sample.test.ts', category: 'locale-formatting' }),
      ]),
    );
  });
});

describe('runAnalyzer', () => {
  it('prints the consistent-failure summary for automation', () => {
    const lines: string[] = [];
    const summary = runAnalyzer(
      {
        runs: 2,
        rootDir: process.cwd(),
        testDir: join(process.cwd(), 'tests'),
        passThroughArgs: [],
      },
      {
        runVitest: iteration =>
          createRunRecord({
            iteration,
            success: false,
            failedSuites: ['tests/fail.test.ts'],
            failedAssertions: [
              {
                file: 'tests/fail.test.ts',
                testName: 'always fails',
                failureMessages: ['boom'],
              },
            ],
          }),
        scanHeuristics: () => [],
        log: line => lines.push(line),
      },
    );

    expect(summary.assessment).toBe('consistent-failures');
    expect(lines.join('\n')).toContain('Assessment: the suite failed consistently across all runs');
  });
});
