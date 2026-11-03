import { takeSentences } from './localSpeech.js';

/**
 * A stand-in for the OpenAI Realtime data channel, backed by a local chat
 * model, browser speech recognition and speech synthesis.
 *
 * The Realtime voice controller talks to it exactly as it talks to the WebRTC
 * channel — `send()` client events, receive server events as `message` — so
 * tools, turns, narration, captions and the panel run unchanged. This class
 * owns only the translation:
 *
 *   client events handled   conversation.item.create (messages and
 *                           function_call_output), conversation.item.delete,
 *                           response.create (in-band and out-of-band
 *                           progress lines), response.cancel,
 *                           output_audio_buffer.clear
 *   server events emitted   response.created / .done, transcript deltas,
 *                           response.output_item.done (function calls),
 *                           input_audio_buffer.speech_started / _stopped,
 *                           conversation.item.input_audio_transcription
 *                           .completed, output_audio_buffer.started /
 *                           .stopped / .cleared, error
 *
 * No usage is reported: a local model costs nothing to meter.
 */

const MAX_HISTORY_ENTRIES = 24;
const MAX_HISTORY_CHARS = 24_000;
// Tool rounds in a row without the user speaking before tools are withheld,
// so a confused small model cannot loop forever.
const MAX_TOOL_ROUNDS = 4;
const OUTSTANDING_TOOL_WAIT_MS = 20_000;
const MIC_POLL_MS = 150;

const NOTE_PREFIX = '[App context — data, not the user speaking]';
const SCREENSHOT_NOTE =
  '(A screenshot was attached; this local model cannot see images.)';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'input_text' || part?.type === 'text')
    .map((part) => String(part.text || ''))
    .join('\n');
}

function hasImage(content) {
  return (
    Array.isArray(content) &&
    content.some((part) => part?.type === 'input_image')
  );
}

