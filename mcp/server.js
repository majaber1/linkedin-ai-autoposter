#!/usr/bin/env node
'use strict';

/**
 * SignalPost MCP server.
 *
 * Exposes the content studio to any MCP client (Claude Desktop, Claude Code)
 * over stdio. Two transport modes:
 *
 *   local  — talks straight to the storage layer in this repo. Requires the
 *            same env as the app (DATABASE_URL, OPENAI_API_KEY, LINKEDIN_*).
 *   remote — calls a deployed instance over HTTP using AUTOMATION_API_KEY.
 *            Set SIGNALPOST_URL to enable.
 *
 * Publishing is deliberately a separate tool from approving, and it refuses to
 * run unless `confirm: true` is passed, so a model cannot post to LinkedIn as a
 * side effect of a vaguer instruction.
 */

const REMOTE = process.env.SIGNALPOST_URL;
const API_KEY = process.env.AUTOMATION_API_KEY;

let local = null;
if (!REMOTE) local = require('../scripts/generate-and-post');

const topics = require('../content/topics.json');

async function remote(method, path, body) {
  const fetch = require('node-fetch');
  const response = await fetch(`${REMOTE.replace(/\/$/, '')}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY || '' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${REMOTE} returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

/* ----------------------------- tool catalogue ----------------------------- */

const TOOLS = [
  {
    name: 'list_topics',
    description: 'List the configured content topics with their index and slug. Use the index when generating a draft on a specific topic.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_posts',
    description: 'List posts in the content queue, newest first, with their lifecycle status (draft, approved, publishing, published, failed).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'approved', 'publishing', 'published', 'failed'], description: 'Optional status filter.' }
      }
    }
  },
  {
    name: 'get_post',
    description: 'Read one post in full, including its body text and any publishing error.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The post id.' } },
      required: ['id']
    }
  },
  {
    name: 'generate_draft',
    description: 'Generate a new LinkedIn draft. Saves it as a draft for review; it is never published by this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        topicIndex: { type: 'integer', description: 'Topic index from list_topics. Omit to use the rotating cursor.' },
        language: { type: 'string', enum: ['English', 'Arabic'], description: 'Output language. Defaults to English.' },
        tone: { type: 'string', description: 'For example: executive, practical, reflective.' },
        objective: { type: 'string', description: 'What the post should achieve.' }
      }
    }
  },
  {
    name: 'edit_post',
    description: 'Replace the body text of a draft. Use this to apply revisions before approving.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string', description: 'The full replacement body, max 3000 characters.' }
      },
      required: ['id', 'text']
    }
  },
  {
    name: 'approve_post',
    description: 'Mark a post approved so it is queued. Does NOT publish it. Optionally set scheduledFor to have the automation runner publish it later.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        scheduledFor: { type: 'string', description: 'Optional ISO 8601 time to publish at, for example 2026-08-02T05:00:00Z.' }
      },
      required: ['id']
    }
  },
  {
    name: 'publish_post',
    description: 'Publish a post to LinkedIn immediately. This is irreversible and visible to the public. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true. Guards against publishing without explicit intent.' }
      },
      required: ['id', 'confirm']
    }
  },
  {
    name: 'delete_post',
    description: 'Delete a post from the queue permanently.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'studio_status',
    description: 'Report which AI provider is active, whether LinkedIn publishing is configured, which storage driver is in use, and how many posts sit in each state.',
    inputSchema: { type: 'object', properties: {} }
  }
];

/* ------------------------------ tool handlers ----------------------------- */

const handlers = {
  async list_topics() {
    return topics.map((topic, index) => ({ index, slug: topic.slug, title: topic.title }));
  },

  async list_posts({ status }) {
    const posts = REMOTE ? (await remote('GET', '/api/posts')).posts : await local.listPosts();
    const filtered = status ? posts.filter(post => post.status === status) : posts;
    return filtered.map(post => ({
      id: post.id, title: post.title, status: post.status, language: post.language,
      provider: post.provider, chars: (post.text || '').length,
      createdAt: post.createdAt, scheduledFor: post.scheduledFor, error: post.error || null
    }));
  },

  async get_post({ id }) {
    return REMOTE ? (await remote('GET', `/api/posts/${encodeURIComponent(id)}`)).post : local.getPost(id);
  },

  async generate_draft(args) {
    if (REMOTE) return (await remote('POST', '/api/automation/generate', args)).post;
    return local.generateDraft(args);
  },

  async edit_post({ id, text }) {
    if (text.length > 3000) throw new Error(`The text is ${text.length} characters. LinkedIn allows 3000.`);
    if (REMOTE) return (await remote('PATCH', `/api/posts/${encodeURIComponent(id)}`, { text })).post;
    return local.updatePost(id, { text });
  },

  async approve_post({ id, scheduledFor }) {
    if (REMOTE) {
      return scheduledFor
        ? (await remote('POST', `/api/posts/${encodeURIComponent(id)}/schedule`, { scheduledFor })).post
        : (await remote('POST', `/api/posts/${encodeURIComponent(id)}/approve`, { publish: false })).post;
    }
    return scheduledFor ? local.schedulePost(id, scheduledFor) : local.approveAndPublish(id, undefined, false);
  },

  async publish_post({ id, confirm }) {
    if (confirm !== true) throw new Error('Publishing was not confirmed. Pass confirm: true to publish to LinkedIn.');
    if (REMOTE) return (await remote('POST', `/api/posts/${encodeURIComponent(id)}/approve`, { publish: true })).post;
    return local.approveAndPublish(id, undefined, true);
  },

  async delete_post({ id }) {
    if (REMOTE) {
      await remote('DELETE', `/api/posts/${encodeURIComponent(id)}`);
      return { deleted: id };
    }
    await local.deletePost(id);
    return { deleted: id };
  },

  async studio_status() {
    const health = REMOTE
      ? await remote('GET', '/api/health')
      : {
        mode: process.env.OPENAI_API_KEY ? 'ai' : 'demo',
        linkedinConfigured: Boolean(process.env.LINKEDIN_ACCESS_TOKEN && process.env.LINKEDIN_PERSON_URN),
        persistence: local.store.kind
      };
    const posts = REMOTE ? (await remote('GET', '/api/posts')).posts : await local.listPosts();
    const counts = posts.reduce((acc, post) => ({ ...acc, [post.status]: (acc[post.status] || 0) + 1 }), {});
    return { transport: REMOTE ? 'remote' : 'local', ...health, topics: topics.length, counts, total: posts.length };
  }
};

/* --------------------------- JSON-RPC over stdio -------------------------- */

const PROTOCOL_VERSION = '2024-11-05';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function dispatch(request) {
  const { id, method, params } = request;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'signalpost', version: require('../package.json').version }
    });
  }

  if (method === 'notifications/initialized' || method === 'initialized') return;

  if (method === 'tools/list') return reply(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const handler = handlers[params?.name];
    if (!handler) return replyError(id, -32601, `Unknown tool: ${params?.name}`);
    try {
      const result = await handler(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (error) {
      // Reported as tool-level failure so the model can read and react to it.
      return reply(id, { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true });
    }
  }

  if (method === 'ping') return reply(id, {});
  if (id !== undefined) replyError(id, -32601, `Unsupported method: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    dispatch(request).catch(error => {
      if (request.id !== undefined) replyError(request.id, -32603, error.message);
    });
  }
});

process.stdin.on('end', () => process.exit(0));

if (REMOTE && !API_KEY) {
  process.stderr.write('SIGNALPOST_URL is set but AUTOMATION_API_KEY is missing; remote calls will be rejected.\n');
}
