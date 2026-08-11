'use strict';

const CHANNELS = [
  { id: 'linkedin', name: 'LinkedIn', nameAr: 'لينكدإن', kind: 'professional', formats: ['text', 'image'], maxChars: 3000, connector: 'live', env: 'LINKEDIN_ACCESS_TOKEN' },
  { id: 'reddit', name: 'Reddit', nameAr: 'ريديت', kind: 'community', formats: ['text', 'link', 'image'], connector: 'planned', env: 'REDDIT_CLIENT_ID' },
  { id: 'meetup', name: 'Meetup', nameAr: 'ميتاب', kind: 'community', formats: ['event', 'discussion'], connector: 'planned', env: 'MEETUP_CLIENT_ID' },
  { id: 'instagram', name: 'Instagram', nameAr: 'إنستغرام', kind: 'visual', formats: ['image', 'carousel', 'reel'], connector: 'planned', env: 'META_ACCESS_TOKEN' },
  { id: 'tiktok', name: 'TikTok', nameAr: 'تيك توك', kind: 'video', formats: ['short-video'], connector: 'planned', env: 'TIKTOK_CLIENT_KEY' },
  { id: 'youtube', name: 'YouTube', nameAr: 'يوتيوب', kind: 'video', formats: ['video', 'short', 'community-post'], connector: 'planned', env: 'YOUTUBE_CLIENT_ID' },
  { id: 'newsletter', name: 'Newsletter / publication', nameAr: 'النشرة أو المنصة الإعلامية', kind: 'editorial', formats: ['article', 'pitch', 'newsletter'], connector: 'export', env: null },
  { id: 'website', name: 'Technology website', nameAr: 'الموقع التقني', kind: 'owned', formats: ['article', 'news-brief'], connector: 'export', env: null }
];

function channelCatalog(env = process.env) {
  return CHANNELS.map(channel => ({
    ...channel,
    connected: channel.connector === 'live' ? Boolean(env[channel.env]) : false,
    available: channel.connector === 'live' ? Boolean(env[channel.env]) : channel.connector === 'export'
  }));
}

module.exports = { CHANNELS, channelCatalog };
