---
applyTo: "docs/**/*.md,README.md"
---

# Writing user-facing documentation

These files are the **published user docs** — the Jekyll site under `docs/` and the README. Write them for someone *using* copillm, not building it.

- **Explain behaviour and usage, not implementation.** Describe what a command, flag, endpoint, or config option does, what the user sees, and how to use it.
- **Don't leak implementation details.** No specific backing library/package names (e.g. which keychain or HTTP library powers a feature), internal class/function/field names, internal module paths (`src/...`), or reverse-engineered third-party internals. If a term is only useful to someone grepping the source, cut it.
- **Do document what users actually touch:** CLI commands, flags, and printed output (e.g. `backend: keyring` from `copillm auth status`); environment variables; `~/.copillm/` config options and file locations; observable behaviour; and error messages.
- **Frame the "why" in user terms.** Prefer "every model you're entitled to that supports chat" over the upstream eligibility field names that gate it.
- Keep examples copy-pasteable and current with the actual CLI surface.

Implementation detail belongs in the contributor guide (`.github/copilot-instructions.md`), not here.
