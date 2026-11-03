import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { LocalRealtimeChannel } from './localChannel.js';

// Every channel a test opens is closed afterwards, so its timers end.
const open = new Set();
function test(name, body) {
  nodeTest(name, async () => {
    try {
      await body();
    } finally {
      for (const channel of open) channel.close();
      open.clear();
    }
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) await tick();
}

function fakeSpeechOutput() {
  const spoken = [];
  const pending = [];
  return {
    spoken,
    finishAll() {
      while (pending.length) pending.shift()();
    },
    speak(text) {
      spoken.push(text);
      return new Promise((resolve) => pending.push(resolve));
    },
    cancel() {
      while (pending.length) pending.shift()();
    },
  };
}

function fixture({
  replies = [],
  micEnabled = () => true,
  speech = true,
} = {}) {
  const requests = [];
  const output = fakeSpeechOutput();
  let input = null;
  const channel = new LocalRealtimeChannel({
    model: 'qwen3:27b',
    chat: async function* (request) {
      requests.push(request);
      const reply = replies.shift() || [
        { type: 'delta', text: 'Okay.' },
        { type: 'done' },
      ];
      for (const event of typeof reply === 'function'
        ? await reply(request)
        : reply) {
        if (request.signal.aborted) return;
        yield event;
      }
    },
    speechOutput: output,
    createSpeechInput: speech
      ? (handlers) => {
          input = {
            ...handlers,
            enabled: false,
            setEnabled(value) {
              this.enabled = value;
            },
            dispose() {},
          };
          return input;
        }
      : () => null,
    isMicrophoneEnabled: micEnabled,
  });
  open.add(channel);
  const events = [];
  channel.addEventListener('message', (event) =>
    events.push(JSON.parse(event.data)),
  );
  return { channel, events, requests, output, input: () => input };
}

const send = (channel, message) => channel.send(JSON.stringify(message));
const types = (events) => events.map((event) => event.type);
const userText = (text) => ({
  type: 'conversation.item.create',
  item: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  },
});

test('opens asynchronously and answers a typed turn with Realtime events', async () => {
  const { channel, events, requests, output } = fixture({
    replies: [
      [
        { type: 'delta', text: 'Flying to Paris. ' },
        { type: 'delta', text: 'Enjoy' },
        { type: 'done' },
      ],
    ],
  });
  assert.equal(channel.readyState, 'connecting');
  let opened = false;
  channel.addEventListener('open', () => {
    opened = true;
  });
  await settle();
  assert.equal(opened, true);
  assert.equal(channel.readyState, 'open');
  send(channel, userText('Go to Paris'));
  send(channel, { type: 'response.create' });
  await settle();
  // Speech starts on the first complete sentence, mid-stream.
  assert.deepEqual(types(events), [
    'response.created',
    'response.output_audio_transcript.delta',
    'output_audio_buffer.started',
    'response.output_audio_transcript.delta',
    'response.output_audio_transcript.done',
    'response.done',
  ]);
  assert.equal(events.at(-1).response.status, 'completed');
  assert.equal(
    events.find((e) => e.type === 'response.output_audio_transcript.done')
      .transcript,
    'Flying to Paris. Enjoy',
  );
  assert.deepEqual(output.spoken, ['Flying to Paris.', 'Enjoy']);
  assert.deepEqual(requests[0].messages, [
    { role: 'user', content: 'Go to Paris' },
  ]);
  assert.equal(requests[0].tools, true);
  output.finishAll();
  await settle();
  assert.equal(events.at(-1).type, 'output_audio_buffer.stopped');
});

