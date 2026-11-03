import { LocalRealtimeChannel } from './localChannel.js';
import {
  createBrowserSpeechInput,
  createBrowserSpeechOutput,
} from './localSpeech.js';

export const LOCAL_MODEL_STORAGE_KEY = 'godsEyeView.localAi.model';

function storage(scope = globalThis) {
  try {
    return scope.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The model the operator last chose, or null. Never throws. */
export function readStoredLocalModel(store = storage()) {
  try {
    const value = store?.getItem(LOCAL_MODEL_STORAGE_KEY);
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/** Remember the chosen model. Never throws. */
export function writeStoredLocalModel(model, store = storage()) {
  try {
    store?.setItem(LOCAL_MODEL_STORAGE_KEY, model);
  } catch {
    /* best effort */
  }
  return model;
}

async function readError(response) {
  const data = await response.json().catch(() => null);
  return typeof data?.error === 'string'
    ? data.error
    : `Local AI request failed: HTTP ${response.status}`;
}

/** Parse an NDJSON response body into events. */
export async function* readNdjsonEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          /* skip a malformed line */
        }
      }
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest) {
      try {
        yield JSON.parse(rest);
      } catch {
        /* ignore */
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * Backend for the Local AI voice provider. It speaks the Realtime backend's
 * `requestToken` contract (so the controller's start sequence is unchanged)
 * and, instead of SDP negotiation, opens a local event channel.
 */
export function createLocalVoiceBackend({
  sessionEndpoint = '/api/local-ai/session',
  chatEndpoint = '/api/local-ai/chat',
  transport = (...args) => fetch(...args),
  readModel = () => readStoredLocalModel(),
  lang = () =>
    globalThis.document?.documentElement?.lang ||
    globalThis.navigator?.language ||
    'en-US',
  createSpeechInput = createBrowserSpeechInput,
  createSpeechOutput = createBrowserSpeechOutput,
  timeoutMs = 15_000,
  signal: lifetime,
} = {}) {
  const scoped = (signal, ms = timeoutMs) =>
    AbortSignal.any(
      [lifetime, signal, ms ? AbortSignal.timeout(ms) : null].filter(Boolean),
    );

  async function describe({ model = readModel(), signal } = {}) {
    const response = await transport(sessionEndpoint, {
      method: 'POST',
      signal: scoped(signal),
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model ? { model } : {}),
    });
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json();
    if (typeof data?.model !== 'string' || !data.model)
      throw new Error('Local AI did not name a model');
    return {
      model: data.model,
      models: Array.isArray(data.models)
        ? data.models.map(String)
        : [data.model],
    };
  }

  async function* chat({ model, messages, note, tools, signal }) {
    const response = await transport(chatEndpoint, {
      method: 'POST',
      // No overall timeout here: the server bounds the model's time, and a
      // first answer from a large model can take a while to load and prefill.
      signal: scoped(signal, 0),
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, note, tools }),
    });
    if (!response.ok) throw new Error(await readError(response));
    if (!response.body) throw new Error('Local AI returned no stream');
    yield* readNdjsonEvents(response.body);
  }

  return Object.freeze({
    protocol: 'local-chat',
    describe,
    async requestToken({ signal } = {}) {
      const described = await describe({ signal });
      return {
        token: 'local',
        local: true,
        model: described.model,
        models: described.models,
        tier: null,
        expiresAt: null,
      };
    },
    /**
     * Open the event channel for one session. `stream` is the microphone the
     * controller acquired; its enabled track is the push-to-talk gate.
     */
    openChannel({ credential, stream, debugLog = () => {} }) {
      const language = lang();
      return new LocalRealtimeChannel({
        chat,
        model: credential.model,
        createSpeechInput: (handlers) =>
          createSpeechInput({ lang: language, ...handlers }),
        speechOutput: createSpeechOutput({ lang: language }),
        isMicrophoneEnabled: () =>
          Boolean(stream?.getAudioTracks?.().some((track) => track.enabled)),
        onDiagnostic: debugLog,
      });
    },
  });
}
