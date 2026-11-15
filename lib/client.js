/**
 * dsh-delete-sessions-ru — браузерная часть.
 *
 * Добавляет в меню «…» каждой сессии в боковой панели **красный** пункт
 * «Удалить сессию» — сразу под «Архивировать сессию» (order 400) и над
 * «Копировать Session ID» (order 450), то есть order 410.
 *
 * Пункт меню использует хостовые MenuItemButton + иконку Fluent и несёт
 * `danger: true`, поэтому вся строка окрашивается в опасный цвет хоста
 * (`--dsw-alias-state-error-primary`) — тем же путём, что и «Удалить рабочее
 * пространство», поэтому цвет/отступы/размер шрифта совпадают сами собой.
 *
 * Диалог подтверждения размещён в слоте **`shell.overlay`**, а не внутри
 * компонента пункта меню: при клике пункт вызывает `setMenuOpen(false)`,
 * меню закрывается и весь компонент размонтируется — если рендерить Modal
 * внутри него, окно уничтожалось бы сразу после появления (именно это и есть
 * причина «нажал — ничего не произошло»). Здесь повторяется структура
 * хостового «подтверждения архивирования»:
 *   - в области видимости плагина `createSnapshotStore(null)` хранит
 *     «запрос, ожидающий подтверждения»;
 *   - пункт меню получает этот store через `inject` слота и при клике лишь
 *     делает `store.set({...})`;
 *   - `shell.overlay` регистрирует постоянно смонтированный компонент,
 *     который через `hooks: { deleteRequest }` получает hook
 *     `useDeleteRequest` и рендерит Modal, когда запрос есть.
 *
 * После подтверждения выполняется POST на хостовый маршрут
 * `/plugins/dsh-delete-sessions-ru/delete`; при успехе хост рассылает
 * `api-session/removed`, и строка списка исчезает автоматически.
 *
 * Браузерный бандл в форме рукописного CommonJS (как dsh-plugin-poker):
 * `window.__ModuleLoader__.load({id, factory})`, `require` платформенных
 * `react`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-store`.
 *
 * @module dsh-delete-sessions-ru/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-delete-sessions-ru',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { MenuItemButton, Modal, Button, IconTrashOutlineRegular } = primitives;
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');

    /** Хостовый маршрут удаления (same-origin). */
    const DELETE_SESSION_PATH = '/plugins/dsh-delete-sessions-ru/delete';

    /** Классы опасной кнопки / вторичного текста (стили вставляются тегом style ниже). */
    const DANGER_BUTTON_CLASS = 'dsh-delete-sessions-ru-danger';
    const DIALOG_META_CLASS = 'dsh-delete-sessions-ru-meta';
    const STYLE_ID = 'dsh-delete-sessions-ru-style';

    /** Стили внедряются один раз: опасный цвет берётся из семантических переменных хоста и следует теме. */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        '.' + DANGER_BUTTON_CLASS + ':not(:disabled){',
        '  color: var(--dsw-alias-state-error-primary);',
        '  border-color: var(--dsw-alias-state-error-primary);',
        '}',
        '.' + DANGER_BUTTON_CLASS + ':not(:disabled):hover{',
        '  background: var(--dsw-alias-state-error-primary);',
        '  color: var(--dsw-alias-label-on-primary, #fff);',
        '}',
        '.' + DIALOG_META_CLASS + '{',
        '  margin-top: 12px;',
        '  font-size: 12px;',
        '  line-height: 18px;',
        '  color: var(--dsw-alias-label-tertiary);',
        '  word-break: break-all;',
        '}',
      ].join('\n');
      document.head.appendChild(style);
    }

    /**
     * Диалог подтверждения удаления (постоянно смонтированный хост в `shell.overlay`).
     *
     * `useDeleteRequest` внедряется через `hooks: { deleteRequest }` слота; пока
     * нет запроса на подтверждение, возвращается null, поэтому диалог не занимает
     * место в интерфейсе и не размонтируется при открытии/закрытии меню сессии.
     */
    function DeleteSessionDialog({ useDeleteRequest, dismissDeleteRequest }) {
      const request = useDeleteRequest((pending) => pending);
      const [deleting, setDeleting] = React.useState(false);
      const [error, setError] = React.useState(null);

      React.useEffect(() => { ensureStyle(); }, []);

      const sessionId = request === null ? null : request.sessionId;

      // При смене сессии (или закрытии) сбрасываем предыдущее состояние «в процессе»/ошибки.
      React.useEffect(() => {
        setDeleting(false);
        setError(null);
      }, [sessionId]);

      if (request === null) return null;

      const title = (request.displayTitle && String(request.displayTitle).trim() !== '')
        ? String(request.displayTitle)
        : sessionId;

      const close = () => {
        if (deleting) return;
        dismissDeleteRequest();
      };

      const confirm = () => {
        if (deleting) return;
        setDeleting(true);
        setError(null);
        fetch(DELETE_SESSION_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
          .then(async (response) => {
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.ok !== true) {
              const msg = (data && data.error) ? data.error : ('HTTP ' + response.status);
              setError(msg);
              setDeleting(false);
              return;
            }
            // Успех: хост рассылает api-session/removed, строка размонтируется сама; здесь закрываем диалог.
            dismissDeleteRequest();
          })
          .catch((thrown) => {
            setError(thrown && thrown.message ? thrown.message : String(thrown));
            setDeleting(false);
          });
      };

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        closeLabel: 'Закрыть',
        title: 'Удалить сессию',
        footer: React.createElement(React.Fragment, null,
          React.createElement(Button, {
            variant: 'outline',
            disabled: deleting,
            onClick: close,
            children: 'Отмена',
          }),
          React.createElement(Button, {
            variant: 'outline',
            className: DANGER_BUTTON_CLASS,
            disabled: deleting,
            onClick: confirm,
            children: deleting ? 'Удаление…' : 'Удалить',
          })),
        children: [
          React.createElement('div', { key: 'desc' },
            'Сессия и вся история диалога (журнал сессии, кэш проекции и учёт рабочего пространства) будут удалены безвозвратно. Отменить это действие нельзя.'),
          React.createElement('div', { key: 'title', className: DIALOG_META_CLASS },
            'Сессия: ' + title),
          React.createElement('div', { key: 'id', className: DIALOG_META_CLASS },
            'ID: ' + sessionId),
          error === null ? null : React.createElement('div', {
            key: 'err',
            className: DIALOG_META_CLASS,
            style: { color: 'var(--dsw-alias-state-error-primary)' },
            role: 'alert',
          }, 'Не удалось удалить: ' + error),
        ],
      });
    }

    /**
     * Пункт «Удалить сессию» (красный) в меню «…» сессии.
     *
     * Отвечает только за закрытие меню и передачу запроса в store уровня плагина —
     * диалог рендерит постоянно смонтированный компонент в `shell.overlay`,
     * поэтому закрытие меню не уносит окно с собой.
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, deleteRequest }) {
      const [, setMenuOpen] = useMenuOpenState ? useMenuOpenState() : [null, () => {}];

      const onSelect = () => {
        setMenuOpen(false);
        deleteRequest.set({ sessionId, displayTitle: displayTitle ?? null });
      };

      return React.createElement(MenuItemButton, {
        icon: React.createElement(IconTrashOutlineRegular, { size: 14 }),
        danger: true,
        onSelect,
        children: 'Удалить сессию',
      });
    }

    /** Регистрирует пункт меню и оверлей-диалог; при отсутствии сервиса slots тихо деградирует. */
    function apply(ctx) {
      try {
        const slots = ctx.get ? ctx.get('slots') : undefined;
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          if (typeof console !== 'undefined') console.warn('[dsh-delete-sessions-ru] slots unavailable, entries not registered');
          return;
        }

        /**
         * Запрос на удаление, ожидающий подтверждения. Используется snapshot store
         * хоста (а не state компонента), чтобы «пункт меню» и «оверлей-диалог» —
         * два независимых компонента — делили одно состояние; он живёт в области
         * видимости плагина, поэтому открытие/закрытие меню на него не влияет.
         */
        const deleteRequest = createSnapshotStore(null);

        // order 410: ровно под «Архивировать сессию» (400) и над «Копировать Session ID» (450).
        slots.inject('sidebar.workspaces.session.menu.item', function* () {
          yield slots.register({
            name: 'sidebar.workspaces.session.menu.item',
            id: 'delete-session',
            order: 410,
            inject: () => ({ deleteRequest }),
          }, DeleteSessionMenuItem);
        });

        // Постоянный оверлей: диалог остаётся и после размонтирования пункта меню.
        slots.inject('shell.overlay', function* () {
          yield slots.register({
            name: 'shell.overlay',
            id: 'dsh-delete-sessions-ru-confirm',
            inject: () => ({
              hooks: { deleteRequest },
              dismissDeleteRequest: () => deleteRequest.set(null),
            }),
          }, DeleteSessionDialog);
        });

        if (typeof console !== 'undefined') console.info('[dsh-delete-sessions-ru] client half active');
      } catch (error) {
        if (typeof console !== 'undefined') console.warn('[dsh-delete-sessions-ru] failed to register entries', error);
      }
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
