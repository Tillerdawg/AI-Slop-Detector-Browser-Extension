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

const VOTE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// --- base64url + HMAC vote-token helpers -----------------------------------

function base64UrlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSign(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(sig));
}

async function mintVoteToken(clientId, secret) {
  const exp = Date.now() + VOTE_TOKEN_TTL_MS;
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ clientId, exp })));
  const sig = await hmacSign(payload, secret);
  return { token: `${payload}.${sig}`, expiresAt: exp };
}

async function verifyVoteToken(token, clientId, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expectedSig = await hmacSign(payload, secret);
  if (!timingSafeEqual(sig, expectedSig)) return false;
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch (e) {
    return false;
  }
  if (!parsed || parsed.clientId !== clientId) return false;
  if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return false;
  return true;
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
  if (!videoId || !clientId || (vote !== 'ai' && vote !== 'human')) {
    return json({ error: 'videoId, clientId, and vote ("ai"|"human") are required' }, 400);
  }

  const voteToken = request.headers.get('x-vote-token');
  const validToken = await verifyVoteToken(voteToken, clientId, env.VOTE_TOKEN_SECRET || '');
  if (!validToken) return json({ error: 'not verified' }, 401);

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

async function handleVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid json' }, 400);
  }
  const { turnstileToken, clientId } = body || {};
  if (!turnstileToken || !clientId) {
    return json({ error: 'turnstileToken and clientId are required' }, 400);
  }

  const verifyUrl = env.TURNSTILE_VERIFY_URL || TURNSTILE_VERIFY_URL;
  let verifyResult;
  try {
    const resp = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: turnstileToken }),
    });
    verifyResult = await resp.json();
  } catch (e) {
    return json({ error: 'turnstile verification unreachable' }, 502);
  }
  if (!verifyResult || !verifyResult.success) {
    return json({ error: 'turnstile verification failed' }, 403);
  }

  const { token, expiresAt } = await mintVoteToken(clientId, env.VOTE_TOKEN_SECRET || '');
  return json({ voteToken: token, expiresAt });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type, x-vote-token, x-admin-token',
        },
      });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/score/')) {
      return handleGetScore(env, decodeURIComponent(url.pathname.slice('/score/'.length)));
    }
    if (request.method === 'POST' && url.pathname === '/verify') {
      return handleVerify(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/vote') {
      return handlePostVote(request, env);
    }
    return json({ error: 'not found' }, 404);
  },
};

export { base64UrlEncode, base64UrlDecode, hmacSign, mintVoteToken, verifyVoteToken, timingSafeEqual };
