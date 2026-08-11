const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { readImageDimensions } = require('../lib/image-validation');
const {
  generateDraft, approveAndPublish, listPosts, getPost, updatePost,
  deletePost, schedulePost, publishDuePosts, transformDraft, LINKEDIN_MAX_CHARS
} = require('../scripts/generate-and-post');
const { store } = require('../lib/store');
const { saveCredentials, connectionStatus } = require('../lib/linkedin-auth');
const { reportError } = require('../lib/error-reporting');
const topics = require('../content/topics.json');

const DEFAULT_SETTINGS = {
  audience: 'Technology leaders in Saudi Arabia',
  tone: 'authoritative and practical',
  objective: 'Start a useful discussion',
  language: 'English'
};

async function workspaceConfig() {
  return {
    pillars: await store.getAppState('content_pillars') || topics,
    settings: { ...DEFAULT_SETTINGS, ...(await store.getAppState('workspace_settings') || {}) }
  };
}

function validatePillars(value) {
  if (!Array.isArray(value) || !value.length || value.length > 24) throw new Error('Provide between 1 and 24 content pillars.');
  return value.map((pillar, index) => {
    const title = String(pillar.title || '').trim().slice(0, 120);
    const message = String(pillar.message || '').trim().slice(0, 600);
    if (!title || !message) throw new Error(`Pillar ${index + 1} needs a title and guidance.`);
    const slug = String(pillar.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80) || `pillar-${index + 1}`;
    return { slug, title, message };
  });
}

const app = express();
const PORT = process.env.PORT || 3000;
let storeReady;
function productionConfigErrors(env = process.env) {
  if (env.NODE_ENV !== 'production') return [];
  const required = ['DATABASE_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_REDIRECT_URI', 'ALLOWED_GITHUB_USERS'];
  const missing = required.filter(name => !String(env[name] || '').trim());
  const linkedinOAuth = env.LINKEDIN_CLIENT_ID || env.LINKEDIN_CLIENT_SECRET || env.LINKEDIN_REDIRECT_URI;
  if (linkedinOAuth && !env.LINKEDIN_TOKEN_ENCRYPTION_KEY) missing.push('LINKEDIN_TOKEN_ENCRYPTION_KEY');
  return missing;
}
function ensureStoreReady() {
  if (!storeReady) {
    const missing = productionConfigErrors();
    storeReady = (missing.length
      ? Promise.reject(new Error(`Production configuration is incomplete: ${missing.join(', ')}`))
      : store.init()).catch(error => {
      storeReady = null;
      throw error;
    });
  }
  return storeReady;
}
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif']);
const imageBody = express.raw({ type: ['image/jpeg', 'image/png', 'image/gif'], limit: '20mb' });

function validateImage(data, mimeType) {
  if (!IMAGE_TYPES.has(mimeType)) throw new Error('Use a JPG, PNG, or GIF image.');
  if (!Buffer.isBuffer(data) || !data.length) throw new Error('The image is empty.');
  const dimensions = readImageDimensions(data);
  const detectedMime = dimensions.type === 'jpg' ? 'image/jpeg' : `image/${dimensions.type}`;
  if (detectedMime !== mimeType) throw new Error('The file content does not match its image type.');
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height >= 36152320) {
    throw new Error('The image has too many pixels for LinkedIn.');
  }
  return dimensions;
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => ensureStoreReady().then(() => next(), next));
app.use(express.static(path.join(__dirname, '..', 'frontend'), { extensions: ['html'] }));

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(value => {
    const index = value.indexOf('=');
    return [value.slice(0, index).trim(), decodeURIComponent(value.slice(index + 1))];
  }));
}

const DEMO_ENABLED = process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production';

if (process.env.DEMO_MODE === 'true' && process.env.NODE_ENV === 'production') {
  console.warn('[security] DEMO_MODE is ignored in production. Configure GitHub OAuth for a live deployment.');
}

function demoUser() {
  // DEMO_MODE grants an unauthenticated session, so it must never apply in production.
  return DEMO_ENABLED
    ? { login: 'demo', name: 'Demo workspace', avatar: '', demo: true }
    : null;
}

async function currentUser(req) {
  const token = cookies(req).auth_token || req.headers.authorization?.replace(/^Bearer /, '');
  return (token && await store.getSession(token)) || demoUser();
}

