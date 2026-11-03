import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseVoice,
  createBrowserSpeechInput,
  createBrowserSpeechOutput,
  speechInputSupported,
  takeSentences,
} from './localSpeech.js';
import {
  createLocalVoiceBackend,
  readNdjsonEvents,
  readStoredLocalModel,
  writeStoredLocalModel,
} from './localBackend.js';
import { localModelLabel, nextLocalModel } from './localSession.js';

test('sentences are released at sentence ends, the rest at the end', () => {
  assert.deepEqual(takeSentences('Flying to Paris. It is'), {
    sentences: ['Flying to Paris.'],
    rest: 'It is',
  });
  assert.deepEqual(takeSentences('Pi is 3.14 today'), {
    sentences: [],
    rest: 'Pi is 3.14 today',
  });
  assert.deepEqual(takeSentences('Done.'), { sentences: [], rest: 'Done.' });
  assert.deepEqual(takeSentences('Done. Next', { final: true }), {
    sentences: ['Done.', 'Next'],
    rest: '',
  });
});

test('a local voice in the language is preferred', () => {
  const voices = [
    { name: 'Remote US', lang: 'en-US', localService: false },
    { name: 'Samantha', lang: 'en-US', localService: true },
    { name: 'Anna', lang: 'de-DE', localService: true },
  ];
  assert.equal(chooseVoice(voices, 'en-US').name, 'Samantha');
  assert.equal(chooseVoice(voices, 'de').name, 'Anna');
  assert.equal(chooseVoice(voices, 'ja-JP'), null);
  assert.equal(chooseVoice([], 'en'), null);
});

function fakeRecognizerScope() {
  const instances = [];
  class Recognizer {
    constructor() {
      this.processLocally = false;
      instances.push(this);
      this.started = 0;
      this.stopped = 0;
    }
    start() {
      this.started += 1;
    }
    stop() {
      this.stopped += 1;
      this.onend?.();
    }
    abort() {
      this.onend?.();
    }
  }
  return { scope: { webkitSpeechRecognition: Recognizer }, instances };
}

const result = (text, isFinal) =>
  Object.assign([{ transcript: text }], { isFinal });

test('speech input reports finals, restarts after silence and stops on demand', () => {
  const { scope, instances } = fakeRecognizerScope();
  assert.equal(speechInputSupported(scope), true);
  assert.equal(speechInputSupported({}), false);
  const timers = [];
  const heard = [];
  let started = 0;
  const input = createBrowserSpeechInput({
    lang: 'en-US',
    scope,
    onSpeechStart: () => {
      started += 1;
    },
    onFinal: (text) => heard.push(text),
    setTimer: (fn) => timers.push(fn),
  });
  input.setEnabled(true);
  const first = instances[0];
  assert.equal(first.lang, 'en-US');
  assert.equal(first.continuous, true);
  assert.equal(first.processLocally, true, 'on-device first where offered');
  first.onresult({ resultIndex: 0, results: [result('zoom in', false)] });
  first.onresult({
    resultIndex: 0,
    results: [result('zoom into London', true)],
  });
  assert.deepEqual(heard, ['zoom into London']);
  assert.equal(started, 1);

  // The browser ends a session after silence; it is resumed.
  first.onend();
  timers.shift()();
  assert.equal(instances.length, 2);

  // No on-device pack: the next session uses the browser default.
  instances[1].onerror({ error: 'language-not-supported' });
  instances[1].onend();
  timers.shift()();
  assert.equal(instances[2].processLocally, false);

  input.setEnabled(false);
  assert.equal(instances[2].stopped, 1, 'stop flushes the phrase so far');
  assert.equal(timers.length, 0, 'no restart once disabled');
  input.dispose();
});

test('speech output resolves per sentence and cancel clears the queue', async () => {
  const spoken = [];
  let cancelled = 0;
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  const scope = {
    SpeechSynthesisUtterance: Utterance,
    speechSynthesis: {
      getVoices: () => [
        { lang: 'en-US', localService: true, name: 'Samantha' },
      ],
      speak(utterance) {
        spoken.push(utterance);
      },
      cancel() {
        cancelled += 1;
        spoken.forEach((utterance) => utterance.onend?.());
      },
    },
  };
  const output = createBrowserSpeechOutput({ lang: 'en-US', scope });
  const done = output.speak('Hello there.');
  assert.equal(output.speaking, true);
  assert.equal(spoken[0].voice.name, 'Samantha');
  spoken[0].onend();
  await done;
  assert.equal(output.speaking, false);
  void output.speak('One.');
  output.cancel();
  assert.equal(cancelled, 1);
  assert.equal(output.speaking, false);
  assert.equal(createBrowserSpeechOutput({ scope: {} }), null);
});

test('NDJSON streams parse across chunk boundaries', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"type":"delta","te'));
      controller.enqueue(
        encoder.encode('xt":"Hi"}\nnot json\n{"type":"done"}'),
      );
      controller.close();
    },
  });
  const events = [];
  for await (const event of readNdjsonEvents(body)) events.push(event);
  assert.deepEqual(events, [{ type: 'delta', text: 'Hi' }, { type: 'done' }]);
});

test('the backend names the served model and remembers the choice', async () => {
  const requests = [];
  const backend = createLocalVoiceBackend({
    readModel: () => 'gemma4:e4b',
    transport: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({
          model: 'gemma4:e4b',
          models: ['gemma4:e4b', 'qwen3:27b'],
        }),
        { status: 200 },
      );
    },
  });
  const minted = await backend.requestToken({});
  assert.equal(minted.local, true);
  assert.equal(minted.model, 'gemma4:e4b');
  assert.deepEqual(minted.models, ['gemma4:e4b', 'qwen3:27b']);
  assert.deepEqual(requests[0], {
    url: '/api/local-ai/session',
    body: { model: 'gemma4:e4b' },
  });

  const failing = createLocalVoiceBackend({
    transport: async () =>
      new Response(JSON.stringify({ error: 'Ollama is not reachable.' }), {
        status: 503,
      }),
  });
  await assert.rejects(failing.requestToken({}), /Ollama is not reachable/);

  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  assert.equal(readStoredLocalModel(storage), null);
  writeStoredLocalModel('qwen3:27b', storage);
  assert.equal(readStoredLocalModel(storage), 'qwen3:27b');
  assert.equal(
    readStoredLocalModel({
      getItem: () => {
        throw new Error('denied');
      },
    }),
    null,
  );
});

test('the model button shows a short name and cycles installed models', () => {
  assert.equal(localModelLabel('qwen3:27b'), 'QWEN3:27B');
  assert.equal(localModelLabel('library/gemma4:e4b'), 'GEMMA4:E4B');
  assert.equal(localModelLabel('a-very-long-model-name:latest').length, 12);
  assert.equal(nextLocalModel(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(nextLocalModel(['a', 'b', 'c'], 'c'), 'a');
  assert.equal(nextLocalModel(['a', 'b'], 'gone'), 'a');
  assert.equal(nextLocalModel([], 'a'), null);
});
