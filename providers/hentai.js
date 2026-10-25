// Nuvio Provider: Hentai Scraper (18+)
// Quellen: hanime.tv, hentaihaven.xxx, hanime.red, a-hentai.tv
// WICHTIG: Seitenstrukturen ändern sich oft -> bei Ausfall die jeweilige Quelle unten anpassen.

const TMDB_KEY = ''; // <- eigenen TMDB API Key (v3) eintragen
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36';

const log = (...a) => console.log('[HentaiScraper]', ...a);

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.json();
}
async function getText(url, headers) {
  const r = await fetch(url, { headers: Object.assign({ 'User-Agent': UA }, headers || {}) });
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.text();
}

async function getTitle(tmdbId, type) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const d = await getJson(`https://api.themoviedb.org/3/${kind}/${tmdbId}?api_key=${TMDB_KEY}`);
  return { title: d.title || d.name, original: d.original_title || d.original_name };
}

const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function qualityOf(u, hint) {
  const m = (hint || u).match(/(2160|1080|720|480|360)/);
  return m ? m[1] + 'p' : 'Auto';
}

function mediaFromHtml(html, base) {
  const out = new Set();
  const re = /https?:\\?\/\\?\/[^"'\s<>\\]+?\.(?:m3u8|mp4)(?:\?[^"'\s<>\\]*)?/gi;
  (html.match(re) || []).forEach(u => out.add(u.replace(/\\\//g, '/')));
  return [...out];
}

function iframesFromHtml(html, base) {
  const out = [];
  const re = /<iframe[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    let u = m[1];
    if (u.startsWith('//')) u = 'https:' + u;
    else if (u.startsWith('/')) u = base + u;
    out.push(u);
  }
  return out;
}

// Generischer Scraper für WordPress-artige Seiten
async function wpSource(src, q, season, episode, isMovie) {
  const html = await getText(`${src.base}/?s=${encodeURIComponent(q)}`);
  const links = [...html.matchAll(/href=["'](https?:\/\/[^"']*?(?:hentai|series|watch|video|anime)[^"']*)["']/gi)]
    .map(m => m[1]).filter(u => u.startsWith(src.base));
  const hit = links.find(u => u.includes(slugify(q))) || links[0];
  if (!hit) return [];
  let page = hit;
  if (!isMovie) {
    const series = await getText(hit);
    const ep = episode || 1;
    const epLinks = [...series.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]);
    const epHit = epLinks.find(u => new RegExp(`(episode|ep)[-_/]?0*${ep}(?!\\d)`, 'i').test(u));
    if (epHit) page = epHit.startsWith('http') ? epHit : src.base + epHit;
  }
  const pageHtml = await getText(page, { Referer: src.base });
  const streams = [];
  const add = (u, ref) => streams.push({
    name: src.name, title: `${src.name} ${qualityOf(u)}`, url: u,
    quality: qualityOf(u), headers: { 'User-Agent': UA, Referer: ref || src.base }
  });
  mediaFromHtml(pageHtml, src.base).forEach(u => add(u, page));
  for (const f of iframesFromHtml(pageHtml, src.base).slice(0, 4)) {
    try {
      const fh = await getText(f, { Referer: page });
      mediaFromHtml(fh, f).forEach(u => add(u, f));
    } catch (e) { log('iframe fail', f); }
  }
  return streams;
}

async function hanimeTv(q, season, episode) {
  const res = await getJson('https://search.htv-services.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ search_text: q, tags: [], tags_mode: 'AND', brands: [], blacklist: [],
      order_by: 'created_at_unix', ordering: 'desc', page: 0 })
  });
  const hits = typeof res.hits === 'string' ? JSON.parse(res.hits) : res.hits || [];
  if (!hits.length) return [];
  const base = slugify(q);
  const ep = episode || 1;
  const hit = hits.find(h => h.slug === `${base}-${ep}`) ||
              hits.find(h => (h.slug || '').startsWith(base) && (h.slug || '').endsWith('-' + ep)) || hits[0];
  const data = await getJson(`https://hanime.tv/api/v8/video?id=${hit.slug}`, { headers: { 'User-Agent': UA } });
  const servers = (data.videos_manifest && data.videos_manifest.servers) || [];
  const out = [];
  servers.forEach(s => (s.streams || []).forEach(st => {
    if (!st.url) return; // Premium-Streams haben oft leere URL
    out.push({ name: 'Hanime.tv', title: `Hanime.tv ${st.height}p`, url: st.url,
      quality: st.height + 'p', headers: { 'User-Agent': UA, Referer: 'https://hanime.tv/' } });
  }));
  return out;
}

const SOURCES = [
  { id: 'hanime.tv', run: (q, s, e) => hanimeTv(q, s, e) },
  { id: 'hentaihaven', run: (q, s, e, m) => wpSource({ name: 'HentaiHaven', base: 'https://hentaihaven.xxx' }, q, s, e, m) },
  { id: 'hanime.red', run: (q, s, e, m) => wpSource({ name: 'Hanime.red', base: 'https://hanime.red' }, q, s, e, m) },
  { id: 'a-hentai', run: (q, s, e, m) => wpSource({ name: 'A-Hentai', base: 'https://a-hentai.tv' }, q, s, e, m) }
];

async function getStreams(tmdbId, mediaType, season, episode) {
  let names;
  try {
    const t = await getTitle(tmdbId, mediaType);
    names = [t.title, t.original].filter(Boolean);
  } catch (e) { log('TMDB fail', e.message); return []; }

  const isMovie = mediaType === 'movie';
  const results = await Promise.all(SOURCES.map(async s => {
    for (const n of names) {
      try {
        const r = await s.run(n, season, episode, isMovie);
        if (r.length) return r;
      } catch (e) { log(s.id, 'fail:', e.message); }
    }
    return [];
  }));
  const flat = results.flat();
  const order = { '2160p': 5, '1080p': 4, '720p': 3, '480p': 2, '360p': 1, Auto: 0 };
  return flat.sort((a, b) => (order[b.quality] || 0) - (order[a.quality] || 0));
}

module.exports = { getStreams };
