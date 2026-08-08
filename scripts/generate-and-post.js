const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const slugify = require('slugify');
const { store } = require('../lib/store');
const { getPublishingCredentials } = require('../lib/linkedin-auth');

// LinkedIn rejects commentary longer than 3000 characters.
const LINKEDIN_MAX_CHARS = 3000;

const CONTENT_DIR = path.join(__dirname, '..', 'content');
const TOPICS_FILE = path.join(CONTENT_DIR, 'topics.json');

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function demoPost(topic, options = {}) {
  const language = options.language || topic.language || 'English';
  const subject = topic.title || topic.sector || 'Cloud transformation';
  if (language.toLowerCase().startsWith('arab')) {
    return `التحول التقني الناجح لا يبدأ بشراء منصة جديدة، بل يبدأ بتحديد النتيجة التي نريد تحقيقها.\n\nفي ${subject}، الفرق الحقيقي تصنعه الحوكمة الواضحة، والقياس المستمر، وبناء قدرات الفريق بالتوازي مع التقنية.\n\nما العامل الذي ترونه الأكثر تأثيرًا في نجاح مبادرات التحول؟\n\n#التحول_الرقمي #الحوسبة_السحابية #البنية_التحتية`;
  }
  return `Successful technology transformation does not start with buying another platform. It starts with a clearly defined outcome.\n\nIn ${subject}, the strongest results come from combining sound governance, measurable operations, and team capability—not treating technology as a standalone project.\n\nWhat has made the biggest difference in your transformation programs?\n\n#CloudComputing #Infrastructure #DigitalTransformation`;
}

function buildPrompt(topic, options = {}) {
  const language = options.language || topic.language || 'English';
  const tone = options.tone || topic.tone || 'authoritative and practical';
  const objective = options.objective || 'build professional thought leadership and start useful discussion';
  const audience = options.audience || 'technology leaders, cloud architects, infrastructure teams, and decision makers in Saudi Arabia';
  const idea = options.idea || topic.title || topic.sector || 'Technology leadership';
  return [
    `Write one LinkedIn post in ${language}.`,
    `Topic or idea: ${idea}`,
    `Brief: ${topic.message || topic.brief || ''}`,
    `Tone: ${tone}. Objective: ${objective}.`,
    `Audience: ${audience}.`,
    options.sourceUrl ? `Source URL for context only: ${options.sourceUrl}` : '',
    options.notes ? `Supporting notes: ${options.notes}` : '',
    options.cta ? `Preferred call to action: ${options.cta}` : '',
    'Start with a strong but credible hook. Use short LinkedIn-friendly paragraphs and one specific practical insight.',
    'Sound natural and experienced, not generic or promotional. Avoid excessive emojis, hashtags, buzzwords, and hype.',
    'Use natural Arabic business language and RTL-friendly structure when writing Arabic.',
    'Use 3 to 5 relevant hashtags. Never invent facts, statistics, customer names, certifications, or personal achievements.',
    'Return only the finished post. Keep it between 700 and 1,300 characters.'
  ].filter(Boolean).join('\n');
}

async function callOpenAI(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    if (/^(1|true)$/i.test(process.env.DEMO_MODE || process.env.DUMMY_MODE || '')) return null;
    throw new Error('OPENAI_API_KEY is not configured. Enable DEMO_MODE for a safe preview.');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      instructions: 'You are an expert LinkedIn editor. Write credible, specific professional content without hype or fabricated facts.',
      input: prompt,
      max_output_tokens: 650,
      temperature: 0.7
    })
  });

  if (!response.ok) throw new Error(`OpenAI request failed (${response.status}): ${await response.text()}`);
  const data = await response.json();
  const text = data.output_text || data.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
  if (!text) throw new Error('The AI provider returned an empty post.');
  return text.trim();
}

const TRANSFORM_ACTIONS = new Set(['regenerate', 'shorten', 'expand', 'tone', 'translate']);

