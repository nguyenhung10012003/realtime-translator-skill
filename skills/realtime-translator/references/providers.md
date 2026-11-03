# Cloud providers

By default nothing leaves the machine: whisper.cpp recognizes speech, the agent translates, and the system voice speaks. Each of those three steps can be swapped for a cloud provider independently.

**Before using one, get the user's agreement.** A provider receives their audio or transcript and bills their account. Keys come only from the user's environment; never ask for one to be pasted into a command.

## What each provider offers

| Provider     | Recognize (`--stt`) | Translate                   | Speak (`--tts`)        | Key                                 |
| ------------ | ------------------- | --------------------------- | ---------------------- | ----------------------------------- |
| `openai`     | `gpt-transcribe`    | `gpt-6-luna`                | `gpt-4o-mini-tts`      | `OPENAI_API_KEY`                    |
| `gemini`     | `gemini-3.8-flash`  | `gemini-3.8-flash`          | `gemini-3.8-flash-tts` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| `anthropic`  | none                | `claude-opus-5-5`           | none                   | `ANTHROPIC_API_KEY`, or SDK profile |
| `groq`       | `whisper-large-v3`  | any, with a model           | none                   | `GROQ_API_KEY`                      |
| `openrouter` | none                | any, with a model           | none                   | `OPENROUTER_API_KEY`                |
| `ollama`     | none                | any installed, with a model | none                   | none; runs locally                  |

The model named is the default. Override with `--stt-model`, `--translate-model`, or `--tts-model`, and `--model` on `translate`. These ids reflect each provider's documentation as of November 2026 and go out of date; if one is rejected, check the provider's current list and pass the new id.

## Examples

```bash
# File, all cloud: no whisper.cpp or model needed
node scripts/translator.cjs transcribe talk.mp3 --job /tmp/talk -l vi --stt openai
node scripts/translator.cjs translate --job /tmp/talk --provider anthropic
node scripts/translator.cjs render --job /tmp/talk --srt out/talk.srt --audio out/talk.mp3 --tts gemini

# Live, unattended, with the agent out of the loop
node scripts/translator.cjs live --job /tmp/live -p <pid> -l vi --duration 600 --play \
  --stt groq --translator anthropic --translate-model claude-haiku-5-5 --tts openai

# Translate with a local model through Ollama
node scripts/translator.cjs translate --job /tmp/talk --provider ollama --model <model>
```

`translate` works through all pending segments in batches of 30 (`--batch`), saving after each, and carrying the last lines as context. It exits 4 if any remain, and running it again continues where it stopped.

`next`/`push` still work on any job, so an agent can translate a job transcribed by a provider.

Mixing is normal, and is the way around a key that lacks a model. This chain has been run against the real API, with the system voice speaking because that project had no `gpt-4o-mini-tts`:

```bash
node scripts/translator.cjs transcribe talk.mp3 --job /tmp/talk -l vi --stt openai
node scripts/translator.cjs translate --job /tmp/talk --provider openai
node scripts/translator.cjs render --job /tmp/talk --srt out/talk.srt --audio out/talk.vi.mp3
```

## Choosing

- **Lower live latency:** a fast recognizer plus `--translator` removes the agent turn, the slowest step. Each line still waits for a pause in speech.
- **Translation quality:** Anthropic defaults to `claude-opus-5-5`. For a long file or live use, `--model claude-haiku-5-5` is much cheaper and faster, at the user's choice.
- **Voice quality:** cloud voices sound more natural than system voices, but every line becomes a billed request. Live, they also add a network round trip per line.

## Realtime providers

`live --latency realtime --realtime-provider <p>` holds one WebSocket open with a speech-to-speech model, instead of the three separate steps above.

| Provider | Default model                       | Key                                 | Targets                                                           |
| -------- | ----------------------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| `openai` | `gpt-realtime-translate`            | `OPENAI_API_KEY`                    | 13 documented: es, pt, fr, ja, ru, zh, de, ko, hi, id, vi, it, en |
| `gemini` | `gemini-3.5-live-translate-preview` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | 70+ documented                                                    |

A dropped connection reconnects with backoff, up to 6 tries without the server accepting. Gemini resumes with its handle and OpenAI starts a new session, since its docs describe no resumption. Audio during the gap is dropped. Session length limits are not documented by either provider.

## Provider notes

**OpenAI.** Translation uses the Responses API. OpenAI's docs list `gpt-4o-mini-tts`, `tts-1`, and `tts-1-hd` as deprecated on `/v1/audio/speech`, with shutdown on 2027-01-06. Their replacement runs only on the Realtime API, which this skill does not use, so expect `--tts openai` to stop working then; `--tts gemini` or the system voice are the alternatives. Voices include `marin` (default) and `cedar`; pass one with `--voice`.

**Gemini.** Uses the Interactions API at revision `2026-05-20`. Voices include `Kore` (default), `Puck`, and `Zephyr`.

**Anthropic.** The Messages API takes no audio and produces no speech, so this provider only translates. It uses the official SDK, bundled into the CLI. It runs at low effort, since translation is routine and live use is latency-sensitive, and `claude-opus-5-5` has server-side `fallbacks: "default"` on, so a safety decline is retried on another model instead of failing. If a line is still declined, it stays pending and the command reports it.

**OpenAI-compatible (`groq`, `openrouter`, `ollama`).** Use `/chat/completions`, and `/audio/transcriptions` where offered. To reach any other compatible service, use the `openai` provider's STT, or point one of these at it with its base URL variable below.

## Recognition without provider timestamps

Provider recognition uses the skill's own segmenter for timing: the audio is cut at pauses, up to 30 s for files and 6 s live, and each chunk is one request (four at a time for files). This works with models that return no timestamps and stays under upload limits, but a one-hour talk becomes hundreds of requests, and a chunk boundary can fall mid-sentence. Speech detection here is energy-based, so continuous background music reduces it to fixed-length chunks.

## Failures

| Situation                         | Result                                                              |
| --------------------------------- | ------------------------------------------------------------------- |
| Key missing or rejected           | Exit 3 at once, naming the variable. A live session stops itself.   |
| Provider lacks that capability    | Exit 2, before any request                                          |
| Rate limit, 5xx, or network error | Up to 4 attempts with backoff, honouring `Retry-After`; then exit 4 |
| Model skipped a segment           | One more try for just those; any left stay pending                  |
| Live: one line fails              | A `warning` event; that segment stays pending                       |

## Base URL overrides

`OPENAI_BASE_URL`, `GEMINI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GROQ_BASE_URL`, `OPENROUTER_BASE_URL`, `OLLAMA_BASE_URL`. Use these for a gateway or proxy. A provider receives the configured key, so only point one at a server you trust.

## When a key can't use a model

An OpenAI project only reaches the models enabled for it, and some include no audio models at all. That shows up as exit 3 with `refused access; the key may not include this model`. A provider can therefore be usable for one step and not another: keep the local or system option for the step it can't do, or pass a model the key has with `--stt-model`, `--translate-model`, or `--tts-model`.
