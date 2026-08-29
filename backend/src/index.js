/**
 * Scaffold Cloudflare Worker for the future community-ratings layer.
 * NOT wired into the extension yet -- see backend/README.md for the plan.
 *
 * Endpoints:
 *   GET  /score/:videoId          -> aggregated vote counts for a video
 *   POST /vote {videoId, channelId, vote, clientId}
 *                                  -> record one anonymous vote
 *
 * Deliberately minimal: no auth, no accounts. Abuse resistance is limited to
 * (a) one vote per (videoId, clientId) via a DB primary key, and (b) a crude
 * per-IP-hash rate limit. A real deployment should add at least CAPTCHA-free
 * bot filtering (e.g. Cloudflare Turnstile) before taking this beyond a
 * personal/small-community scale.
 */

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 20;

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

async function handleGetScore(env, videoId) {
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
  if (!videoId || !clientId || (vote !== 'ai' && vote !== 'human')) {
    return json({ error: 'videoId, clientId, and vote ("ai"|"human") are required' }, 400);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/score/')) {
      return handleGetScore(env, decodeURIComponent(url.pathname.slice('/score/'.length)));
    }
    if (request.method === 'POST' && url.pathname === '/vote') {
      return handlePostVote(request, env);
    }
    return json({ error: 'not found' }, 404);
  },
};
