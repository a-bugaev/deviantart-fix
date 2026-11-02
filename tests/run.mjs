#!/usr/bin/env node
// Проверка стиля на живой ленте DeviantArt. Описание и примеры: tests/README.md.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { hasSession, loadCookies } from './lib/cookies.mjs';
import { outPath, runBottomBar, runImages, runScroll } from './lib/scenarios.mjs';
import { defaultStylePath, loadStyle } from './lib/usercss.mjs';

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testsDir, '..');

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INVALID = 2;

const PAGES = {
  tag: 'https://www.deviantart.com/tag/squirrel',
  morelikethis: 'https://www.deviantart.com/morelikethis/OliverBPhotography/1123582209',
  home: 'https://www.deviantart.com/',
  search: 'https://www.deviantart.com/search?q=squirrel',
  daily: 'https://www.deviantart.com/daily-deviations',
  gallery: 'https://www.deviantart.com/oliverbphotography/gallery',
  favourites: 'https://www.deviantart.com/oliverbphotography/favourites',
  profile: 'https://www.deviantart.com/oliverbphotography',
  watch: 'https://www.deviantart.com/watch/deviations',
};
const ANON_PAGES = ['tag', 'morelikethis', 'home'];
const LOGGED_IN_PAGES = Object.keys(PAGES);

const HELP = `Использование: node tests/run.mjs [параметры]

  --css <файл|ref|none>   какую версию проверять (по умолчанию файл стиля в репозитории)
  --compare <файл|ref>    прогнать ещё одну версию и показать рядом
  --pages <список>        ${Object.keys(PAGES).join(', ')} или URL через запятую
  --cookies <файл>        куки тестового аккаунта (по умолчанию cookies.txt в tests/ или в корне)
  --anon                  не использовать куки, даже если файл есть
  --steps <n>             шагов прокрутки вниз (по умолчанию 60)
  --delay <мс>            задержка картинок в сценарии медленной сети (по умолчанию 500)
  --no-images             пропустить сценарии с загрузкой картинок
  --no-banner             пропустить проверку плашки веб-приложения
  --no-control            пропустить контрольный прогон
  --firefox <путь>        исполняемый файл Firefox
  --out <папка>           куда сохранить отчёт и скриншоты (по умолчанию tests/out)
  --help                  эта справка

Код выхода: 0 — пройдено, 1 — есть провал, 2 — проверка недействительна.`;

const { values: args } = parseArgs({
  options: {
    css: { type: 'string' },
    compare: { type: 'string' },
    pages: { type: 'string' },
    cookies: { type: 'string' },
    anon: { type: 'boolean', default: false },
    steps: { type: 'string', default: '60' },
    delay: { type: 'string', default: '500' },
    'no-images': { type: 'boolean', default: false },
    'no-banner': { type: 'boolean', default: false },
    'no-control': { type: 'boolean', default: false },
    firefox: { type: 'string', default: process.env.FIREFOX_BIN ?? 'firefox' },
    out: { type: 'string', default: join(testsDir, 'out') },
    help: { type: 'boolean', default: false },
  },
});

if (args.help) {
  console.log(HELP);
  process.exit(EXIT_PASS);
}

const invalid = message => {
  console.error(`\nПРОВЕРКА НЕДЕЙСТВИТЕЛЬНА: ${message}`);
  process.exit(EXIT_INVALID);
};

function resolveCookies() {
  if (args.anon) return null;
  const path = args.cookies ?? [join(testsDir, 'cookies.txt'), join(repoRoot, 'cookies.txt')].find(existsSync);
  if (!path) return null;
  if (!existsSync(path)) invalid(`нет файла ${path}`);
  const cookies = loadCookies(path);
  if (!hasSession(cookies)) invalid('в файле нет действующих куки auth / auth_secure');
  return cookies;
}

