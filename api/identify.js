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

  const apiKey = process.env.PLANTID_API_KEY;
  if (!apiKey) {
    console.error('[identify] PLANTID_API_KEY not set in environment');
    return res.status(500).json({ error: 'API key not configured', name: null });
  }

  const { photo } = req.body;
  if (!photo) {
    console.error('[identify] No photo in request body');
    return res.status(400).json({ error: 'No photo provided', name: null });
  }

  // Validate it's a base64 image
  if (!photo.startsWith('data:image/')) {
    console.error('[identify] Invalid photo format — expected base64 data URL');
    return res.status(400).json({ error: 'Invalid photo format', name: null });
  }

  try {
    console.log('[identify] Sending request to Plant.id...');

    const response = await fetch(
      'https://plant.id/api/v3/identification?details=common_names,watering,best_light_condition,description&language=en',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Key': apiKey
        },
        body: JSON.stringify({
          images: [photo],
          similar_images: false
        })
      }
    );

    const data = await response.json();

    // Log full response for debugging
    console.log('[identify] Plant.id status:', response.status);
    console.log('[identify] Plant.id response keys:', Object.keys(data));

    if (!response.ok) {
      console.error('[identify] Plant.id HTTP error:', response.status, data);
      // Rate limit
      if (response.status === 429) {
        return res.status(429).json({ name: null, error: 'rate_limit' });
      }
      return res.status(500).json({ name: null, error: data.message || 'Identification failed' });
    }

    // Check if it's actually a plant
    const isPlant = data.result?.is_plant?.binary;
    const isPlantProb = data.result?.is_plant?.probability || 0;
    console.log('[identify] Is plant:', isPlant, 'probability:', isPlantProb);

    if (!isPlant) {
      console.log('[identify] Image does not appear to be a plant');
      return res.status(200).json({ name: null, reason: 'not_a_plant' });
    }

    const suggestions = data.result?.classification?.suggestions;
    if (!suggestions || !suggestions.length) {
      console.log('[identify] No suggestions returned');
      return res.status(200).json({ name: null, reason: 'no_suggestions' });
    }

    const top = suggestions[0];
    const details = top.details || {};
    console.log('[identify] Top suggestion:', top.name, 'probability:', top.probability);

    // Common name — prefer common_names array, fall back to scientific name
    const name = details.common_names?.[0] || top.name || null;
    if (!name) {
      console.log('[identify] No name found in top suggestion');
      return res.status(200).json({ name: null });
    }

    // Map watering — Plant.id returns min/max times per month
    const waterMin = details.watering?.min ?? 2;
    const waterMax = details.watering?.max ?? 4;
    const timesPerMonth = (waterMin + waterMax) / 2;
    const waterEveryRaw = Math.round(30 / Math.max(timesPerMonth, 0.5));
    const validOptions = [1, 2, 3, 5, 7, 10, 14, 21, 30];
    const waterEvery = validOptions.reduce((a, b) =>
      Math.abs(b - waterEveryRaw) < Math.abs(a - waterEveryRaw) ? b : a
    );
    console.log('[identify] Watering: times/month=', timesPerMonth, '→ every', waterEvery, 'days');

    // Map light condition
    const lightRaw = (details.best_light_condition || '').toLowerCase();
    let light = 'indirect';
    if (lightRaw.includes('full sun') || lightRaw.includes('direct')) light = 'direct window';
    else if (lightRaw.includes('bright')) light = 'bright indirect';
    else if (lightRaw.includes('low') || lightRaw.includes('shade')) light = 'low light';
    console.log('[identify] Light:', lightRaw, '→', light);

    // Derive type from name and description text
    const descText = (details.description?.value || '').toLowerCase();
    const nameLower = name.toLowerCase();
    const combined = nameLower + ' ' + descText;
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
    console.log('[identify] Type derived:', type);

    // Short care note from description — first sentence under 80 chars
    let notes = '';
    if (details.description?.value) {
      const sentences = details.description.value
        .split(/[.!?]/)
        .map(s => s.trim())
        .filter(s => s.length > 10 && s.length < 80);
      if (sentences[0]) notes = sentences[0] + '.';
    }

    const result = { name, type, waterEvery, light, notes };
    console.log('[identify] Final result:', result);
    return res.status(200).json(result);

  } catch (err) {
    console.error('[identify] Handler error:', err.message, err.stack);
    return res.status(500).json({ name: null, error: err.message });
  }
}
