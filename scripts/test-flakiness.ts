#!/usr/bin/env tsx

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXIT_CLEAN = 0;
export const EXIT_INTERMITTENT_FAILURES = 1;
export const EXIT_CONSISTENT_FAILURES = 2;

interface CliOptions {
  runs: number;
  grep?: string;
  filePattern?: string;
  passThroughArgs: string[];
  rootDir: string;
  testDir: string;
}

interface VitestAssertionResult {
  ancestorTitles?: string[];
  fullName?: string;
  status: string;
  title?: string;
  failureMessages?: string[];
}

interface VitestSuiteResult {
  assertionResults?: VitestAssertionResult[];
  status: string;
  message?: string;
  name: string;
}

interface VitestJsonReport {
  success: boolean;
  testResults: VitestSuiteResult[];
}

export interface AggregatedFailure {
  file: string;
  testName: string;
  failureMessages: string[];
}

export interface RunRecord {
  iteration: number;
  success: boolean;
  failedAssertions: AggregatedFailure[];
  failedSuites: string[];
  suiteErrors: string[];
}

export interface Heuristic {
  file: string;
  category: string;
  detail: string;
}

type Assessment = 'clean' | 'consistent-failures' | 'intermittent';

export interface Summary {
  assessment: Assessment;
  totalRuns: number;
  failedRuns: number;
  uniqueFailingFiles: number;
  uniqueFailingTests: number;
  intermittentFiles: Array<{ file: string; failedRuns: number; totalRuns: number }>;
  intermittentTests: Array<{ file: string; testName: string; failedRuns: number; totalRuns: number }>;
  fileStats: Array<{ file: string; failedRuns: number; totalRuns: number }>;
  testStats: Array<{ file: string; testName: string; failedRuns: number; totalRuns: number }>;
  suiteErrors: string[];
  heuristics: Heuristic[];
}

interface AnalyzerDeps {
  runVitest: (iteration: number, options: CliOptions) => RunRecord;
  scanHeuristics: (options: CliOptions) => Heuristic[];
  log: (line: string) => void;
}

