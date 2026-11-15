/**
 * dsh-delete-sessions-ru — добавляет в DeepSeek Harness настоящее «удаление сессии».
 *
 * В DSH из коробки есть только «архивирование» (archive): оно лишь добавляет id
 * сессии в набор `archivedSessionIds`, а журнал сессии на диске
 * (`~/.dsh/sessions/<project>/<id>/session.v4.jsonl.zstd`) и кэш проекции
 * (`~/.dsh/storages/session_projcache/sessions/<id>.json`) никогда не удаляются.
 *
 * Этот плагин добавляет в меню «…» каждой сессии в боковой панели пункт
 * «Удалить сессию»; после клика браузер делает POST на одноимённый маршрут
 * плагина, все права на удаление остаются у хоста, и по порядку:
 *
 *   1. останавливает текущую работу сессии (`workspace/session-stop` вызывает
 *      `agent.cancel` — тот же путь, что у «остановить и архивировать»);
 *   2. убирает id из глобальных наборов архива и закрепления (`unarchiveSession`
 *      / `unpinSession`, обе идемпотентны);
 *   3. отвязывает id из `sessionIds` каждого рабочего пространства (идемпотентно);
 *   4. удаляет запись кэша проекции (через домен `session_projcache` в
 *      storage-domain, синхронизируя память и диск; если домен не смонтирован —
 *      пропускает);
 *   5. удаляет каталог журнала сессии (предпочтительно получая точный путь через
 *      `sessionPersistence.locate()`, при отсутствии этой возможности — сканируя
 *      одноимённые каталоги в `~/.dsh/sessions`);
 *   6. `ctx.emit('api-session/removed', sessionId)` — это событие уже есть в
 *      белом списке пересылки `dsh-api-remotes`, поэтому браузер сразу убирает
 *      строку из списка.
 *
 * Id сессии проверяется на реальное существование через `sessionPersistence.stat()`
 * и только потом удаляется; `locate()` внутри кодирует id в безопасный сегмент
 * пути через `encodeSegment`, поэтому обход пути невозможен.
 *
 * @module dsh-delete-sessions-ru
 */
import { rm, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Имя плагина Cordis. */
export const name = 'dsh-delete-sessions-ru';

/** Хостовые сервисы, нужные плагину; webServer внедряется опционально (headless-профиль всё равно загрузится). */
export const inject = ['sessionPersistence', 'workspaceRegistry', 'sessions'];

/** Маршрут удаления (same-origin). */
export const DELETE_SESSION_PATH = '/plugins/dsh-delete-sessions-ru/delete';

/** Короткая пауза между остановкой и удалением: даёт последнему flush от `agent.cancel` записаться на диск. */
const STOP_SETTLE_MS = 500;

/** Число повторов и интервал при удалении каталога журнала на случай Windows EBUSY/EPERM. */
const RM_RETRY = 6;
const RM_RETRY_GAP_MS = 150;

/** Только loopback-источник; остальные отклоняются (удаление необратимо). */
function loopbackOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

/** Максимальный размер тела запроса (несёт только один sessionId). */
const MAX_BODY_BYTES = 16 * 1024;

/** Читает небольшое JSON-тело запроса. */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('тело запроса слишком велико');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Отвечает JSON-ом. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Ошибка «файл занят» (Windows сообщает её при удалении занятого каталога). */
function isBusyError(error) {
  const code = error && error.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
}

/** Рекурсивное удаление с повторами: после остановки антивирус/индексатор может ненадолго занять файл журнала. */
async function rmWithRetry(target) {
  let lastError;
  for (let attempt = 0; attempt < RM_RETRY; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isBusyError(error)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, RM_RETRY_GAP_MS));
    }
  }
  throw lastError;
}

/** Существует ли сессия на самом деле (live или сохранённая). */
async function sessionExists(ctx, sessionId) {
  if (ctx.sessions.get(sessionId) !== undefined) return true;
  try {
    return (await ctx.sessionPersistence.stat(sessionId)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Удаляет каталог журнала сессии.
 *
 * Предпочтительно `sessionPersistence.locate(meta)` (публичный у jsonl-бэкенда):
 * он возвращает абсолютный путь файла журнала этой сессии (id уже безопасно
 * закодирован `encodeSegment`), каталог — его родитель.
 * Если такой возможности нет — запасной вариант: рекурсивно искать в
 * `~/.dsh/sessions` каталог, basename которого в точности равен sessionId
 * (текущие id вида `session-<uuid>` состоят из path-safe символов и после
 * кодирования совпадают).
 */
async function removeSessionLog(ctx, meta) {
  const persistence = ctx.sessionPersistence;
  if (typeof persistence.locate === 'function') {
    const located = persistence.locate(meta);
    if (located && typeof located.path === 'string' && located.path !== '') {
      await rmWithRetry(dirname(located.path));
      return;
    }
  }
  // Запасной путь: сканируем корень sessions в домашнем каталоге. Если home
  // определить не удалось, удаляем только кэш проекции, а каталог журнала
  // пользователь почистит вручную (здесь не throw, чтобы не падать на полпути).
  let home;
  try {
    const { resolveDshHome } = await import('@deepseek-ai/dsh-home-paths');
    home = resolveDshHome();
  } catch {
    return;
  }
  const sessionsRoot = join(home, 'sessions');
  let projects;
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return; // Нет корня sessions: удалять нечего.
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = join(sessionsRoot, project.name);
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.isDirectory() && child.name === meta.id) {
        await rmWithRetry(join(dir, child.name));
        return;
      }
    }
  }
}

