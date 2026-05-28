import test from "node:test";
import assert from "node:assert/strict";
import { getCompactToolContract, getAvailableToolsList } from "../tools.ts";

test("getCompactToolContract generates expected text for common tools", () => {
  const tools = getAvailableToolsList("reviewer");
  const contract = getCompactToolContract(tools);
  
  assert.ok(contract.includes("Available tools this run:"));
  assert.ok(contract.includes("- read_file"));
  assert.ok(contract.includes("- git_diff"));
  assert.ok(!contract.includes("- write_file")); // Reviewer shouldn't have write
});

test("getAvailableToolsList respects role", () => {
  const builderTools = getAvailableToolsList("builder");
  const reviewerTools = getAvailableToolsList("reviewer");
  const decoderTools = getAvailableToolsList("epic-decoder");
  const epicReviewerTools = getAvailableToolsList("epic-reviewer");

  assert.ok(builderTools.includes("write_file"));
  assert.ok(reviewerTools.includes("git_diff"));
  assert.ok(decoderTools.includes("web_search"));
  assert.ok(epicReviewerTools.includes("write_file")); // We added this per user feedback
});

test("explorer only gets run_command when install is explicitly enabled", () => {
  const defaultExplorerTools = getAvailableToolsList("explorer");
  const installExplorerTools = getAvailableToolsList("explorer", { availableCommands: ["install"] });

  assert.equal(defaultExplorerTools.includes("run_command"), false);
  assert.equal(installExplorerTools.includes("run_command"), true);
});
