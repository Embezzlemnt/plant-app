export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { photo } = req.body;
  if (!photo) return res.status(400).json({ error: 'No photo provided' });

  const base64 = photo.replace(/^data:image\/\w+;base64,/, '');
  const mimeType = photo.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                inline_data: { mime_type: mimeType, data: base64 }
              },
              {
                text: `Identify this plant. Respond ONLY with a valid JSON object, no markdown, no extra text:
{
  "name": "common plant name",
  "type": "category like succulent / tropical / herb / fern / flowering etc",
  "waterEvery": <integer days between watering>,
  "light": "<one of: low light / indirect / bright indirect / direct window>",
  "notes": "<one short helpful care tip>"
}
If you cannot identify the plant, return: {"name": null}`
              }
            ]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 256 }
        })
      }
    );

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: 'Identification failed', name: null });
  }
}
