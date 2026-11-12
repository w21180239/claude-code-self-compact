# AGENTS.md

How a coding agent works in this repository. Humans can read it too.

## Layout

- `.claude-plugin/marketplace.json`: the marketplace; one plugin, `self-compact`, sourced from `./plugins/self-compact`.
- `plugins/self-compact/`: the plugin. `.claude-plugin/plugin.json` (manifest, version, `userConfig`), `hooks/hooks.json` + `hooks/register.ts` (the mod), `tests/self-compact.test.ts`.
- `docs/en/DESIGN.md`: the design. Read it before changing the gate, the queue or the race handling.
- `docs/en/CHANGELOG.md`: release notes are cut from it by `.github/workflows/release.yml`.
- `repo-assets/`: logo, flow diagram, social preview.

## Commands

Needs the `claude` CLI, 2.1.287 or later (plugin mods are on by default from that version).

```sh
claude plugin validate .
claude plugin validate plugins/self-compact
claude plugin test plugins/self-compact
```

CI runs the same three commands on Ubuntu and macOS. Run them before every commit that touches the plugin.

`.claude-plugin/types/` inside the plugin (editor typings for the mod API) is generated and gitignored.

## Rules

- **No `node:fs` in mods.** The mod runtime cannot import it. File access goes through the engine's `$.fs`; environment through `$.env`.
- **No network calls, no external dependencies, no state outside `~/.claude/self-compact/`.** The README promises this; a change that breaks it needs a README and SECURITY.md update in the same PR.
- **Clean-room.** Other compaction plugins inform the design (see Acknowledgements in `docs/en/DESIGN.md`). Do not copy their code or prompts.
- **English for code, comments, commit messages and PR text.** Comments are terse: the why, not a restatement of the code. User-facing strings (tool description, denials, toasts, nudges, continuation prompt) live in the `STRINGS` table in `register.ts`, one entry per language (`en`, `zh`); a new or changed string needs both.
- **Tests with behavior changes.** Every gate, queue or race change gets a test in `plugins/self-compact/tests/`. Flip the assertion once and confirm the test fails, then restore it.
- **Docs stay in sync.** The tier table, the break-even table and the configuration table appear in `README.md`, `README.zh-cn.md` and `docs/`. Change them together.
- **Versioning.** `version` in `plugins/self-compact/.claude-plugin/plugin.json` must equal the release tag without the `v`; the release workflow checks it.

## Commits

Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`). One topic per commit.
