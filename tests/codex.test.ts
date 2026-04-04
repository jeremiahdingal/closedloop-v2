import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { CodexLaunchError, CodexRunner } from "../src/orchestration/codex.ts";

function createSpawnStub(
  assertLaunch: (command: string, args: string[], options: Record<string, unknown>, stdin: PassThrough) => void,
  output = '<FINAL_JSON>{"summary":"ok","tickets":[]}</FINAL_JSON>'
) {
  return ((command: string, args: string[], options: Record<string, unknown>) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    assertLaunch(command, args, options, child.stdin);
    process.nextTick(() => {
      child.stdout.write(output);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
    });
    return child as any;
  }) as any;
}

test("CodexRunner launches non-interactively and sends the prompt over stdin", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-cwd-"));
  const launches: Array<{ command: string; args: string[]; options: Record<string, unknown>; stdinText: string }> = [];
  const runner = new CodexRunner({
    spawnImpl: createSpawnStub((command, args, options, stdin) => {
      let stdinText = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk: string) => {
        stdinText += chunk;
      });
      stdin.on("end", () => {
        launches.push({ command, args, options, stdinText });
      });
    })
  });

  const result = await runner.runEpicDecoder({
    role: "epicDecoder",
    cwd,
    prompt: "Inspect the repo and return ticket JSON."
  });

  assert.equal(result.summary, "ok");
  assert.deepEqual(result.tickets, []);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, "codex");
  assert.deepEqual(launches[0].args.slice(0, 5), ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", cwd]);
  assert.equal(launches[0].args.at(-1), "-");
  assert.equal(launches[0].options.shell, true);
  assert.equal(launches[0].stdinText, "Inspect the repo and return ticket JSON.");
});

test("CodexRunner rejects an invalid cwd before spawning", async () => {
  const runner = new CodexRunner({
    spawnImpl: createSpawnStub(() => {
      throw new Error("spawn should not run");
    })
  });
  const missingDir = path.join(os.tmpdir(), `codex-missing-${Date.now()}`);

  await assert.rejects(
    () => runner.runEpicDecoder({
      role: "epicDecoder",
      cwd: missingDir,
      prompt: "No workspace"
    }),
    (error: unknown) => error instanceof CodexLaunchError && error.kind === "invalid_cwd"
  );
});

test("CodexRunner extracts epic reviewer FINAL_JSON even with noisy stderr", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-review-"));
  const runner = new CodexRunner({
    spawnImpl: ((command: string, args: string[], options: Record<string, unknown>) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      void command;
      void args;
      void options;
      process.nextTick(() => {
        child.stderr.write("warn: plugin sync failed\n");
        child.stdout.write('<FINAL_JSON>{"verdict":"approved","summary":"Review passed","followupTickets":[]}</FINAL_JSON>');
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0);
      });
      return child as any;
    }) as any
  });

  const result = await runner.runEpicReviewer({
    role: "epicReviewer",
    cwd,
    prompt: "Review the epic result and return final JSON."
  });

  assert.equal(result.verdict, "approved");
  assert.equal(result.summary, "Review passed");
  assert.deepEqual(result.followupTickets, []);
});
