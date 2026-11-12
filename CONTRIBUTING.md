# Contributing

The most useful things you can send are bug reports with a `log.jsonl` excerpt, compactions that dropped something a handoff should have kept, and nudges that arrived at the wrong moment. Open an issue with your Claude Code version, the context window size and what happened.

## Pull requests

1. Fork, branch from `main`, keep the change to one topic.
2. Run the same checks CI runs (needs the `claude` CLI, 2.1.287 or later):

   ```sh
   claude plugin validate .
   claude plugin validate plugins/self-compact
   claude plugin test plugins/self-compact
   ```

3. Add or update a test in `plugins/self-compact/tests/` for any behavior change. For a gate or race fix, flip the assertion once and confirm the test fails before you commit.
4. Note user-visible changes under a new heading in `docs/en/CHANGELOG.md`, and bump `version` in `plugins/self-compact/.claude-plugin/plugin.json` for a release.

The maintainer reviews and merges. CI on pull requests from new contributors starts after approval.

## Scope

- Claude Code only, main session only. Subagents, `-p`, SDK and cron sessions stay denied.
- No network calls, no external dependencies, no state outside `~/.claude/self-compact/`.
- Mods cannot import `node:fs`; file access goes through the engine's `$.fs`.
- Code, comments and identifiers are English. Clean-room rule: ideas from other compaction plugins are welcome, copied code is not.

## License

Contributions are dual-licensed under MIT and Apache-2.0, the same as the project.
