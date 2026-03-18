#!/usr/bin/env node
'use strict';

/**
 * Phase E: Agentic Deep Dive
 *
 * Runs a Claude agent with full Swarm artifacts + codebase access to find
 * vulnerabilities that Swarm's structured pipeline missed. Targets integration
 * boundary exploits and math precision issues.
 *
 * Prompt template: ../prompts/phase-e-prompt.txt
 *
 * Usage:
 *   node phase-e-agent.js --contest <id> [--max-turns 200] [--model claude-opus-4-6]
 *
 * Example:
 *   node phase-e-agent.js --contest 2024-01-renft
 *   node phase-e-agent.js --contest 2024-01-renft --max-turns 100 --dry-run
 */

const fs = require('fs');
const path = require('path');

// Load environment variables
// Note: automata/performance/ is a symlink → ~/performance/, so __dirname resolves
// outside the automata repo. We find .env via the symlink-aware automata root.
const AUTOMATA_ROOT = path.resolve(__dirname, '..', '..', '..', '..'); // evmbench → swarm-bench → performance → automata (via symlink)
const AUTOMATA_ENV = path.join(AUTOMATA_ROOT, '.env');
// When running via symlink, AUTOMATA_ROOT resolves to ~/performance/../../ = ~/
// So also check the known canonical location
const ENV_CANDIDATES = [
  AUTOMATA_ENV,
  path.join(path.dirname(process.env.HOME || '/'), path.basename(process.env.HOME || ''), 'automata', '.env'),
];
const envPath = ENV_CANDIDATES.find(p => fs.existsSync(p));
if (envPath) {
  require('dotenv').config({ path: envPath });
} else {
  console.warn('⚠️  No .env file found. Set ANTHROPIC_API_KEY or CLAUDE_API_KEY in environment.');
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const EVMBENCH_ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(EVMBENCH_ROOT, 'runs');
const REPOS_DIR = path.join(EVMBENCH_ROOT, 'repos');
const SUBMISSIONS_DIR = path.join(EVMBENCH_ROOT, 'submissions');
const PROMPT_TEMPLATE_PATH = path.join(EVMBENCH_ROOT, 'prompts', 'phase-e-prompt.txt');

// ─── Claude Agent SDK (dynamic import — ES module) ──────────────────────────

let queryFn = null;
async function loadSDK() {
  if (!queryFn) {
    if (process.env.CLAUDE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = process.env.CLAUDE_API_KEY;
    }
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      queryFn = sdk.query;
    } catch (error) {
      console.error('❌ Failed to load Claude Agent SDK');
      console.error('   npm install @anthropic-ai/claude-agent-sdk');
      process.exit(1);
    }
  }
  return queryFn;
}

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    maxTurns: 500,           // High ceiling — wall-clock timeout is the real bound
    timeoutMinutes: 90,      // Default: 90 minutes wall-clock
    model: 'claude-opus-4-6',
    maxThinkingTokens: 10000,
    dryRun: false
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--contest' && args[i + 1]) opts.contest = args[++i];
    else if (args[i] === '--max-turns' && args[i + 1]) opts.maxTurns = parseInt(args[++i]);
    else if (args[i] === '--timeout' && args[i + 1]) opts.timeoutMinutes = parseInt(args[++i]);
    else if (args[i] === '--model' && args[i + 1]) opts.model = args[++i];
    else if (args[i] === '--max-thinking-tokens' && args[i + 1]) opts.maxThinkingTokens = parseInt(args[++i]);
    else if (args[i] === '--dry-run') opts.dryRun = true;
  }
  if (!opts.contest) {
    console.error('Usage: node phase-e-agent.js --contest <id> [--timeout 90] [--model claude-opus-4-6] [--dry-run]');
    process.exit(1);
  }
  return opts;
}

// ─── Artifact Loading ────────────────────────────────────────────────────────

