// МонетоЧек — сервер без зависимостей (Node 18+)
const http = require('http'), fs = require('fs'), path = require('path');
try { fs.readFileSync('.env', 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }); } catch {}
const KEY = process.env.YT_API_KEY, PORT = process.env.PORT || 3000;
const API = 'https://www.googleapis.com/youtube/v3/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const cache = new Map(), hits = new Map();

// Диапазоны RPM ($ на 1000 просмотров, доля автора) по категориям YouTube
const RPM = { 27: [2, 6], 26: [2, 6], 28: [3, 8], 25: [2, 5], 22: [1, 3], 24: [1, 3], 23: [1, 3], 20: [1, 3], 10: [0.5, 2], 19: [1.5, 4], 17: [1, 3], 1: [1, 3], 2: [1, 3], 15: [1, 3], 29: [1.5, 4], 43: [1, 3], 44: [1, 3] };
const RPM_DEFAULT = [1, 4], RPM_SHORTS = [0.01, 0.06];

async function yt(ep, params) {
  const u = new URL(API + ep);
  Object.entries({ ...params, key: KEY }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u), j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Ошибка YouTube API');
  return j;
}

async function resolveChannel(input) {
  input = String(input || '').trim();
  if (!input) throw new Error('Вставьте ссылку на канал');
  if (/^UC[\w-]{22}$/.test(input)) return { id: input };
  if (input.startsWith('@')) return { forHandle: input };
  let url;
  try { url = new URL(/^https?:\/\//.test(input) ? input : 'https://' + input); } catch { throw new Error('Не удалось разобрать ссылку'); }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname)) throw new Error('Нужна ссылка на YouTube');
  const p = url.pathname.split('/').filter(Boolean);
  const v = url.hostname.includes('youtu.be') ? p[0] : url.searchParams.get('v') || (p[0] === 'shorts' ? p[1] : null);
  if (v) { const j = await yt('videos', { part: 'snippet', id: v }); if (!j.items.length) throw new Error('Видео не найдено'); return { id: j.items[0].snippet.channelId }; }
  if (p[0] === 'channel' && p[1]) return { id: p[1] };
  if (p[0] && p[0].startsWith('@')) return { forHandle: p[0] };
  if (p[0] === 'user' && p[1]) return { forUsername: p[1] };
  if (p[0]) { // /c/name или /name — поиск (стоит 100 единиц квоты)
    const j = await yt('search', { part: 'snippet', type: 'channel', q: p[p.length - 1], maxResults: 1 });
    if (j.items.length) return { id: j.items[0].snippet.channelId };
  }
  throw new Error('Канал не найден');
}

async function hasAds(id) {
  try {
    const r = await fetch('https://www.youtube.com/watch?v=' + id, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1; SOCS=CAI' }, signal: AbortSignal.timeout(9000) });
    const t = await r.text();
    if (!t.includes('ytInitialPlayerResponse')) return null;
    return /"adPlacements"\s*:\s*\[/.test(t) || /"playerAds"\s*:\s*\[/.test(t) || /"yt_ad"\s*:\s*"?1/.test(t);
  } catch { return null; }
}

const secs = d => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '') || []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };

async function check(input) {
  const q = await resolveChannel(input);
  const ch = await yt('channels', { part: 'snippet,statistics,contentDetails,status', ...q });
  if (!ch.items || !ch.items.length) throw new Error('Канал не найден');
  const c = ch.items[0], s = c.statistics;
  const pl = await yt('playlistItems', { part: 'contentDetails', playlistId: c.contentDetails.relatedPlaylists.uploads, maxResults: 15 }).catch(() => ({ items: [] }));
  const ids = pl.items.map(i => i.contentDetails.videoId);
  const vids = ids.length ? (await yt('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(',') })).items : [];
  const sample = vids.slice(0, 6);
  const adRes = await Promise.all(sample.map(v => hasAds(v.id)));
  const videos = vids.map(v => ({ id: v.id, title: v.snippet.title, views: +v.statistics.viewCount || 0, date: v.snippet.publishedAt, short: secs(v.contentDetails.duration) <= 60, cat: v.snippet.categoryId, ads: sample.includes(v) ? adRes[sample.indexOf(v)] : undefined }));
  const checked = videos.filter(v => v.ads !== undefined && v.ads !== null), withAds = checked.filter(v => v.ads).length;
  const subs = s.hiddenSubscriberCount ? null : +s.subscriberCount;
  let status = 'unknown';
  if (checked.length) status = withAds / checked.length >= 0.5 ? 'likely' : withAds > 0 ? 'partial' : 'unlikely';

  // Оценка дохода по темпу просмотров последних видео
  let monthly = null, lifetime = null;
  if (videos.length) {
    const oldest = Math.min(...videos.map(v => Date.parse(v.date)));
    const span = Math.max(14, (Date.now() - oldest) / 864e5);
    let lo = 0, hi = 0, tot = 0;
    videos.forEach(v => { const r = v.short ? RPM_SHORTS : (RPM[v.cat] || RPM_DEFAULT); lo += v.views * r[0] / 1000; hi += v.views * r[1] / 1000; tot += v.views; });
    const k = 30 / span;
    monthly = { views: Math.round(tot * k), lo: lo * k, hi: hi * k };
    if (tot) lifetime = { lo: +s.viewCount * (lo / tot) / 1, hi: +s.viewCount * (hi / tot) / 1 };
  }
  return {
    channel: { id: c.id, title: c.snippet.title, handle: c.snippet.customUrl, country: c.snippet.country || null, created: c.snippet.publishedAt, avatar: (c.snippet.thumbnails.medium || c.snippet.thumbnails.default).url, kids: c.status.madeForKids || false, subs, views: +s.viewCount, videos: +s.videoCount },
    monetization: { status, checked: checked.length, withAds, belowThreshold: subs !== null && subs < 500 },
    earnings: monthly && { monthly, lifetime }, videos
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/check') {
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    if (!KEY) return send(500, { error: 'На сервере не задан YT_API_KEY' });
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress, now = Date.now();
    const h = (hits.get(ip) || []).filter(t => now - t < 36e5);
    if (h.length >= 30) return send(429, { error: 'Слишком много запросов, попробуйте позже' });
    hits.set(ip, [...h, now]);
    const key = (u.searchParams.get('url') || '').trim().toLowerCase(), hit = cache.get(key);
    if (hit && now - hit.t < 36e5) return send(200, hit.d);
    try { const d = await check(u.searchParams.get('url')); cache.set(key, { t: now, d }); send(200, d); }
    catch (e) { send(400, { error: e.message }); }
    return;
  }
  const f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(b); });
}).listen(PORT, () => console.log('МонетоЧек: http://localhost:' + PORT));
