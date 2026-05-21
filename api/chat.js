const MODEL = 'gemini-2.0-flash-lite';

function send(res, status, data) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(data));
}

function textContent(text) {
  return { content: [{ type: 'text', text }] };
}

function dedupeConsecutive(messages = []) {
  const out = [];
  for (const msg of messages) {
    if (!msg || !msg.role) continue;
    const content = typeof msg.content === 'string' ? msg.content.trim() : '';
    if (!content) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role && prev.content === content) continue;
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
  if (!match) return null;
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 200, {});
  if (req.method !== 'POST') return send(res, 200, textContent('Use POST to ask a plant question.'));

  try {
    const { system = '', messages = [], max_tokens = 1000, photo = null } = req.body || {};
    const key = process.env.GEMINI_API_KEY;
    if (!key) return send(res, 200, textContent('Plant advisor is not configured yet.'));

    const cleanMessages = dedupeConsecutive(messages);
    if (!cleanMessages.length && !photo) {
      return send(res, 200, textContent('Ask me a plant question first.'));
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
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        generationConfig: { maxOutputTokens: Math.min(Number(max_tokens) || 1000, 1200) }
      })
    });

    if (response.status === 429) {
      return send(res, 200, textContent('too many requests — try again in a moment 🌱'));
    }

    if (!response.ok) {
      return send(res, 200, textContent('Plant advisor is resting for a moment. Try again soon 🌱'));
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n').trim();
    return send(res, 200, textContent(text || 'I could not read that clearly. Try asking again with a little more detail.'));
  } catch {
    return send(res, 200, textContent('Plant advisor had a hiccup. Try again in a moment 🌿'));
  }
}