test('tool calls become function_call items and the next reply waits for their results', async () => {
  const { channel, events, requests } = fixture({
    replies: [
      [
        {
          type: 'tool_call',
          name: 'fly_to_location',
          arguments: { query: 'Paris' },
        },
        { type: 'done' },
      ],
      [{ type: 'delta', text: 'Here is Paris.' }, { type: 'done' }],
    ],
  });
  await settle();
  send(channel, userText('Paris'));
  send(channel, { type: 'response.create' });
  await settle();
  const call = events.find(
    (event) => event.type === 'response.output_item.done',
  );
  assert.equal(call.item.type, 'function_call');
  assert.equal(call.item.name, 'fly_to_location');
  assert.equal(call.item.arguments, '{"query":"Paris"}');
  assert.equal(call.response_id, events[0].response.id);

  // The follow-up arrives before the tool result: it must wait for it.
  send(channel, {
    type: 'response.create',
    response: { instructions: 'Briefly confirm.' },
  });
  await settle();
  assert.equal(requests.length, 1);
  send(channel, {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: call.item.call_id,
      output: '{"ok":true}',
    },
  });
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].note, 'Briefly confirm.');
  assert.deepEqual(requests[1].messages, [
    { role: 'user', content: 'Paris' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ name: 'fly_to_location', arguments: { query: 'Paris' } }],
    },
    { role: 'tool', tool_name: 'fly_to_location', content: '{"ok":true}' },
  ]);
});

test('an overlapping response.create is refused with the Realtime error code', async () => {
  let release;
  const { channel, events } = fixture({
    replies: [
      async () => {
        await new Promise((resolve) => {
          release = resolve;
        });
        return [{ type: 'delta', text: 'Done.' }, { type: 'done' }];
      },
    ],
  });
  await settle();
  send(channel, userText('hi'));
  send(channel, { type: 'response.create' });
  send(channel, { type: 'response.create', event_id: 'evt_2' });
  await settle();
  const error = events.find((event) => event.type === 'error');
  assert.equal(error.error.code, 'conversation_already_has_active_response');
  assert.equal(error.event_id, 'evt_2');
  release();
  await settle();
  assert.equal(events.at(-1).type, 'response.done');
});

test('response.cancel ends the active reply as cancelled', async () => {
  let release;
  const { channel, events } = fixture({
    replies: [
      async () => {
        await new Promise((resolve) => {
          release = resolve;
        });
        return [{ type: 'delta', text: 'Too late.' }];
      },
    ],
  });
  await settle();
  send(channel, userText('hi'));
  send(channel, { type: 'response.create' });
  await settle();
  send(channel, {
    type: 'response.cancel',
    response_id: events[0].response.id,
  });
  release();
  await settle();
  const done = events.find((event) => event.type === 'response.done');
  assert.equal(done.response.status, 'cancelled');
  assert.equal(
    events.some((e) => e.type === 'response.output_audio_transcript.delta'),
    false,
  );
});

test('a failed chat becomes a failed response.done with the reason', async () => {
  const { channel, events } = fixture({
    replies: [[{ type: 'error', error: 'Ollama is not reachable.' }]],
  });
  await settle();
  send(channel, userText('hi'));
  send(channel, { type: 'response.create' });
  await settle();
  const done = events.find((event) => event.type === 'response.done');
  assert.equal(done.response.status, 'failed');
  assert.equal(
    done.response.status_details.error.message,
    'Ollama is not reachable.',
  );
});

test('progress lines are spoken verbatim without calling the model', async () => {
  const { channel, events, requests, output } = fixture();
  await settle();
  send(channel, {
    type: 'response.create',
    event_id: 'gev_progress_1',
    response: {
      conversation: 'none',
      metadata: { gev: 'progress' },
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Looking that up.' }],
        },
      ],
    },
  });
  await settle();
  assert.equal(requests.length, 0);
  assert.deepEqual(output.spoken, ['Looking that up.']);
  assert.equal(events[0].response.metadata.gev, 'progress');
  assert.equal(
    events.find((e) => e.type === 'response.done').response.metadata.gev,
    'progress',
  );
});

