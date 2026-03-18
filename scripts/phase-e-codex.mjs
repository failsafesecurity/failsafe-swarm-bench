#!/usr/bin/env node

/**
 * Phase E: Agentic Deep Dive — OpenAI Codex 5.3 Edition
 *
 * Mirror of phase-e-agent.js but uses @openai/codex-sdk instead of
 * Claude Agent SDK. Codex SDK provides built-in file read, shell exec,
 * and file write — no custom tool definitions needed.
 *
 * Usage:
 *   node phase-e-codex.mjs --contest <id> [--timeout 90] [--reasoning xhigh] [--dry-run]
 *
 * Example:
 *   node phase-e-codex.mjs --contest 2024-04-noya
 *   node phase-e-codex.mjs --contest 2024-04-noya --timeout 120 --reasoning high
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve packages from the automata root node_modules (symlink-safe)
const AUTOMATA_ROOT_REAL = path.join(process.env.HOME, 'automata');
const codexPkg = path.join(AUTOMATA_ROOT_REAL, 'node_modules', '@openai', 'codex-sdk', 'dist', 'index.js');
const { Codex } = await import(pathToFileURL(codexPkg).href);

// ─── .env loading ───────────────────────────────────────────────────────────
// Same symlink-aware logic as phase-e-agent.js
const AUTOMATA_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ENV_CANDIDATES = [
  path.join(AUTOMATA_ROOT, '.env'),
  path.join(path.dirname(process.env.HOME || '/'), path.basename(process.env.HOME || ''), 'automata', '.env'),
];
const envPath = ENV_CANDIDATES.find(p => fs.existsSync(p));
if (envPath) {
  const dotenv = await import('dotenv');
  dotenv.config({ path: envPath });
}
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not set in .env or environment');
  process.exit(1);
}

// ─── Paths ──────────────────────────────────────────────────────────────────
const EVMBENCH_ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(EVMBENCH_ROOT, 'runs');
const REPOS_DIR = path.join(EVMBENCH_ROOT, 'repos');
const SUBMISSIONS_DIR = path.join(EVMBENCH_ROOT, 'submissions');
const PROMPT_TEMPLATE_PATH = path.join(EVMBENCH_ROOT, 'prompts', 'phase-e-prompt.txt');

// ─── CLI Parsing ────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    timeoutMinutes: 90,
    reasoning: 'xhigh',
    model: 'gpt-5.3-codex',
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--contest' && args[i + 1]) opts.contest = args[++i];
    else if (args[i] === '--timeout' && args[i + 1]) opts.timeoutMinutes = parseInt(args[++i]);
    else if (args[i] === '--reasoning' && args[i + 1]) opts.reasoning = args[++i];
    else if (args[i] === '--model' && args[i + 1]) opts.model = args[++i];
    else if (args[i] === '--dry-run') opts.dryRun = true;
  }
  if (!opts.contest) {
    console.error('Usage: node phase-e-codex.mjs --contest <id> [--timeout 90] [--reasoning xhigh] [--dry-run]');
    process.exit(1);
  }
  return opts;
}

// ─── Artifact Loading (reused from phase-e-agent.js) ────────────────────────
function loadArtifacts(contestId) {
  const runDir = path.join(RUNS_DIR, contestId);
  const repoDir = path.join(REPOS_DIR, contestId);

  if (!fs.existsSync(runDir)) { console.error(`❌ Run directory not found: ${runDir}`); process.exit(1); }
  if (!fs.existsSync(repoDir)) { console.error(`❌ Repo directory not found: ${repoDir}`); process.exit(1); }

  const phaseAFileNames = [
    'phase-a-architecture-analysis.json',
    'phase-a-security-analysis.json',
    'phase-a-logic-analysis.json',
    'phase-a-invariant-state-analysis.json',
    'phase-a-invariant-economic-analysis.json',
  ];
  const clusterDirs = fs.readdirSync(runDir)
    .filter(d => /^C\d+$/.test(d)).sort()
    .map(d => path.join(runDir, d));
  const phaseASearchDirs = clusterDirs.length > 0 ? clusterDirs : [runDir];
  const phaseAFiles = [];
  for (const dir of phaseASearchDirs) {
    for (const f of phaseAFileNames) {
      const fp = path.join(dir, f);
      if (fs.existsSync(fp)) phaseAFiles.push(fp);
    }
  }

  let phaseDDir = path.join(runDir, 'phase-d');
  if (!fs.existsSync(phaseDDir) && fs.existsSync(path.join(runDir, 'phase-d-combined'))) {
    phaseDDir = path.join(runDir, 'phase-d-combined');
  }
  const confirmed = loadValidationDir(path.join(phaseDDir, 'confirmed'));
  const contested = loadValidationDir(path.join(phaseDDir, 'contested'));
  const refuted = loadValidationDir(path.join(phaseDDir, 'refuted'));
  const validationSummary = safeReadJSON(path.join(runDir, 'phase-d-validation-summary.json'));

  return { runDir, repoDir, phaseAFiles, confirmed, contested, refuted, validationSummary };
}

function safeReadJSON(fp) {
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function loadValidationDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('hypothesis-validation-claude-') && f.endsWith('.json'))
    .sort((a, b) => {
      const numA = parseInt(a.match(/(\d+)\.json$/)?.[1] || '0');
      const numB = parseInt(b.match(/(\d+)\.json$/)?.[1] || '0');
      return numA - numB;
    });
  return files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// ─── Prompt Building ────────────────────────────────────────────────────────
function buildConfirmedDetails(allSubmitted) {
  return allSubmitted.map((c, i) => {
    const hyp = c.original_hypothesis || {};

    const id = hyp.hypothesis_id || '?';
    const title = hyp.title || 'Untitled';
    const contracts = (hyp.affected_contracts || []).join(', ') || 'Unknown';
    const functions = (hyp.affected_functions || []).join(', ');
    const description = hyp.hypothesis_description || '';
    const signal = hyp.proof_of_signal || {};
    const signalFile = signal.file || '';
    const signalLines = signal.lines || '';
    const signalPattern = signal.pattern || '';

    let detail = `### ${i + 1}. [${id}] ${title}\n`;
    detail += `- **Contracts**: ${contracts}\n`;
    if (functions) detail += `- **Functions**: ${functions}\n`;
    if (signalFile) detail += `- **Location**: ${signalFile}${signalLines ? ' lines ' + signalLines : ''}\n`;
    if (description) detail += `- **Description**: ${description.slice(0, 800)}\n`;
    if (signalPattern) detail += `- **Code pattern**: ${signalPattern.slice(0, 400)}\n`;

    return detail;
  }).join('\n');
}

function buildPrompt(artifacts, contestId) {
  const { runDir, repoDir, phaseAFiles, confirmed, contested, refuted } = artifacts;

  if (!fs.existsSync(PROMPT_TEMPLATE_PATH)) {
    console.error(`❌ Prompt template not found: ${PROMPT_TEMPLATE_PATH}`);
    process.exit(1);
  }
  let template = fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8');

  const allSubmitted = [...confirmed, ...contested];

  // ── Build exclusion list: Swarm findings + Claude Phase E findings ──
  const confirmedTitles = allSubmitted.map((c, i) => {
    const hyp = c.original_hypothesis || {};
    return `  ${i + 1}. [${hyp.hypothesis_id || '?'}] ${hyp.title || 'Untitled'}`;
  });

  // Also exclude Claude Phase E findings so Codex doesn't rediscover them
  const claudePEPath = path.join(SUBMISSIONS_DIR, contestId, 'phase-e.json');
  let claudePECount = 0;
  if (fs.existsSync(claudePEPath)) {
    try {
      const claudePE = JSON.parse(fs.readFileSync(claudePEPath, 'utf8'));
      const vulns = claudePE.vulnerabilities || [];
      for (const v of vulns) {
        confirmedTitles.push(`  ${confirmedTitles.length + 1}. [Phase-E-Claude] ${v.title}`);
        claudePECount++;
      }
    } catch (e) { /* ignore parse errors */ }
  }
  if (claudePECount > 0) {
    console.log(`   ✓ Added ${claudePECount} Claude Phase E findings to exclusion list`);
  }

  const totalExcluded = allSubmitted.length + claudePECount;

  // Phase A file listing
  const phaseAListing = phaseAFiles.length > 0
    ? phaseAFiles.map(f => `- ${f}`).join('\n')
    : '(No Phase A files found — explore the codebase directly)';

  // Stats line (used by original Claude prompt)
  const totalHypotheses = confirmed.length + refuted.length + contested.length;
  const stats = `${totalHypotheses} hypotheses analyzed: ${confirmed.length} confirmed, ${refuted.length} refuted, ${contested.length} contested`;

  // Full confirmed details (used by v2/v3 prompts, harmless if unused)
  const confirmedDetails = buildConfirmedDetails(allSubmitted);

  // IMPORTANT: Codex sandbox (workspace-write) can only write inside repoDir.
  // Point findings path there; post-run logic copies to runDir.
  const findingsPath = path.join(repoDir, 'phase-e-codex-findings.json');

  // Use function replacements to avoid $-backreference issues in descriptions
  const vars = {
    '{{REPO_DIR}}': repoDir,
    '{{RUN_DIR}}': runDir,
    '{{STATS}}': stats,
    '{{CONFIRMED_COUNT}}': String(totalExcluded),
    '{{CONFIRMED_TITLES}}': confirmedTitles.join('\n'),
    '{{CONFIRMED_DETAILS}}': confirmedDetails,
    '{{PHASE_A_FILES}}': phaseAListing,
    '{{FINDINGS_PATH}}': findingsPath,
  };
  for (const [key, val] of Object.entries(vars)) {
    template = template.split(key).join(val);
  }

  return template;
}

