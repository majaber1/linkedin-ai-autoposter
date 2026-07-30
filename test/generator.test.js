const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, demoPost } = require('../scripts/generate-and-post');

const topic = { title: 'AI infrastructure readiness', message: 'Explain the foundations.' };

test('prompt preserves professional constraints', () => {
  const prompt = buildPrompt(topic, { language: 'English', tone: 'executive' });
  assert.match(prompt, /AI infrastructure readiness/);
  assert.match(prompt, /Do not invent statistics/);
  assert.match(prompt, /Saudi Arabia/);
});

test('demo generator supports English and Arabic', () => {
  assert.match(demoPost(topic, { language: 'English' }), /#CloudComputing/);
  assert.match(demoPost(topic, { language: 'Arabic' }), /#الحوسبة_السحابية/);
});
