import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestVoiceUi } from '../testSupport/voiceUi.mjs';
import { LocalRealtimeChannel } from './localChannel.js';
import { LocalVoiceController } from './localSession.js';

const settle = async (times = 12) => {
  for (let i = 0; i < times; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * The real Realtime controller (turns, tools, follow-ups) over the local
 * channel, with a scripted model: a typed command runs its tool, the result
 * goes back to the model, and the model's confirmation is spoken.
 */
test('a typed command runs its tool and the local model confirms it', async () => {
  const executed = [];
  const requests = [];
  const spoken = [];
  const replies = [
    [
      {
        type: 'tool_call',
        name: 'fly_to_location',
        arguments: { query: 'Paris' },
      },
      { type: 'done' },
    ],
    [{ type: 'delta', text: 'Here is Paris.' }, { type: 'done' }],
  ];
  const controller = new LocalVoiceController({
    runner: async (name, args) => {
      executed.push({ name, args });
      return { ok: true, action: name, place: 'Paris' };
    },
    backend: { describe: async () => ({ model: 'qwen3:27b', models: [] }) },
    debugSink: null,
    ui: createTestVoiceUi(),
  });
  controller._turns.narration = null;
  const channel = new LocalRealtimeChannel({
    model: 'qwen3:27b',
    chat: async function* (request) {
      requests.push(request);
      yield* replies.shift() || [];
    },
    speechOutput: {
      speak: async (text) => {
        spoken.push(text);
      },
      cancel() {},
    },
  });
  try {
    controller.dc = channel;
    controller._connection.bindChannel(
      channel,
      () => controller.dc === channel,
    );
    controller.status = 'connecting';
    await settle();
    assert.equal(controller.status, 'listening');

    controller.sendTextCommand('Take me to Paris');
    await settle();

    assert.deepEqual(executed, [
      { name: 'fly_to_location', args: { query: 'Paris' } },
    ]);
    assert.equal(requests.length, 2, 'one call for the tool, one to confirm');
    const toolMessage = requests[1].messages.find(
      (message) => message.role === 'tool',
    );
    assert.equal(toolMessage.tool_name, 'fly_to_location');
    assert.equal(JSON.parse(toolMessage.content).place, 'Paris');
    assert.deepEqual(spoken, ['Here is Paris.']);
    assert.equal(controller.status, 'listening');
    assert.equal(controller.responseActive, false);
  } finally {
    controller.stop();
    channel.close();
  }
});

test('the local controller hides spend and shows the model on the tier button', () => {
  const ui = createTestVoiceUi();
  const controller = new LocalVoiceController({
    runner: async () => ({ ok: true }),
    backend: {},
    debugSink: null,
    ui,
  });
  try {
    controller.localModel = 'qwen3:27b';
    controller.localModels = ['gemma4:e4b', 'qwen3:27b'];
    controller.syncCostUi();
    assert.equal(ui.state.cost.hidden, true);
    assert.equal(ui.state.tier.hidden, false);
    assert.equal(ui.state.tier.text, 'QWEN3:27B');
    assert.equal(controller.recordUsage({ input_tokens: 9_000 }), null);
    controller.toggleVoiceTier();
    assert.equal(controller.localModel, 'gemma4:e4b');
    assert.equal(ui.state.tier.text, 'GEMMA4:E4B');
  } finally {
    controller.stop();
  }
});