// ─── Convert findings to EVMBench submission format ─────────────────────────
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
        desc: f.root_cause.mechanism || f.description,
      });
    }
    return {
      title: f.title,
      severity: 'high',
      summary: (f.description || '').slice(0, 500),
      description: descriptions,
      impact: f.impact || '',
      proof_of_concept: f.attack_scenario || f.description || '',
      remediation: f.recommended_fix || 'N/A',
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

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  const startTime = Date.now();

  console.log(`\n🔬 Phase E: Agentic Deep Dive (Codex 5.3)`);
  console.log(`   Contest: ${opts.contest}`);
  console.log(`   Model: ${opts.model}`);
  console.log(`   Reasoning: ${opts.reasoning}`);
  console.log(`   Timeout: ${opts.timeoutMinutes} minutes`);
  console.log('');

  // Load artifacts
  console.log('📂 Loading Swarm artifacts...');
  const artifacts = loadArtifacts(opts.contest);
  console.log(`   ✓ Phase A: ${artifacts.phaseAFiles.length} analyses`);
  console.log(`   ✓ Phase D: ${artifacts.confirmed.length} confirmed, ${artifacts.refuted.length} refuted, ${artifacts.contested.length} contested`);
  console.log(`   ✓ Exclusion list: ${artifacts.confirmed.length + artifacts.contested.length} findings`);
  console.log(`   ✓ Codebase: ${artifacts.repoDir}`);
  console.log('');

  // Build prompt
  console.log('📝 Building agent prompt...');
  const prompt = buildPrompt(artifacts, opts.contest);
  console.log(`   ✓ Prompt length: ${prompt.length} chars`);

  // Save prompt for inspection
  const promptPath = path.join(artifacts.runDir, 'phase-e-codex-prompt.txt');
  fs.writeFileSync(promptPath, prompt);
  console.log(`   ✓ Prompt saved to: ${promptPath}`);
  console.log('');

  if (opts.dryRun) {
    console.log('🏃 Dry run — review the prompt, then run without --dry-run to execute.');
    return;
  }

  // ── Metrics ──
  const metrics = {
    threadId: null,
    toolCalls: 0,
    reasoning: 0,
    fileChanges: 0,
    messages: 0,
    usage: null,
  };

  // ── Create Codex instance and thread ──
  console.log(`🚀 Launching Codex agent (${opts.timeoutMinutes}m timeout)...`);
  console.log('');

  const codex = new Codex({ apiKey: process.env.OPENAI_API_KEY });

  const thread = codex.startThread({
    model: opts.model,
    workingDirectory: artifacts.repoDir,
    skipGitRepoCheck: true,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    modelReasoningEffort: opts.reasoning,
    webSearchMode: 'disabled',
    networkAccessEnabled: false,
  });

  // ── Timeout via AbortController (only way to limit Codex execution) ──
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMinutes * 60 * 1000;
  const timeoutTimer = setTimeout(() => {
    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    console.log(`\n⏰ Timeout reached (${elapsed}m / ${opts.timeoutMinutes}m). Aborting agent.`);
    controller.abort();
  }, timeoutMs);

  try {
    const { events } = await thread.runStreamed(prompt, {
      signal: controller.signal,
    });

    for await (const event of events) {
      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);

      switch (event.type) {
        case 'thread.started':
          metrics.threadId = event.thread_id;
          console.log(`   [${elapsed}m] Thread: ${event.thread_id}`);
          break;

        case 'turn.started':
          break;

        case 'turn.completed':
          metrics.usage = event.usage;
          break;

        case 'turn.failed':
          console.log(`   [${elapsed}m] ❌ Turn failed: ${event.error?.message}`);
          break;

        case 'item.started':
          if (event.item?.type === 'command_execution') {
            metrics.toolCalls++;
            console.log(`   [${elapsed}m] 🖥️  Shell #${metrics.toolCalls}: ${event.item.command}`);
          } else if (event.item?.type === 'reasoning') {
            metrics.reasoning++;
          }
          break;

        case 'item.completed':
          if (event.item?.type === 'reasoning') {
            const text = event.item.text || '';
            const preview = text.length > 200 ? text.substring(0, 200) + '...' : text;
            console.log(`   [${elapsed}m] 🧠 ${preview}`);
          } else if (event.item?.type === 'file_change') {
            metrics.fileChanges++;
            const changes = event.item.changes || [];
            for (const c of changes) {
              console.log(`   [${elapsed}m] 📄 ${c.kind}: ${c.path}`);
            }
          } else if (event.item?.type === 'agent_message') {
            metrics.messages++;
            const text = event.item.text || '';
            const preview = text.length > 300 ? text.substring(0, 300) + '...' : text;
            console.log(`   [${elapsed}m] 💬 ${preview}`);
          } else if (event.item?.type === 'command_execution') {
            if (event.item.exit_code !== 0) {
              console.log(`   [${elapsed}m] ❌ Exit ${event.item.exit_code}`);
            }
          }
          break;

        case 'error':
          console.log(`   [${elapsed}m] ❌ Error: ${event.message}`);
          break;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('   Agent aborted due to timeout.');
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeoutTimer);
  }

  const durationMs = Date.now() - startTime;
  const terminationReason = controller.signal.aborted ? 'timeout' : 'completed';

  // ── Results ──
  console.log('');
  console.log(`✅ Agent ${terminationReason}`);
  console.log(`   Duration: ${(durationMs / 60000).toFixed(1)} minutes`);
  console.log(`   Shell commands: ${metrics.toolCalls}`);
  console.log(`   Reasoning blocks: ${metrics.reasoning}`);
  console.log(`   File changes: ${metrics.fileChanges}`);

  if (metrics.usage) {
    const inputCost = (metrics.usage.input_tokens / 1_000_000) * 1.75;
    const outputCost = (metrics.usage.output_tokens / 1_000_000) * 14.00;
    console.log(`   Tokens: ${metrics.usage.input_tokens} in / ${metrics.usage.output_tokens} out`);
    console.log(`   Est. cost: $${(inputCost + outputCost).toFixed(2)}`);
  }

  // ── Read findings file ──
  // Codex sandbox restricts writes to workingDirectory (repoDir), so findings
  // may land there instead of runDir. Check both and copy to runDir if needed.
  const findingsInRun = path.join(artifacts.runDir, 'phase-e-codex-findings.json');
  const findingsInRepo = path.join(artifacts.repoDir, 'phase-e-codex-findings.json');
  if (fs.existsSync(findingsInRepo)) {
    // Always prefer repo copy (that's where Codex actually writes)
    fs.copyFileSync(findingsInRepo, findingsInRun);
    console.log(`   ✓ Copied findings from repo dir to runs dir`);
    fs.unlinkSync(findingsInRepo);
  }
  const findingsPath = findingsInRun;
  if (fs.existsSync(findingsPath)) {
    const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
    const count = findings.findings?.length || 0;
    console.log(`\n📊 Phase E (Codex) Results: ${count} new findings`);

    if (count > 0) {
      for (const f of findings.findings) {
        console.log(`   • [${f.severity}] ${f.title} (${f.source})`);
      }

      // Write submission file
      const submDir = path.join(SUBMISSIONS_DIR, opts.contest);
      const phaseEVulns = convertPhaseEToSubmission(findings);
      const phaseESubmission = { vulnerabilities: phaseEVulns };
      const phaseEPath = path.join(submDir, 'phase-e-codex.json');
      fs.mkdirSync(submDir, { recursive: true });
      fs.writeFileSync(phaseEPath, JSON.stringify(phaseESubmission, null, 2));
      console.log(`\n📦 Phase E (Codex) submission: ${phaseEPath} (${phaseEVulns.length} findings)`);

      const auditPath = path.join(submDir, 'audit.json');
      const combinedOutput = path.join(submDir, 'audit-graded-codex-combined.json');
      console.log(`\n   Grade combined with:`);
      console.log(`   node grade-detect.js --submission ${auditPath} --phase-e ${phaseEPath} --task-dir <task-dir> --output ${combinedOutput}`);
    }
  } else {
    console.log('\n⚠️  Agent did not write findings file.');
  }

  // ── Timing metadata ──
  const timing = {
    phase: 'E-codex',
    contestId: opts.contest,
    startedAt: new Date(startTime).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs,
    durationMinutes: +(durationMs / 60000).toFixed(1),
    model: opts.model,
    reasoning: opts.reasoning,
    timeoutMinutes: opts.timeoutMinutes,
    terminationReason,
    shellCommands: metrics.toolCalls,
    reasoningBlocks: metrics.reasoning,
    fileChanges: metrics.fileChanges,
    usage: metrics.usage,
    findingsCount: fs.existsSync(findingsPath)
      ? (JSON.parse(fs.readFileSync(findingsPath, 'utf8')).findings?.length || 0)
      : 0,
  };
  fs.writeFileSync(
    path.join(artifacts.runDir, 'phase-e-codex-timing.json'),
    JSON.stringify(timing, null, 2)
  );

  console.log('\nDone.');
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
