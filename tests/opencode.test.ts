import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { OpenCodeLaunchError, OpenCodeRunner } from "../src/orchestration/opencode.ts";

function createSpawnStub(
  assertLaunch: (command: string, args: string[], options: Record<string, unknown>) => void,
  output = '<FINAL_JSON>{"summary":"ok","sessionId":"session-test"}</FINAL_JSON>'
) {
  return ((command: string, args: string[], options: Record<string, unknown>) => {
    assertLaunch(command, args, options);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.write(output);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
    });
    return child as any;
  }) as any;
}

test("OpenCodeRunner launches the package entrypoint through node without a shell", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "opencode-cwd-"));
  const launches: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const runner = new OpenCodeRunner({
    spawnImpl: createSpawnStub((command, args, options) => {
      launches.push({ command, args, options });
    })
  });

  const result = await runner.runBuilder({
    role: "builder",
    cwd,
    prompt: "Make a tiny change."
  });

  assert.equal(result.sessionId, "session-test");
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, process.execPath);
  assert.match(launches[0].args[0], /node_modules[\\/]+opencode-ai[\\/]+bin[\\/]+opencode$/);
  assert.equal(launches[0].args.includes("--prompt"), false);
  assert.equal(typeof launches[0].args[launches[0].args.length - 1], "string");
  assert.equal(launches[0].options.shell, undefined);
  assert.equal(result.launchInfo?.shell, false);
  assert.equal(result.launchInfo?.binarySource, "package-entrypoint");
});

test("OpenCodeRunner rejects an invalid cwd before spawning", async () => {
  const runner = new OpenCodeRunner({
    spawnImpl: createSpawnStub(() => {
      throw new Error("spawn should not run");
    })
  });
  const missingDir = path.join(os.tmpdir(), `does-not-exist-${Date.now()}`);

  await assert.rejects(
    () => runner.runBuilder({
      role: "builder",
      cwd: missingDir,
      prompt: "No workspace"
    }),
    (error: unknown) => error instanceof OpenCodeLaunchError && error.kind === "invalid_cwd"
  );
});

test("OpenCodeRunner reports a missing OPENCODE_BIN override clearly", async () => {
  const original = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = path.join(os.tmpdir(), `missing-opencode-${Date.now()}.js`);
  const runner = new OpenCodeRunner({
    spawnImpl: createSpawnStub(() => {
      throw new Error("spawn should not run");
    })
  });

  try {
    await assert.rejects(
      () => runner.runBuilder({
        role: "builder",
        cwd: process.cwd(),
        prompt: "No override"
      }),
      (error: unknown) => error instanceof OpenCodeLaunchError && error.kind === "missing_binary"
    );
  } finally {
    if (original === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = original;
  }
});

test("OpenCodeRunner extracts the final JSON payload from noisy output", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "opencode-noisy-"));
  const noisyOutput = [
    "[stderr]",
    "Error: invalid tool arguments: {\"expected\":\"string\"}",
    "I'll create the requested file now.",
    "<FINAL_JSON>{\"summary\":\"Created launch-verify-2.txt\",\"sessionId\":\"session-noisy\"}</FINAL_JSON>",
    "completed"
  ].join("\n");
  const runner = new OpenCodeRunner({
    spawnImpl: createSpawnStub(() => {}, noisyOutput)
  });

  const result = await runner.runBuilder({
    role: "builder",
    cwd,
    prompt: "Create the file"
  });

  assert.equal(result.summary, "Created launch-verify-2.txt");
  assert.equal(result.sessionId, "session-noisy");
});

test("OpenCodeRunner prefers the last valid final payload over earlier JSON noise", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "opencode-noisy-"));
  const noisyOutput = [
    "{\"expected\":\"string\",\"code\":\"invalid_type\"}",
    "Assistant chatter before the real answer.",
    "{\"summary\":\"Final builder summary\",\"sessionId\":\"session-final\"}"
  ].join("\n");
  const runner = new OpenCodeRunner({
    spawnImpl: createSpawnStub(() => {}, noisyOutput)
  });

  const result = await runner.runBuilder({
    role: "builder",
    cwd,
    prompt: "Create the file"
  });

  assert.equal(result.summary, "Final builder summary");
  assert.equal(result.sessionId, "session-final");
});
