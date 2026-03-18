// Model cascade — tries each in order until one works
const MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-lite-001'
];

async function callGemini(apiKey, model, payload) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  );
  const data = await res.json();
  return { status: res.status, data };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const apiKey = process.env.GEMINI_API_KEY;
  console.log('[chat] API key present:', !!process.env.GEMINI_API_KEY, 'starts with:', process.env.GEMINI_API_KEY?.slice(0,8));
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { system, messages, max_tokens, photo } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages payload' });
    }

    // Deduplicate consecutive same-role messages — Gemini rejects them
    const deduped = [];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (deduped.length > 0 && deduped[deduped.length - 1].role === role) {
        deduped[deduped.length - 1].parts[0].text += '\n' + (m.content || '');
      } else {
        deduped.push({ role, parts: [{ text: m.content || '' }] });
      }
    }

    // Attach photo to last user message if provided
    if (photo && deduped.length > 0) {
      const last = deduped[deduped.length - 1];
      if (last.role === 'user') {
        const base64 = photo.replace(/^data:image\/\w+;base64,/, '');
        const mimeType = photo.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
        last.parts.unshift({ inline_data: { mime_type: mimeType, data: base64 } });
      }
    }

    // Gemini requires conversation to start with user role
    if (deduped.length === 0 || deduped[0].role !== 'user') {
      return res.status(400).json({ error: 'Conversation must start with user message' });
    }

    const payload = {
      system_instruction: { parts: [{ text: system || '' }] },
      contents: deduped,
      generationConfig: { temperature: 0.7, maxOutputTokens: max_tokens || 1000 }
    };

    // Try each model in order until one succeeds
    let lastError = null;
    for (const model of MODELS) {
      try {
        const { status, data } = await callGemini(apiKey, model, payload);

        // Skip model if not found or not supported
        if (status === 404 || (data.error?.status === 'NOT_FOUND')) {
console.log(`Model ${model} not available:`, JSON.stringify(data.error));
          continue;
        }

        // Rate limit — don't try other models, just return error
        if (status === 429 || data.error?.code === 429) {
          console.error('Gemini rate limit hit:', data.error);
          return res.status(429).json({
            error: 'rate_limit',
            content: [{ type: 'text', text: "I'm a little busy right now 🌱 wait a moment and try again!" }]
          });
        }

        if (data.error) {
          console.error(`Gemini error on ${model}:`, data.error);
          lastError = data.error.message;
          continue;
        }

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!text) {
          lastError = 'Empty response from model';
          continue;
        }

        console.log(`Success with model: ${model}`);
        return res.status(200).json({ content: [{ type: 'text', text }] });

      } catch (fetchErr) {
        console.error(`Fetch error on model ${model}:`, fetchErr.message);
        lastError = fetchErr.message;
        continue;
      }
    }

    // All models failed
    console.error('All models failed. Last error:', lastError);
    return res.status(500).json({
      error: lastError || 'All models unavailable',
      content: [{ type: 'text', text: "Couldn't get a response right now 🌱 try again in a moment!" }]
    });

  } catch (err) {
    console.error('Chat handler error:', err);
    return res.status(500).json({
      error: err.message,
      content: [{ type: 'text', text: "Something went wrong — try again!" }]
    });
  }
}
