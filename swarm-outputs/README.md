# Swarm Outputs

Full threat model artifacts from FailSafe Swarm's Phases A–D for all 40 EVMBench contests.

## Structure

Each contest directory contains the complete output of Swarm's structured threat modeling pipeline:

```
<contest-id>/
├── phase-a-architecture-analysis.json       — Architecture & entry points
├── phase-a-security-analysis.json           — Security & trust boundaries
├── phase-a-logic-analysis.json              — Data flow & logic
├── phase-a-invariant-state-analysis.json    — State machine invariants
├── phase-a-invariant-economic-analysis.json — Economic invariants
├── phase-a-summary.json                     — Consolidated Phase A summary
├── phase-b-technical-threats.json           — Technical threats (LLM pass 1)
├── phase-b-technical-2-threats.json         — Technical threats (LLM pass 2)
├── phase-b-economic-threats.json            — Economic threats (LLM pass 1)
├── phase-b-economic-2-threats.json          — Economic threats (LLM pass 2)
├── phase-b-operational-threats.json         — Operational threats (LLM pass 1)
├── phase-b-operational-2-threats.json       — Operational threats (LLM pass 2)
├── phase-b-summary.json                     — Consolidated Phase B summary
├── phase-c-deduplicated-threats.json        — Deduplicated threat list
├── phase-c-deduplication-analysis.json      — Deduplication reasoning
├── phase-c-consensus-tracking.json          — Cross-specialist consensus
├── phase-d-validation-summary.json          — Validation statistics
└── phase-d/
    └── confirmed/                           — Validated findings (one JSON per finding)
```

### Multi-Cluster Contests

Large codebases are split into clusters, each analyzed independently. These contests have subdirectories instead of top-level files:

```
<contest-id>/
├── C01/          — Cluster 1 (same file structure as above)
├── C02/          — Cluster 2
└── C03/          — Cluster 3 (if applicable)
```

Multi-cluster contests: abracadabra-money, arbitrum-foundation, benddao, blackhole, noya, taiko, virtuals, wildcat.

## Phase Descriptions

| Phase | Purpose | Typical Output |
|-------|---------|---------------|
| **A — Foundation** | 5 specialist analyses of architecture, invariants, trust boundaries | ~5 JSON files per cluster |
| **B — Threat Generation** | 6 specialists × 2 LLM passes generate code-anchored hypotheses | 50–80 hypotheses per cluster |
| **C — Deduplication** | Semantic consolidation of overlapping findings | ~45% reduction |
| **D — Validation** | Independent deep analysis: CONFIRMED or REFUTED | Binary verdict per hypothesis |

## Reading the Artifacts

**Start here**: `phase-d-validation-summary.json` gives an overview of how many hypotheses were confirmed vs. refuted.

**Confirmed findings**: `phase-d/confirmed/*.json` — each file is a validated finding with root cause, affected code, execution path, and remediation.

**Threat model context**: The `phase-a-*.json` files provide the architectural understanding that informed all downstream analysis.
