#!/usr/bin/env node
// eval CLI — subcommand dispatch skeleton.
// Subcommands: extract (group B), score / baseline (group C).
// This module only provides command dispatch + shared scaffolding; the
// business logic for each subcommand is filled in by later groups.

import { basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extractFromHar } from './har.js';
import { loadCorpus } from './corpus.js';
import { renderReport, scoreCorpus, type Metrics } from './score.js';
import {
  DEFAULT_THRESHOLD,
  compareToBaseline,
  renderComparison,
  type Baseline,
} from './baseline.js';

type Subcommand = 'extract' | 'score' | 'baseline';

const SUBCOMMANDS: readonly Subcommand[] = ['extract', 'score', 'baseline'];

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.error(
    [
      'Usage: eval <command> [options]',
      '',
      'Commands:',
      '  extract    Build corpus from a HAR capture: eval extract <har> [--out <jsonl>]',
      '  score      Run the scoring harness: eval score <corpus.jsonl> [--baseline <baseline.json>] [--threshold <n>] [--out <metrics.json>]',
      '  baseline   Save current metrics as the regression baseline: eval baseline <corpus.jsonl> --out <baseline.json>',
    ].join('\n'),
  );
}

/**
 * `eval extract <har> [--out <jsonl>]`
 *
 * Parses a HAR capture, extracts Sam's product-list samples (deduped by spuId),
 * and writes JSONL corpus to stdout (or to `--out`). All diagnostics go to
 * stderr so the corpus stream on stdout stays clean.
 */
async function runExtract(args: string[]): Promise<void> {
  let harPath: string | undefined;
  let outPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--out' || arg === '-o') {
      outPath = args[++i];
      if (outPath === undefined) {
        // eslint-disable-next-line no-console
        console.error('eval extract: --out requires a path');
        process.exit(2);
      }
    } else if (harPath === undefined) {
      harPath = arg;
    } else {
      // eslint-disable-next-line no-console
      console.error(`eval extract: unexpected argument "${arg}"`);
      process.exit(2);
    }
  }

  if (!harPath) {
    // eslint-disable-next-line no-console
    console.error('Usage: eval extract <har> [--out <jsonl>]');
    process.exit(2);
  }

  const raw = readFileSync(harPath, 'utf8');
  let harJson: unknown;
  try {
    harJson = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`eval extract: HAR file is not valid JSON (${detail})`);
    process.exit(1);
  }

  const source = `har:${basename(harPath)}`;
  const result = extractFromHar(harJson, source);

  const jsonl = result.samples.map((s) => JSON.stringify(s)).join('\n');
  const output = jsonl === '' ? '' : `${jsonl}\n`;

  if (outPath) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(outPath, output, 'utf8');
  } else {
    process.stdout.write(output);
  }

  // eslint-disable-next-line no-console
  console.error(
    `eval extract: ${result.samples.length} sample(s), ` +
      `${result.noPrice} no-price, ${result.noUnitPrice} no-unit-price, ` +
      `${result.skippedBodies} skipped body(ies)`,
  );
}

/** Load + validate a corpus file path, exiting 2 on a load error. */
function loadCorpusFile(corpusPath: string): ReturnType<typeof loadCorpus> {
  const raw = readFileSync(corpusPath, 'utf8');
  return loadCorpus(raw);
}

/**
 * `eval score <corpus.jsonl> [--baseline <baseline.json>] [--threshold <n>]`
 *
 * Runs the harness, writes machine-readable metrics to stdout (or `--out`),
 * prints a human-readable summary + regression verdict to stderr. Exit code:
 * 0 = passed / no baseline; non-zero = regression detected.
 */
