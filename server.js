// server.js – Titrari.ro Stremio Addon FINAL
const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const AdmZip = require('adm-zip');
const { createExtractorFromData } = require('node-unrar-js');
const express = require('express');

const PORT = process.env.PORT || 7000;
const BASE_URL =
  process.env.RENDER_EXTERNAL_URL ||
  `https://${process.env.RENDER_SERVICE_NAME || 'titrari-scara'}.onrender.com`;

const CACHE = new Map();

// ================= AXIOS =================
const axiosInstance = axios.create({
  timeout: 20000,
  responseType: 'arraybuffer',
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    Referer: 'https://titrari.ro/',
  },
});

// ================= MANIFEST =================
const manifest = {
  id: 'org.titrari.scara',
  version: '3.0.1',
  name: 'Titrari.ro',
  description: 'Subtitrări românești • titrari.ro',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  logo: 'https://titrari.ro/images/logo.png',
};

const builder = new addonBuilder(manifest);

// ================= DIACRITICE =================
function fixDiacritics(text) {
  return text
    .replace(/ª/g, 'Ș')
    .replace(/º/g, 'ș')
    .replace(/Þ/g, 'Ț')
    .replace(/þ/g, 'ț')
    .replace(/Åž/g, 'Ș')
    .replace(/ÅŸ/g, 'ș')
    .replace(/Å¢/g, 'Ț')
    .replace(/Å£/g, 'ț')
    .replace(/Ã¢/g, 'â')
    .replace(/Ã£/g, 'ă')
    .replace(/ÃŽ/g, 'Î')
    .replace(/Ã®/g, 'î');
}

function decodeBuffer(buffer) {
  try {
    let text = buffer.toString('utf8');
    if (/[șțăîâȘȚĂÎÂ]/.test(text)) return fixDiacritics(text);
    return fixDiacritics(buffer.toString('latin1'));
  } catch {
    return fixDiacritics(buffer.toString('latin1'));
  }
}

// ================= EXTRAGERE SRT =================
async function getSrt(subId, season = null, episode = null) {
  const cacheKey = `srt:${subId}:${season || ''}:${episode || ''}`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  try {
    const res = await axiosInstance.get(
      `https://titrari.ro/get.php?id=${subId}`
    );

    const buffer = Buffer.from(res.data);
    let content = null;

    const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
    const isRar = buffer.toString('ascii', 0, 4) === 'Rar!';

    if (isZip) {
      const zip = new AdmZip(buffer);
      let files = zip
        .getEntries()
        .filter((e) => /\.(srt|sub)$/i.test(e.name));

      if (season && episode) {
        const re = new RegExp(
          `S0*${season}E0*${episode}|${season}x0*${episode}`,
          'i'
        );
        files = files.filter((f) => re.test(f.name));
      }

      if (files[0]) content = decodeBuffer(zip.readFile(files[0]));
    } else if (isRar) {
      const extractor = await createExtractorFromData({ data: buffer });
      let files = extractor.getFileList().fileHeaders.filter((f) =>
        /\.(srt|sub)$/i.test(f.name)
      );

      if (season && episode) {
        const re = new RegExp(
          `S0*${season}E0*${episode}|${season}x0*${episode}`,
          'i'
        );
        files = files.filter((f) => re.test(f.name));
      }

      if (files[0]) {
        const extracted = extractor.extract({ files: [files[0].name] });
        const file = [...extracted.files][0];
        if (file?.extraction)
          content = decodeBuffer(Buffer.from(file.extraction));
      }
    } else {
      content = decodeBuffer(buffer);
    }

    if (content) CACHE.set(cacheKey, content);
    return content || null;
  } catch (err) {
    console.error('SRT ERROR:', err.message);
    return null;
  }
}

// ================= SEARCH =================
async function searchSubtitles(imdbId, type, season, episode) {
  const cacheKey = `search:${imdbId}:${season || 0}:${episode || 0}`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  const cleanId = imdbId.replace('tt', '');
  const url = `https://titrari.ro/index.php?page=numaicautamcaneiesepenas&z5=${cleanId}`;

  try {
    const res = await axios.get(url, { headers: axiosInstance.defaults.headers });
    const $ = cheerio.load(res.data);

    const results = [];

    $('a[href*="get.php?id="]').each((_, el) => {
      const link = $(el).attr('href');
      const id = link?.match(/id=(\d+)/)?.[1];
      if (!id) return;

      results.push({
        id: `titrari:${id}`,
        lang: 'ro',
        url: `${BASE_URL}/subtitle/${id}.srt${
          season ? `?season=${season}&episode=${episode}` : ''
        }`,
        title: 'Titrari.ro',
      });
    });

    CACHE.set(cacheKey, results);
    return results;
  } catch (err) {
    console.error('SEARCH ERROR:', err.message);
    return [];
  }
}

// ================= HANDLER =================
builder.defineSubtitlesHandler(async (args) => {
  const imdb = args.id.split(':')[0];
  const season = args.extra?.season
    ? parseInt(args.extra.season)
    : null;
  const episode = args.extra?.episode
    ? parseInt(args.extra.episode)
    : null;

  const subtitles = await searchSubtitles(
    imdb,
    args.type,
    season,
    episode
  );

  return { subtitles };
});

// ================= EXPRESS =================
const app = express();
app.use(builder.getInterface());

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

app.listen(PORT, () =>
  console.log(`Addon ready: ${BASE_URL}/manifest.json`)
);



