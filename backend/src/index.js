/**
 * Cloudflare Worker for the community-ratings layer -- see backend/README.md.
 *
 * Endpoints:
 *   GET    /score/:videoId              -> aggregated vote counts for a video
 *   POST   /vote {videoId, channelId, vote, clientId}
 *                                        -> record one anonymous vote
 *   POST   /admin/blocklist {videoId, reason}, header x-admin-token
 *                                        -> suppress a video's community score
 *   DELETE /admin/blocklist/:videoId, header x-admin-token
 *                                        -> un-suppress a video
 *
 * Deliberately minimal: no auth, no accounts, no human-verification step.
 * Abuse resistance is limited to (a) one vote per (videoId, clientId) via a
 * DB primary key, and (b) a crude per-IP-hash rate limit, with the blocklist
 * as the moderation backstop. That's appropriate for a personal /
 * small-community scale, not for an adversarial one.
 */

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 20;

// --- input validation ------------------------------------------------------
// Client-supplied identifiers are stored verbatim, so bound them here rather
// than only truthiness-checking them. Real YouTube ids are 11 chars; the caps
// below leave slack without accepting multi-KB junk.

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_CHANNEL_ID_LENGTH = 64;
const MAX_CLIENT_ID_LENGTH = 128;
const MAX_REASON_LENGTH = 500;

function isValidVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_RE.test(value);
}

function isValidClientId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CLIENT_ID_LENGTH;
}

// channelId and reason are optional: absent/empty is fine, oversized is not.
function isValidOptionalString(value, maxLength) {
  if (value === undefined || value === null || value === '') return true;
  return typeof value === 'string' && value.length <= maxLength;
}

// decodeURIComponent throws URIError on a malformed escape (e.g. "/score/%");
// treat an undecodable segment as a literal one rather than a 500.
function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch (e) {
    return str;
  }
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

async function hashIp(ip, salt) {
  const enc = new TextEncoder().encode(ip + salt);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function checkRateLimit(env, ip) {
  const ipHash = await hashIp(ip, env.IP_SALT || 'dev-salt-change-me');
  const windowStart = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  const row = await env.DB.prepare('SELECT count FROM rate_limit WHERE ip_hash = ? AND window_start = ?')
    .bind(ipHash, windowStart)
    .first();
  const count = row ? row.count : 0;
  if (count >= RATE_LIMIT_MAX_PER_WINDOW) return false;
  await env.DB.prepare(
    `INSERT INTO rate_limit (ip_hash, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(ip_hash, window_start) DO UPDATE SET count = count + 1`
  )
    .bind(ipHash, windowStart)
    .run();
  return true;
}

async function isBlocklisted(env, videoId) {
  const row = await env.DB.prepare('SELECT video_id FROM blocklist WHERE video_id = ?').bind(videoId).first();
  return !!row;
}

async function handleGetScore(env, videoId) {
  if (await isBlocklisted(env, videoId)) {
    return json({ videoId, blocked: true, aiVotes: 0, humanVotes: 0, total: 0, communityScore: null });
  }
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN vote = 'ai' THEN 1 ELSE 0 END) AS ai_votes,
       SUM(CASE WHEN vote = 'human' THEN 1 ELSE 0 END) AS human_votes
     FROM votes WHERE video_id = ?`
  )
    .bind(videoId)
    .first();
  const aiVotes = (row && row.ai_votes) || 0;
  const humanVotes = (row && row.human_votes) || 0;
  const total = aiVotes + humanVotes;
  return json({
    videoId,
    blocked: false,
    aiVotes,
    humanVotes,
    total,
    communityScore: total > 0 ? Math.round((aiVotes / total) * 100) : null,
  });
}

async function handlePostVote(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const allowed = await checkRateLimit(env, ip);
  if (!allowed) return json({ error: 'rate limited' }, 429);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid json' }, 400);
  }
  const { videoId, channelId, vote, clientId } = body || {};
  if (!isValidVideoId(videoId) || !isValidClientId(clientId) || (vote !== 'ai' && vote !== 'human')) {
    return json({ error: 'videoId, clientId, and vote ("ai"|"human") are required' }, 400);
  }
  if (!isValidOptionalString(channelId, MAX_CHANNEL_ID_LENGTH)) {
    return json({ error: `channelId must be at most ${MAX_CHANNEL_ID_LENGTH} characters` }, 400);
  }

  if (await isBlocklisted(env, videoId)) {
    return json({ error: 'video is blocklisted' }, 403);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO votes (video_id, channel_id, vote, client_id, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(video_id, client_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`
    )
      .bind(videoId, channelId || null, vote, clientId, Date.now())
      .run();
  } catch (e) {
    return json({ error: 'write failed' }, 500);
  }
  return handleGetScore(env, videoId);
}

function checkAdmin(request, env) {
  // Fail closed: with no ADMIN_TOKEN configured, comparing against '' would
  // let a request with no header at all through.
  const expected = env.ADMIN_TOKEN;
  if (typeof expected !== 'string' || expected.length === 0) return false;
  return timingSafeEqual(request.headers.get('x-admin-token') || '', expected);
}

async function handleAddBlocklist(request, env) {
  if (!checkAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid json' }, 400);
  }
  const { videoId, reason } = body || {};
  if (!isValidVideoId(videoId)) return json({ error: 'videoId is required' }, 400);
  if (!isValidOptionalString(reason, MAX_REASON_LENGTH)) {
    return json({ error: `reason must be at most ${MAX_REASON_LENGTH} characters` }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO blocklist (video_id, reason, created_at) VALUES (?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at`
  )
    .bind(videoId, reason || null, Date.now())
    .run();
  return json({ ok: true, videoId });
}

async function handleRemoveBlocklist(request, env, videoId) {
  if (!checkAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
  if (!videoId) return json({ error: 'videoId is required' }, 400);
  await env.DB.prepare('DELETE FROM blocklist WHERE video_id = ?').bind(videoId).run();
  return json({ ok: true, videoId });
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, x-admin-token',
      },
    });
  }
  if (request.method === 'GET' && url.pathname.startsWith('/score/')) {
    return handleGetScore(env, safeDecode(url.pathname.slice('/score/'.length)));
  }
  if (request.method === 'POST' && url.pathname === '/admin/blocklist') {
    return handleAddBlocklist(request, env);
  }
  if (request.method === 'DELETE' && url.pathname.startsWith('/admin/blocklist/')) {
    return handleRemoveBlocklist(request, env, safeDecode(url.pathname.slice('/admin/blocklist/'.length)));
  }
  if (request.method === 'POST' && url.pathname === '/vote') {
    return handlePostVote(request, env);
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    // Every error path returns JSON + CORS; an uncaught throw would not, so
    // catch anything unexpected here rather than letting the runtime 500.
    try {
      return await route(request, env);
    } catch (e) {
      // Swallowing the throw would otherwise also swallow it from the logs.
      console.error('unhandled error', (e && e.stack) || e);
      return json({ error: 'internal error' }, 500);
    }
  },
};

export { timingSafeEqual };