function loadArtifacts(contestId) {
  const runDir = path.join(RUNS_DIR, contestId);
  const repoDir = path.join(REPOS_DIR, contestId);

  if (!fs.existsSync(runDir)) {
    console.error(`❌ Run directory not found: ${runDir}`);
    process.exit(1);
  }
  if (!fs.existsSync(repoDir)) {
    console.error(`❌ Repo directory not found: ${repoDir}`);
    process.exit(1);
  }

  // ── Phase A analysis file paths (agent reads these via tools) ──
  // For multi-cluster contests, load Phase A from ALL cluster dirs (C01, C02, ...)
  const phaseAFileNames = [
    'phase-a-architecture-analysis.json',
    'phase-a-security-analysis.json',
    'phase-a-logic-analysis.json',
    'phase-a-invariant-state-analysis.json',
    'phase-a-invariant-economic-analysis.json'
  ];
  // Discover cluster dirs (C01, C02, C03, ...)
  const clusterDirs = fs.readdirSync(runDir)
    .filter(d => /^C\d+$/.test(d))
    .sort()
    .map(d => path.join(runDir, d));
  const phaseASearchDirs = clusterDirs.length > 0 ? clusterDirs : [runDir];
  const phaseAFiles = [];
  for (const dir of phaseASearchDirs) {
    for (const f of phaseAFileNames) {
      const fp = path.join(dir, f);
      if (fs.existsSync(fp)) phaseAFiles.push(fp);
    }
  }

  // ── Phase D confirmed findings (for exclusion list in prompt) ──
  // Multi-cluster contests use phase-d-combined/ instead of phase-d/
  let phaseDDir = path.join(runDir, 'phase-d');
  if (!fs.existsSync(phaseDDir) && fs.existsSync(path.join(runDir, 'phase-d-combined'))) {
    phaseDDir = path.join(runDir, 'phase-d-combined');
  }
  const confirmed = loadValidationDir(path.join(phaseDDir, 'confirmed'));
  const contested = loadValidationDir(path.join(phaseDDir, 'contested'));
  const refuted = loadValidationDir(path.join(phaseDDir, 'refuted'));

  // ── Validation summary ──
  const validationSummary = safeReadJSON(path.join(runDir, 'phase-d-validation-summary.json'));

  return {
    runDir,
    repoDir,
    phaseAFiles,
    confirmed,
    contested,
    refuted,
    validationSummary
  };
}

function safeReadJSON(fp) {
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return null; }
}

function loadValidationDir(dir) {
  if (!fs.existsSync(dir)) return [];
  // Dedupe by hypothesis index — take claude version (richer analysis typically)
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('hypothesis-validation-claude-') && f.endsWith('.json'))
    .sort((a, b) => {
      const numA = parseInt(a.match(/(\d+)\.json$/)?.[1] || '0');
      const numB = parseInt(b.match(/(\d+)\.json$/)?.[1] || '0');
      return numA - numB;
    });
  return files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// ─── Prompt Building ─────────────────────────────────────────────────────────

function buildPrompt(artifacts) {
  const { runDir, repoDir, confirmed, contested, refuted, phaseAFiles } = artifacts;

  // Load template
  if (!fs.existsSync(PROMPT_TEMPLATE_PATH)) {
    console.error(`❌ Prompt template not found: ${PROMPT_TEMPLATE_PATH}`);
    process.exit(1);
  }
  let template = fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8');

  // ── Confirmed + contested finding titles (exclusion list) ──
  // We submit both confirmed and contested, so agent should not re-report either
  const allSubmitted = [...confirmed, ...contested];
  const confirmedTitles = allSubmitted.map((c, i) => {
    const hyp = c.original_hypothesis || {};
    return `  ${i + 1}. [${hyp.hypothesis_id || '?'}] ${hyp.title || 'Untitled'}`;
  }).join('\n');

  // ── Stats ──
  const totalHypotheses = confirmed.length + refuted.length + contested.length;
  const stats = `${totalHypotheses} hypotheses analyzed: ${confirmed.length} confirmed, ${refuted.length} refuted, ${contested.length} contested`;

  // ── Phase A file paths (for the agent to read via tools) ──
  const phaseAFileList = phaseAFiles
    .map(fp => `- ${fp}`)
    .join('\n');

  // ── Findings output path ──
  const findingsPath = path.join(runDir, 'phase-e-findings.json');

  // ── Substitute template variables ──
  template = template
    .replace(/\{\{STATS\}\}/g, stats)
    .replace(/\{\{PHASE_A_FILES\}\}/g, phaseAFileList)
    .replace(/\{\{REPO_DIR\}\}/g, repoDir)
    .replace(/\{\{RUN_DIR\}\}/g, runDir)
    .replace(/\{\{CONFIRMED_COUNT\}\}/g, String(allSubmitted.length))
    .replace(/\{\{CONFIRMED_TITLES\}\}/g, confirmedTitles)
    .replace(/\{\{FINDINGS_PATH\}\}/g, findingsPath);

  return template;
}

