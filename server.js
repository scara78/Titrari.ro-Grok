const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const express = require('express');

// ... restul codului tău rămâne IDENTIC ...

const app = express();

/**
 * ATAȘĂM ADDONUL STREMIO LA EXPRESS
 * (asta expune /manifest.json și /subtitles/*)
 */
serveHTTP(builder.getInterface(), { app });

/**
 * ENDPOINT SRT – FUNCȚIONAL
 */
app.get('/subtitle/:id.srt', async (req, res) => {
  const { id } = req.params;
  const { season, episode } = req.query;

  const srt = await getSrt(id, season || null, episode || null);
  if (!srt) {
    res.status(404).send('');
    return;
  }

  res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(srt);
});

app.get('/health', (_, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`Addon ready: ${BASE_URL}/manifest.json`);
});




