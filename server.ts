import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateJathagam } from './server/astrology/jathagamEngine';
import { runAllAstrologyTests } from './server/tests/astrologyTests';
import { explainStructuredAstrology } from './server/astrology/aiExplainer';
import { BirthDetails } from './src/types/jathagam';
import { COMPREHENSIVE_PLACES } from './src/data/places.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware
  app.use(express.json());

  // ================= API Endpoints =================

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'Tamil Jathagam Calculator' });
  });

  // Automated astrology calculation test suite
  app.get('/api/test-results', (req, res) => {
    try {
      const results = runAllAstrologyTests();
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  function estimateTimezone(countryCode?: string, lon: number = 0): number {
  if (!countryCode) {
    return Math.round((lon / 15.0) * 2) / 2;
  }
  const code = countryCode.toLowerCase();
  if (code === 'in' || code === 'lk') return 5.5;
  if (code === 'sg' || code === 'my') return 8.0;
  if (code === 'ae' || code === 'om') return 4.0;
  if (code === 'qa' || code === 'kw' || code === 'sa' || code === 'bh') return 3.0;
  if (code === 'gb') return 0.0;
  if (code === 'fr' || code === 'de' || code === 'ch' || code === 'it') return 1.0;
  if (code === 'mu' || code === 're') return 4.0;
  if (code === 'za') return 2.0;
  if (code === 'nz') return 12.0;
  if (code === 'us' || code === 'ca') {
    if (lon < -115) return -8.0;
    if (lon < -100) return -7.0;
    if (lon < -85) return -6.0;
    return -5.0;
  }
  if (code === 'au') {
    if (lon > 140) return 10.0;
    if (lon > 125) return 9.5;
    return 8.0;
  }
  return Math.round((lon / 15.0) * 2) / 2;
}

// Global Place Search & Geocoding API
app.get('/api/geocode', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q || q.length < 2) {
      return res.json({ results: [] });
    }

    const lowerQ = q.toLowerCase();

    // 1. Search in local comprehensive places catalog
    const localMatches = COMPREHENSIVE_PLACES.filter((p) => {
      return (
        p.name.toLowerCase().includes(lowerQ) ||
        p.tamilName.includes(q) ||
        (p.district && p.district.toLowerCase().includes(lowerQ)) ||
        (p.stateOrCountry && p.stateOrCountry.toLowerCase().includes(lowerQ)) ||
        (p.keywords && p.keywords.some((k) => k.toLowerCase().includes(lowerQ)))
      );
    }).slice(0, 8);

    const formattedLocal = localMatches.map((p) => ({
      id: p.id,
      name: p.name,
      tamilName: p.tamilName,
      district: p.district || '',
      stateOrCountry: p.stateOrCountry,
      latitude: p.latitude,
      longitude: p.longitude,
      timezone: p.timezone,
      source: 'catalog' as const,
    }));

    // If we have sufficient local matches, return them immediately
    if (formattedLocal.length >= 6) {
      return res.json({ results: formattedLocal });
    }

    // 2. Query Nominatim for global locations or smaller villages/taluks
    let nominatimResults: any[] = [];
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const nomRes = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
          q
        )}&limit=6&addressdetails=1`,
        {
          signal: controller.signal,
          headers: {
            'User-Agent': 'TamilJathagamApp/1.0 (Astrology Ephemeris Calculator)',
            'Accept-Language': 'en,ta',
          },
        }
      );
      clearTimeout(timeoutId);

      if (nomRes.ok) {
        const data: any = await nomRes.json();
        nominatimResults = (data || []).map((item: any) => {
          const lat = parseFloat(item.lat);
          const lon = parseFloat(item.lon);
          const addr = item.address || {};
          const countryCode = addr.country_code;
          const country = addr.country || '';
          const state = addr.state || addr.county || '';
          const city =
            addr.city ||
            addr.town ||
            addr.village ||
            addr.municipality ||
            addr.suburb ||
            item.display_name.split(',')[0];
          const tz = estimateTimezone(countryCode, lon);

          return {
            id: `geo-${item.place_id}`,
            name: city,
            tamilName: city,
            district: state,
            stateOrCountry: [state, country].filter(Boolean).join(', '),
            latitude: Number(lat.toFixed(6)),
            longitude: Number(lon.toFixed(6)),
            timezone: tz,
            source: 'global' as const,
          };
        });
      }
    } catch {
      // Fallback silently if Nominatim network request times out
    }

    // Merge and deduplicate by proximity
    const combined = [...formattedLocal];
    for (const nr of nominatimResults) {
      const isDuplicate = combined.some(
        (c) =>
          Math.abs(c.latitude - nr.latitude) < 0.05 &&
          Math.abs(c.longitude - nr.longitude) < 0.05
      );
      if (!isDuplicate) {
        combined.push(nr);
      }
    }

    return res.json({ results: combined.slice(0, 10) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Geocoding failed' });
  }
});

// Primary Jathagam Calculation API
app.post('/api/jathagam', (req, res) => {
  try {
    const body = req.body;

    // Validation
    if (!body.name || typeof body.name !== 'string') {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!body.dateOfBirth || !/^\d{4}-\d{2}-\d{2}$/.test(body.dateOfBirth)) {
      return res.status(400).json({
        error: 'Valid Date of Birth is required in YYYY-MM-DD format',
      });
    }
    if (!body.timeOfBirth || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(body.timeOfBirth)) {
      return res.status(400).json({
        error: 'Valid Exact Time of Birth is required in HH:mm or HH:mm:ss format',
      });
    }
    if (
      body.latitude === undefined ||
      isNaN(Number(body.latitude)) ||
      Number(body.latitude) < -90 ||
      Number(body.latitude) > 90
    ) {
      return res.status(400).json({
        error: 'Valid Latitude between -90 and 90 is required',
      });
    }
    if (
      body.longitude === undefined ||
      isNaN(Number(body.longitude)) ||
      Number(body.longitude) < -180 ||
      Number(body.longitude) > 180
    ) {
      return res.status(400).json({
        error: 'Valid Longitude between -180 and 180 is required',
      });
    }
    if (
      body.timezone === undefined ||
      isNaN(Number(body.timezone)) ||
      Number(body.timezone) < -12 ||
      Number(body.timezone) > 14
    ) {
      return res.status(400).json({
        error: 'Valid Timezone offset between -12 and +14 is required',
      });
    }

    const birthDetails: BirthDetails = {
      name: body.name.trim(),
      gender: body.gender || 'Other',
      dateOfBirth: body.dateOfBirth,
      timeOfBirth: body.timeOfBirth,
      birthPlace: body.birthPlace ? body.birthPlace.trim() : 'Location',
      latitude: Number(body.latitude),
      longitude: Number(body.longitude),
      timezone: Number(body.timezone),
      ayanamsa: body.ayanamsa || 'Lahiri',
    };

    const jathagam = calculateJathagam(birthDetails);
    return res.json({ success: true, data: jathagam });
    } catch (err: any) {
      console.error('Jathagam calculation error:', err);
      return res.status(500).json({
        error: err.message || 'Astronomical calculation failed',
      });
    }
  });

  // AI Interpretation Explainer (Strictly transforms already-calculated structured factors)
  app.post('/api/interpret-ai', async (req, res) => {
    try {
      const summary = await explainStructuredAstrology(req.body);
      res.json({ success: true, explanation: summary });
    } catch (err: any) {
      console.error('AI Interpretation error:', err);
      res.status(500).json({
        error: err.message || 'Could not synthesize reading',
      });
    }
  });

  // ================= Vite Middleware / Static Serving =================

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Tamil Jathagam server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
