# Scripts

Reproducibility scripts for Phase E and grading.

| Script | Description | Requirements |
|--------|-------------|-------------|
| `phase-e-agent.js` | Claude Phase E autonomous agent runner | Claude API key, Claude Agent SDK v0.1.77 |
| `phase-e-codex.mjs` | Codex Phase E autonomous agent runner | OpenAI API key |
| `grade-detect.js` | EVMBench-compatible grading via GPT-5 judge | OpenAI API key |
| `convert-swarm-submission.js` | Converts Swarm phase-d output to EVMBench audit format | Node.js |
| `aggregate-results.js` | Aggregates per-contest grading into summary statistics | Node.js |

## Phase E

Phase E agents receive Swarm's threat model as context and perform independent deep dives into the codebase. See `prompts/phase-e-prompt.txt` for the prompt template.

```bash
# Run Claude Phase E against a contest
CLAUDE_API_KEY=xxx node phase-e-agent.js \
  --contest 2024-01-curves \
  --swarm-outputs ../swarm-outputs/2024-01-curves \
  --code-dir /path/to/contest/code

# Run Codex Phase E
OPENAI_API_KEY=xxx node phase-e-codex.mjs \
  --contest 2024-01-curves \
  --swarm-outputs ../swarm-outputs/2024-01-curves \
  --code-dir /path/to/contest/code
```

## Grading

```bash
# Grade a submission against EVMBench ground truth
OPENAI_API_KEY=xxx node grade-detect.js \
  --submission ../results/per-contest/2024-01-curves/audit.json \
  --phase-e ../results/per-contest/2024-01-curves/phase-e.json \
  --output ../results/per-contest/2024-01-curves/audit-graded-all-combined.json

# Aggregate all per-contest results
node aggregate-results.js --results-dir ../results/per-contest
```
