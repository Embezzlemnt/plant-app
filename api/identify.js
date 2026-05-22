const MAX_PHOTO_CHARS = 7_200_000;
const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

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

function supportedPhoto(photo) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(photo || '');
  return !!match && ALLOWED_PHOTO_TYPES.has(match[1].toLowerCase()) && photo.length <= MAX_PHOTO_CHARS;
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  allowSameOrigin(req, res);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', name: null });
  if (process.env.ENABLE_PLANT_IDENTIFY !== '1') {
    return res.status(404).json({ error: 'Plant identification is disabled', name: null });
  }
  if (!process.env.PLANTID_API_KEY) {
    return res.status(503).json({ error: 'Plant identification is not configured', name: null });
  }

  const { photo } = parseBody(req.body);
  if (!photo) return res.status(400).json({ error: 'No photo provided', name: null });
  if (!supportedPhoto(photo)) {
    return res.status(400).json({ error: 'Use a JPG, PNG, WEBP, GIF, or HEIC photo under 5 MB', name: null });
  }

  try {
    const response = await fetch(
      'https://plant.id/api/v3/identification?details=common_names,watering,best_light_condition,description&language=en',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Key': process.env.PLANTID_API_KEY
        },
        body: JSON.stringify({ images: [photo], similar_images: false })
      }
    );
    const data = await response.json().catch(() => ({}));
    if (response.status === 429) return res.status(429).json({ name: null, error: 'rate_limit' });
    if (!response.ok) return res.status(502).json({ name: null, error: 'Identification is unavailable right now' });

    if (!data.result?.is_plant?.binary) return res.status(200).json({ name: null, reason: 'not_a_plant' });
    const top = data.result?.classification?.suggestions?.[0];
    if (!top) return res.status(200).json({ name: null, reason: 'no_suggestions' });

    const details = top.details || {};
    const name = details.common_names?.[0] || top.name || null;
    if (!name) return res.status(200).json({ name: null });

    const waterMin = details.watering?.min ?? 2;
    const waterMax = details.watering?.max ?? 4;
    const timesPerMonth = (waterMin + waterMax) / 2;
    const waterEveryRaw = Math.round(30 / Math.max(timesPerMonth, 0.5));
    const validWaterIntervals = [1, 2, 3, 5, 7, 10, 14, 21, 30];
    const waterEvery = validWaterIntervals.reduce((a, b) =>
      Math.abs(b - waterEveryRaw) < Math.abs(a - waterEveryRaw) ? b : a
    );

    const lightRaw = String(details.best_light_condition || '').toLowerCase();
    let light = 'indirect';
    if (lightRaw.includes('full sun') || lightRaw.includes('direct')) light = 'direct window';
    else if (lightRaw.includes('bright')) light = 'bright indirect';
    else if (lightRaw.includes('low') || lightRaw.includes('shade')) light = 'low light';

    const descText = String(details.description?.value || '').toLowerCase();
    const combined = name.toLowerCase() + ' ' + descText;
    let type = 'other';
    if (/succulent|aloe|echeveria|sedum|haworthia|crassula/.test(combined)) type = 'succulent';
    else if (/cactus|cacti/.test(combined)) type = 'cactus';
    else if (/fern/.test(combined)) type = 'fern';
    else if (/basil|mint|rosemary|thyme|cilantro|parsley|oregano|herb/.test(combined)) type = 'herb';
    else if (/tropical|palm|monstera|philodendron|pothos|calathea|dracaena/.test(combined)) type = 'tropical';
    else if (/vine|ivy|climbing/.test(combined)) type = 'vine';
    else if (/grass|bamboo/.test(combined)) type = 'grass';
    else if (/tree|shrub/.test(combined)) type = 'tree';
    else if (/flower|bloom|rose|orchid|lily|daisy|tulip|petunia/.test(combined)) type = 'flowering';

    let notes = '';
    if (details.description?.value) {
      const sentence = details.description.value
        .split(/[.!?]/)
        .map(s => s.trim())
        .find(s => s.length > 10 && s.length < 80);
      if (sentence) notes = sentence + '.';
    }

    return res.status(200).json({ name, type, waterEvery, light, notes });
  } catch {
    return res.status(502).json({ name: null, error: 'Identification is unavailable right now' });
  }
}
