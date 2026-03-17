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
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { system, messages, max_tokens, photo } = req.body;

    // Deduplicate consecutive same-role messages — Gemini rejects them
    const deduped = [];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (deduped.length > 0 && deduped[deduped.length - 1].role === role) {
        // Merge into previous message
        deduped[deduped.length - 1].parts[0].text += '\n' + m.content;
      } else {
        deduped.push({ role, parts: [{ text: m.content }] });
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

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: deduped,
          generationConfig: { temperature: 0.7, maxOutputTokens: max_tokens || 1000 }
        })
      }
    );

    const data = await response.json();

    if (data.error) {
      console.error('Gemini error:', data.error);
      return res.status(500).json({ error: data.error.message, content: [{ type: 'text', text: "I'm having trouble connecting right now 🌱 Try again in a moment!" }] });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
      || "Sorry, I couldn't get an answer right now. Try again!";

    return res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (err) {
    console.error('Chat handler error:', err);
    return res.status(500).json({ error: err.message, content: [{ type: 'text', text: "Something went wrong — try again!" }] });
  }
}
