// Сценарии проверки одной страницы. Прогоны идут строго по очереди: параллельные
// сессии одного аккаунта мешают друг другу и дают недействительные данные.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './firefox.mjs';

const IMAGE_HOST = 'images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com';
const FEED_TIMEOUT_MS = 20_000;
const SETTLE_AFTER_LOAD_MS = 3000;
const IDLE_MS = 10_000;
const STEP_SETTLE_MS = 600;
const FAST_SETTLE_MS = 400;
const END_OF_FEED_STEPS = 4;

const probeSource = readFileSync(new URL('./probe.browser.js', import.meta.url), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Плашка показывается только аккаунтам старше 30 дней, а тестовому может быть меньше.
// Дата меняется только в данных страницы и только в этом браузере.
const AGE_ACCOUNT = `(() => {
  const parse = JSON.parse;
  JSON.parse = function (text, ...rest) {
    const aged = typeof text === 'string' ? text.replace(/("joinDate"\\s*:\\s*")[^"]+/g, '$12015-01-01T00:00:00-0800') : text;
    return parse.call(this, aged, ...rest);
  };
})();`;

async function openFeed({ style, url, cookies, firefox, prefs, delayMs, agedAccount }) {
  const browser = await launch({ binary: firefox, prefs });
  try {
    if (cookies) {
      const failed = await browser.setCookies(cookies);
      if (failed.length) throw new Error(`Браузер не принял куки: ${failed.join(', ')}`);
    }
    // Стиль ставится до скриптов страницы, как это делает расширение.
    await browser.preload(`() => {
      ${agedAccount ? AGE_ACCOUNT : ''}
      const css = ${JSON.stringify(style.css)};
      if (!css) return;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }`);
    if (delayMs) await browser.delayRequests(IMAGE_HOST, delayMs);
    await browser.goto(url);

    const started = Date.now();
    let found = false;
    while (!found && Date.now() - started < FEED_TIMEOUT_MS) {
      found = await browser.eval(`!!document.querySelector('[data-testid="grid-row"] section')`);
      if (!found) await sleep(500);
    }
    const page = await browser.eval(`(() => {
      const state = document.documentElement.outerHTML.match(/isLoggedIn\\\\?"?\\s*:\\s*(true|false)/);
      return { path: location.pathname, loggedIn: state ? state[1] === 'true' : null };
    })()`);
    if (!found) return { browser, page, feed: false };
    await sleep(SETTLE_AFTER_LOAD_MS);
    await browser.eval(probeSource);
    return { browser, page, feed: true };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// Прокрутка до конца ленты или до лимита шагов. Шаги без движения не учитываются.
async function walk(browser, dy, maxSteps, settleMs) {
  const steps = [];
  let stuck = 0;
  while (steps.length < maxSteps && stuck < END_OF_FEED_STEPS) {
    const step = await browser.eval(`__dafix.step(${dy}, ${settleMs})`);
    stuck = step.moved ? 0 : stuck + 1;
    if (step.moved) steps.push(step);
  }
  return steps;
}

function summarize(steps) {
  if (!steps.length) return { steps: 0, jumps: 0, maxJump: 0, peakBlank: 0, endBlank: 0 };
  return {
    steps: steps.length,
    jumps: steps.filter(step => step.maxJump > 0).length,
    maxJump: Math.max(...steps.map(step => step.maxJump)),
    peakBlank: Math.max(...steps.map(step => step.peakBlank)),
    endBlank: Math.max(...steps.map(step => step.endBlank)),
    ...Object.fromEntries(['rows', 'mounted', 'doc', 'nodes'].map(key => [key, steps.at(-1)[key]])),
  };
}

// Scroll anchoring выключен: на телефоне он отключается сам после серии подстроек,
// а при включённом браузер компенсирует сдвиг, и тест его не увидит.
export async function runScroll({ style, url, cookies, firefox, steps, screenshotPath, idle = true }) {
  const { browser, page, feed } = await openFeed({
    style, url, cookies, firefox, prefs: { 'layout.css.scroll-anchoring.enabled': false },
  });
  try {
    if (!feed) return { page, feed: false };
    const initial = await browser.eval('__dafix.counts()');
    if (idle) await sleep(IDLE_MS);
    const afterIdle = await browser.eval('__dafix.counts()');
    const down = await walk(browser, 450, steps, STEP_SETTLE_MS);
    if (screenshotPath) await browser.screenshot(screenshotPath);
    const up = await walk(browser, -450, Math.ceil(steps * 2 / 3), STEP_SETTLE_MS);
    const fast = await walk(browser, 2500, 8, FAST_SETTLE_MS);
    const layout = await browser.eval('__dafix.layout()');
    return {
      page,
      feed: true,
      idle: { before: initial.rows, after: afterIdle.rows },
      down: summarize(down),
      up: summarize(up),
      fast: summarize(fast),
      layout,
    };
  } finally {
    await browser.close();
  }
}

// Scroll anchoring как в обычном браузере, загрузка картинок задержана. Чтение и быстрая
// прокрутка идут в разных сессиях: иначе короткая лента закончится ещё при чтении,
// а картинки уже будут в кэше, и быстрой прокрутке будет нечего проверять.
export async function runImages({ style, url, cookies, firefox, delayMs, steps }) {
  const options = { style, url, cookies, firefox, delayMs };
  const reading = await openFeed(options);
  let read;
  try {
    if (!reading.feed) return { page: reading.page, feed: false };
    read = await walk(reading.browser, 200, Math.min(30, steps), 500);
  } finally {
    await reading.browser.close();
  }

  const fast = await openFeed(options);
  try {
    if (!fast.feed) return { page: fast.page, feed: false };
    const brisk = await walk(fast.browser, 900, Math.min(20, steps), 500);
    const back = await walk(fast.browser, -600, Math.min(16, steps), 500);
    return { page: fast.page, feed: true, delayMs, read: summarize(read), brisk: summarize(brisk), back: summarize(back) };
  } finally {
    await fast.browser.close();
  }
}

// Настоящая плашка веб-приложения: кука pwai хранит её закрытие, поэтому без неё.
export async function runBottomBar({ style, url, cookies, firefox, screenshotPath }) {
  const { browser, feed } = await openFeed({
    style, url, firefox, agedAccount: true, cookies: cookies.filter(cookie => cookie.name !== 'pwai'),
  });
  try {
    if (!feed) return { feed: false };
    const result = await browser.eval('__dafix.bottomBar()');
    if (screenshotPath) await browser.screenshot(screenshotPath);
    return { feed: true, ...result };
  } finally {
    await browser.close();
  }
}

export const outPath = (dir, name) => join(dir, name);
