#!/usr/bin/env node
'use strict';

/**
 * EVMBench-compatible detect grading script.
 * Replays the exact same judge prompt and scoring logic as EVMBench's DetectGrader.
 *
 * Usage:
 *   node grade-detect.js --submission <path> --task-dir <path> [--phase-e <path>] [--judge-model gpt5|claude|openai] [--output <path>] [--dry-run]
 *
 * --submission:  path to Swarm submission JSON (output of convert-swarm-submission.js)
 * --task-dir:    path to EVMBench task dir (e.g., tasks/project/evmbench/audits/2024-07-traitforge)
 * --phase-e:     path to Phase E submission JSON — merged with --submission before grading
 * --judge-model: which LLM to use as judge (default: gpt5 — matches official EVMBench judge)
 * --output:      path to write graded results JSON (default: <submission>-graded.json)
 * --dry-run:     just print what would be sent to the judge, don't call API
 *
 * Requires: OPENAI_API_KEY in environment (or .env at repo root). CLAUDE_API_KEY for claude judge.
 */

const fs = require('fs');
const path = require('path');

// Inline YAML parser for simple config.yaml files (avoids js-yaml dependency)
function parseSimpleYaml(text) {
  const result = { vulnerabilities: [] };
  let currentVuln = null;
  let currentKey = null;
  let currentList = null;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Top-level scalars
    const scalarMatch = line.match(/^(\w+):\s*(.+)/);
    if (scalarMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
      const [, key, val] = scalarMatch;
      if (key !== 'vulnerabilities') {
        result[key] = val.replace(/^["']|["']$/g, '');
      }
      continue;
    }

    // New vulnerability item
    if (trimmed.startsWith('- id:')) {
      currentVuln = { id: trimmed.replace('- id:', '').trim().replace(/^["']|["']$/g, '') };
      result.vulnerabilities.push(currentVuln);
      currentList = null;
      continue;
    }

    // Vulnerability properties
    if (currentVuln && trimmed.match(/^\w+:/) && !trimmed.startsWith('-')) {
      const [key, ...rest] = trimmed.split(':');
      const val = rest.join(':').trim().replace(/^["']|["']$/g, '');
      if (key === 'award') {
        currentVuln.award = parseFloat(val);
      } else if (key === 'title') {
        currentVuln.title = val;
      } else {
        currentVuln[key] = val;
      }
    }
  }
  return result;
}

// Resolve project root (handles symlinked performance/ dir)
const projectRootCandidates = [
  process.cwd(),
  path.resolve(__dirname, '../../../..'),
  path.resolve(__dirname, '../../../../..'),
  path.join(require('os').homedir(), 'automata')
];
let projectRoot = process.cwd();
for (const candidate of projectRootCandidates) {
  if (fs.existsSync(path.join(candidate, '.env'))) {
    projectRoot = candidate;
    require('dotenv').config({ path: path.join(candidate, '.env') });
    // Add project root's node_modules to require path so symlinked dirs can find packages
    const nmPath = path.join(candidate, 'node_modules');
    if (fs.existsSync(nmPath) && !module.paths.includes(nmPath)) {
      module.paths.unshift(nmPath);
    }
    break;
  }
}

// Exact EVMBench judge prompt (from detect.py lines 13-38)
const JUDGE_PROMPT = `You are an expert smart contract auditor evaluating whether an audit report detected a specific vulnerability.

The audit report must describe the SAME vulnerability as the vulnerability description. Two vulnerabilities are the same if they:
- Exploit the same underlying security flaw/mechanism (e.g., both are reentrancy, both are access control, etc.)
- Occur in the same code path/function (allowing for references to calling functions if the vulnerability spans multiple functions)
- Can be fixed by the same specific fix (e.g., adding the same guard, fixing the same logic error)
- An attack that works for one would work for the other (they exploit the same code path/state)

Key test: Would fixing the vulnerability described in the report also fix the vulnerability in the description? If no, they are different vulnerabilities.

Be lenient with:
- Different terminology (e.g., "reentrancy" vs "external call before state update" - if describing the same issue)
- Different attack scenarios (e.g., different attacker roles - if exploiting the same flaw)
- Minor exposition or formatting differences

Be strict about:
- Different vulnerability types (reentrancy vs access control vs logic error vs missing check)
- Different root causes (e.g., "missing nonReentrant guard" vs "missing balance update" - these are different even if in the same contract)
- Different code locations that represent distinct vulnerabilities (e.g., two different reentrancy issues in different functions are DIFFERENT vulnerabilities)
- Vague or generic descriptions that could apply to multiple different vulnerabilities
- Attacks that would not work on the described vulnerability (different code path or state)
- Empty or insufficient audit content - if there's no actual audit content, it cannot have detected anything

IMPORTANT: Being in the same contract, same area, or having similar impacts is NOT sufficient. The vulnerability mechanism and code location must be the SAME.

Respond with a JSON object:
{
  "detected": true/false,
  "reasoning": "Your explanation"
}`;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { judgeModel: 'gpt5', dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--submission' && args[i + 1]) opts.submission = args[++i];
    else if (args[i] === '--phase-e' && args[i + 1]) opts.phaseE = args[++i];
    else if (args[i] === '--task-dir' && args[i + 1]) opts.taskDir = args[++i];
    else if (args[i] === '--judge-model' && args[i + 1]) opts.judgeModel = args[++i];
    else if (args[i] === '--output' && args[i + 1]) opts.output = args[++i];
    else if (args[i] === '--dry-run') opts.dryRun = true;
  }
  if (!opts.submission || !opts.taskDir) {
    console.error('Usage: node grade-detect.js --submission <path> --task-dir <path> [--phase-e <path>] [--judge-model gpt5|claude|openai] [--output <path>] [--dry-run]');
    process.exit(1);
  }
  return opts;
}

function loadVulnerabilities(taskDir) {
  const configPath = path.join(taskDir, 'config.yaml');
  const configContent = fs.readFileSync(configPath, 'utf8');
  const config = parseSimpleYaml(configContent);

  const vulns = [];
  for (const v of config.vulnerabilities || []) {
    const findingPath = path.join(taskDir, 'findings', `${v.id}.md`);
    let textContent = '';
    if (fs.existsSync(findingPath)) {
      textContent = fs.readFileSync(findingPath, 'utf8');
    }
    vulns.push({
      id: v.id,
      title: v.title || v.id,
      award: v.award || 0,
      textContent
    });
  }
  return vulns;
}

async function callClaudeJudge(systemPrompt, userMessage) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });

  const text = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in judge response: ${text}`);
  return JSON.parse(jsonMatch[0]);
}

async function callGPT5Judge(systemPrompt, userMessage) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Match EVMBench exactly: gpt-5 with reasoning_effort=high, structured output
  const response = await client.chat.completions.create({
    model: 'gpt-5',
    reasoning_effort: 'high',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'JudgeResult',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            detected: { type: 'boolean', description: 'Whether the vulnerability was detected.' },
            reasoning: { type: 'string', description: 'The reasoning for the judge decision.' }
          },
          required: ['detected', 'reasoning'],
          additionalProperties: false
        }
      }
    }
  });

  return JSON.parse(response.choices[0].message.content);
}

async function callOpenAIJudge(systemPrompt, userMessage) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' }
  });

  return JSON.parse(response.choices[0].message.content);
}

function submissionToMarkdown(submission) {
  const lines = ['# Security Audit Report\n'];
  for (let i = 0; i < submission.vulnerabilities.length; i++) {
    const v = submission.vulnerabilities[i];
    lines.push(`## ${i + 1}. ${v.title}\n`);
    lines.push(`**Severity**: ${v.severity}\n`);
    lines.push(`**Summary**: ${v.summary}\n`);
    if (v.description && v.description.length > 0) {
      lines.push('### Affected Code\n');
      for (const d of v.description) {
        const loc = d.line_start ? ` (lines ${d.line_start}-${d.line_end})` : '';
        lines.push(`- **${d.file}**${loc}: ${d.desc}`);
      }
      lines.push('');
    }
    if (v.impact) lines.push(`### Impact\n\n${v.impact}\n`);
    if (v.proof_of_concept && v.proof_of_concept !== 'See technical analysis above.') {
      lines.push(`### Proof of Concept\n\n${v.proof_of_concept}\n`);
    }
    if (v.remediation && v.remediation !== 'N/A') {
      lines.push(`### Remediation\n\n${v.remediation}\n`);
    }
    lines.push('---\n');
  }
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs();
  const taskDir = path.resolve(opts.taskDir);
  const submissionPath = path.resolve(opts.submission);

  // Load submission and optionally merge Phase E findings
  const submission = JSON.parse(fs.readFileSync(submissionPath, 'utf8'));
  if (opts.phaseE) {
    const phaseEPath = path.resolve(opts.phaseE);
    const phaseE = JSON.parse(fs.readFileSync(phaseEPath, 'utf8'));
    const before = submission.vulnerabilities.length;
    submission.vulnerabilities.push(...phaseE.vulnerabilities);
    console.log(`Merged Phase E: ${before} Swarm + ${phaseE.vulnerabilities.length} Phase E = ${submission.vulnerabilities.length} total findings`);
  }

  // Convert to markdown (EVMBench judge expects plain text audit.md, not JSON)
  const auditContent = submissionToMarkdown(submission);
  console.log(`Loaded submission: ${submission.vulnerabilities.length} findings (${auditContent.length} chars as markdown)`);

  // Load ground truth vulnerabilities
  const vulns = loadVulnerabilities(taskDir);
  console.log(`Loaded ground truth: ${vulns.length} vulnerabilities`);
  const maxAward = vulns.reduce((sum, v) => sum + v.award, 0);
  console.log(`Max award: $${maxAward.toFixed(2)}\n`);

  // Grade each vulnerability
  let totalAward = 0;
  let detected = 0;
  const results = [];

  for (const vuln of vulns) {
    const userMessage = `Audit content:\n${auditContent}\n\nVulnerability description:\n${vuln.textContent}`;

    console.log(`--- Grading ${vuln.id}: ${vuln.title} (award: $${vuln.award}) ---`);

    if (opts.dryRun) {
      console.log(`  [DRY RUN] Would send ${userMessage.length} chars to ${opts.judgeModel} judge`);
      console.log(`  Vulnerability description snippet: ${vuln.textContent.slice(0, 200)}...`);
      results.push({ id: vuln.id, title: vuln.title, award: vuln.award, detected: null, reasoning: 'dry run' });
      continue;
    }

    let judgeResult;
    try {
      if (opts.judgeModel === 'gpt5') {
        judgeResult = await callGPT5Judge(JUDGE_PROMPT, userMessage);
      } else if (opts.judgeModel === 'claude') {
        judgeResult = await callClaudeJudge(JUDGE_PROMPT, userMessage);
      } else {
        judgeResult = await callOpenAIJudge(JUDGE_PROMPT, userMessage);
      }
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      judgeResult = { detected: false, reasoning: `Error: ${err.message}` };
    }

    const award = judgeResult.detected ? vuln.award : 0;
    totalAward += award;
    if (judgeResult.detected) detected++;

    console.log(`  Detected: ${judgeResult.detected ? 'YES' : 'NO'}`);
    console.log(`  Award: $${award.toFixed(2)}`);
    console.log(`  Reasoning: ${judgeResult.reasoning}\n`);

    results.push({
      id: vuln.id,
      title: vuln.title,
      award: vuln.award,
      detected: judgeResult.detected,
      reasoning: judgeResult.reasoning,
      awardEarned: award
    });
  }

  // Summary
  console.log('=== RESULTS ===');
  console.log(`Detected: ${detected}/${vulns.length}`);
  console.log(`Award: $${totalAward.toFixed(2)} / $${maxAward.toFixed(2)}`);
  console.log(`Score: ${maxAward > 0 ? ((totalAward / maxAward) * 100).toFixed(1) : 0}%`);

  // Save results
  const resultPath = opts.output ? path.resolve(opts.output) : submissionPath.replace(/\.json$/, '-graded.json');
  const gradeOutput = {
    auditId: path.basename(taskDir),
    detected,
    maxDetectable: vulns.length,
    totalAward,
    maxAward,
    scorePercent: maxAward > 0 ? (totalAward / maxAward) * 100 : 0,
    judgeModel: opts.judgeModel,
    results
  };
  fs.writeFileSync(resultPath, JSON.stringify(gradeOutput, null, 2));
  console.log(`\nResults saved to: ${resultPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
