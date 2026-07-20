const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { generateAndPost } = require('../scripts/generate-and-post');

const app = express();
const PORT = process.env.PORT || 3000;
const POSTS_DIR = path.join(__dirname, '..', 'content', 'posts');

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI || `http://localhost:${PORT}/auth/github/callback`;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Session storage (in production, use a proper session store like Redis)
const sessions = new Map();

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15);
}

// Auth middleware
function requireAuth(req, res, next) {
  const token = req.cookies?.auth_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  req.user = sessions.get(token);
  next();
}

// OAuth login endpoint
app.get('/auth/github', (req, res) => {
  const scope = 'user:email';
  const redirectUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(GITHUB_REDIRECT_URI)}&scope=${scope}`;
  res.json({ ok: true, url: redirectUrl });
});

// OAuth callback
app.get('/auth/github/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ ok: false, error: 'No auth code' });

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code
      })
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description);

    // Get user info
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `token ${tokenData.access_token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
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

// Check auth status
app.get('/auth/me', (req, res) => {
  const token = req.cookies?.auth_token || req.query.auth_token;
  if (!token || !sessions.has(token)) {
    return res.json({ ok: false, user: null });
  }
  res.json({ ok: true, user: sessions.get(token) });
});

// Logout
app.post('/auth/logout', (req, res) => {
  const token = req.cookies?.auth_token || req.headers.authorization?.replace('Bearer ', '');
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'auth_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 UTC');
  res.json({ ok: true });
});

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
    const publish = req.body.publish !== undefined ? !!req.body.publish : true;
    const result = await generateAndPost({ publish });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
