// МонетоЧек v2 — сервер без зависимостей (Node 18+)
const http = require('http'), fs = require('fs'), path = require('path');
try { fs.readFileSync('.env', 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }); } catch {}
const KEY = process.env.YT_API_KEY, PORT = process.env.PORT || 3000;
const API = 'https://www.googleapis.com/youtube/v3/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const cache = new Map(), hits = new Map();

// Категории YouTube: [название, RPM от, RPM до] — $ на 1000 просмотров (доля автора)
const CATS = { 1: ['Кино и анимация', 1, 3], 2: ['Авто и транспорт', 3, 8], 10: ['Музыка', 0.5, 2], 15: ['Животные', 1, 3], 17: ['Спорт', 1.5, 4], 19: ['Путешествия', 3, 8], 20: ['Игры', 1, 3], 22: ['Люди и блоги', 1, 3], 23: ['Юмор', 1, 3], 24: ['Развлечения', 1, 3], 25: ['Новости и политика', 2, 5], 26: ['Хобби и стиль', 2, 6], 27: ['Образование', 2, 6], 28: ['Наука и техника', 3, 8], 29: ['Некоммерческие', 1, 3] };
const DEF = ['Другое', 1, 4], SHORTS = [0.01, 0.06];

async function yt(ep, params) {
  const u = new URL(API + ep);
  Object.entries({ ...params, key: KEY }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u), j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Ошибка YouTube API');
  return j;
}

async function resolve(input) {
  input = String(input || '').trim();
  if (!input) throw new Error('Вставьте ссылку на канал или видео');
  if (/^UC[\w-]{22}$/.test(input)) return { ch: { id: input } };
  if (/^[\w-]{11}$/.test(input) && !/^@/.test(input)) return { video: input };
  if (input.startsWith('@')) return { ch: { forHandle: input } };
  let url;
  try { url = new URL(/^https?:\/\//.test(input) ? input : 'https://' + input); } catch { throw new Error('Не удалось разобрать ссылку'); }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname)) throw new Error('Нужна ссылка на YouTube');
  const p = url.pathname.split('/').filter(Boolean);
  const v = url.hostname.includes('youtu.be') ? p[0] : url.searchParams.get('v') || (['shorts', 'live', 'embed'].includes(p[0]) ? p[1] : null);
  if (v) return { video: v };
  if (p[0] === 'channel' && p[1]) return { ch: { id: p[1] } };
  if (p[0] && p[0].startsWith('@')) return { ch: { forHandle: p[0] } };
  if (p[0] === 'user' && p[1]) return { ch: { forUsername: p[1] } };
  if (p[0]) { // /c/имя — поиск (100 единиц квоты)
    const j = await yt('search', { part: 'snippet', type: 'channel', q: p[p.length - 1], maxResults: 1 });
    if (j.items.length) return { ch: { id: j.items[0].snippet.channelId } };
  }
  throw new Error('Канал не найден');
}

// Признаки рекламы: сначала страница видео, затем внутренний API плеера (эвристика)
const parseAds = t => ({ ads: /"adPlacements"\s*:\s*\[\s*\{/.test(t) || /"playerAds"\s*:\s*\[\s*\{/.test(t) || /"yt_ad"\s*:\s*"?1/.test(t),
  breaks: [...new Set([...t.matchAll(/"offsetStartMilliseconds"\s*:\s*"(\d+)"/g)].map(m => Math.round(+m[1] / 1000)))].sort((a, b) => a - b),
  pre: /AD_PLACEMENT_KIND_START/.test(t), post: /AD_PLACEMENT_KIND_END/.test(t) });
async function adInfo(id) {
  const why = [];
  try {
    const r = await fetch('https://www.youtube.com/watch?v=' + id, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1; SOCS=CAI' }, signal: AbortSignal.timeout(9000) });
    const t = await r.text();
    if (t.includes('ytInitialPlayerResponse')) return parseAds(t);
    why.push(/consent/i.test(r.url) || /consent\.youtube/i.test(t.slice(0, 5000)) ? 'окно согласия cookie' : /unusual traffic|captcha/i.test(t) ? 'защита YouTube от ботов' : 'страница без данных плеера (HTTP ' + r.status + ')');
  } catch (e) { why.push('страница видео недоступна'); }
  for (const [name, num] of [['WEB', '1'], ['MWEB', '2']]) {
    try {
      const ver = '2.20250101.00.00';
      const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, origin: 'https://www.youtube.com', 'x-youtube-client-name': num, 'x-youtube-client-version': ver },
        body: JSON.stringify({ context: { client: { clientName: name, clientVersion: ver, hl: 'en', gl: 'US' } }, videoId: id, contentCheckOk: true, racyCheckOk: true }), signal: AbortSignal.timeout(9000) });
      const j = await r.json(), ps = j.playabilityStatus && j.playabilityStatus.status;
      if (ps === 'OK') return parseAds(JSON.stringify(j));
      why.push('API плеера ' + name + ': ' + (ps || 'HTTP ' + r.status));
    } catch (e) { why.push('API плеера ' + name + ' недоступен'); }
  }
  return { ads: null, reason: why.join('; ') };
}

const secs = d => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '') || []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };
const rate = (cat, short) => short ? SHORTS : (CATS[cat] || DEF).slice(-2);
const topicName = u => decodeURIComponent(String(u).split('/').pop()).replace(/_/g, ' ');
const parseKw = s => s ? [...s.matchAll(/"([^"]+)"|(\S+)/g)].map(m => m[1] || m[2]) : [];
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[s.length >> 1] + s[(s.length - 1) >> 1]) / 2 : 0; };

