#!/usr/bin/env node
'use strict';

/**
 * Converts Swarm Phase D findings (confirmed + contested) into EVMBench detect submission format.
 *
 * Usage:
 *   node convert-swarm-submission.js --phase-d-dir <path> --output <path> [--dedupe-provider claude|gemini]
 *
 * Includes both confirmed and contested findings (contested = one validator confirmed,
 * one refuted — we should submit these since EVMBench agents submit everything they find).
 *
 * Input:  phase-d directory containing confirmed/ and contested/ subdirs
 * Output: EVMBench submission JSON
 *
 * Legacy flag --confirmed-dir still works (reads only confirmed).
 */

const fs = require('fs');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dedupeProvider: 'claude' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--phase-d-dir' && args[i + 1]) opts.phaseDDir = args[++i];
    else if (args[i] === '--confirmed-dir' && args[i + 1]) opts.confirmedDir = args[++i]; // legacy
    else if (args[i] === '--output' && args[i + 1]) opts.output = args[++i];
    else if (args[i] === '--dedupe-provider' && args[i + 1]) opts.dedupeProvider = args[++i];
  }
  if ((!opts.phaseDDir && !opts.confirmedDir) || !opts.output) {
    console.error('Usage: node convert-swarm-submission.js --phase-d-dir <path> --output <path> [--dedupe-provider claude|gemini]');
    process.exit(1);
  }
  return opts;
}

function parseLines(linesStr) {
  if (!linesStr) return { start: 0, end: 0 };
  const str = String(linesStr);
  const match = str.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (match) return { start: parseInt(match[1]), end: parseInt(match[2]) };
  const single = str.match(/(\d+)/);
  if (single) return { start: parseInt(single[1]), end: parseInt(single[1]) };
  return { start: 0, end: 0 };
}

function convertFinding(confirmed) {
  const hyp = confirmed.original_hypothesis || {};
  const val = confirmed.validation_result || {};

  const title = hyp.title || hyp.hypothesis_id || 'Unknown';
  const summary = hyp.hypothesis_description || '';
  const impact = val.impact_assessment || hyp.risk_level || '';
  const rootCause = val.root_cause_analysis || '';
  const technicalAnalysis = val.technical_analysis || '';

  // Build description entries from proof_of_signal and affected contracts
  const descriptions = [];
  const pos = hyp.proof_of_signal;
  if (pos && pos.file) {
    const lines = parseLines(pos.lines);
    descriptions.push({
      file: pos.file,
      line_start: lines.start,
      line_end: lines.end,
      desc: pos.pattern || summary
    });
  }

  // Add inventory refs as additional description entries if they add new locations
  const seenFiles = new Set(descriptions.map(d => d.file));
  const refs = hyp.inventory_refs || [];
  for (const ref of refs) {
    if (ref.file && !seenFiles.has(ref.file)) {
      seenFiles.add(ref.file);
      descriptions.push({
        file: ref.file,
        line_start: 0,
        line_end: 0,
        desc: `Affected function: ${ref.function || 'N/A'}`
      });
    }
  }

  // If no descriptions, use affected_contracts
  if (descriptions.length === 0) {
    const contracts = hyp.affected_contracts || [];
    for (const c of contracts) {
      descriptions.push({
        file: c,
        line_start: 0,
        line_end: 0,
        desc: summary.slice(0, 200)
      });
    }
  }

  // Build proof_of_concept from validation technical analysis
  let poc = '';
  if (technicalAnalysis) poc += technicalAnalysis;
  if (rootCause && rootCause !== technicalAnalysis) poc += '\n\n' + rootCause;

  // Build remediation from validation or hypothesis
  const remediation = val.remediation || val.recommendation || '';

  return {
    title,
    severity: 'high', // EVMBench only does high-severity detect
    summary: summary.slice(0, 500),
    description: descriptions,
    impact: typeof impact === 'string' ? impact : JSON.stringify(impact),
    proof_of_concept: poc || 'See technical analysis above.',
    remediation: remediation || 'N/A'
  };
}

function loadFindingsFromDir(dir, provider, label) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(`hypothesis-validation-${provider}-`) && f.endsWith('.json'))
    .sort((a, b) => {
      const numA = parseInt(a.match(/(\d+)\.json$/)?.[1] || '0');
      const numB = parseInt(b.match(/(\d+)\.json$/)?.[1] || '0');
      return numA - numB;
    });
  console.log(`  ${label}: ${files.length} ${provider} findings`);
  return files.map(f => ({ file: f, dir, label }));
}

async function main() {
  const opts = parseArgs();
  const outputPath = path.resolve(opts.output);

  // Collect findings from confirmed + contested (or legacy --confirmed-dir only)
  let allFiles = [];
  if (opts.phaseDDir) {
    const phaseDDir = path.resolve(opts.phaseDDir);
    console.log(`Loading findings from phase-d dir: ${phaseDDir}`);
    allFiles.push(...loadFindingsFromDir(path.join(phaseDDir, 'confirmed'), opts.dedupeProvider, 'confirmed'));
    allFiles.push(...loadFindingsFromDir(path.join(phaseDDir, 'contested'), opts.dedupeProvider, 'contested'));
  } else {
    const confirmedDir = path.resolve(opts.confirmedDir);
    if (!fs.existsSync(confirmedDir)) {
      console.error(`Confirmed dir not found: ${confirmedDir}`);
      process.exit(1);
    }
    allFiles.push(...loadFindingsFromDir(confirmedDir, opts.dedupeProvider, 'confirmed'));
  }

  console.log(`Total: ${allFiles.length} findings to convert`);

  const vulnerabilities = [];
  const seenTitles = new Set();

  for (const { file, dir, label } of allFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const converted = convertFinding(data);

    // Deduplicate by title (claude/gemini may have same finding)
    if (seenTitles.has(converted.title)) continue;
    seenTitles.add(converted.title);

    converted._source = label; // track where it came from
    vulnerabilities.push(converted);
  }

  const submission = { vulnerabilities };

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(submission, null, 2));

  const confirmedCount = vulnerabilities.filter(v => v._source === 'confirmed').length;
  const contestedCount = vulnerabilities.filter(v => v._source === 'contested').length;
  console.log(`\nConverted ${vulnerabilities.length} findings (${confirmedCount} confirmed + ${contestedCount} contested) → ${outputPath}`);
  console.log('Titles:');
  for (const v of vulnerabilities) {
    console.log(`  [${v._source}] ${v.title}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
