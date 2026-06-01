/*
 * src/lib/drill-in.js — «провал» в карточку: открытие модалок
 * «Сводные данные» / «Информация об объявлении» для полного текста креатива и
 * (опционально) данных по охвату в ЕС.
 *
 * Только DOM, без chrome.*. Встроенный троттлинг (Workstream C): не чаще
 * perMin запросов в минуту и не чаще, чем раз в minInterval мс — чтобы не
 * провоцировать лимиты/блокировки. Шаги разделены хук-функцией delay().
 *
 * Экспортирует self.FBALS_DrillIn.
 */
(function () {
  'use strict';

  const DrillIn = {
    // hook задержки — переопределяется в тестах/настройках
    delay: function (ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // бюджет запросов (Workstream C)
    _budget: {
      perMin: 20,        // не больше N открытий деталей в минуту
      minInterval: 1500, // и не чаще раза в N мс
      _times: [],        // отметки времени последних открытий
      _lastAt: 0
    },

    configure: function (opts) {
      opts = opts || {};
      if (typeof opts.perMin === 'number') this._budget.perMin = opts.perMin;
      if (typeof opts.minInterval === 'number') this._budget.minInterval = opts.minInterval;
      if (typeof opts.delay === 'function') this.delay = opts.delay;
    },

    // ждём, пока позволит бюджет
    _throttle: async function () {
      const b = this._budget;
      const now = Date.now();

      // минимальный интервал между открытиями
      const sinceLast = now - b._lastAt;
      if (b._lastAt && sinceLast < b.minInterval) {
        await this.delay(b.minInterval - sinceLast);
      }

      // окно «не больше perMin за 60с»
      const cutoff = Date.now() - 60000;
      b._times = b._times.filter((t) => t > cutoff);
      if (b._times.length >= b.perMin) {
        const waitMs = b._times[0] + 60000 - Date.now();
        if (waitMs > 0) await this.delay(waitMs);
        b._times = b._times.filter((t) => t > Date.now() - 60000);
      }

      const stamp = Date.now();
      b._times.push(stamp);
      b._lastAt = stamp;
    },

    // поиск кликабельного элемента по тексту
    _findByText: function (root, re) {
      const nodes = root.querySelectorAll('div[role="button"], a[role="button"], span, a');
      for (const n of nodes) {
        const t = (n.textContent || '').trim();
        if (t && re.test(t) && t.length < 60) return n;
      }
      return null;
    },

    // Находит ИМЕННО панель деталей (а не навигационное меню Меты, у которого
    // тоже role="dialog"!). Берём последний dialog с признаками панели деталей.
    _findOpenModal: function () {
      const dialogs = Array.prototype.slice.call(document.querySelectorAll('div[role="dialog"]'));
      // фильтруем меню навигации (Privacy/Terms/Cookies/Ad Library Report)
      const real = dialogs.filter(function (d) {
        const t = d.textContent || '';
        if (/Ad Library Report|Branded Content|Subscribe to email/i.test(t)) return false; // это меню
        return /Ad Details|EU ad delivery|Transparency by location|Reach|Информация об объявлении|охват/i.test(t);
      });
      if (real.length) return real[real.length - 1];
      // запасной вариант — самый «текстастый» dialog, но не меню
      const notMenu = dialogs.filter((d) => !/Ad Library Report|Branded Content/i.test(d.textContent || ''));
      notMenu.sort((a, b) => (b.textContent || '').length - (a.textContent || '').length);
      return notMenu[0] || null;
    },

    _closeModal: function (modal) {
      const close = (modal || document).querySelector('[aria-label="Close"], [aria-label*="Close"], [aria-label*="Закрыть"], div[role="button"][aria-label]');
      if (close) { try { close.click(); return; } catch (_) { /* игнор */ } }
      // запасной путь — Escape
      try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); } catch (_) { /* */ }
    },

    // Текст элемента с пробелами на границах блоков (textContent их теряет,
    // склеивая «EU ad deliveryReach231…» — это ломало парсинг ЕС).
    _spacedText: function (root) {
      if (!root) return '';
      const parts = [];
      const walk = (node) => {
        for (let i = 0; i < node.childNodes.length; i++) {
          const c = node.childNodes[i];
          if (c.nodeType === 3) {
            const v = c.nodeValue;
            if (v && v.trim()) parts.push(v.trim());
          } else if (c.nodeType === 1) {
            walk(c);
          }
        }
      };
      walk(root);
      return parts.join(' ');
    },

    /**
     * Достаёт расширенные поля из открытой панели деталей.
     * Реальная структура (подтверждена на живой странице):
     *   «EU ad delivery Reach 231 …»               — общий охват по ЕС
     *   «Austria 18-24 Male 1 / Belgium 65+ Female 5» — разбивка стр./возр./пол
     *   «Age 18-65+ years old», «Gender All», «Worldwide» — таргетинг
     */
    scrapeDetails: function (modal) {
      const out = {
        body_text: '',
        eu_total_reach: null,
        eu_reach_breakdown: [],
        targeting_age: '',
        targeting_gender: '',
        targeting_locations: ''
      };
      if (!modal) return out;
      // ВАЖНО: modal.textContent склеивает соседние блоки без пробелов
      // («EU ad deliveryReach231The number…»), из-за чего ломаются regex.
      // Собираем текст, вставляя пробел на границах элементов (как видит человек).
      const text = this._spacedText(modal).replace(/\s+/g, ' ').trim();

      // полный текст объявления — самый длинный pre-wrap блок
      let best = '';
      modal.querySelectorAll('div[style*="pre-wrap"], div[style*="white-space"]').forEach((el) => {
        const t = (el.textContent || '').trim();
        if (t.length > best.length) best = t;
      });
      out.body_text = best;

      // общий охват ЕС: «EU ad delivery Reach 231 The number of Meta…»
      let m = text.match(/EU ad delivery\s*Reach\s*([\d.,\s]+?)\s*The number/i) ||
              text.match(/\bReach\s*([\d.,]+)\s*The number of Meta/i);
      if (m) {
        const n = parseInt(m[1].replace(/[^\d]/g, ''), 10);
        if (!isNaN(n)) out.eu_total_reach = n;
      }

      // разбивка: «<Страна> <возраст> <пол> <число>»
      const RE_ROW = /([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+){0,3})\s+(13-17|18-24|25-34|35-44|45-54|55-64|65\+)\s+(Male|Female|Unknown|All)\s+(\d+)/g;
      const breakdown = [];
      let r;
      while ((r = RE_ROW.exec(text)) !== null) {
        // отрезаем прилипший заголовок таблицы («…Range Gender Reach Austria»)
        let loc = r[1].replace(/.*\b(?:Reach|Gender|Range|Location|Age)\b\s*/i, '').trim();
        if (!loc || /Age|Range|Gender|Reach|Location/i.test(loc)) continue;
        breakdown.push({ location: loc, age: r[2], gender: r[3], reach: parseInt(r[4], 10) });
      }
      out.eu_reach_breakdown = breakdown;

      // если общий охват не нашли — сложим из разбивки
      if (out.eu_total_reach === null && breakdown.length) {
        out.eu_total_reach = breakdown.reduce((s, x) => s + x.reach, 0);
      }

      // таргетинг
      const age = text.match(/Age\s+(\d{1,2}\s*-\s*\d{1,2}\+?\s*years old|\d{1,2}\+?\s*years old)/i);
      if (age) out.targeting_age = age[1].replace(/\s+/g, ' ').trim();
      const gen = text.match(/Gender\s+(All|Men|Women|Male|Female)/i);
      if (gen) out.targeting_gender = gen[1];
      if (/\bWorldwide\b/i.test(text)) out.targeting_locations = 'Worldwide';

      return out;
    },

    /**
     * Открывает детали для одной карточки и возвращает обогащение.
     * @param {Element} card — DOM-карточка объявления
     * @param {Object} [opts] { eu:boolean }
     * @returns {Promise<Object|null>}
     */
    openAdDetails: async function (card, opts) {
      opts = opts || {};
      await this._throttle();

      // Карточка может быть уже откреплена от DOM (виртуальный скролл FB).
      if (!card || !card.isConnected) return { _err: 'карточка вне DOM (скролл)' };

      // подвести карточку в зону видимости, чтобы FB её не «усыпил»
      try { card.scrollIntoView({ block: 'center' }); } catch (_) { /* */ }
      await this.delay(250);
      if (!card.isConnected) return { _err: 'карточка вне DOM (скролл)' };

      // «See ad details» открывает панель с EU transparency.
      // «See summary details» — это группа объявлений (без раздела ЕС у самой группы),
      // поэтому для данных ЕС нужен именно «See ad details».
      let trigger = this._findByText(card, /(See ad details|Информация об объявлении)/i);
      if (!trigger) trigger = this._findByText(card, /(See summary details|Сводные данные)/i);
      if (!trigger) return { _err: 'кнопка деталей не найдена' };

      try { trigger.click(); } catch (_) { return { _err: 'клик не прошёл' }; }

      // ждём появления панели
      let modal = null;
      for (let i = 0; i < 12; i++) {
        await this.delay(500);
        modal = this._findOpenModal();
        if (modal && /EU ad delivery|Transparency by location|Reach\s+\d|EU ad audience/i.test(modal.textContent || '')) break;
      }
      if (!modal) modal = this._findOpenModal();
      if (!modal) return { _err: 'панель деталей не открылась' };

      // Данные ЕС часто в свёрнутых секциях / подгружаются по мере прокрутки.
      // Раскрываем секции и скроллим панель вниз, чтобы FB отрендерил охват.
      await this._revealEu(modal);

      const details = this.scrapeDetails(modal);
      // диагностика: почему ЕС пуст
      if (details.eu_total_reach == null) {
        const t = modal.textContent || '';
        if (/Transparency by location|EU ad audience|EU ad delivery/i.test(t)) {
          details._euNote = 'раздел ЕС есть, но охват не отрисован/не найден';
        } else {
          details._euNote = 'у объявления нет раздела охвата ЕС';
        }
      }
      this._closeModal(modal);
      await this.delay(400);
      return details;
    },

    // Раскрывает свёрнутые секции и прокручивает панель, чтобы подгрузился охват ЕС.
    _revealEu: async function (modal) {
      // 1) кликаем по сворачиваемым заголовкам, относящимся к ЕС
      const heads = modal.querySelectorAll('[role="button"], [aria-expanded], summary, div[tabindex="0"]');
      for (const h of heads) {
        const t = (h.textContent || '').trim();
        if (t.length < 60 && /EU ad delivery|EU ad audience|Transparency by location|Reach by location|охват|Прозрачность/i.test(t)) {
          if (h.getAttribute('aria-expanded') === 'false' || true) {
            try { h.click(); } catch (_) { /* */ }
            await this.delay(250);
          }
        }
      }
      // 2) скроллим саму панель вниз порциями — ленивый рендер таблицы охвата
      const scroller = this._scrollableInside(modal) || modal;
      let lastReach = false;
      for (let i = 0; i < 8; i++) {
        try { scroller.scrollTop = scroller.scrollHeight; } catch (_) { /* */ }
        await this.delay(350);
        const hasReach = /EU ad delivery\s+Reach\s+\d|Reach\s+\d+\s+The number/i.test(modal.textContent || '');
        if (hasReach && lastReach) break; // стабилизировалось
        lastReach = hasReach;
      }
    },

    // Находит прокручиваемый контейнер внутри панели.
    _scrollableInside: function (modal) {
      const all = modal.querySelectorAll('*');
      for (const el of all) {
        if (el.scrollHeight > el.clientHeight + 40) {
          const ov = (el.ownerDocument.defaultView.getComputedStyle(el).overflowY || '');
          if (/auto|scroll/.test(ov)) return el;
        }
      }
      return null;
    }
  };

  if (typeof self !== 'undefined') self.FBALS_DrillIn = DrillIn;
  if (typeof module !== 'undefined' && module.exports) module.exports = DrillIn;
})();
