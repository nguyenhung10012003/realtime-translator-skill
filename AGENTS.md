# AGENTS.md

This repo packages an audio translator as an Agent Skill, with the host agent as the translator. To **use** it, follow `skills/realtime-translator/SKILL.md`. The rest of this file is for **changing** the repo.

## Commands

- `npm run check`: format, typecheck, unit tests, build, and e2e
- `npm test`: unit tests only, under a second
- `npm run test:e2e`: rebuilds, then runs `test/` (needs ffmpeg; no model, no keys, local servers only)
- `npm run build`: regenerates `skills/realtime-translator/scripts/translator.cjs`
- `npm run format`: Prettier

## Rules

- **`scripts/translator.cjs` is generated and committed.** Never edit it. After changing `src/`, run `npm run build` and commit the result, or the installed skill keeps the old behaviour. CI checks for this.
- Everything an installed agent needs must live inside `skills/realtime-translator/`. The installer copies only that folder, so nothing there may depend on repo-root files at runtime.
- The skill must stay usable with no API key and no cloud service. Cloud providers are opt-in per step and never chosen automatically, because they send the user's audio or text elsewhere and bill them.
- Keys come only from the environment. Never log, print, or put one in a URL.
- Installing the skill needs no `npm install`: JavaScript dependencies are devDependencies bundled into `translator.cjs`. The optional Windows capture addon is the one exception.
- Model ids in `src/providers/registry.ts` go stale. When changing one, update `references/providers.md` and check the provider's current docs.
- Keep `SKILL.md` and `references/cli.md` in step with `src/cli/index.ts`.
- Code and comments are in English. No semicolons, single quotes, width 100 (`.prettierrc.yaml`).

## Testing notes

- `test/cli.test.ts` puts stand-ins for `whisper-cli` and `say` on `PATH`. They prove the pipeline and protocol, not recognition or voice quality, so check changes to those with the real tools.
- macOS and Windows capture need manual checks on those systems, because the e2e helper is a fake.
