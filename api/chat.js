export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { system, messages, max_tokens, photo } = req.body;

    // Build Gemini message history
    const geminiMessages = messages.map((m, i) => {
      const isLast = i === messages.length - 1;
      // If there's a photo, attach it to the last user message
      if (photo && isLast && m.role === 'user') {
        const base64 = photo.replace(/^data:image\/\w+;base64,/, '');
        const mimeType = photo.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
        return {
          role: 'user',
          parts: [
            { inline_data: { mime_type: mimeType, data: base64 } },
            { text: m.content }
          ]
        };
      }
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      };
    });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: geminiMessages,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: max_tokens || 1000
          }
        })
      }
    );

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
      || "Sorry, I couldn't get an answer right now. Try again!";

    return res.status(200).json({
      content: [{ type: 'text', text }]
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach AI' });
  }
}
