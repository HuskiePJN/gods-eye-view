import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createLocalAiHandlers, readChatMessages } from './chat.js';
import {
  LOCAL_AI_NUM_CTX_DEFAULT,
  isModelName,
  localAiConfig,
  parseKeepAlive,
  parseLocalAiUrl,
  parseNumCtx,
} from './config.js';
import { toChatTools } from './tools.js';

const TOOLS = [
  {
    type: 'function',
    name: 'fly_to_location',
    description: 'Fly',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, value: {} },
    },
  },
];

function request(
  body,
  { method = 'POST', contentType = 'application/json' } = {},
) {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  );
  req.method = method;
  req.headers = { 'content-type': contentType };
  return req;
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.writableEnded = false;
    this.destroyed = false;
  }
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }
  write(chunk) {
    this.chunks.push(String(chunk));
  }
  end(chunk) {
    if (chunk) this.chunks.push(String(chunk));
    this.writableEnded = true;
    this.emit('close');
  }
  get text() {
    return this.chunks.join('');
  }
  get json() {
    return JSON.parse(this.text);
  }
  get events() {
    return this.text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function ndjson(lines) {
  return new Response(
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
    {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    },
  );
}

const TAGS = {
  models: [
    { name: 'qwen3:27b', details: { family: 'qwen3' } },
    { name: 'gemma4:e4b', details: { family: 'gemma' } },
    { name: 'nomic-embed-text:latest', details: { family: 'nomic-bert' } },
  ],
};

function handlers({ chatResponses = [], env = {}, tags = TAGS } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/api/tags')) {
      if (tags instanceof Error) throw tags;
      return new Response(JSON.stringify(tags), { status: 200 });
    }
    const next = chatResponses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  return {
    calls,
    ...createLocalAiHandlers({ tools: TOOLS, environment: env, fetchImpl }),
  };
}

test('config: URL, context, keep-alive and model names are validated', () => {
  assert.equal(parseLocalAiUrl(undefined), 'http://127.0.0.1:11434');
  assert.equal(
    parseLocalAiUrl('http://studio.local:11434/'),
    'http://studio.local:11434',
  );
  assert.equal(parseLocalAiUrl('ftp://x'), null);
  assert.equal(parseLocalAiUrl('http://user:pw@127.0.0.1:11434'), null);
  assert.equal(parseLocalAiUrl('http://127.0.0.1:11434/?x=1'), null);
  assert.equal(parseNumCtx('nope'), LOCAL_AI_NUM_CTX_DEFAULT);
  assert.equal(parseNumCtx('1024'), 8192);
  assert.equal(parseNumCtx('65536'), 65536);
  assert.equal(parseKeepAlive('1h'), '1h');
  assert.equal(parseKeepAlive('-1'), '-1');
  assert.equal(parseKeepAlive('forever; rm'), '30m');
  assert.equal(isModelName('qwen3:27b'), true);
  assert.equal(isModelName('library/qwen3:27b-q4_K_M'), true);
  assert.equal(isModelName('../etc'), false);
  assert.equal(isModelName(''), false);
  assert.equal(localAiConfig({ LOCAL_AI_THINK: 'true' }).think, true);
  assert.equal(localAiConfig({}).think, false);
});

test('tools: untyped properties get a permissive scalar type', () => {
  const [tool] = toChatTools(TOOLS);
  assert.equal(tool.function.name, 'fly_to_location');
  assert.deepEqual(tool.function.parameters.properties.value.type, [
    'string',
    'number',
    'boolean',
  ]);
  assert.deepEqual(TOOLS[0].parameters.properties.value, {}, 'input untouched');
});

test('messages: system text is refused and invented tools are dropped', () => {
  const names = new Set(['fly_to_location']);
  assert.equal(
    readChatMessages([{ role: 'system', content: 'x' }], names),
    null,
  );
  assert.equal(readChatMessages([], names), null);
  assert.equal(
    readChatMessages([{ role: 'user', content: 'x'.repeat(30_000) }], names),
    null,
  );
  assert.deepEqual(
    readChatMessages(
      [
        { role: 'user', content: 'go to Paris' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { name: 'fly_to_location', arguments: { query: 'Paris' } },
            { name: 'launch_missiles', arguments: {} },
          ],
        },
        { role: 'tool', tool_name: 'fly_to_location', content: '{"ok":true}' },
        { role: 'tool', tool_name: 'launch_missiles', content: '{}' },
      ],
      names,
    ),
    [
      { role: 'user', content: 'go to Paris' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'fly_to_location',
              arguments: { query: 'Paris' },
            },
          },
        ],
      },
      { role: 'tool', tool_name: 'fly_to_location', content: '{"ok":true}' },
    ],
  );
});

