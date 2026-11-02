// Минимальный клиент WebDriver BiDi для обычного Firefox, без зависимостей.
// Каждый запуск — отдельный процесс с временным профилем: профиль пользователя
// и уже открытый Firefox не затрагиваются.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0';
const LAUNCH_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 90_000;

const live = new Set();
process.on('exit', () => { for (const proc of live) proc.kill('SIGKILL'); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => process.exit(130));
}

function waitForEndpoint(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Firefox не открыл порт BiDi за 30 с')), LAUNCH_TIMEOUT_MS);
    let output = '';
    proc.stderr.on('data', chunk => {
      output += chunk;
      const match = output.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`Не удалось запустить Firefox: ${error.message}`));
    });
    proc.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Firefox завершился при запуске, код ${code}`));
    });
  });
}

function unwrap(value) {
  if (!value) return value;
  if (['string', 'number', 'boolean'].includes(value.type)) return value.value;
  if (value.type === 'null' || value.type === 'undefined') return null;
  if (value.type === 'array') return value.value.map(unwrap);
  if (value.type === 'object') return Object.fromEntries(value.value.map(([key, item]) => [key, unwrap(item)]));
  return value.value ?? value.type;
}

export async function launch({ binary = 'firefox', width = 400, height = 900, prefs = {} } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'deviantart-fix-ff-'));
  writeFileSync(join(profile, 'user.js'), Object.entries({
    'general.useragent.override': UA,
    'dom.w3c_touch_events.enabled': 1,
    'browser.shell.checkDefaultBrowser': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.enabled': false,
    'app.update.enabled': false,
    ...prefs,
  }).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));

  const proc = spawn(binary, ['--headless', '--no-remote', '--profile', profile,
    '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  live.add(proc);
  const exited = new Promise(resolve => proc.once('exit', resolve));

  const cleanup = async () => {
    proc.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    proc.kill('SIGKILL');
    live.delete(proc);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  try {
    const endpoint = await waitForEndpoint(proc);
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${endpoint}/session`);
      socket.onopen = () => resolve(socket);
      socket.onerror = () => reject(new Error('Не удалось подключиться к BiDi'));
    });

    let lastId = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(timer);
        if (message.type === 'error') reject(new Error(`${message.error}: ${message.message}`));
        else resolve(message.result);
      } else if (message.method && listeners.has(message.method)) {
        listeners.get(message.method)(message.params);
      }
    };

    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++lastId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Таймаут команды ${method}`));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('session.new', { capabilities: {} });
    const { contexts } = await send('browsingContext.getTree', {});
    const context = contexts[0].context;
    await send('browsingContext.setViewport', { context, viewport: { width, height } });

    return {
      goto: url => send('browsingContext.navigate', { context, url, wait: 'interactive' }),

      eval: async expression => {
        const result = await send('script.evaluate', {
          expression, target: { context }, awaitPromise: true, resultOwnership: 'none',
        });
        if (result.type === 'exception') throw new Error(`Ошибка в странице: ${result.exceptionDetails.text}`);
        return unwrap(result.result);
      },

      preload: functionDeclaration => send('script.addPreloadScript', { functionDeclaration, contexts: [context] }),

      // Значение куки в сообщения об ошибках не попадает: наружу уходит только имя.
      setCookies: async cookies => {
        const failed = [];
        for (const { name, value, expiry, ...rest } of cookies) {
          const cookie = { name, value: { type: 'string', value }, ...rest };
          if (expiry) cookie.expiry = expiry;
          try {
            await send('storage.setCookie', { cookie });
          } catch {
            failed.push(name);
          }
        }
        return failed;
      },

      // Держит запросы к хосту delayMs миллисекунд, как медленная сеть телефона.
      delayRequests: async (hostname, delayMs) => {
        await send('session.subscribe', { events: ['network.beforeRequestSent'] });
        await send('network.addIntercept', { phases: ['beforeRequestSent'], urlPatterns: [{ type: 'pattern', hostname }] });
        listeners.set('network.beforeRequestSent', params => {
          if (!params.isBlocked) return;
          setTimeout(() => send('network.continueRequest', { request: params.request.request }).catch(() => {}), delayMs);
        });
      },

      screenshot: async path => {
        const { data } = await send('browsingContext.captureScreenshot', { context });
        writeFileSync(path, Buffer.from(data, 'base64'));
      },

      close: async () => {
        await Promise.race([send('browser.close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]);
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
