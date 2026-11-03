import { readRequestBodyCapped } from '../common/request.js';
import { readResponseJsonCapped } from '../../../src/sources/httpBody.js';
import { realtimeInstructions } from '../openai/instructions.js';
import { GEV_REALTIME_TOOLS } from '../openai/tools.js';
import { toChatTools } from './tools.js';
import {
  LOCAL_AI_INSTRUCTIONS_SUFFIX,
  isModelName,
  localAiConfig,
} from './config.js';

const REQUEST_BODY_BYTES = 512 * 1024;
const TAGS_BODY_BYTES = 1024 * 1024;
const STREAM_LINE_BYTES = 1024 * 1024;
const STREAM_TOTAL_BYTES = 8 * 1024 * 1024;
const TAGS_TTL_MS = 15_000;
const TAGS_TIMEOUT_MS = 5_000;
const MAX_MESSAGES = 80;
const MAX_CONTENT_CHARS = 24_000;
const MAX_NOTE_CHARS = 2_000;
const MAX_TOOL_CALLS = 8;
const MAX_CONCURRENT_CHATS = 2;

const UNREACHABLE =
  'Ollama is not reachable. Start Ollama on this computer and try again.';
const NO_MODELS =
  'Ollama has no chat models installed. Install one with `ollama pull <model>`.';
const CHAT_FAILURE = 'The local model could not answer. Try again.';

function reply(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

/** Embedding-only models cannot hold a conversation; keep them off the list. */
function isChatModel(entry) {
  const name = String(entry?.name || entry?.model || '');
  if (!isModelName(name)) return false;
  const families = [entry?.details?.family, ...(entry?.details?.families || [])]
    .filter(Boolean)
    .map((family) => String(family).toLowerCase());
  return (
    !/embed/i.test(name) && !families.some((family) => family.includes('bert'))
  );
}

/** Message history from the browser, reduced to the fields Ollama reads. */
export function readChatMessages(raw, toolNames) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES)
    return null;
  const messages = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (content.length > MAX_CONTENT_CHARS) return null;
    if (entry.role === 'user') {
      messages.push({ role: 'user', content });
    } else if (entry.role === 'assistant') {
      const calls = entry.tool_calls ?? [];
      if (!Array.isArray(calls) || calls.length > MAX_TOOL_CALLS) return null;
      const toolCalls = [];
      for (const call of calls) {
        const name = call?.name;
        const args = call?.arguments ?? {};
        if (!args || typeof args !== 'object' || Array.isArray(args))
          return null;
        // A call the model invented is dropped, not fatal to the turn.
        if (toolNames.has(name))
          toolCalls.push({ function: { name, arguments: args } });
      }
      messages.push({
        role: 'assistant',
        content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (entry.role === 'tool') {
      if (typeof entry.tool_name !== 'string') return null;
      if (toolNames.has(entry.tool_name))
        messages.push({ role: 'tool', tool_name: entry.tool_name, content });
    } else {
      // System text is the server's alone; the app sends notes as user data.
      return null;
    }
  }
  return messages;
}

/** Split an NDJSON byte stream into parsed objects, bounding every line. */
async function* readNdjson(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > STREAM_TOTAL_BYTES) throw new Error('stream too large');
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > STREAM_LINE_BYTES && !buffer.includes('\n'))
      throw new Error('stream line too large');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* Skip a malformed line rather than end the turn. */
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
}

/**
 * Local AI voice endpoints.
 *
 *   POST /api/local-ai/session  { model? } → { model, models, numCtx }
 *   POST /api/local-ai/chat     { model, messages, note?, tools? } → NDJSON
 *     {type:'delta',text} | {type:'tool_call',name,arguments} |
 *     {type:'done',stats} | {type:'error',error}
 *
 * The system prompt and tools are the cloud voice session's own (plus a short
 * note that replies are spoken by a synthesizer), held here so the browser
 * never supplies them.
 */
