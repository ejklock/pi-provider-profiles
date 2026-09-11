/**
 * pi-provider-profiles — native pi profiles (one per provider).
 *
 * A profile from `pi-profiles.json` sets the session (main-loop) model and, at
 * every `Agent` dispatch, injects the sub-agent's per-role model. This is the
 * native counterpart to the Docker pi variants: no agent-home overlay, no
 * launcher env — everything happens in-process.
 *
 * How the sub-agent injection works: the `Agent` tool resolves a spawn's model
 * as `frontmatter model ?? caller-supplied model ?? parent(session) model`
 * (@tintinweb/pi-subagents, invocation-config.ts). Native pi agents therefore
 * carry NO `model:` frontmatter (models live in `pi-profiles.json` instead), so
 * the authoritative `model` this extension writes into the `Agent` tool call is
 * honoured. A profile pin replaces a caller-supplied model for the same role.
 *
 * Selection order: `--profile <name>` flag > `PI_PROFILE` env > registry
 * `defaultProfile`. An implicit default does not replace a different model
 * already selected for a child or explicitly configured session. The `/profile`
 * command lists profiles, shows the active one, and switches the session model
 * live (sub-agents follow the active profile on their next spawn).
 *
 * A profile may also declare `account`, naming a saved AuthStorage credential
 * `<provider>.profile.<account>` (e.g. a second GitHub Copilot login). On
 * activation `applyAccount` copies that credential into the active
 * `<provider>` key before the session model is applied — see
 * pi-copilot-account-switcher, whose `login`/`use` subcommands save and
 * restore those credentials.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	loadRegistry,
	type Profile,
	type ProfileRegistry,
	resolveAgentModel,
	resolveSessionModel,
} from "./profiles.ts";

/**
 * Account switching — structural types mirroring AuthStorage, no concrete Pi
 * import (pi-copilot-account-switcher, handleUseSubcommand).
 */

/** Opaque credential value stored in AuthStorage. */
export type AuthCredential = Record<string, unknown>;

/** Minimal structural slice of AuthStorage needed to switch the active credential. */
export interface MinimalAuthStorage {
	get(key: string): AuthCredential | undefined;
	set(key: string, credential: AuthCredential): void;
}

/** Minimal structural slice of ModelRegistry needed by applyAccount. */
export interface MinimalModelRegistry {
	authStorage: MinimalAuthStorage;
	refresh(): void;
}

/** Minimal structural context needed by applyAccount. */
export interface AccountActivationContext {
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
	modelRegistry: MinimalModelRegistry;
}

/**
 * Apply the active profile's authoritative model to an Agent tool input.
 *
 * @param profile - The active profile.
 * @param input - The mutable Agent tool input.
 * @returns The applied role and model, plus a replaced caller model when present.
 */
export function applyAgentModel(
	profile: Profile,
	input: Record<string, unknown>,
): { role: string; model: string; replacedModel?: string } | undefined {
	const role = typeof input.subagent_type === "string" ? input.subagent_type.trim() : "";
	if (!role) return undefined;
	const model = resolveAgentModel(profile, role);
	if (!model) return undefined;
	const currentModel = typeof input.model === "string" ? input.model.trim() : "";
	input.model = model;
	return {
		role,
		model,
		...(currentModel && currentModel !== model ? { replacedModel: currentModel } : {}),
	};
}

/**
 * Decide whether session startup can apply a profile without replacing a selected model.
 *
 * @param profile - The candidate session profile.
 * @param explicitlySelected - Whether a flag or environment value selected the profile.
 * @param currentModel - The model already selected for the session.
 * @returns `true` when the profile can set the session model.
 */
export function shouldApplySessionProfile(
	profile: Profile,
	explicitlySelected: boolean,
	currentModel: { provider: string; id: string } | undefined,
): boolean {
	return explicitlySelected
		|| currentModel === undefined
		|| (currentModel.provider === profile.provider && currentModel.id === profile.model);
}

/** AuthStorage key for a profile's saved account credential. */
function profileAccountAuthKey(provider: string, account: string): string {
	return `${provider}.profile.${account}`;
}

/**
 * Copy the saved `${provider}.profile.${account}` credential into the active
 * `${provider}` AuthStorage key and refresh the model registry, so the
 * session and every sub-agent authenticate as that account. A profile
 * without `account` is a no-op. When no credential is saved at the expected
 * key, warns with the one-time login command and leaves the active
 * credential unchanged.
 */
