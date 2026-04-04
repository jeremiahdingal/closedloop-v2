# Epic: Fix Mediated Tester Stalling Issue

## Problem
The mediated tester agent hangs when trying to test tickets. Observed behavior:
- Ticket gets stuck at `currentNode: "tester"` with `lastMessage: "Running tests."`
- No progress after 5+ minutes
- Worker log shows no errors, just silence

## Root Cause Analysis

### Issue 1: Mediated Tester Hanging
The mediated tester (`mediated:glm-4.7-flash:q4_K_M`) gets stuck in an infinite loop or timeout when:
1. Builder already created tests
2. Tester tries to write NEW tests for files that already have tests
3. The test scoring logic (0-100) may be confusing the model

**Evidence:**
- Ticket `epic_e8bf01645838d8e8__T1` stuck at tester node since 17:28:34
- Builder created test files: `test/readPackageJson.test.js`
- Reviewer approved the changes
- Tester never completed

### Issue 2: Job Recovery Not Triggering
Jobs stuck in "running" state aren't being recovered quickly enough:
- Default stale threshold: 120 seconds (2 minutes)
- Should be shorter for faster recovery

## Solutions

### Short-term: Disable Mediated Tester
Reverted tester to legacy command-based approach:
```json
{
  "tester": "glm-4.7-flash:q4_K_M"
}
```

This uses `npm test` directly instead of the mediated harness.

### Medium-term: Fix Mediated Tester Prompt
The tester prompt needs clarification:
1. **Detect existing tests** - Check if test files already exist for changed files
2. **Skip if tests exist** - Don't write duplicate tests
3. **Run existing tests** - Use `run_command("test")` to run the project's test suite
4. **Better scoring** - Make the 0-100 scoring clearer with examples

### Long-term: Add Test Discovery
Add a `list_tests` tool to the mediated harness that:
- Discovers existing test files
- Maps test files to source files
- Returns test coverage for changed files

## Testing Plan

### Test Case 1: Simple File Copy (NO tests needed)
Goal: Create hello.json with package.json contents
Expected: Tester scores < 50, skips tests, ticket completes

### Test Case 2: New Function (tests needed)
Goal: Add new utility function
Expected: Tester scores >= 50, writes tests, runs them, ticket completes

### Test Case 3: Existing Tests Present
Goal: Modify code that already has tests
Expected: Tester detects existing tests, runs them, ticket completes

## Current Status

- [x] Identified stalling issue
- [x] Disabled mediated tester (reverted to legacy)
- [x] Fixed stuck jobs recovery script
- [ ] Run test epic with legacy tester
- [ ] Verify tickets complete successfully
- [ ] Fix mediated tester prompt
- [ ] Re-enable mediated tester
- [ ] Run test epic with mediated tester
- [ ] Verify no stalling

## Files Modified

1. `config/agent-models.json` - Reverted tester to non-mediated
2. `src/orchestration/ticket-runner.ts` - Added mediated tester support (not currently used)
3. `src/mediated-agent-harness/prompts.ts` - Added tester prompt (needs fixing)
4. `src/types.ts` - Added TesterResult type
5. `src/orchestration/models.ts` - Added runTesterInWorkspace method

## Recovery Commands

When tickets stall:
```bash
# Fix stuck jobs
node --experimental-strip-types src/apps/fix-jobs.ts

# Restart worker
npm run worker
```
