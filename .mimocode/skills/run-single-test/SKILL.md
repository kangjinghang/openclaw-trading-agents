---
name: run-single-test
description: "Run a specific test file or test case. Faster than running full test suite during development."
---

# Run Single Test

Run a specific test file or test case for targeted verification during development.

## Trigger

User says "跑测试", "run test", "test <file>", "verify", or mentions specific test files like trader.test.ts, risk.test.ts.

## Procedure

### Step 1: Identify the test file

Common test files in `tests/ts/`:
- `trader.test.ts` — Trader module tests
- `risk.test.ts` — Risk management tests
- `debate.test.ts` — Debate phase tests
- `integration.test.ts` — Full pipeline integration tests
- `orchestrator_pipeline.test.ts` — Orchestrator tests
- `llm-client.test.ts` — LLM client tests
- `exec-python.test.ts` — Python execution tests
- `cache.test.ts` — Caching tests
- `quality-gate.test.ts` — Quality gate tests

Use Glob to find the exact file:
```bash
ls tests/ts/
```

### Step 2: Ensure dist/ is fresh

```bash
npm run build 2>&1 | tail -5
```

**Critical**: Tests import from `dist/`, so stale build is the #1 cause of failures.

### Step 3: Run the test

**Run entire test file:**
```bash
npx vitest run tests/ts/<test-file>.test.ts
```

**Run with verbose output:**
```bash
npx vitest run tests/ts/<test-file>.test.ts --reporter=verbose
```

**Run specific test case:**
```bash
npx vitest run tests/ts/<test-file>.test.ts -t "test case name"
```

**Run with grep pattern:**
```bash
npx vitest run tests/ts/<test-file>.test.ts -t "pattern"
```

### Step 4: Analyze results

Look for:
- ✅ All tests pass
- ❌ Failed tests with error messages
- ⚠️ Warnings or deprecation notices

Common failure patterns:
- `ReferenceError: ... is not defined` — Missing import or build issue
- `AssertionError: expected ... to equal ...` — Logic error
- `Timeout` — Async operation taking too long

### Step 5: Fix and re-run

If tests fail:
1. Read the error message carefully
2. Check if it's a build issue (rebuild with `npm run build`)
3. Fix the code or test
4. Re-run the specific test

## Quick Commands

**Run all tests:**
```bash
npm test 2>&1
```

**Run specific file:**
```bash
npx vitest run tests/ts/trader.test.ts
```

**Run with grep:**
```bash
npx vitest run tests/ts/integration.test.ts -t "risk"
```

**Run with timeout:**
```bash
npx vitest run tests/ts/integration.test.ts --timeout 30000
```

## Test Output Formats

**Default (dot reporter):**
```
 ✓ tests/ts/trader.test.ts (12 tests) 45ms
```

**Verbose:**
```
 ✓ should calculate position size correctly (12ms)
 ✗ should reject invalid ticker (15ms)
   → AssertionError: expected null to equal '600519'
```

## Common Test Patterns

### Trader Tests
```bash
npx vitest run tests/ts/trader.test.ts
```
- Position sizing calculations
- Order execution logic
- Risk limit checks

### Risk Tests
```bash
npx vitest run tests/ts/risk.test.ts
```
- Risk assessment logic
- Drawdown calculations
- Exposure limits

### Integration Tests
```bash
npx vitest run tests/ts/integration.test.ts
```
- Full pipeline with mocks
- Cross-module interactions
- End-to-end scenarios

### Debate Tests
```bash
npx vitest run tests/ts/debate.test.ts
```
- Debate phase logic
- Argument resolution
- Consensus building

## Example

```bash
# User: "跑 trader 测试"
npm run build 2>&1 | tail -3
npx vitest run tests/ts/trader.test.ts

# User: "测试 risk 的特定用例"
npx vitest run tests/ts/risk.test.ts -t "drawdown"
```

## Failure Modes

1. **Stale dist/** → Rebuild with `npm run build`
2. **Missing dependencies** → Run `npm install`
3. **Python test failures** → Check `tests/scripts/` (separate from vitest)
4. **Mock issues** → Tests mock all external calls; no real API keys needed
