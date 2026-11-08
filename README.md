# Command Optimizer

A Claude Code mod that works like Effort Optimizer, but for commands. After you press Enter, Sonnet reads your prompt **before Claude starts** and, when a command would help, asks:

> Sonnet suggests /plan (Multi-file auth refactor benefits from planning); !npm test (Run the auth tests first). Run one before Claude starts?
>
> `/plan, then my prompt` · `Run !npm test first` · `Just send my prompt`

- Pick a **slash command** (`/plan`, `/effort high`, `/clear`, `/compact`, a plugin's command…): it runs, then your prompt is sent right after it.
- Pick a **shell command** (`!npm test`, `!git status`…): Claude runs it first (through the normal permission prompt) and uses its output.
- **Just send my prompt**, or close the dialog: the prompt goes in unchanged.

When nothing would help, Sonnet says so and your prompt goes straight through.

## Works alongside other mods

- **Effort Optimizer:** it already picks the effort level, so this mod never suggests `/effort` while it's installed. After a command you picked runs, your prompt goes back into the box: press Enter and Effort Optimizer checks it as usual (this mod doesn't check it twice). Without Effort Optimizer the prompt is sent for you.
- **The `/mods` switchboard:** setting `"command-optimizer": false` in `~/.claude/mods/switches.json` turns this mod off, the same switch Effort Optimizer uses.
- **Other mods' commands:** any slash command a plugin adds can be suggested, and the band above the prompt stacks under other mods' bands instead of replacing them.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install command-optimizer --marketplace acus9345/command-optimizer
```

Answer `y` to add the marketplace, then pick a scope (user scope is first; press Enter).

From a shell:

```bash
claude plugin install command-optimizer --marketplace acus9345/command-optimizer
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `acus9345/command-optimizer`, then **Add plugin**.

## How it works

- **Checks before Claude starts (default `ask` mode).** The check takes a second or two; the status line says "Sonnet is checking for useful commands…" meanwhile. Prefer no wait? `band` mode checks alongside the turn and shows suggestions above the prompt instead.
- **Reads the conversation.** Your last 3 prompts and the start of Claude's last reply go with the check, so "yes, do that" after a plan gets the right suggestion.
- **Only your own prompts.** Slash commands, `!` shell escapes, short replies (`yes`, `continue`, …), task notifications and messages from other sessions are skipped, so they cost nothing.
- **No made-up commands.** Slash suggestions are checked against the commands your session actually has (built-in, plugin and MCP); anything else is dropped. The model may also return no suggestions when none would help.
- **Cheap repeats.** The fixed rubric and command catalog are sent first and marked for the prompt cache, and identical prompt + history checks are served from an in-memory cache.
- **Session-aware.** The last 3 prompts are included so suggestions follow your workflow (planning → coding → testing → `/diff` / `/review`).

## Commands

| Command | What it does |
| --- | --- |
| `/command-optimizer` | Status: mode, model, checks, memo hits, prompt-cache reads |
| `/command-optimizer ask` | After Enter, offer to run a command before Claude starts (default) |
| `/command-optimizer band` | Suggest above the prompt alongside the turn, never waiting |
| `/command-optimizer 1` / `2` / `3` | In `band` mode, fill suggestion 1–3 into the prompt box |
| `/command-optimizer off` / `on` | Turn checking off or on (remembered across sessions) |

## Options

Set in the config menu or under `pluginConfigs` in settings:

- `model`: `sonnet` (default), `haiku` (cheapest) or `opus`.
- `defaultMode`: `ask` (default) or `band`.

Each check is one small model call billed to your session's credentials. Switch to `haiku`, or turn the mod off, if you want it cheaper.

## Alternative: classic `UserPromptSubmit` hook

`scripts/suggest-commands-hook.mjs` is a standalone version for setups that use settings hooks instead of mods. It calls the Anthropic API when `ANTHROPIC_API_KEY` is set (model from `CMD_OPTIMIZER_MODEL`, default `claude-sonnet-5-5`), otherwise `claude -p --model sonnet`, and shows suggestions as a system message. Register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/command-optimizer/scripts/suggest-commands-hook.mjs\"",
            "timeout": 15,
            "statusMessage": "Checking recommended commands..."
          }
        ]
      }
    ]
  }
}
```

Unlike the mod, this hook runs before your turn starts, so it adds the check's latency to every prompt.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
claude --plugin-dir .
```

```text
command-optimizer/
├── .claude-plugin/
│   ├── plugin.json                # Manifest and userConfig options
│   └── marketplace.json           # Makes this repo installable with /plugin install
├── hooks/
│   ├── hooks.json                 # Names the hooks module
│   └── register.js                # The mod
├── scripts/
│   └── suggest-commands-hook.mjs  # Standalone UserPromptSubmit hook
└── tests/
    └── command-optimizer.test.ts  # Tests for `claude plugin test`
```

## License

MIT