// Machine callers (n8n, cron, CI) authenticate with a shared key instead of a
// browser session. Compared in constant time so the key cannot be probed.
function apiKeyMatches(candidate) {
  const expected = process.env.AUTOMATION_API_KEY;
  if (!expected || !candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireApiKey(req, res, next) {
  const key = req.get('x-api-key');
  if (!process.env.AUTOMATION_API_KEY) {
    return res.status(503).json({ ok: false, error: 'Automation is disabled. Set AUTOMATION_API_KEY to enable it.' });
  }
  if (!apiKeyMatches(key)) return res.status(401).json({ ok: false, error: 'Invalid automation key.' });
  req.user = { login: 'automation', name: 'Automation', automation: true };
  next();
}

const rateBuckets = new Map();
function rateLimit(windowMs, maximum) {
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    else if (++bucket.count > maximum) return res.status(429).json({ ok: false, error: 'Too many requests. Try again shortly.' });
    next();
  };
}

const authRateLimit = rateLimit(15 * 60 * 1000, 40);
const generationRateLimit = rateLimit(60 * 1000, 10);
const publishingRateLimit = rateLimit(60 * 1000, 8);

function allowedGitHubUser(login) {
  const allowed = String(process.env.ALLOWED_GITHUB_USERS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return process.env.NODE_ENV !== 'production' && !allowed.length
    ? true
    : allowed.includes(String(login || '').toLowerCase());
}

async function requireAuth(req, res, next) {
  try {
    if (apiKeyMatches(req.get('x-api-key'))) {
      req.user = { login: 'automation', name: 'Automation', automation: true };
      return next();
    }
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'Sign in is required.' });
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

app.get('/api/health', async (req, res, next) => {
  try {
  const linkedin = await connectionStatus();
  res.json({
    ok: true,
    production: process.env.NODE_ENV === 'production',
    mode: process.env.OPENAI_API_KEY ? 'ai' : (DEMO_ENABLED ? 'demo' : 'unconfigured'),
    authenticationConfigured: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && process.env.ALLOWED_GITHUB_USERS),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    databaseReachable: true,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    linkedinConfigured: linkedin.connected,
    linkedin,
    persistence: store.kind,
    durable: store.kind === 'postgres',
    automationEnabled: Boolean(process.env.AUTOMATION_API_KEY),
    schedulerConfigured: Boolean(process.env.SIGNALPOST_URL && process.env.AUTOMATION_API_KEY),
    errorMonitoring: process.env.SENTRY_DSN ? 'sentry' : 'vercel-logs',
    demoEnabled: DEMO_ENABLED,
    maxChars: LINKEDIN_MAX_CHARS,
    version: require('../package.json').version
  });
  } catch (error) { next(error); }
});

app.get('/auth/github', authRateLimit, async (req, res) => {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    return res.status(503).json({ ok: false, error: 'GitHub OAuth is not configured. Use DEMO_MODE=true for preview.' });
  }
  const state = crypto.randomBytes(24).toString('hex');
  await store.putOAuthState(state);
  const redirectUri = process.env.GITHUB_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/github/callback`;
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  res.json({ ok: true, url: url.toString() });
});

app.get('/auth/github/callback', authRateLimit, async (req, res) => {
  const valid = await store.consumeOAuthState(req.query.state);
  if (!valid || !req.query.code) return res.status(400).send('Invalid or expired OAuth request.');
  try {
    const redirectUri = process.env.GITHUB_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/github/callback`;
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code: req.query.code,
        redirect_uri: redirectUri
      })
    });
    const token = await tokenResponse.json();
    if (!token.access_token) throw new Error(token.error_description || 'GitHub sign-in failed.');
    const userResponse = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'linkedin-ai-autoposter' }
    });
    if (!userResponse.ok) throw new Error('Could not read the GitHub profile.');
    const profile = await userResponse.json();
    if (!allowedGitHubUser(profile.login)) return res.status(403).send('This GitHub account is not allowed to use SignalPost.');
    const sessionId = crypto.randomBytes(32).toString('hex');
    await store.putSession(sessionId, { login: profile.login, name: profile.name, avatar: profile.avatar_url });
    res.setHeader('Set-Cookie', `auth_token=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.redirect('/');
  } catch (error) {
    res.status(400).send(error.message);
  }
});

app.get('/auth/linkedin', requireAuth, authRateLimit, async (req, res) => {
  if (!process.env.LINKEDIN_CLIENT_ID || !process.env.LINKEDIN_CLIENT_SECRET || !process.env.LINKEDIN_REDIRECT_URI) {
    return res.status(503).json({ ok: false, error: 'LinkedIn OAuth is not configured.' });
  }
  if (!process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY) {
    return res.status(503).json({ ok: false, error: 'LinkedIn token encryption is not configured.' });
  }
  const state = crypto.randomBytes(24).toString('hex');
  await store.putOAuthState(state);
  const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.LINKEDIN_CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.LINKEDIN_REDIRECT_URI);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', 'openid profile w_member_social');
  res.json({ ok: true, url: url.toString() });
});

app.get('/auth/linkedin/callback', authRateLimit, async (req, res) => {
  const valid = await store.consumeOAuthState(req.query.state);
  if (!valid || !req.query.code) return res.status(400).send('Invalid or expired LinkedIn OAuth request.');
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code: String(req.query.code),
      client_id: process.env.LINKEDIN_CLIENT_ID || '', client_secret: process.env.LINKEDIN_CLIENT_SECRET || '',
      redirect_uri: process.env.LINKEDIN_REDIRECT_URI || ''
    });
    const tokenResponse = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_description || 'LinkedIn authorization failed.');
    const profileResponse = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.sub) throw new Error('LinkedIn did not return the member identity.');
    await saveCredentials({
      accessToken: token.access_token, refreshToken: token.refresh_token || null,
      expiresAt: Date.now() + Number(token.expires_in || 0) * 1000,
      refreshExpiresAt: token.refresh_token_expires_in ? Date.now() + Number(token.refresh_token_expires_in) * 1000 : null,
      personUrn: `urn:li:person:${profile.sub}`, profile: { name: profile.name || null, picture: profile.picture || null }
    });
    res.redirect('/?linkedin=connected');
  } catch (error) {
    res.status(400).send(error.message);
  }
});

app.get('/auth/me', async (req, res) => {
  const user = await currentUser(req);
  res.json({ ok: Boolean(user), user });
});
app.post('/auth/logout', async (req, res) => {
  const token = cookies(req).auth_token;
  if (token) await store.deleteSession(token);
  res.setHeader('Set-Cookie', 'auth_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/posts', requireAuth, async (req, res) => res.json({ ok: true, posts: await listPosts() }));
app.get('/api/topics', requireAuth, async (req, res) => res.json({ ok: true, topics: (await workspaceConfig()).pillars }));
app.get('/api/workspace', requireAuth, async (req, res) => res.json({ ok: true, ...(await workspaceConfig()) }));
app.put('/api/workspace/pillars', requireAuth, async (req, res) => {
  try {
    const pillars = validatePillars(req.body?.pillars);
    await store.setAppState('content_pillars', pillars);
    res.json({ ok: true, pillars });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});
app.put('/api/workspace/settings', requireAuth, async (req, res) => {
  const settings = {
    audience: String(req.body?.audience || DEFAULT_SETTINGS.audience).trim().slice(0, 300),
    tone: String(req.body?.tone || DEFAULT_SETTINGS.tone).trim().slice(0, 100),
    objective: String(req.body?.objective || DEFAULT_SETTINGS.objective).trim().slice(0, 300),
    language: req.body?.language === 'Arabic' ? 'Arabic' : 'English'
  };
  await store.setAppState('workspace_settings', settings);
  res.json({ ok: true, settings });
});

app.post('/api/posts/generate', requireAuth, generationRateLimit, async (req, res) => {
  try {
    const config = await workspaceConfig();
    const sourceUrl = String(req.body.sourceUrl || '').trim();
    if (sourceUrl) {
      const parsed = new URL(sourceUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Source URL must use http or https.');
    }
    const result = await generateDraft({
      topicIndex: Number.isInteger(req.body.topicIndex) ? req.body.topicIndex : undefined,
      idea: String(req.body.idea || '').trim().slice(0, 300),
      language: req.body.language,
      tone: String(req.body.tone || '').slice(0, 100),
      objective: String(req.body.objective || '').slice(0, 300),
      audience: String(req.body.audience || '').slice(0, 300),
      sourceUrl,
      notes: String(req.body.notes || '').slice(0, 4000),
      cta: String(req.body.cta || '').slice(0, 300)
      , topics: config.pillars
    });
    res.status(201).json({ ok: true, post: result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.patch('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const current = await getPost(req.params.id);
    const nextAltText = req.body.imageAltText === undefined ? undefined : String(req.body.imageAltText).trim().slice(0, 4086);
    const contentChanged = (req.body.text !== undefined && String(req.body.text).trim() !== current.text)
      || (nextAltText !== undefined && nextAltText !== (current.imageAltText || ''));
    const post = await updatePost(req.params.id, {
      text: req.body.text === undefined ? undefined : String(req.body.text).trim(), title: req.body.title,
      imageAltText: nextAltText,
      status: contentChanged && current.status !== 'draft' ? 'draft' : undefined,
      approvedAt: contentChanged ? null : undefined,
      scheduledFor: contentChanged ? null : undefined,
      revisions: contentChanged ? [...(current.revisions || []), {
        text: current.text, createdAt: new Date().toISOString(), action: 'manual-edit'
      }].slice(-25) : undefined
    });
    res.json({ ok: true, post });
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message });
  }
});

app.post('/api/posts/:id/transform', requireAuth, generationRateLimit, async (req, res) => {
  try {
    const action = String(req.body?.action || '');
    const post = await transformDraft(req.params.id, action, {
      tone: String(req.body?.tone || '').slice(0, 100),
      language: req.body?.language === 'Arabic' ? 'Arabic' : 'English'
    });
    res.json({ ok: true, post });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/posts/:id/approve', requireAuth, async (req, res) => {
  try {
    const post = await approveAndPublish(req.params.id, req.body?.text, false);
    res.json({ ok: true, post });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.post('/api/posts/:id/publish', requireAuth, publishingRateLimit, async (req, res) => {
  try {
    if (req.user.demo) return res.status(403).json({ ok: false, error: 'Publishing is disabled in demo mode.' });
    if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'Explicit publishing confirmation is required.' });
    const post = await approveAndPublish(req.params.id, undefined, true);
    res.json({ ok: true, post });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.get('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, post: await getPost(req.params.id) });
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message });
  }
});

app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    await deletePost(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message });
  }
});

app.post('/api/posts/:id/schedule', requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, post: await schedulePost(req.params.id, req.body.scheduledFor) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.put('/api/posts/:id/image', requireAuth, imageBody, async (req, res) => {
  try {
    const mimeType = String(req.get('content-type') || '').split(';')[0].toLowerCase();
    validateImage(req.body, mimeType);
    const altText = decodeURIComponent(String(req.get('x-image-alt') || '')).trim().slice(0, 4086);
    const name = decodeURIComponent(String(req.get('x-image-name') || 'image')).slice(0, 200);
    let post = await store.savePostImage(req.params.id, { data: req.body, mimeType, altText, name });
    if (post.status !== 'draft') post = await updatePost(req.params.id, { status: 'draft', approvedAt: null, scheduledFor: null });
    res.json({ ok: true, post });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get('/api/posts/:id/image', requireAuth, async (req, res) => {
  try {
    const image = await store.getPostImage(req.params.id);
    if (!image) return res.status(404).json({ ok: false, error: 'Image not found.' });
    res.setHeader('Content-Type', image.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(image.data);
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message });
  }
});

app.delete('/api/posts/:id/image', requireAuth, async (req, res) => {
  try {
    let post = await store.deletePostImage(req.params.id);
    if (post.status !== 'draft') post = await updatePost(req.params.id, { status: 'draft', approvedAt: null, scheduledFor: null });
    res.json({ ok: true, post });
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message });
  }
});

// --- Automation surface (n8n, cron). Key auth only; never a browser session. ---

app.post('/api/automation/generate', requireApiKey, async (req, res) => {
  try {
    const post = await generateDraft({
      topicIndex: Number.isInteger(req.body.topicIndex) ? req.body.topicIndex : undefined,
      idea: req.body.idea,
      language: req.body.language,
      tone: req.body.tone,
      objective: req.body.objective,
      audience: req.body.audience,
      sourceUrl: req.body.sourceUrl,
      notes: req.body.notes,
      cta: req.body.cta,
      scheduledFor: req.body.scheduledFor
    });
    res.status(201).json({ ok: true, post });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/automation/publish-due', requireApiKey, async (req, res) => {
  try {
    res.json({ ok: true, ...await publishDuePosts({ limit: Number(req.body.limit) || 10 }) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/automation/pending', requireApiKey, async (req, res) => {
  const posts = await listPosts();
  res.json({
    ok: true,
    drafts: posts.filter(p => p.status === 'draft').length,
    approved: posts.filter(p => p.status === 'approved').length,
    scheduled: posts.filter(p => p.status === 'scheduled').length,
    failed: posts.filter(p => p.status === 'failed').map(p => ({ id: p.id, error: p.error })),
    posts: posts.filter(p => ['draft', 'scheduled', 'failed'].includes(p.status)).slice(0, 20)
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')));

app.use((error, req, res, next) => {
  reportError(error, { route: req.path, method: req.method, requestId: req.get('x-vercel-id') || null });
  if (res.headersSent) return next(error);
  res.status(500).json({ ok: false, error: 'An unexpected server error occurred.' });
});

app.locals.security = { apiKeyMatches, allowedGitHubUser, validateImage, productionConfigErrors };

if (require.main === module) ensureStoreReady().then(() => app.listen(PORT, () => console.log(`LinkedIn Studio running at http://localhost:${PORT} (persistence: ${store.kind})`)))
  .catch(error => { console.error('Storage init failed:', error.message); process.exit(1); });
module.exports = app;
