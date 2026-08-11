'use strict';

const fetch = require('node-fetch');

function sentryEnvelope(error, context = {}) {
  const dsn = new URL(process.env.SENTRY_DSN);
  const projectId = dsn.pathname.replace(/^\//, '');
  const eventId = require('crypto').randomBytes(16).toString('hex');
  const event = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
    server_name: process.env.VERCEL_URL || undefined,
    exception: { values: [{ type: error.name || 'Error', value: error.message || String(error), stacktrace: error.stack ? { frames: [] } : undefined }] },
    extra: { ...context, stack: error.stack }
  };
  const header = { event_id: eventId, dsn: process.env.SENTRY_DSN };
  const itemHeader = { type: 'event', content_type: 'application/json' };
  return {
    url: `${dsn.protocol}//${dsn.host}/api/${projectId}/envelope/?sentry_key=${dsn.username}&sentry_version=7`,
    body: `${JSON.stringify(header)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(event)}`
  };
}

async function reportError(error, context = {}) {
  const payload = {
    level: 'error', message: error.message || String(error), stack: error.stack,
    timestamp: new Date().toISOString(), ...context
  };
  console.error(JSON.stringify(payload));
  if (!process.env.SENTRY_DSN) return;
  try {
    const envelope = sentryEnvelope(error, context);
    await fetch(envelope.url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: envelope.body, timeout: 2500
    });
  } catch (reportingError) {
    console.error(JSON.stringify({ level: 'warn', message: 'Sentry delivery failed', error: reportingError.message }));
  }
}

module.exports = { reportError };
