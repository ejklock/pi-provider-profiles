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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension, {
	applyAccount,
	applyAgentModel,
	shouldApplySessionProfile,
	type AccountActivationContext,
	type AuthCredential,
} from "./index.ts";

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

test("applyAgentModel replaces a caller model with the active profile pin", () => {
	const input: Record<string, unknown> = {
		subagent_type: "coder",
		model: "anthropic/claude-opus-4-8",
	};

	const applied = applyAgentModel(GPT, input);

	assert.deepEqual(applied, {
		role: "coder",
		model: "openai-codex/gpt-5.6-terra",
		replacedModel: "anthropic/claude-opus-4-8",
	});
	assert.equal(input.model, "openai-codex/gpt-5.6-terra");
});

test("applyAgentModel leaves an unpinned role unchanged", () => {
	const input: Record<string, unknown> = {
		subagent_type: "explorer",
		model: "anthropic/claude-opus-4-8",
	};

	assert.equal(applyAgentModel(GPT, input), undefined);
	assert.equal(input.model, "anthropic/claude-opus-4-8");
});

test("shouldApplySessionProfile preserves a different model when the default profile is implicit", () => {
	const defaultProfile: Profile = { provider: "anthropic", model: "claude-opus-4-8" };
	assert.equal(
		shouldApplySessionProfile(defaultProfile, false, {
			provider: "openai-codex",
			id: "gpt-5.6-luna",
		}),
		false,
	);
});

test("shouldApplySessionProfile honours an explicitly selected profile", () => {
	const defaultProfile: Profile = { provider: "anthropic", model: "claude-opus-4-8" };
	assert.equal(
		shouldApplySessionProfile(defaultProfile, true, {
			provider: "openai-codex",
			id: "gpt-5.6-luna",
		}),
		true,
	);
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

test("loadRegistry preserves an `account` field on a profile", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-account-"));
	fs.writeFileSync(
		path.join(dir, "pi-profiles.json"),
		JSON.stringify({
			defaultProfile: "work",
			profiles: { work: { provider: "github-copilot", model: "gpt-5.6-sol", account: "work" } },
		}),
	);
	const reg = loadRegistry(dir);
	assert.equal(reg?.profiles.work.account, "work");
});

/** A structural AuthStorage mock: an in-memory credential map. */
function fakeContext(store: Record<string, AuthCredential>): {
	ctx: AccountActivationContext;
	notifications: Array<{ message: string; type?: string }>;
	refreshCount: () => number;
} {
	const notifications: Array<{ message: string; type?: string }> = [];
	let refreshCount = 0;
	const ctx: AccountActivationContext = {
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifications.push({ message, type });
			},
		},
		modelRegistry: {
			authStorage: {
				get: (key: string) => store[key],
				set: (key: string, credential: AuthCredential) => {
					store[key] = credential;
				},
			},
			refresh: () => {
				refreshCount += 1;
			},
		},
	};
	return { ctx, notifications, refreshCount: () => refreshCount };
}

const COPILOT_WORK: Profile = { provider: "github-copilot", model: "gpt-5.6-sol", account: "work" };
const COPILOT_DEFAULT: Profile = { provider: "github-copilot", model: "gpt-5.6-sol" };

test("applyAccount copies the saved credential into the active key and refreshes", () => {
	const credential = { token: "opaque" };
	const { ctx, refreshCount } = fakeContext({ "github-copilot.profile.work": credential });
	applyAccount(ctx, COPILOT_WORK);
	assert.equal(ctx.modelRegistry.authStorage.get("github-copilot"), credential);
	assert.equal(refreshCount(), 1);
});

test("applyAccount warns with the login command and leaves the active credential unchanged when no credential is saved", () => {
	const { ctx, notifications, refreshCount } = fakeContext({});
	applyAccount(ctx, COPILOT_WORK);
	assert.equal(ctx.modelRegistry.authStorage.get("github-copilot"), undefined);
	assert.equal(refreshCount(), 0);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]?.type, "warning");
	assert.match(notifications[0]?.message ?? "", /\/copilot-profile login work/);
});

