#!/usr/bin/env node
'use strict';

/**
 * Aggregates graded EVMBench results across all contests into a summary table.
 *
 * Usage:
 *   node aggregate-results.js --submissions-dir <path> [--output <path>]
 *
 * Reads *-graded.json files from each contest subdirectory.
 * Produces a summary table and total score.
 */

const fs = require('fs');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--submissions-dir' && args[i + 1]) opts.submissionsDir = args[++i];
    else if (args[i] === '--output' && args[i + 1]) opts.output = args[++i];
  }
  if (!opts.submissionsDir) {
    console.error('Usage: node aggregate-results.js --submissions-dir <path> [--output <path>]');
    process.exit(1);
  }
  return opts;
}

function main() {
  const opts = parseArgs();
  const submDir = path.resolve(opts.submissionsDir);

  const contests = fs.readdirSync(submDir).filter(d => {
    const full = path.join(submDir, d);
    return fs.statSync(full).isDirectory();
  }).sort();

  let totalAward = 0;
  let totalMaxAward = 0;
  let totalDetected = 0;
  let totalVulns = 0;
  const rows = [];

  for (const contest of contests) {
    const gradedFile = path.join(submDir, contest, 'audit-graded.json');
    if (!fs.existsSync(gradedFile)) {
      rows.push({ contest, status: 'NOT GRADED', detected: '-', maxDetectable: '-', award: '-', maxAward: '-', pct: '-' });
      continue;
    }

    const data = JSON.parse(fs.readFileSync(gradedFile, 'utf8'));
    totalAward += data.totalAward || 0;
    totalMaxAward += data.maxAward || 0;
    totalDetected += data.detected || 0;
    totalVulns += data.maxDetectable || 0;

    rows.push({
      contest,
      status: 'GRADED',
      detected: data.detected,
      maxDetectable: data.maxDetectable,
      award: `$${(data.totalAward || 0).toFixed(2)}`,
      maxAward: `$${(data.maxAward || 0).toFixed(2)}`,
      pct: `${(data.scorePercent || 0).toFixed(1)}%`
    });
  }

  // Print table
  console.log('EVMBench Aggregate Results');
  console.log('='.repeat(90));
  console.log(
    'Contest'.padEnd(40) +
    'Det'.padStart(5) +
    'Max'.padStart(5) +
    'Award'.padStart(12) +
    'Max Award'.padStart(12) +
    'Score'.padStart(8)
  );
  console.log('-'.repeat(90));

  for (const r of rows) {
    if (r.status === 'NOT GRADED') {
      console.log(`${r.contest.padEnd(40)}  — not graded —`);
    } else {
      console.log(
        r.contest.padEnd(40) +
        String(r.detected).padStart(5) +
        String(r.maxDetectable).padStart(5) +
        r.award.padStart(12) +
        r.maxAward.padStart(12) +
        r.pct.padStart(8)
      );
    }
  }

  console.log('-'.repeat(90));
  const totalPct = totalMaxAward > 0 ? ((totalAward / totalMaxAward) * 100).toFixed(1) : '0.0';
  console.log(
    'TOTAL'.padEnd(40) +
    String(totalDetected).padStart(5) +
    String(totalVulns).padStart(5) +
    `$${totalAward.toFixed(2)}`.padStart(12) +
    `$${totalMaxAward.toFixed(2)}`.padStart(12) +
    `${totalPct}%`.padStart(8)
  );

  const countPct = totalVulns > 0 ? ((totalDetected / totalVulns) * 100).toFixed(1) : '0.0';

  console.log(`\nSwarm (dollar-weighted): ${totalPct}% ($${totalAward.toFixed(2)} / $${totalMaxAward.toFixed(2)})`);
  console.log(`Swarm (count-based):     ${countPct}% (${totalDetected} / ${totalVulns} vulns)`);
  console.log(`Graded: ${rows.filter(r => r.status === 'GRADED').length} / ${contests.length} contests`);

  // Save
  const outputPath = opts.output || path.join(submDir, 'aggregate-summary.json');
  const gradedRows = rows.filter(r => r.status === 'GRADED');
  const summary = {
    dollarWeightedPercent: parseFloat(totalPct),
    countBasedPercent: parseFloat(countPct),
    totalDetected,
    totalVulns,
    totalAward,
    totalMaxAward,
    gradedContests: gradedRows.length,
    totalContests: contests.length,
    judgeModel: 'gpt-5',
    judgeReasoningEffort: 'high',
    findingsIncluded: 'confirmed + contested',
    results: rows
  };
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  console.log(`\nSaved to: ${outputPath}`);
}

main();
