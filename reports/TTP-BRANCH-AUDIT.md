# Branch audit — post AI OS landing (PR #17, #18, #19)

Audited: 2026-09-21. `origin/main` tip: `46af788` (2026-09-21 20:51:18 +0200).

No product code, prices, or SKUs are touched by this audit or by the deletes below.
`lib/products.ts` and Stripe wiring are unchanged.

| Branch | Tip SHA | Last commit date | Author | Merged into main? | Ahead/Behind main | Verdict |
|---|---|---|---|---|---|---|
| `agent/ttp-ai-core` | `d2c54a7` | 2026-09-21 10:49:02+02:00 | Vincenzo Ceccarelli Grimaldi | yes | 0 / 14 | DELETE |
| `agent/ttp-ai-billing` | `fbce3dc` | 2026-09-21 08:10:36+00:00 | Claude | no | 1 / 16 | DELETE |
| `agent/ttp-ai-workspace` | `e124040` | 2026-09-21 10:49:13+02:00 | Vincenzo Ceccarelli Grimaldi | no | 2 / 16 | DELETE |
| `claude/bold-babbage-ywy03t` | `7e8240c` | 2026-09-20 17:58:32+00:00 | Claude | yes | 0 / 35 | DELETE |
| `claude/kind-mendel-fh42fo` | `e851cf8` | 2026-09-20 18:40:38+00:00 | Claude | yes | 0 / 32 | DELETE |
| `claude/nice-mendel-z3muz7` | `7cf7706` | 2026-09-21 10:48:52+02:00 | Vincenzo Ceccarelli Grimaldi | no (merge commit only) | 1 / 14 | DELETE |
| `claude/serene-euler-6u7cvt` | `d21a9c9` | 2026-09-20 19:38:02+00:00 | Claude | yes | 0 / 30 | DELETE |
| `claude/wizardly-knuth-qdwo69` | `6b705af` | 2026-09-21 18:33:29+00:00 | Claude | yes | 0 / 1 | DELETE |
| `claude/wonderful-hopper-k8on8z` | `d5e241d` | 2026-09-20 22:18:52+00:00 | Claude | yes | 0 / 18 | DELETE |
| `factory/GF-001` | `79d53d6` | 2026-09-16 17:09:08+02:00 | Vincenzo Ceccarelli Grimaldi | yes | 0 / 52 | DELETE |
| `factory/GF-001-failclosed` | `7e34b6d` | 2026-09-16 17:19:42+02:00 | iceccarelli | yes | 0 / 50 | DELETE |
| `fix/dashboard-honesty-smoke` | `8ed34ef` | 2026-09-17 23:21:24+02:00 | iceccarelli | yes | 0 / 38 | DELETE |
| `integrate/ttp-ai-os-landing` | `db167e0` | 2026-09-21 09:04:47+00:00 | Claude | yes | 0 / 8 | DELETE |
| `phase0-phase1-density-screen-sell` | `b3f5e53` | 2026-09-17 20:45:19+02:00 | iceccarelli | yes | 0 / 41 | DELETE |

## Detail on the three non-fully-merged tips

**`agent/ttp-ai-billing`** (1 commit ahead, 16 behind) — its one unique commit,
"Wire AI commercialAction checkout attribution and add event logging," edits
`components/ai/mock.ts` directly (`git diff origin/main...origin/agent/ttp-ai-billing`
shows `components/ai/mock.ts | 48 +++++++++++++++++++++++++++++-----`). Main's
real `/api/chat` (from PR #17/#18/#19) has already superseded the mock chat
path — `components/ai/mock.ts` does not exist on `main`. Merging this branch
would reintroduce the mock chat path. **Verdict: DELETE, do not merge.**

**`agent/ttp-ai-workspace`** (2 commits ahead, 16 behind) — its two unique
commits are a merge of `agent/ttp-ai-billing` plus the same billing commit
above (`git log origin/main..origin/agent/ttp-ai-workspace` shows only these
two, and the diff stat against main is identical to `agent/ttp-ai-billing`).
Same `components/ai/mock.ts` regression, same supersession by main.
**Verdict: DELETE, do not merge.**

**`claude/nice-mendel-z3muz7`** (1 commit ahead, 14 behind) — its one unique
commit is a merge of `agent/ttp-ai-core` and touches no files itself; its
diff against main only differs because of a multi-merge-base artifact
(`reports/TTP-AI-AGENT-PLAN.md`, `reports/TTP-AI-AUDIT.md`,
`reports/TTP-AI-CAPABILITY-MATRIX.md`), and all three of those files already
exist byte-identical on `main`. No unique product commits. **Verdict: DELETE.**

## HUMAN_REVIEW

None. No branch carries unique, non-regressive work that main lacks.

## Rules applied

- DELETE if fully merged (0 commits ahead of main): 11 branches.
- DELETE `agent/ttp-ai-billing` and `agent/ttp-ai-workspace`: superseded by
  main and both still touch/reintroduce `components/ai/mock.ts`. Not merged.
- DELETE `claude/nice-mendel-z3muz7`: no unique product commits, only a
  merge commit whose apparent diff is already on `main`.
- KEEP: none qualified — no branch has unique unmerged work that is not a
  mock-chat regression.
