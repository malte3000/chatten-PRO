import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/pattern-analysis.js", import.meta.url));

test("pattern analysis CLI help documents data and cost assumptions", () => {
  const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /splittar\/utdelningar/);
  assert.match(result.stdout, /--spread-bps/);
  assert.match(result.stdout, /TIE/);
});

test("pattern analysis CLI requires explicit execution assumptions", () => {
  const result = spawnSync(process.execPath, [script, "--input", "x.json", "--output", "y.json"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Obligatoriska parametrar saknas/);
});

test("pattern analysis CLI creates a combined deterministic research report without overwriting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pattern-cli-"));
  try {
    const input = join(directory, "input.json");
    const output = join(directory, "report.json");
    const bars = Array.from({ length: 85 }, (_, index) => {
      const base = index < 35 ? 100 + index * 0.2 : index === 35 ? 88 : 88 + (index - 35) * 0.3;
      return { datetime: `2026-${String(1 + Math.floor(index / 28)).padStart(2, "0")}-${String(1 + index % 28).padStart(2, "0")}`, open: base, high: base * 1.02, low: base * 0.98, close: base, volume: 1000 + index };
    });
    await writeFile(input, JSON.stringify([{ ticker: "TEST", bars }]), "utf8");
    const args = [script, "--input", input, "--output", output, "--window", "30", "--threshold", "10", "--horizon", "20", "--recovery-target", "5", "--continuation-target", "3", "--quantity", "2", "--fee", "1", "--slippage-bps", "10", "--spread-bps", "5"];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.status, "COMPLETED");
    assert.equal(report.patternDiscovery.version, "pattern-discovery-v0.1");
    assert.equal(report.eventBacktest.version, "event-backtest-v0.1");
    assert.ok(report.patternDiscovery.events.length > 0);
    const second = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /finns redan/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
