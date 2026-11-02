// Разбор файла с куками тестового аккаунта. Поддерживаются три формата экспорта:
// Netscape (cookies.txt), JSON (Cookie-Editor) и строка заголовка Cookie.
// Значения никогда не выводятся: в отчёт попадают только имена и сроки.
import { readFileSync } from 'node:fs';

const SITE = 'deviantart.com';
const SESSION_COOKIE = /^auth(_secure)?$/;

function fromNetscape(text) {
  return text.split('\n').flatMap(line => {
    const httpOnly = line.startsWith('#HttpOnly_');
    if (!line.trim() || (line.startsWith('#') && !httpOnly)) return [];
    const parts = (httpOnly ? line.slice('#HttpOnly_'.length) : line).split('\t');
    if (parts.length < 7) return [];
    const [host, includeSubdomains, path, secure, expiry, name, value] = parts;
    // Ведущая точка значима: без неё Firefox привяжет куку к одному хосту,
    // и куки с deviantart.com не будут отправляться на www.deviantart.com.
    const domain = includeSubdomains === 'TRUE' && !host.startsWith('.') ? `.${host}` : host;
    return [{ name, value: value.trim(), domain, path, secure: secure === 'TRUE', httpOnly, expiry: Number(expiry) }];
  });
}

function fromJson(data) {
  const list = Array.isArray(data) ? data : data.cookies ?? [];
  return list.map(cookie => ({
    name: cookie.name,
    value: String(cookie.value),
    domain: cookie.hostOnly || cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`,
    path: cookie.path ?? '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    expiry: Math.floor(cookie.expirationDate ?? cookie.expires ?? 0),
  }));
}

function fromHeader(text) {
  return text.replace(/^cookie:\s*/i, '').split(';').flatMap(pair => {
    const separator = pair.indexOf('=');
    if (separator < 1) return [];
    return [{
      name: pair.slice(0, separator).trim(),
      value: pair.slice(separator + 1).trim(),
      domain: `.${SITE}`,
      path: '/',
      secure: true,
      httpOnly: false,
      expiry: 0,
    }];
  });
}

export function parseCookies(text, nowSeconds = Date.now() / 1000) {
  const trimmed = text.trim();
  let cookies;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) cookies = fromJson(JSON.parse(trimmed));
  else if (trimmed.includes('\t')) cookies = fromNetscape(trimmed);
  else cookies = fromHeader(trimmed);

  const hostname = domain => domain.replace(/^\./, '');
  return cookies.filter(cookie =>
    (hostname(cookie.domain) === SITE || hostname(cookie.domain).endsWith(`.${SITE}`))
    && (!cookie.expiry || cookie.expiry > nowSeconds));
}

export function hasSession(cookies) {
  return cookies.some(cookie => SESSION_COOKIE.test(cookie.name));
}

export function loadCookies(path) {
  return parseCookies(readFileSync(path, 'utf8'));
}