const cookies = resolveCookies();
const firefox = args.firefox;
const steps = Number(args.steps);
const delayMs = Number(args.delay);
const pageKeys = args.pages ? args.pages.split(',') : cookies ? LOGGED_IN_PAGES : ANON_PAGES;
const pages = pageKeys.map(key => ({ key, url: PAGES[key] ?? key }));
for (const { key, url } of pages) {
  if (!/^https?:\/\//.test(url)) invalid(`неизвестная страница ${key}`);
}

mkdirSync(args.out, { recursive: true });

function loadOrExit(spec) {
  try {
    return loadStyle(spec, repoRoot);
  } catch {
    return invalid(`не удалось загрузить версию стиля «${spec}»: это не файл и не git-ссылка`);
  }
}

const style = loadOrExit(args.css ?? defaultStylePath(repoRoot));
const compare = args.compare ? loadOrExit(args.compare) : null;
const control = loadStyle(join(testsDir, 'fixtures/control-0.2.0.user.css'), repoRoot);

// Вердикт по одной проверке: fail — провал, known — известная открытая проблема, ok — норма.
function checks(scroll, images) {
  const out = [];
  const add = (name, level, detail) => out.push({ name, level, detail });
  const motion = part => `сдвигов ${part.jumps}/${part.steps}, до ${part.maxJump}px; пусто до ${part.peakBlank}px`;
  // Если все карточки на месте, выгрузки не было: сдвиг дала догрузившаяся картинка,
  // это открытая проблема №4. Если строки выгружались, это возврат скачков.
  const motionLevel = part => {
    if (part.peakBlank || (part.jumps && part.mounted < part.rows)) return 'fail';
    return part.jumps ? 'known' : 'ok';
  };

  if (scroll) {
    const grew = scroll.idle.after - scroll.idle.before;
    add('Нет догрузки без прокрутки', grew > 0 ? 'fail' : 'ok', `строк ${scroll.idle.before} → ${scroll.idle.after}`);
    add('Прокрутка вниз', motionLevel(scroll.down), motion(scroll.down));
    add('Прокрутка вверх', motionLevel(scroll.up), motion(scroll.up));
    add('Быстрая прокрутка', motionLevel(scroll.fast), motion(scroll.fast));
    if (scroll.layout.checked) {
      add('Картинки без обрезки', scroll.layout.cropped ? 'fail' : 'ok', `обрезано ${scroll.layout.cropped} из ${scroll.layout.checked}`);
    } else {
      add('Картинки без обрезки', 'info', 'не проверено: на странице нет строк с одной карточкой');
    }
    if (scroll.layout.avatars) {
      add('Аватары не растянуты', scroll.layout.stretched ? 'fail' : 'ok', `растянуто ${scroll.layout.stretched} из ${scroll.layout.avatars}`);
    } else {
      add('Аватары не растянуты', 'info', 'не проверено: на странице нет заглушек аватаров');
    }
    add('Размер ленты', 'info', `строк ${scroll.down.rows}, с карточкой ${scroll.down.mounted}, элементов DOM ${scroll.down.nodes}`);
  }
  for (const run of images) {
    const label = run.delayMs ? `задержка ${run.delayMs} мс` : 'без задержки';
    const part = (name, data, failing) => {
      const title = `Картинки, ${label}: ${name}`;
      if (!data.steps) return add(title, 'info', 'не проверено: прокручивать некуда');
      return add(title, data.jumps ? (failing ? 'fail' : 'known') : 'ok', `сдвигов ${data.jumps}/${data.steps}, до ${data.maxJump}px`);
    };
    part('чтение', run.read, true);
    part('быстро вниз', run.brisk, false);
    part('назад', run.back, false);
  }
  return out;
}

const report = { style: style.label, compare: compare?.label ?? null, loggedIn: Boolean(cookies), pages: [], control: null };
const log = message => console.log(message);

log(`Версия: ${style.label}${compare ? `, сравнение: ${compare.label}` : ''}`);
log(`Куки: ${cookies ? `тестовый аккаунт (${cookies.length} шт., значения не выводятся)` : 'нет, анонимно'}`);

async function runVariant(variant, { url, key }, label) {
  const screenshotPath = outPath(args.out, `${key.replace(/\W+/g, '_').slice(-40)}-${label}.png`);
  log(`  ${label}: прокрутка...`);
  const scroll = await runScroll({ style: variant, url, cookies, firefox, steps, screenshotPath });
  if (!scroll.feed) return { feed: false, scroll };
  if (cookies && scroll.page.loggedIn === false) invalid('сайт не принял куки: сессия истекла или вы вышли из аккаунта');
  const images = [];
  if (!args['no-images']) {
    for (const delay of [0, delayMs]) {
      log(`  ${label}: картинки, задержка ${delay} мс...`);
      const run = await runImages({ style: variant, url, cookies, firefox, delayMs: delay, steps });
      if (run.feed) images.push(run);
    }
  }
  return { feed: true, scroll, images, checks: checks(scroll, images) };
}

const MARK = { ok: 'ok  ', fail: 'FAIL', known: 'warn', info: '    ' };

let failed = false;
let tested = 0;
let controlPage = null;

for (const page of pages) {
  log(`\n== ${page.key}`);
  const main = await runVariant(style, page, 'main');
  if (!main.feed) {
    log(`  пропущено: на странице нет ленты с карточками (${main.scroll.page.path})`);
    report.pages.push({ ...page, skipped: true });
    continue;
  }
  tested++;
  controlPage ??= page;
  const other = compare ? await runVariant(compare, page, 'compare') : null;

  for (const check of main.checks) {
    if (check.level === 'fail') failed = true;
    log(`  ${MARK[check.level]} ${check.name}: ${check.detail}`);
    const peer = other?.checks?.find(item => item.name === check.name);
    if (peer) log(`       ${compare.label}: ${peer.detail}`);
  }
  if (cookies && main.scroll.down.rows <= main.scroll.idle.before) {
    log('  warn Лента не выросла при прокрутке: бесконечная подгрузка не проверена');
  }
  report.pages.push({ ...page, main, compare: other });
}

if (!tested) invalid('ни на одной странице нет ленты. Вёрстка сайта могла измениться или включилась защита от ботов.');

// Плашка показывается только под логином, поэтому без куки проверить её нельзя.
if (!args['no-banner']) {
  log(`\n== плашка веб-приложения на ${controlPage.key}`);
  if (!cookies) {
    log('       не проверено: нужны куки');
  } else {
    const bar = await runBottomBar({ style, url: controlPage.url, cookies, firefox, screenshotPath: outPath(args.out, 'bottom-bar.png') });
    report.bottomBar = bar;
    if (!bar.feed || !bar.rendered) {
      log('       не проверено: сайт не показал плашку');
    } else {
      if (bar.covering) failed = true;
      log(`  ${bar.covering ? MARK.fail : MARK.ok} Низ экрана свободен: закреплённых элементов ${bar.covering}`);
    }
  }
}

// Контроль самого теста: в версии 0.2.0 скачки точно есть. Если тест их не видит,
// его нули ничего не значат.
if (!args['no-control']) {
  log(`\n== контроль: версия ${control.label} на ${controlPage.key} должна дать скачки`);
  const run = await runScroll({ style: control, url: controlPage.url, cookies, firefox, steps, idle: false });
  const seen = run.feed ? run.down.jumps + run.up.jumps + run.fast.jumps : 0;
  report.control = { version: control.label, page: controlPage.key, jumps: seen };
  log(`  найдено сдвигов: ${seen}`);
  if (!seen) {
    writeFileSync(join(args.out, 'report.json'), JSON.stringify(report, null, 2));
    invalid('контрольная версия не дала скачков, тест их не видит. Его результатам верить нельзя.');
  }
}

writeFileSync(join(args.out, 'report.json'), JSON.stringify(report, null, 2));
log(`\nОтчёт: ${join(args.out, 'report.json')}`);
log(failed ? 'ИТОГ: ЕСТЬ ПРОВАЛЫ' : 'ИТОГ: ПРОЙДЕНО');
process.exit(failed ? EXIT_FAIL : EXIT_PASS);