// ─── Convert Phase E findings to EVMBench submission format ──────────────────

function convertPhaseEToSubmission(phaseEFindings) {
  if (!phaseEFindings || !phaseEFindings.findings) return [];

  return phaseEFindings.findings.map(f => {
    const descriptions = [];
    if (f.root_cause && f.root_cause.file) {
      const lines = parseLines(f.root_cause.lines);
      descriptions.push({
        file: f.root_cause.file,
        line_start: lines.start,
        line_end: lines.end,
        desc: f.root_cause.mechanism || f.description
      });
    }

    return {
      title: f.title,
      severity: 'high',
      summary: (f.description || '').slice(0, 500),
      description: descriptions,
      impact: f.impact || '',
      proof_of_concept: f.attack_scenario || f.description || '',
      remediation: f.recommended_fix || 'N/A'
    };
  });
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const startTime = Date.now();

  console.log(`\n🔬 Phase E: Agentic Deep Dive`);
  console.log(`   Contest: ${opts.contest}`);
  console.log(`   Model: ${opts.model}`);
  console.log(`   Timeout: ${opts.timeoutMinutes} minutes`);
  console.log(`   Max turns: ${opts.maxTurns} (safety ceiling)`);
  console.log('');

  // Load artifacts
  console.log('📂 Loading Swarm artifacts...');
  const artifacts = loadArtifacts(opts.contest);
  console.log(`   ✓ Phase A: ${artifacts.phaseAFiles.length} analyses`);
  console.log(`   ✓ Phase D: ${artifacts.confirmed.length} confirmed, ${artifacts.refuted.length} refuted, ${artifacts.contested.length} contested`);
  console.log(`   ✓ Exclusion list: ${artifacts.confirmed.length + artifacts.contested.length} findings (confirmed + contested)`);
  console.log(`   ✓ Codebase: ${artifacts.repoDir}`);
  console.log('');

  // Build prompt
  console.log('📝 Building agent prompt...');
  const prompt = buildPrompt(artifacts);
  console.log(`   ✓ Prompt length: ${prompt.length} chars`);
  console.log('');

  // Always save the generated prompt for post-run inspection
  const promptPath = path.join(artifacts.runDir, 'phase-e-prompt.txt');
  fs.writeFileSync(promptPath, prompt);
  console.log(`   ✓ Prompt saved to: ${promptPath}`);

  if (opts.dryRun) {
    console.log(`🏃 Dry run — review the prompt, then run without --dry-run to execute.`);
    return;
  }

  // Load SDK and run agent
  console.log(`🚀 Launching Claude agent (${opts.timeoutMinutes}m timeout)...`);
  const query = await loadSDK();

  // ── Shared post-run logic (used by both normal completion and timeout) ──
  const findingsPath = path.join(artifacts.runDir, 'phase-e-findings.json');

  function finishRun(terminationReason) {
    // Read the findings file the agent should have written incrementally
    if (fs.existsSync(findingsPath)) {
      const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
      const count = findings.findings?.length || 0;
      console.log(`\n📊 Phase E Results: ${count} new findings`);

      if (count > 0) {
        for (const f of findings.findings) {
          console.log(`   • [${f.severity}] ${f.title} (${f.source})`);
        }

        // Write Phase E findings as separate submission (merged with Swarm at grading time)
        const submDir = path.join(SUBMISSIONS_DIR, opts.contest);
        const phaseEVulns = convertPhaseEToSubmission(findings);
        const phaseESubmission = { vulnerabilities: phaseEVulns };
        const phaseEPath = path.join(submDir, 'phase-e.json');
        fs.mkdirSync(submDir, { recursive: true });
        fs.writeFileSync(phaseEPath, JSON.stringify(phaseESubmission, null, 2));
        console.log(`\n📦 Phase E submission: ${phaseEPath} (${phaseEVulns.length} findings)`);
        const auditPath = path.join(submDir, 'audit.json');
        const combinedOutput = path.join(submDir, 'audit-graded-combined.json');
        console.log(`\n   Grade combined (Swarm + Phase E) with:`);
        console.log(`   node grade-detect.js --submission ${auditPath} --phase-e ${phaseEPath} --task-dir <task-dir> --output ${combinedOutput}`);
      }

      // Save timing metadata
      const timing = {
        phase: 'E',
        contestId: opts.contest,
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        durationMinutes: +((Date.now() - startTime) / 60000).toFixed(1),
        model: opts.model,
        timeoutMinutes: opts.timeoutMinutes,
        terminationReason: terminationReason,
        toolCalls: toolCalls,
        costUsd: result?.total_cost_usd || 0,
        actualTurns: result?.num_turns || 0,
        findingsCount: count
      };
      fs.writeFileSync(
        path.join(artifacts.runDir, 'phase-e-timing.json'),
        JSON.stringify(timing, null, 2)
      );
    } else {
      console.log('\n⚠️  Agent did not write findings file.');
    }
    console.log('\nDone.');
  }

  // ── Wall-clock timeout (primary bound, same approach as EVMBench competition) ──
  const timeoutMs = opts.timeoutMinutes * 60 * 1000;
  const timeoutTimer = setTimeout(() => {
    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    console.log(`\n⏰ Timeout reached (${elapsed}m / ${opts.timeoutMinutes}m). Terminating agent.`);
    finishRun('timeout');
    process.exit(0);
  }, timeoutMs);
  timeoutTimer.unref();

  // ── Run the agent ──
  let messageCount = 0;
  let toolCalls = 0;
  let result = null;

  for await (const message of query({
    prompt: prompt,
    options: {
      model: opts.model,
      maxThinkingTokens: opts.maxThinkingTokens,
      maxTurns: opts.maxTurns,
      cwd: artifacts.repoDir,
      allowedTools: ['Read', 'Bash', 'Grep', 'Glob', 'Write', 'Edit'],
      persistSession: false
    }
  })) {
    messageCount++;

    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          toolCalls++;
          const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
          // Detailed tool logging
          let detail = '';
          if (block.input?.file_path) detail = ` → ${block.input.file_path}`;
          else if (block.input?.pattern && block.input?.path) detail = ` → "${block.input.pattern.slice(0, 50)}" in ${path.basename(block.input.path)}`;
          else if (block.input?.pattern) detail = ` → "${block.input.pattern.slice(0, 50)}"`;
          else if (block.input?.command) detail = ` → ${block.input.command.slice(0, 80)}`;
          else if (block.input?.content) detail = ` → (${block.input.content.length} chars)`;
          console.log(`   [${elapsed}m] Tool #${toolCalls}: ${block.name}${detail}`);
        } else if (block.type === 'text' && block.text) {
          // Log assistant reasoning — show enough to follow along
          const text = block.text.trim();
          if (text.length > 0) {
            const preview = text.length > 500 ? text.slice(0, 500) + '...' : text;
            console.log(`   [${((Date.now() - startTime) / 60000).toFixed(1)}m] 💬 ${preview}`);
          }
        }
      }
    } else if (message.type === 'result' && !result) {
      // Only capture the first result message (SDK sometimes emits a zeroed duplicate)
      result = message;
      const duration = Date.now() - startTime;
      const costUsd = message.total_cost_usd || 0;
      const turns = message.num_turns || 0;

      console.log('');
      console.log(`✅ Agent completed naturally`);
      console.log(`   Duration: ${(duration / 60000).toFixed(1)} minutes`);
      console.log(`   Turns: ${turns}`);
      console.log(`   Tool calls: ${toolCalls}`);
      console.log(`   Cost: $${costUsd.toFixed(2)}`);
    }
  }

  clearTimeout(timeoutTimer);
  finishRun('completed');
}

main().catch(err => {
  // SDK v0.1.77 throws when the underlying claude CLI exits with non-zero code
  // even after successfully yielding all results. Write timing data before exiting.
  console.error('❌ Fatal error:', err.message);
  // Attempt to write timing even on crash (finishRun may not have run)
  try {
    const opts = parseArgs();
    const artifacts = loadArtifacts(opts.contest);
    const findingsPath = path.join(artifacts.runDir, 'phase-e-findings.json');
    if (fs.existsSync(findingsPath)) {
      const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
      const count = findings.findings?.length || 0;
      console.log(`   (Crash recovery: ${count} findings preserved in findings file)`);
    }
  } catch (_) { /* best effort */ }
  process.exit(1);
});
