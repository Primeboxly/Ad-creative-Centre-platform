// Import a product from its page URL: a safe fetch (public internet only), then what the page says about the product
// (JSON-LD Product, Open Graph / meta tags, visible text, pictures).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpError } from './errors.js';

const MAX_BYTES = 3 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

// Private, loopback, link-local and reserved addresses: never fetched (the server must not be used to reach its own network).
export function isPrivateIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

export async function checkPublicUrl(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { throw new HttpError(400, 'Not a valid link'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Only http and https links');
  if (u.username || u.password) throw new HttpError(400, 'Links with a login are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new HttpError(400, 'This address is not allowed');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new HttpError(400, `Cannot find ${host}`); });
  if (addrs.some(a => isPrivateIp(a.address))) throw new HttpError(400, 'This address is not allowed');
  return u;
}

// GET with redirects checked one by one, a size limit and a timeout. Returns { url, type, body (Buffer) }.
export async function safeGet(raw, { accept = 'text/html,application/xhtml+xml,*/*;q=0.8', maxBytes = MAX_BYTES, timeout = 15000 } = {}) {
  let url = await checkPublicUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let r;
    try {
      r = await fetch(url, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': UA, accept, 'accept-language': 'en;q=0.9,fr;q=0.8' } });
    } catch (e) {
      clearTimeout(timer);
      throw new HttpError(502, e.name === 'AbortError' ? 'The page took too long to answer' : `Could not open the page (${e.cause?.code || e.message})`);
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      clearTimeout(timer);
      url = await checkPublicUrl(new URL(r.headers.get('location'), url).href);
      continue;
    }
    if (!r.ok) { clearTimeout(timer); throw new HttpError(502, `The page answered ${r.status}${r.status === 403 || r.status === 429 ? ' (the site blocks automatic visits: fill the product by hand)' : ''}`); }
    const chunks = [];
    let size = 0;
    for await (const c of r.body) {
      size += c.length;
      if (size > maxBytes) { ctrl.abort(); break; }
      chunks.push(c);
    }
    clearTimeout(timer);
    return { url: url.href, type: r.headers.get('content-type') || '', body: Buffer.concat(chunks) };
  }
  throw new HttpError(502, 'Too many redirects');
}

const decode = s => String(s || '').replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos|#39|nbsp);/gi, m => {
  const k = m.slice(1, -1).toLowerCase();
  if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : Number(k.slice(1)));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k] ?? m;
}).replace(/\s+/g, ' ').trim();

const meta = (html, names) => {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${n}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    const c = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (c) return decode(c);
  }
  return '';
};

// All JSON-LD objects of the page, flattened (@graph and arrays).
function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { out.push(v); if (v['@graph']) walk(v['@graph']); } };
      walk(JSON.parse(m[1].trim()));
    } catch { /* broken JSON-LD: ignore */ }
  }
  return out;
}

const abs = (u, base) => { try { return new URL(u, base).href; } catch { return ''; } };

// What the page says about the product. Returns { name, description, price, currency, images[], text }.
export function extractProduct(html, pageUrl) {
  const ld = jsonLd(html);
  const prod = ld.find(o => [].concat(o['@type'] || []).some(t => /product/i.test(t))) || {};
  const offer = [].concat(prod.offers || [])[0] || {};
  const offerPrice = offer.price ?? offer.lowPrice ?? [].concat(offer.priceSpecification || [])[0]?.price;
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const images = [];
  const addImg = u => {
    const a = abs(typeof u === 'object' ? u?.contentUrl || u?.url : u, pageUrl);
    if (!a || !/^https?:/.test(a) || images.includes(a) || a.split('#')[0] === String(pageUrl).split('#')[0]) return;
    if (!/\.(jpe?g|png|webp|gif|avif)(\?|$)|image|media|img|cdn|photo|upload/i.test(a)) return; // looks like a picture
    images.push(a);
  };
  [].concat(prod.image || []).forEach(addImg);
  addImg(meta(html, ['og:image', 'og:image:url', 'twitter:image']));
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const src = tag.match(/(?:data-src|data-original|src)=["']([^"']+)["']/i)?.[1];
    if (!src || /sprite|icon|logo|avatar|placeholder|pixel|\.svg|data:/i.test(src)) continue;
    const w = Number(tag.match(/width=["']?(\d+)/i)?.[1] || 0);
    if (w && w < 200) continue;
    addImg(src);
    if (images.length >= 16) break;
  }
  // Visible text, for the AI to read (scripts, styles and tags removed).
  const text = decode(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ')).slice(0, 15000);
  return {
    name: decode(prod.name) || meta(html, ['og:title', 'twitter:title']) || title,
    description: decode(prod.description) || meta(html, ['og:description', 'description', 'twitter:description']),
    price: offerPrice !== undefined ? String(offerPrice) : meta(html, ['product:price:amount', 'og:price:amount', 'price']),
    currency: offer.priceCurrency || meta(html, ['product:price:currency', 'og:price:currency', 'priceCurrency']),
    images: images.slice(0, 16),
    text,
  };
}