test("applyAccount is a no-op when the profile does not declare `account`", () => {
	const { ctx, notifications, refreshCount } = fakeContext({ "github-copilot.profile.work": { token: "x" } });
	applyAccount(ctx, COPILOT_DEFAULT);
	assert.equal(ctx.modelRegistry.authStorage.get("github-copilot"), undefined);
	assert.equal(refreshCount(), 0);
	assert.equal(notifications.length, 0);
});

const FRONT_REGISTRY: { defaultProfile: string; profiles: Record<string, Profile> } = {
	defaultProfile: "go",
	profiles: {
		go: {
			provider: "anthropic",
			model: "claude-opus-4-8",
			agents: { coder: "claude-haiku-4-5", blank: "" },
		},
		"gpt-local": {
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			agents: { coder: { provider: "llamaswap", model: "Qwen3-VL-8B" } },
		},
		bare: { provider: "anthropic", model: "claude-sonnet-4-5" },
	},
};

interface FrontSessionOptions {
	currentModel?: { provider: string; id: string };
	setModelOk?: boolean;
	find?: (provider: string, modelId: string) => { provider: string; modelId: string } | undefined;
}

/**
 * Drive the extension's session_start handler against a stubbed host, with the
 * fixture registry as a project-local override in a temporary cwd. The stubbed
 * modelRegistry hands out a per-pair object, so every setModel receipt
 * identifies the provider/model the extension resolved.
 */
async function startFrontSession(
	flags: Record<string, string>,
	options: FrontSessionOptions = {},
): Promise<{
	setModelCalls: unknown[];
	notifications: Array<{ message: string; type?: string }>;
	statuses: Array<[string, string | undefined]>;
}> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-front-"));
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "pi-profiles.json"), JSON.stringify(FRONT_REGISTRY));

	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const setModelCalls: unknown[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Array<[string, string | undefined]> = [];

	const piStub = {
		getFlag: (name: string) => flags[name],
		registerFlag: () => {},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) => {
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand: () => {},
		setModel: async (model: unknown) => {
			setModelCalls.push(model);
			return options.setModelOk ?? true;
		},
	} as unknown as ExtensionAPI;

	extension(piStub);

	const ctxStub = {
		cwd,
		model: options.currentModel,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifications.push({ message, type });
			},
			setStatus: (key: string, text: string | undefined) => {
				statuses.push([key, text]);
			},
		},
		modelRegistry: {
			find: (provider: string, modelId: string) =>
				options.find ? options.find(provider, modelId) : { provider, modelId },
		},
	} as unknown as ExtensionContext;

	const handler = handlers.get("session_start");
	assert.ok(handler, "the extension registered a session_start handler");
	const previousProfile = process.env.PI_PROFILE;
	process.env.PI_PROFILE = "";
	try {
		await handler({ type: "session_start", reason: "startup" }, ctxStub);
	} finally {
		if (previousProfile === undefined) delete process.env.PI_PROFILE;
		else process.env.PI_PROFILE = previousProfile;
	}
	return { setModelCalls, notifications, statuses };
}

/** The first warning the session produced, asserted to exist. */
function theWarning(notifications: Array<{ message: string; type?: string }>): string {
	const warn = notifications.find((n) => n.type === "warning");
	assert.ok(warn, `expected a warning, got: ${JSON.stringify(notifications)}`);
	return warn?.message ?? "";
}

test("a front launch binds the profile's pinned model for the role at session_start", async () => {
	const { setModelCalls, statuses } = await startFrontSession({ profile: "go", front: "coder" });

	assert.equal(setModelCalls.length, 2);
	assert.deepEqual(setModelCalls[0], { provider: "anthropic", modelId: "claude-opus-4-8" });
	assert.deepEqual(setModelCalls.at(-1), { provider: "anthropic", modelId: "claude-haiku-4-5" });
	assert.deepEqual(statuses.at(-1), ["profile", "⦿ go · front coder"]);
});