export function applyAccount(ctx: AccountActivationContext, profile: Profile): void {
	if (!profile.account) return;
	const key = profileAccountAuthKey(profile.provider, profile.account);
	const credential = ctx.modelRegistry.authStorage.get(key);
	if (!credential) {
		ctx.ui.notify(
			`profile: no saved '${profile.provider}' credential for account '${profile.account}' (expected '${key}'). Run '/copilot-profile login ${profile.account}' once, then retry.`,
			"warning",
		);
		return;
	}
	ctx.modelRegistry.authStorage.set(profile.provider, credential);
	ctx.modelRegistry.refresh();
}

export default function (pi: ExtensionAPI) {
	let registry: ProfileRegistry | null = null;
	let activeName = "";
	let active: Profile | undefined;

	const reload = (cwd?: string): void => {
		registry = loadRegistry(getAgentDir(), cwd);
	};

	const names = (): string[] => Object.keys(registry?.profiles ?? {});

	/** Explicit profile name: --profile flag > PI_PROFILE env. */
	const explicitSelectedName = (): string => {
		const flag = pi.getFlag("profile");
		const fromFlag = typeof flag === "string" ? flag.trim() : "";
		const fromEnv = (process.env.PI_PROFILE ?? "").trim();
		return fromFlag || fromEnv;
	};

	/** Selected profile name: explicit selection > registry default. */
	const selectedName = (): string => explicitSelectedName() || registry?.defaultProfile || "";

	const applySessionModel = async (ctx: ExtensionContext): Promise<void> => {
		if (!active) return;
		const { provider, model } = resolveSessionModel(active);
		const resolved = ctx.modelRegistry.find(provider, model);
		if (!resolved) {
			ctx.ui.notify(`profile '${activeName}': session model ${provider}/${model} is not in the catalog`, "warning");
			return;
		}
		const ok = await pi.setModel(resolved);
		if (!ok) {
			ctx.ui.notify(`profile '${activeName}': provider '${provider}' has no configured auth — session model unchanged`, "warning");
		}
	};

	const activate = async (ctx: ExtensionContext, name: string): Promise<boolean> => {
		if (!registry) reload(ctx.cwd);
		const profile = registry?.profiles[name];
		if (!profile) {
			ctx.ui.notify(`profile: unknown '${name}' (available: ${names().join(", ") || "none"})`, "error");
			return false;
		}
		activeName = name;
		active = profile;
		applyAccount(ctx as unknown as AccountActivationContext, profile);
		await applySessionModel(ctx);
		ctx.ui.setStatus("profile", `⦿ ${name}`);
		return true;
	};

	pi.registerFlag("profile", {
		type: "string",
		description: "Activate a pi profile from pi-profiles.json (sets the session + sub-agent models).",
	});

	pi.on("session_start", async (_event, ctx) => {
		reload(ctx.cwd);
		if (!registry) return;
		const explicitName = explicitSelectedName();
		const name = selectedName();
		const profile = registry.profiles[name];
		if (!name || !profile || !shouldApplySessionProfile(profile, Boolean(explicitName), ctx.model)) return;
		await activate(ctx, name);
	});

	// Apply the profile pin at dispatch so a caller cannot drift to another model.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "Agent" || !active) return;
		const applied = applyAgentModel(active, event.input as Record<string, unknown>);
		if (!applied) return;
		ctx.ui.setStatus("profile", `⦿ ${activeName} · ${applied.role}: ${applied.model}`);
		if (applied.replacedModel) {
			ctx.ui.notify(
				`profile '${activeName}': ${applied.role} model ${applied.replacedModel} → ${applied.model}`,
				"info",
			);
		}
	});

	pi.registerCommand("profile", {
		description: "List pi profiles, show the active one, or switch: /profile [name]",
		getArgumentCompletions: (prefix) => {
			if (!registry) reload();
			return names()
				.filter((n) => n.startsWith(prefix))
				.map((n) => {
					const p = registry!.profiles[n];
					return { value: n, label: n, description: `${p.provider}/${p.model}` };
				});
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			reload(ctx.cwd);
			if (!registry) {
				ctx.ui.notify("profile: no pi-profiles.json found in the agent dir or project .pi/", "error");
				return;
			}
			const name = args.trim();
			if (!name) {
				const lines = names().map((n) => {
					const p = registry!.profiles[n];
					const mark = n === activeName ? "⦿" : " ";
					const tag = n === registry!.defaultProfile ? " (default)" : "";
					return `${mark} ${n}${tag} — ${p.provider}/${p.model}${p.description ? `  · ${p.description}` : ""}`;
				});
				ctx.ui.notify(`pi profiles:\n${lines.join("\n") || "  (none)"}\nactive: ${activeName || "(none)"}`, "info");
				return;
			}
			const ok = await activate(ctx, name);
			if (ok) {
				ctx.ui.notify(
					`profile → ${name}: session model set; sub-agents use this profile on their next spawn.`,
					"info",
				);
			}
		},
	});
}
