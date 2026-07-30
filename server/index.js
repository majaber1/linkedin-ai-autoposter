const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const {
  generateDraft, approveAndPublish, listPosts, getPost, updatePost,
  deletePost, schedulePost, publishDuePosts, LINKEDIN_MAX_CHARS
} = require('../scripts/generate-and-post');
const { store } = require('../lib/store');
const topics = require('../content/topics.json');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
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
  const key = req.get('x-api-key') || req.query.key;
  if (!process.env.AUTOMATION_API_KEY) {
    return res.status(503).json({ ok: false, error: 'Automation is disabled. Set AUTOMATION_API_KEY to enable it.' });
  }
  if (!apiKeyMatches(key)) return res.status(401).json({ ok: false, error: 'Invalid automation key.' });
  req.user = { login: 'automation', name: 'Automation', automation: true };
  next();
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

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mode: process.env.OPENAI_API_KEY ? 'ai' : 'demo',
    linkedinConfigured: Boolean(process.env.LINKEDIN_ACCESS_TOKEN && process.env.LINKEDIN_PERSON_URN),
    persistence: store.kind,
    durable: store.kind === 'postgres',
    automationEnabled: Boolean(process.env.AUTOMATION_API_KEY),
    maxChars: LINKEDIN_MAX_CHARS,
    version: require('../package.json').version
  });
});

app.get('/auth/github', async (req, res) => {
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

app.get('/auth/github/callback', async (req, res) => {
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
    const sessionId = crypto.randomBytes(32).toString('hex');
    await store.putSession(sessionId, { login: profile.login, name: profile.name, avatar: profile.avatar_url });
    res.setHeader('Set-Cookie', `auth_token=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.redirect('/');
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
app.get('/api/topics', requireAuth, (req, res) => res.json({ ok: true, topics }));

app.post('/api/posts/generate', requireAuth, async (req, res) => {
  try {
    const result = await generateDraft({
      topicIndex: Number.isInteger(req.body.topicIndex) ? req.body.topicIndex : undefined,
      language: req.body.language,
      tone: req.body.tone,
      objective: req.body.objective
    });
    res.status(201).json({ ok: true, post: result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.patch('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const post = await updatePost(req.params.id, { text: String(req.body.text || '').trim(), title: req.body.title });
    res.json({ ok: true, post });
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message });
  }
});

app.post('/api/posts/:id/approve', requireAuth, async (req, res) => {
  try {
    if (req.user.demo && req.body.publish) {
      return res.status(403).json({ ok: false, error: 'Publishing is disabled for the demo session.' });
    }
    const post = await approveAndPublish(req.params.id, req.body.text, Boolean(req.body.publish));
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

// --- Automation surface (n8n, cron). Key auth only; never a browser session. ---

app.post('/api/automation/generate', requireApiKey, async (req, res) => {
  try {
    const post = await generateDraft({
      topicIndex: Number.isInteger(req.body.topicIndex) ? req.body.topicIndex : undefined,
      language: req.body.language,
      tone: req.body.tone,
      objective: req.body.objective,
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
    failed: posts.filter(p => p.status === 'failed').map(p => ({ id: p.id, error: p.error })),
    posts: posts.filter(p => p.status === 'draft' || p.status === 'failed').slice(0, 20)
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')));

if (require.main === module) store.init().then(() => app.listen(PORT, () => console.log(`LinkedIn Studio running at http://localhost:${PORT} (persistence: ${store.kind})`)))
  .catch(error => { console.error('Storage init failed:', error.message); process.exit(1); });
module.exports = app;
