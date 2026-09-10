/**
 * profiles.ts — load and resolve the native pi profile registry.
 *
 * The registry (`pi-profiles.json`, one entry per provider) is the SSOT for the
 * session model and every sub-agent model. It lives in the agent dir
 * (`~/.pi/agent/pi-profiles.json`), with an optional project-local override at
 * `<cwd>/.pi/pi-profiles.json` that wins per profile name.
 *
 * Model resolution is pure string work: an `agents[<role>]` value is either a
 * bare model id resolved under the profile-level `provider`, or an object
 * `{ provider, model }` to cross providers. `resolveAgentModel` returns the
 * `provider/model` string the `Agent` tool understands, or `undefined` when the
 * profile does not define that role (the caller then leaves the dispatch alone).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** A per-role model pin: a bare model id or a cross-provider { provider, model }. */
export type AgentPin = string | { provider?: string; model: string };

export interface Profile {
	description?: string;
	/** Provider for the session model and the default provider for every role pin. */
	provider: string;
	/** Session (main-loop) model id, resolved under `provider`. */
	model: string;
	/** Per-role sub-agent model pins, keyed by `subagent_type`. */
	agents?: Record<string, AgentPin>;
}

export interface ProfileRegistry {
	/** Profile applied when none is selected. Must be a key of `profiles`. */
	defaultProfile: string;
	profiles: Record<string, Profile>;
}

/** A resolved `provider/model` pair. */
export interface ResolvedModel {
	provider: string;
	model: string;
}

function readJson(file: string): unknown | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

function isProfile(value: unknown): value is Profile {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	return typeof p.provider === "string" && typeof p.model === "string";
}

function coerceRegistry(value: unknown): ProfileRegistry | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const profilesRaw = raw.profiles;
	if (!profilesRaw || typeof profilesRaw !== "object") return null;

	const profiles: Record<string, Profile> = {};
	for (const [name, prof] of Object.entries(profilesRaw as Record<string, unknown>)) {
		if (isProfile(prof)) profiles[name] = prof as Profile;
	}
	if (Object.keys(profiles).length === 0) return null;

	const requested = typeof raw.defaultProfile === "string" ? raw.defaultProfile : "";
	const defaultProfile = profiles[requested] ? requested : (profiles.default ? "default" : Object.keys(profiles)[0]);
	return { defaultProfile, profiles };
}

/**
 * Load the registry from the agent dir, merging a project-local override when
 * present. Project profiles win per name; the default-profile pointer comes
 * from the project file when it declares one, else the agent-dir file.
 * Returns `null` when neither file yields a usable registry.
 */
export function loadRegistry(agentDir: string, cwd?: string): ProfileRegistry | null {
	const base = coerceRegistry(readJson(path.join(agentDir, "pi-profiles.json")));
	const local = cwd ? coerceRegistry(readJson(path.join(cwd, ".pi", "pi-profiles.json"))) : null;

	if (!base && !local) return null;
	if (!local) return base;
	if (!base) return local;

	const merged: Record<string, Profile> = { ...base.profiles, ...local.profiles };
	const defaultProfile = merged[local.defaultProfile]
		? local.defaultProfile
		: merged[base.defaultProfile]
			? base.defaultProfile
			: Object.keys(merged)[0];
	return { defaultProfile, profiles: merged };
}

/** The session (main-loop) model for a profile. */
export function resolveSessionModel(profile: Profile): ResolvedModel {
	return { provider: profile.provider, model: profile.model };
}

/**
 * The `provider/model` string for a sub-agent role, or `undefined` when the
 * profile does not pin that role. A bare-string pin inherits the profile
 * provider; an object pin may override it.
 */
export function resolveAgentModel(profile: Profile, role: string): string | undefined {
	const pin = profile.agents?.[role];
	if (pin === undefined) return undefined;
	if (typeof pin === "string") {
		if (!pin.trim()) return undefined;
		return `${profile.provider}/${pin}`;
	}
	if (!pin.model?.trim()) return undefined;
	return `${pin.provider ?? profile.provider}/${pin.model}`;
}
