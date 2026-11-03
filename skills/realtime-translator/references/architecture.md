# Architecture

Agents can read and write text but cannot hear or speak. The skill supplies exactly those two senses, locally, and leaves the translating to the agent already running.

```text
 FILE            mp3/m4a/wav/video → ffmpeg decode ─────────────┐
 LIVE (macOS)    app → Core Audio process tap  ─┐               │
 LIVE (Windows)  app → WASAPI process loopback ─┼→ resample →   │
 LIVE (any)      raw PCM on stdin ──────────────┘   16 kHz mono │
                                                    │           │
                                             Segmenter (VAD)    │
                                                    └─────┬─────┘
                                                          ▼
                                                     whisper.cpp
                                                          ▼
                                                  segments.jsonl ───── next ────► agent
                                                                                    │ translates
                                                translations.jsonl ◄── push ────────┘
                                                          │
                                ┌─────────────────────────┼──────────────┐
                                ▼                         ▼              ▼
                         live: speak aloud          SRT / VTT      dubbed WAV / MP3
```

## Why this shape

**The agent is the translator.** It already understands every language it is asked for, has context about the user's domain, and needs no key. Nothing in the skill calls a translation service, so the skill works the same in Claude Code, Codex, or anything that can run a shell command.

**Files are the protocol.** `next` and `push` are the only interface between the pipeline and the agent. Any agent can use them, a job survives a crashed process or a lost session, and a human can read or correct it.

**Local recognition and speech.** An agent cannot do these, and they should not need an account. whisper.cpp is one binary with no runtime dependencies, and every desktop OS ships a speech engine.

## Latency

What a live listener waits for, in order:

| Stage       | Delay                                | Controlled by                             |
| ----------- | ------------------------------------ | ----------------------------------------- |
| Segmenting  | Until 500 ms of silence, 6 s at most | `SegmenterOptions`                        |
| Recognition | Model and hardware dependent         | Model size; `tiny` and `base` are fastest |
| Translation | One agent turn                       | The agent, or `--translator-cmd`          |
| Speech      | Immediate, unless backlogged         | Backlog above 3 lines drops the oldest    |

**Measured with providers:** one run on clean synthetic speech, with `gpt-transcribe` and `gpt-6-luna`, had the translation ready 3.7 to 4.5 s after each sentence ended, of which 1.3 to 1.8 s was the silence wait plus recognition. A 5 s sentence therefore appeared about 9 s after it began. Spoken output adds synthesis and playback on top, which was not measured, and real audio or a busy network will vary.

**With the agent translating:** plan for 5 to 30 s, an estimate from the stages above rather than a measurement, because it depends on how fast the agent takes its turns.

A streaming speech-to-speech model can do much better than either, since it doesn't wait for a sentence to end.

## Latency levels

`careful`, `balanced`, and `fast` are this same pipeline with different segmentation (`src/latency/levels.ts`): waiting longer gives the translator whole sentences, and cutting sooner gets text out earlier at the cost of accuracy. `realtime` skips the pipeline, streaming audio to a model that transcribes, translates, and speaks in one session (`src/realtime/`). Translated speech plays through a single open `ffplay` there, because continuous audio cannot wait for a process per chunk.

## Modules

| Path                           | Responsibility                                                         |
| ------------------------------ | ---------------------------------------------------------------------- |
| `src/types.ts`                 | `AudioSource`, `AudioFrame`                                            |
| `src/audio/sources/`           | `MacosTapSource`, `WindowsLoopbackSource`, `StdinSource`               |
| `src/audio/framing/`           | `PcmFramer`: arbitrary capture chunks → exact frames                   |
| `src/audio/resample/`          | `PcmResampler`: any rate and channel count → 16 kHz mono Int16         |
| `src/audio/segmenter.ts`       | Energy-based voice activity detection                                  |
| `src/audio/macos/tapHelper.ts` | Protocol of the native helper: header, exit codes, process list        |
| `src/stt/whisper.ts`           | Find, run, and parse whisper.cpp                                       |
| `src/tts/tts.ts`               | Voice choice and the per-OS speech engines                             |
| `src/job/store.ts`             | The job directory                                                      |
| `src/render/render.ts`         | Subtitles, and laying speech on the timeline                           |
| `src/realtime/`                | Streaming sessions, per-provider wire formats, captions from fragments |
| `src/latency/levels.ts`        | Level definitions, and which are available on this machine             |
| `src/cli/`                     | Commands, and the live session loop                                    |
| `native/macos/AudioTap.m`      | Core Audio process tap helper                                          |

## Design decisions

**Per-process capture, never system-wide.** Capturing one app is what prevents a feedback loop: the translated voice plays from a different process, so it is never recaptured. The macOS helper also refuses to list its own parent.

**Segmenting by energy.** whisper.cpp takes bounded chunks, so the stream must be cut. A plain RMS threshold needs no model and works everywhere, though it can be fooled by constant background music, which then cuts only at the 6 s limit. 200 ms of pre-roll keeps first syllables.

**One whisper process per utterance.** Simple and crash-isolated, at the cost of reloading the model each time. A long-running `whisper-server` would cut that cost if it proves to matter.

**Dub timing.** Each line starts at its source time. If it would overrun the next line, it is sped up with ffmpeg's `atempo` (pitch-preserving, at most 1.5×). If it still overruns, the next line waits. Lines never overlap, but a dense passage can drift later until a pause absorbs it.

**Both subtitle tracks on the source timeline.** They fit the original recording, and also the dub, which follows the same timeline.

**Non-speech markers are dropped.** Whisper emits lines such as `[BLANK_AUDIO]` and `(music)` for non-speech; these never reach the agent or the subtitles.

## Native capture

### macOS helper protocol

`bin/audio-tap` is compiled from `AudioTap.m` by `scripts/setup.mjs`. It is Objective-C so that it builds against any SDK without Swift-toolchain coupling.

- `list` prints JSON: `pid`, `name`, `bundleId`, `audioActive`, `system`.
- `tap <pid> [--muted]` prints one header, then raw PCM on stdout until SIGTERM or SIGINT:

  ```text
  AUDIO-TAP 1 rate=48000 channels=1 format=f32
  ```

- Writing `mute` or `unmute` on stdin rebuilds the tap on the same stream. `muteBehavior` is fixed at tap creation, so this cannot be done in place.
- It exits by itself if its parent dies.

| Exit | Meaning                                  |
| ---- | ---------------------------------------- |
| 0    | Clean stop                               |
| 64   | Usage error                              |
| 66   | Process unknown to Core Audio            |
| 69   | Needs macOS 14.4+                        |
| 70   | Internal Core Audio error                |
| 77   | System Audio Recording permission denied |

The permission prompt goes to the _responsible_ app, whatever launched the process: the terminal, or the agent host. The start timeout is 30 s because the first start can wait behind that prompt.

### Windows

`WindowsLoopbackSource` uses the `application-loopback` addon, installed on demand by `setup.mjs --install-windows-capture`. It assumes the WASAPI mix format, f32 at 48 kHz stereo. Source muting is a no-op: WASAPI process loopback has no per-process mute.
