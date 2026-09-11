# pi-provider-profiles

Native [pi](https://github.com/earendil-works/pi) profiles — **one per provider**.
Start pi under a named profile and it sets the **session model** and every
**sub-agent model** from a single `pi-profiles.json`. This is the native,
in-process counterpart to the Docker pi variants — no agent-home overlay, no
launcher env.

## Install

```bash
pi install git:github.com/ejklock/pi-provider-profiles
```

Then create the registry at `~/.pi/agent/pi-profiles.json` (see below). A
project-local `<cwd>/.pi/pi-profiles.json` overrides it per profile name.

## Invocation

- `pi --profile gpt` — native CLI flag (registered by this extension).
- `pi profile gpt` — a thin shell wrapper mapping to `--profile` (optional; e.g.
  installed by your dotfiles / installer).
- `/profile` — in a running session: list profiles + show the active one.
- `/profile gpt` — switch the session model live; sub-agents follow the active
  profile on their next spawn.

Selection order: `--profile` flag > `PI_PROFILE` env > registry `defaultProfile`.

## Registry — `pi-profiles.json`

```json
{
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "description": "Anthropic per-role matrix.",
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "agents": {
        "coder": "claude-sonnet-5",
        "reviewer": "claude-sonnet-4-6",
        "explorer": "claude-haiku-4-5",
        "quality-gate": "claude-haiku-4-5",
        "advisor": "claude-opus-4-8"
      }
    },
    "gpt": {
      "description": "OpenAI Codex — GPT-5.6 tiers.",
      "provider": "openai-codex",
      "model": "gpt-5.6-sol",
      "agents": {
        "coder": "gpt-5.6-terra",
        "reviewer": "gpt-5.6-sol",
        "explorer": "gpt-5.6-luna",
        "quality-gate": "gpt-5.6-luna",
        "advisor": "gpt-5.6-sol"
      }
    }
  }
}
```

- `provider` / `model` — the session (main-loop) model.
- `agents[<role>]` — keyed by `subagent_type`. A bare string is a model id
  resolved under the profile `provider`; use `{ "provider": "...", "model": "..." }`
  to cross providers.
- `account` — optional. Names a saved AuthStorage credential
  `<provider>.profile.<account>` to activate instead of the provider's default
  credential (e.g. a second GitHub Copilot account). See below.
- `defaultProfile` — applied when no profile is chosen.

## Per-profile account (`account`)

A profile can pin a specific saved credential instead of whatever is
currently active for its `provider`:

```json
{
  "work-copilot": {
    "description": "GitHub Copilot — work account.",
    "provider": "github-copilot",
    "model": "gpt-5.6-sol",
    "account": "work"
  }
}
```

On activation, this extension copies the credential saved at
`github-copilot.profile.work` into the active `github-copilot` AuthStorage
key and refreshes the model registry, before the session model is applied.

The credential must be saved once, ahead of time, with
[pi-copilot-account-switcher](https://github.com/ejklock/pi-copilot-account-switcher):

```bash
/copilot-profile login work   # or: /copilot-profile save-current work
```

If no credential is saved at the expected key, activation warns with that
same command and leaves the active credential unchanged — it never throws
and never writes tokens to `pi-profiles.json` or any log.

A profile without `account` behaves exactly as before (no AuthStorage
mutation).

## How sub-agent injection works

The `Agent` tool resolves a spawn's model as
`frontmatter model ?? caller model ?? parent(session) model`
(`@tintinweb/pi-subagents`, `invocation-config.ts`). So your pi agents must
carry **no `model:` frontmatter** — the models live in `pi-profiles.json`
instead — and this extension writes the per-role `model` into each `Agent` tool
call, where it is honoured. A profile pin is authoritative: it replaces an
explicit `model` supplied by the orchestrator for the same role. When that
happens, the extension shows an informational notification with the old and new
models. The profile status also shows the role and model applied to the latest
`Agent` dispatch.

## Caveats

- The models are owned by this extension. If it fails to load, sub-agents fall
  back to the **session model** (silent degradation), not their per-role model.
- Agent-file `model:` frontmatter still outranks tool-call input inside
  `@tintinweb/pi-subagents`. Native agents must not declare that field; the
  extension cannot replace a frontmatter pin.
- Sub-agents spawned by `/workflows` or nested spawns may inherit the session
  model rather than the per-role pin — the injection covers the standard `Agent`
  dispatch path.
- `/profile <name>` mid-session re-points the **session** model immediately;
  already-running sub-agents keep the model they started with.

## Develop

```bash
npm install
npm test        # tsx --test src/*.test.ts
npm run typecheck
```

## License

MIT © Evaldo Klock