test("an unknown front role keeps the session model and names the roles the profile pins", async () => {
	const { setModelCalls, notifications } = await startFrontSession({ profile: "go", front: "architect" });

	assert.equal(setModelCalls.length, 1);
	assert.deepEqual(setModelCalls.at(-1), { provider: "anthropic", modelId: "claude-opus-4-8" });
	assert.match(theWarning(notifications), /front role 'architect' is not pinned/);
	assert.match(theWarning(notifications), /coder/);
});

test("a front launch on a profile without agent pins keeps the session model and reports none", async () => {
	const { setModelCalls, notifications } = await startFrontSession({ profile: "bare", front: "coder" });

	assert.equal(setModelCalls.length, 1);
	assert.deepEqual(setModelCalls.at(-1), { provider: "anthropic", modelId: "claude-sonnet-4-5" });
	assert.match(theWarning(notifications), /front role 'coder' is not pinned/);
	assert.match(theWarning(notifications), /none/);
});

test("a front role pinned as a cross-provider object binds the overriding provider", async () => {
	const { setModelCalls } = await startFrontSession({ profile: "gpt-local", front: "coder" });

	assert.equal(setModelCalls.length, 2);
	assert.deepEqual(setModelCalls.at(-1), { provider: "llamaswap", modelId: "Qwen3-VL-8B" });
});

test("a front launch without a profile flag still binds the role pin over a host-selected model", async () => {
	const { setModelCalls } = await startFrontSession(
		{ front: "coder" },
		{ currentModel: { provider: "openai-codex", id: "gpt-5.6-luna" } },
	);

	assert.deepEqual(setModelCalls.at(-1), { provider: "anthropic", modelId: "claude-haiku-4-5" });
});

test("without a front flag the session binding is unchanged", async () => {
	const { setModelCalls, notifications, statuses } = await startFrontSession({ profile: "go" });

	assert.equal(setModelCalls.length, 1);
	assert.deepEqual(setModelCalls.at(-1), { provider: "anthropic", modelId: "claude-opus-4-8" });
	assert.equal(notifications.length, 0);
	assert.deepEqual(statuses.at(-1), ["profile", "⦿ go"]);
});

test("a blank agent pin is unpinned for a front launch", async () => {
	const { setModelCalls, notifications } = await startFrontSession({ profile: "go", front: "blank" });

	assert.equal(setModelCalls.length, 1);
	assert.match(theWarning(notifications), /front role 'blank' is not pinned/);
	assert.match(theWarning(notifications), /pinned roles: coder/);
});

test("a front pin missing from the catalog warns and keeps the session model", async () => {
	const { setModelCalls, notifications } = await startFrontSession(
		{ profile: "go", front: "coder" },
		{ find: (provider, modelId) => (modelId === "claude-haiku-4-5" ? undefined : { provider, modelId }) },
	);

	assert.equal(setModelCalls.length, 1);
	assert.deepEqual(setModelCalls.at(-1), { provider: "anthropic", modelId: "claude-opus-4-8" });
	assert.match(theWarning(notifications), /front model anthropic\/claude-haiku-4-5 .*is not in the catalog/);
});

test("a front pin whose provider has no configured auth warns and keeps the session model", async () => {
	const { setModelCalls, notifications } = await startFrontSession(
		{ profile: "go", front: "coder" },
		{ setModelOk: false },
	);

	assert.deepEqual(setModelCalls.at(-1), { provider: "anthropic", modelId: "claude-haiku-4-5" });
	assert.ok(
		notifications.some((n) => n.type === "warning" && /no configured auth.*front model unchanged/.test(n.message)),
		`expected a front no-auth warning, got: ${JSON.stringify(notifications)}`,
	);
});