async function runScore(args: string[]): Promise<void> {
  let corpusPath: string | undefined;
  let baselinePath: string | undefined;
  let outPath: string | undefined;
  let threshold = DEFAULT_THRESHOLD;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--baseline' || arg === '-b') {
      baselinePath = args[++i];
      if (baselinePath === undefined) {
        console.error('eval score: --baseline requires a path');
        process.exit(2);
      }
    } else if (arg === '--threshold' || arg === '-t') {
      const v = args[++i];
      const n = v === undefined ? NaN : Number(v);
      if (!Number.isFinite(n) || n < 0) {
        console.error('eval score: --threshold requires a non-negative number');
        process.exit(2);
      }
      threshold = n;
    } else if (arg === '--out' || arg === '-o') {
      outPath = args[++i];
      if (outPath === undefined) {
        console.error('eval score: --out requires a path');
        process.exit(2);
      }
    } else if (corpusPath === undefined) {
      corpusPath = arg;
    } else {
      console.error(`eval score: unexpected argument "${arg}"`);
      process.exit(2);
    }
  }

  if (!corpusPath) {
    console.error('Usage: eval score <corpus.jsonl> [--baseline <baseline.json>] [--threshold <n>] [--out <metrics.json>]');
    process.exit(2);
  }

  const samples = loadCorpusFile(corpusPath);
  const metrics = await scoreCorpus(samples, { apiKey: process.env.OPENROUTER_API_KEY });

  // Machine-readable metrics → stdout (or --out file).
  const json = `${JSON.stringify(metrics, null, 2)}\n`;
  if (outPath) {
    writeFileSync(outPath, json, 'utf8');
  } else {
    process.stdout.write(json);
  }

  // Human-readable summary → stderr (keeps stdout clean for piping).
  console.error(renderReport(metrics));

  // Regression comparison.
  let baseline: Baseline | null = null;
  if (baselinePath) {
    if (existsSync(baselinePath)) {
      try {
        baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
      } catch (err) {
        console.error(`eval score: baseline is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
        process.exit(2);
      }
    } else {
      // Explicit --baseline pointing at a missing file: warn loudly (likely a CI
      // misconfiguration) but still treat as a first run (spec: missing = first run).
      console.error(`warning: baseline file not found: ${baselinePath}, treating as first run`);
    }
  }
  const comparison = compareToBaseline(metrics, baseline, threshold);
  console.error(renderComparison(comparison));

  // Exit code: regression → non-zero; first run / pass → 0.
  process.exit(comparison.regressions.length > 0 ? 1 : 0);
}

/**
 * `eval baseline <corpus.jsonl> --out <baseline.json>`
 *
 * Explicitly saves the current metrics snapshot as the regression baseline.
 */
async function runBaseline(args: string[]): Promise<void> {
  let corpusPath: string | undefined;
  let outPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--out' || arg === '-o') {
      outPath = args[++i];
      if (outPath === undefined) {
        console.error('eval baseline: --out requires a path');
        process.exit(2);
      }
    } else if (corpusPath === undefined) {
      corpusPath = arg;
    } else {
      console.error(`eval baseline: unexpected argument "${arg}"`);
      process.exit(2);
    }
  }

  if (!corpusPath || !outPath) {
    console.error('Usage: eval baseline <corpus.jsonl> --out <baseline.json>');
    process.exit(2);
  }

  const samples = loadCorpusFile(corpusPath);
  const metrics: Metrics = await scoreCorpus(samples, { apiKey: process.env.OPENROUTER_API_KEY });
  writeFileSync(outPath, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  console.error(`eval baseline: saved metrics for ${samples.length} sample(s) → ${outPath}`);
  console.error(renderReport(metrics));
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === '-h' || cmd === '--help') {
    printUsage();
    process.exit(cmd ? 0 : 2);
  }

  if (!isSubcommand(cmd)) {
    // eslint-disable-next-line no-console
    console.error(`eval: unknown command "${cmd}"`);
    printUsage();
    process.exit(2);
  }

  switch (cmd) {
    case 'extract':
      await runExtract(rest);
      break;
    case 'score':
      await runScore(rest);
      break;
    case 'baseline':
      await runBaseline(rest);
      break;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
