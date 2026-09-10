/**
 * profiles.test.ts — unit tests for the registry loader and model resolution.
 * Run with: npm test  (tsx --test src/*.test.ts)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadRegistry, type Profile, resolveAgentModel, resolveSessionModel } from "./profiles.ts";

const GPT: Profile = {
	provider: "openai-codex",
	model: "gpt-5.6-sol",
	agents: {
		coder: "gpt-5.6-terra",
		reviewer: "gpt-5.6-sol",
		vision: { provider: "llamaswap", model: "Qwen3-VL-8B" },
		blank: "",
	},
};

test("resolveSessionModel returns the profile provider/model", () => {
	assert.deepEqual(resolveSessionModel(GPT), { provider: "openai-codex", model: "gpt-5.6-sol" });
});

test("resolveAgentModel prefixes a bare pin with the profile provider", () => {
	assert.equal(resolveAgentModel(GPT, "coder"), "openai-codex/gpt-5.6-terra");
});

test("resolveAgentModel honours a cross-provider object pin", () => {
	assert.equal(resolveAgentModel(GPT, "vision"), "llamaswap/Qwen3-VL-8B");
});

test("resolveAgentModel returns undefined for an unpinned or blank role", () => {
	assert.equal(resolveAgentModel(GPT, "explorer"), undefined);
	assert.equal(resolveAgentModel(GPT, "blank"), undefined);
});

test("loadRegistry reads the agent-dir file and picks the default profile", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-profiles-"));
	fs.writeFileSync(
		path.join(dir, "pi-profiles.json"),
		JSON.stringify({ defaultProfile: "gpt", profiles: { gpt: GPT } }),
	);
	const reg = loadRegistry(dir);
	assert.ok(reg);
	assert.equal(reg?.defaultProfile, "gpt");
	assert.equal(reg?.profiles.gpt.provider, "openai-codex");
});

test("loadRegistry lets a project file override a profile by name", () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cwd-"));
	fs.writeFileSync(
		path.join(agentDir, "pi-profiles.json"),
		JSON.stringify({ defaultProfile: "gpt", profiles: { gpt: GPT } }),
	);
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "pi-profiles.json"),
		JSON.stringify({ profiles: { gpt: { provider: "anthropic", model: "claude-opus-4-8" } } }),
	);
	const reg = loadRegistry(agentDir, cwd);
	assert.equal(reg?.profiles.gpt.provider, "anthropic");
	assert.equal(reg?.defaultProfile, "gpt");
});

test("loadRegistry returns null when no registry exists", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-empty-"));
	assert.equal(loadRegistry(dir), null);
});