const DATE_PATTERNS = [
  { category: 'date-time', regex: /\bnew Date\(/g, detail: 'References wall-clock time directly.' },
  { category: 'date-time', regex: /\bDate\.now\(/g, detail: 'References wall-clock time directly.' },
  { category: 'date-time', regex: /\btoISOString\(/g, detail: 'References wall-clock time directly.' },
  { category: 'date-time', regex: /date\(\s*['"]now['"]/g, detail: 'References wall-clock time directly.' },
];

const OTHER_PATTERNS = [
  { category: 'locale-formatting', regex: /\btoLocale(DateString|String|TimeString)\(/g, detail: 'Formats dates or strings using locale-sensitive APIs.' },
  { category: 'randomness', regex: /\bMath\.random\(|crypto\.randomUUID\(/g, detail: 'Uses random data without an injected seed.' },
  { category: 'environment', regex: /\bprocess\.env\b/g, detail: 'Depends on environment variables.' },
  { category: 'timing', regex: /\bsetTimeout\(|setInterval\(|queueMicrotask\(/g, detail: 'Relies on scheduler timing or async ordering.' },
  { category: 'ordering', regex: /\bObject\.(keys|values|entries)\(/g, detail: 'Depends on collection iteration order.' },
];

const defaultRootDir = process.cwd();

function vitestBin(rootDir: string): string {
  return process.platform === 'win32'
    ? resolve(rootDir, 'node_modules', '.bin', 'vitest.cmd')
    : resolve(rootDir, 'node_modules', '.bin', 'vitest');
}

export function parseArgs(argv: string[], rootDir = defaultRootDir): CliOptions {
  const options: CliOptions = {
    runs: 10,
    passThroughArgs: [],
    rootDir,
    testDir: resolve(rootDir, 'tests'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runs' || arg === '-r') {
      options.runs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--runs=')) {
      options.runs = Number(arg.split('=')[1]);
      continue;
    }
    if (arg === '--grep' || arg === '-g') {
      options.grep = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--grep=')) {
      options.grep = arg.slice('--grep='.length);
      continue;
    }
    if (arg === '--file' || arg === '-f') {
      options.filePattern = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--file=')) {
      options.filePattern = arg.slice('--file='.length);
      continue;
    }
    if (arg.startsWith('--test-dir=')) {
      options.testDir = resolve(rootDir, arg.slice('--test-dir='.length));
      continue;
    }
    options.passThroughArgs.push(arg);
  }

  if (!Number.isInteger(options.runs) || options.runs <= 0) {
    throw new Error(`Expected --runs to be a positive integer, received: ${options.runs}`);
  }

  return options;
}

export function runVitest(iteration: number, options: CliOptions): RunRecord {
  const tempDir = mkdtempSync(join(tmpdir(), 'mx3-vitest-flake-'));
  const outputFile = join(tempDir, `vitest-run-${iteration}.json`);
  const args = [
    'run',
    '--reporter=json',
    '--outputFile',
    outputFile,
    '--no-color',
  ];

  if (options.grep) {
    args.push('--testNamePattern', options.grep);
  }
  if (options.filePattern) {
    args.push(options.filePattern);
  }
  args.push(...options.passThroughArgs);

  const result = spawnSync(vitestBin(options.rootDir), args, {
    cwd: options.rootDir,
    encoding: 'utf8',
    env: process.env,
  });

  let report: VitestJsonReport | undefined;
  try {
    report = JSON.parse(readFileSync(outputFile, 'utf8')) as VitestJsonReport;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `Failed to parse Vitest JSON report for run ${iteration}.`,
        `Command: vitest ${args.join(' ')}`,
        result.stderr.trim(),
        result.stdout.trim(),
        reason,
      ].filter(Boolean).join('\n'),
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }

  const failedAssertions: AggregatedFailure[] = [];
  const failedSuites: string[] = [];
  const suiteErrors: string[] = [];

  for (const suite of report.testResults) {
    const file = relative(options.rootDir, suite.name);
    if (suite.status === 'failed') {
      failedSuites.push(file);
    }
    if (suite.message?.trim()) {
      suiteErrors.push(`${file}: ${firstLine(suite.message)}`);
    }

    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status !== 'failed') {
        continue;
      }

      failedAssertions.push({
        file,
        testName: assertion.fullName ?? [...(assertion.ancestorTitles ?? []), assertion.title].filter(Boolean).join(' > '),
        failureMessages: assertion.failureMessages ?? [],
      });
    }
  }

  return {
    iteration,
    success: result.status === 0 && report.success && failedAssertions.length === 0 && suiteErrors.length === 0,
    failedAssertions,
    failedSuites,
    suiteErrors,
  };
}

export function scanHeuristics(options: CliOptions): Heuristic[] {
  const heuristics = new Map<string, Heuristic>();

  for (const file of collectCandidateFiles(options)) {
    let content = '';
    try {
      content = sanitizeForHeuristics(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }

    for (const pattern of [...DATE_PATTERNS, ...OTHER_PATTERNS]) {
      if (!pattern.regex.test(content)) {
        pattern.regex.lastIndex = 0;
        continue;
      }

      const finding = {
        file: relative(options.rootDir, file),
        category: pattern.category,
        detail: pattern.detail,
      };
      heuristics.set(`${finding.file}::${finding.category}::${finding.detail}`, finding);
      pattern.regex.lastIndex = 0;
    }
  }

  return [...heuristics.values()];
}

function sanitizeForHeuristics(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/`(?:\\.|[^`])*`/g, ' ')
    .replace(/"(?:\\.|[^"])*"/g, ' ')
    .replace(/'(?:\\.|[^'])*'/g, ' ');
}

function collectCandidateFiles(options: CliOptions): string[] {
  if (options.filePattern) {
    return [resolve(options.rootDir, options.filePattern)];
  }

  try {
    return walkFiles(options.testDir);
  } catch {
    return [];
  }
}

function walkFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...walkFiles(fullPath));
      continue;
    }
    if (stats.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

export function summarizeRuns(runRecords: RunRecord[], heuristics: Heuristic[]): Summary {
  const totalRuns = runRecords.length;
  const failedRuns = runRecords.filter(run => !run.success);
  const fileStats = new Map<string, { failedRuns: number; totalRuns: number }>();
  const testStats = new Map<string, { file: string; testName: string; failedRuns: number; totalRuns: number }>();
  const suiteErrors = new Set<string>();

  for (const run of runRecords) {
    const failedFileSet = new Set<string>(run.failedSuites);
    const failedTestSet = new Set<string>();

    for (const suiteError of run.suiteErrors) {
      suiteErrors.add(suiteError);
    }

    for (const assertion of run.failedAssertions) {
      failedFileSet.add(assertion.file);
      failedTestSet.add(`${assertion.file}::${assertion.testName}`);
    }

    for (const file of failedFileSet) {
      const current = fileStats.get(file) ?? { failedRuns: 0, totalRuns };
      current.failedRuns += 1;
      fileStats.set(file, current);
    }

    for (const key of failedTestSet) {
      const [file, testName] = splitFailureKey(key);
      const current = testStats.get(key) ?? { file, testName, failedRuns: 0, totalRuns };
      current.failedRuns += 1;
      testStats.set(key, current);
    }
  }

  const fileEntries = [...fileStats.entries()]
    .map(([file, stats]) => ({ file, ...stats }))
    .sort((left, right) => right.failedRuns - left.failedRuns || left.file.localeCompare(right.file));
  const testEntries = [...testStats.entries()]
    .map(([, stats]) => stats)
    .sort((left, right) => right.failedRuns - left.failedRuns || left.file.localeCompare(right.file) || left.testName.localeCompare(right.testName));
  const intermittentFiles = fileEntries.filter(stats => stats.failedRuns > 0 && stats.failedRuns < stats.totalRuns);
  const intermittentTests = testEntries.filter(stats => stats.failedRuns > 0 && stats.failedRuns < stats.totalRuns);

  let assessment: Assessment = 'clean';
  if (failedRuns.length === 0) {
    assessment = 'clean';
  } else if (intermittentTests.length > 0 || intermittentFiles.length > 0 || failedRuns.length < totalRuns) {
    assessment = 'intermittent';
  } else {
    assessment = 'consistent-failures';
  }

  return {
    assessment,
    totalRuns,
    failedRuns: failedRuns.length,
    uniqueFailingFiles: fileEntries.length,
    uniqueFailingTests: testEntries.length,
    intermittentFiles,
    intermittentTests,
    fileStats: fileEntries,
    testStats: testEntries,
    suiteErrors: [...suiteErrors].sort(),
    heuristics,
  };
}

export function printSummary(summary: Summary, log: (line: string) => void): void {
  log('Flakiness analyzer summary');
  log(`Runs: ${summary.totalRuns}`);
  log(`Failed runs: ${summary.failedRuns}`);
  log(`Unique failing files: ${summary.uniqueFailingFiles}`);
  log(`Unique failing tests: ${summary.uniqueFailingTests}`);
  log('');

  if (summary.failedRuns === 0) {
    log('Run results: all runs passed.');
  } else {
    log('Failure frequency by file:');
    if (summary.fileStats.length === 0) {
      log('  none');
    } else {
      for (const stats of summary.fileStats) {
        log(`  ${stats.file}: ${stats.failedRuns}/${stats.totalRuns} failed runs`);
      }
    }

    log('');
    log('Failure frequency by test:');
    if (summary.testStats.length === 0) {
      log('  none');
    } else {
      for (const stats of summary.testStats) {
        log(`  ${stats.file} :: ${stats.testName}: ${stats.failedRuns}/${stats.totalRuns} failed runs`);
      }
    }

    if (summary.suiteErrors.length > 0) {
      log('');
      log('Suite-level failures:');
      for (const suiteError of summary.suiteErrors) {
        log(`  ${suiteError}`);
      }
    }
  }

  log('');
  log('Heuristic review:');
  if (summary.heuristics.length === 0) {
    log('  no obvious nondeterminism patterns found in scanned test files');
  } else {
    for (const heuristic of summary.heuristics) {
      log(`  ${heuristic.file}: [${heuristic.category}] ${heuristic.detail}`);
    }
  }

  log('');
  if (summary.assessment === 'clean') {
    log('Assessment: no intermittent failures were observed.');
  } else if (summary.assessment === 'consistent-failures') {
    log('Assessment: the suite failed consistently across all runs; this is not a flake, but the command should still fail.');
  } else {
    log('Assessment: intermittent failures detected.');
    if (summary.intermittentFiles.length > 0) {
      log('Intermittent files:');
      for (const stats of summary.intermittentFiles) {
        log(`  ${stats.file}: ${stats.failedRuns}/${stats.totalRuns} failed runs`);
      }
    }
    if (summary.intermittentTests.length > 0) {
      log('Intermittent tests:');
      for (const stats of summary.intermittentTests) {
        log(`  ${stats.file} :: ${stats.testName}: ${stats.failedRuns}/${stats.totalRuns} failed runs`);
      }
    }
  }
}

export function runAnalyzer(options: CliOptions, deps: AnalyzerDeps): Summary {
  const runRecords: RunRecord[] = [];

  for (let iteration = 1; iteration <= options.runs; iteration += 1) {
    deps.log(`Running Vitest iteration ${iteration}/${options.runs}...`);
    runRecords.push(deps.runVitest(iteration, options));
  }

  const summary = summarizeRuns(runRecords, deps.scanHeuristics(options));
  printSummary(summary, deps.log);
  return summary;
}

export function exitCodeForAssessment(assessment: Assessment): number {
  if (assessment === 'clean') {
    return EXIT_CLEAN;
  }
  if (assessment === 'intermittent') {
    return EXIT_INTERMITTENT_FAILURES;
  }
  return EXIT_CONSISTENT_FAILURES;
}

export function main(argv = process.argv.slice(2)): number {
  const options = parseArgs(argv);
  const summary = runAnalyzer(options, {
    runVitest,
    scanHeuristics,
    log: line => console.log(line),
  });
  return exitCodeForAssessment(summary.assessment);
}

function firstLine(message: string): string {
  return message.split('\n').map(line => line.trim()).find(Boolean) ?? message.trim();
}

function splitFailureKey(key: string): [string, string] {
  const separator = key.indexOf('::');
  if (separator === -1) {
    return [key, ''];
  }
  return [key.slice(0, separator), key.slice(separator + 2)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