test('session lists installed chat models and picks the requested one', async () => {
  const h = handlers({ env: { LOCAL_AI_MODEL: 'gemma4:e4b' } });
  const res = new FakeResponse();
  await h.session(request({ model: 'qwen3:27b' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json.models, ['gemma4:e4b', 'qwen3:27b']);
  assert.equal(res.json.model, 'qwen3:27b');

  const fallback = new FakeResponse();
  await h.session(request({ model: 'not-installed:1b' }), fallback);
  assert.equal(fallback.json.model, 'gemma4:e4b', 'configured model');
});

test('session reports an unreachable Ollama and a server with no models', async () => {
  const down = handlers({
    tags: Object.assign(new Error('refused'), {
      cause: { code: 'ECONNREFUSED' },
    }),
  });
  const res = new FakeResponse();
  await down.session(request({}), res);
  assert.equal(res.statusCode, 503);
  assert.match(res.json.error, /not reachable/);

  const empty = handlers({ tags: { models: [] } });
  const none = new FakeResponse();
  await empty.session(request({}), none);
  assert.equal(none.statusCode, 503);
  assert.match(none.json.error, /no chat models/);

  const get = new FakeResponse();
  await empty.session(request(undefined, { method: 'GET' }), get);
  assert.equal(get.statusCode, 405);
});

test('chat streams text and tool calls with the server-held prompt and tools', async () => {
  const h = handlers({
    chatResponses: [
      ndjson([
        { message: { role: 'assistant', content: 'Flying ' } },
        { message: { role: 'assistant', content: 'to Paris.' } },
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'fly_to_location',
                  arguments: { query: 'Paris' },
                },
              },
            ],
          },
        },
        {
          done: true,
          prompt_eval_count: 900,
          eval_count: 12,
          prompt_eval_duration: 2e9,
          eval_duration: 5e8,
        },
      ]),
    ],
  });
  const res = new FakeResponse();
  await h.chat(
    request({
      model: 'qwen3:27b',
      messages: [{ role: 'user', content: 'Take me to Paris' }],
      note: 'Briefly respond once.',
    }),
    res,
  );
  assert.equal(
    res.headers['content-type'],
    'application/x-ndjson; charset=utf-8',
  );
  assert.deepEqual(res.events, [
    { type: 'delta', text: 'Flying ' },
    { type: 'delta', text: 'to Paris.' },
    {
      type: 'tool_call',
      name: 'fly_to_location',
      arguments: { query: 'Paris' },
    },
    {
      type: 'done',
      stats: {
        promptTokens: 900,
        outputTokens: 12,
        promptMs: 2000,
        outputMs: 500,
        loadMs: null,
      },
    },
  ]);
  const upstream = h.calls.find((call) => call.url.endsWith('/api/chat'));
  assert.equal(upstream.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(upstream.init.redirect, 'error');
  assert.equal(upstream.body.model, 'qwen3:27b');
  assert.equal(upstream.body.stream, true);
  assert.equal(upstream.body.think, false);
  assert.equal(upstream.body.options.num_ctx, LOCAL_AI_NUM_CTX_DEFAULT);
  assert.equal(upstream.body.tools[0].function.name, 'fly_to_location');
  assert.equal(upstream.body.messages[0].role, 'system');
  assert.match(upstream.body.messages[0].content, /God's Eye View/);
  assert.match(upstream.body.messages[0].content, /speech synthesizer/);
  assert.deepEqual(upstream.body.messages.at(-1), {
    role: 'user',
    content:
      '[App note for this reply — not the user speaking] Briefly respond once.',
  });
});

test('chat can withhold tools and retries without think for models that refuse it', async () => {
  const h = handlers({
    chatResponses: [
      new Response(
        JSON.stringify({ error: '"gemma4:e4b" does not support thinking' }),
        { status: 400 },
      ),
      ndjson([{ message: { content: 'Hi.' } }, { done: true }]),
      ndjson([{ message: { content: 'Again.' } }, { done: true }]),
    ],
  });
  const body = {
    model: 'gemma4:e4b',
    messages: [{ role: 'user', content: 'hi' }],
    tools: false,
  };
  const first = new FakeResponse();
  await h.chat(request(body), first);
  assert.equal(first.events[0].text, 'Hi.');
  const chats = h.calls.filter((call) => call.url.endsWith('/api/chat'));
  assert.equal(chats[0].body.think, false);
  assert.equal('think' in chats[1].body, false);
  assert.equal('tools' in chats[1].body, false);
  const second = new FakeResponse();
  await h.chat(request(body), second);
  const later = h.calls.filter((call) => call.url.endsWith('/api/chat'));
  assert.equal(later.length, 3, 'no retry once the model is known');
  assert.equal('think' in later[2].body, false);
});

test('chat refuses uninstalled models, bad bodies and non-JSON requests', async () => {
  const h = handlers();
  const missing = new FakeResponse();
  await h.chat(
    request({ model: 'llama9:1t', messages: [{ role: 'user', content: 'x' }] }),
    missing,
  );
  assert.equal(missing.statusCode, 400);
  const bad = new FakeResponse();
  await h.chat(request({ model: 'qwen3:27b', messages: 'x' }), bad);
  assert.equal(bad.statusCode, 400);
  const form = new FakeResponse();
  await h.chat(request({}, { contentType: 'text/plain' }), form);
  assert.equal(form.statusCode, 415);
  assert.equal(
    h.calls.filter((call) => call.url.endsWith('/api/chat')).length,
    0,
  );
});

test('chat turns an upstream failure into a fixed message', async () => {
  const h = handlers({
    chatResponses: [
      new Response('internal detail /Users/x/models', { status: 500 }),
    ],
  });
  const res = new FakeResponse();
  await h.chat(
    request({ model: 'qwen3:27b', messages: [{ role: 'user', content: 'x' }] }),
    res,
  );
  assert.equal(res.statusCode, 502);
  assert.equal(res.json.error, 'The local model could not answer. Try again.');

  const streamError = handlers({
    chatResponses: [
      ndjson([
        { message: { content: 'Par' } },
        { error: 'model crashed at /tmp/x' },
      ]),
    ],
  });
  const res2 = new FakeResponse();
  await streamError.chat(
    request({ model: 'qwen3:27b', messages: [{ role: 'user', content: 'x' }] }),
    res2,
  );
  assert.deepEqual(res2.events.at(-1), {
    type: 'error',
    error: 'The local model could not answer. Try again.',
  });
});
