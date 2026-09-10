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
- `defaultProfile` — applied when no profile is chosen.

## How sub-agent injection works

The `Agent` tool resolves a spawn's model as
`frontmatter model ?? caller model ?? parent(session) model`
(`@tintinweb/pi-subagents`, `invocation-config.ts`). So your pi agents must
carry **no `model:` frontmatter** — the models live in `pi-profiles.json`
instead — and this extension writes the per-role `model` into each `Agent` tool
call, where it is honoured. An explicit `model` the orchestrator already set is
never overwritten.

## Caveats

- The models are owned by this extension. If it fails to load, sub-agents fall
  back to the **session model** (silent degradation), not their per-role model.
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
