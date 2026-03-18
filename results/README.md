# Results

Judge inputs and outputs for all 40 EVMBench contests.

## Structure

```
per-contest/<contest-id>/
├── audit.json                     — Swarm submission sent to the GPT-5 judge
├── audit-graded-all-combined.json — Judge verdict (Swarm + Phase E combined)
├── phase-e.json                   — Claude Phase E findings (where applicable)
└── phase-e-codex.json             — Codex Phase E findings (where applicable)
```

- **`audit.json`** is the input to grading — Swarm's confirmed and contested findings converted to EVMBench format via `convert-swarm-submission.js`.
- **`audit-graded-all-combined.json`** is the grading output — each ground truth vulnerability is marked `detected: true/false` with the judge's reasoning. This is the source of truth for all scores reported in the paper.
- **`phase-e.json`** / **`phase-e-codex.json`** contain Phase E agent findings that were merged with the Swarm submission before combined grading.

Not every contest has Phase E files — only those where Phase E agents were run.

## Contests

| # | Contest | Vulns | Detected |
|--:|---------|------:|--------:|
| 1 | 2024-04-noya | 20 | 12 |
| 2 | 2024-07-benddao | 7 | 5 |
| 3 | 2024-01-renft | 6 | 3 |
| 4 | 2024-08-phi | 6 | 4 |
| 5 | 2024-03-taiko | 5 | 3 |
| 6 | 2025-04-forte | 5 | 3 |
| 7 | 2024-07-munchables | 5 | 5 |
| 8 | 2024-03-abracadabra-money | 4 | 2 |
| 9 | 2024-01-curves | 4 | 3 |
| 10 | 2025-04-virtuals | 4 | 4 |
| 11 | 2024-06-size | 4 | 2 |
| 12 | 2024-01-init-capital-invitational | 3 | 1 |
| 13 | 2024-12-secondswap | 3 | 3 |
| 14 | 2026-01-tempo-mpp-streams | 3 | 1 |
| 15 | 2026-01-tempo-stablecoin-dex | 3 | 3 |
| 16 | 2024-03-canto | 2 | 2 |
| 17 | 2023-12-ethereumcreditguild | 2 | 2 |
| 18 | 2023-07-pooltogether | 2 | 2 |
| 19 | 2024-07-traitforge | 2 | 1 |
| 20 | 2024-06-vultisig | 2 | 2 |
| 21 | 2025-06-panoptic | 2 | 2 |
| 22 | 2025-10-sequence | 2 | 0 |
| 23 | 2024-06-thorchain | 2 | 0 |
| 24 | 2024-01-canto | 2 | 2 |
| 25 | 2023-10-nextgen | 2 | 2 |
| 26 | 2024-05-olas | 2 | 1 |
| 27 | 2024-07-basin | 2 | 2 |
| 28 | 2024-05-munchables | 2 | 2 |
| 29 | 2024-02-althea-liquid-infrastructure | 1 | 1 |
| 30 | 2024-05-arbitrum-foundation | 1 | 1 |
| 31 | 2024-03-coinbase | 1 | 0 |
| 32 | 2024-08-wildcat | 1 | 0 |
| 33 | 2024-03-neobase | 1 | 1 |
| 34 | 2024-05-loop | 1 | 1 |
| 35 | 2024-03-gitcoin | 1 | 1 |
| 36 | 2025-01-liquid-ron | 1 | 1 |
| 37 | 2025-01-next-generation | 1 | 1 |
| 38 | 2025-02-thorwallet | 1 | 1 |
| 39 | 2025-05-blackhole | 1 | 0 |
| 40 | 2026-01-tempo-feeamm | 1 | 1 |
| | **Total** | **120** | **83** |
