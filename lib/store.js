'use strict';

const fs = require('fs');
const path = require('path');

const CONTENT_DIR = path.join(__dirname, '..', 'content');
const POSTS_DIR = path.join(CONTENT_DIR, 'posts');
const MEDIA_DIR = path.join(CONTENT_DIR, 'media');
const LAST_INDEX_FILE = path.join(CONTENT_DIR, 'last_index.json');

const POST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,199}$/i;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function assertPostId(id) {
  if (typeof id !== 'string' || !POST_ID_PATTERN.test(id)) throw new Error('Post not found.');
  return id;
}

/* ------------------------------------------------------------------ *
 * Filesystem driver — for local development and Railway/Fly/VM hosts
 * with a persistent volume. Sessions live in process memory, which is
 * correct for a single long-lived instance.
 * ------------------------------------------------------------------ */

function filesystemDriver() {
  const sessions = new Map();
  const oauthStates = new Map();
  const publishingClaims = new Set();

  function readJSON(filePath, fallback) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function atomicWrite(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, filePath);
  }

  function postPath(id) {
    const filePath = path.join(POSTS_DIR, `${assertPostId(id)}.json`);
    const root = path.resolve(POSTS_DIR) + path.sep;
    if (!path.resolve(filePath).startsWith(root)) throw new Error('Post not found.');
    return filePath;
  }

  function mediaPath(id) {
    const filePath = path.join(MEDIA_DIR, `${assertPostId(id)}.bin`);
    const root = path.resolve(MEDIA_DIR) + path.sep;
    if (!path.resolve(filePath).startsWith(root)) throw new Error('Post not found.');
    return filePath;
  }

  return {
    kind: 'filesystem',
    async init() {},

    async savePost(record) {
      atomicWrite(postPath(record.id), JSON.stringify(record, null, 2));
      return record;
    },

    async getPost(id) {
      const filePath = postPath(id);
      if (!fs.existsSync(filePath)) throw new Error('Post not found.');
      return readJSON(filePath, null);
    },

    async updatePost(id, changes) {
      const current = await this.getPost(id);
      const updated = { ...current, ...changes, id: current.id, updatedAt: new Date().toISOString() };
      atomicWrite(postPath(id), JSON.stringify(updated, null, 2));
      return updated;
    },

    async deletePost(id) {
      const filePath = postPath(id);
      if (!fs.existsSync(filePath)) throw new Error('Post not found.');
      fs.unlinkSync(filePath);
      if (fs.existsSync(mediaPath(id))) fs.unlinkSync(mediaPath(id));
      return true;
    },

    async savePostImage(id, image) {
      await this.getPost(id);
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      const temporary = `${mediaPath(id)}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, image.data);
      fs.renameSync(temporary, mediaPath(id));
      return this.updatePost(id, { hasImage: true, imageMimeType: image.mimeType, imageAltText: image.altText || '', imageName: image.name || 'image' });
    },

    async getPostImage(id) {
      const post = await this.getPost(id);
      if (!post.hasImage || !fs.existsSync(mediaPath(id))) return null;
      return { data: fs.readFileSync(mediaPath(id)), mimeType: post.imageMimeType, altText: post.imageAltText || '', name: post.imageName };
    },

    async deletePostImage(id) {
      if (fs.existsSync(mediaPath(id))) fs.unlinkSync(mediaPath(id));
      return this.updatePost(id, { hasImage: false, imageMimeType: null, imageAltText: null, imageName: null });
    },

    async listDuePosts(now = new Date()) {
      const all = await this.listPosts();
      return all.filter(post => post.status === 'scheduled' && post.scheduledFor && new Date(post.scheduledFor) <= now);
    },

    async claimPostForPublishing(id) {
      if (publishingClaims.has(id)) return null;
      const current = await this.getPost(id);
      if (!['approved', 'scheduled', 'failed'].includes(current.status) || !current.approvedAt) return null;
      publishingClaims.add(id);
      try {
        return await this.updatePost(id, { status: 'publishing', error: null });
      } catch (error) {
        publishingClaims.delete(id);
        throw error;
      }
    },

    async finishPublishing(id, changes) {
      try {
        return await this.updatePost(id, changes);
      } finally {
        publishingClaims.delete(id);
      }
    },

    async listPosts() {
      if (!fs.existsSync(POSTS_DIR)) return [];
      return fs.readdirSync(POSTS_DIR)
        .filter(file => file.endsWith('.json'))
        .map(file => readJSON(path.join(POSTS_DIR, file), null))
        .filter(Boolean)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async getCursor() {
      return readJSON(LAST_INDEX_FILE, { index: 0 }).index || 0;
    },

    async setCursor(index) {
      atomicWrite(LAST_INDEX_FILE, JSON.stringify({ index }, null, 2));
    },

    async getAppState(key) {
      return readJSON(path.join(CONTENT_DIR, `.state-${key}.json`), null);
    },

    async setAppState(key, value) {
      if (!/^[a-z0-9_-]{1,80}$/i.test(key)) throw new Error('Invalid state key.');
      atomicWrite(path.join(CONTENT_DIR, `.state-${key}.json`), JSON.stringify(value));
    },

    async putSession(id, user) {
      sessions.set(id, { user, expiresAt: Date.now() + SESSION_TTL_MS });
    },

    async getSession(id) {
      const entry = sessions.get(id);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) {
        sessions.delete(id);
        return null;
      }
      return entry.user;
    },

    async deleteSession(id) {
      sessions.delete(id);
    },

    async putOAuthState(state) {
      oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
    },

    async consumeOAuthState(state) {
      const expiresAt = oauthStates.get(state);
      oauthStates.delete(state);
      return Boolean(expiresAt && expiresAt > Date.now());
    }
  };
}

/* ------------------------------------------------------------------ *
 * Postgres driver — required for Vercel and any serverless host, where
 * the filesystem is read-only and no instance state survives a request.
 * ------------------------------------------------------------------ */

function postgresDriver() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX || 3),
    ssl: /sslmode=disable/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: false }
  });

  const rowToPost = row => row && ({
    id: row.id,
    title: row.title,
    text: row.text,
    status: row.status,
    provider: row.provider,
    topicSlug: row.topic_slug,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
    linkedinId: row.linkedin_id,
    scheduledFor: row.scheduled_for ? row.scheduled_for.toISOString() : null,
    language: row.language,
    error: row.error,
    hasImage: Boolean(row.has_image),
    imageMimeType: row.image_mime_type,
    imageAltText: row.image_alt_text,
    imageName: row.image_name,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
    linkedinUrl: row.linkedin_url,
    brief: row.brief || null
  });

  return {
    kind: 'postgres',

    async init() {
      const schema = `
        CREATE TABLE IF NOT EXISTS posts (
          id           TEXT PRIMARY KEY,
          title        TEXT NOT NULL,
          text         TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'draft',
          provider     TEXT NOT NULL DEFAULT 'demo',
          topic_slug   TEXT,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          published_at TIMESTAMPTZ,
          linkedin_id  TEXT,
          scheduled_for TIMESTAMPTZ,
          language     TEXT,
          error        TEXT
        );
        ALTER TABLE posts ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
        ALTER TABLE posts ADD COLUMN IF NOT EXISTS language TEXT;
        ALTER TABLE posts ADD COLUMN IF NOT EXISTS has_image BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_mime_type TEXT;
        ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_alt_text TEXT;
        ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_name TEXT;
        ALTER TABLE posts ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
        ALTER TABLE posts ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
        ALTER TABLE posts ADD COLUMN IF NOT EXISTS brief JSONB;
        CREATE INDEX IF NOT EXISTS posts_due_idx ON posts (status, scheduled_for);
        CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts (created_at DESC);

        CREATE TABLE IF NOT EXISTS app_state (
          key   TEXT PRIMARY KEY,
          value JSONB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id         TEXT PRIMARY KEY,
          user_data  JSONB NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

        CREATE TABLE IF NOT EXISTS oauth_states (
          state      TEXT PRIMARY KEY,
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS post_images (
          post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
          image_data BYTEA NOT NULL
        );
      `;
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await pool.query(schema);
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 250));
        }
      }
      throw lastError;
    },

    async savePost(record) {
      await pool.query(
        `INSERT INTO posts (id, title, text, status, provider, topic_slug, created_at, updated_at, published_at, linkedin_id, scheduled_for, language, brief)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [assertPostId(record.id), record.title, record.text, record.status, record.provider,
          record.topicSlug, record.createdAt, record.updatedAt, record.publishedAt, record.linkedinId,
          record.scheduledFor || null, record.language || null, JSON.stringify(record.brief || null)]
      );
      return record;
    },

    async getPost(id) {
      const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [assertPostId(id)]);
      if (!rows.length) throw new Error('Post not found.');
      return rowToPost(rows[0]);
    },

    async updatePost(id, changes) {
      // Only whitelisted columns are writable; nothing is interpolated into SQL.
      const columns = {
        text: 'text', title: 'title', status: 'status',
        publishedAt: 'published_at', linkedinId: 'linkedin_id', error: 'error',
        scheduledFor: 'scheduled_for', language: 'language',
        hasImage: 'has_image', imageMimeType: 'image_mime_type',
        imageAltText: 'image_alt_text', imageName: 'image_name',
        approvedAt: 'approved_at', linkedinUrl: 'linkedin_url', brief: 'brief'
      };
      const sets = [];
      const values = [assertPostId(id)];
      for (const [key, column] of Object.entries(columns)) {
        if (changes[key] !== undefined) {
          values.push(changes[key]);
          sets.push(`${column} = $${values.length}`);
        }
      }
      sets.push('updated_at = now()');
      const { rows } = await pool.query(
        `UPDATE posts SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, values
      );
      if (!rows.length) throw new Error('Post not found.');
      return rowToPost(rows[0]);
    },

    async listPosts() {
      const { rows } = await pool.query('SELECT * FROM posts ORDER BY created_at DESC LIMIT 500');
      return rows.map(rowToPost);
    },

    async deletePost(id) {
      const { rowCount } = await pool.query('DELETE FROM posts WHERE id = $1', [assertPostId(id)]);
      if (!rowCount) throw new Error('Post not found.');
      return true;
    },

    async savePostImage(id, image) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO post_images (post_id, image_data) VALUES ($1, $2)
           ON CONFLICT (post_id) DO UPDATE SET image_data = EXCLUDED.image_data`,
          [assertPostId(id), image.data]
        );
        const { rows } = await client.query(
          `UPDATE posts SET has_image = true, image_mime_type = $2, image_alt_text = $3,
             image_name = $4, updated_at = now() WHERE id = $1 RETURNING *`,
          [id, image.mimeType, image.altText || '', image.name || 'image']
        );
        if (!rows.length) throw new Error('Post not found.');
        await client.query('COMMIT');
        return rowToPost(rows[0]);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },

    async getPostImage(id) {
      const { rows } = await pool.query(
        `SELECT i.image_data, p.image_mime_type, p.image_alt_text, p.image_name
         FROM post_images i JOIN posts p ON p.id = i.post_id WHERE i.post_id = $1`,
        [assertPostId(id)]
      );
      return rows.length ? { data: rows[0].image_data, mimeType: rows[0].image_mime_type, altText: rows[0].image_alt_text || '', name: rows[0].image_name } : null;
    },

    async deletePostImage(id) {
      await pool.query('DELETE FROM post_images WHERE post_id = $1', [assertPostId(id)]);
      return this.updatePost(id, { hasImage: false, imageMimeType: null, imageAltText: null, imageName: null });
    },

    async listDuePosts(now = new Date()) {
      const { rows } = await pool.query(
        `SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= $1
         ORDER BY scheduled_for ASC LIMIT 25`, [now.toISOString()]
      );
      return rows.map(rowToPost);
    },

    async claimPostForPublishing(id) {
      const { rows } = await pool.query(
        `UPDATE posts SET status = 'publishing', error = NULL, updated_at = now()
         WHERE id = $1 AND status IN ('approved', 'scheduled', 'failed') AND approved_at IS NOT NULL RETURNING *`, [assertPostId(id)]
      );
      return rows.length ? rowToPost(rows[0]) : null;
    },

    async finishPublishing(id, changes) {
      return this.updatePost(id, changes);
    },

    async getCursor() {
      const { rows } = await pool.query(`SELECT value FROM app_state WHERE key = 'cursor'`);
      return rows.length ? Number(rows[0].value.index) || 0 : 0;
    },

    async setCursor(index) {
      await pool.query(
        `INSERT INTO app_state (key, value) VALUES ('cursor', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [JSON.stringify({ index })]
      );
    },

    async getAppState(key) {
      const { rows } = await pool.query('SELECT value FROM app_state WHERE key = $1', [key]);
      return rows.length ? rows[0].value : null;
    },

    async setAppState(key, value) {
      await pool.query(
        `INSERT INTO app_state (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)]
      );
    },

    async putSession(id, user) {
      await pool.query(
        `INSERT INTO sessions (id, user_data, expires_at) VALUES ($1, $2, now() + interval '24 hours')`,
        [id, JSON.stringify(user)]
      );
      await pool.query('DELETE FROM sessions WHERE expires_at < now()');
    },

    async getSession(id) {
      const { rows } = await pool.query(
        'SELECT user_data FROM sessions WHERE id = $1 AND expires_at > now()', [id]
      );
      return rows.length ? rows[0].user_data : null;
    },

    async deleteSession(id) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [id]);
    },

    async putOAuthState(state) {
      await pool.query(
        `INSERT INTO oauth_states (state, expires_at) VALUES ($1, now() + interval '10 minutes')
         ON CONFLICT (state) DO NOTHING`,
        [state]
      );
      await pool.query('DELETE FROM oauth_states WHERE expires_at < now()');
    },

    async consumeOAuthState(state) {
      const { rows } = await pool.query(
        'DELETE FROM oauth_states WHERE state = $1 AND expires_at > now() RETURNING state', [state]
      );
      return rows.length > 0;
    }
  };
}

const store = process.env.DATABASE_URL ? postgresDriver() : filesystemDriver();

module.exports = { store, assertPostId, POST_ID_PATTERN };
