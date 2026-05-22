const MODEL = 'gemini-2.5-flash-lite';
const MAX_MESSAGES = 20;
const MAX_TEXT_CHARS = 6000;
const MAX_PHOTO_CHARS = 7_200_000;
const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_WINDOW = 18;
const requestWindows = globalThis.__plantChatRequestWindows || new Map();
globalThis.__plantChatRequestWindows = requestWindows;

function allowSameOrigin(req, res) {
  const origin = req.headers?.origin;
  const host = req.headers?.host;
  if (!origin || !host) return;
  try {
    if (new URL(origin).host === host) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  } catch {}
}

function send(req, res, status, data) {
  res.status(status).setHeader('Content-Type', 'application/json');
  allowSameOrigin(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(data));
}

function textContent(text) {
  return { content: [{ type: 'text', text }] };
}

function clientKey(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(req) {
  const now = Date.now();
  const key = clientKey(req);
  const current = requestWindows.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    requestWindows.set(key, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  if (requestWindows.size > 500) {
    for (const [bucketKey, bucket] of requestWindows) {
      if (now - bucket.startedAt >= RATE_WINDOW_MS) requestWindows.delete(bucketKey);
    }
  }
  return current.count > RATE_LIMIT_PER_WINDOW;
}

function dedupeConsecutive(messages = []) {
  const out = [];
  const recentMessages = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES) : [];
  for (const msg of recentMessages) {
    if (!msg || !msg.role) continue;
    const content = typeof msg.content === 'string' ? msg.content.trim().slice(0, MAX_TEXT_CHARS) : '';
    if (!content) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role) {
      if (prev.content !== content) prev.content += `\n${content}`;
      continue;
    }
    out.push({ role: msg.role, content });
  }
  return out;
}

function toGeminiPart(message) {
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }]
  };
}

function photoPart(photo) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(photo || '');
  if (!match || !ALLOWED_PHOTO_TYPES.has(match[1].toLowerCase())) return null;
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(req, res, 200, {});
  if (req.method !== 'POST') return send(req, res, 200, textContent('Use POST to ask a plant question.'));

  try {
    if (isRateLimited(req)) {
      return send(req, res, 200, textContent('Plant advisor is busy for a minute. Try again soon.'));
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const { system = '', messages = [], max_tokens = 1000, photo = null } = body;
    const systemText = typeof system === 'string' ? system.slice(0, MAX_TEXT_CHARS) : '';
    const key = process.env.GEMINI_API_KEY;
    if (!key) return send(req, res, 200, textContent('Plant advisor is not configured yet.'));
    if (typeof photo === 'string' && photo.length > MAX_PHOTO_CHARS) {
      return send(req, res, 200, textContent('That photo is too large. Try a smaller image.'));
    }
    if (photo && !photoPart(photo)) {
      return send(req, res, 200, textContent('Use a JPG, PNG, WEBP, GIF, or HEIC plant photo.'));
    }

    const cleanMessages = dedupeConsecutive(messages);
    if (!cleanMessages.length && !photo) {
      return send(req, res, 200, textContent('Ask me a plant question first.'));
    }

    if (photo) {
      const part = photoPart(photo);
      if (part) {
        let lastUser = cleanMessages.length - 1;
        while (lastUser >= 0 && cleanMessages[lastUser].role !== 'user') lastUser--;
        if (lastUser < 0) {
          cleanMessages.push({ role: 'user', content: 'Please look at this plant photo.' });
          lastUser = cleanMessages.length - 1;
        }
        const content = toGeminiPart(cleanMessages[lastUser]);
        content.parts.push(part);
        cleanMessages[lastUser] = content;
      }
    }

    const contents = cleanMessages.map(m => m.parts ? m : toGeminiPart(m));
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
        contents,
        generationConfig: { maxOutputTokens: Math.min(Number(max_tokens) || 1000, 1200) }
      })
    });

    if (response.status === 429) {
      return send(req, res, 200, textContent('too many requests — try again in a moment 🌱'));
    }

    if (!response.ok) {
      const upstream = await response.json().catch(() => ({}));
      const upstreamText = String(upstream?.error?.message || '').toLowerCase();
      if (upstreamText.includes('leaked') || upstreamText.includes('api key') || response.status === 401 || response.status === 403) {
        return send(req, res, 200, textContent('Plant advisor needs a fresh server key before it can answer again.'));
      }
      return send(req, res, 200, textContent('Plant advisor is resting for a moment. Try again soon 🌱'));
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n').trim();
    return send(req, res, 200, textContent(text || 'I could not read that clearly. Try asking again with a little more detail.'));
  } catch {
    return send(req, res, 200, textContent('Plant advisor had a hiccup. Try again in a moment 🌿'));
  }
}
