const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { generateAndPost } = require('../scripts/generate-and-post');

const app = express();
const PORT = process.env.PORT || 3000;
const POSTS_DIR = path.join(__dirname, '..', 'content', 'posts');
const TOPICS_FILE = path.join(__dirname, '..', 'content', 'topics.json');
const LAST_INDEX_FILE = path.join(__dirname, '..', 'content', 'last_index.json');

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI || `http://localhost:${PORT}/auth/github/callback`;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const sessions = new Map();

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15);
}

function requireAuth(req, res, next) {
  const token = req.cookies?.auth_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  req.user = sessions.get(token);
  next();
}

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// OAuth endpoints
app.get('/auth/github', (req, res) => {
  const scope = 'user:email';
  const redirectUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(GITHUB_REDIRECT_URI)}&scope=${scope}`;
  res.json({ ok: true, url: redirectUrl });
});

app.get('/auth/github/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ ok: false, error: 'No auth code' });

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code })
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description);

    const userRes = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `token ${tokenData.access_token}`, 'Accept': 'application/vnd.github.v3+json' }
    });

    const user = await userRes.json();
    const sessionId = generateSessionId();
    sessions.set(sessionId, { login: user.login, id: user.id, avatar: user.avatar_url });

    res.setHeader('Set-Cookie', `auth_token=${sessionId}; Path=/; HttpOnly; SameSite=Strict`);
    res.redirect('/?auth_token=' + sessionId);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/auth/me', (req, res) => {
  const token = req.cookies?.auth_token || req.query.auth_token;
  if (!token || !sessions.has(token)) {
    return res.json({ ok: false, user: null });
  }
  res.json({ ok: true, user: sessions.get(token) });
});

app.post('/auth/logout', (req, res) => {
  const token = req.cookies?.auth_token || req.headers.authorization?.replace('Bearer ', '');
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'auth_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 UTC');
  res.json({ ok: true });
});

// Posts API
app.get('/api/posts', (req, res) => {
  if (!fs.existsSync(POSTS_DIR)) return res.json([]);
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md')).sort().reverse();
  const posts = files.map(f => {
    const raw = fs.readFileSync(path.join(POSTS_DIR, f), 'utf8');
    const match = raw.match(/date:\s*"([^"]+)"/);
    const date = match ? match[1] : f.split('-').slice(0, 3).join('-');
    return { filename: f, content: raw, date };
  });
  res.json(posts);
});

// Topics API
app.get('/api/topics', (req, res) => {
  const topics = readJSON(TOPICS_FILE) || [];
  const lastIndex = (readJSON(LAST_INDEX_FILE) || { index: 0 }).index;
  const currentIdx = lastIndex % topics.length;
  res.json({ topics, currentIndex: currentIdx });
});

app.put('/api/topics', requireAuth, (req, res) => {
  try {
    const { topics } = req.body;
    if (!Array.isArray(topics)) throw new Error('Topics must be an array');
    writeJSON(TOPICS_FILE, topics);
    res.json({ ok: true, topics });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Generate endpoint
app.post('/api/generate', requireAuth, async (req, res) => {
  try {
    const { publish } = req.body;
    process.env.DUMMY_MODE = 'true';
    process.env.SKIP_PUBLISH = publish === false ? 'true' : '';
    const result = await generateAndPost({ publish: publish !== false });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Legacy endpoints (keep for compatibility)
app.get('/posts', (req, res) => {
  if (!fs.existsSync(POSTS_DIR)) return res.json([]);
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  const posts = files.map(f => {
    const raw = fs.readFileSync(path.join(POSTS_DIR, f), 'utf8');
    return { filename: f, content: raw };
  });
  res.json(posts);
});

app.post('/generate', requireAuth, async (req, res) => {
  try {
    process.env.DUMMY_MODE = 'true';
    process.env.SKIP_PUBLISH = 'true';
    const result = await generateAndPost({ publish: false });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`✨ Server listening on http://localhost:${PORT}`));