export function createLocalAiHandlers({
  annotationGuidance,
  tools = GEV_REALTIME_TOOLS,
  environment = process.env,
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
} = {}) {
  const chatTools = toChatTools(tools);
  const toolNames = new Set(chatTools.map((tool) => tool.function.name));
  const system = `${realtimeInstructions(annotationGuidance)}\n\n${LOCAL_AI_INSTRUCTIONS_SUFFIX}`;
  // Models that refused `think`; the parameter is omitted for them after.
  const noThinkModels = new Set();
  let tagsCache = null;
  let activeChats = 0;

  const config = () => localAiConfig(environment);

  async function listModels(baseUrl) {
    if (tagsCache && tagsCache.baseUrl === baseUrl && tagsCache.expires > now())
      return tagsCache.models;
    const response = await fetchImpl(`${baseUrl}/api/tags`, {
      redirect: 'error',
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`tags HTTP ${response.status}`);
    }
    const data = await readResponseJsonCapped(response, TAGS_BODY_BYTES);
    const models = (Array.isArray(data?.models) ? data.models : [])
      .filter(isChatModel)
      .map((entry) => String(entry.name || entry.model))
      .sort((a, b) => a.localeCompare(b));
    tagsCache = { baseUrl, models, expires: now() + TAGS_TTL_MS };
    return models;
  }

  /** The requested model when installed, else the configured one, else the first. */
  function chooseModel(models, requested, configured) {
    if (isModelName(requested) && models.includes(requested)) return requested;
    if (configured && models.includes(configured)) return configured;
    return models[0] ?? null;
  }

  async function readJsonBody(req) {
    const raw = await readRequestBodyCapped(req, REQUEST_BODY_BYTES);
    if (!raw.length) return {};
    return JSON.parse(raw.toString('utf8'));
  }

  async function session(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(res, 405, { error: 'Method not allowed' });
    }
    const settings = config();
    if (!settings.baseUrl)
      return reply(res, 500, {
        error: 'LOCAL_AI_URL is not a valid http(s) URL',
      });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return reply(res, 400, { error: 'Invalid request' });
    }
    let models;
    try {
      models = await listModels(settings.baseUrl);
    } catch {
      console.warn('[local-ai] Ollama model list failed');
      return reply(res, 503, { error: UNREACHABLE });
    }
    if (!models.length) return reply(res, 503, { error: NO_MODELS });
    const model = chooseModel(models, body?.model, settings.model);
    return reply(res, 200, {
      ok: true,
      model,
      models,
      configuredModel: settings.model || null,
      numCtx: settings.numCtx,
    });
  }

  async function chat(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(res, 405, { error: 'Method not allowed' });
    }
    if (
      !/^application\/json\b/i.test(String(req.headers?.['content-type'] || ''))
    )
      return reply(res, 415, {
        error: 'Content-Type must be application/json',
      });
    const settings = config();
    if (!settings.baseUrl)
      return reply(res, 500, {
        error: 'LOCAL_AI_URL is not a valid http(s) URL',
      });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return reply(res, 400, { error: 'Invalid request' });
    }
    const messages = readChatMessages(body?.messages, toolNames);
    if (!messages) return reply(res, 400, { error: 'Invalid messages' });
    const note =
      typeof body?.note === 'string' ? body.note.slice(0, MAX_NOTE_CHARS) : '';
    let models;
    try {
      models = await listModels(settings.baseUrl);
    } catch {
      return reply(res, 503, { error: UNREACHABLE });
    }
    if (!isModelName(body?.model) || !models.includes(body.model))
      return reply(res, 400, {
        error: 'That model is not installed in Ollama',
      });
    if (activeChats >= MAX_CONCURRENT_CHATS)
      return reply(res, 429, { error: 'The local model is busy. Try again.' });

    activeChats += 1;
    const upstreamAbort = new AbortController();
    const onClose = () => upstreamAbort.abort();
    res.on('close', onClose);
    const signal = AbortSignal.any([
      upstreamAbort.signal,
      AbortSignal.timeout(settings.timeoutMs),
    ]);
    const wire = [
      { role: 'system', content: system },
      ...messages,
      ...(note
        ? [
            {
              role: 'user',
              content: `[App note for this reply — not the user speaking] ${note}`,
            },
          ]
        : []),
    ];
    const request = (withThink) =>
      fetchImpl(`${settings.baseUrl}/api/chat`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: body.model,
          messages: wire,
          ...(body.tools === false ? {} : { tools: chatTools }),
          stream: true,
          keep_alive: settings.keepAlive,
          options: { num_ctx: settings.numCtx },
          ...(withThink ? { think: settings.think } : {}),
        }),
      });
    let headersSent = false;
    const write = (event) => {
      if (res.destroyed || res.writableEnded) return;
      if (!headersSent) {
        headersSent = true;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      }
      res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      let upstream = await request(!noThinkModels.has(body.model));
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        if (/does not support thinking/i.test(text)) {
          noThinkModels.add(body.model);
          upstream = await request(false);
        } else {
          console.warn(`[local-ai] Ollama chat HTTP ${upstream.status}`);
          return reply(res, 502, { error: CHAT_FAILURE });
        }
      }
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel?.().catch(() => {});
        console.warn(`[local-ai] Ollama chat HTTP ${upstream.status}`);
        return reply(res, 502, { error: CHAT_FAILURE });
      }
      for await (const event of readNdjson(upstream.body)) {
        if (event?.error) {
          console.warn('[local-ai] Ollama stream error');
          write({ type: 'error', error: CHAT_FAILURE });
          break;
        }
        const message = event?.message || {};
        if (typeof message.content === 'string' && message.content)
          write({ type: 'delta', text: message.content });
        for (const call of message.tool_calls || []) {
          const name = call?.function?.name;
          let args = call?.function?.arguments ?? {};
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              args = {};
            }
          }
          if (typeof name !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(name))
            continue;
          write({
            type: 'tool_call',
            name,
            arguments: args && typeof args === 'object' ? args : {},
          });
        }
        if (event?.done) {
          const ms = (ns) =>
            Number.isFinite(ns) ? Math.round(ns / 1e6) : null;
          write({
            type: 'done',
            stats: {
              promptTokens: event.prompt_eval_count ?? null,
              outputTokens: event.eval_count ?? null,
              promptMs: ms(event.prompt_eval_duration),
              outputMs: ms(event.eval_duration),
              loadMs: ms(event.load_duration),
            },
          });
        }
      }
      if (!headersSent) return reply(res, 502, { error: CHAT_FAILURE });
      res.end();
    } catch (error) {
      if (upstreamAbort.signal.aborted) return; // The browser left.
      const timedOut = error?.name === 'TimeoutError';
      console.warn(`[local-ai] chat ${timedOut ? 'timed out' : 'failed'}`);
      const message = timedOut
        ? 'The local model took too long to answer.'
        : error?.cause?.code === 'ECONNREFUSED'
          ? UNREACHABLE
          : CHAT_FAILURE;
      if (headersSent) {
        write({ type: 'error', error: message });
        res.end();
      } else reply(res, timedOut ? 504 : 502, { error: message });
    } finally {
      activeChats -= 1;
      res.off('close', onClose);
    }
  }

  return { session, chat };
}