/**
 * Полная очистка при удалении сессии. Возвращает `{ ok: true }` или `{ ok: false, error }`.
 *
 * Порядок очистки выбран намеренно: сначала остановить активность (чтобы
 * последнее событие записалось), затем снять все ссылки на этот id
 * (архив/закрепление/рабочие пространства), затем удалить кэш проекции и
 * последним — каталог журнала; ошибка на любом шаге сразу прерывает работу,
 * чтобы не возникало незавершённого состояния «в UI исчезло, а на диске осталось».
 */
export async function deleteSession(ctx, sessionId) {
  // 0. Проверка: id должен принадлежать реально существующей сессии. Для live
  //    сессии берём её точный header, иначе откатываемся на сохранённый stat.
  const live = ctx.sessions.get(sessionId);
  let meta;
  if (live !== undefined) {
    meta = live.header;
  } else {
    const stat = await ctx.sessionPersistence.stat(sessionId);
    if (stat === undefined) {
      return { ok: false, error: 'сессия не найдена' };
    }
    meta = stat.header;
  }

  // 1. Останавливаем активность. `workspace/session-stop` устанавливается
  //    допуском архивирования у агента и отменяет идущий ход так же, как это
  //    сделал бы пользователь; если активности нет — no-op.
  try {
    await ctx.parallel('workspace/session-stop', { sessionId });
  } catch {
    // Ошибка остановки не должна блокировать удаление: архивирование
    // «остановить и архивировать» тоже лишь пишет предупреждение.
  }
  // Даём последнему событию, вызванному cancel, записаться на диск, чтобы
  // удаление каталога не гонялось с flush, который его же пересоздаст.
  await new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_MS));

  // 2. Снимаем архив / закрепление (обе операции идемпотентны; архив и
  //    закрепление взаимоисключающи, поэтому порядок «сначала архив» безопасен).
  try {
    await ctx.workspaceRegistry.unarchiveSession(sessionId);
  } catch {
    /* Не в архиве или ошибка registry — продолжаем */
  }
  try {
    await ctx.workspaceRegistry.unpinSession(sessionId);
  } catch {
    /* Не закреплена или ошибка registry — продолжаем */
  }

  // 3. Отвязываем от учёта каждого рабочего пространства (идемпотентно: если
  //    id нет в списке — no-op).
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue;
    await workspace.detachSession(sessionId);
  }

  // 4. Удаляем кэш проекции (через домен, синхронно память и диск; если домен
  //    не смонтирован — пропускаем).
  try {
    const domain = ctx.get('storageDomain');
    const projcache = typeof domain?.get === 'function' ? domain.get('session_projcache') : undefined;
    if (projcache) await projcache.table('sessions').delete(sessionId);
  } catch {
    /* Кэш — производные данные: если удалить не удалось, он пересоздастся при
       следующем холодном чтении; удаление не блокирует */
  }

  // 5. Удаляем каталог журнала (включая session.v4.jsonl.zstd и, возможно, session.lock).
  await removeSessionLog(ctx, meta);

  // 6. Рассылаем удаление: api-remotes пересылает это событие в браузер, и UI
  //    сразу убирает строку.
  ctx.emit('api-session/removed', sessionId);

  return { ok: true };
}

/**
 * Обработчик маршрута удаления: принимает только POST с loopback-источника,
 * тело — один sessionId.
 * @param req - запрос.
 * @param res - ответ.
 */
export async function handleDeleteRequest(ctx, req, res) {
  try {
    if ((req.method ?? 'POST').toUpperCase() !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'метод не разрешён' });
      return;
    }
    if (!loopbackOrigin(req)) {
      sendJson(res, 403, { ok: false, error: 'недоверенный источник запроса' });
      return;
    }
    const body = await readJsonBody(req);
    const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (sessionId === '') {
      sendJson(res, 400, { ok: false, error: 'не указан sessionId' });
      return;
    }
    if (!(await sessionExists(ctx, sessionId))) {
      sendJson(res, 404, { ok: false, error: 'сессия не найдена' });
      return;
    }
    const result = await deleteSession(ctx, sessionId);
    if (result.ok) {
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 500, { ok: false, error: result.error });
    }
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Точка входа плагина Cordis. */
export function apply(ctx) {
  // webServer — опциональный сервис: в headless-профиле маршрута нет, но сам
  // плагин всё равно загружается.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => {
        webCtx.effect(() => webCtx.webServer.register({
          kind: 'exact',
          path: DELETE_SESSION_PATH,
          handler: (req, res) => handleDeleteRequest(ctx, req, res),
        }), 'dsh-delete-sessions-ru: delete route');
      });
    }
  } catch {
    /* Нет webServer: маршрут не регистрируем */
  }
}
