const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildPrompt, demoPost, publishApprovedPost, uploadImageToLinkedIn } = require('../scripts/generate-and-post');

const topic = { title: 'AI infrastructure readiness', message: 'Explain the foundations.' };

test('prompt preserves professional constraints', () => {
  const prompt = buildPrompt(topic, { language: 'English', tone: 'executive' });
  assert.match(prompt, /AI infrastructure readiness/);
  assert.match(prompt, /Never invent facts, statistics/);
  assert.match(prompt, /Saudi Arabia/);
});

test('V3 prompt preserves owner context without weakening credibility rules', () => {
  const prompt = buildPrompt(topic, {
    idea: 'What platform teams should measure', audience: 'Saudi technology executives',
    objective: 'Share a practical lesson', sourceUrl: 'https://example.com/source',
    notes: 'Use operational experience, not vendor claims.', cta: 'Ask leaders what they measure.'
  });
  assert.match(prompt, /What platform teams should measure/);
  assert.match(prompt, /Saudi technology executives/);
  assert.match(prompt, /https:\/\/example.com\/source/);
  assert.match(prompt, /not vendor claims/);
  assert.match(prompt, /Ask leaders what they measure/);
  assert.match(prompt, /not generic or promotional/);
});

test('demo generator supports English and Arabic', () => {
  assert.match(demoPost(topic, { language: 'English' }), /#CloudComputing/);
  assert.match(demoPost(topic, { language: 'Arabic' }), /#الحوسبة_السحابية/);
});

test('concurrent publishers claim an approved post only once', async () => {
  let claimed = false;
  let publishCalls = 0;
  const fakeStore = {
    async claimPostForPublishing() {
      if (claimed) return null;
      claimed = true;
      return { id: 'post-1', text: 'Ship once', status: 'publishing' };
    },
    async finishPublishing(id, changes) {
      return { id, text: 'Ship once', ...changes };
    }
  };
  const publish = async () => {
    publishCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { id: 'urn:li:share:1' };
  };

  const results = await Promise.allSettled([
    publishApprovedPost('post-1', { store: fakeStore, publish }),
    publishApprovedPost('post-1', { store: fakeStore, publish })
  ]);

  assert.equal(publishCalls, 1);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('publishing failures leave a retryable failed state', async () => {
  let finalChanges;
  const fakeStore = {
    async claimPostForPublishing() { return { id: 'post-2', text: 'Try me' }; },
    async finishPublishing(id, changes) { finalChanges = changes; return { id, ...changes }; }
  };

  await assert.rejects(
    publishApprovedPost('post-2', { store: fakeStore, publish: async () => { throw new Error('LinkedIn unavailable'); } }),
    /LinkedIn unavailable/
  );
  assert.equal(finalChanges.status, 'failed');
  assert.match(finalChanges.error, /LinkedIn unavailable/);
});

test('an unapproved draft cannot enter the publishing path', async () => {
  let publishCalls = 0;
  const draftStore = { async claimPostForPublishing() { return null; } };
  await assert.rejects(
    publishApprovedPost('draft-1', { store: draftStore, publish: async () => { publishCalls += 1; } }),
    /not approved/
  );
  assert.equal(publishCalls, 0);
});

test('image publishing initializes and uploads the exact bytes', async () => {
  const calls = [];
  const http = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return {
      ok: true,
      json: async () => ({ value: { uploadUrl: 'https://upload.example/image', image: 'urn:li:image:123' } })
    };
    return { ok: true };
  };
  const bytes = Buffer.from('image-bytes');
  const urn = await uploadImageToLinkedIn(
    { data: bytes, mimeType: 'image/png' },
    { accessToken: 'token', personUrn: 'urn:li:person:123' },
    http
  );

  assert.equal(urn, 'urn:li:image:123');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /images\?action=initializeUpload/);
  assert.equal(JSON.parse(calls[0].options.body).initializeUploadRequest.owner, 'urn:li:person:123');
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(calls[1].options.body, bytes);
});

test('V3 interface includes responsive review, preview, image, and RTL controls', () => {
  const html = fs.readFileSync(require.resolve('../frontend/index.html'), 'utf8');
  assert.match(html, /Turn expertise into signal/);
  assert.match(html, /Live preview/);
  assert.match(html, /Image alt text/);
  assert.match(html, /dir="\$\{rtl\?'rtl':'ltr'\}"/);
  assert.match(html, /@media\(max-width:700px\)/);
  assert.match(html, /Explicit publishing confirmation is required|confirm:true/);
});
