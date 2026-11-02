// Загрузка версии стиля: из файла или из git, и превращение её в обычный CSS.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Обёртку ==UserStyle== и @-moz-document применяет Stylus, странице нужно только содержимое.
export function extractCss(source) {
  const body = source.replace(/\/\* ==UserStyle==[\s\S]*?==\/UserStyle== \*\//, '');
  const wrapper = body.indexOf('@-moz-document');
  if (wrapper === -1) return body.trim();
  return body.slice(body.indexOf('{', wrapper) + 1, body.lastIndexOf('}')).trim();
}

// spec — путь к файлу, git-ссылка (`main`, `07427a6`) или `none` для страницы без стиля.
export function loadStyle(spec, repoRoot) {
  if (spec === 'none') return { label: 'без стиля', css: '' };
  const source = existsSync(spec)
    ? readFileSync(spec, 'utf8')
    : execFileSync('git', ['-C', repoRoot, 'show', `${spec}:deviantart-fix.user.css`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const version = source.match(/@version\s+(\S+)/)?.[1];
  return { label: version ? `${version}` : spec, css: extractCss(source) };
}

export const defaultStylePath = repoRoot => join(repoRoot, 'deviantart-fix.user.css');
