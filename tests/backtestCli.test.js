import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../scripts/backtest.js", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10000 });

test("offline CLI help describes simulation and explicit costs without requiring files", () => {
  const result = run("--help");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /endast simulering/);
  assert.match(result.stdout, /Inga nätverksanrop/);
  assert.match(result.stdout, /måste anges uttryckligen/);
  assert.match(result.stdout, /--benchmark-ticker/);
  assert.equal(result.stderr, "");
});

test("offline CLI rejects omitted execution assumptions before reading input", () => {
  const result = run("--input", "does-not-exist.json", "--output", "unused-report.json", "--market", "usa", "--setup", "BREAKOUT", "--holding", "3", "--quantity", "10");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Obligatoriska parametrar saknas: --fee, --slippage-bps, --as-of/);
  assert.doesNotMatch(result.stderr, /Kunde inte läsa/);
  assert.equal(result.stdout, "");
});

test("offline CLI saves invalid-data diagnostics but preserves an existing output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "swing-replay-cli-"));
  const input = join(directory, "input.json");
  const output = join(directory, "report.json");
  try {
    await writeFile(input, JSON.stringify({ ticker: "AAPL", currency: "USD", interval: "1day", bars: [] }));
    const args = ["--input", input, "--output", output, "--market", "usa", "--setup", "BREAKOUT", "--holding", "3", "--quantity", "10", "--fee", "1", "--slippage-bps", "5", "--as-of", "2026-09-29T23:00:00Z"];
    const invalid = run(...args);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Diagnostik sparad/);
    const contents = await readFile(output, "utf8");
    const report = JSON.parse(contents);
    assert.equal(report.status, "INVALID");
    assert.equal(report.simulation, true);
    assert.equal(report.runConfig.marketContextMode, "off");
    const duplicate = run(...args);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /finns redan/);
    assert.equal(await readFile(output, "utf8"), contents);
  } finally {
    // Only the two named files in the directory allocated by mkdtemp are removed.
    await unlink(input).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await unlink(output).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
});
