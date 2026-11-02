// Быстрые тесты без браузера и сети: node --test tests/unit.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasSession, parseCookies } from './lib/cookies.mjs';
import { extractCss } from './lib/usercss.mjs';

const NOW = 1_000_000;
const netscape = (domain, sub, name, expiry = 2_000_000) => `${domain}\t${sub}\t/\tTRUE\t${expiry}\t${name}\tsecret`;

test('Netscape: ведущая точка домена сохраняется', () => {
  const [cookie] = parseCookies(netscape('.deviantart.com', 'TRUE', 'auth'), NOW);
  assert.equal(cookie.domain, '.deviantart.com');
  assert.equal(cookie.secure, true);
});

test('Netscape: домен с подстановкой поддоменов получает точку', () => {
  const [cookie] = parseCookies(netscape('deviantart.com', 'TRUE', 'auth'), NOW);
  assert.equal(cookie.domain, '.deviantart.com');
});

test('Netscape: куки одного хоста остаются без точки', () => {
  const [cookie] = parseCookies(netscape('www.deviantart.com', 'FALSE', 'lng'), NOW);
  assert.equal(cookie.domain, 'www.deviantart.com');
});

test('Netscape: читается префикс #HttpOnly_, комментарии пропускаются', () => {
  const text = `# Netscape HTTP Cookie File\n#HttpOnly_${netscape('.deviantart.com', 'TRUE', 'auth')}`;
  const cookies = parseCookies(text, NOW);
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].httpOnly, true);
});

test('Просроченные и чужие куки отбрасываются', () => {
  const text = [
    netscape('.deviantart.com', 'TRUE', 'old', NOW - 1),
    netscape('.example.com', 'TRUE', 'foreign'),
    netscape('.notdeviantart.com', 'TRUE', 'lookalike'),
    netscape('.deviantart.com', 'TRUE', 'auth'),
  ].join('\n');
  assert.deepEqual(parseCookies(text, NOW).map(cookie => cookie.name), ['auth']);
});

test('Сессионная кука без срока не считается просроченной', () => {
  assert.equal(parseCookies(netscape('.deviantart.com', 'TRUE', 'td', 0), NOW).length, 1);
});

test('JSON из Cookie-Editor', () => {
  const text = JSON.stringify([
    { name: 'auth', value: 'x', domain: 'deviantart.com', hostOnly: false, path: '/', secure: true, expirationDate: 2_000_000.5 },
    { name: 'lng', value: 'en', domain: 'www.deviantart.com', hostOnly: true, path: '/', secure: true },
  ]);
  const [auth, lng] = parseCookies(text, NOW);
  assert.equal(auth.domain, '.deviantart.com');
  assert.equal(auth.expiry, 2_000_000);
  assert.equal(lng.domain, 'www.deviantart.com');
});

test('Строка заголовка Cookie', () => {
  const cookies = parseCookies('Cookie: auth=a=b; lng=en', NOW);
  assert.deepEqual(cookies.map(({ name, value, domain }) => [name, value, domain]),
    [['auth', 'a=b', '.deviantart.com'], ['lng', 'en', '.deviantart.com']]);
});

test('hasSession ищет только куки авторизации', () => {
  assert.equal(hasSession(parseCookies('auth_secure=x', NOW)), true);
  assert.equal(hasSession(parseCookies('lng=en', NOW)), false);
});

test('extractCss снимает обёртки Stylus', () => {
  const css = extractCss(`/* ==UserStyle==
@name x
==/UserStyle== */
@-moz-document domain("deviantart.com") {
  @media (max-width: 700px) { a { color: red; } }
}
`);
  assert.equal(css, '@media (max-width: 700px) { a { color: red; } }');
});
