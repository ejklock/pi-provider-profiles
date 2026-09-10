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
 * the `model` this extension writes into the `Agent` tool call is honoured. An
 * explicit `model` the orchestrator already set is never overwritten.
 *
 * Selection order: `--profile <name>` flag > `PI_PROFILE` env > registry
 * `defaultProfile`. The `/profile` command lists profiles, shows the active
 * one, and switches the session model live (sub-agents follow the active
 * profile on their next spawn).
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

export default function (pi: ExtensionAPI) {
	let registry: ProfileRegistry | null = null;
	let activeName = "";
	let active: Profile | undefined;

	const reload = (cwd?: string): void => {
		registry = loadRegistry(getAgentDir(), cwd);
	};

	const names = (): string[] => Object.keys(registry?.profiles ?? {});

	/** Selected profile name: --profile flag > PI_PROFILE env > registry default. */
	const selectedName = (): string => {
		const flag = pi.getFlag("profile");
		const fromFlag = typeof flag === "string" ? flag.trim() : "";
		const fromEnv = (process.env.PI_PROFILE ?? "").trim();
		return fromFlag || fromEnv || registry?.defaultProfile || "";
	};

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
		const name = selectedName();
		if (name) await activate(ctx, name);
	});

	// Inject the per-role sub-agent model at dispatch. Only when a profile is
	// active, the role is pinned, and the caller did not already choose a model.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "Agent" || !active) return;
		const input = event.input as Record<string, unknown>;
		if (typeof input.model === "string" && input.model.trim()) return;
		const role = typeof input.subagent_type === "string" ? input.subagent_type : "";
		if (!role) return;
		const pin = resolveAgentModel(active, role);
		if (pin) input.model = pin;
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
