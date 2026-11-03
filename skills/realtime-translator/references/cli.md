# CLI reference

Run as `node scripts/translator.cjs <command>`. Requires Node 20+. Every command prints JSON on stdout; errors go to stderr as `Error: <message>`.

## `transcribe <audio> --job <dir>`

Decodes the input (audio, or a video's audio track), recognizes speech, and creates a job. Re-using a directory starts it clean, which discards its translations.

| Flag                   | Default   | Meaning                                  |
| ---------------------- | --------- | ---------------------------------------- |
| `-l, --lang <code>`    | `vi`      | Target language, recorded in the job     |
| `--source-lang <code>` | `auto`    | Spoken language, when detection is wrong |
| `--model <path>`       | see below | Whisper model file                       |

Prints `{"job","sourceLanguage","targetLanguage","segments"}`.

## `next --job <dir>`

| Flag               | Default | Meaning                                                  |
| ------------------ | ------- | -------------------------------------------------------- |
| `--limit <n>`      | `30`    | Most segments to return                                  |
| `--wait <seconds>` | `0`     | Block until something is pending or the job has finished |

```json
{
  "targetLanguage": "vi",
  "pending": [{ "id": 3, "startMs": 5200, "endMs": 7800, "text": "Thank you." }],
  "remaining": 1,
  "finished": false,
  "context": [{ "source": "Hello.", "translation": "Xin chào." }]
}
```

`finished` means no more segments will arrive. The job is complete when `finished` is true and `remaining` is 0.

## `push --job <dir>`

Reads `[{"id":1,"text":"..."}]` from stdin, or from `--file <path>`. A later push for the same `id` replaces the earlier translation. An unknown `id` or blank text rejects the whole batch with exit 2. Prints `{"accepted","remaining"}`.

## `render --job <dir>`

| Flag              | Default     | Meaning                                                |
| ----------------- | ----------- | ------------------------------------------------------ |
| `--srt <path>`    |             | Write SRT                                              |
| `--vtt <path>`    |             | Write WebVTT                                           |
| `--audio <path>`  |             | Write a dubbed track; `.mp3` writes MP3, otherwise WAV |
| `--track <which>` | `both`      | `both`, `source`, or `translated`                      |
| `--voice <name>`  | by language | System voice; see `voices`                             |
| `--allow-partial` | off         | Render what is translated, instead of exit 5           |

Prints `{"outputs":[{"kind","format","path","track"}],"untranslated"}`. With `--track both`, `x.srt` becomes `x.source.srt` and `x.<lang>.srt`. Existing files are overwritten and missing directories are created. Both subtitle tracks use the source timeline.

## `live --job <dir> (-p <pid> | --stdin)`

| Flag                     | Default     | Meaning                                                      |
| ------------------------ | ----------- | ------------------------------------------------------------ |
| `-p, --process <pid>`    |             | App to capture, from `list`                                  |
| `--stdin`                |             | Read raw 16 kHz mono 16-bit LE PCM from stdin                |
| `-l, --lang <code>`      | `vi`        | Target language                                              |
| `--duration <seconds>`   | none        | Stop on its own. Without it, runs until `stop` or a signal   |
| `--play`                 | off         | Read translations aloud                                      |
| `--voice <name>`         | by language | System voice                                                 |
| `--mute-source`          | off         | Silence the captured app (macOS only)                        |
| `--translator-cmd <cmd>` | none        | Run through a shell: segment on stdin, translation on stdout |
| `--translator <p>`       | agent       | Translate through a provider; see providers.md               |
| `--translate-model <id>` | provider's  | Translation model                                            |
| `--stt <p>`              | `local`     | Recognize through a provider                                 |
| `--stt-model <id>`       | provider's  | Recognition model                                            |
| `--tts <p>`              | `system`    | Speak through a provider                                     |
| `--tts-model <id>`       | provider's  | Speech model                                                 |
| `--drain <seconds>`      | `15`        | After capture ends, how long to wait for translations        |
| `--source-lang <code>`   | `auto`      | Spoken language                                              |
| `--model <path>`         | see below   | Whisper model file                                           |

Prints one JSON event per line:

```json
{"type":"status","status":"capturing","pid":1234}
{"type":"segment","id":1,"startMs":800,"endMs":3100,"text":"Hello everyone."}
{"type":"translation","id":1,"text":"Xin chào mọi người."}
{"type":"warning","message":"speech fell behind; skipped a line"}
{"type":"status","status":"draining","pending":0}
{"type":"status","status":"stopped","pending":0}
```

`--translator-cmd` receives `RTT_TARGET_LANGUAGE` in its environment and is limited to 60 s per segment. A failure becomes a `warning`, and the segment stays pending.

Segments still pending at the end remain in the job, so you can finish them with `next`/`push` and then `render`.

## `translate --job <dir> --provider <p>`

Translates every pending segment through a provider, in batches, saving as it goes. `--model <id>` overrides the model and `--batch <n>` the batch size (default 30). Prints `{"translated","remaining"}` and exits 4 if any remain; run it again to continue.

`transcribe` also takes `--stt <p>` and `--stt-model <id>`, and `render` takes `--tts <p>` and `--tts-model <id>`. See [providers.md](providers.md).

## Latency levels

`live --latency <level>` picks how far behind the speaker to run. `levels [-l <lang>]` prints each one's `available`, `missing`, `latency`, `measured`, `tradeoff`, and `providers` for this machine.

| Level      | Cuts speech after           | Translator                                 | Default when               |
| ---------- | --------------------------- | ------------------------------------------ | -------------------------- |
| `careful`  | 800 ms of silence, or 12 s  | You, by `next`/`push`                      | No `--translator` is given |
| `balanced` | 500 ms of silence, or 6 s   | `--translator` or `--translator-cmd`       | A translator is given      |
| `fast`     | 250 ms of silence, or 3 s   | `--translator` or `--translator-cmd`       | Never                      |
| `realtime` | Does not cut; audio streams | The provider, within one streaming session | Never                      |

`realtime` also takes `--realtime-provider openai|gemini` (required), `--realtime-model <id>`, and `--audio <path>` to save the translated speech as WAV or MP3. It rejects `--stt`, `--translator`, `--translator-cmd`, `--tts`, `--voice`, and `--model`, which have no meaning there, and emits a `{"type":"status","status":"first_output","afterMs":...}` event measuring time from connection to first output.

## Other commands

| Command              | Purpose                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `status --job <dir>` | Job info, plus `segments`, `remaining`, `running`                            |
| `stop --job <dir>`   | Stop a live session. Prints `{"stopped":true,"pid"}` or the reason it didn't |
| `list`               | Apps that can be captured: `[{"id","name"}]`; 🔊 means playing now           |
| `voices [-l <lang>]` | System voices. With `-l`, `{"default","voices"}`; `default` is the pick      |

## Exit codes

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 0    | Done. `live` also returns 0 when stopped by `stop` or a signal   |
| 2    | Bad arguments, unknown job, missing input, rejected translations |
| 3    | whisper.cpp, its model, or a voice is missing                    |
| 4    | Runtime failure: decode, recognition, or capture                 |
| 5    | `render` found untranslated segments                             |

## Job directory

| File                 | Contents                                                         |
| -------------------- | ---------------------------------------------------------------- |
| `job.json`           | `mode`, `source`, `targetLanguage`, `sourceLanguage`, `finished` |
| `segments.jsonl`     | One recognized segment per line                                  |
| `translations.jsonl` | One translation per line; the last for an `id` wins              |
| `audio.16k.wav`      | Decoded input, file mode only                                    |
| `live.pid`           | The running live process                                         |

These are plain files. Delete the directory when finished; it holds a transcript of whatever was captured.

## Environment

| Variable            | Purpose                                                |
| ------------------- | ------------------------------------------------------ |
| `RTT_WHISPER_CLI`   | whisper.cpp binary, instead of `whisper-cli` on `PATH` |
| `RTT_WHISPER_MODEL` | Model file, instead of searching                       |
| `RTT_FFMPEG_PATH`   | ffmpeg binary, instead of `PATH`                       |
| `RTT_FFPLAY_PATH`   | ffplay binary, used by realtime `--play`               |
| `RTT_TAP_HELPER`    | macOS capture helper, instead of `bin/audio-tap`       |

Models are searched in the skill's `models/`, then `~/.cache/realtime-translator/models/`, preferring `small`, then `base`, `medium`, `large`, `tiny`.