function buildTransformPrompt(post, action, options = {}) {
  if (!TRANSFORM_ACTIONS.has(action)) throw new Error('Unsupported draft action.');
  const instructions = {
    regenerate: 'Rewrite the post with a fresh structure and hook while preserving its meaning and factual boundaries.',
    shorten: 'Shorten the post materially. Keep the strongest insight, CTA, and useful hashtags.',
    expand: 'Expand the post with more useful explanation, without adding invented facts or unsupported claims.',
    tone: `Rewrite in a ${String(options.tone || 'practical executive').slice(0, 100)} tone.`,
    translate: `Translate and localize the post into ${options.language === 'Arabic' ? 'natural Arabic business language' : 'natural professional English'}.`
  };
  return [
    instructions[action],
    'Preserve the original intent, verified details, and call to action. Do not invent statistics, claims, names, or achievements.',
    'Use short LinkedIn-friendly paragraphs, 3–5 relevant hashtags, no hype, and stay below 3,000 characters.',
    'Return only the finished post.',
    `Original post:\n${post.text}`
  ].join('\n');
}

async function transformDraft(id, action, options = {}) {
  const post = await store.getPost(id);
  if (!['draft', 'failed'].includes(post.status)) throw new Error('Return the post to Draft before changing its content.');
  const prompt = buildTransformPrompt(post, action, options);
  let text = await callOpenAI(prompt);
  if (!text) {
    if (action === 'shorten') text = post.text.slice(0, Math.max(300, Math.floor(post.text.length * 0.65))).trim();
    else if (action === 'translate') text = demoPost({ title: post.title }, { language: options.language || 'Arabic' });
    else text = post.text;
  }
  if (!text || text.length > LINKEDIN_MAX_CHARS) throw new Error('The revised post exceeds the LinkedIn character limit.');
  const revision = { text: post.text, createdAt: new Date().toISOString(), action };
  return store.updatePost(id, {
    text, language: action === 'translate' ? options.language : post.language,
    status: 'draft', approvedAt: null, scheduledFor: null, error: null,
    revisions: [...(post.revisions || []), revision].slice(-25)
  });
}

async function uploadImageToLinkedIn(image, credentials, http = fetch) {
  const version = process.env.LINKEDIN_API_VERSION || '202601';
  const initialized = await http('https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': version,
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify({ initializeUploadRequest: { owner: credentials.personUrn } })
  });
  if (!initialized.ok) throw new Error(`LinkedIn image initialization failed (${initialized.status}): ${await initialized.text()}`);
  const payload = await initialized.json();
  const uploadUrl = payload.value?.uploadUrl;
  const imageUrn = payload.value?.image;
  if (!uploadUrl || !imageUrn) throw new Error('LinkedIn did not return an image upload URL.');

  const uploaded = await http(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Content-Type': image.mimeType },
    body: image.data
  });
  if (!uploaded.ok) throw new Error(`LinkedIn image upload failed (${uploaded.status}): ${await uploaded.text()}`);
  return imageUrn;
}

async function publishToLinkedIn(text, image = null) {
  const credentials = await getPublishingCredentials();
  const token = credentials.accessToken;
  const author = credentials.personUrn;
  if (!text || !text.trim()) throw new Error('The post is empty.');
  if (text.length > LINKEDIN_MAX_CHARS) {
    throw new Error(`The post is ${text.length} characters. LinkedIn allows ${LINKEDIN_MAX_CHARS}.`);
  }

  const imageUrn = image ? await uploadImageToLinkedIn(image, credentials) : null;
  const postBody = {
    author,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false
  };
  if (imageUrn) postBody.content = { media: { id: imageUrn, altText: image.altText || '' } };

  const response = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': process.env.LINKEDIN_API_VERSION || '202601',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify(postBody)
  });

  if (!response.ok) throw new Error(`LinkedIn publish failed (${response.status}): ${await response.text()}`);
  return { id: response.headers.get('x-restli-id') || null };
}

async function savePost({ title, text, topic, status = 'draft', provider = 'demo', linkedinId = null, language = null, scheduledFor = null, brief = null }) {
  const now = new Date();
  const slug = slugify(title || 'linkedin-post', { lower: true, strict: true }) || 'linkedin-post';
  const suffix = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  const record = {
    id: `${now.toISOString().slice(0, 10)}-${slug}-${suffix}`,
    title,
    text,
    status,
    provider,
    topicSlug: topic?.slug || null,
    language: language || null,
    scheduledFor: scheduledFor || null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    publishedAt: status === 'published' ? now.toISOString() : null,
    linkedinId
    , brief, approvedAt: null, linkedinUrl: null, revisions: [], publishingAttempts: []
  };
  return store.savePost(record);
}

function updatePost(id, changes) {
  const clean = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
  return store.updatePost(id, clean);
}

function listPosts() {
  return store.listPosts();
}

function getPost(id) {
  return store.getPost(id);
}