async function checkChannel(q) {
  const ch = await yt('channels', { part: 'snippet,statistics,contentDetails,status,brandingSettings,topicDetails', ...q });
  if (!ch.items || !ch.items.length) throw new Error('Канал не найден');
  const c = ch.items[0], s = c.statistics, b = c.brandingSettings || {};
  const pl = await yt('playlistItems', { part: 'contentDetails', playlistId: c.contentDetails.relatedPlaylists.uploads, maxResults: 20 }).catch(() => ({ items: [] }));
  const ids = pl.items.map(i => i.contentDetails.videoId);
  const vids = ids.length ? (await yt('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(',') })).items : [];
  const sample = vids.slice(0, 6), ai = await Promise.all(sample.map(v => adInfo(v.id)));
  const videos = vids.map(v => ({ id: v.id, title: v.snippet.title, views: +v.statistics.viewCount || 0, likes: +v.statistics.likeCount || 0, comments: +v.statistics.commentCount || 0, date: v.snippet.publishedAt, dur: secs(v.contentDetails.duration), short: secs(v.contentDetails.duration) <= 60, cat: v.snippet.categoryId, ads: sample.includes(v) ? ai[sample.indexOf(v)].ads : undefined }));
  const checked = videos.filter(v => typeof v.ads === 'boolean'), withAds = checked.filter(v => v.ads).length;
  const subs = s.hiddenSubscriberCount ? null : +s.subscriberCount;
  let status = 'unknown';
  if (checked.length) status = withAds / checked.length >= 0.5 ? 'likely' : withAds > 0 ? 'partial' : 'unlikely';

  let stats = null, earnings = null;
  if (videos.length) {
    const dates = videos.map(v => Date.parse(v.date)), oldest = Math.min(...dates);
    const span = Math.max(14, (Date.now() - oldest) / 864e5), k = 30 / span;
    let lo = 0, hi = 0, tot = 0, eng = 0, shorts = 0; const catViews = {};
    videos.forEach(v => { const r = rate(v.cat, v.short); lo += v.views * r[0] / 1000; hi += v.views * r[1] / 1000; tot += v.views; eng += v.likes + v.comments; if (v.short) shorts++; if (!v.short) catViews[v.cat] = (catViews[v.cat] || 0) + v.views; });
    const topCat = +Object.keys(catViews).sort((a, b) => catViews[b] - catViews[a])[0] || +videos[0].cat;
    const mv = tot * k;
    stats = { avgViews: tot / videos.length, medianViews: median(videos.map(v => v.views)), perWeek: videos.length > 1 ? (videos.length - 1) / (Math.max(1, (Math.max(...dates) - oldest) / 864e5) / 7) : 0, engagement: tot ? eng / tot * 100 : 0, shortsShare: shorts / videos.length * 100, topCat: (CATS[topCat] || DEF)[0], monthlyViews: mv };
    earnings = { monthly: { views: Math.round(mv), lo: lo * k, hi: hi * k }, lifetime: tot ? { lo: +s.viewCount * lo / tot, hi: +s.viewCount * hi / tot } : null,
      matrix: Object.values(CATS).map(c => ({ name: c[0], lo: c[1], hi: c[2], mlo: mv * c[1] / 1000, mhi: mv * c[2] / 1000 })).sort((a, b) => b.mhi - a.mhi) };
  }
  return { type: 'channel',
    channel: { id: c.id, title: c.snippet.title, handle: c.snippet.customUrl, country: c.snippet.country || null, created: c.snippet.publishedAt, avatar: (c.snippet.thumbnails.medium || c.snippet.thumbnails.default).url, banner: b.image && b.image.bannerExternalUrl ? b.image.bannerExternalUrl + '=w1280' : null, description: c.snippet.description || '', keywords: parseKw(b.channel && b.channel.keywords), topics: ((c.topicDetails && c.topicDetails.topicCategories) || []).map(topicName), lang: c.snippet.defaultLanguage || (b.channel && b.channel.defaultLanguage) || null, linked: c.status.isLinked, kids: c.status.madeForKids || false, subs, views: +s.viewCount, videos: +s.videoCount },
    monetization: { status, checked: checked.length, withAds, belowThreshold: subs !== null && subs < 500, reason: ai.filter(a => a.ads === null).map(a => a.reason)[0] || null, signals: { subsOk: subs !== null && subs >= 1000, activeOk: videos.filter(v => Date.now() - Date.parse(v.date) < 90 * 864e5).length >= 3 } }, stats, earnings, videos };
}

async function checkVideo(id) {
  const j = await yt('videos', { part: 'snippet,statistics,contentDetails,status,topicDetails,recordingDetails', id });
  if (!j.items.length) throw new Error('Видео не найдено');
  const v = j.items[0], sn = v.snippet, st = v.statistics, d = secs(v.contentDetails.duration), short = d <= 60;
  const [ch, ai] = await Promise.all([yt('channels', { part: 'snippet,statistics', id: sn.channelId }), adInfo(id)]);
  const c = ch.items[0], views = +st.viewCount || 0, r = rate(sn.categoryId, short);
  const rr = v.contentDetails.regionRestriction;
  return { type: 'video',
    video: { id, title: sn.title, description: sn.description || '', tags: sn.tags || [], cat: (CATS[sn.categoryId] || DEF)[0], date: sn.publishedAt, dur: d, short, views, likes: +st.likeCount || 0, comments: +st.commentCount || 0, lang: sn.defaultAudioLanguage || sn.defaultLanguage || null, embeddable: v.status.embeddable, kids: v.status.madeForKids || false, age: !!(v.contentDetails.contentRating && v.contentDetails.contentRating.ytRating), regions: rr ? (rr.blocked ? 'закрыто в ' + rr.blocked.length + ' странах' : 'доступно только в ' + (rr.allowed || []).length + ' странах') : null, topics: ((v.topicDetails && v.topicDetails.topicCategories) || []).map(topicName), place: v.recordingDetails && v.recordingDetails.locationDescription || null, live: sn.liveBroadcastContent },
    channel: { id: c.id, title: c.snippet.title, avatar: (c.snippet.thumbnails.default || {}).url, subs: c.statistics.hiddenSubscriberCount ? null : +c.statistics.subscriberCount },
    ads: ai, earnings: { lo: views * r[0] / 1000, hi: views * r[1] / 1000, rpm: r } };
}

async function check(input) {
  const r = await resolve(input);
  return r.video ? checkVideo(r.video) : checkChannel(r.ch);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/check') {
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    if (!KEY) return send(500, { error: 'На сервере не задан YT_API_KEY' });
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress, now = Date.now();
    const h = (hits.get(ip) || []).filter(t => now - t < 36e5);
    if (h.length >= 60) return send(429, { error: 'Слишком много запросов, попробуйте позже' });
    hits.set(ip, [...h, now]);
    const key = (u.searchParams.get('url') || '').trim().toLowerCase(), hit = cache.get(key);
    if (hit && now - hit.t < 36e5) return send(200, hit.d);
    try { const d = await check(u.searchParams.get('url')); if (d.type === 'video' ? d.ads.ads !== null : d.monetization.status !== 'unknown') cache.set(key, { t: now, d }); send(200, d); }
    catch (e) { send(400, { error: e.message }); }
    return;
  }
  const f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(b); });
}).listen(PORT, () => console.log('МонетоЧек: http://localhost:' + PORT));