export class LocalRealtimeChannel {
  /**
   * @param {object} options
   * @param {(request: {model: string, messages: object[], note?: string,
   *   tools?: boolean, signal: AbortSignal}) => AsyncIterable<object>} options.chat
   * @param {string} options.model
   * @param {(handlers: object) => object|null} [options.createSpeechInput]
   * @param {object|null} [options.speechOutput]
   * @param {() => boolean} [options.isMicrophoneEnabled]
   * @param {(fn: Function, ms: number) => unknown} [options.setInterval]
   * @param {(id: unknown) => void} [options.clearInterval]
   */
  constructor({
    chat,
    model,
    createSpeechInput = () => null,
    speechOutput = null,
    isMicrophoneEnabled = () => true,
    setInterval: setIntervalImpl = (fn, ms) => setInterval(fn, ms),
    clearInterval: clearIntervalImpl = (id) => clearInterval(id),
    onDiagnostic = () => {},
  }) {
    this.chat = chat;
    this.model = model;
    this.speechOutput = speechOutput;
    this.isMicrophoneEnabled = isMicrophoneEnabled;
    this.clearIntervalImpl = clearIntervalImpl;
    this.onDiagnostic = onDiagnostic;
    this.readyState = 'connecting';
    this.label = 'local-events';
    this.listeners = new Map();
    this.entries = [];
    this.outstanding = new Map();
    this.active = null;
    this.toolRounds = 0;
    this.sequence = 0;
    this.speech = { count: 0, responseId: null, generation: 0 };
    this.lastStats = null;
    this.speechInput = createSpeechInput({
      onFinal: (text) => this.handleHeard(text),
      onError: (code) => this.onDiagnostic('speech_input.error', { code }),
    });
    this.speechInputSupported = Boolean(this.speechInput);
    this.micPoll = setIntervalImpl(() => this.syncListening(), MIC_POLL_MS);
    queueMicrotask(() => {
      if (this.readyState !== 'connecting') return;
      this.readyState = 'open';
      this.dispatch('open', {});
      this.syncListening();
    });
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      try {
        listener(event);
      } catch (error) {
        console.error('[GEV local voice] listener failed', error);
      }
    }
  }

  /** Server events go out in order, never re-entrantly inside send(). */
  emit(payload) {
    queueMicrotask(() => {
      if (this.readyState !== 'open') return;
      this.dispatch('message', { data: JSON.stringify(payload) });
    });
  }

  nextId(prefix) {
    this.sequence += 1;
    return `${prefix}_local_${Date.now().toString(36)}_${this.sequence}`;
  }

  send(raw) {
    if (this.readyState !== 'open')
      throw new Error('Local voice channel is not open');
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    switch (message?.type) {
      case 'conversation.item.create':
        this.addItem(message.item);
        break;
      case 'conversation.item.delete':
        this.entries = this.entries.filter(
          (entry) => entry.id !== message.item_id,
        );
        break;
      case 'response.create':
        this.createResponse(message);
        break;
      case 'response.cancel':
        this.cancelResponse(message.response_id);
        break;
      case 'output_audio_buffer.clear':
        this.clearSpeech();
        break;
      default:
        // session.update and audio-buffer events have no local meaning.
        break;
    }
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.clearIntervalImpl(this.micPoll);
    this.active?.abort.abort();
    this.active = null;
    this.speechInput?.dispose();
    this.speechOutput?.cancel();
    for (const waiter of this.outstanding.values()) waiter.resolve?.();
    this.outstanding.clear();
    queueMicrotask(() => this.dispatch('close', {}));
  }

  // ── Conversation ─────────────────────────────────────────────────────────

  addItem(item) {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'function_call_output') {
      const waiter = this.outstanding.get(item.call_id);
      if (!waiter) return;
      waiter.entry.outputs.set(item.call_id, String(item.output ?? ''));
      this.outstanding.delete(item.call_id);
      waiter.resolve?.();
      return;
    }
    if (item.type !== 'message') return;
    const text = textOf(item.content);
    const image = hasImage(item.content);
    const appNote = item.role === 'system' || image;
    if (!text && !image) return;
    this.entries.push({
      id: item.id || this.nextId('item'),
      role: appNote ? 'note' : item.role === 'assistant' ? 'assistant' : 'user',
      content: image ? `${text}\n${SCREENSHOT_NOTE}`.trim() : text,
      toolCalls: [],
      outputs: new Map(),
    });
    if (!appNote && item.role === 'user') this.toolRounds = 0;
  }

  /** The history Ollama receives, newest entries kept within a budget. */
  buildMessages() {
    const kept = [];
    let chars = 0;
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      const size =
        entry.content.length +
        [...entry.outputs.values()].reduce((sum, out) => sum + out.length, 0);
      if (kept.length >= MAX_HISTORY_ENTRIES) break;
      if (kept.length && chars + size > MAX_HISTORY_CHARS) break;
      chars += size;
      kept.unshift(entry);
    }
    const messages = [];
    for (const entry of kept) {
      if (entry.role === 'note') {
        messages.push({
          role: 'user',
          content: `${NOTE_PREFIX} ${entry.content}`,
        });
        continue;
      }
      if (entry.role !== 'assistant') {
        messages.push({ role: 'user', content: entry.content });
        continue;
      }
      messages.push({
        role: 'assistant',
        content: entry.content,
        ...(entry.toolCalls.length
          ? {
              tool_calls: entry.toolCalls.map((call) => ({
                name: call.name,
                arguments: call.arguments,
              })),
            }
          : {}),
      });
      for (const call of entry.toolCalls) {
        messages.push({
          role: 'tool',
          tool_name: call.name,
          content:
            entry.outputs.get(call.callId) ??
            JSON.stringify({ ok: false, error: 'No result was returned.' }),
        });
      }
    }
    // A conversation opens with the user, never with an orphan reply.
    while (messages.length && messages[0].role !== 'user') messages.shift();
    return messages;
  }

  /** Tool results the app is still producing for an earlier response. */
  async awaitOutstanding(signal) {
    const pending = [...this.outstanding.values()];
    if (!pending.length) return;
    let timer;
    let onAbort;
    try {
      await Promise.race([
        Promise.all(pending.map((waiter) => waiter.done)),
        new Promise((resolve) => {
          timer = setTimeout(resolve, OUTSTANDING_TOOL_WAIT_MS);
        }),
        new Promise((resolve) => {
          onAbort = resolve;
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  // ── Responses ────────────────────────────────────────────────────────────

  createResponse(message) {
    const response = message.response || {};
    if (response.conversation === 'none') {
      this.speakProgress(message, response);
      return;
    }
    if (this.active) {
      this.emit({
        type: 'error',
        event_id: message.event_id || null,
        error: {
          type: 'invalid_request_error',
          code: 'conversation_already_has_active_response',
          message: 'A response is already in progress.',
        },
      });
      return;
    }
    void this.runResponse(
      typeof response.instructions === 'string' ? response.instructions : '',
    );
  }

  cancelResponse(responseId) {
    if (this.active && (!responseId || responseId === this.active.id))
      this.active.abort.abort();
    if (!responseId || responseId === this.speech.responseId)
      this.clearSpeech();
  }

  async runResponse(note) {
    const id = this.nextId('resp');
    const abort = new AbortController();
    this.active = { id, abort };
    const itemId = this.nextId('item');
    let text = '';
    let pendingSpeech = '';
    let entry = null;
    const output = [];
    const ensureEntry = () => {
      if (entry) return entry;
      entry = {
        id: itemId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        outputs: new Map(),
      };
      this.entries.push(entry);
      return entry;
    };
    this.emit({
      type: 'response.created',
      response: { id, object: 'realtime.response', status: 'in_progress' },
    });
    let status = 'completed';
    let failure = null;
    try {
      await this.awaitOutstanding(abort.signal);
      if (abort.signal.aborted) throw abort.signal.reason;
      const messages = this.buildMessages();
      if (!messages.length) throw new Error('Nothing to answer yet.');
      const allowTools = this.toolRounds < MAX_TOOL_ROUNDS;
      for await (const event of this.chat({
        model: this.model,
        messages,
        note,
        tools: allowTools,
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) break;
        if (event?.type === 'delta' && event.text) {
          text += event.text;
          pendingSpeech += event.text;
          this.emit({
            type: 'response.output_audio_transcript.delta',
            response_id: id,
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta: event.text,
          });
          const { sentences, rest } = takeSentences(pendingSpeech);
          pendingSpeech = rest;
          for (const sentence of sentences) this.speak(sentence, id);
        } else if (event?.type === 'tool_call' && event.name) {
          const callId = this.nextId('call');
          const target = ensureEntry();
          target.toolCalls.push({
            callId,
            name: event.name,
            arguments: event.arguments || {},
          });
          let resolve;
          const done = new Promise((r) => {
            resolve = r;
          });
          this.outstanding.set(callId, { entry: target, resolve, done });
          const item = {
            id: this.nextId('item'),
            type: 'function_call',
            status: 'completed',
            call_id: callId,
            name: event.name,
            arguments: JSON.stringify(event.arguments || {}),
          };
          output.push(item);
          this.emit({
            type: 'response.output_item.done',
            response_id: id,
            output_index: output.length - 1,
            item,
          });
        } else if (event?.type === 'error') {
          throw new Error(event.error || 'The local model could not answer.');
        } else if (event?.type === 'done') {
          this.lastStats = event.stats || null;
          this.onDiagnostic('local_ai.stats', this.lastStats || {});
        }
      }
      if (abort.signal.aborted) status = 'cancelled';
    } catch (error) {
      if (abort.signal.aborted) status = 'cancelled';
      else {
        status = 'failed';
        failure = error?.message || 'The local model could not answer.';
      }
    }
    if (status !== 'cancelled') {
      const { sentences } = takeSentences(pendingSpeech, { final: true });
      for (const sentence of sentences) this.speak(sentence, id);
    }
    if (text) {
      ensureEntry().content = text;
      this.emit({
        type: 'response.output_audio_transcript.done',
        response_id: id,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        transcript: text,
      });
    }
    if (entry?.toolCalls.length) this.toolRounds += 1;
    if (this.active?.id === id) this.active = null;
    this.emit({
      type: 'response.done',
      response: {
        id,
        object: 'realtime.response',
        status,
        output,
        ...(failure
          ? {
              status_details: {
                type: 'failed',
                reason: 'local_ai',
                error: {
                  type: 'local_ai_error',
                  code: 'local_ai',
                  message: failure,
                },
              },
            }
          : {}),
      },
    });
  }

  /** Out-of-band progress line: read the given text, no model call. */
  speakProgress(message, response) {
    const id = this.nextId('resp');
    const line = textOf(response.input?.[0]?.content).trim();
    this.emit({
      type: 'response.created',
      event_id: message.event_id || null,
      response: {
        id,
        object: 'realtime.response',
        status: 'in_progress',
        metadata: response.metadata || null,
      },
    });
    if (line) this.speak(line, id);
    this.emit({
      type: 'response.done',
      response: {
        id,
        object: 'realtime.response',
        status: 'completed',
        metadata: response.metadata || null,
        output: [],
      },
    });
  }

  // ── Speech ───────────────────────────────────────────────────────────────

  speak(sentence, responseId) {
    if (!this.speechOutput || !sentence) return;
    const generation = this.speech.generation;
    if (this.speech.count === 0) {
      this.speech.responseId = responseId;
      this.emit({
        type: 'output_audio_buffer.started',
        response_id: responseId,
      });
    }
    this.speech.count += 1;
    this.syncListening();
    void this.speechOutput.speak(sentence).then(() => {
      if (generation !== this.speech.generation) return;
      this.speech.count = Math.max(0, this.speech.count - 1);
      if (this.speech.count === 0) {
        this.emit({
          type: 'output_audio_buffer.stopped',
          response_id: this.speech.responseId,
        });
        this.speech.responseId = null;
        this.syncListening();
      }
    });
  }

  clearSpeech() {
    if (!this.speech.count) return;
    const responseId = this.speech.responseId;
    this.speech = {
      count: 0,
      responseId: null,
      generation: this.speech.generation + 1,
    };
    this.speechOutput?.cancel();
    this.emit({ type: 'output_audio_buffer.cleared', response_id: responseId });
    this.syncListening();
  }

  get speaking() {
    return this.speech.count > 0;
  }

  /** Listen only while the mic is live and the assistant is not speaking. */
  syncListening() {
    if (!this.speechInput) return;
    const wanted =
      this.readyState === 'open' &&
      !this.speaking &&
      this.isMicrophoneEnabled();
    if (wanted !== this.speechInput.enabled)
      this.speechInput.setEnabled(wanted);
  }

  /** A finished phrase from the recognizer: one user turn. */
  handleHeard(text) {
    const transcript = String(text || '').trim();
    if (!transcript || this.readyState !== 'open' || this.speaking) return;
    const itemId = this.nextId('item');
    // Speech events are sent together once the phrase is final, so a cough
    // that never becomes words cannot leave the controller waiting on a turn.
    this.emit({
      type: 'input_audio_buffer.speech_started',
      item_id: itemId,
      audio_start_ms: 0,
    });
    this.emit({
      type: 'input_audio_buffer.speech_stopped',
      item_id: itemId,
      audio_end_ms: 0,
    });
    this.entries.push({
      id: itemId,
      role: 'user',
      content: transcript,
      toolCalls: [],
      outputs: new Map(),
    });
    this.toolRounds = 0;
    this.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: itemId,
      content_index: 0,
      transcript,
    });
    // Server-side turn detection answers the phrase itself; so does this.
    queueMicrotask(() => {
      if (this.readyState !== 'open') return;
      if (this.active) {
        const previous = this.active;
        previous.abort.abort();
      }
      const start = () => {
        if (this.readyState === 'open' && !this.active)
          void this.runResponse('');
        else if (this.readyState === 'open') setTimeout(start, 50);
      };
      start();
    });
  }
}
