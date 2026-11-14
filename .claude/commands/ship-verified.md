Run the full pre-merge verification gate on the current branch:
1. Check `git status` and ensure branch is rebased onto latest `origin/main`.
2. Run engine-vs-repo drift check and capability parity tests (`python3 -m pytest tests/test_stack_consistency.py tests/test_catalogue_parity.py tests/test_one_company.py tests/test_openapi_parity.py tests/test_agent_distribution.py -q`).
3. Regenerate page dates once via `node scripts/page-lastmod.mjs`.
4. Run `npm run typecheck`, `npm run lint`, and the full `npx vitest run` suite under Node 20 compatibility rules.
5. Run `npm run build` and verify the per-route JavaScript bundle budget (`tests/site/perf-budget.test.ts`).
