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
  if (!apiKey) return res.status(500).json({ error: 'API key not configured', name: null });

  const { photo } = req.body;
  if (!photo) return res.status(400).json({ error: 'No photo provided', name: null });

  const base64 = photo.replace(/^data:image\/\w+;base64,/, '');
  const mimeType = photo.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType, data: base64 } },
              { text: `You are a plant identification expert. Look at this image carefully.

Respond with ONLY a raw JSON object. No markdown fences, no explanation, no extra text. Just the JSON.

{
  "name": "common plant name in English",
  "type": "one of: succulent, tropical, herb, fern, flowering, cactus, tree, vine, grass, other",
  "waterEvery": 7,
  "light": "one of: low light, indirect, bright indirect, direct window",
  "notes": "one helpful care tip under 15 words"
}

If you cannot identify a plant in the image, respond with exactly: {"name":null}` }
            ]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 300 }
        })
      }
    );

    const data = await response.json();

    if (data.error) {
      console.error('Gemini identify error:', data.error);
      return res.status(500).json({ name: null, error: data.error.message });
    }

    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Robust JSON extraction — handles markdown fences, extra text, whitespace
    let parsed = null;
    const attempts = [
      raw.trim(),
      raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim(),
      (raw.match(/\{[\s\S]*\}/) || [''])[0],
    ];

    for (const attempt of attempts) {
      try {
        parsed = JSON.parse(attempt);
        break;
      } catch (_) {}
    }

    if (!parsed) {
      console.error('Could not parse Gemini response:', raw);
      return res.status(200).json({ name: null });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Identify handler error:', err);
    return res.status(500).json({ name: null, error: err.message });
  }
}
