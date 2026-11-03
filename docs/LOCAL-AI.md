# Local AI voice (Ollama)

God's Eye View can run its voice agent on a model on your own computer
instead of OpenAI or Gemini. Choose **Ollama** in the GEV MIC provider chooser.
No API key is needed, and nothing is billed.

The local agent receives the same instructions and the same map tools as the
cloud agents. It can fly the camera, switch layers, answer analyst questions,
annotate the map and so on.

## How it works

| Part | Cloud providers | Ollama |
|---|---|---|
| Understanding and tool calls | OpenAI / Gemini voice model | Your Ollama model |
| Your speech → text | The voice model | The browser's speech recognizer |
| Reply → speech | The voice model's voice | The browser's speech synthesis (system voices) |
| Typed commands | ✓ | ✓ |
| Screenshots of the view | Sent to the model | Not sent (text models cannot see them) |
| Cost meter / MINI tier | OpenAI only | Hidden; the button shows the model instead |

The browser talks to the app's own server (`/api/local-ai/*`), which forwards
the request to Ollama. The browser never chooses where the request goes: the
Ollama address comes from the server's `LOCAL_AI_URL`. The browser can only
pick among the models Ollama reports as installed.

### What stays on your computer

- **Everything the model reads and writes:** prompts, map context, tool
  results and answers.
- **Speech recognition, which depends on the browser.** Chrome recognizes
  on-device when it has the language pack for your language, and the app asks
  for that first. Otherwise Chrome, like Safari, may send the microphone audio
  to Google's or Apple's speech service, just as dictation does. If that
  matters to you, type commands instead: typing never needs recognition.
- **Spoken replies:** they use the voices installed in your system.

## Setup on a Mac

1. Install Ollama from <https://ollama.com/download> and open it. It serves on
   `http://127.0.0.1:11434`.
2. Pull a model that supports **tool calling**, for example:
   ```sh
   ollama pull qwen3:30b
   ```
   Any installed chat model appears in the app. Check with `ollama list`.
3. Start God's Eye View: `npm run dev`, Pinokio, or the double-click
   launcher below.
4. Choose **Ollama** in the voice provider chooser and turn voice on.
5. The model button shows the active model, for example `QWEN3:30B`. With the
   voice panel it is under the gear (Voice Settings), in the "Voice model
   tier" row. Click it to step through your installed models. The change
   applies the next time voice starts.

### Double-click launcher

`scripts/gev-launch.command` starts the app, or reuses one already running,
and opens it in its own Chrome window (or your default browser). Along the
way it:

- switches to Node 24 through nvm if the current Node is not supported;
- installs project packages only when they are missing or changed;
- starts Ollama if it is installed but not running.

It does not load the model; Ollama loads it the first time voice uses it.

Closing the app window shuts the app down about 15 seconds later: the server
stops and the launcher's Terminal window closes. Closing the Terminal window,
or pressing Ctrl+C in it, does the same. Ollama keeps running and unloads the
model itself after `LOCAL_AI_KEEP_ALIVE`, since other apps may use it.
Put a link to it on the Desktop once:

```sh
ln -s "$PWD/scripts/gev-launch.command" ~/Desktop/"God's Eye View.command"
```

Leave the Terminal window it opens running while you use the app.

Optional settings, in `.env` (terminal) or `pinokio/ENVIRONMENT` (Pinokio):

| Variable | Default | Meaning |
|---|---|---|
| `LOCAL_AI_URL` | `http://127.0.0.1:11434` | Ollama address (http/https only, no credentials) |
| `LOCAL_AI_MODEL` | first installed | Model used when none was chosen in the app |
| `LOCAL_AI_NUM_CTX` | `32768` | Context window; the voice prompt and tools are about 15k tokens |
| `LOCAL_AI_KEEP_ALIVE` | `30m` | How long Ollama keeps the model in memory after a turn |
| `LOCAL_AI_TIMEOUT_MS` | `180000` | Longest a single answer may take, including loading the model |
| `LOCAL_AI_THINK` | off | Let reasoning models think first (more accurate, much slower) |

## What to expect

- **The first answer is slow.** Ollama has to load the model and read the
  roughly 15k-token instructions. Later turns reuse that work and are much
  faster. Keeping `LOCAL_AI_KEEP_ALIVE` long avoids reloading.
- **Speech starts per sentence.** The reply is spoken as soon as its first
  sentence is complete, not when the whole answer is done.
- **No talking over the assistant.** The recognizer pauses while the reply is
  spoken, so the assistant does not hear itself. To interrupt, hold Space or
  type.
- **Push-to-talk: pause a beat after pressing Space.** The recognizer starts
  when Space goes down, so a first syllable spoken at the same instant can be
  missed. Releasing Space sends what was heard.
- **Smaller models make more mistakes** choosing tools and arguments. The
  project's benchmark measures this against the exact production prompt:
  `node scripts/qa-voice-bench.mjs --provider ollama --model <name>`.
- **Loops are cut off.** After four tool rounds in a row without you speaking,
  the model has to answer in words.
- **Speech recognition needs Chrome, Edge or Safari.** Firefox has none; typed
  commands still work there.
- **The AI HUD summary still uses OpenAI** when an OpenAI key is set. The voice
  provider choice does not change it.

## Troubleshooting

- *"Ollama is not reachable"*: open the Ollama app, or run `ollama serve`, and
  check that `curl http://127.0.0.1:11434/api/tags` answers.
- *"Ollama has no chat models installed"*: run `ollama pull <model>`.
  Embedding-only models are not listed.
- *"The local model took too long"*: the first answer from a large model can
  take a while. Raise `LOCAL_AI_TIMEOUT_MS`, or choose a smaller model.
- *It answers but never acts*: the model may not support tool calling. Try a
  tool-capable model; the Ollama library marks these as *tools*.
