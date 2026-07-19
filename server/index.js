const express = require('express');
const path = require('path');
const fs = require('fs');
const { generateAndPost } = require('../scripts/generate-and-post');

const app = express();
const PORT = process.env.PORT || 3000;
const POSTS_DIR = path.join(__dirname, '..', 'content', 'posts');

app.use(express.json());

app.get('/posts', (req, res) => {
  if (!fs.existsSync(POSTS_DIR)) return res.json([]);
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  const posts = files.map(f => {
    const raw = fs.readFileSync(path.join(POSTS_DIR, f), 'utf8');
    return { filename: f, content: raw };
  });
  res.json(posts);
});

app.post('/generate', async (req, res) => {
  try {
    const publish = req.body.publish !== undefined ? !!req.body.publish : true;
    const result = await generateAndPost({ publish });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
