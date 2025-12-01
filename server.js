// server.js - Titrari.ro Stremio Addon v2.0.0 (2025 Edition)
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const AdmZip = require('adm-zip');
const { createExtractorFromData } = require('node-unrar-js');
const express = require('express');

// ====================== CONFIG ======================
const PORT = process.env.PORT || 7000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `https://stremio-titrari-ro.onrender.com`;

const CACHE = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 ore

const axiosInstance = axios.create({
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://titrari.ro/',
        'Origin': 'https://titrari.ro'
    }
});

// ====================== MANIFEST ======================
const manifest = {
    id: 'org.titrari.stremio',
    version: '2.0.0',
    name: 'Titrari.ro',
    description: 'Subtitrări românești rapide și corectate automat • titrari.ro',
    resources: ['subtitles', 'stream'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    logo: 'https://i.imgur.com/0n5Oi.png',
    background: 'https://i.imgur.com/8f5Kp.jpg',
    contactEmail: 'contact@stremio.ro',
    behaviorHints: { adult: false, p2p: false, configurable: false }
};

const builder = new addonBuilder(manifest);

// ====================== UTILS ======================
function fixDiacritics(text) {
    return text
        .replace(/ª/g, 'Ș').replace(/º/g, 'ș')
        .replace(/Þ/g, 'Ț').replace(/þ/g, 'ț')
        .replace(/Ãª/g, 'ă').replace(/Ã¢/g, 'â')
        .replace(/ÃŽ/g, 'Î).replace(/ï¿½/g, 'ă')
        .replace(/Ã£/g, 'ă').replace(/Ã¢/g, 'â')
        .replace(/Ã©/g, 'ă').replace(/ÅŸ/g, 'ș');
}

function decodeBuffer(buffer) {
    try {
        let text = buffer.toString('utf8');
        if (/[șțăîâ]/.test(text)) return fixDiacritics(text);

        text = buffer.toString('latin1');
        if (/[ȘșȚțĂăÎîÂâ]/.test(text)) return fixDiacritics(text);

        // Windows-1250 manual fallback
        const map = { 0x80: '€', 0x8A: 'Ș', 0x8C: 'Ț', 0x9A: 'ș', 0x9C: 'ț', 0xE3: 'ă', 0xC3: 'Ă' };
        text = '';
        for (let b of buffer) {
            text += map[b] || String.fromCharCode(b);
        }
        return fixDiacritics(text);
    } catch {
        return buffer.toString('latin1');
    }
}

async function getSrtFromApi(subId, season = null, episode = null) {
    const cacheKey = `srt:${subId}:${season||''}:${episode||''}`;
    if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

    try {
        const url = `https://titrari.ro/app/api/subtitle.php?id=${subId}`;
        const res = await axiosInstance.get(url, { responseType: 'arraybuffer' });

        const buffer = Buffer.from(res.data);
        const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B;
        const isRar = buffer.toString('ascii', 0, 4) === 'Rar!';

        let srtContent = null;

        if (isZip) {
            const zip = new AdmZip(buffer);
            const entries = zip.getEntries().filter(e => !e.isDirectory);
            const srtFiles = entries.filter(e => /\.(srt|sub)$/i.test(e.name));

            let target = srtFiles[0]?.name;
            if (season && episode) {
                const regex = new RegExp(`S0*${season}E0*${episode}|${season}x0*${episode}`, 'i');
                target = srtFiles.find(f => regex.test(f.name))?.name || target;
            }

            if (target) {
                srtContent = decodeBuffer(zip.readFile(target));
            }
        } else if (isRar) {
            const extractor = await createExtractorFromData({ data: buffer });
            const list = [...extractor.getFileList().fileHeaders];
            const srtFiles = list.filter(f => /\.(srt|sub)$/i.test(f.name));

            let target = srtFiles[0]?.name;
            if (season && episode) {
                const regex = new RegExp(`S0*${season}E0*${episode}|${season}x0*${episode}`, 'i');
                target = srtFiles.find(f => regex.test(f.name))?.name || target;
            }

            if (target) {
                const extracted = extractor.extract({ files: [target] });
                srtContent = decodeBuffer(Buffer.from([...extracted.files][0].extraction));
            }
        } else {
            srtContent = decodeBuffer(buffer);
        }

        if (srtContent) CACHE.set(cacheKey, srtContent);
        return srtContent || null;
    } catch (err) {
        console.error('Eroare extragere SRT:', err.message);
        return null;
    }
}

// ====================== SEARCH VIA API ======================
async function searchSubtitles(imdbId, type, season, episode) {
    const cacheKey = `search:${imdbId}:${season||'0'}:${episode||'0'}`;
    if (CACHE.has(cacheKey)) {
        const cached = CACHE.get(cacheKey);
        if (Date.now() - cached.time < CACHE_TTL) return cached.data;
    }

    }

    try {
        const res = await axiosInstance.get(
            `https://titrari.ro/app/api/search.php?imdb=${imdbId.replace('tt','')}`
        );

        if (!Array.isArray(res.data)) return [];

        let results = res.data;

        if (type === 'series' && season && episode) {
            const pattern = new RegExp(`S0*${season}E0*${episode}|${season}x0*${episode}`, 'i');
            results = results.filter(r => pattern.test(r.title + r.info));
        }

        results.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));

        const subs = results.map(sub => ({
            id: `titrari:${sub.id}`,
            lang: 'ro',
            url: `${BASE_URL}/subtitle/${sub.id}.srt${season ? `?season=${season}&episode=${episode}` : ''}`,
            title: sub.title.trim() || 'Titrari.ro',
        }));

        CACHE.set(cacheKey, { data: subs, time: Date.now() });
        return subs;
    } catch (err) {
        console.error('Eroare API căutare:', err.message);
        return [];
    }
}

// ====================== HANDLERS ======================
builder.defineSubtitlesHandler(async args => {
    const { type, id } = args;
    const [imdb, s, e] = id.split(':');
    const season = s ? parseInt(s) : null;
    const episode = e ? parseInt(e) : null;

    const subs = await searchSubtitles(imdb, type, season, episode);
    return { subtitles: subs };
});

builder.defineStreamHandler(async args => {
    if (args.id.startsWith('titrari:')) {
        const subId = args.id.split(':')[1];
        const url = `${BASE_URL}/subtitle/${subId}.srt`;
        return {
            streams: [{
                url: url + (args.extra?.season ? `?season=${args.extra.season}&episode=${args.extra.episode}` : ''),
                title: 'Titrari.ro • Direct SRT',
                behaviorHints: { notWebReady: false }
            }]
        };
    }
    return { streams: [] };
});

// ====================== EXPRESS APP ======================
const app = express();

app.get('/health', (req, res) => res.send('OK'));

app.get('/subtitle/:id.srt', async (req, res) => {
    const { id } = req.params;
    const { season, episode } = req.query;

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Access-Control-Allow-Origin', '*');

    const srt = await getSrtFromApi(id, season || null, episode || null);

    if (srt) {
        res.send(srt);
    } else {
        res.status(404).send('-- subtitle not found or corrupted --');
    }
});

// ====================== START ======================
serveHTTP(builder.getInterface(), { port: PORT })
    .then(() => {
        console.log(`Titrari.ro Addon v2.0.0 pornit`);
        console.log(`Manifest: ${BASE_URL}/manifest.json`);
        console.log(`Exemplu SRT: ${BASE_URL}/subtitle/12345.srt`);
    });

app.listen(7001); // doar pentru /health și /subtitle/*.srt dacă vrei