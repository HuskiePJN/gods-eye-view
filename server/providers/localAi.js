import { sameSiteGated } from './common/same-site.js';
import { createLocalAiHandlers } from './local-ai/chat.js';

/**
 * Vite plugin: Local AI voice through an Ollama server the operator runs.
 *
 * No key is involved, but the routes still refuse cross-site browser requests:
 * a foreign page must not be able to drive this machine's model.
 */
function localAiProxy({ annotationGuidance, realtime = {} } = {}) {
  const handlers = createLocalAiHandlers({
    annotationGuidance,
    ...(realtime.tools ? { tools: realtime.tools } : {}),
  });
  function install(middlewares) {
    middlewares.use('/api/local-ai/session', sameSiteGated(handlers.session));
    middlewares.use('/api/local-ai/chat', sameSiteGated(handlers.chat));
  }
  return {
    name: 'local-ai-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { localAiProxy };
