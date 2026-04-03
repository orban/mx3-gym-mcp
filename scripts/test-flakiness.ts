import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

interface CliOptions {
  runs: number;
  grep?: string;
  filePattern?: string;
  passThroughArgs: string[];
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
  numTotalTests: number;
  numFailedTests: number;
  testResults: VitestSuiteResult[];
}

interface RunRecord {
  iteration: number;
  success: boolean;
  failedAssertions: AggregatedFailure[];
  failedSuites: string[];
}

interface AggregatedFailure {
  file: string;
  testName: string;
  failureMessages: string[];
}

interface Heuristic {
  file: string;
  category: string;
  detail: string;
}

type Assessment = 'clean' | 'consistent-failures' | 'intermittent';

const repoRoot = process.cwd();
const vitestBin = process.platform === 'win32'
  ? resolve(repoRoot, 'node_modules', '.bin', 'vitest.cmd')
  : resolve(repoRoot, 'node_modules', '.bin', 'vitest');

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    runs: 10,
    passThroughArgs: [],
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
    options.passThroughArgs.push(arg);
  }

  if (!Number.isInteger(options.runs) || options.runs <= 0) {
    throw new Error(`Expected --runs to be a positive integer, received: ${options.runs}`);
  }

  return options;
}

function runVitest(iteration: number, options: CliOptions): RunRecord {
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

  const result = spawnSync(vitestBin, args, {
    cwd: repoRoot,
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
        `Command: ${basename(vitestBin)} ${args.join(' ')}`,
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

  for (const suite of report.testResults) {
    const file = relative(repoRoot, suite.name);
    if (suite.status === 'failed') {
      failedSuites.push(file);
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
    success: result.status === 0 && report.success,
    failedAssertions,
    failedSuites,
  };
}

function collectCandidateFiles(options: CliOptions): string[] {
  if (options.filePattern) {
    return [resolve(repoRoot, options.filePattern)];
  }

  const root = resolve(repoRoot, 'tests');
  try {
    return walkFiles(root);
  } catch {
    return [];
  }
}

function walkFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function scanHeuristics(options: CliOptions): Heuristic[] {
  const patterns = [
    {
      category: 'date-time',
      regex: /\bnew Date\(|Date\.now\(|toISOString\(|date\('now'/g,
      detail: 'References wall-clock time directly.',
    },
    {
      category: 'locale-formatting',
      regex: /\btoLocale(DateString|String|TimeString)\(|Intl\./g,
      detail: 'Formats dates or strings using locale-sensitive APIs.',
    },
    {
      category: 'randomness',
      regex: /\bMath\.random\(|crypto\.randomUUID\(/g,
      detail: 'Uses random data without an injected seed.',
    },
    {
      category: 'environment',
      regex: /\bprocess\.env\b/g,
      detail: 'Depends on environment variables.',
    },
    {
      category: 'timing',
      regex: /\bsetTimeout\(|setInterval\(|queueMicrotask\(/g,
      detail: 'Relies on scheduler timing or async ordering.',
    },
  ];

  const heuristics: Heuristic[] = [];
  for (const file of collectCandidateFiles(options)) {
    let content = '';
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const pattern of patterns) {
      if (pattern.regex.test(content)) {
        heuristics.push({
          file: relative(repoRoot, file),
          category: pattern.category,
          detail: pattern.detail,
        });
      }
      pattern.regex.lastIndex = 0;
    }
  }

  return heuristics;
}

function printSummary(runRecords: RunRecord[], heuristics: Heuristic[]): Assessment {
  const totalRuns = runRecords.length;
  const failedRuns = runRecords.filter(run => !run.success);
  const fileStats = new Map<string, { failedRuns: number; totalRuns: number }>();
  const testStats = new Map<string, { file: string; failedRuns: number; totalRuns: number }>();

  for (const run of runRecords) {
    const failedFileSet = new Set<string>(run.failedSuites);
    const failedTestSet = new Set<string>();

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
      const [file, testName] = key.split('::');
      const current = testStats.get(key) ?? { file, failedRuns: 0, totalRuns };
      current.failedRuns += 1;
      testStats.set(key, current);
    }
  }

  const intermittentTests = [...testStats.entries()]
    .filter(([, stats]) => stats.failedRuns > 0 && stats.failedRuns < stats.totalRuns)
    .sort((left, right) => right[1].failedRuns - left[1].failedRuns);

  const intermittentFiles = [...fileStats.entries()]
    .filter(([, stats]) => stats.failedRuns > 0 && stats.failedRuns < stats.totalRuns)
    .sort((left, right) => right[1].failedRuns - left[1].failedRuns);

  console.log(`Flakiness analyzer summary`);
  console.log(`Runs: ${totalRuns}`);
  console.log(`Failed runs: ${failedRuns.length}`);
  console.log(`Unique failing files: ${fileStats.size}`);
  console.log(`Unique failing tests: ${testStats.size}`);
  console.log('');

  if (failedRuns.length === 0) {
    console.log('Run results: all runs passed.');
  } else {
    console.log('Run results:');
    for (const run of failedRuns) {
      const labels = [
        ...run.failedSuites,
        ...run.failedAssertions.map(assertion => `${assertion.file} :: ${assertion.testName}`),
      ];
      console.log(`  run ${run.iteration}: ${labels.join(', ') || 'suite-level failure without assertion detail'}`);
    }
  }

  console.log('');
  console.log('Failure frequency by file:');
  if (fileStats.size === 0) {
    console.log('  none');
  } else {
    for (const [file, stats] of [...fileStats.entries()].sort((left, right) => right[1].failedRuns - left[1].failedRuns)) {
      console.log(`  ${file}: ${stats.failedRuns}/${stats.totalRuns} failed runs`);
    }
  }

  console.log('');
  console.log('Failure frequency by test:');
  if (testStats.size === 0) {
    console.log('  none');
  } else {
    for (const [key, stats] of [...testStats.entries()].sort((left, right) => right[1].failedRuns - left[1].failedRuns)) {
      const testName = key.split('::')[1];
      console.log(`  ${stats.file} :: ${testName}: ${stats.failedRuns}/${stats.totalRuns} failed runs`);
    }
  }

  console.log('');
  console.log('Heuristic review:');
  if (heuristics.length === 0) {
    console.log('  no obvious nondeterminism patterns found in scanned test files');
  } else {
    for (const heuristic of heuristics) {
      console.log(`  ${heuristic.file}: [${heuristic.category}] ${heuristic.detail}`);
    }
  }

  console.log('');
  if (failedRuns.length === 0) {
    console.log('Assessment: no intermittent failures were observed.');
    return 'clean';
  }

  if (intermittentTests.length === 0 && intermittentFiles.length === 0) {
    console.log('Assessment: the suite failed consistently across all runs; this is not a flake, but the command should still fail.');
    return 'consistent-failures';
  }

  console.log('Assessment: intermittent failures detected.');
  if (intermittentFiles.length > 0) {
    console.log('Intermittent files:');
    for (const [file, stats] of intermittentFiles) {
      console.log(`  ${file}: ${stats.failedRuns}/${stats.totalRuns} failed runs`);
    }
  }
  if (intermittentTests.length > 0) {
    console.log('Intermittent tests:');
    for (const [key, stats] of intermittentTests) {
      const testName = key.split('::')[1];
      console.log(`  ${stats.file} :: ${testName}: ${stats.failedRuns}/${stats.totalRuns} failed runs`);
    }
  }
  return 'intermittent';
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const runRecords: RunRecord[] = [];

  for (let iteration = 1; iteration <= options.runs; iteration += 1) {
    process.stdout.write(`Running Vitest iteration ${iteration}/${options.runs}...\n`);
    runRecords.push(runVitest(iteration, options));
  }

  const heuristics = scanHeuristics(options);
  const assessment = printSummary(runRecords, heuristics);
  process.exitCode = assessment === 'clean' ? 0 : assessment === 'intermittent' ? 1 : 2;
}

main();
