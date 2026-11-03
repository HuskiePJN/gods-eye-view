/**
 * Browser speech for the Local AI voice provider.
 *
 * Input uses the Web Speech API's recognizer and output uses speechSynthesis
 * with the system's voices. Neither needs a key. Where the recognizer runs is
 * the browser's choice: Chrome can recognize on-device when it has the
 * language pack (`processLocally`), and otherwise — like Safari — may send the
 * audio to its vendor's speech service. Text from the model never leaves the
 * machine.
 */

const RESTART_DELAY_MS = 250;

function recognizerClass(scope = globalThis) {
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
}

/** Whether this browser can turn speech into text at all. */
export function speechInputSupported(scope = globalThis) {
  return Boolean(recognizerClass(scope));
}

/**
 * Continuous recognizer that can be gated on and off (push-to-talk, or while
 * the assistant speaks). `stop()` asks the recognizer for a final result of
 * what was heard so far, so releasing Space still sends the phrase.
 */
export function createBrowserSpeechInput({
  lang,
  onSpeechStart = () => {},
  onSpeechEnd = () => {},
  onFinal = () => {},
  onError = () => {},
  scope = globalThis,
  setTimer = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  const Recognizer = recognizerClass(scope);
  if (!Recognizer) return null;
  let recognition = null;
  let wanted = false;
  let running = false;
  let heard = false;
  let preferLocal = true;
  let disposed = false;

  const build = () => {
    const next = new Recognizer();
    next.continuous = true;
    next.interimResults = true;
    next.maxAlternatives = 1;
    if (lang) next.lang = lang;
    // Chrome's on-device recognition; ignored where the property is absent.
    if (preferLocal && 'processLocally' in next) next.processLocally = true;
    next.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = String(result?.[0]?.transcript || '').trim();
        if (!text) continue;
        if (!heard) {
          heard = true;
          onSpeechStart();
        }
        if (result.isFinal) {
          heard = false;
          onSpeechEnd();
          onFinal(text);
        }
      }
    };
    next.onerror = (event) => {
      const code = event?.error || 'unknown';
      if (code === 'no-speech' || code === 'aborted') return;
      if (
        preferLocal &&
        'processLocally' in next &&
        (code === 'language-not-supported' || code === 'service-not-allowed')
      ) {
        // No on-device pack for this language: use the browser's default.
        preferLocal = false;
        return;
      }
      if (code === 'not-allowed') wanted = false;
      onError(code);
    };
    next.onend = () => {
      running = false;
      if (heard) {
        heard = false;
        onSpeechEnd();
      }
      // Chrome ends a "continuous" session after a silence; resume it.
      if (wanted && !disposed)
        setTimer(() => {
          if (wanted && !running && !disposed) begin();
        }, RESTART_DELAY_MS);
    };
    return next;
  };

  const begin = () => {
    if (running || disposed) return;
    recognition = build();
    try {
      recognition.start();
      running = true;
    } catch {
      running = false;
    }
  };

  return {
    /** Listen (true) or stop and flush what was heard (false). */
    setEnabled(enabled) {
      wanted = Boolean(enabled) && !disposed;
      if (wanted) begin();
      else if (running) {
        try {
          recognition?.stop();
        } catch {
          /* already stopped */
        }
      }
    },
    get enabled() {
      return wanted;
    },
    dispose() {
      disposed = true;
      wanted = false;
      try {
        recognition?.abort();
      } catch {
        /* no-op */
      }
      recognition = null;
    },
  };
}

/** Pick a system voice for the language, preferring a local one. */
export function chooseVoice(voices, lang) {
  if (!Array.isArray(voices) || !voices.length) return null;
  const wanted = String(lang || 'en').toLowerCase();
  const base = wanted.split('-')[0];
  const matches = (voice) => String(voice.lang || '').toLowerCase();
  const ranked = [
    (v) => matches(v) === wanted && v.localService,
    (v) => matches(v).startsWith(base) && v.localService,
    (v) => matches(v) === wanted,
    (v) => matches(v).startsWith(base),
  ];
  for (const test of ranked) {
    const found = voices.find(test);
    if (found) return found;
  }
  return null;
}

/**
 * Queue sentences for speechSynthesis. `speak` resolves when that sentence
 * ends (or is cancelled); `cancel` drops everything queued.
 */
export function createBrowserSpeechOutput({
  lang,
  rate = 1.05,
  scope = globalThis,
} = {}) {
  const synth = scope.speechSynthesis;
  const Utterance = scope.SpeechSynthesisUtterance;
  if (!synth || !Utterance) return null;
  let pending = 0;
  let generation = 0;
  return {
    speak(text) {
      const clean = String(text || '').trim();
      if (!clean) return Promise.resolve();
      const mine = generation;
      pending += 1;
      return new Promise((resolve) => {
        const utterance = new Utterance(clean);
        utterance.rate = rate;
        if (lang) utterance.lang = lang;
        const voice = chooseVoice(synth.getVoices?.() || [], lang);
        if (voice) utterance.voice = voice;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          if (mine === generation) pending = Math.max(0, pending - 1);
          resolve();
        };
        utterance.onend = done;
        utterance.onerror = done;
        synth.speak(utterance);
      });
    },
    cancel() {
      generation += 1;
      pending = 0;
      synth.cancel();
    },
    get speaking() {
      return pending > 0;
    },
  };
}

/** Split streamed text at sentence ends so speech can start early. */
export function takeSentences(buffer, { final = false } = {}) {
  const sentences = [];
  let rest = buffer;
  const pattern = /^(.+?[.!?…:;])(\s+|$)/s;
  for (;;) {
    const match = rest.match(pattern);
    if (!match || (!match[2] && !final)) break;
    sentences.push(match[1].trim());
    rest = rest.slice(match[0].length);
  }
  if (final && rest.trim()) {
    sentences.push(rest.trim());
    rest = '';
  }
  return { sentences, rest };
}
