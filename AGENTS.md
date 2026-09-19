# AGENTS.md

Instructions for AI agents that are asked to install, verify, or work on this repository.

## What this is

`ego-jev` makes browser automation faster by replacing the per-step large-model round trip with
[TypeSafe](https://docs.typesafe.ai)'s System One model **Jev**. One *indexed element table* goes in;
one **operation + target** comes out, in a single request. Code owns observation, execution,
verification and exit conditions.

It builds on [ego lite](https://github.com/citrolabs/ego-lite) (`ego-browser`). It is an **add-on**:
it never modifies the ego lite application bundle.

## Install

### Option 1 — skills CLI (recommended, works across 40+ agents)

```bash
npx skills add jiangkoumo/ego-jev
```

This places the skill (including `scripts/ego-jev.mjs` and `scripts/ego-jev`) in the agent's skills
directory, e.g. `~/.agents/skills/ego-jev/`.

### Option 2 — clone and run the installer

```bash
git clone https://github.com/jiangkoumo/ego-jev.git
cd ego-jev
./install.sh          # links scripts/ego-jev into ~/.local/bin, prepares the credential file
./install.sh --test   # additionally runs an end-to-end smoke test
```

### Option 3 — prompt to paste into any agent

> Install `ego-jev` from https://github.com/jiangkoumo/ego-jev for me:
> 1. run `npx skills add jiangkoumo/ego-jev` (fall back to cloning the repo and running
>    `./install.sh` if the skills CLI is unavailable);
> 2. confirm `ego-browser --version` works, and if ego lite is missing tell me to install it first;
> 3. make sure a Jev API key exists at `~/.config/typesafe/api_key` (mode 600). If it is missing,
>    ask me for the key — do **not** invent one and do **not** put it in your prompt history;
> 4. run the verification below and report the actual command output.

## Verify the install — run these, do not assume

```bash
# 1. prerequisites
ego-browser --version                       # expect: ego-browser <version> + chromium + node
test -f ~/.config/typesafe/api_key && echo "key file present"

# 2. end-to-end (deterministic exit condition; expect exit 0 and "success": true)
~/.agents/skills/ego-jev/scripts/ego-jev \
  --url "https://en.wikipedia.org/wiki/Main_Page" \
  --text "Jev" --until "/wiki/JEV" --steps 5 \
  "type Jev into the search box and submit"
```

Exit codes: `0` goal reached (`check_passed` / `jev_done`), `1` not reached (the TaskSpace is kept for
inspection), `2` bad arguments, `3` missing Jev credential.

## Hard constraints

- **Never write into the ego lite application bundle.** `/Applications/ego lite.app/...` is
  vendor-signed; every ego lite upgrade replaces its versioned `Resources/ego-skills/` directory, so
  edits there are lost. Extensions belong outside the bundle (`~/.agents/skills/`, `~/.agents/lib/`).
- **Credentials must live in a file.** The embedded runtime of `ego-browser nodejs` inherits only a
  minimal login environment. Custom environment variables — including `TYPESAFE_API_KEY` — are **not**
  passed through, so exported variables never reach the script. Write the key to
  `~/.config/typesafe/api_key` (or point `TYPESAFE_API_KEY_FILE` at it).
- Do not commit credentials. `~/.config/typesafe/text_model.json` may reference an existing secret
  file by path (`apiKeyJson`) instead of copying the key.
- Keep the skill installable: `SKILL.md` must stay at the repository root and must reference bundled
  files by relative path (`scripts/...`).

## Runtime facts measured in this repo (they will save you debugging time)

| Behaviour | Detail |
| --- | --- |
| Static `import` of a built-in silently kills the script | `import { x } from "node:http"` → no output, exit 0. Always `await import("node:...")`. |
| No server, no loopback | `server.listen()` never fires its callback; `fetch("http://127.0.0.1:…")` hangs then exits 0. External HTTPS `fetch()` works. |
| `process.cwd()` is `/` | Never rely on relative paths inside an `ego-browser nodejs` script. |
| Custom env vars are stripped | Pass configuration by substituting values into the script text from the parent process. |
| `loc` values may contain `]` | Parse the attribute list from the first `[` to the **last** `]`, or CSS selectors like `input[name="a"]` get truncated. |
| Checkbox/radio state is not in the snapshot | Read it with one batched `page.evaluate()`; if DOM and snapshot counts disagree, report "state unknown" instead of guessing. |
| Browser auto-translation is on | Element and option names may be translated. Never compare UI strings in `--until`; compare URL paths or DOM state. |

## Repository layout

```
SKILL.md                 the agent skill (root on purpose — this is what `npx skills add` installs)
scripts/ego-jev.mjs      engine
scripts/ego-jev          CLI (finds the engine in the same dir, the repo root, or ~/.agents/lib)
examples/bench/          A/B benchmark harness (Jev loop vs per-step large-model loop)
install.sh               manual installer (non-skills-CLI path)
```

## Development conventions

- Engine changes belong in `scripts/ego-jev.mjs` and must keep the exported API stable:
  `askJev`, `parseActionTargets`, `enrichTargets`, `buildQuestions`, `runJevStep`,
  `runJevAutonomousLoop`, `generateText`, `loadTextModelConfig`, `resolveTextApiKey`, `loadApiKey`.
- After changing the engine, re-run the smoke tests above **and** `./examples/bench/run-pair.sh A`.
- Only claim completion with real command output and exit codes. Verify exit 0 and
  `"success": true`, or say exactly which step failed.
- Never report a benchmark number without the harness that produced it.
