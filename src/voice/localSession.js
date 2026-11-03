import { GevRealtimeController } from './realtimeController.js';
import { createRealtimeSession } from './realtimeSession.js';
import {
  createLocalVoiceBackend,
  readStoredLocalModel,
  writeStoredLocalModel,
} from './localBackend.js';
import { speechInputSupported } from './localSpeech.js';
import { t } from '../i18n/index.js';

/** Short button label for a model id: `qwen3:27b` → `QWEN3:27B`. */
export function localModelLabel(model) {
  const text =
    String(model || '')
      .split('/')
      .pop() || '';
  return text.length > 12 ? `${text.slice(0, 11)}…` : text.toUpperCase();
}

/** The next installed model after `current`, wrapping around. */
export function nextLocalModel(models, current) {
  if (!Array.isArray(models) || !models.length) return null;
  const index = models.indexOf(current);
  return models[(index + 1) % models.length];
}

/**
 * The Realtime controller driving a local model. Turns, tools, narration and
 * captions are inherited; what differs is that nothing is billed, so the cost
 * readout is hidden and the tier button picks the local model instead.
 */
export class LocalVoiceController extends GevRealtimeController {
  constructor(options) {
    super(options);
    this.localModels = [];
    this.localModel = readStoredLocalModel();
    this.localServedModel = null;
  }

  async refreshLocalModels() {
    try {
      const described = await this.backend.describe({ model: this.localModel });
      this.localModels = described.models;
      this.localModel = described.model;
    } catch (error) {
      this.localModels = [];
      this.debugLog('local_ai.models.failed', {
        error: error?.message || String(error),
      });
    }
    this.syncCostUi();
  }

  syncCostUi() {
    if (!this.ui) return;
    this.ui.update('cost', { hidden: true });
    this.ui.update('costWarning', { hidden: true, text: '' });
    const model = this.localModel;
    const served = this.localServedModel;
    this.ui.update('tier', {
      hidden: false,
      pressed: false,
      text: model ? localModelLabel(model) : t('LOCAL'),
      title: !model
        ? t('Local model: none found — start Ollama and install a model')
        : this.isActive() && served && served !== model
          ? t('Next session: {pendingId} — this session stays on {modelId}', {
              pendingId: model,
              modelId: served,
            })
          : t('Local model: {model} — click to switch; applies next session', {
              model,
            }),
    });
  }

  /** The tier button cycles through the models Ollama has installed. */
  toggleVoiceTier() {
    if (this.localModels.length < 2) {
      void this.refreshLocalModels();
      return this.localModel;
    }
    this.localModel = writeStoredLocalModel(
      nextLocalModel(this.localModels, this.localModel),
    );
    this.syncCostUi();
    if (this.isActive())
      this.setStatus(
        this.status,
        t('{model} applies next session', {
          model: this.localModel,
        }),
      );
    return this.localModel;
  }

  recordUsage() {
    return null;
  }

  recordTranscriptionUsage() {
    return null;
  }

  async start(settings) {
    if (!speechInputSupported())
      console.warn(
        '[GEV local voice] this browser has no speech recognition; typed commands still work.',
      );
    const result = await super.start(settings);
    const served = this.dc?.model ?? null;
    if (served) {
      this.localServedModel = served;
      this.localModel = served;
      this.syncCostUi();
      // After the channel's own "listening" update, which lands first.
      if (this.dc && !this.dc.speechInputSupported)
        setTimeout(() => {
          if (this.status === 'listening')
            this.setStatus(
              'listening',
              t('Speech input unavailable here — type a command'),
            );
        }, 0);
    }
    return result;
  }
}

/** Voice session for the Local AI provider (Ollama). */
export function createLocalSession({
  backend = createLocalVoiceBackend(),
  createController = (options) => new LocalVoiceController(options),
  ...options
}) {
  const session = createRealtimeSession({
    ...options,
    backend,
    createController,
  });
  const { controller } = session;
  return {
    ...session,
    capabilities: { costControls: false, pushToTalk: true },
    bindControls() {
      session.bindControls();
      void controller.refreshLocalModels?.();
    },
  };
}
