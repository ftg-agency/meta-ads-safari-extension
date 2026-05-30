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

    _findOpenModal: function () {
      return document.querySelector('div[role="dialog"]');
    },

    _closeModal: function (modal) {
      const close = (modal || document).querySelector('div[role="button"][aria-label], [aria-label*="Close"], [aria-label*="Закрыть"]');
      if (close) { try { close.click(); } catch (_) { /* игнор */ } }
    },

    // достаём расширенные поля из открытой модалки
    scrapeDetails: function (modal) {
      const out = { body_text: '', eu_total_reach: null, eu_reach_breakdown: [] };
      if (!modal) return out;
      const text = (modal.textContent || '');

      // полный текст объявления — самый длинный листовой блок
      let best = '';
      modal.querySelectorAll('div, span').forEach((el) => {
        if (el.children.length === 0) {
          const t = (el.textContent || '').trim();
          if (t.length > best.length && t.length < 8000) best = t;
        }
      });
      out.body_text = best;

      // охват в ЕС: «Total reach in EU / Общий охват в ЕС: 12 345»
      const m = text.match(/(?:Total reach in EU|Охват в ЕС|Общий охват)[^\d]*([\d  .,]+)/i);
      if (m) {
        const num = parseInt(m[1].replace(/[^\d]/g, ''), 10);
        if (!isNaN(num)) out.eu_total_reach = num;
      }
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

      const trigger = this._findByText(card, /(See ad details|Информация об объявлении|See summary details|Сводные данные)/i);
      if (!trigger) return null;

      try { trigger.click(); } catch (_) { return null; }
      await this.delay(800);

      const modal = this._findOpenModal();
      if (!modal) return null;

      const details = this.scrapeDetails(modal);

      // данные по ЕС — отдельная вкладка/раздел, опционально
      if (opts.eu) {
        const euTab = this._findByText(modal, /(EU transparency|Прозрачность в ЕС|Сводные данные)/i);
        if (euTab) {
          try { euTab.click(); } catch (_) { /* игнор */ }
          await this.delay(800);
          const euData = this.scrapeDetails(this._findOpenModal() || modal);
          if (euData.eu_total_reach !== null) {
            details.eu_total_reach = euData.eu_total_reach;
            details.eu_reach_breakdown = euData.eu_reach_breakdown;
          }
        }
      }

      this._closeModal(modal);
      await this.delay(400);
      return details;
    }
  };

  if (typeof self !== 'undefined') self.FBALS_DrillIn = DrillIn;
  if (typeof module !== 'undefined' && module.exports) module.exports = DrillIn;
})();
