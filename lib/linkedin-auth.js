'use strict';

const crypto = require('crypto');
const fetch = require('node-fetch');
const { store } = require('./store');

const STATE_KEY = 'linkedin_credentials';

function encryptionKey() {
  const configured = process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY;
  if (!configured) return null;
  return crypto.createHash('sha256').update(configured).digest();
}

function encrypt(value) {
  const key = encryptionKey();
  if (!key) throw new Error('LINKEDIN_TOKEN_ENCRYPTION_KEY is required to connect LinkedIn.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') };
}

function decrypt(payload) {
  const key = encryptionKey();
  if (!key || !payload?.iv || !payload?.tag || !payload?.data) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8'));
}

async function saveCredentials(credentials) {
  await store.setAppState(STATE_KEY, encrypt(credentials));
}

async function storedCredentials() {
  const payload = await store.getAppState(STATE_KEY);
  return payload ? decrypt(payload) : null;
}

async function refresh(credentials) {
  if (!credentials.refreshToken) return credentials;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: process.env.LINKEDIN_CLIENT_ID || '',
    client_secret: process.env.LINKEDIN_CLIENT_SECRET || ''
  });
  const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  if (!response.ok) throw new Error(`LinkedIn token refresh failed (${response.status}). Reconnect LinkedIn.`);
  const token = await response.json();
  const updated = {
    ...credentials,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || credentials.refreshToken,
    expiresAt: Date.now() + Number(token.expires_in || 0) * 1000,
    refreshExpiresAt: token.refresh_token_expires_in
      ? Date.now() + Number(token.refresh_token_expires_in) * 1000
      : credentials.refreshExpiresAt
  };
  await saveCredentials(updated);
  return updated;
}

async function getPublishingCredentials() {
  if (process.env.LINKEDIN_ACCESS_TOKEN && process.env.LINKEDIN_PERSON_URN) {
    return { accessToken: process.env.LINKEDIN_ACCESS_TOKEN, personUrn: process.env.LINKEDIN_PERSON_URN, source: 'environment' };
  }
  let credentials = await storedCredentials();
  if (!credentials) throw new Error('LinkedIn is not connected.');
  if (credentials.expiresAt && credentials.expiresAt <= Date.now() + 5 * 60 * 1000) {
    if (!credentials.refreshToken) throw new Error('LinkedIn access expired. Reconnect LinkedIn.');
    credentials = await refresh(credentials);
  }
  return { ...credentials, source: 'oauth' };
}

async function connectionStatus() {
  if (process.env.LINKEDIN_ACCESS_TOKEN && process.env.LINKEDIN_PERSON_URN) {
    return { connected: true, source: 'environment', expiresAt: null };
  }
  try {
    const credentials = await storedCredentials();
    return credentials
      ? { connected: true, source: 'oauth', expiresAt: credentials.expiresAt || null }
      : { connected: false };
  } catch {
    return { connected: false, error: 'Stored LinkedIn credentials cannot be decrypted.' };
  }
}

module.exports = { getPublishingCredentials, saveCredentials, connectionStatus };
