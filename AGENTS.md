# AGENTS.md: rules for every AI working in this repository

A public fork of bilawalsidhu/gods-eye-view. See `README.md`.

This is the only instruction file in this repository. Claude Code, Codex and Gemini CLI all read it. Do not add a `CLAUDE.md` or `GEMINI.md`: they stop some tools from reading this one.

## Rules

- Run `git status` before starting. If there are changes you did not make, stop and ask the maintainer.
- One AI edits at a time. Work on a branch named after your tool: `claude/<topic>`, `codex/<topic>` or `gemini/<topic>`. the maintainer merges into `main`.
- Small commits that say what and why. End each commit message with a `Co-Authored-By:` line that names your model.
- Never commit secrets (`.env` files, keys, passwords, hosting logins) or live data (databases, uploads, submissions).
- Stay in scope. Note other ideas instead of doing them.
- This repository is public. Never add personal data or keys.
- Keep changes small so the fork can still take updates from upstream.

## AI roles

Keep this table current. When a role, model or effort level changes, update it in the same commit.

| Role | Provider | Tool | Model | Effort or mode | Notes |
|---|---|---|---|---|---|
| Coding | Not set yet |  |  |  |  |
| Review / audit | Not set yet |  |  |  |  |
