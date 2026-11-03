# realtime-translator-skill

An [Agent Skill](https://agentskills.io) for translating speech in audio, with **no API key and no cloud speech service**. The agent you already use (Claude Code, Codex, or another that reads skills) does the translating, while speech recognition and voice run on your machine.

## What an agent can do with it

- **Translate a file:** audio or video → translated subtitles (SRT/VTT) and a dubbed audio track (WAV/MP3).
- **Translate an app as it plays:** capture one app's audio on macOS or Windows, and hear or read the translation.

```text
audio → whisper.cpp → text → your agent translates → subtitles + system voice
```

Each step can also use a cloud provider, chosen per step:

| Step      | Default      | Cloud options                                       |
| --------- | ------------ | --------------------------------------------------- |
| Recognize | whisper.cpp  | OpenAI, Gemini, Groq                                |
| Translate | your agent   | Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama |
| Speak     | system voice | OpenAI, Gemini                                      |

With a provider key you can skip installing whisper.cpp. See [references/providers.md](skills/realtime-translator/references/providers.md).

## Install

Needs Node 20+, `ffmpeg`, and [whisper.cpp](https://github.com/ggml-org/whisper.cpp).

```bash
brew install ffmpeg whisper-cpp     # macOS; setup.mjs prints the equivalent elsewhere

git clone <this repo> && cd realtime-translator-skill

node install.mjs --agent claude               # ~/.claude/skills/
node install.mjs --agent codex                # ~/.agents/skills/
node install.mjs --agent gemini               # ~/.gemini/skills/
node install.mjs --agent cursor --project .   # ./.cursor/skills/
```

| Flag              | Effect                                                |
| ----------------- | ----------------------------------------------------- |
| `--agent all`     | Install for all four                                  |
| `--project <dir>` | Install into a project instead of your home directory |
| `--link`          | Symlink instead of copy, so it tracks this checkout   |
| `--dest <dir>`    | Any other skills directory, for other agents          |
| `--force`         | Replace an existing install                           |
| `--dry-run`       | Show what would happen                                |

Then, from the installed folder, check the machine and fetch a speech model. On macOS this also compiles the capture helper.

```bash
node ~/.claude/skills/realtime-translator/scripts/setup.mjs --download-model base
```

**Agents without skill support:** point them at `skills/realtime-translator/SKILL.md` from your `AGENTS.md` or equivalent. It is ordinary Markdown with ordinary shell commands.

## Use

Ask your agent:

> Translate `talk.mp3` into Vietnamese and make subtitles.

> Dịch trực tiếp âm thanh của Chrome sang tiếng Việt trong 10 phút.

## Latency levels

The agent picks one with `live --latency`, after `levels` reports what works on the machine:

| Level      | Translator  | Delay                                      | Needs                |
| ---------- | ----------- | ------------------------------------------ | -------------------- |
| `careful`  | Your agent  | 5 to 30 s after a sentence (estimate)      | Local speech only    |
| `balanced` | A provider  | About 4 to 5 s after a sentence (measured) | A provider key       |
| `fast`     | A provider  | Sooner, but cuts mid-sentence (unmeasured) | A provider key       |
| `realtime` | The session | Lowest, streaming (unmeasured)             | OpenAI or Gemini key |

## What to expect

- **Files** work well: recognition is local, and the agent translates with full context. It uses your agent's tokens, in proportion to the amount of speech.
- **Live** is near-realtime, not instant. Each line waits for a pause, recognition, and an agent turn, so plan for roughly 5 to 30 seconds behind the speaker, and token use for as long as it runs. Good for following a talk, not for holding a conversation. `--translator-cmd` swaps the agent for any faster command.
- **Voice** is your system's. It is clear but robotic, and a language needs an installed voice. Subtitles work regardless.

## Platform support

| Capability      | macOS                   | Windows                         | Linux          |
| --------------- | ----------------------- | ------------------------------- | -------------- |
| Files           | yes                     | yes                             | yes            |
| App capture     | 14.4+, needs permission | 10 build 19041+, needs an addon | `--stdin` only |
| Spoken output   | `say`                   | System.Speech                   | `espeak-ng`    |
| Mute the source | yes                     | no                              | n/a            |

## Layout

```text
skills/realtime-translator/     everything an agent gets
  SKILL.md                      instructions the agent reads
  agents/openai.yaml            Codex UI metadata
  scripts/translator.cjs        the CLI, bundled; needs no npm install
  scripts/setup.mjs             machine check, model download, helper build
  references/                   CLI and architecture docs
  src/                          TypeScript source + unit tests
  native/macos/                 Core Audio capture helper source
test/                           end-to-end tests
scripts/build.mjs               regenerates scripts/translator.cjs
install.mjs                     skill installer
```

## Develop

```bash
npm install
npm run check      # format, typecheck, unit tests, build, e2e
```

`scripts/translator.cjs` is generated and committed, so that installing the skill needs no build. Run `npm run build` after changing `src/`, and commit the result. CI fails if it is stale.

The e2e tests spawn the bundle with real ffmpeg, but with stand-ins for whisper.cpp and the speech engine, so they need no model and make no sound.