function deletePost(id) {
  return store.deletePost(id);
}

async function schedulePost(id, scheduledFor) {
  const when = new Date(scheduledFor);
  if (Number.isNaN(when.getTime())) throw new Error('The scheduled time is not a valid date.');
  if (when <= new Date()) throw new Error('Choose a future publishing time.');
  const post = await store.getPost(id);
  if (post.status !== 'approved') throw new Error('Approve this post before scheduling it.');
  return store.updatePost(id, { status: 'scheduled', scheduledFor: when.toISOString() });
}

// Publishes every scheduled post whose publishing time has passed. Safe to call
// repeatedly: publishing flips the status, so a post is never sent twice.
async function publishDuePosts({ limit = 10 } = {}) {
  const due = await store.listDuePosts(new Date());
  const results = [];
  for (const post of due.slice(0, limit)) {
    try {
      const published = await approveAndPublish(post.id, undefined, true);
      results.push({ id: post.id, status: published.status, linkedinId: published.linkedinId });
    } catch (error) {
      results.push({ id: post.id, status: 'failed', error: error.message });
    }
  }
  return { checked: due.length, processed: results.length, results };
}

async function generateDraft(options = {}) {
  const topics = readJSON(TOPICS_FILE, []);
  if (!topics.length) throw new Error('No content topics are configured.');
  const cursor = await store.getCursor();
  const index = Number.isInteger(options.topicIndex) ? options.topicIndex : cursor % topics.length;
  const topic = topics[index];
  if (!topic) throw new Error('The requested topic does not exist.');
  const generated = await callOpenAI(buildPrompt(topic, options));
  const text = generated || demoPost(topic, options);
  const record = await savePost({
    title: topic.title || topic.sector || 'LinkedIn post',
    text,
    topic,
    status: 'draft',
    provider: generated ? 'openai' : 'demo',
    language: options.language || topic.language || 'English',
    scheduledFor: options.scheduledFor || null
    , brief: {
      idea: options.idea || null, objective: options.objective || null, audience: options.audience || null,
      sourceUrl: options.sourceUrl || null, notes: options.notes || null, cta: options.cta || null, tone: options.tone || null
    }
  });
  if (!Number.isInteger(options.topicIndex)) await store.setCursor(cursor + 1);
  return record;
}

async function approveAndPublish(id, editedText, shouldPublish = false) {
  if (!shouldPublish) {
    const current = await store.getPost(id);
    if (!['draft', 'failed'].includes(current.status)) throw new Error('Only a reviewed draft or failed post can be approved.');
    return updatePost(id, {
      text: editedText?.trim() || undefined, status: 'approved', approvedAt: new Date().toISOString(), scheduledFor: null, error: null
    });
  }
  if (editedText?.trim()) throw new Error('Save edits and approve the post before publishing.');
  return publishApprovedPost(id);
}

async function publishApprovedPost(id, dependencies = {}) {
  const activeStore = dependencies.store || store;
  const publish = dependencies.publish || publishToLinkedIn;
  const post = await activeStore.claimPostForPublishing(id);
  if (!post) throw new Error('This post is not approved or is already being published.');
  try {
    const image = post.hasImage ? await activeStore.getPostImage(id) : null;
    if (post.hasImage && !image) throw new Error('The post image is missing from storage. Upload it again.');
    const result = await publish(post.text, image);
    const linkedinUrl = result.id ? `https://www.linkedin.com/feed/update/${result.id}/` : null;
    return await activeStore.finishPublishing(id, {
      status: 'published', publishedAt: new Date().toISOString(), linkedinId: result.id, linkedinUrl, error: null
    });
  } catch (error) {
    await activeStore.finishPublishing(id, { status: 'failed', error: error.message });
    throw error;
  }
}

async function generateAndPost({ publish = false } = {}) {
  const draft = await generateDraft();
  if (publish) throw new Error('Automatic generation cannot publish. Review and approve the saved draft first.');
  return draft;
}

if (require.main === module) {
  generateAndPost({ publish: /^(1|true)$/i.test(process.env.AUTO_PUBLISH || '') })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  generateDraft, approveAndPublish, generateAndPost, listPosts, getPost, updatePost,
  deletePost, schedulePost, publishDuePosts, buildPrompt, buildTransformPrompt, transformDraft, demoPost, store, LINKEDIN_MAX_CHARS
  , publishToLinkedIn, publishApprovedPost, uploadImageToLinkedIn
};
