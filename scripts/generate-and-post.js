const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const slugify = require('slugify');

const CONTENT_DIR = path.join(__dirname, '..', 'content');
const TOPICS_FILE = path.join(CONTENT_DIR, 'topics.json');
const POSTS_DIR = path.join(CONTENT_DIR, 'posts');
const LAST_INDEX_FILE = path.join(CONTENT_DIR, 'last_index.json');

async function callOpenAI(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'system', content: 'You are a helpful assistant that writes short on-brand LinkedIn posts.' }, { role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.7
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('OpenAI error: ' + txt);
  }
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

async function postToLinkedIn(text) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const author = process.env.LINKEDIN_PERSON_URN; // e.g. urn:li:person:xxxx
  if (!token || !author) throw new Error('LINKEDIN_ACCESS_TOKEN or LINKEDIN_PERSON_URN not set');

  const payload = {
    author: author,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: {
          text: text
        },
        shareMediaCategory: 'NONE'
      }
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
    }
  };

  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error('LinkedIn error: ' + txt);
  }
  return await res.json();
}

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writePostToFile(title, text) {
  const now = new Date();
  const date = now.toISOString().slice(0,10);
  const slug = slugify(title || text.slice(0,40), { lower: true, strict: true });
  const filename = `${date}-${slug}.md`;
  const filePath = path.join(POSTS_DIR, filename);
  const content = `---\ntitle: "${title.replace(/\"/g, '\\"')}"\ndate: "${now.toISOString()}"\n---\n\n${text}\n`;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

async function generateAndPost({ publish = true } = {}) {
  const topics = readJSON(TOPICS_FILE) || [];
  if (!topics.length) throw new Error('No topics found in content/topics.json');

  let last = readJSON(LAST_INDEX_FILE) || { index: 0 };
  const idx = last.index % topics.length;
  const topic = topics[idx];

  const prompt = `Write a short (3-6 sentence) LinkedIn post about the following topic: \n\n${JSON.stringify(topic)}\n\nKeep it professional, engaging, and end with a question to promote comments.`;
  console.log('Generating post for topic:', topic.title || topic);
  const postText = await callOpenAI(prompt);

  const title = (topic.title) ? `${topic.title}` : (typeof topic === 'string' ? topic : 'Daily post');
  const savedPath = writePostToFile(title, postText);
  console.log('Saved post to', savedPath);

  last.index = last.index + 1;
  fs.writeFileSync(LAST_INDEX_FILE, JSON.stringify(last, null, 2), 'utf8');

  let linkedinResult = null;
  if (publish) {
    try {
      linkedinResult = await postToLinkedIn(postText);
      console.log('Published to LinkedIn:', JSON.stringify(linkedinResult));
    } catch (err) {
      console.error('LinkedIn publish failed:', err.message);
      // still return success but include error
      linkedinResult = { error: err.message };
    }
  }

  return { savedPath, postText, linkedinResult };
}

if (require.main === module) {
  // CLI
  (async () => {
    try {
      const publish = process.env.SKIP_PUBLISH ? false : true;
      const res = await generateAndPost({ publish });
      console.log('Done', res.savedPath);
      process.exit(0);
    } catch (err) {
      console.error(err);
      process.exit(2);
    }
  })();
} else {
  module.exports = { generateAndPost };
}