test('map events and screenshots reach the model as labelled app notes', async () => {
  const { channel, requests } = fixture();
  await settle();
  send(channel, {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: '{"event":"outline"}' }],
    },
  });
  send(channel, {
    type: 'conversation.item.create',
    item: {
      id: 'msg_view',
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Current viewport.' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' },
      ],
    },
  });
  send(channel, userText('What is this?'));
  send(channel, { type: 'response.create' });
  await settle();
  const [first, second, third] = requests[0].messages;
  assert.match(
    first.content,
    /^\[App context — data, not the user speaking\] \{"event":"outline"\}/,
  );
  assert.match(
    second.content,
    /Current viewport\.\n\(A screenshot was attached/,
  );
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /base64/);
  assert.deepEqual(third, { role: 'user', content: 'What is this?' });

  send(channel, { type: 'conversation.item.delete', item_id: 'msg_view' });
  send(channel, userText('And now?'));
  send(channel, { type: 'response.create' });
  await settle();
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /Current viewport/);
});

test('a heard phrase is a user turn that answers itself', async () => {
  const { channel, events, requests, input } = fixture();
  await settle();
  assert.equal(input().enabled, true, 'listening while the mic is on');
  input().onFinal('zoom into London');
  await settle();
  assert.deepEqual(types(events).slice(0, 4), [
    'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped',
    'conversation.item.input_audio_transcription.completed',
    'response.created',
  ]);
  assert.equal(events[2].transcript, 'zoom into London');
  assert.deepEqual(requests[0].messages, [
    { role: 'user', content: 'zoom into London' },
  ]);
});

test('recognition pauses while the assistant speaks and follows the mic gate', async () => {
  let mic = true;
  const { channel, input, output, events } = fixture({ micEnabled: () => mic });
  await settle();
  send(channel, userText('hi'));
  send(channel, { type: 'response.create' });
  await settle();
  assert.equal(channel.speaking, true);
  assert.equal(input().enabled, false, 'no listening over our own voice');
  input().onFinal('echo of the assistant');
  output.finishAll();
  await settle();
  assert.equal(input().enabled, true);
  assert.equal(
    events.some(
      (e) => e.type === 'conversation.item.input_audio_transcription.completed',
    ),
    false,
  );
  mic = false;
  channel.syncListening();
  assert.equal(input().enabled, false, 'push-to-talk released');
});

test('output_audio_buffer.clear stops speech and reports cleared', async () => {
  const { channel, events } = fixture();
  await settle();
  send(channel, userText('hi'));
  send(channel, { type: 'response.create' });
  await settle();
  send(channel, { type: 'output_audio_buffer.clear' });
  await settle();
  assert.equal(channel.speaking, false);
  assert.equal(events.at(-1).type, 'output_audio_buffer.cleared');
});

test('tools are withheld after repeated tool rounds until the user speaks', async () => {
  const toolReply = [
    { type: 'tool_call', name: 'zoom', arguments: {} },
    { type: 'done' },
  ];
  const { channel, events, requests } = fixture({
    replies: [toolReply, toolReply, toolReply, toolReply, toolReply],
  });
  await settle();
  send(channel, userText('loop'));
  for (let round = 0; round < 5; round += 1) {
    send(channel, { type: 'response.create' });
    await settle();
    const call = events
      .filter((e) => e.type === 'response.output_item.done')
      .at(-1);
    send(channel, {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: call.item.call_id,
        output: '{}',
      },
    });
    await settle();
  }
  assert.deepEqual(
    requests.map((request) => request.tools),
    [true, true, true, true, false],
  );
  send(channel, userText('thanks'));
  send(channel, { type: 'response.create' });
  await settle();
  assert.equal(requests.at(-1).tools, true);
});

test('close stops everything and reports close once', async () => {
  const { channel } = fixture();
  await settle();
  let closes = 0;
  channel.addEventListener('close', () => {
    closes += 1;
  });
  channel.close();
  channel.close();
  await settle();
  assert.equal(closes, 1);
  assert.equal(channel.readyState, 'closed');
  assert.throws(() => send(channel, userText('x')), /not open/);
});

test('without speech recognition the channel still serves typed commands', async () => {
  const { channel, requests } = fixture({ speech: false });
  await settle();
  assert.equal(channel.speechInputSupported, false);
  send(channel, userText('hi'));
  send(channel, { type: 'response.create' });
  await settle();
  assert.equal(requests.length, 1);
});
