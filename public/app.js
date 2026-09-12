"use strict";

/**
 * Dashboard бильярдного клуба.
 *
 * Источник истины — сервер: /api/dashboard возвращает elapsed_seconds и
 * current_cost на момент ответа. Между опросами (раз в POLL_MS) таймер и
 * стоимость тикают локально от этой базы, поэтому обновление страницы
 * ничего не сбрасывает.
 */

const POLL_MS = 5000;
const TICK_MS = 1000;

const state = {
  tables: [],          // ответ /api/dashboard
  fetchedAt: 0,        // performance.now() в момент ответа
  tariffs: [],
  tariffChoice: new Map(), // table_id -> выбранный tariff_id в селекте
  clientDraft: new Map(),  // table_id -> набранный текст в поле клиента
  devices: [],         // устройства Tuya для вкладки «Настройки»
  hallDevices: [],     // кондиционер, вытяжка, приток — вкладка «Устройства»
  devicesFetchedAt: 0, // когда их ответ пришёл: от него идёт отсчёт на плашках
  user: null,          // текущий сотрудник {id, name, role}
  permissions: {},     // права текущей роли — {manage_tables: bool, ...}
  shift: null,         // открытая кассовая смена или null
  clients: [],         // клиентская база для быстрого выбора при открытии
  autoTariffId: null,  // тариф по расписанию на «сейчас»
  view: "map",         // вид «Залов»: map (карта) или cards (карточки)
  selected: new Set(), // выбранные на карте столы (id)
  plan: { cols: 40, rows: 25, elements: [] }, // план зала: сетка, стены, двери
  editMode: false,     // включён ли редактор зала
  receiptWidth: "80",   // ширина чековой ленты: 58, 80 (мм) или a4
  promotion: null,      // действующая сейчас акция «счастливый час»
  warnBeforeMinutes: 5, // за сколько минут предупреждать о конце времени
  warnSound: true,      // подавать ли звуковой сигнал
  warned: new Set(),    // сеансы, о которых уже предупредили (id сеанса)
  warnedOver: new Set(), // сеансы, о конце времени которых уже сказали
  edit: null,          // рабочая копия плана в редакторе
};

const CELL = 20; // размер клетки сетки, px

const PAYMENT_LABELS = {
  cash: "Наличные",
  card: "Карта",
  transfer: "Перевод",
  // Игра по чеку на остаток: живых денег в этот раз не было.
  voucher: "Чеком (остаток)",
  // Оплата со счёта клиента: деньги пришли в кассу раньше, при пополнении.
  balance: "Со счёта клиента",
};

state.currency = "₽";

/** Символ валюты клуба (настраивается в «Настройках»). */
function cur() {
  return state.currency;
}

/** Есть ли у текущей роли право key. */
function can(key) {
  return Boolean(state.permissions[key]);
}

/** Сумма с валютой: 1234.5 -> "1 234,50 ₽". */
function money(value) {
  return `${formatMoney(value)} ${state.currency}`;
}

/** Меняет «₽» на валюту клуба в статичной разметке (заголовки таблиц и т.п.). */
function applyCurrencyToStatic() {
  if (state.currency === "₽") return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue.includes("₽")) nodes.push(walker.currentNode);
  }
  for (const node of nodes) {
    node.nodeValue = node.nodeValue.replaceAll("₽", state.currency);
  }
  for (const input of document.querySelectorAll("input[placeholder*='₽']")) {
    input.placeholder = input.placeholder.replaceAll("₽", state.currency);
  }
}

// ---------------------------------------------------------------- helpers

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("Требуется вход");
  }
  if (!response.ok) {
    let detail = `Ошибка ${response.status}`;
    try {
      const body = await response.json();
      if (body.detail) {
        detail = typeof body.detail === "string" ? body.detail : detail;
      }
    } catch (_) { /* тело не JSON — оставляем статус */ }
    throw new Error(detail);
  }
  return response.json();
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

function formatMoney(rubles) {
  return rubles.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ---------------------------------------------------------------- иконки

/**
 * Монохромная иконка. Рисуется CSS-маской (.ic-<name> в style.css),
 * цвет берётся от текста, поэтому иконка одинаково хороша в тёмной и
 * светлой теме.
 */
function icon(name) {
  const el = document.createElement("i");
  el.className = `ic ic-${name}`;
  el.setAttribute("aria-hidden", "true");
  return el;
}

/** Иконка + подпись: `el.append(...withIcon("play", "Открыть…"))`. */
function withIcon(name, text) {
  const span = document.createElement("span");
  span.textContent = text;
  return [icon(name), span];
}

// ---------------------------------------------------------------- modal

// Что вызвать, если окно закрыли крестиком или щелчком по фону
// (нужно диалогам вопросов: закрытие = отказ).
let modalOnClose = null;

function closeModal() {
  document.getElementById("modal-overlay").hidden = true;
  const onClose = modalOnClose;
  modalOnClose = null;
  if (onClose) onClose();
}

/**
 * Показывает модальное окно с заголовком и произвольным содержимым.
 * @param {string} title
 * @param {Node} bodyNode
 * @param {(() => void) | null} [onClose] вызывается при закрытии окна
 */
function openModal(title, bodyNode, onClose = null, { wide = false } = {}) {
  const modal = document.getElementById("modal");
  modal.classList.toggle("wide", wide);
  modal.replaceChildren();
  const head = document.createElement("div");
  head.className = "modal-head";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const close = document.createElement("button");
  close.className = "mini";
  close.title = "Закрыть";
  close.append(icon("close"));
  close.addEventListener("click", closeModal);
  head.append(heading, close);
  modal.append(head, bodyNode);
  modalOnClose = onClose;
  document.getElementById("modal-overlay").hidden = false;
}

/**
 * Модальное «вы уверены?» вместо системного confirm(): в том же стиле,
 * что остальные окна, и не блокирует страницу.
 * @returns {Promise<boolean>} true — пользователь подтвердил
 */
function confirmModal(title, message, confirmLabel = "Подтвердить") {
  return new Promise((resolve) => {
    const body = document.createElement("div");
    const text = document.createElement("p");
    text.className = "hint";
    text.textContent = message;
    body.append(text);

    const actions = document.createElement("div");
    actions.className = "settings-actions";

    let answered = false;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      closeModal();
      resolve(value);
    };

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "primary danger-btn";
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener("click", () => finish(true));

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "mini";
    cancelBtn.textContent = "Отмена";
    cancelBtn.addEventListener("click", () => finish(false));

    actions.append(confirmBtn, cancelBtn);
    body.append(actions);
    // Закрытие крестиком/по фону — это отказ.
    openModal(title, body, () => finish(false));
    confirmBtn.focus();
  });
}

/**
 * Выход из системы. Если смена открыта, сначала спрашиваем — просто
 * выйти (смена останется открытой для следующего, кто зайдёт под этим
 * же логином) или сразу сдать кассу. Без вопроса кассир слишком легко
 * забывал закрыть смену перед уходом.
 */
async function handleLogout() {
  if (state.shift) {
    const body = document.createElement("div");
    const text = document.createElement("p");
    text.className = "hint";
    text.textContent = "У вас открыта кассовая смена. Что сделать перед выходом?";
    body.append(text);

    const actions = document.createElement("div");
    actions.className = "settings-actions";

    let answered = false;
    const finish = async (closeShiftToo) => {
      if (answered) return;
      answered = true;
      closeModal();
      if (closeShiftToo) {
        try {
          await api("/api/shifts/close", { method: "POST", body: JSON.stringify({}) });
        } catch (error) {
          showToast(error.message);
          return;
        }
      }
      await api("/api/auth/logout", { method: "POST" }).catch(() => {});
      window.location.href = "/login";
    };

    const closeShiftBtn = document.createElement("button");
    closeShiftBtn.className = "primary";
    closeShiftBtn.textContent = "Выйти и закрыть смену";
    closeShiftBtn.addEventListener("click", () => finish(true));

    const justLeaveBtn = document.createElement("button");
    justLeaveBtn.className = "mini";
    justLeaveBtn.textContent = "Выйти";
    justLeaveBtn.addEventListener("click", () => finish(false));

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "mini";
    cancelBtn.textContent = "Отмена";
    cancelBtn.addEventListener("click", () => {
      if (answered) return;
      answered = true;
      closeModal();
    });

    actions.append(closeShiftBtn, justLeaveBtn, cancelBtn);
    body.append(actions);
    openModal("Выход", body, () => {
      answered = true;
    });
    closeShiftBtn.focus();
    return;
  }
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/login";
}

/**
 * Несъезжающая плашка «перезапустите сервер»: программу обновили, а
 * сервер продолжает работать со старым кодом в памяти.
 */
function showRestartBanner() {
  if (document.getElementById("restart-banner")) return;
  const banner = document.createElement("div");
  banner.id = "restart-banner";
  banner.className = "restart-banner";
  banner.append(
    ...withIcon(
      "warning",
      "Программа обновлена, но сервер работает на старой версии. " +
        "Закройте окно «Сервер клуба» и запустите start-club.bat заново — " +
        "иначе часть действий будет давать ошибки."
    )
  );
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = "Понятно";
  close.addEventListener("click", () => banner.remove());
  banner.append(close);
  document.body.prepend(banner);
}

/**
 * Свежая установка: владельца в системе ещё нет. Подсказываем создать —
 * иначе непонятно, почему в списке ролей нет «Владельца», а раздел
 * «Роли и права» пуст.
 */
function showOwnerSetupHint() {
  if (document.getElementById("owner-setup-banner")) return;
  const banner = document.createElement("div");
  banner.id = "owner-setup-banner";
  banner.className = "restart-banner owner-setup-banner";
  banner.append(
    ...withIcon(
      "person",
      "Владелец клуба ещё не создан. Откройте «Пользователи» → «Новый " +
        "сотрудник» и создайте аккаунт с ролью «Владелец» — ему будут " +
        "доступны роли и права, бесплатное время и загрузка базы из копии."
    )
  );
  const go = document.createElement("button");
  go.className = "mini";
  go.textContent = "Создать";
  go.addEventListener("click", () => {
    switchTab("users");
    document.getElementById("new-user-login").focus();
  });
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = "Позже";
  close.addEventListener("click", () => banner.remove());
  banner.append(go, close);
  document.body.prepend(banner);
}

/**
 * Всплывающее уведомление в правом верхнем углу.
 *
 * Об удачном действии говорим коротко и по делу («Сеанс открыт»), а об
 * ошибке — человеческим языком: «Упс, что-то пошло не так» и следом
 * причина, как её объяснил сервер. Уведомления складываются стопкой:
 * если кассир нажал несколько кнопок подряд, ни одно не потеряется.
 */
function showToast(message, ok = false) {
  const box = document.getElementById("toasts");
  if (!box) return;

  const item = document.createElement("div");
  item.className = `toast ${ok ? "ok" : "bad"}`;

  const mark = icon(ok ? "check" : "warning");
  mark.classList.add("toast-icon");

  const text = document.createElement("div");
  text.className = "toast-text";
  const title = document.createElement("div");
  title.className = "toast-title";
  title.textContent = ok ? String(message) : "Упс, что-то пошло не так";
  text.append(title);
  if (!ok && message) {
    const why = document.createElement("div");
    why.className = "toast-why";
    why.textContent = String(message);
    text.append(why);
  }

  const close = document.createElement("button");
  close.className = "toast-close";
  close.type = "button";
  close.title = "Скрыть";
  close.textContent = "×";
  close.addEventListener("click", () => item.remove());

  item.append(mark, text, close);
  box.append(item);

  // Ошибку держим дольше: её нужно успеть прочитать.
  setTimeout(() => item.remove(), ok ? 3500 : 7000);
}

// ------------------------------------------- предупреждение о конце времени

/**
 * Короткий сигнал «пи-пи» без звукового файла: два тона через WebAudio.
 * Браузер разрешает звук только после первого клика по странице, поэтому
 * контекст создаётся лениво (см. unlockSound).
 */
let audioCtx = null;
function unlockSound() {
  if (audioCtx) return;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return;
  try {
    audioCtx = new Ctor();
  } catch {
    audioCtx = null; // звука не будет — не беда, полоска всё равно видна
  }
}

function beep(times = 2) {
  if (!state.warnSound) return;
  unlockSound();
  if (!audioCtx) return;
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  for (let i = 0; i < times; i += 1) {
    const at = audioCtx.currentTime + i * 0.22;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(at);
    osc.stop(at + 0.2);
  }
}

/**
 * Полоска-предупреждение вверху экрана. Держится, пока кассир её не
 * закроет или пока не пройдёт минута: сообщение важное, всплывающий
 * toast на 4 секунды тут не годится.
 */
function showAlert(text, kind = "warn") {
  const box = document.getElementById("alerts");
  if (!box) return;
  const item = document.createElement("div");
  item.className = `alert ${kind}`;
  const label = document.createElement("span");
  label.textContent = text;
  const close = document.createElement("button");
  close.className = "alert-close";
  close.type = "button";
  close.title = "Скрыть";
  close.textContent = "×";
  close.addEventListener("click", () => item.remove());
  item.append(label, close);
  box.append(item);
  setTimeout(() => item.remove(), 60000);
}

/** Сколько секунд осталось у предоплаченного стола прямо сейчас. */
function remainingSeconds(table) {
  return (
    table.session.remaining_seconds - (performance.now() - state.fetchedAt) / 1000
  );
}

/**
 * Раз в секунду смотрит на предоплаченные столы: за N минут до конца
 * предупреждает («скоро закончится»), а когда время вышло — говорит об
 * этом ещё раз. По каждому сеансу — не больше одного сообщения на
 * событие, иначе полоска сыпалась бы каждую секунду.
 */
function checkTimeWarnings() {
  const warnAfter = state.warnBeforeMinutes * 60;
  for (const table of state.tables) {
    if (!table.session?.prepaid) continue;
    const sid = table.session.session_id;
    const left = remainingSeconds(table);
    if (left <= 0) {
      if (!state.warnedOver.has(sid)) {
        state.warnedOver.add(sid);
        showAlert(`${table.name} — время вышло`, "over");
        beep(3);
      }
      continue;
    }
    if (warnAfter > 0 && left <= warnAfter && !state.warned.has(sid)) {
      state.warned.add(sid);
      const minutes = Math.max(1, Math.round(left / 60));
      showAlert(`${table.name} — осталось ${minutes} мин`, "warn");
      beep(2);
    }
  }
}

// ---------------------------------------------------------------- dashboard

function liveElapsedSeconds(table) {
  const drift = (performance.now() - state.fetchedAt) / 1000;
  return table.session.elapsed_seconds + drift;
}

function liveCost(table) {
  const perSecond = table.session.price_per_hour / 3600;
  return liveElapsedSeconds(table) * perSecond;
}

function clientOptionLabel(client) {
  return client.phone ? `${client.name} — ${client.phone}` : client.name;
}

function renderClientsDatalist() {
  const datalist = document.getElementById("clients-datalist");
  datalist.replaceChildren();
  for (const client of state.clients) {
    const option = document.createElement("option");
    option.value = clientOptionLabel(client);
    datalist.append(option);
  }
}

/**
 * Клиент по тексту в поле. В списке подсказок значится «Имя — телефон»,
 * но кассир часто набирает просто имя или просто телефон — принимаем и
 * то, и другое, иначе скидка молча не применится.
 */
function clientIdFromInput(value) {
  const text = value.trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const digits = text.replace(/\D/g, "");
  const byLabel = state.clients.find((c) => clientOptionLabel(c) === text);
  if (byLabel) return byLabel.id;
  const byName = state.clients.find((c) => c.name.trim().toLowerCase() === lower);
  if (byName) return byName.id;
  if (digits.length >= 6) {
    const byPhone = state.clients.find(
      (c) => (c.phone ?? "").replace(/\D/g, "") === digits
    );
    if (byPhone) return byPhone.id;
  }
  return null;
}

function bookingBadge(table) {
  if (!table.booking) return null;
  const startsMs = Date.parse(table.booking.starts_at);
  const minutesLeft = Math.round((startsMs - Date.now()) / 60000);
  const el = document.createElement("div");
  el.className = "booking-note" + (minutesLeft <= 60 ? " soon" : "");
  const when = new Date(startsMs).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  el.append(
    ...withIcon(
      "calendar",
      minutesLeft <= 0
        ? `Бронь сейчас: ${table.booking.client_name}`
        : `Бронь в ${when} — ${table.booking.client_name}`
    )
  );
  return el;
}

// Тип точки: у всех общие тарифы, сеансы и биллинг — отличается только
// подпись/значок. ic — имя иконки, series — номер поколения рядом с ней.
const KIND_META = {
  billiard: { ic: "ball", label: "Бильярдный стол" },
  ps3: { ic: "gamepad", series: "3", label: "PlayStation 3" },
  ps4: { ic: "gamepad", series: "4", label: "PlayStation 4" },
  ps5: { ic: "gamepad", series: "5", label: "PlayStation 5" },
  tv: { ic: "tv", badge: "TV", label: "Телевизор" },
};

/** Статус стола для карты: free | busy | prepaid | expired (+ booked). */
function tableStatusClass(table) {
  if (!table.session) return "free";
  if (!table.session.prepaid) return "busy";
  return table.session.expired ? "expired" : "prepaid";
}

// Бронь ближе этого срока считается «скорой»: плитка подсвечивается,
// предупреждение кассиру краснеет.
const BOOKING_SOON_MINUTES = 60;

function bookingSoon(table) {
  if (!table.booking) return false;
  return Date.parse(table.booking.starts_at) - Date.now() <= BOOKING_SOON_MINUTES * 60000;
}

/** Сколько минут осталось до брони (отрицательно — бронь уже идёт). */
function bookingMinutesLeft(table) {
  if (!table.booking) return null;
  return Math.round((Date.parse(table.booking.starts_at) - Date.now()) / 60000);
}

/** Часы:минуты для брони — той же локалью, что и остальные подписи броней. */
function bookingClock(iso) {
  return new Date(Date.parse(iso)).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** «1 ч 35 мин» — в предупреждении читается лучше, чем 01:35:00. */
function humanMinutes(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

/**
 * Текст предупреждения кассиру: до какого часа можно играть и что будет
 * дальше. plannedMinutes — сколько кассир собирается открыть (null, если
 * время не ограничено: у постоплаты конца нет и сравнивать не с чем).
 */
function bookingWarningText(table, plannedMinutes = null) {
  if (!table.booking) return "";
  const { client_name: name, starts_at: startsAt, ends_at: endsAt } = table.booking;
  const left = bookingMinutesLeft(table);
  const freeAgain = endsAt ? ` Стол снова свободен в ${bookingClock(endsAt)}.` : "";

  if (left <= 0) {
    return (
      `Стол забронирован: ${name}. Бронь уже идёт с ${bookingClock(startsAt)}.` +
      freeAgain
    );
  }
  const head =
    left < 1
      ? `Стол забронирован: ${name} — бронь начинается прямо сейчас.`
      : `Стол забронирован: ${name} в ${bookingClock(startsAt)}. ` +
        `Играть можно ${humanMinutes(left)} — до ${bookingClock(startsAt)}.`;
  const overrun =
    plannedMinutes !== null && plannedMinutes > left
      ? ` Вы открываете на ${humanMinutes(plannedMinutes)} — ` +
        `гость не доиграет ${humanMinutes(plannedMinutes - left)} до брони.`
      : "";
  return head + overrun + freeAgain;
}

/**
 * Полоска-предупреждение о брони для окон открытия стола. Возвращает null,
 * если брони нет, — тогда в окне ничего не меняется.
 * @param {object} table
 * @param {() => number | null} plannedMinutes сколько минут собираются открыть
 * @returns {{node: HTMLElement, update: () => void} | null}
 */
function bookingWarningNote(table, plannedMinutes = () => null) {
  if (!table.booking) return null;
  const node = document.createElement("div");
  const text = document.createElement("span");
  const update = () => {
    const planned = plannedMinutes();
    const left = bookingMinutesLeft(table);
    const over = left <= 0 || (planned !== null && planned > left);
    node.className = "booking-note" + (over ? " over" : left <= BOOKING_SOON_MINUTES ? " soon" : "");
    text.textContent = bookingWarningText(table, planned);
  };
  node.append(icon("calendar"), text);
  update();
  return { node, update };
}

/**
 * Спрашивает кассира, точно ли открывать стол, у которого скоро (или уже)
 * бронь. Не запрещает: гость брони может опоздать, а решает кассир.
 * @returns {Promise<boolean>} true — можно открывать
 */
async function confirmBookingOverrun(table, plannedMinutes) {
  if (!table.booking) return true;
  const left = bookingMinutesLeft(table);
  // Время не ограничено — предупреждаем при любой брони: конца у такого
  // сеанса нет, и сам он до брони не закончится.
  const overrun = plannedMinutes === null ? true : left <= 0 || plannedMinutes > left;
  if (!overrun) return true;
  return confirmModal(
    "Стол забронирован",
    bookingWarningText(table, plannedMinutes),
    "Всё равно открыть"
  );
}

/** Полная интерактивная карточка стола (для сетки карточек и окна стола). */
function buildTableCard(table, { inModal = false } = {}) {
  {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.tableId = String(table.id);

    const head = document.createElement("div");
    head.className = "card-head";
    const title = document.createElement("h2");
    const kindMeta = KIND_META[table.kind] ?? KIND_META.billiard;
    const mark = kindMeta.series ?? kindMeta.badge ?? "";
    title.append(icon(kindMeta.ic));
    if (mark) {
      const markEl = document.createElement("span");
      markEl.className = "kind-mark";
      markEl.textContent = mark;
      title.append(markEl);
    }
    const nameEl = document.createElement("span");
    nameEl.textContent = table.name;
    title.append(nameEl);
    title.title = kindMeta.label ?? "";
    const badge = document.createElement("span");
    badge.className = `badge ${table.status}`;
    badge.textContent = table.status === "busy" ? "ЗАНЯТ" : "СВОБОДЕН";
    head.append(title, badge);
    card.append(head);

    const light = document.createElement("div");
    light.className = "light";
    light.classList.toggle("on", Boolean(table.light_on));
    light.append(
      ...withIcon("bulb", table.light_on ? "Свет включён" : "Свет выключен")
    );
    card.append(light);

    const booking = bookingBadge(table);
    if (booking) card.append(booking);

    if (table.session) {
      const prepaid = table.session.prepaid;
      const timer = document.createElement("div");
      timer.className = "timer";
      timer.dataset.role = "timer";

      const cost = document.createElement("div");
      cost.className = "cost";
      cost.dataset.role = "cost";

      if (prepaid) {
        // Предоплата: обратный отсчёт оплаченного времени.
        const remaining = table.session.remaining_seconds -
          (performance.now() - state.fetchedAt) / 1000;
        timer.textContent = formatDuration(Math.max(0, remaining));
        timer.classList.toggle("expired", remaining <= 0);
        if (remaining <= 0) timer.textContent = "ВРЕМЯ ВЫШЛО";
        cost.textContent =
          `Оплачено ${money(table.session.prepaid_amount)}` +
          (table.session.payment_method
            ? ` · ${PAYMENT_LABELS[table.session.payment_method].toLowerCase()}`
            : "");
      } else {
        timer.textContent = formatDuration(liveElapsedSeconds(table));
        cost.textContent = `${money(liveCost(table))}`;
      }

      const meta = document.createElement("div");
      meta.className = "session-meta";
      const parts = [
        `Тариф «${table.session.tariff_name}» — ${table.session.price_per_hour} ${cur()}/час`,
        `начало ${formatDateTime(table.session.started_at)}`,
      ];
      if (table.session.client_name) {
        parts.push(
          `клиент ${table.session.client_name}` +
            (table.session.discount_percent
              ? ` (скидка ${table.session.discount_percent}%)`
              : "")
        );
      }
      meta.textContent = parts.join(", ");

      const closeBtn = document.createElement("button");
      closeBtn.className = "action close";
      closeBtn.textContent = "ЗАКРЫТЬ";
      closeBtn.addEventListener("click", () => openCloseModal(table));

      card.append(timer, cost, meta, closeBtn);
    } else {
      const select = document.createElement("select");
      const activeTariffs = allowedTariffs(table);
      for (const tariff of activeTariffs) {
        const option = document.createElement("option");
        option.value = String(tariff.id);
        const auto = tariff.id === state.autoTariffId ? " · авто" : "";
        option.textContent = `${tariff.name} — ${tariff.price_per_hour} ${cur()}/час${auto}`;
        select.append(option);
      }
      // Приоритет: выбор кассира, затем тариф по расписанию.
      const remembered = state.tariffChoice.get(table.id);
      if (remembered && activeTariffs.some((t) => t.id === remembered)) {
        select.value = String(remembered);
      } else if (state.autoTariffId) {
        select.value = String(state.autoTariffId);
      }
      select.addEventListener("change", () => {
        state.tariffChoice.set(table.id, Number(select.value));
      });

      const clientInput = document.createElement("input");
      clientInput.type = "text";
      clientInput.placeholder = "Клиент (не обязательно)";
      clientInput.setAttribute("list", "clients-datalist");
      // Периодическая перерисовка не должна стирать набранный текст.
      clientInput.value = state.clientDraft.get(table.id) ?? "";
      clientInput.addEventListener("input", () => {
        state.clientDraft.set(table.id, clientInput.value);
      });

      const openBtn = document.createElement("button");
      openBtn.className = "action open";
      openBtn.textContent = "ОТКРЫТЬ";
      if (!activeTariffs.length) {
        openBtn.disabled = true;
        openBtn.textContent = "НЕТ АКТИВНЫХ ТАРИФОВ";
      }
      openBtn.addEventListener("click", () => {
        const done = openTable(table, select, clientInput);
        if (inModal) done.finally(closeModal);
      });

      card.append(select, clientInput, openBtn);
    }

    if (!inModal) {
      card.addEventListener("contextmenu", (event) =>
        showContextMenu(event, table, card)
      );
    }
    return card;
  }
}

// --- Выделение столов на карте (клик; несколько сразу) ---

function updateSelectionUI() {
  const chip = document.getElementById("selection-chip");
  const selectAll = document.getElementById("select-all");
  const count = state.selected.size;
  chip.hidden = count === 0;
  chip.replaceChildren();
  const chipText = document.createElement("span");
  chipText.textContent = `Выбрано: ${count}`;
  chip.append(chipText, icon("close"));
  // Кнопка нужна только после первого выбора: до этого выбирать «все»
  // не из чего, и она лишь занимает место в шапке.
  selectAll.hidden = count === 0;
  selectAll.textContent =
    count === state.tables.length && count > 0 ? "Снять выбор" : "Выбрать все";
  for (const tile of document.querySelectorAll(".tile")) {
    tile.classList.toggle(
      "selected",
      state.selected.has(Number(tile.dataset.tableId))
    );
  }
}

function clearSelection() {
  state.selected.clear();
  updateSelectionUI();
}

function toggleSelect(tableId) {
  if (state.selected.has(tableId)) state.selected.delete(tableId);
  else state.selected.add(tableId);
  updateSelectionUI();
}

function toggleSelectAll() {
  if (state.selected.size === state.tables.length && state.tables.length > 0) {
    state.selected.clear();
  } else {
    state.selected = new Set(state.tables.map((t) => t.id));
  }
  updateSelectionUI();
}

/** Раскладка столов на плане: сохранённая или авторасстановка для новых. */
function resolveLayouts() {
  const layouts = new Map();
  const plan = state.editMode ? state.edit : state.plan;
  let autoIndex = 0;
  const perRow = Math.max(1, Math.floor((plan.cols - 2) / 5));
  for (const table of state.tables) {
    if (state.editMode && state.edit.layouts.has(table.id)) {
      layouts.set(table.id, { ...state.edit.layouts.get(table.id) });
      continue;
    }
    if (table.pos_x !== null && table.pos_y !== null) {
      layouts.set(table.id, {
        x: table.pos_x,
        y: table.pos_y,
        w: table.size_w ?? 4,
        h: table.size_h ?? 3,
      });
    } else {
      // Нерасставленный стол — во временную сетку сверху слева.
      layouts.set(table.id, {
        x: 1 + (autoIndex % perRow) * 5,
        y: 1 + Math.floor(autoIndex / perRow) * 4,
        w: 4,
        h: 3,
      });
      autoIndex += 1;
    }
  }
  return layouts;
}

function planCellFromEvent(event) {
  const rect = document.getElementById("plan").getBoundingClientRect();
  const plan = state.editMode ? state.edit : state.plan;
  return {
    x: Math.max(0, Math.min(plan.cols - 1, Math.floor((event.clientX - rect.left) / CELL))),
    y: Math.max(0, Math.min(plan.rows - 1, Math.floor((event.clientY - rect.top) / CELL))),
  };
}

function renderMap() {
  const planData = state.editMode ? state.edit : state.plan;
  const planEl = document.getElementById("plan");
  planEl.classList.toggle("editing", state.editMode);
  planEl.style.width = `${planData.cols * CELL}px`;
  planEl.style.height = `${planData.rows * CELL}px`;
  planEl.replaceChildren();

  // Убираем из выбора столы, которых больше нет.
  const ids = new Set(state.tables.map((t) => t.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);

  // Стены, двери, мебель и устройства зала.
  planData.elements.forEach((el, index) => {
    const div = document.createElement("div");
    div.className = `plan-el ${el.type}`;
    div.style.left = `${el.x * CELL}px`;
    div.style.top = `${el.y * CELL}px`;
    div.style.width = `${el.w * CELL}px`;
    div.style.height = `${el.h * CELL}px`;
    if (el.type === "device") {
      const device = state.hallDevices.find((d) => d.id === el.device_id);
      const meta = DEVICE_TYPES[device?.type] ?? DEVICE_TYPES.exhaust;
      div.classList.toggle("on", Boolean(device?.is_on));
      const label = document.createElement("span");
      label.textContent = device
        ? device.type === "damper" && device.position
          ? `${device.name} ${device.position}%`
          : device.name
        : "удалено";
      div.append(icon(meta.ic), label);
      div.title = device ? `${meta.label}: ${deviceStatusText(device, device.switches_in_seconds)}` : "";
      if (!state.editMode && device) {
        div.addEventListener("click", () => openDeviceControl(device));
      }
    }
    if (state.editMode) {
      div.dataset.elIndex = String(index);
      div.classList.add("editable");
      const handle = document.createElement("span");
      handle.className = "rsz";
      div.append(handle);
      div.addEventListener("mousedown", (event) =>
        startElementDrag(event, index, div, event.target === handle)
      );
    }
    planEl.append(div);
  });

  // Столы.
  const layouts = resolveLayouts();
  for (const table of state.tables) {
    const layout = layouts.get(table.id);
    const tile = document.createElement("div");
    tile.className = `tile ${tableStatusClass(table)}`;
    if (bookingSoon(table)) tile.classList.add("booked");
    tile.dataset.tableId = String(table.id);
    tile.style.left = `${layout.x * CELL}px`;
    tile.style.top = `${layout.y * CELL}px`;
    tile.style.width = `${layout.w * CELL}px`;
    tile.style.height = `${layout.h * CELL}px`;

    if (table.kind && table.kind !== "billiard") {
      const meta = KIND_META[table.kind] ?? { ic: "ball", badge: table.kind };
      const kindBadge = document.createElement("span");
      kindBadge.className = "kind-badge";
      kindBadge.title = meta.label ?? table.kind;
      const mark = meta.series ?? meta.badge ?? "";
      kindBadge.append(icon(meta.ic ?? "ball"));
      if (mark) {
        const markEl = document.createElement("span");
        markEl.textContent = mark;
        kindBadge.append(markEl);
      }
      tile.append(kindBadge);
    }

    const name = document.createElement("div");
    name.className = "tile-name";
    // Короткий номер, если имя вида «Стол 5», иначе имя целиком.
    const short = table.name.match(/^стол\s*(\d+)$/i);
    name.textContent = short ? short[1] : table.name;
    name.title = table.name;

    const sub = document.createElement("div");
    sub.className = "tile-sub";
    sub.dataset.role = "tile-sub";
    tile.append(name, sub);

    const bar = document.createElement("div");
    bar.className = "tile-bar";
    tile.append(bar);

    if (state.editMode) {
      tile.classList.add("editable");
      const handle = document.createElement("span");
      handle.className = "rsz";
      tile.append(handle);
      tile.addEventListener("mousedown", (event) =>
        startTileDrag(event, table, tile, layout, event.target === handle)
      );
    } else {
      // Клик — выделение (два клика до двойного взаимно погасят друг
      // друга, выбор не собьётся). Двойной клик — то же меню действий,
      // что и правый клик: так до открытия стола одинаково удобно
      // добираться и мышью, и на планшете.
      tile.addEventListener("click", () => toggleSelect(table.id));
      tile.addEventListener("dblclick", (event) =>
        showContextMenu(event, table, tile)
      );
      tile.addEventListener("contextmenu", (event) =>
        showContextMenu(event, table, tile)
      );
    }
    planEl.append(tile);
  }

  updateSelectionUI();
  updateTiles();
  fitPlanToViewport();
  if (state.editMode) renderDevicePalette();
}

/** Клик по устройству на плане: те же кнопки, что на вкладке «Устройства». */
function openDeviceControl(device) {
  const body = document.createElement("div");
  body.append(
    buildDeviceChip(device, async () => {
      closeModal();
      await refreshDashboard();
    })
  );
  openModal(device.name, body);
}

/**
 * Палитра редактора: устройства, которых ещё нет на плане. Стоящие
 * там уже — не показываем: одно устройство стоит в одном месте.
 */
function renderDevicePalette() {
  const box = document.getElementById("pal-devices");
  if (!box || !state.edit) return;
  const placed = new Set(
    state.edit.elements.filter((el) => el.type === "device").map((el) => el.device_id)
  );
  box.replaceChildren();
  for (const device of state.hallDevices) {
    if (placed.has(device.id)) continue;
    const meta = DEVICE_TYPES[device.type] ?? DEVICE_TYPES.exhaust;
    const btn = document.createElement("button");
    btn.className = "pal-tool";
    btn.dataset.tool = `device:${device.id}`;
    btn.append(icon(meta.ic), device.name);
    btn.title = meta.label;
    btn.addEventListener("click", () => setEditorTool(btn.dataset.tool));
    box.append(btn);
  }
  document.getElementById("pal-devices-hint").hidden = state.hallDevices.length > 0 && box.children.length === 0;
}

/**
 * Сетка плана (40×25 клеток по умолчанию) обычно намного больше, чем
 * реально занято столами — на телефоне это выглядит как крошечная кучка
 * плиток в углу большого пустого поля. Вместо всей сетки вписываем в экран
 * только фактически занятую область (столы + мебель), с отступом на
 * пару клеток — так обзор на маленьком экране крупнее и понятнее.
 * В редакторе зала не трогаем — там нужна точная сетка 1:1.
 */
function fitPlanToViewport() {
  const wrap = document.querySelector(".plan-scroll");
  const planEl = document.getElementById("plan");
  if (!wrap || !planEl) return;
  if (state.editMode) {
    planEl.style.transform = "";
    wrap.style.height = "";
    return;
  }
  const available = wrap.clientWidth;
  if (!available) return;

  const planData = state.plan;
  const layouts = resolveLayouts();
  let maxX = 0;
  let maxY = 0;
  for (const layout of layouts.values()) {
    maxX = Math.max(maxX, layout.x + layout.w);
    maxY = Math.max(maxY, layout.y + layout.h);
  }
  for (const el of planData.elements) {
    maxX = Math.max(maxX, el.x + el.w);
    maxY = Math.max(maxY, el.y + el.h);
  }
  const contentCols = Math.min(planData.cols, Math.max(6, maxX + 2));
  const contentRows = Math.min(planData.rows, Math.max(4, maxY + 2));
  const contentWidth = contentCols * CELL;
  const contentHeight = contentRows * CELL;

  // Увеличиваем (для лучшего обзора) только на телефоне/планшете — на
  // десктопе, где места и так достаточно, план не трогаем, только не даём
  // ему вылезти за пределы контейнера. Не уменьшаем сильнее чем в 3 раза,
  // чтобы столы оставались кликабельного размера.
  const maxScale = window.innerWidth < 900 ? 1.5 : 1;
  const scale = Math.max(0.33, Math.min(maxScale, available / contentWidth));
  if (Math.abs(scale - 1) < 0.02) {
    planEl.style.transform = "";
    wrap.style.height = "";
    return;
  }
  planEl.style.transformOrigin = "top left";
  planEl.style.transform = `scale(${scale})`;
  wrap.style.height = `${Math.ceil(contentHeight * scale)}px`;
}

// ---------------------------------------------------------------- plan editor

function enterPlanEditor() {
  setDashView();
  const layouts = resolveLayouts();
  state.editMode = true;
  state.edit = {
    cols: state.plan.cols,
    rows: state.plan.rows,
    elements: state.plan.elements.map((el) => ({ ...el })),
    layouts,
    changed: new Set(),
    tool: "move",
  };
  document.getElementById("editor-palette").hidden = false;
  document.getElementById("plan-cols").value = state.edit.cols;
  document.getElementById("plan-rows").value = state.edit.rows;
  setEditorTool("move");
  clearSelection();
  renderMap();
}

function exitPlanEditor() {
  state.editMode = false;
  state.edit = null;
  document.getElementById("editor-palette").hidden = true;
  refreshDashboard().catch(() => {});
}

/**
 * Есть ли в редакторе несохранённые правки: сравниваем с тем, что лежит
 * на сервере. Нужно, чтобы не спрашивать зря, когда ничего не менялось.
 */
function planEditorHasChanges() {
  if (!state.editMode || !state.edit) return false;
  if (state.edit.cols !== state.plan.cols || state.edit.rows !== state.plan.rows) {
    return true;
  }
  if (state.edit.changed && state.edit.changed.size > 0) return true;
  const key = (el) => `${el.type}:${el.device_id ?? ""}:${el.x},${el.y},${el.w},${el.h}`;
  const before = state.plan.elements.map(key).sort().join("|");
  const after = state.edit.elements.map(key).sort().join("|");
  return before !== after;
}

/**
 * Спрашивает про несохранённый план перед уходом. Вызывает continueFn,
 * когда можно продолжать (сохранили или решили выйти без сохранения).
 */
function confirmLeavePlanEditor(continueFn) {
  if (!planEditorHasChanges()) {
    exitPlanEditor();
    continueFn();
    return;
  }
  const body = document.createElement("div");
  const text = document.createElement("p");
  text.className = "hint";
  text.textContent =
    "В редакторе зала есть несохранённые изменения: расстановка столов, " +
    "стены или мебель. Если уйти сейчас, они пропадут.";
  body.append(text);

  const actions = document.createElement("div");
  actions.className = "settings-actions";

  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = "Сохранить и перейти";
  save.addEventListener("click", async () => {
    const ok = await savePlanEditor();
    if (!ok) return; // не сохранилось — остаёмся в редакторе
    closeModal();
    continueFn();
  });

  const drop = document.createElement("button");
  drop.className = "mini danger";
  drop.textContent = "Уйти без сохранения";
  drop.addEventListener("click", () => {
    exitPlanEditor();
    closeModal();
    continueFn();
  });

  const stay = document.createElement("button");
  stay.className = "mini";
  stay.textContent = "Остаться";
  stay.addEventListener("click", closeModal);

  actions.append(save, drop, stay);
  body.append(actions);
  openModal("Изменения не сохранены", body);
}

function setEditorTool(tool) {
  if (state.edit) state.edit.tool = tool;
  for (const btn of document.querySelectorAll(".pal-tool")) {
    btn.classList.toggle("sel", btn.dataset.tool === tool);
  }
  document.getElementById("plan").dataset.tool = tool;
}

async function savePlanEditor() {
  try {
    await api("/api/plan", {
      method: "PUT",
      body: JSON.stringify({
        cols: state.edit.cols,
        rows: state.edit.rows,
        elements: state.edit.elements.map(({ type, x, y, w, h, device_id }) => ({
          type, x, y, w, h, ...(type === "device" ? { device_id } : {}),
        })),
      }),
    });
    // Сохраняем раскладку всех столов (включая авторасставленные).
    for (const [tableId, layout] of state.edit.layouts) {
      await api(`/api/tables/${tableId}/layout`, {
        method: "PUT",
        body: JSON.stringify(layout),
      });
    }
    showToast("План зала сохранён", true);
    exitPlanEditor();
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  }
}

/** Перетаскивание/растягивание стола в редакторе. */
function startTileDrag(event, table, tile, layout, isResize) {
  if (state.edit.tool !== "move") return;
  event.preventDefault();
  event.stopPropagation();
  const start = { x: event.clientX, y: event.clientY };
  const orig = { ...layout };
  const tip = document.createElement("div");
  tip.className = "size-tip";
  document.getElementById("plan").append(tip);
  tile.classList.add(isResize ? "resizing" : "dragging");

  const onMove = (e) => {
    const dxCells = Math.round((e.clientX - start.x) / CELL);
    const dyCells = Math.round((e.clientY - start.y) / CELL);
    const next = { ...orig };
    if (isResize) {
      next.w = Math.max(2, Math.min(16, orig.w + dxCells));
      next.h = Math.max(1, Math.min(12, orig.h + dyCells));
    } else {
      next.x = Math.max(0, Math.min(state.edit.cols - orig.w, orig.x + dxCells));
      next.y = Math.max(0, Math.min(state.edit.rows - orig.h, orig.y + dyCells));
    }
    Object.assign(layout, next);
    tile.style.left = `${next.x * CELL}px`;
    tile.style.top = `${next.y * CELL}px`;
    tile.style.width = `${next.w * CELL}px`;
    tile.style.height = `${next.h * CELL}px`;
    tip.textContent = isResize
      ? `${next.w} × ${next.h} клеток`
      : `${next.x}, ${next.y}`;
    tip.style.left = `${(next.x + next.w) * CELL + 6}px`;
    tip.style.top = `${(next.y + next.h) * CELL + 6}px`;
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    tile.classList.remove("resizing", "dragging");
    tip.remove();
    state.edit.layouts.set(table.id, { ...layout });
    state.edit.changed.add(table.id);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

/** Перетаскивание/растягивание стены, двери или мебели в редакторе. */
function startElementDrag(event, index, div, isResize) {
  if (state.edit.tool !== "move") return;
  event.preventDefault();
  event.stopPropagation();
  const el = state.edit.elements[index];
  const start = { x: event.clientX, y: event.clientY };
  const orig = { ...el };
  const tip = document.createElement("div");
  tip.className = "size-tip";
  document.getElementById("plan").append(tip);
  div.classList.add(isResize ? "resizing" : "dragging");

  const onMove = (e) => {
    const dxCells = Math.round((e.clientX - start.x) / CELL);
    const dyCells = Math.round((e.clientY - start.y) / CELL);
    if (isResize) {
      el.w = Math.max(1, Math.min(state.edit.cols - el.x, orig.w + dxCells));
      el.h = Math.max(1, Math.min(state.edit.rows - el.y, orig.h + dyCells));
    } else {
      el.x = Math.max(0, Math.min(state.edit.cols - orig.w, orig.x + dxCells));
      el.y = Math.max(0, Math.min(state.edit.rows - orig.h, orig.y + dyCells));
    }
    div.style.left = `${el.x * CELL}px`;
    div.style.top = `${el.y * CELL}px`;
    div.style.width = `${el.w * CELL}px`;
    div.style.height = `${el.h * CELL}px`;
    tip.textContent = isResize ? `${el.w} × ${el.h} клеток` : `${el.x}, ${el.y}`;
    tip.style.left = `${(el.x + el.w) * CELL + 6}px`;
    tip.style.top = `${(el.y + el.h) * CELL + 6}px`;
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    div.classList.remove("resizing", "dragging");
    tip.remove();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// Стена и дверь — тянутся линией по одной оси. Мебель ставится кликом
// (со своим размером по умолчанию) и растягивается свободным прямоугольником.
const LINE_TOOLS = new Set(["wall", "door"]);
const FURNITURE_DEFAULTS = {
  sofa: { w: 3, h: 1 },
  armchair: { w: 1, h: 1 },
  deco_table: { w: 2, h: 2 },
  tv: { w: 2, h: 1 },
  device: { w: 4, h: 2 }, // иконка и название читаются, дальше — растянуть
};

/** Рисование стены/двери/мебели и ластик. */
function planDrawStart(event) {
  const tool = state.edit?.tool;
  if (!tool || tool === "move") return;

  // Ластиком можно удалить и стол — удаление столов перенесли сюда, чтобы
  // на рабочей карте зала кассир не мог случайно снести стол.
  const tile = event.target.closest(".tile");
  if (tile) {
    if (tool !== "erase") return;
    event.preventDefault();
    const table = state.tables.find(
      (t) => t.id === Number(tile.dataset.tableId)
    );
    if (table) deleteTableConfirm(table);
    return;
  }
  event.preventDefault();

  if (tool === "erase") {
    const el = event.target.closest(".plan-el");
    if (el) {
      state.edit.elements.splice(Number(el.dataset.elIndex), 1);
      renderMap();
    }
    return;
  }

  const { cols, rows } = state.edit;
  const clampBox = (box) => {
    const w = Math.min(box.w, cols);
    const h = Math.min(box.h, rows);
    return {
      type: box.type,
      w, h,
      x: Math.max(0, Math.min(box.x, cols - w)),
      y: Math.max(0, Math.min(box.y, rows - h)),
    };
  };

  // Устройство зала ставится кликом, как мебель, но помнит, какое оно.
  const deviceId = tool.startsWith("device:") ? Number(tool.slice(7)) : null;
  const kind = deviceId === null ? tool : "device";

  const startCell = planCellFromEvent(event);
  const preview = document.createElement("div");
  preview.className = `plan-el ${kind} preview`;
  document.getElementById("plan").append(preview);
  const def = FURNITURE_DEFAULTS[kind] || { w: 1, h: 1 };
  let current = clampBox({ type: kind, x: startCell.x, y: startCell.y, ...def });

  const applyPreview = (cell) => {
    const dx = cell.x - startCell.x;
    const dy = cell.y - startCell.y;
    if (LINE_TOOLS.has(kind)) {
      // Ось с бОльшим смещением задаёт направление линии.
      current = Math.abs(dx) >= Math.abs(dy)
        ? { type: kind, x: Math.min(startCell.x, cell.x), y: startCell.y, w: Math.abs(dx) + 1, h: 1 }
        : { type: kind, x: startCell.x, y: Math.min(startCell.y, cell.y), w: 1, h: Math.abs(dy) + 1 };
    } else if (dx === 0 && dy === 0) {
      // Просто клик без протяжки — ставим мебель размером по умолчанию.
      current = clampBox({ type: kind, x: startCell.x, y: startCell.y, ...def });
    } else {
      // Протяжка — свободный прямоугольник в обе стороны.
      current = clampBox({
        type: kind,
        x: Math.min(startCell.x, cell.x),
        y: Math.min(startCell.y, cell.y),
        w: Math.abs(dx) + 1,
        h: Math.abs(dy) + 1,
      });
    }
    preview.style.left = `${current.x * CELL}px`;
    preview.style.top = `${current.y * CELL}px`;
    preview.style.width = `${current.w * CELL}px`;
    preview.style.height = `${current.h * CELL}px`;
  };
  applyPreview(startCell);

  const onMove = (e) => applyPreview(planCellFromEvent(e));
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    preview.remove();
    if (deviceId !== null) current.device_id = deviceId;
    state.edit.elements.push(current);
    // Устройство стоит в одном месте — после установки инструмент
    // возвращается к перемещению, чтобы второй клик не поставил дубль.
    if (deviceId !== null) setEditorTool("move");
    renderMap();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

/** Текст под номером на плитке: таймер/остаток. */
function updateTiles() {
  for (const table of state.tables) {
    const tile = document.querySelector(`.tile[data-table-id="${table.id}"]`);
    if (!tile) continue;
    const sub = tile.querySelector('[data-role="tile-sub"]');
    if (!table.session) {
      sub.textContent = bookingSoon(table)
        ? `бронь ${new Date(Date.parse(table.booking.starts_at)).toLocaleTimeString(
            "ru-RU",
            { hour: "2-digit", minute: "2-digit" }
          )}`
        : "";
      continue;
    }
    if (table.session.prepaid) {
      const remaining = remainingSeconds(table);
      if (remaining <= 0) {
        sub.textContent = "время вышло";
        tile.classList.remove("prepaid", "ending");
        tile.classList.add("expired");
      } else {
        sub.textContent = `-${formatDuration(remaining)}`;
        // Последние минуты — стол подсвечивается, чтобы кассир успел
        // подойти и предложить продление.
        const warnAfter = state.warnBeforeMinutes * 60;
        tile.classList.toggle("ending", warnAfter > 0 && remaining <= warnAfter);
      }
    } else {
      sub.textContent = formatDuration(liveElapsedSeconds(table));
    }
  }
}

/**
 * Вид зала. Раньше можно было переключаться между картой и «карточками»;
 * карточки убрали — карта показывает то же самое и нагляднее. Функция
 * оставлена, чтобы редактор зала и старые настройки в браузере ничего
 * не ломали.
 */
function setDashView() {
  state.view = "map";
  document.getElementById("tables").hidden = true;
  renderTables(); // сама решит: карта или список для телефона
}

/**
 * Телефон и маленький планшет: карта зала на таком экране бесполезна
 * (столы стоят по координатам и не помещаются). Вместо неё — крупный
 * список столов, где всё делается пальцем в одно-два касания.
 */
const PHONE_MEDIA = window.matchMedia("(max-width: 760px)");

function isPhoneMode() {
  return PHONE_MEDIA.matches;
}

/** Крупная кнопка для списка на телефоне. */
function phoneAction(label, iconName, handler) {
  const btn = document.createElement("button");
  btn.className = "phone-action";
  btn.append(...withIcon(iconName, label));
  btn.addEventListener("click", handler);
  return btn;
}

/** Меню действий над столом — то же, что по правому клику, но пальцем. */
function openPhoneActions(table) {
  const body = document.createElement("div");
  const actions = document.createElement("div");
  actions.className = "phone-actions";

  if (table.session) {
    if (table.session.prepaid) {
      actions.append(
        phoneAction("Продлить время…", "timer", () => openExtendModal(table))
      );
    }
    actions.append(
      phoneAction("Пересадить на стол…", "move", () => openMoveModal(table)),
      phoneAction("Закрыть стол…", "card", () => openCloseModal(table))
    );
  } else {
    actions.append(
      phoneAction("Открыть…", "play", () => openStartSessionModal(table)),
      phoneAction("Чек на сумму…", "card", () => openCheckModal(table)),
      phoneAction("Открыть по чеку…", "gift", () => openVoucherModal(table)),
      phoneAction("Забронировать…", "calendar", () => openBookingModal(table))
    );
    if (can("open_free_time")) {
      actions.append(
        phoneAction("Бесплатное время", "gift", () => openFreeTimeSession(table))
      );
    }
  }
  if (table.booking) {
    actions.append(
      phoneAction("Отменить бронь", "close", () => cancelTableBooking(table))
    );
  }
  if (can("manage_tables")) {
    actions.append(
      phoneAction(
        table.light_on ? "Выключить свет" : "Включить свет",
        "bulb",
        () => toggleTableLight(table)
      )
    );
  }
  body.append(actions);
  openModal(table.name, body);
}

/** Список столов для телефона: состояние крупно, действие — по касанию. */
function renderPhoneList() {
  const box = document.getElementById("phone-list");
  box.replaceChildren();
  for (const table of state.tables) {
    const row = document.createElement("button");
    row.className = `phone-row ${tableStatusClass(table)}`;
    row.dataset.tableId = String(table.id);

    const name = document.createElement("span");
    name.className = "phone-name";
    name.textContent = table.name;

    const state_ = document.createElement("span");
    state_.className = "phone-state";
    state_.dataset.role = "phone-state";
    state_.textContent = phoneStateText(table);

    row.append(name, state_);
    row.addEventListener("click", () => openPhoneActions(table));
    box.append(row);
  }
}

/** Подпись состояния стола в списке для телефона. */
function phoneStateText(table) {
  if (!table.session) {
    return bookingSoon(table)
      ? `бронь ${new Date(Date.parse(table.booking.starts_at)).toLocaleTimeString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
        })}`
      : "свободен";
  }
  if (table.session.prepaid) {
    const left = remainingSeconds(table);
    return left > 0 ? `осталось ${formatDuration(left)}` : "ВРЕМЯ ВЫШЛО";
  }
  return `идёт ${formatDuration(liveElapsedSeconds(table))} · ${money(liveCost(table))}`;
}

function renderTables() {
  // Загрузка клуба: занято / всего.
  const busy = state.tables.filter((t) => t.session).length;
  const load = document.getElementById("club-load");
  load.textContent = `Загрузка клуба ${busy}/${state.tables.length}`;

  // На телефоне вместо карты — список; на большом экране всё как было.
  const phone = isPhoneMode() && !state.editMode;
  document.getElementById("phone-list").hidden = !phone;
  document.getElementById("map-wrap").hidden = phone;
  if (phone) {
    renderPhoneList();
    return;
  }

  if (state.view === "map") {
    renderMap();
    return;
  }
  const container = document.getElementById("tables");
  container.replaceChildren();
  for (const table of state.tables) {
    container.append(buildTableCard(table));
  }
}

/** Секундный тик: обновляет только цифры, без перерисовки карточек. */
function tick() {
  if (state.editMode) return;
  checkTimeWarnings();
  if (activeTab === "devices") updateDeviceCountdowns();
  if (activeTab === "dashboard" && isPhoneMode()) {
    for (const table of state.tables) {
      const row = document.querySelector(`.phone-row[data-table-id="${table.id}"]`);
      const label = row?.querySelector('[data-role="phone-state"]');
      if (label) label.textContent = phoneStateText(table);
    }
  } else if (state.view === "map" && activeTab === "dashboard") {
    updateTiles();
  }
  for (const table of state.tables) {
    if (!table.session) continue;
    const card = document.querySelector(`.card[data-table-id="${table.id}"]`);
    if (!card) continue;
    const timer = card.querySelector('[data-role="timer"]');
    const cost = card.querySelector('[data-role="cost"]');
    if (table.session.prepaid) {
      if (!timer) continue;
      const remaining =
        table.session.remaining_seconds -
        (performance.now() - state.fetchedAt) / 1000;
      if (remaining <= 0) {
        timer.textContent = "ВРЕМЯ ВЫШЛО";
        timer.classList.add("expired");
      } else {
        timer.textContent = formatDuration(remaining);
        timer.classList.remove("expired");
      }
      continue;
    }
    if (timer) timer.textContent = formatDuration(liveElapsedSeconds(table));
    if (cost) cost.textContent = `${money(liveCost(table))}`;
  }
}

async function refreshDashboard() {
  if (state.editMode) return; // пока редактируют план — данные не трогаем
  const [tables, tariffs, auto, plan, promo, devices] = await Promise.all([
    api("/api/dashboard"),
    api("/api/tariffs"),
    api("/api/tariffs/auto"),
    api("/api/plan"),
    api("/api/promotions/active").catch(() => ({ promotion: null })),
    api("/api/devices").catch(() => []),
  ]);
  state.promotion = promo.promotion ?? null;
  // Стол продлили — время снова есть, значит и предупредить о нём надо
  // будет заново.
  for (const table of tables) {
    const sid = table.session?.session_id;
    if (!sid || !table.session.prepaid) continue;
    const left =
      table.session.remaining_seconds - 0; // свежий ответ сервера, дрейфа нет
    const warnAfter = state.warnBeforeMinutes * 60;
    if (left > warnAfter) state.warned.delete(sid);
    if (left > 0) state.warnedOver.delete(sid);
  }
  state.tables = tables;
  state.tariffs = tariffs;
  state.autoTariffId = auto.tariff_id;
  state.plan = plan;
  state.hallDevices = devices; // для плиток на плане и полоски в шапке
  state.fetchedAt = performance.now();
  renderTables();
  renderDevicesStrip(devices);
}

/**
 * Полоска устройств в шапке зала: по иконке на устройство, цвет —
 * состояние (зелёная — работает, красная — реле не отвечает), у решётки
 * рядом процент. Подробности — во всплывающей подсказке, клик —
 * управление. Места почти не занимает, зато видно всё сразу.
 */
function renderDevicesStrip(devices) {
  const strip = document.getElementById("devices-strip");
  strip.replaceChildren(
    ...devices.map((device) => {
      const meta = DEVICE_TYPES[device.type] ?? DEVICE_TYPES.exhaust;
      const btn = document.createElement("button");
      const offline = device.relay_error || device.online === false;
      btn.className = `device-dot${device.is_on ? " on" : ""}${offline ? " err" : ""}`;
      btn.title =
        `${device.name}: ${deviceStatusText(device, device.switches_in_seconds)}` +
        (device.online === false ? " · нет связи" : "");
      btn.append(icon(meta.ic));
      if (device.type === "damper" && device.position && device.positions.length > 1) {
        btn.append(`${device.position}%`);
      }
      btn.addEventListener("click", () => openDeviceControl(device));
      return btn;
    })
  );
  strip.hidden = devices.length === 0;
}

// ------------------------------------------- устройства зала (вытяжка и т. п.)

/** Подпись типа реле — для таблиц состояния. */
function relayKindLabel(kind) {
  return (LIGHT_KINDS.find(([value]) => value === (kind ?? ""))?.[1] ?? kind ?? "—")
    .replace(/ \(.*\)$/, "")
    .replace(/ — .*$/, "");
}

/** Как реле называется в таблице: тип (и канал или id в облаке). */
function relayIdentity(relay) {
  const kind = relay.kind ?? relay.light_kind;
  const channel = Number(relay.channel ?? relay.light_channel ?? 0);
  if (kind === "tasmota" || kind === "shelly") {
    return `${relayKindLabel(kind)}${channel ? ` · канал ${channel}` : ""}`;
  }
  if (kind === "url") return "Своё устройство";
  return `Tuya / MOES ${relay.device_id ?? relay.tuya_device_id ?? ""}`.trim();
}

/** «12:34», а если не сегодня — с датой. */
function formatSeen(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString("ru-RU", {
    ...(today ? {} : { day: "2-digit", month: "2-digit" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Связь с реле одним словом: по последнему опросу. */
function linkState(item) {
  const bound = item.light_kind || item.tuya_device_id || item.kind;
  if (!bound) return { text: "без реле", cls: "muted" };
  if (item.online === true) return { text: "в сети", cls: "ok" };
  if (item.online === false) return { text: "нет связи", cls: "bad" };
  return { text: "не проверяется", cls: "muted" };
}

/** Виды устройств зала: подпись и иконка (для плашек, таблицы и плана). */
const DEVICE_TYPES = {
  ac: { label: "Кондиционер", ic: "ac" },
  exhaust: { label: "Вытяжка", ic: "exhaust" },
  intake: { label: "Приток", ic: "intake" },
  damper: { label: "Решётка канала", ic: "damper" },
};

/** «через 7 мин» / «через 40 с» — до смены фазы цикла. */
function formatSwitchIn(seconds) {
  if (seconds >= 90) return `через ${Math.round(seconds / 60)} мин`;
  return `через ${Math.max(0, Math.round(seconds))} с`;
}

/** Подпись состояния устройства для плашки. secondsLeft — уже с учётом
 * времени, прошедшего после ответа сервера. */
function deviceStatusText(device, secondsLeft) {
  if (device.type === "damper") {
    if (!device.position) return "закрыта";
    return device.positions.length === 1 ? "открыта" : `открыта на ${device.position}%`;
  }
  let text = device.is_on ? "работает" : "стоит";
  if (device.cycle_on && device.should_be_on !== device.is_on) {
    // Фаза уже сменилась, а реле ещё нет: либо ждём ближайший тик
    // (до полуминуты), либо реле молчит — сервер знает, что из двух.
    return device.relay_error
      ? `${text} · реле не отвечает, пробуем снова`
      : `${text} · переключается…`;
  }
  if (device.cycle_on) {
    text +=
      secondsLeft === null
        ? " · цикл без пауз"
        : ` · ${device.is_on ? "выключится" : "включится"} ${formatSwitchIn(secondsLeft)}`;
  }
  return text;
}

/** Секундная стрелка плашек: между опросами сервера отсчёт идёт сам. */
function updateDeviceCountdowns() {
  const elapsed = (performance.now() - state.devicesFetchedAt) / 1000;
  for (const device of state.hallDevices) {
    const label = document.querySelector(
      `.device-chip[data-device-id="${device.id}"] .device-status`
    );
    if (!label) continue;
    const left =
      device.switches_in_seconds === null ? null : device.switches_in_seconds - elapsed;
    label.textContent = deviceStatusText(device, left);
  }
}

/**
 * Плашка устройства: состояние, когда переключится, кнопки «включить/
 * выключить» и «цикл». Это не стол: ни таймера, ни денег — только реле.
 */
function buildDeviceChip(device, afterAction = refreshDevicesTab) {
  const chip = document.createElement("div");
  chip.className = `device-chip${device.is_on ? " on" : ""}`;
  chip.dataset.deviceId = device.id;

  const meta = DEVICE_TYPES[device.type] ?? DEVICE_TYPES.exhaust;
  const name = document.createElement("b");
  name.append(icon(meta.ic), ` ${device.name}`);
  name.title = meta.label;

  // Связь с реле: видно сразу, кто отвалился от сети.
  const link = linkState(device);
  const linkEl = document.createElement("span");
  linkEl.className = `device-link ${link.cls}`;
  linkEl.textContent = link.text;
  if (device.online === false && device.last_seen) {
    linkEl.textContent += ` с ${formatSeen(device.last_seen)}`;
  }
  linkEl.title = device.last_seen
    ? `Выходило на связь: ${formatDateTime(device.last_seen)}`
    : "";
  name.append(" ", linkEl);

  const status = document.createElement("span");
  status.className = "device-status";
  status.textContent = deviceStatusText(device, device.switches_in_seconds);

  const call = async (url, body) => {
    try {
      await api(url, { method: "POST", body: JSON.stringify(body) });
      await afterAction();
    } catch (error) {
      showToast(error.message);
    }
  };

  // Решётка: кнопка на каждое положение и «Закрыть»; цикла у неё нет.
  if (device.type === "damper") {
    chip.append(name, status);
    for (const percent of [...device.positions, 0]) {
      const btn = document.createElement("button");
      btn.className = `mini${device.position === percent ? " active" : ""}`;
      btn.textContent = !percent
        ? "Закрыть"
        : device.positions.length === 1
          ? "Открыть"
          : `${percent}%`;
      btn.addEventListener("click", () =>
        call(`/api/devices/${device.id}/position`, { percent })
      );
      chip.append(btn);
    }
    return chip;
  }

  const power = document.createElement("button");
  power.className = "mini";
  power.textContent = device.is_on ? "Выключить" : "Включить";
  power.title = device.cycle_on
    ? "Переключить сейчас — цикл начнётся заново с этой фазы"
    : "Переключить реле";
  power.addEventListener("click", () =>
    call(`/api/devices/${device.id}/power`, { on: !device.is_on })
  );

  const cycle = document.createElement("button");
  cycle.className = `mini${device.cycle_on ? " active" : ""}`;
  cycle.textContent = `Цикл ${device.work_minutes}/${device.rest_minutes}`;
  cycle.title = device.cycle_on
    ? `Работает ${device.work_minutes} мин, стоит ${device.rest_minutes} — по кругу. Нажмите, чтобы остановить`
    : `Запустить по кругу: работает ${device.work_minutes} мин, стоит ${device.rest_minutes}`;
  cycle.addEventListener("click", () =>
    call(`/api/devices/${device.id}/cycle`, { on: !device.cycle_on })
  );

  chip.append(name, status, power, cycle);
  return chip;
}

function renderDevicesBar(devices) {
  const bar = document.getElementById("devices-bar");
  // Не map(buildDeviceChip): map подсунул бы индекс вместо afterAction.
  bar.replaceChildren(...devices.map((device) => buildDeviceChip(device)));
  bar.hidden = devices.length === 0;
  document.getElementById("devices-none").hidden = devices.length > 0;
}

/**
 * Вкладка «Устройства»: плашки перерисовываются каждым опросом, а
 * таблица настройки — только пока в ней никто не печатает: значения в
 * ней сохраняются по уходу из поля, и перерисовка под руками их бы
 * стёрла.
 */
async function refreshDevicesTab() {
  const [devices, relays] = await Promise.all([api("/api/devices"), api("/api/relays")]);
  state.hallDevices = devices;
  state.devicesFetchedAt = performance.now();
  renderDevicesBar(devices);
  renderRelayRows(relays);
}

/**
 * Все реле — над столами и у устройств: IP и MAC (правятся на месте),
 * связь, состояние и когда выходило на связь. Свет над столом
 * переключается отсюда же (право «Столы»).
 */
function renderRelayRows(relays) {
  const rows = document.getElementById("relay-rows");
  // Пока в таблице печатают, опрос её не перерисовывает: значение
  // сохраняется по уходу из поля.
  if (rows.contains(document.activeElement)) return;
  rows.replaceChildren();
  for (const relay of relays) {
    const tr = document.createElement("tr");
    const cell = (text) => {
      const td = document.createElement("td");
      td.append(text);
      return td;
    };
    const link = linkState(relay);
    const linkEl = document.createElement("span");
    linkEl.className = `device-link ${link.cls}`;
    linkEl.textContent = link.text;

    // Реле узнаётся по типу; над каким столом или у какого устройства —
    // мелко рядом.
    const identity = document.createElement("span");
    identity.textContent = relayIdentity(relay);
    const where = document.createElement("span");
    where.className = "hint";
    where.textContent = ` — ${relay.name}`;
    const relayCell = document.createElement("td");
    relayCell.append(identity, where);

    // IP и MAC: правит разработчик (столы) или кто ведёт настройки
    // (устройства); остальным — текстом.
    const editable =
      state.user?.role === "developer" ||
      (relay.scope === "device" && state.permissions.manage_settings);
    const netField = (value, placeholder, size) => {
      if (!editable) return cell(value || "—");
      const input = document.createElement("input");
      input.type = "text";
      input.value = value ?? "";
      input.placeholder = placeholder;
      input.size = size;
      input.spellcheck = false;
      return cell(input);
    };
    const ipCell = netField(relay.ip, "192.168.1.50", 14);
    const macCell = netField(relay.mac, "A4:CF:12:34:56:78", 17);
    if (editable) {
      const save = async () => {
        try {
          await api(`/api/relays/${relay.scope}/${relay.id}/net`, {
            method: "PUT",
            body: JSON.stringify({
              ip: ipCell.firstChild.value,
              mac: macCell.firstChild.value,
            }),
          });
          showToast(`${relay.name}: сохранено`, true);
          await refreshDevicesTab();
        } catch (error) {
          showToast(error.message);
        }
      };
      ipCell.firstChild.addEventListener("change", save);
      macCell.firstChild.addEventListener("change", save);
    }

    const stateCell = document.createElement("td");
    if (relay.scope === "table") {
      stateCell.append(relay.light_on ? "горит" : "выключен");
      if (state.permissions.manage_tables) {
        const toggle = document.createElement("button");
        toggle.className = "mini";
        toggle.style.marginLeft = "8px";
        toggle.textContent = relay.light_on ? "Выключить" : "Включить";
        toggle.addEventListener("click", async () => {
          try {
            await api(`/api/tables/${relay.id}/light`, {
              method: "POST",
              body: JSON.stringify({ on: !relay.light_on }),
            });
            await refreshDevicesTab();
          } catch (error) {
            showToast(error.message);
          }
        });
        stateCell.append(toggle);
      }
    } else {
      const device = state.hallDevices.find((d) => d.id === relay.id);
      stateCell.append(device ? deviceStatusText(device, device.switches_in_seconds) : "—");
    }
    const seenCell = cell(formatSeen(relay.last_seen));
    seenCell.title = relay.last_seen
      ? formatDateTime(relay.last_seen)
      : "С запуска программы не отвечало";
    tr.append(relayCell, ipCell, macCell, cell(linkEl), stateCell, seenCell);
    rows.append(tr);
  }
  document.getElementById("relays-empty").hidden = relays.length > 0;
}

async function loadClients() {
  state.clients = await api("/api/clients");
  renderClientsDatalist();
}

async function openTable(table, select, clientInput) {
  if (!select.value) {
    showToast("Сначала добавьте тариф");
    return;
  }
  const clientText = clientInput.value.trim();
  const clientId = clientIdFromInput(clientText);
  if (clientText && clientId === null) {
    showToast("Клиент не найден — выберите из списка или оставьте поле пустым");
    return;
  }
  try {
    await api(`/api/tables/${table.id}/open`, {
      method: "POST",
      body: JSON.stringify({ tariff_id: Number(select.value), client_id: clientId }),
    });
    state.clientDraft.delete(table.id);
    showToast(`${table.name}: сеанс открыт (постоплата)`, true);
    await refreshDashboard();
  } catch (error) {
    showToast(error.message);
    await refreshDashboard();
  }
}

// --- Закрытие стола: чек, способ оплаты, печать ---

async function openCloseModal(table) {
  let check;
  try {
    check = await api(`/api/tables/${table.id}/check`);
  } catch (error) {
    showToast(error.message);
    return;
  }

  const body = document.createElement("div");
  const prepaid = Boolean(table.session?.prepaid);

  const lines = document.createElement("div");
  lines.className = "check-lines";
  const addLine = (label, value, strong = false) => {
    const row = document.createElement("div");
    row.className = "check-line" + (strong ? " strong" : "");
    const l = document.createElement("span");
    l.textContent = label;
    const v = document.createElement("span");
    v.textContent = value;
    row.append(l, v);
    lines.append(row);
  };
  // Время всегда считается по факту: и при постоплате, и при предоплате.
  addLine(
    `Время (${formatDuration(check.billed_seconds)})`,
    `${money(check.time_cost)}`
  );
  if (check.discount_percent > 0) {
    addLine(
      `Скидка ${check.discount_percent}%${check.client_name ? ` — ${check.client_name}` : ""}`,
      `−${money(check.time_cost - check.discounted_time)}`
    );
  }
  if (check.bar_cost > 0) {
    addLine("Бар", `${money(check.bar_cost)}`);
  }
  addLine("Итого", `${money(check.total)}`, true);

  if (check.paid_from_account > 0) {
    addLine("Оплачено со счёта клиента", `${money(check.paid_from_account)}`);
  }
  if (prepaid) {
    if (check.paid_by_voucher > 0) {
      addLine(
        `Оплачено чеком${check.voucher_code ? ` ${check.voucher_code}` : ""}`,
        `${money(check.paid_by_voucher)}`
      );
    }
    // «Уже оплачено» — только живые деньги: чек и счёт клиента показаны
    // отдельными строками, иначе одна и та же сумма читается дважды.
    const ownMoney =
      check.prepaid_amount - check.paid_by_voucher - check.paid_from_account;
    if (ownMoney > 0) addLine("Уже оплачено", `${money(ownMoney)}`);

    if (check.voucher_out > 0) {
      // Чек на сумму: остаток не отдаём деньгами, а выдаём чеком.
      addLine(
        `Остаток чеком${check.unused_seconds ? ` (не сыграно ${formatDuration(check.unused_seconds)})` : ""}`,
        `${money(check.voucher_out)}`,
        true
      );
    }
    if (check.change_to_account > 0) {
      // Оплачено со счёта — сдачу из кассы взять неоткуда, она
      // возвращается обратно на счёт клиента.
      addLine(
        `Вернётся на счёт клиента${check.unused_seconds ? ` (не сыграно ${formatDuration(check.unused_seconds)})` : ""}`,
        `${money(check.change_to_account)}`,
        true
      );
    }
    if (check.change > 0) {
      // Оплата «на время»: разницу возвращаем деньгами.
      addLine(
        `Сдача${check.unused_seconds ? ` (не сыграно ${formatDuration(check.unused_seconds)})` : ""}`,
        `${money(check.change)}`,
        true
      );
    }
    if (check.due > 0) {
      addLine(
        `К доплате${check.overtime_seconds ? ` (перебор ${formatDuration(check.overtime_seconds)})` : ""}`,
        `${money(check.due)}`,
        true
      );
    }
    if (check.due === 0 && check.change === 0 && check.voucher_out === 0) {
      addLine("Расчёт", "ровно, доплаты нет", true);
    }
  }
  body.append(lines);

  const closeWith = async (method, useBalance = true) => {
    try {
      const session = await api(`/api/tables/${table.id}/close`, {
        method: "POST",
        body: JSON.stringify({
          ...(method ? { payment_method: method } : {}),
          use_balance: useBalance,
        }),
      });
      closeModal();
      showToast(
        `Сеанс закрыт: ${table.name}, итог ${money(session.total_cost)}`,
        true
      );
      await refreshDashboard();
      if (session.issued_voucher) {
        // Код чека нужно назвать гостю — показываем его отдельным окном,
        // чтобы не потерялся среди уведомлений.
        showVoucherIssued(
          session.issued_voucher,
          () => {
            openReceipt(session.id, { print: true });
            if (session.bonus_voucher) showBonusLater(session.bonus_voucher);
          },
          { reused: Boolean(session.reused_voucher) }
        );
      } else if (session.bonus_voucher) {
        // Подарок за наигранные часы: код тоже нужно назвать гостю.
        showVoucherIssued(
          session.bonus_voucher,
          () => openReceipt(session.id, { print: true }),
          { bonus: true }
        );
      } else {
        // Печать чека — только здесь, при закрытии стола.
        openReceipt(session.id, { print: true });
      }
    } catch (error) {
      showToast(error.message);
      closeModal();
      await refreshDashboard();
    }
  };

  const hint = document.createElement("p");
  hint.className = "hint";
  if (check.due > 0 && (check.account_left ?? 0) > 0) {
    hint.textContent =
      check.due_money > 0
        ? `Со счёта клиента спишется ${money(check.due_from_account)}, ` +
          `деньгами возьмите ещё ${money(check.due_money)}.`
        : `Всё спишется со счёта клиента (${money(check.due_from_account)}) — ` +
          "деньги брать не нужно.";
  } else if (prepaid && check.voucher_out > 0 && check.due > 0) {
    hint.textContent =
      `Возьмите с гостя ещё ${money(check.due)}. Неиспользованный остаток ` +
      `${money(check.voucher_out)} не возвращается деньгами — на него будет ` +
      "выдан чек, по нему гость доиграет в другой день.";
  } else if (prepaid && check.voucher_out > 0) {
    hint.textContent = check.voucher_code
      ? // Играли по чеку — остаток вернётся на него же, новый код гостю
        // называть не нужно.
        `Деньги не возвращаем: остаток ${money(check.voucher_out)} вернётся ` +
        `на тот же чек ${check.voucher_code} — код у гостя не изменится.`
      : `Деньги не возвращаем: на остаток ${money(check.voucher_out)} будет ` +
        "выдан чек — по нему гость доиграет в любой другой день. Код чека " +
        "появится после закрытия и напечатается на чеке.";
  } else if (prepaid && check.change > 0) {
    hint.textContent =
      `Верните гостю ${money(check.change)} — это за неиспользованное ` +
      "оплаченное время. Затем закройте стол.";
  } else if (prepaid && check.due > 0) {
    hint.textContent =
      `Возьмите с гостя ещё ${money(check.due)} и выберите, чем он платит.`;
  } else if (prepaid) {
    hint.textContent = "Всё оплачено ровно — просто закройте стол.";
  } else {
    hint.textContent = "Выберите способ оплаты — стол закроется сразу.";
  }
  body.append(hint);

  // Способ оплаты спрашиваем, когда с гостя ещё нужно взять деньги.
  // Если доплаты нет (или наоборот — сдача), достаточно одной кнопки.
  if (!prepaid || check.due > 0) {
    const pay = accountPayRow(
      (method, useBalance) => closeWith(method, useBalance),
      { actionLabel: "Закрыть со счёта" }
    );
    pay.update(check.account_left ?? 0, check.due);
    body.append(pay.node);
  } else {
    const confirm = document.createElement("button");
    confirm.className = "primary";
    confirm.style.width = "100%";
    confirm.textContent =
      check.change > 0
        ? `Вернуть ${money(check.change)} и закрыть`
        : check.voucher_out > 0
          ? `Выдать чек на ${money(check.voucher_out)} и закрыть`
          : "Закрыть стол";
    confirm.addEventListener("click", () => closeWith(null));
    body.append(confirm);
  }

  openModal(`Закрытие — ${table.name}`, body);
}

// --- Чек: печать ---

/**
 * Стили печатного чека под выбранную ленту.
 *
 * Термопринтер печатает ровно на ширину ленты: если сверстать «как
 * страницу», Windows добавит поля и половина чека уедет. Поэтому при
 * 58 и 80 мм задаём @page с точным размером и нулевыми полями, а шрифт
 * уменьшаем — иначе строки переносятся.
 */
function printStyles() {
  const width = state.receiptWidth ?? "80";
  if (width === "a4") {
    return `
      @page { size: A4; margin: 12mm; }
      body { font-family: "Courier New", monospace; max-width: 320px; margin: 20px auto; font-size: 13px; color: #000; }
      h2 { text-align: center; font-size: 15px; margin: 0 0 4px; }
      .center { text-align: center; }
      table { width: 100%; border-collapse: collapse; margin: 8px 0; }
      td { padding: 2px 0; vertical-align: top; }
      .r { text-align: right; white-space: nowrap; }
      .total td { border-top: 1px dashed #000; font-weight: bold; padding-top: 6px; }
      hr { border: 0; border-top: 1px dashed #000; }`;
  }
  // Ширина ленты минус технические поля печати.
  const paper = width === "58" ? "58mm" : "80mm";
  const content = width === "58" ? "48mm" : "72mm";
  const size = width === "58" ? "11px" : "12px";
  return `
    @page { size: ${paper} auto; margin: 0; }
    body {
      font-family: "Courier New", monospace;
      width: ${content};
      margin: 0 auto;
      padding: 3mm 0 8mm;
      font-size: ${size};
      line-height: 1.25;
      color: #000;
    }
    h2 { text-align: center; font-size: ${width === "58" ? "12px" : "13px"}; margin: 0 0 3px; }
    .center { text-align: center; }
    table { width: 100%; border-collapse: collapse; margin: 5px 0; }
    td { padding: 1px 0; vertical-align: top; word-break: break-word; }
    .r { text-align: right; white-space: nowrap; }
    .total td { border-top: 1px dashed #000; font-weight: bold; padding-top: 4px; }
    hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }`;
}

/** Показывает окно подарка чуть позже — когда уже закрыли предыдущее. */
function showBonusLater(voucher) {
  setTimeout(() => showVoucherIssued(voucher, null, { bonus: true }), 400);
}

/**
 * Окно «выдан чек на остаток»: код нужно назвать гостю и написать на
 * бумажке, поэтому показываем его крупно и отдельно от уведомлений.
 */
function showVoucherIssued(voucher, onPrint, { bonus = false, reused = false } = {}) {
  const body = document.createElement("div");

  const code = document.createElement("p");
  code.className = "voucher-code";
  code.textContent = voucher.code;
  body.append(code);

  const sum = document.createElement("p");
  sum.className = "order-total";
  sum.textContent = bonus
    ? `Подарок: ${voucher.bonus_hours} ч игры (${money(voucher.balance)})`
    : `Остаток на чеке: ${money(voucher.balance)}`;
  body.append(sum);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = bonus
    ? "Гость наиграл очередные часы — это подарок от клуба. Назовите " +
      "код: по нему он сыграет бесплатно в любой день («Открыть по " +
      "чеку…» в меню стола)."
    : reused
      ? "Код тот же, что и был — новый чек гостю не нужен, у него уже есть " +
        "этот номер. Остаток на нём просто уменьшился. Доиграть можно в " +
        "любой день: «Открыть по чеку…» в меню стола."
      : "Назовите код гостю (он есть и на печатном чеке). По этому чеку он " +
        "доиграет в любой другой день: «Открыть по чеку…» в меню стола. " +
        "Деньги за неиспользованное время не возвращаются.";
  body.append(hint);

  const actions = document.createElement("div");
  actions.className = "settings-actions";
  const printBtn = document.createElement("button");
  printBtn.className = "primary";
  printBtn.append(...withIcon("download", "Напечатать чек"));
  printBtn.addEventListener("click", () => {
    closeModal();
    onPrint?.();
  });
  const laterBtn = document.createElement("button");
  laterBtn.className = "mini";
  laterBtn.textContent = "Закрыть";
  laterBtn.addEventListener("click", closeModal);
  actions.append(printBtn, laterBtn);
  body.append(actions);

  openModal(
    bonus
      ? "Подарок постоянному гостю"
      : reused
        ? "Остаток вернулся на тот же чек"
        : "Выдан чек на остаток",
    body
  );
}

/**
 * Чек сеанса. При закрытии стола (print: true) открывается окно печати,
 * а из истории — просто показывается на экране: там чек смотрят глазами,
 * и всплывающее окно печати только мешает.
 */
async function openReceipt(sessionId, { print = false } = {}) {
  let receipt;
  try {
    receipt = await api(`/api/sessions/${sessionId}`);
  } catch (error) {
    showToast(error.message);
    return;
  }
  const esc = (text) =>
    String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const orderRows = receipt.orders
    .map(
      (o) =>
        `<tr><td>${esc(o.item_name)} × ${o.quantity}</td>` +
        `<td class="r">${money(o.price * o.quantity)}</td></tr>`
    )
    .join("");
  const discountRow =
    receipt.discount_percent > 0
      ? `<tr><td>Скидка ${receipt.discount_percent}%${
          receipt.promo_name ? ` (${esc(receipt.promo_name)})` : ""
        }</td><td class="r">−${money(
          (receipt.time_cost ?? 0) * receipt.discount_percent / 100
        )}</td></tr>`
      : "";
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
    <title>Чек №${receipt.id}</title>
    <style>${printStyles()}</style></head><body>
    <h2>${esc(receipt.club_name)}</h2>
    <p class="center">Чек №${receipt.id} · ${esc(receipt.table_name)}</p>
    <hr>
    <table>
      <tr><td>Начало</td><td class="r">${new Date(receipt.started_at).toLocaleString("ru-RU")}</td></tr>
      <tr><td>Конец</td><td class="r">${new Date(receipt.ended_at).toLocaleString("ru-RU")}</td></tr>
      <tr><td>Длительность</td><td class="r">${formatDuration(receipt.duration_seconds)}</td></tr>
      <tr><td>Тариф</td><td class="r">${esc(receipt.tariff_name)} · ${receipt.price_per_hour} ${cur()}/ч</td></tr>
      ${receipt.client_name ? `<tr><td>Клиент</td><td class="r">${esc(receipt.client_name)}</td></tr>` : ""}
    </table>
    <hr>
    <table>
      <tr><td>Время игры</td><td class="r">${money(receipt.time_cost ?? receipt.total_cost)}</td></tr>
      ${discountRow}
      ${orderRows}
      ${receipt.paid_by_voucher > 0
        ? `<tr><td>Оплачено чеком ${esc(receipt.voucher_code ?? "")}</td><td class="r">${money(receipt.paid_by_voucher)}</td></tr>`
        : ""}
      ${receipt.paid_from_account > 0
        ? `<tr><td>Со счёта клиента</td><td class="r">${money(receipt.paid_from_account)}</td></tr>` +
          `<tr><td>Остаток на счету</td><td class="r">${money(receipt.client_account)}</td></tr>`
        : ""}
      <tr class="total"><td>ИТОГО</td><td class="r">${money(receipt.total_cost)}</td></tr>
      <tr><td>Оплата</td><td class="r">${PAYMENT_LABELS[receipt.payment_method] ?? "—"}</td></tr>
      ${receipt.closed_by_name ? `<tr><td>Кассир</td><td class="r">${esc(receipt.closed_by_name)}</td></tr>` : ""}
    </table>
    ${receipt.bonus_voucher
      ? `<hr><p class="center"><b>ПОДАРОК КЛУБА ${esc(receipt.bonus_voucher.code)}</b><br>` +
        `${money(receipt.bonus_voucher.balance)} бесплатной игры<br>` +
        `Назовите код — и играйте в любой день</p>`
      : ""}
    ${receipt.issued_voucher
      ? `<hr><p class="center"><b>ЧЕК НА ОСТАТОК ${esc(receipt.issued_voucher.code)}</b><br>` +
        `${money(receipt.issued_voucher.balance)}<br>` +
        `Действует без срока: назовите код,<br>чтобы доиграть в другой день</p>`
      : ""}
    <p class="center">Спасибо! Ждём вас снова</p>
    ${print ? "<script>window.print();</" + "script>" : ""}</body></html>`;

  if (!print) {
    // Из истории показываем чек внутри страницы: без новых окон и печати.
    const body = document.createElement("div");
    const frame = document.createElement("iframe");
    frame.className = "receipt-frame";
    frame.title = `Чек №${receipt.id}`;
    body.append(frame);

    const actions = document.createElement("div");
    actions.className = "settings-actions";
    const printBtn = document.createElement("button");
    printBtn.className = "mini";
    printBtn.append(...withIcon("download", "Распечатать"));
    printBtn.addEventListener("click", () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    });
    actions.append(printBtn);
    body.append(actions);

    openModal(`Чек №${receipt.id} — ${receipt.table_name}`, body);
    frame.srcdoc = html;
    return;
  }

  const win = window.open("", "_blank", "width=380,height=600");
  if (!win) {
    showToast("Разрешите всплывающие окна для печати чека");
    return;
  }
  win.document.write(html);
  win.document.close();
}

// ------------------------------------------------- отчёты по кассовой смене

/**
 * Печатная форма отчёта по смене.
 * X-отчёт — промежуточный: «сколько в кассе прямо сейчас», смена при
 * этом продолжается. Z-отчёт — итоговый, при закрытии смены: его сдают
 * вместе с деньгами.
 */
function shiftReportHtml(shift, moves, { z = false } = {}) {
  const esc = (text) =>
    String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const row = (label, value, cls = "") =>
    `<tr class="${cls}"><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`;
  const moveRows = moves.length
    ? moves
        .map(
          (m) =>
            `<tr><td>${m.kind === "out" ? "−" : "+"} ${esc(m.reason)}</td>` +
            `<td class="r">${money(m.amount)}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="2">движения денег не было</td></tr>`;
  const discrepancy =
    shift.cash_discrepancy === null
      ? "—"
      : shift.cash_discrepancy === 0
        ? "сошлась"
        : money(shift.cash_discrepancy);

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
    <title>${z ? "Z" : "X"}-отчёт смены</title>
    <style>
      ${printStyles()}
    </style></head><body>
    <h2>${esc(document.getElementById("club-title").textContent)}</h2>
    <p class="center"><b>${z ? "Z-ОТЧЁТ (смена закрыта)" : "X-ОТЧЁТ (смена продолжается)"}</b><br>
      ${esc(shift.user_name)}</p>
    <hr>
    <table>
      ${row("Смена открыта", formatDateTime(shift.opened_at))}
      ${row(z && shift.closed_at ? "Смена закрыта" : "Отчёт снят", formatDateTime(shift.closed_at ?? new Date().toISOString()))}
      ${row("Сеансов закрыто", String(shift.sessions_count))}
    </table>
    <hr>
    <table>
      ${row("Наличные", money(shift.cash))}
      ${row("Карта", money(shift.card))}
      ${row("Перевод", money(shift.transfer))}
      ${shift.account > 0 ? row("Со счетов клиентов", money(shift.account)) : ""}
      <tr class="total"><td>ВЫРУЧКА</td><td class="r">${money(shift.revenue)}</td></tr>
    </table>
    <hr>
    <p class="center">Касса</p>
    <table>
      ${row("В кассе на начало", shift.opening_cash === null ? "не указано" : money(shift.opening_cash))}
      ${row("+ наличная выручка", money(shift.cash))}
      ${row("+ внесено", money(shift.cash_in ?? 0))}
      ${row("− выдано", money(shift.cash_out ?? 0))}
      <tr class="total"><td>ДОЛЖНО БЫТЬ В КАССЕ</td><td class="r">${
        shift.expected_cash === null ? "—" : money(shift.expected_cash)
      }</td></tr>
      ${z ? row("Сдано фактически", shift.closing_cash === null ? "не указано" : money(shift.closing_cash)) : ""}
      ${z ? row("Расхождение", discrepancy) : ""}
    </table>
    <hr>
    <p class="center">Выдачи и внесения</p>
    <table>${moveRows}</table>
    <hr>
    <p class="center">${z ? "Отчёт сдаётся вместе с деньгами" : "Смена не закрыта, деньги не сдаются"}</p>
    <p class="center">Подпись кассира ____________</p>
    </body></html>`;
}

/**
 * Показывает отчёт по смене в окне с кнопкой «Распечатать».
 * @param {object} shift смена (из /api/shifts/current или ответа закрытия)
 * @param {{z?: boolean, autoPrint?: boolean}} [options]
 */
async function openShiftReport(shift, { z = false, autoPrint = false } = {}) {
  let moves = [];
  try {
    moves = await api(`/api/shifts/${shift.id}/cash`);
  } catch {
    // Список движений — часть отчёта, но без него отчёт всё равно нужен.
  }
  const html = shiftReportHtml(shift, moves, { z });

  const body = document.createElement("div");
  const frame = document.createElement("iframe");
  frame.className = "receipt-frame";
  frame.title = z ? "Z-отчёт" : "X-отчёт";
  body.append(frame);

  const actions = document.createElement("div");
  actions.className = "settings-actions";
  const printBtn = document.createElement("button");
  printBtn.className = "mini";
  printBtn.append(...withIcon("download", "Распечатать"));
  printBtn.addEventListener("click", () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
  });
  actions.append(printBtn);
  body.append(actions);

  openModal(z ? "Z-отчёт: смена закрыта" : "X-отчёт: сколько в кассе сейчас", body);
  frame.srcdoc = html;
  if (autoPrint) {
    frame.addEventListener("load", () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    });
  }
}

/** X-отчёт по своей открытой смене. */
async function openXReport() {
  const shift = await api("/api/shifts/current");
  if (!shift) {
    showToast("Открытой смены нет — отчёт снимать не с чего");
    return;
  }
  state.shift = shift;
  await openShiftReport(shift, { z: false });
}

// ---------------------------------------------------------------- auth & shift

const ROLE_LABELS_LC = {
  developer: "разработчик",
  owner: "владелец",
  manager: "управляющий",
  admin: "администратор",
  cashier: "кассир",
};

/** Название и логотип клуба в шапке. Логотипа нет — просто название. */
function applyBrand({ club_name, club_logo, club_logo_height }) {
  if (club_name) {
    document.getElementById("club-title").textContent = club_name;
    document.title = club_name;
  }
  const logo = document.getElementById("club-logo");
  // Масштаб задаётся в настройках: логотипы бывают и вытянутые, и
  // квадратные, одна высота на всех не подходит.
  const height = Number(club_logo_height);
  if (Number.isFinite(height) && height > 0) {
    logo.style.height = `${height}px`;
    logo.style.maxHeight = `${height}px`;
  }
  if (club_logo) {
    logo.src = club_logo;
    logo.alt = club_name ?? "";
    logo.hidden = false;
  } else {
    logo.removeAttribute("src");
    logo.hidden = true;
  }
}

function renderUserChip() {
  const chip = document.getElementById("user-chip");
  const role = ROLE_LABELS_LC[state.user.role] ?? state.user.role;
  chip.textContent = `${state.user.name} · ${role}`;
}

/** Кнопка смены в шапке (без статистики — итоги видны только при
 *  закрытии смены и в «Отчётах»). */
function renderShiftBar() {
  const toggle = document.getElementById("shift-toggle");
  toggle.textContent = state.shift ? "Закрыть смену" : "Открыть смену";
}

async function refreshShift() {
  state.shift = await api("/api/shifts/current");
  renderShiftBar();
}

/** Модальное окно с полем суммы наличных (открытие/закрытие смены). */
function cashModal(title, hint, buttonLabel, onSubmit, { summaryNode = null } = {}) {
  const body = document.createElement("div");
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = hint;
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.step = "0.01";
  input.placeholder = `Сумма, ${cur()} (можно оставить пустым)`;
  input.className = "cash-input";
  const btn = document.createElement("button");
  btn.className = "primary";
  btn.textContent = buttonLabel;
  btn.addEventListener("click", () => {
    const raw = input.value.trim();
    const value = raw === "" ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      showToast("Сумма должна быть числом не меньше нуля");
      return;
    }
    onSubmit(value);
  });
  const actions = document.createElement("div");
  actions.className = "settings-actions";
  actions.append(btn);
  body.append(p);
  if (summaryNode) body.append(summaryNode);
  body.append(input, actions);
  openModal(title, body);
  input.focus();
}

/**
 * Сводка по смене для окна её закрытия: сколько сеансов, разбивка по
 * способам оплаты, выдачи/внесения и расчётные наличные — чтобы кассир
 * видел цифры ДО того, как введёт фактическую сумму, а не гадал.
 * @param {object} shift
 */
function shiftClosingSummary(shift) {
  const wrap = document.createElement("table");
  wrap.className = "shift-summary";
  const row = (label, value, bold = false) => {
    const tr = document.createElement("tr");
    const th = document.createElement("td");
    th.textContent = label;
    const td = document.createElement("td");
    td.className = "r";
    if (bold) {
      const b = document.createElement("b");
      b.textContent = value;
      td.append(b);
    } else {
      td.textContent = value;
    }
    tr.append(th, td);
    return tr;
  };
  wrap.append(
    row("Сеансов закрыто", String(shift.sessions_count)),
    row("Наличные", money(shift.cash)),
    row("Карта", money(shift.card)),
    row("Перевод", money(shift.transfer)),
    // Оплата со счетов клиентов: выручка есть, а денег в кассу сейчас не
    // приходило — они пришли раньше, при пополнении.
    row("Со счетов клиентов", money(shift.account ?? 0)),
    row("Выручка всего", money(shift.revenue), true),
    row("В кассе на начало", shift.opening_cash === null ? "не указано" : money(shift.opening_cash)),
    row("Внесено в кассу", money(shift.cash_in)),
    row("Выдано из кассы", money(shift.cash_out)),
    row(
      "Должно быть в кассе",
      shift.expected_cash === null ? "—" : money(shift.expected_cash),
      shift.expected_cash !== null
    )
  );
  return wrap;
}

/**
 * Выдача из кассы и внесение в кассу. Без этого расчётные наличные
 * расходились с ящиком каждый раз, когда днём брали деньги на закупку
 * или сдавали выручку старшему.
 */
function openCashMoveModal() {
  if (!state.shift) {
    showToast("Сначала откройте кассовую смену");
    return;
  }
  const body = document.createElement("div");
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    `В кассе по расчёту ${
      state.shift.expected_cash === null ? "—" : money(state.shift.expected_cash)
    }. Выдача уменьшает расчётные наличные, внесение — увеличивает, ` +
    "поэтому при закрытии смены касса сходится.";
  body.append(hint);

  const kind = document.createElement("select");
  for (const [value, label] of [
    ["out", "Выдать из кассы (закупка, инкассация, возврат)"],
    ["in", "Внести в кассу (размен, довложение)"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    kind.append(option);
  }
  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0";
  amount.step = "0.01";
  amount.className = "cash-input";
  amount.placeholder = `Сумма, ${cur()}`;
  const reason = document.createElement("input");
  reason.type = "text";
  reason.maxLength = 200;
  reason.placeholder = "Например: закупка воды";
  body.append(
    makeField("Операция", kind),
    makeField("Сумма", amount),
    makeField("За что", reason)
  );

  const list = document.createElement("div");
  list.className = "cash-moves";
  body.append(list);
  const reloadList = async () => {
    try {
      const moves = await api(`/api/shifts/${state.shift.id}/cash`);
      list.replaceChildren();
      if (!moves.length) return;
      const title = document.createElement("p");
      title.className = "hint";
      title.textContent = "За эту смену:";
      list.append(title);
      for (const move of moves) {
        const row = document.createElement("div");
        row.className = `cash-move ${move.kind}`;
        row.textContent =
          `${move.kind === "out" ? "−" : "+"}${money(move.amount)} — ${move.reason} ` +
          `(${formatDateTime(move.created_at)}, ${move.user_name})`;
        list.append(row);
      }
    } catch {
      // список — справка, без него окно работает
    }
  };
  reloadList();

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = "Записать";
  save.addEventListener("click", async () => {
    const sum = Number(amount.value);
    if (!Number.isFinite(sum) || sum <= 0) {
      showToast("Сумма должна быть больше нуля");
      return;
    }
    if (!reason.value.trim()) {
      showToast("Напишите, за что деньги");
      return;
    }
    save.disabled = true;
    try {
      state.shift = await api("/api/shifts/cash", {
        method: "POST",
        body: JSON.stringify({
          kind: kind.value,
          amount: sum,
          reason: reason.value.trim(),
        }),
      });
      amount.value = "";
      reason.value = "";
      hint.textContent =
        `В кассе по расчёту ${money(state.shift.expected_cash)}. ` +
        "Выдача уменьшает расчётные наличные, внесение — увеличивает, " +
        "поэтому при закрытии смены касса сходится.";
      await reloadList();
      showToast("Записано", true);
    } catch (error) {
      showToast(error.message);
    } finally {
      save.disabled = false;
    }
  });
  const report = document.createElement("button");
  report.className = "mini";
  report.textContent = "X-отчёт";
  report.title = "Сколько должно быть в кассе прямо сейчас";
  report.addEventListener("click", () => {
    openXReport().catch((error) => showToast(error.message));
  });
  actions.append(save, report);
  body.append(actions);
  openModal("Касса: выдача и внесение", body);
  amount.focus();
}

async function toggleShift() {
  if (state.shift) {
    // Наличные/карта в state.shift считаются на момент последней загрузки,
    // а закрытие столов в течение смены его не обновляет — без свежего
    // запроса тут показались бы устаревшие (часто нулевые) цифры.
    try {
      await refreshShift();
    } catch (error) {
      showToast(error.message);
      return;
    }
    cashModal(
      "Закрытие смены",
      `Пересчитайте наличные в кассе и укажите фактическую сумму — система сравнит с расчётной` +
        (state.shift.expected_cash !== null
          ? ` (${money(state.shift.expected_cash)})`
          : "") + ".",
      "Закрыть смену",
      async (closingCash) => {
        try {
          const closed = await api("/api/shifts/close", {
            method: "POST",
            body: JSON.stringify({ closing_cash: closingCash }),
          });
          closeModal();
          let message =
            `Смена закрыта: сеансов ${closed.sessions_count}, ` +
            `выручка ${money(closed.revenue)}`;
          if (closed.cash_discrepancy !== null) {
            message +=
              closed.cash_discrepancy === 0
                ? ", касса сошлась"
                : `, расхождение ${money(closed.cash_discrepancy)}`;
          }
          showToast(message, closed.cash_discrepancy === null || closed.cash_discrepancy === 0);
          // Z-отчёт: его сдают вместе с деньгами, поэтому печатаем сразу.
          openShiftReport(closed, { z: true, autoPrint: true }).catch(() => {});
          state.shift = null;
          renderShiftBar();
        } catch (error) {
          showToast(error.message);
        }
      },
      { summaryNode: shiftClosingSummary(state.shift) }
    );
  } else {
    cashModal(
      "Открытие смены",
      "Укажите наличные в кассе на начало смены — по ним считается пересдача.",
      "Открыть смену",
      async (openingCash) => {
        try {
          state.shift = await api("/api/shifts/open", {
            method: "POST",
            body: JSON.stringify({ opening_cash: openingCash }),
          });
          closeModal();
          showToast("Смена открыта", true);
          renderShiftBar();
        } catch (error) {
          showToast(error.message);
        }
      }
    );
  }
}

// ---------------------------------------------------------------- history

async function refreshHistory() {
  const rows = document.getElementById("history-rows");
  const sessions = await api("/api/history");
  rows.replaceChildren();
  for (const s of sessions) {
    const tr = document.createElement("tr");
    const cells = [
      s.table_name + (s.client_name ? ` · ${s.client_name}` : ""),
      `${s.tariff_name} (${s.price_per_hour} ${cur()}/час)` +
        (s.discount_percent ? `, скидка ${s.discount_percent}%` : ""),
      formatDateTime(s.started_at),
      formatDuration(s.duration_seconds),
      formatMoney(s.total_cost),
      PAYMENT_LABELS[s.payment_method] ?? "—",
      s.closed_by_name ?? s.opened_by_name ?? "—",
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    const receiptCell = document.createElement("td");
    const receiptBtn = document.createElement("button");
    receiptBtn.className = "mini";
    receiptBtn.textContent = "Чек";
    receiptBtn.addEventListener("click", () => openReceipt(s.id));
    receiptCell.append(receiptBtn);
    tr.append(receiptCell);
    rows.append(tr);
  }
  document.getElementById("history-empty").hidden = sessions.length > 0;
}

// ---------------------------------------------------------------- journal

const EVENT_LABELS = {
  table_created: "Создан стол",
  tariff_created: "Создан тариф",
  session_opened: "Сеанс открыт",
  session_closed: "Сеанс закрыт",
  light_on: "Свет включён",
  light_off: "Свет выключен",
  device_on: "Устройство включено",
  device_off: "Устройство выключено",
  device_cycle: "Цикл устройства",
  device_position: "Положение решётки",
  shift_opened: "Смена открыта",
  shift_closed: "Смена закрыта",
  user_created: "Создан сотрудник",
  user_updated: "Обновлён сотрудник",
  user_deleted: "Удалён сотрудник",
  backup_restored: "База восстановлена",
  settings_updated: "Изменены настройки",
  booking_created: "Создана бронь",
  booking_cancelled: "Отменена бронь",
  client_created: "Добавлен клиент",
  client_topup: "Пополнение счёта",
  client_debit: "Списание со счёта",
};

async function refreshJournal() {
  const rows = document.getElementById("journal-rows");
  const entries = await api("/api/journal");
  rows.replaceChildren();
  for (const entry of entries) {
    const tr = document.createElement("tr");
    const cells = [
      formatDateTime(entry.created_at),
      EVENT_LABELS[entry.event] ?? entry.event,
      entry.message,
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    rows.append(tr);
  }
  document.getElementById("journal-empty").hidden = entries.length > 0;
}

// ---------------------------------------------------------------- tariffs

const DAY_NAMES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function minutesToTime(minutes) {
  const m = minutes % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function initDaysPicker(id = "rule-days") {
  const box = document.getElementById(id);
  if (!box || box.childElementCount) return;
  DAY_NAMES.forEach((name, index) => {
    const label = document.createElement("label");
    label.className = "day-chip";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(index + 1);
    const span = document.createElement("span");
    span.textContent = name;
    label.append(checkbox, span);
    box.append(label);
  });
}

async function refreshTariffs() {
  const rows = document.getElementById("tariff-rows");
  const tariffs = await api("/api/tariffs");
  state.tariffs = tariffs;
  rows.replaceChildren();
  for (const tariff of tariffs) {
    const tr = document.createElement("tr");
    const cells = [
      tariff.name,
      String(tariff.price_per_hour),
      tariff.is_active ? "Да" : "Нет",
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }

    const actions = document.createElement("td");
    actions.className = "tariff-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "mini";
    editBtn.textContent = "Изменить";
    editBtn.addEventListener("click", async () => {
      const name = prompt("Название тарифа:", tariff.name);
      if (name === null) return;
      const price = prompt("Цена, ₽/час:", String(tariff.price_per_hour));
      if (price === null) return;
      try {
        await api(`/api/tariffs/${tariff.id}`, {
          method: "PUT",
          body: JSON.stringify({ name, price_per_hour: Number(price) }),
        });
        showToast("Тариф изменён", true);
        await refreshTariffs();
      } catch (error) {
        showToast(error.message);
      }
    });

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "mini";
    toggleBtn.textContent = tariff.is_active ? "Отключить" : "Включить";
    toggleBtn.addEventListener("click", async () => {
      try {
        await api(`/api/tariffs/${tariff.id}`, {
          method: "PUT",
          body: JSON.stringify({ is_active: !tariff.is_active }),
        });
        await refreshTariffs();
      } catch (error) {
        showToast(error.message);
      }
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "mini danger";
    deleteBtn.textContent = "Удалить";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Удалить тариф «${tariff.name}»?`)) return;
      try {
        await api(`/api/tariffs/${tariff.id}`, { method: "DELETE" });
        showToast("Тариф удалён", true);
        await refreshTariffs();
      } catch (error) {
        showToast(error.message);
      }
    });

    actions.append(editBtn, toggleBtn, deleteBtn);
    tr.append(actions);
    rows.append(tr);
  }

  // Расписание тарифов и привязка тарифов к столам — тоже здесь.
  if (!can("manage_tariffs")) return;
  await renderTableTariffBindings();
  initDaysPicker();

  const tariffSelect = document.getElementById("rule-tariff");
  const selected = tariffSelect.value;
  tariffSelect.replaceChildren();
  for (const tariff of tariffs.filter((t) => t.is_active)) {
    const option = document.createElement("option");
    option.value = String(tariff.id);
    option.textContent = `${tariff.name} — ${tariff.price_per_hour} ${cur()}/час`;
    tariffSelect.append(option);
  }
  if (selected) tariffSelect.value = selected;

  const rules = await api("/api/tariff-rules");
  const ruleRows = document.getElementById("rule-rows");
  ruleRows.replaceChildren();
  for (const rule of rules) {
    const tr = document.createElement("tr");
    const cells = [
      `${rule.tariff_name} (${rule.price_per_hour} ${cur()}/час)`,
      rule.days.map((d) => DAY_NAMES[d - 1]).join(", "),
      `${minutesToTime(rule.start_minute)}–${minutesToTime(rule.end_minute)}` +
        (rule.end_minute <= rule.start_minute ? " (через полночь)" : ""),
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    const actions = document.createElement("td");
    const del = document.createElement("button");
    del.className = "mini";
    del.textContent = "Удалить";
    del.addEventListener("click", async () => {
      try {
        await api(`/api/tariff-rules/${rule.id}`, { method: "DELETE" });
        await refreshTariffs();
      } catch (error) {
        showToast(error.message);
      }
    });
    actions.append(del);
    tr.append(actions);
    ruleRows.append(tr);
  }
  document.getElementById("rules-empty").hidden = rules.length > 0;

  // Акции и подарочные часы живут на этой же вкладке.
  initDaysPicker("promo-days");
  await renderPromotions();
  const settings = await api("/api/settings");
  document.getElementById("bonus-every").value = settings.bonus_every_hours;
}

/**
 * Акции «счастливый час»: список и включение/выключение. Удобнее, чем
 * менять тарифы: одна строка «по будням до 18:00 минус 30%» работает на
 * всех столах и со всеми тарифами.
 */
async function renderPromotions() {
  const rows = document.getElementById("promo-rows");
  const promos = await api("/api/promotions");
  rows.replaceChildren();
  for (const promo of promos) {
    const tr = document.createElement("tr");
    for (const text of [
      promo.name,
      `−${promo.discount_percent}%`,
      promo.days.map((d) => DAY_NAMES[d - 1]).join(", "),
      `${minutesToTime(promo.start_minute)}–${minutesToTime(promo.end_minute)}`,
    ]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }

    const stateCell = document.createElement("td");
    const toggle = document.createElement("button");
    toggle.className = "mini";
    toggle.textContent = promo.is_active ? "Да" : "Нет";
    toggle.title = promo.is_active ? "Выключить акцию" : "Включить акцию";
    toggle.addEventListener("click", async () => {
      try {
        await api(`/api/promotions/${promo.id}`, {
          method: "PUT",
          body: JSON.stringify({ is_active: !promo.is_active }),
        });
        await renderPromotions();
      } catch (error) {
        showToast(error.message);
      }
    });
    stateCell.append(toggle);
    tr.append(stateCell);

    const actions = document.createElement("td");
    const del = document.createElement("button");
    del.className = "mini";
    del.textContent = "Удалить";
    del.addEventListener("click", async () => {
      try {
        await api(`/api/promotions/${promo.id}`, { method: "DELETE" });
        await renderPromotions();
      } catch (error) {
        showToast(error.message);
      }
    });
    actions.append(del);
    tr.append(actions);
    rows.append(tr);
  }
  document.getElementById("promos-empty").hidden = promos.length > 0;
}

async function addPromotion() {
  const days = [...document.querySelectorAll("#promo-days input:checked")].map((c) =>
    Number(c.value)
  );
  if (!days.length) {
    showToast("Отметьте хотя бы один день недели");
    return;
  }
  try {
    await api("/api/promotions", {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("promo-name").value.trim(),
        discount_percent: Number(document.getElementById("promo-percent").value),
        days,
        start_minute: timeToMinutes(document.getElementById("promo-start").value),
        end_minute: timeToMinutes(document.getElementById("promo-end").value),
      }),
    });
    document.getElementById("promo-name").value = "";
    showToast("Акция добавлена", true);
    await renderPromotions();
  } catch (error) {
    showToast(error.message);
  }
}

/**
 * Цена каждого стола: таблица «стол — тариф — цена». Один тариф на стол,
 * кассир его не выбирает; «не назначен» — берётся тариф по расписанию.
 */
async function renderTableTariffBindings() {
  const wrap = document.getElementById("table-tariff-bindings");
  const [tables, activeTariffs] = await Promise.all([
    api("/api/dashboard"),
    api("/api/tariffs?only_active=true"),
  ]);
  wrap.replaceChildren();
  if (activeTariffs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Сначала добавьте хотя бы один тариф.";
    wrap.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const text of ["Стол", "Тариф", "Цена"]) {
    const th = document.createElement("th");
    th.textContent = text;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  table.append(thead, tbody);

  const priceOf = (tariffId) => {
    const tariff = activeTariffs.find((t) => t.id === Number(tariffId));
    return tariff ? `${tariff.price_per_hour} ${cur()}/час` : "по расписанию";
  };

  for (const item of tables) {
    const tr = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.className = "table-tariff-name";
    const meta = KIND_META[item.kind] ?? KIND_META.billiard;
    nameCell.append(icon(meta.ic), item.name);
    nameCell.title = meta.label;

    // Один тариф на стол: это его цена, кассир её не выбирает.
    const select = document.createElement("select");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Не назначен — по расписанию";
    select.append(none);
    for (const tariff of activeTariffs) {
      const option = document.createElement("option");
      option.value = String(tariff.id);
      option.textContent = tariff.name;
      select.append(option);
    }
    const assigned = item.allowed_tariff_ids ?? [];
    select.value = assigned.length === 1 ? String(assigned[0]) : "";
    const selectCell = document.createElement("td");
    selectCell.append(select);

    // Столы с несколькими тарифами (день/ночь по расписанию) настраивались
    // раньше галочками — такую связку не ломаем, просто показываем как есть.
    const multi = document.createElement("div");
    multi.className = "hint";
    if (assigned.length > 1) {
      multi.textContent =
        `Назначено несколько (${assigned.length}) — выбирает расписание. ` +
        "Выберите один тариф, чтобы закрепить цену.";
      selectCell.append(multi);
    }

    const priceCell = document.createElement("td");
    priceCell.className = "table-tariff-price";
    priceCell.textContent = assigned.length === 1 ? priceOf(assigned[0]) : "по расписанию";

    select.addEventListener("change", async () => {
      const value = select.value ? [Number(select.value)] : [];
      try {
        await api(`/api/tables/${item.id}/tariffs`, {
          method: "PUT",
          body: JSON.stringify({ tariff_ids: value }),
        });
        multi.remove();
        priceCell.textContent = value.length ? priceOf(value[0]) : "по расписанию";
        showToast(
          value.length
            ? `${item.name}: тариф закреплён`
            : `${item.name}: тариф не назначен — возьмётся по расписанию`,
          true
        );
      } catch (error) {
        showToast(error.message);
      }
    });

    tr.append(nameCell, selectCell, priceCell);
    tbody.append(tr);
  }
  wrap.append(table);
}

function timeToMinutes(value) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

async function addTariffRule() {
  const days = [...document.querySelectorAll("#rule-days input:checked")].map((c) =>
    Number(c.value)
  );
  if (!days.length) {
    showToast("Отметьте хотя бы один день недели");
    return;
  }
  try {
    await api("/api/tariff-rules", {
      method: "POST",
      body: JSON.stringify({
        tariff_id: Number(document.getElementById("rule-tariff").value),
        days,
        start_minute: timeToMinutes(document.getElementById("rule-start").value),
        end_minute: timeToMinutes(document.getElementById("rule-end").value),
      }),
    });
    showToast("Правило добавлено", true);
    await refreshTariffs();
  } catch (error) {
    showToast(error.message);
  }
}

// ---------------------------------------------------------------- reports

function renderStatTiles(o) {
  const tiles = document.getElementById("stat-tiles");
  tiles.replaceChildren();
  const items = [
    ["Сегодня", `${money(o.today.revenue)}`, `${o.today.sessions} сеанс(ов)`],
    ["7 дней", `${money(o.week.revenue)}`, `${o.week.sessions} сеанс(ов)`],
    ["30 дней", `${money(o.month.revenue)}`, `${o.month.sessions} сеанс(ов)`],
    ["Средний чек", `${money(o.avg_check)}`, "за 30 дней"],
    ["Средняя игра", formatDuration(o.avg_duration_seconds), "за 30 дней"],
  ];
  for (const [label, value, sub] of items) {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const l = document.createElement("div");
    l.className = "stat-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "stat-value";
    v.textContent = value;
    const s = document.createElement("div");
    s.className = "stat-sub";
    s.textContent = sub;
    tile.append(l, v, s);
    tiles.append(tile);
  }
}

function renderWeekdays(weekdays) {
  const chart = document.getElementById("weekday-chart");
  chart.replaceChildren();
  const max = Math.max(1, ...weekdays.map((d) => d.sessions_count));
  for (const day of weekdays) {
    const col = document.createElement("div");
    col.className = "hour-col";
    const bar = document.createElement("div");
    bar.className = "hour-bar";
    bar.style.height = `${Math.max(3, Math.round((day.sessions_count / max) * 100))}%`;
    bar.title = `${day.name}: сеансов ${day.sessions_count}, выручка ${money(day.revenue)}`;
    const label = document.createElement("span");
    label.className = "hour-label";
    label.textContent = day.name;
    const count = document.createElement("span");
    count.className = "hour-count";
    count.textContent = day.sessions_count || "";
    col.append(count, bar, label);
    chart.append(col);
  }
}

/**
 * Зарплата: часы по кассовым сменам, выручка этих смен и начисление.
 * Отдельного табеля нет — смену и так открывают каждый день.
 */
async function renderPayroll() {
  const rows = document.getElementById("payroll-rows");
  const report = await api("/api/payroll?days=30");
  rows.replaceChildren();
  for (const person of report.people) {
    const tr = document.createElement("tr");
    if (!person.is_active) tr.classList.add("row-off");
    for (const text of [
      person.name,
      String(person.shifts_count),
      `${person.hours} ч`,
      formatMoney(person.revenue),
      person.hourly_rate ? formatMoney(person.hourly_rate) : "—",
      person.revenue_percent ? `${person.revenue_percent}%` : "—",
      formatMoney(person.pay_for_hours),
      formatMoney(person.pay_for_revenue),
      formatMoney(person.pay_total),
    ]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    tr.lastChild.style.fontWeight = "700";
    rows.append(tr);
  }
  document.getElementById("payroll-empty").hidden = report.people.length > 0;
  document.getElementById("payroll-total").textContent = report.people.length
    ? `Всего часов: ${report.total_hours} · к выплате: ${money(report.total_pay)}`
    : "";
}

async function refreshReports() {
  const days = Number(document.getElementById("stats-days").value);
  const revenueDays = Number(document.getElementById("revenue-days").value);
  const [stats, revenue, o] = await Promise.all([
    api(`/api/stats/tables?days=${days}`),
    api(`/api/stats/revenue?days=${revenueDays}`),
    api("/api/stats/overview"),
  ]);
  renderStatTiles(o);
  renderWeekdays(o.weekdays);
  await renderPayroll().catch(() => {}); // зарплата — отдельный блок

  // Выручка по дням.
  const revenueRows = document.getElementById("revenue-rows");
  revenueRows.replaceChildren();
  const maxDayTotal = Math.max(1, ...revenue.days.map((d) => d.total));
  for (const day of revenue.days) {
    const tr = document.createElement("tr");
    const cells = [
      new Date(`${day.day}T00:00:00`).toLocaleDateString("ru-RU", {
        day: "2-digit", month: "2-digit", weekday: "short",
      }),
      String(day.sessions_count),
      formatMoney(day.cash),
      formatMoney(day.card),
      formatMoney(day.transfer),
      formatMoney(day.total),
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    const barCell = document.createElement("td");
    const bar = document.createElement("div");
    bar.className = "load-bar";
    const fill = document.createElement("div");
    fill.className = "load-bar-fill";
    fill.style.width = `${Math.round((day.total / maxDayTotal) * 100)}%`;
    bar.append(fill);
    barCell.append(bar);
    tr.append(barCell);
    revenueRows.append(tr);
  }
  document.getElementById("revenue-empty").hidden = revenue.days.length > 0;

  // Пиковые часы: 24 столбика.
  const hoursChart = document.getElementById("hours-chart");
  hoursChart.replaceChildren();
  const maxHour = Math.max(1, ...revenue.hours.map((h) => h.sessions_count));
  for (const { hour, sessions_count } of revenue.hours) {
    const col = document.createElement("div");
    col.className = "hour-col";
    const bar = document.createElement("div");
    bar.className = "hour-bar";
    bar.style.height = `${Math.round((sessions_count / maxHour) * 100)}%`;
    bar.title = `${String(hour).padStart(2, "0")}:00 — сеансов: ${sessions_count}`;
    const label = document.createElement("span");
    label.className = "hour-label";
    label.textContent = hour % 3 === 0 ? String(hour).padStart(2, "0") : "";
    col.append(bar, label);
    hoursChart.append(col);
  }

  const statsRows = document.getElementById("stats-rows");
  statsRows.replaceChildren();
  const maxRevenue = Math.max(1, ...stats.tables.map((t) => t.revenue));
  for (const table of stats.tables) {
    const tr = document.createElement("tr");
    const hours = table.busy_seconds / 3600;
    const cells = [
      table.name,
      String(table.sessions_count),
      hours >= 0.1 ? `${hours.toFixed(1)} ч` : "—",
      formatMoney(table.revenue),
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    const barCell = document.createElement("td");
    const bar = document.createElement("div");
    bar.className = "load-bar";
    const fill = document.createElement("div");
    fill.className = "load-bar-fill";
    fill.style.width = `${Math.round((table.revenue / maxRevenue) * 100)}%`;
    bar.append(fill);
    barCell.append(bar);
    tr.append(barCell);
    statsRows.append(tr);
  }
}

// ---------------------------------------------------------------- bookings
// Брони живут прямо на столах: создание и отмена — через правый клик
// по карточке; на карточке показывается ближайшая бронь.

/**
 * Оборачивает поле пароля глазком «показать/скрыть». Пароли часто
 * набирают на планшете и вслепую ошибаются — возможность посмотреть
 * набранное экономит время.
 */
function withPasswordEye(input) {
  const wrap = document.createElement("span");
  wrap.className = "password-row";
  const eye = document.createElement("button");
  eye.type = "button";
  eye.className = "password-eye";
  eye.title = "Показать пароль";
  eye.setAttribute("aria-label", eye.title);
  eye.append(icon("eye"));
  eye.addEventListener("click", () => {
    const shown = input.type === "text";
    input.type = shown ? "password" : "text";
    eye.classList.toggle("on", !shown);
    eye.title = shown ? "Показать пароль" : "Скрыть пароль";
    eye.setAttribute("aria-label", eye.title);
    input.focus();
  });
  wrap.append(input, eye);
  return wrap;
}

function makeField(labelText, inputEl) {
  const label = document.createElement("label");
  label.className = "field";
  label.append(labelText, inputEl);
  return label;
}

function openBookingModal(table) {
  const body = document.createElement("div");
  const grid = document.createElement("div");
  grid.className = "settings-grid";

  const start = document.createElement("input");
  start.type = "datetime-local";
  const inHour = new Date(Date.now() + 3600 * 1000);
  inHour.setSeconds(0, 0);
  start.value =
    `${inHour.getFullYear()}-${String(inHour.getMonth() + 1).padStart(2, "0")}-` +
    `${String(inHour.getDate()).padStart(2, "0")}T` +
    `${String(inHour.getHours()).padStart(2, "0")}:` +
    `${String(inHour.getMinutes()).padStart(2, "0")}`;

  const duration = document.createElement("select");
  for (const [minutes, label] of [
    [30, "30 минут"], [60, "1 час"], [90, "1.5 часа"], [120, "2 часа"], [180, "3 часа"],
  ]) {
    const option = document.createElement("option");
    option.value = String(minutes);
    option.textContent = label;
    duration.append(option);
  }
  duration.value = "60";

  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = "Имя клиента";
  const phone = document.createElement("input");
  phone.type = "tel";
  phone.placeholder = "Телефон (не обязательно)";

  grid.append(
    makeField("Дата и время", start),
    makeField("Длительность", duration),
    makeField("Имя клиента", name),
    makeField("Телефон", phone)
  );

  const submit = document.createElement("button");
  submit.className = "primary";
  submit.textContent = "Забронировать";
  submit.addEventListener("click", async () => {
    if (!start.value) {
      showToast("Укажите дату и время брони");
      return;
    }
    try {
      await api("/api/bookings", {
        method: "POST",
        body: JSON.stringify({
          table_id: table.id,
          starts_at: new Date(start.value).toISOString(),
          duration_minutes: Number(duration.value),
          client_name: name.value.trim(),
          phone: phone.value.trim(),
        }),
      });
      closeModal();
      showToast("Бронь создана", true);
      await refreshDashboard();
    } catch (error) {
      showToast(error.message);
    }
  });

  const actions = document.createElement("div");
  actions.className = "settings-actions";
  actions.append(submit);
  body.append(grid, actions);
  openModal(`Бронь — ${table.name}`, body);
}

async function cancelTableBooking(table) {
  try {
    await api(`/api/bookings/${table.booking.id}/cancel`, { method: "POST" });
    showToast("Бронь отменена", true);
    await refreshDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

/** Ручное включение и выключение света над столом. */
async function toggleTableLight(table) {
  const on = !table.light_on;
  try {
    await api(`/api/tables/${table.id}/light`, {
      method: "POST",
      body: JSON.stringify({ on }),
    });
    showToast(`${table.name}: свет ${on ? "включён" : "выключен"}`, true);
    await refreshDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

/** Открывает сеанс без тарификации времени (право open_free_time). */
async function openFreeTimeSession(table) {
  const { tariff } = cardPricing(null, table);
  if (!tariff) {
    showToast("Нет доступных тарифов для этого стола");
    return;
  }
  // Бесплатное время тоже не кончается само — при брони предупреждаем.
  if (!(await confirmBookingOverrun(table, null))) return;
  try {
    await api(`/api/tables/${table.id}/open`, {
      method: "POST",
      body: JSON.stringify({ tariff_id: tariff.id, mode: "free" }),
    });
    showToast(`${table.name}: открыто бесплатное время`, true);
    await refreshDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

/** Удаление стола (право manage_tables) — с подтверждением. */
/**
 * Перечитывает столы, не выходя из редактора зала: добавление и удаление
 * столов теперь делают прямо в нём, а несохранённые стены и расстановка
 * должны при этом остаться на месте.
 */
async function reloadTablesKeepingEditor() {
  if (!state.editMode) {
    await refreshDashboard();
    return;
  }
  state.tables = await api("/api/dashboard");
  state.fetchedAt = performance.now();
  // Раскладка: убираем удалённые столы, для новых берём авторасстановку.
  const layouts = resolveLayouts();
  for (const id of [...state.edit.layouts.keys()]) {
    if (!state.tables.some((t) => t.id === id)) {
      state.edit.layouts.delete(id);
      state.edit.changed.delete(id);
    }
  }
  for (const [id, layout] of layouts) {
    if (!state.edit.layouts.has(id)) state.edit.layouts.set(id, layout);
  }
  renderMap();
}

async function deleteTableConfirm(table) {
  const confirmed = await confirmModal(
    "Удаление стола",
    `Удалить стол «${table.name}»? Если по нему уже была история сеансов, ` +
      "стол скрывается из зала, а история сохраняется.",
    "Удалить"
  );
  if (!confirmed) return;
  try {
    await api(`/api/tables/${table.id}`, { method: "DELETE" });
    showToast("Стол удалён", true);
    await reloadTablesKeepingEditor();
  } catch (error) {
    showToast(error.message);
  }
}

// ---------------------------------------------------------------- prepaid

/** Активные тарифы, доступные на конкретном столе (с учётом ограничения). */
function allowedTariffs(table) {
  const active = state.tariffs.filter((t) => t.is_active);
  const allowed = table?.allowed_tariff_ids;
  if (!allowed || allowed.length === 0) return active;
  return active.filter((t) => allowed.includes(t.id));
}

/** Тариф и скидка клиента, выбранные на карточке стола.
 *  Для плитки карты (без селекта) — тариф по расписанию или первый активный,
 *  с учётом ограничения тарифов конкретного стола. */
function cardPricing(card, table) {
  const select = card?.querySelector?.("select");
  const active = allowedTariffs(table);
  const tariff = select
    ? state.tariffs.find((t) => t.id === Number(select.value))
    : active.find((t) => t.id === state.autoTariffId) ?? active[0];
  const clientInput = card?.querySelector?.("input[list='clients-datalist']");
  const clientId = clientInput ? clientIdFromInput(clientInput.value) : null;
  const client = state.clients.find((c) => c.id === clientId);
  return {
    tariff,
    clientId,
    discount: client?.discount_percent ?? 0,
  };
}

function paymentButtonsRow(onPick) {
  const row = document.createElement("div");
  row.className = "pay-buttons";
  for (const [method, label] of Object.entries(PAYMENT_LABELS)) {
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = label;
    btn.addEventListener("click", () => onPick(method));
    row.append(btn);
  }
  return row;
}

/**
 * Кнопки оплаты с учётом счёта клиента.
 *
 * Гость, который заранее внёс деньги, платить второй раз не должен:
 * галочка «сначала со счёта» стоит по умолчанию, а кассир видит, сколько
 * спишется и сколько ещё взять деньгами. Если счёта хватает на всё,
 * выбирать наличные или карту не нужно — достаточно одной кнопки.
 *
 * @param {(method: string | null, useBalance: boolean) => void} onPick
 *   method — наличные/карта/перевод; null — платим только со счёта.
 * @returns {{node: HTMLElement, update: (account: number, amount: number) => void}}
 */
function accountPayRow(onPick, { actionLabel = "Открыть со счёта" } = {}) {
  const wrap = document.createElement("div");

  const useBox = document.createElement("input");
  useBox.type = "checkbox";
  useBox.checked = true;
  const useRow = document.createElement("label");
  useRow.className = "switch-row";
  const useText = document.createTextNode(" Сначала списать со счёта клиента");
  useRow.append(useBox, useText);

  const note = document.createElement("p");
  note.className = "hint";

  const accountBtn = document.createElement("button");
  accountBtn.className = "primary";
  accountBtn.style.width = "100%";
  accountBtn.addEventListener("click", () => onPick(null, true));

  const buttons = paymentButtonsRow((method) => onPick(method, useBox.checked));
  wrap.append(useRow, note, accountBtn, buttons);

  let account = 0;
  let amount = 0;
  const render = () => {
    const has = account > 0;
    useRow.hidden = !has;
    note.hidden = !has;
    if (!has) {
      accountBtn.hidden = true;
      buttons.hidden = false;
      return;
    }
    useText.textContent = ` Сначала списать со счёта клиента (${money(account)})`;
    const fromAccount = useBox.checked ? Math.min(account, amount) : 0;
    const covers = useBox.checked && amount > 0 && account >= amount;
    note.textContent = !useBox.checked
      ? `Счёт клиента не трогаем — гость платит деньгами ${money(amount)}.`
      : covers
        ? `Спишем со счёта ${money(amount)} — деньги брать не нужно.`
        : `Спишем со счёта ${money(fromAccount)}, деньгами добрать ${money(amount - fromAccount)}.`;
    accountBtn.hidden = !covers;
    accountBtn.textContent = `${actionLabel} — ${money(amount)}`;
    buttons.hidden = covers;
  };
  useBox.addEventListener("change", render);
  render();

  return {
    node: wrap,
    update: (nextAccount, nextAmount) => {
      account = Number(nextAccount) || 0;
      amount = Number(nextAmount) || 0;
      render();
    },
  };
}

async function openPrepaid(table, payload) {
  try {
    await api(`/api/tables/${table.id}/open`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    closeModal();
    state.clientDraft.delete(table.id);
    showToast(`${table.name}: стол открыт по предоплате`, true);
    await refreshDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

/**
 * Обычная постоплата: открыть сразу, стоимость считается по факту
 * закрытия. Тариф и клиент приходят из окна открытия
 * ({tariffId, clientId}) либо читаются с карточки стола — так работают
 * групповые действия.
 */
async function openPostpaidNow(table, source) {
  const { tariff, clientId } =
    source && "tariffId" in source
      ? {
          tariff: state.tariffs.find((t) => t.id === source.tariffId),
          clientId: source.clientId ?? null,
        }
      : cardPricing(source, table);
  if (!tariff) {
    showToast("Нет доступных тарифов для этого стола");
    return;
  }
  try {
    await api(`/api/tables/${table.id}/open`, {
      method: "POST",
      body: JSON.stringify({ tariff_id: tariff.id, client_id: clientId }),
    });
    closeModal();
    showToast(`${table.name}: сеанс открыт (постоплата)`, true);
    await refreshDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

/**
 * Единое окно открытия стола: постоплата без ограничения времени,
 * либо предоплата — по времени (с быстрыми чипсами минут) или по
 * фиксированной сумме (отдельным чекбоксом вместо времени).
 */
/**
 * Блок «тариф + клиент» для окон открытия стола. На карте зала карточки
 * с полями нет, поэтому выбор клиента и тарифа делается в самом окне:
 * от них зависят цена часа и скидка, а значит и предпросмотр сумм.
 *
 * @param {object} table стол
 * @param {{onChange?: (pricing: object) => void}} [options]
 * @returns {{node: HTMLElement, read: () => {tariff: object, clientId: number|null, discount: number}}}
 */
function pricingControls(table, { onChange } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "settings-grid";

  const tariffSelect = document.createElement("select");
  const active = allowedTariffs(table);
  for (const tariff of active) {
    const option = document.createElement("option");
    option.value = String(tariff.id);
    const auto = tariff.id === state.autoTariffId ? " · авто" : "";
    option.textContent = `${tariff.name} — ${tariff.price_per_hour} ${cur()}/час${auto}`;
    tariffSelect.append(option);
  }
  const preferred =
    active.find((t) => t.id === table?.tariff?.id) ??
    active.find((t) => t.id === state.autoTariffId) ??
    active[0];
  if (preferred) tariffSelect.value = String(preferred.id);

  // Цену стола задаёт администратор — кассир только открывает время.
  // Выбор оставляем лишь тому, кто управляет тарифами, и лишь когда на
  // столе их правда несколько (например «день/ночь» по расписанию).
  const canChooseTariff = can("manage_tariffs") && active.length > 1;
  const tariffLine = document.createElement("div");
  tariffLine.className = "table-tariff-line";
  const showTariffLine = () => {
    const shown = preferred;
    tariffLine.textContent = shown
      ? `${shown.name} — ${shown.price_per_hour} ${cur()}/час`
      : "Тариф столу не назначен";
  };
  showTariffLine();

  const clientInput = document.createElement("input");
  clientInput.type = "text";
  clientInput.setAttribute("list", "clients-datalist");
  clientInput.placeholder = "Не обязательно";
  clientInput.autocomplete = "off";

  // Скидка выбранного клиента — сразу под полем, чтобы кассир видел,
  // что она применится.
  const clientNote = document.createElement("p");
  clientNote.className = "hint";

  const read = () => {
    const tariff = canChooseTariff
      ? state.tariffs.find((t) => t.id === Number(tariffSelect.value))
      : preferred;
    const clientId = clientIdFromInput(clientInput.value);
    const client = state.clients.find((c) => c.id === clientId);
    // Скидка клиента и акция не складываются — считаем по бо́льшей,
    // ровно как это сделает сервер при открытии.
    const clientDiscount = client?.discount_percent ?? 0;
    const promoDiscount = state.promotion?.discount_percent ?? 0;
    return {
      tariff,
      clientId,
      client,
      discount: Math.max(clientDiscount, promoDiscount),
      clientDiscount,
      promo: promoDiscount > clientDiscount ? state.promotion : null,
    };
  };

  const refreshNote = () => {
    const { client, clientDiscount, promo } = read();
    const parts = [];
    if (!clientInput.value.trim()) {
      // Клиента не выбрали — но акция всё равно действует.
    } else if (!client) {
      parts.push("Клиент не найден в базе — скидка клиента не применится.");
    } else {
      parts.push(
        clientDiscount
          ? `${client.name}: скидка ${clientDiscount}%`
          : `${client.name}: скидки нет`
      );
      if (client.account > 0) {
        parts.push(`На счету ${money(client.account)} — спишется в первую очередь`);
      }
    }
    if (state.promotion) {
      parts.push(
        promo
          ? `Действует акция «${state.promotion.name}» — скидка ${state.promotion.discount_percent}%`
          : `Акция «${state.promotion.name}» (−${state.promotion.discount_percent}%) не применяется: ` +
            "у клиента скидка больше"
      );
    }
    clientNote.textContent = parts.join(". ");
  };

  const notify = () => {
    refreshNote();
    onChange?.(read());
  };
  tariffSelect.addEventListener("change", notify);
  clientInput.addEventListener("change", notify);
  clientInput.addEventListener("input", notify);

  wrap.append(
    makeField("Тариф", canChooseTariff ? tariffSelect : tariffLine),
    makeField("Клиент", clientInput)
  );
  const box = document.createElement("div");
  box.append(wrap, clientNote);
  // Действующую акцию показываем сразу, ещё до выбора клиента.
  refreshNote();
  return { node: box, read };
}

function openStartSessionModal(table) {
  if (!allowedTariffs(table).length) {
    showToast("Нет доступных тарифов для этого стола");
    return;
  }
  const body = document.createElement("div");
  // Кнопки оплаты создаются ниже, но предпросмотр суммы обращается к ним
  // раньше — объявляем заранее, чтобы первый расчёт не падал.
  let timePay = null;

  // Тариф и клиент выбираются прямо здесь: на карте зала полей нет, а
  // от клиента зависит скидка и цена часа.
  const pricing = pricingControls(table, {
    onChange: () => updateTimePreview(),
  });
  body.append(pricing.node);
  const perHourNow = () => {
    const { tariff, discount } = pricing.read();
    return (tariff?.price_per_hour ?? 0) * (1 - discount / 100);
  };

  // Два взаимоисключающих варианта (чекбоксы ведут себя как радиокнопки):
  // без ограничения времени (постоплата) — по умолчанию, или ограничение
  // по времени. Чек на фиксированную сумму — отдельный пункт меню стола
  // (openCheckModal), чтобы не мешать этим двум.
  const modeRow = (text) => {
    const row = document.createElement("label");
    row.className = "switch-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    row.append(box, document.createTextNode(` ${text}`));
    return { row, box };
  };
  const unlimited = modeRow("Без ограничения времени (постоплата)");
  const timed = modeRow("Ограничение по времени");
  unlimited.box.checked = true;
  body.append(unlimited.row, timed.row);

  // Блок «по времени»: чипсы + своё значение минут.
  const timeBlock = document.createElement("div");
  timeBlock.hidden = true;
  const chipsRow = document.createElement("div");
  chipsRow.className = "minute-chips";
  const minutesInput = document.createElement("input");
  minutesInput.type = "number";
  minutesInput.min = "1";
  minutesInput.className = "cash-input";
  minutesInput.value = "60";
  const chips = [];
  for (const m of [15, 30, 60, 90, 120]) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "minute-chip";
    chip.textContent = m % 60 === 0 ? `${m / 60} ч` : `${m} мин`;
    chip.addEventListener("click", () => {
      minutesInput.value = String(m);
      updateTimePreview();
      syncChips();
    });
    chips.push([chip, m]);
    chipsRow.append(chip);
  }
  const syncChips = () => {
    for (const [chip, m] of chips) {
      chip.classList.toggle("minute-chip-active", Number(minutesInput.value) === m);
    }
  };
  const timePreview = document.createElement("p");
  timePreview.className = "order-total";
  const updateTimePreview = () => {
    const minutes = Number(minutesInput.value) || 0;
    const sum = (perHourNow() * minutes) / 60;
    timePreview.textContent = `К оплате сейчас: ~${money(sum)}`;
    // Счёт клиента появляется только вместе с самим клиентом, поэтому
    // пересчитываем разбивку вместе с суммой.
    timePay?.update(pricing.read().client?.account ?? 0, sum);
  };
  minutesInput.addEventListener("input", () => {
    updateTimePreview();
    syncChips();
  });
  timeBlock.append(makeField("Время сессии, мин", minutesInput), chipsRow, timePreview);
  body.append(timeBlock);
  syncChips();

  // Стол забронирован — кассир должен увидеть это до того, как посадит
  // гостя: у постоплаты конца нет, а «на время» может перехлестнуть бронь.
  // Полоску ставим вверху окна, но создаём здесь — ей нужны поля времени.
  const bookingWarn = bookingWarningNote(table, () =>
    timed.box.checked ? Number(minutesInput.value) || 0 : null
  );
  if (bookingWarn) body.insertBefore(bookingWarn.node, unlimited.row);
  const refreshPreview = () => {
    updateTimePreview();
    bookingWarn?.update();
  };
  minutesInput.addEventListener("input", () => bookingWarn?.update());
  for (const box of [unlimited.box, timed.box]) {
    box.addEventListener("change", () => bookingWarn?.update());
  }
  refreshPreview();

  timePay = accountPayRow(async (method, useBalance) => {
    const minutes = Number(minutesInput.value);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      showToast("Укажите время больше нуля");
      return;
    }
    if (!(await confirmBookingOverrun(table, minutes))) return;
    const { tariff, clientId } = pricing.read();
    openPrepaid(table, {
      tariff_id: tariff.id,
      client_id: clientId,
      mode: "time",
      minutes,
      payment_method: method,
      use_balance: useBalance,
    });
  });
  const timePayRow = timePay.node;
  timePayRow.hidden = true;
  body.append(timePayRow);

  const plainOpenBtn = document.createElement("button");
  plainOpenBtn.className = "primary";
  plainOpenBtn.textContent = "Открыть";
  plainOpenBtn.addEventListener("click", async () => {
    // Постоплата не кончается сама — при брони спрашиваем всегда.
    if (!(await confirmBookingOverrun(table, null))) return;
    const { tariff, clientId } = pricing.read();
    openPostpaidNow(table, { tariffId: tariff.id, clientId });
  });
  body.append(plainOpenBtn);

  const modes = [
    { ...unlimited, sections: [plainOpenBtn] },
    { ...timed, sections: [timeBlock, timePayRow] },
  ];
  const allSections = modes.flatMap((m) => m.sections);
  for (const mode of modes) {
    mode.box.addEventListener("change", () => {
      if (!mode.box.checked) {
        mode.box.checked = true; // нельзя снять — всегда выбран ровно один вариант
        return;
      }
      for (const other of modes) if (other !== mode) other.box.checked = false;
      for (const el of allSections) el.hidden = true;
      for (const el of mode.sections) el.hidden = false;
    });
  }

  openModal(`Открыть — ${table.name}`, body);
}

/**
 * Чек на сумму: клиент платит фиксированную сумму сразу, время считается
 * по тарифу и отсчитывается — «пришёл поиграть на 30 000» → открываем чек
 * на 30 000, стол сам подсветится, когда время выйдет.
 */
function openCheckModal(table) {
  if (!allowedTariffs(table).length) {
    showToast("Нет доступных тарифов для этого стола");
    return;
  }
  const body = document.createElement("div");
  let checkPay = null;

  // Тариф и клиент выбираются здесь же: от них зависит, сколько времени
  // даст сумма чека.
  const pricing = pricingControls(table, {
    onChange: () => {
      updatePreview();
      updateChips();
    },
  });
  body.append(pricing.node);
  const perHourNow = () => {
    const { tariff, discount } = pricing.read();
    return (tariff?.price_per_hour ?? 0) * (1 - discount / 100);
  };

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Время посчитается от суммы чека по выбранному тарифу.";
  body.append(hint);

  const amountInput = document.createElement("input");
  amountInput.type = "number";
  amountInput.min = "1";
  amountInput.placeholder = `Сумма чека, ${cur()}`;
  amountInput.className = "cash-input";

  const preview = document.createElement("p");
  preview.className = "order-total";
  const updatePreview = () => {
    const sum = Number(amountInput.value);
    const perHour = perHourNow();
    if (!Number.isFinite(sum) || sum <= 0 || perHour <= 0) {
      preview.textContent = "";
      checkPay?.update(pricing.read().client?.account ?? 0, 0);
      return;
    }
    const minutes = Math.floor((sum / perHour) * 60);
    preview.textContent = `Этого хватит примерно на ${formatDuration(minutes * 60)}`;
    checkPay?.update(pricing.read().client?.account ?? 0, sum);
  };
  amountInput.addEventListener("input", updatePreview);

  // Быстрые суммы: круглые числа от цены часа — чаще всего берут их.
  const chipsRow = document.createElement("div");
  chipsRow.className = "minute-chips";
  const updateChips = () => {
    chipsRow.replaceChildren();
    const step = Math.max(1, Math.round(perHourNow()));
    for (const multiplier of [1, 2, 3, 5]) {
      const sum = step * multiplier;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "minute-chip";
      chip.textContent = `${sum} ${cur()}`;
      chip.addEventListener("click", () => {
        amountInput.value = String(sum);
        updatePreview();
      });
      chipsRow.append(chip);
    }
  };
  updateChips();

  body.append(makeField(`Сумма чека, ${cur()}`, amountInput), chipsRow, preview);

  // Сколько минут даст введённая сумма — по ним и сверяемся с бронью.
  const plannedByAmount = () => {
    const sum = Number(amountInput.value);
    const perHour = perHourNow();
    if (!Number.isFinite(sum) || sum <= 0 || perHour <= 0) return null;
    return Math.floor((sum / perHour) * 60);
  };
  const bookingWarn = bookingWarningNote(table, plannedByAmount);
  if (bookingWarn) {
    body.insertBefore(bookingWarn.node, hint);
    amountInput.addEventListener("input", () => bookingWarn.update());
  }

  checkPay = accountPayRow(async (method, useBalance) => {
      const sum = Number(amountInput.value);
      if (!Number.isFinite(sum) || sum <= 0) {
        showToast("Укажите сумму больше нуля");
        return;
      }
      if (!(await confirmBookingOverrun(table, plannedByAmount()))) return;
      const { tariff, clientId } = pricing.read();
      openPrepaid(table, {
        tariff_id: tariff.id,
        client_id: clientId,
        mode: "amount",
        amount: sum,
        payment_method: method,
        use_balance: useBalance,
      });
  });
  body.append(checkPay.node);

  openModal(`Чек на сумму — ${table.name}`, body);
  amountInput.focus();
}

/**
 * Продление открытого чека: «ещё 30 минут» или «ещё на сумму». Нужно,
 * когда оплаченное время кончилось, а гость играет дальше — раньше
 * приходилось закрывать стол и открывать заново, теряя историю сеанса.
 */
/**
 * Пересадка гостей на другой стол: сеанс со всей оплатой, баром и
 * таймером переезжает целиком. Показываем только свободные столы —
 * пересадить на занятый нельзя.
 */
function openMoveModal(table) {
  const free = state.tables.filter((t) => !t.session && t.id !== table.id);
  const body = document.createElement("div");

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    `Оплата, бар, клиент и таймер переедут на новый стол — заново ` +
    `открывать и пересчитывать ничего не нужно. Тариф останется прежним ` +
    `(«${table.session.tariff_name}»), поэтому цена не изменится.`;
  body.append(hint);

  if (!free.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Свободных столов нет.";
    body.append(empty);
    openModal(`Пересадить со стола «${table.name}»`, body);
    return;
  }

  const select = document.createElement("select");
  for (const target of free) {
    const option = document.createElement("option");
    option.value = String(target.id);
    option.textContent = target.name;
    select.append(option);
  }
  body.append(makeField("На какой стол", select));

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const go = document.createElement("button");
  go.className = "primary";
  go.textContent = "Пересадить";
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      await api(`/api/tables/${table.id}/move`, {
        method: "POST",
        body: JSON.stringify({ target_table_id: Number(select.value) }),
      });
      const name = free.find((t) => t.id === Number(select.value))?.name ?? "";
      closeModal();
      await refreshDashboard();
      showToast(`Гости пересажены на «${name}»`, true);
    } catch (error) {
      showToast(error.message);
      go.disabled = false;
    }
  });
  actions.append(go);
  body.append(actions);
  openModal(`Пересадить со стола «${table.name}»`, body);
}

function openExtendModal(table) {
  const session = table.session;
  if (!session?.prepaid) {
    showToast("Сеанс без ограничения времени — продлевать нечего");
    return;
  }
  const perHour = session.price_per_hour * (1 - (session.discount_percent ?? 0) / 100);
  const body = document.createElement("div");
  // Кнопки оплаты создаются ниже, а предпросмотр сумм обращается к ним
  // раньше — объявляем заранее.
  let timePay = null;
  let amountPay = null;

  const hint = document.createElement("p");
  hint.className = "hint";
  const left = Math.round(session.remaining_seconds);
  hint.textContent =
    `Тариф «${session.tariff_name}» — ${session.price_per_hour} ${cur()}/час` +
    (session.discount_percent ? ` со скидкой ${session.discount_percent}%` : "") +
    ". " +
    (left > 0
      ? `Осталось ${formatDuration(left)}.`
      : `Оплаченное время кончилось ${formatDuration(-left)} назад.`);
  body.append(hint);

  // Два равноправных варианта: докупить минуты или внести сумму.
  const modeRow = document.createElement("div");
  modeRow.className = "view-toggle";
  const buttons = new Map();
  for (const [value, label] of [["time", "Добавить время"], ["amount", "Добавить сумму"]]) {
    const btn = document.createElement("button");
    btn.className = "mini";
    btn.textContent = label;
    btn.addEventListener("click", () => setMode(value));
    buttons.set(value, btn);
    modeRow.append(btn);
  }
  body.append(modeRow);

  // --- время ---
  const timeBlock = document.createElement("div");
  const minutesInput = document.createElement("input");
  minutesInput.type = "number";
  minutesInput.min = "5";
  minutesInput.className = "cash-input";
  minutesInput.value = "60";
  const chipsRow = document.createElement("div");
  chipsRow.className = "minute-chips";
  const chips = [];
  for (const m of [15, 30, 60, 90, 120]) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "minute-chip";
    chip.textContent = m % 60 === 0 ? `${m / 60} ч` : `${m} мин`;
    chip.addEventListener("click", () => {
      minutesInput.value = String(m);
      updateTimePreview();
    });
    chips.push([chip, m]);
    chipsRow.append(chip);
  }
  const timePreview = document.createElement("p");
  timePreview.className = "order-total";
  const updateTimePreview = () => {
    const minutes = Number(minutesInput.value) || 0;
    const sum = (perHour * minutes) / 60;
    timePreview.textContent = `К оплате сейчас: ~${money(sum)}`;
    timePay?.update(session.client_account ?? 0, sum);
    for (const [chip, m] of chips) {
      chip.classList.toggle("minute-chip-active", Number(minutesInput.value) === m);
    }
  };
  minutesInput.addEventListener("input", updateTimePreview);
  timeBlock.append(makeField("Добавить минут", minutesInput), chipsRow, timePreview);
  body.append(timeBlock);
  updateTimePreview();

  timePay = accountPayRow(
    (method, useBalance) => {
      const minutes = Number(minutesInput.value);
      if (!Number.isFinite(minutes) || minutes < 5) {
        showToast("Продление: не меньше 5 минут");
        return;
      }
      extend({ minutes, payment_method: method, use_balance: useBalance });
    },
    { actionLabel: "Продлить со счёта" }
  );
  body.append(timePay.node);
  updateTimePreview();

  // --- сумма ---
  const amountBlock = document.createElement("div");
  amountBlock.hidden = true;
  const amountInput = document.createElement("input");
  amountInput.type = "number";
  amountInput.min = "1";
  amountInput.className = "cash-input";
  amountInput.placeholder = `Сумма, ${cur()}`;
  const amountPreview = document.createElement("p");
  amountPreview.className = "order-total";
  const updateAmountPreview = () => {
    const sum = Number(amountInput.value);
    if (!Number.isFinite(sum) || sum <= 0 || perHour <= 0) {
      amountPreview.textContent = "";
      amountPay?.update(session.client_account ?? 0, 0);
      return;
    }
    amountPreview.textContent =
      `Добавит примерно ${formatDuration(Math.floor((sum / perHour) * 3600))}`;
    amountPay?.update(session.client_account ?? 0, sum);
  };
  amountInput.addEventListener("input", updateAmountPreview);
  amountBlock.append(makeField(`Сумма, ${cur()}`, amountInput), amountPreview);
  body.append(amountBlock);

  amountPay = accountPayRow(
    (method, useBalance) => {
      const sum = Number(amountInput.value);
      if (!Number.isFinite(sum) || sum <= 0) {
        showToast("Укажите сумму больше нуля");
        return;
      }
      extend({ amount: sum, payment_method: method, use_balance: useBalance });
    },
    { actionLabel: "Продлить со счёта" }
  );
  amountPay.node.hidden = true;
  body.append(amountPay.node);
  updateAmountPreview();

  function setMode(mode) {
    for (const [value, btn] of buttons) {
      btn.classList.toggle("view-active", value === mode);
    }
    timeBlock.hidden = mode !== "time";
    timePay.node.hidden = mode !== "time";
    amountBlock.hidden = mode !== "amount";
    amountPay.node.hidden = mode !== "amount";
  }
  setMode("time");

  async function extend(payload) {
    try {
      await api(`/api/tables/${table.id}/extend`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      closeModal();
      showToast("Время продлено", true);
      await refreshDashboard();
    } catch (error) {
      showToast(error.message);
    }
  }

  openModal(`Продлить — ${table.name}`, body);
}

/**
 * Игра по чеку на остаток. Гость приносит бумажку с кодом — вводим код,
 * видим остаток и сколько времени он даёт по выбранному тарифу.
 */
function openVoucherModal(table) {
  if (!allowedTariffs(table).length) {
    showToast("Нет доступных тарифов для этого стола");
    return;
  }
  const body = document.createElement("div");

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "Чек выдаётся, когда гость не догулял оплаченное время. Введите код " +
    "с чека — остаток пойдёт в оплату этого сеанса, новых денег брать не нужно.";
  body.append(hint);

  const pricing = pricingControls(table, { onChange: () => refresh() });
  body.append(pricing.node);

  const codeInput = document.createElement("input");
  codeInput.type = "text";
  codeInput.className = "cash-input";
  codeInput.placeholder = "Ч-1234 или просто 1234";
  codeInput.autocomplete = "off";
  body.append(makeField("Код чека", codeInput));

  const found = document.createElement("p");
  found.className = "order-total";
  body.append(found);

  // Действующие чеки списком — чаще всего их немного, и выбрать из
  // списка быстрее, чем набирать код.
  const listBox = document.createElement("div");
  listBox.className = "voucher-list";
  body.append(listBox);

  let voucher = null;

  // На сколько минут хватит остатка чека — по ним сверяемся с бронью.
  const plannedByVoucher = () => {
    if (!voucher) return null;
    const { tariff, discount } = pricing.read();
    const perHour = (tariff?.price_per_hour ?? 0) * (1 - discount / 100);
    if (perHour <= 0) return null;
    return Math.floor((voucher.balance / perHour) * 60);
  };
  const bookingWarn = bookingWarningNote(table, plannedByVoucher);
  if (bookingWarn) body.insertBefore(bookingWarn.node, hint);

  const refresh = () => {
    bookingWarn?.update();
    if (!voucher) {
      found.textContent = "";
      return;
    }
    const { tariff, discount } = pricing.read();
    const perHour = (tariff?.price_per_hour ?? 0) * (1 - discount / 100);
    const seconds = perHour > 0 ? Math.floor((voucher.balance / perHour) * 3600) : 0;
    found.textContent =
      `Чек ${voucher.code}: остаток ${money(voucher.balance)}` +
      (voucher.client_name ? ` · ${voucher.client_name}` : "") +
      ` — хватит примерно на ${formatDuration(seconds)}`;
  };

  const lookup = async (code) => {
    const text = String(code ?? "").trim();
    if (!text) {
      voucher = null;
      refresh();
      return;
    }
    try {
      voucher = await api(`/api/vouchers/by-code/${encodeURIComponent(text)}`);
      if (voucher.status !== "active" || voucher.balance <= 0) {
        found.textContent = `Чек ${voucher.code} уже использован или отменён`;
        voucher = null;
        return;
      }
      codeInput.value = voucher.code;
      refresh();
    } catch (error) {
      voucher = null;
      found.textContent = error.message;
    }
  };
  codeInput.addEventListener("change", () => lookup(codeInput.value));

  api("/api/vouchers")
    .then((vouchers) => {
      listBox.replaceChildren();
      if (!vouchers.length) {
        const empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "Действующих чеков нет.";
        listBox.append(empty);
        return;
      }
      const title = document.createElement("p");
      title.className = "hint";
      title.textContent = "Действующие чеки:";
      listBox.append(title);
      for (const item of vouchers.slice(0, 12)) {
        const btn = document.createElement("button");
        btn.className = "mini voucher-chip";
        btn.textContent =
          `${item.code} · ${money(item.balance)}` +
          (item.client_name ? ` · ${item.client_name}` : "");
        btn.addEventListener("click", () => {
          voucher = item;
          codeInput.value = item.code;
          refresh();
        });
        listBox.append(btn);
      }
    })
    .catch(() => {});

  const openBtn = document.createElement("button");
  openBtn.className = "primary";
  openBtn.style.width = "100%";
  openBtn.textContent = "Открыть по чеку";
  openBtn.addEventListener("click", async () => {
    if (!voucher) {
      await lookup(codeInput.value);
      if (!voucher) {
        showToast("Введите код действующего чека");
        return;
      }
    }
    if (!(await confirmBookingOverrun(table, plannedByVoucher()))) return;
    const { tariff, clientId } = pricing.read();
    try {
      await api(`/api/tables/${table.id}/open`, {
        method: "POST",
        body: JSON.stringify({
          tariff_id: tariff.id,
          client_id: clientId ?? voucher.client_id ?? null,
          mode: "voucher",
          voucher_code: voucher.code,
        }),
      });
      closeModal();
      showToast(`Стол открыт по чеку ${voucher.code}`, true);
      await refreshDashboard();
    } catch (error) {
      showToast(error.message);
    }
  });
  body.append(openBtn);

  openModal(`Открыть по чеку — ${table.name}`, body);
}

// --- Групповые действия над выбранными столами ---

function selectedTables() {
  return state.tables.filter((t) => state.selected.has(t.id));
}

/** Последовательно выполняет действие над столами, показывает итог. */
async function runGroup(tables, action, successWord) {
  let ok = 0;
  let firstError = null;
  for (const table of tables) {
    try {
      await action(table);
      ok += 1;
    } catch (error) {
      firstError = firstError ?? `${table.name}: ${error.message}`;
    }
  }
  clearSelection();
  await refreshDashboard();
  if (firstError && ok === 0) showToast(firstError);
  else if (firstError) showToast(`${successWord}: ${ok}. Ошибка — ${firstError}`);
  else showToast(`${successWord}: ${ok}`, true);
}

/**
 * Одно подтверждение на все забронированные столы из выделения — вместо
 * череды окон по столу. Возвращает false, если кассир передумал.
 */
async function confirmGroupBookings(tables, plannedMinutes = null) {
  const booked = tables.filter((t) => {
    const left = bookingMinutesLeft(t);
    if (left === null) return false;
    return plannedMinutes === null || left <= 0 || plannedMinutes > left;
  });
  if (!booked.length) return true;
  const list = booked
    .map((t) => {
      const left = bookingMinutesLeft(t);
      return left <= 0
        ? `${t.name} — бронь уже идёт (${t.booking.client_name})`
        : `${t.name} — бронь через ${humanMinutes(left)} (${t.booking.client_name})`;
    })
    .join("; ");
  return confirmModal(
    booked.length === 1 ? "Стол забронирован" : "Столы забронированы",
    `${list}. Открыть всё равно?`,
    "Всё равно открыть"
  );
}

async function groupOpenPostpaid() {
  const free = selectedTables().filter((t) => !t.session);
  const { tariff } = cardPricing(null);
  if (!free.length) return showToast("Среди выбранных нет свободных столов");
  if (!tariff) return showToast("Нет активных тарифов");
  if (!(await confirmGroupBookings(free))) return;
  runGroup(
    free,
    (table) =>
      api(`/api/tables/${table.id}/open`, {
        method: "POST",
        body: JSON.stringify({ tariff_id: tariff.id }),
      }),
    "Открыто столов"
  );
}

function groupOpenTimeModal() {
  const free = selectedTables().filter((t) => !t.session);
  const { tariff } = cardPricing(null);
  if (!free.length) return showToast("Среди выбранных нет свободных столов");
  if (!tariff) return showToast("Нет активных тарифов");

  const body = document.createElement("div");
  const duration = document.createElement("select");
  for (const [minutes, label] of [
    [30, "30 минут"], [60, "1 час"], [90, "1.5 часа"], [120, "2 часа"], [180, "3 часа"],
  ]) {
    const option = document.createElement("option");
    option.value = String(minutes);
    option.textContent = label;
    duration.append(option);
  }
  duration.value = "60";
  const preview = document.createElement("p");
  preview.className = "order-total";
  const updatePreview = () => {
    const sum = tariff.price_per_hour * (Number(duration.value) / 60) * free.length;
    preview.textContent =
      `${free.length} стол(а) × тариф «${tariff.name}» — итого ~${money(sum)}`;
  };
  duration.addEventListener("change", updatePreview);
  updatePreview();
  body.append(makeField("Оплаченное время", duration), preview);

  // Забронированные столы среди выбранных — по строке на каждый.
  const bookedNotes = free
    .filter((t) => t.booking)
    .map((t) => bookingWarningNote(t, () => Number(duration.value)));
  for (const note of bookedNotes) body.append(note.node);
  duration.addEventListener("change", () => {
    for (const note of bookedNotes) note.update();
  });

  body.append(
    paymentButtonsRow(async (method) => {
      if (!(await confirmGroupBookings(free, Number(duration.value)))) return;
      closeModal();
      runGroup(
        free,
        (table) =>
          api(`/api/tables/${table.id}/open`, {
            method: "POST",
            body: JSON.stringify({
              tariff_id: tariff.id,
              mode: "time",
              minutes: Number(duration.value),
              payment_method: method,
            }),
          }),
        "Открыто столов"
      );
    })
  );
  openModal(`На время — ${free.length} стол(а)`, body);
}

function groupCloseModal() {
  const busy = selectedTables().filter((t) => t.session);
  if (!busy.length) return showToast("Среди выбранных нет занятых столов");

  const body = document.createElement("div");
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    `Закроются столы: ${busy.map((t) => t.name).join(", ")}. ` +
    "Выберите способ оплаты для всех.";
  body.append(hint);
  body.append(
    paymentButtonsRow((method) => {
      closeModal();
      runGroup(
        busy,
        (table) =>
          api(`/api/tables/${table.id}/close`, {
            method: "POST",
            body: JSON.stringify({ payment_method: method }),
          }),
        "Закрыто столов"
      );
    })
  );
  openModal(`Закрытие — ${busy.length} стол(а)`, body);
}

// ------------------------------------------------- горячие клавиши и поиск

/**
 * Быстрый поиск: столы и клиенты в одном окне. Кассиру не нужно
 * вспоминать, на какой вкладке искать — набрал имя или номер стола и
 * сразу попал куда надо.
 */
function openQuickSearch() {
  const body = document.createElement("div");
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Стол, имя клиента или телефон";
  input.autocomplete = "off";
  body.append(input);

  const results = document.createElement("div");
  results.className = "quick-results";
  body.append(results);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "↑ ↓ — выбрать, Enter — открыть, Esc — закрыть.";
  body.append(hint);

  let items = [];
  let cursor = 0;

  const render = () => {
    results.replaceChildren();
    items.forEach((item, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `quick-item${index === cursor ? " active" : ""}`;
      row.append(icon(item.icon));
      const label = document.createElement("span");
      label.textContent = item.label;
      const note = document.createElement("span");
      note.className = "quick-note";
      note.textContent = item.note;
      row.append(label, note);
      row.addEventListener("click", () => {
        closeModal();
        item.run();
      });
      results.append(row);
    });
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "Ничего не нашлось.";
      results.append(empty);
    }
  };

  const search = () => {
    const query = input.value.trim().toLowerCase();
    const digits = query.replace(/\D/g, "");
    items = [];
    if (query) {
      for (const table of state.tables) {
        if (!table.name.toLowerCase().includes(query)) continue;
        items.push({
          icon: table.session ? "play" : "ball",
          label: table.name,
          note: table.session
            ? `занят${table.session.client_name ? `, ${table.session.client_name}` : ""}`
            : "свободен",
          run: () => {
            switchTab("dashboard");
            selectTableOnMap(table.id);
          },
        });
      }
      for (const client of state.clients) {
        const phone = (client.phone ?? "").replace(/\D/g, "");
        const byName = client.name.toLowerCase().includes(query);
        const byPhone = digits.length >= 3 && phone.includes(digits);
        if (!byName && !byPhone) continue;
        items.push({
          icon: "person",
          label: client.name,
          note: client.phone ?? "клиент",
          run: () => openClientStats(client),
        });
      }
    }
    items = items.slice(0, 12);
    cursor = 0;
    render();
  };

  input.addEventListener("input", search);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      cursor = Math.min(cursor + 1, items.length - 1);
      render();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      render();
    } else if (event.key === "Enter" && items[cursor]) {
      event.preventDefault();
      const chosen = items[cursor];
      closeModal();
      chosen.run();
    }
  });

  openModal("Быстрый поиск", body);
  input.focus();
  search();
}

/** Подсвечивает стол на карте и показывает его меню действий. */
function selectTableOnMap(tableId) {
  const tile = document.querySelector(`.tile[data-table-id="${tableId}"]`);
  if (!tile) return;
  tile.scrollIntoView({ block: "center", behavior: "smooth" });
  clearSelection();
  state.selected.add(tableId);
  renderMap();
  const table = state.tables.find((t) => t.id === tableId);
  const box = tile.getBoundingClientRect();
  if (table) {
    showContextMenu(
      { preventDefault() {}, clientX: box.left + box.width / 2, clientY: box.bottom },
      table
    );
  }
}

/** Окно со списком горячих клавиш (F1). */
function openShortcutsHelp() {
  const body = document.createElement("div");
  const list = document.createElement("div");
  list.className = "shortcuts";
  const rows = [
    ["F, / или Ctrl+F", "быстрый поиск стола и клиента"],
    ["1 … 9", "выбрать стол с этим номером и открыть меню действий"],
    ["Enter", "подтвердить в открытом окне (главная кнопка)"],
    ["Esc", "закрыть окно или меню"],
    ["С", "открыть/закрыть кассовую смену"],
    ["F1 или ?", "эта подсказка"],
  ];
  for (const [key, what] of rows) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    const text = document.createElement("span");
    text.textContent = what;
    row.append(kbd, text);
    list.append(row);
  }
  body.append(list);
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "Клавиши работают, когда курсор не стоит в поле ввода — иначе " +
    "они просто печатаются.";
  body.append(hint);
  openModal("Горячие клавиши", body);
}

/** Печатает ли пользователь прямо сейчас в поле ввода. */
function typingInField(target) {
  const tag = target?.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target?.isContentEditable === true
  );
}

/**
 * Горячие клавиши. Кассир за смену делает сотни кликов — часть из них
 * заменяется одной клавишей. Всё, что печатается в поля, не трогаем.
 */
function handleShortcut(event) {
  const modalOpen = !document.getElementById("modal-overlay").hidden;
  const menuOpen = !document.getElementById("context-menu").hidden;

  if (event.key === "Escape") {
    if (menuOpen) hideContextMenu();
    else if (modalOpen) closeModal();
    return;
  }
  if (modalOpen) {
    // Enter в окне = нажать главную кнопку (кроме многострочного поля,
    // где Enter — это перенос строки).
    if (event.key === "Enter" && event.target?.tagName !== "TEXTAREA") {
      const primary = document.querySelector("#modal button.primary:not([disabled])");
      if (primary) {
        event.preventDefault();
        primary.click();
      }
    }
    return;
  }
  if (typingInField(event.target)) return;

  if (event.key === "F1" || event.key === "?") {
    event.preventDefault();
    openShortcutsHelp();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    openQuickSearch();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const key = event.key.toLowerCase();
  if (key === "/" || key === "f" || key === "а") {
    // «а» — та же клавиша F в русской раскладке.
    event.preventDefault();
    openQuickSearch();
    return;
  }
  if (key === "с" || key === "c") {
    event.preventDefault();
    toggleShift();
    return;
  }
  if (/^[1-9]$/.test(event.key)) {
    const table = state.tables.find((t) => {
      const short = t.name.match(/(\d+)\s*$/);
      return short && short[1] === event.key;
    });
    if (table) {
      event.preventDefault();
      switchTab("dashboard");
      selectTableOnMap(table.id);
    }
  }
}

// ---------------------------------------------------------------- context menu

function hideContextMenu() {
  document.getElementById("context-menu").hidden = true;
}

function showContextMenu(event, table, card) {
  event.preventDefault();
  const menu = document.getElementById("context-menu");
  menu.replaceChildren();

  const addItem = (iconName, label, handler) => {
    const item = document.createElement("button");
    item.className = "context-item";
    item.append(...withIcon(iconName, label));
    item.addEventListener("click", () => {
      hideContextMenu();
      handler();
    });
    menu.append(item);
  };

  // Групповое меню: правый клик по одному из нескольких выбранных столов.
  if (state.selected.size > 1 && state.selected.has(table.id)) {
    const chosen = selectedTables();
    const free = chosen.filter((t) => !t.session).length;
    const busy = chosen.length - free;
    if (free > 0) {
      addItem("play", `Открыть свободные (${free}) — постоплата`, groupOpenPostpaid);
      addItem("timer", `Открыть свободные (${free}) на время…`, groupOpenTimeModal);
    }
    if (busy > 0) {
      addItem("card", `Закрыть занятые (${busy})…`, groupCloseModal);
    }
    addItem("close", "Снять выделение", clearSelection);
    menu.hidden = false;
    const { innerWidth, innerHeight } = window;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(event.clientX, innerWidth - rect.width - 8)}px`;
    menu.style.top = `${Math.min(event.clientY, innerHeight - rect.height - 8)}px`;
    return;
  }

  if (table.session) {
    // Продлить можно только предоплаченный сеанс: у постоплаты время
    // и так не кончается.
    if (table.session.prepaid) {
      addItem("timer", "Продлить время…", () => openExtendModal(table));
    }
    addItem("move", "Пересадить на стол…", () => openMoveModal(table));
    addItem("card", "Закрыть стол…", () => openCloseModal(table));
  } else {
    addItem("play", "Открыть…", () => openStartSessionModal(table));
    addItem("card", "Чек на сумму…", () => openCheckModal(table));
    addItem("gift", "Открыть по чеку…", () => openVoucherModal(table));
    addItem("calendar", "Забронировать…", () => openBookingModal(table));
    if (can("open_free_time")) {
      addItem("gift", "Бесплатное время", () => openFreeTimeSession(table));
    }
  }
  if (table.booking) {
    addItem("close", "Отменить бронь", () => cancelTableBooking(table));
  }
  // Свет над столом: включается сам при открытии сеанса, но иногда его
  // нужно щёлкнуть руками — проверить реле или погасить забытую лампу.
  if (can("manage_tables")) {
    addItem(
      "bulb",
      table.light_on ? "Выключить свет" : "Включить свет",
      () => toggleTableLight(table)
    );
  }


  menu.hidden = false;
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, innerHeight - rect.height - 8)}px`;
}

// ---------------------------------------------------------------- clients tab

async function refreshClientsTab() {
  const query = document.getElementById("client-search").value.trim();
  const clients = await api(`/api/clients?query=${encodeURIComponent(query)}`);
  state.clients = clients;
  renderClientsDatalist();

  const rows = document.getElementById("client-rows");
  rows.replaceChildren();
  // Статистику по каждому клиенту берём одним пакетом запросов: она
  // отвечает на главный вопрос — кто ходит часто и сколько оставляет.
  const stats = new Map(
    (
      await Promise.all(
        clients.map((client) =>
          api(`/api/clients/${client.id}/stats`)
            .then((data) => [client.id, data])
            .catch(() => [client.id, null])
        )
      )
    ).filter(([, data]) => data)
  );

  for (const client of clients) {
    const tr = document.createElement("tr");
    const stat = stats.get(client.id);
    const cells = [
      client.name,
      client.phone ?? "—",
      client.discount_percent ? `${client.discount_percent}%` : "—",
      String(client.visits),
      stat && stat.total.visits ? money(stat.total.average) : "—",
      stat && stat.total.seconds ? formatDuration(stat.total.seconds) : "—",
      stat?.last_visit ? formatDateTime(stat.last_visit) : "—",
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }

    const actions = document.createElement("td");
    actions.className = "user-actions";
    const statsBtn = document.createElement("button");
    statsBtn.className = "mini";
    statsBtn.textContent = "Статистика";
    statsBtn.addEventListener("click", () => openClientStats(client));
    actions.append(statsBtn);

    if (can("manage_clients")) {
      const discountBtn = document.createElement("button");
      discountBtn.className = "mini";
      discountBtn.textContent = "Скидка";
      discountBtn.addEventListener("click", async () => {
        const value = prompt(
          `Скидка для «${client.name}» в процентах (0–100):`,
          String(client.discount_percent)
        );
        if (value === null) return;
        try {
          await api(`/api/clients/${client.id}`, {
            method: "PUT",
            body: JSON.stringify({ discount_percent: Number(value) }),
          });
          showToast("Скидка обновлена", true);
          await refreshClientsTab();
        } catch (error) {
          showToast(error.message);
        }
      });
      actions.append(discountBtn);
    }
    tr.append(actions);
    rows.append(tr);
  }
  document.getElementById("clients-empty").hidden = clients.length > 0;
  await renderVouchers().catch(() => {}); // чеки — справка, без них можно
}

/** Действующие чеки на остаток — таблица во вкладке «Клиенты». */
async function renderVouchers() {
  const rows = document.getElementById("voucher-rows");
  const empty = document.getElementById("vouchers-empty");
  const vouchers = await api("/api/vouchers");
  rows.replaceChildren();
  for (const voucher of vouchers) {
    const tr = document.createElement("tr");
    for (const text of [
      voucher.kind === "bonus" ? `${voucher.code} · подарок` : voucher.code,
      money(voucher.balance),
      voucher.client_name ?? "—",
      formatDateTime(voucher.created_at),
      voucher.created_by_name ?? "—",
    ]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    const actions = document.createElement("td");
    if (can("manage_settings")) {
      const cancel = document.createElement("button");
      cancel.className = "mini danger";
      cancel.textContent = "Отменить";
      cancel.addEventListener("click", async () => {
        const ok = await confirmModal(
          "Отмена чека",
          `Отменить чек ${voucher.code} на ${money(voucher.balance)}? ` +
            "Гость больше не сможет по нему доиграть.",
          "Отменить чек"
        );
        if (!ok) return;
        try {
          await api(`/api/vouchers/${voucher.id}`, { method: "DELETE" });
          showToast("Чек отменён", true);
          await renderVouchers();
        } catch (error) {
          showToast(error.message);
        }
      });
      actions.append(cancel);
    }
    tr.append(actions);
    rows.append(tr);
  }
  empty.hidden = vouchers.length > 0;
}

/**
 * Карточка статистики клиента: посещаемость, расход и время за день,
 * неделю, месяц и за всё время.
 */
async function openClientStats(client) {
  let stats;
  try {
    stats = await api(`/api/clients/${client.id}/stats`);
  } catch (error) {
    showToast(error.message);
    return;
  }
  const body = document.createElement("div");

  const head = document.createElement("p");
  head.className = "hint";
  head.textContent =
    (stats.discount_percent ? `Скидка ${stats.discount_percent}%. ` : "") +
    (stats.last_visit
      ? `Последний визит: ${formatDateTime(stats.last_visit)}.`
      : "Закрытых визитов пока не было.");
  body.append(head);

  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const text of ["Период", "Визитов", "Расход", "Средний расход", "Время"]) {
    const th = document.createElement("th");
    th.textContent = text;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  const periods = [
    ["День", stats.day],
    ["Неделя", stats.week],
    ["Месяц", stats.month],
    ["Всё время", stats.total],
  ];
  for (const [label, p] of periods) {
    const tr = document.createElement("tr");
    for (const text of [
      label,
      String(p.visits),
      money(p.spent),
      p.visits ? money(p.average) : "—",
      p.seconds ? formatDuration(p.seconds) : "—",
    ]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  body.append(table);

  // Любимые столы/тарифы — куда чаще всего садится этот клиент, помогает
  // предложить привычное место и не переспрашивать заново.
  const favoriteBlock = (title, rows) => {
    if (!rows.length) return null;
    const wrap = document.createElement("div");
    const heading = document.createElement("h4");
    heading.className = "limit-title";
    heading.textContent = title;
    wrap.append(heading);
    const t = document.createElement("table");
    t.className = "data-table";
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Название</th><th>Визитов</th><th>Время</th><th>Расход</th></tr>";
    t.append(thead);
    const tb = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const text of [
        row.name,
        String(row.visits),
        formatDuration(row.seconds),
        money(row.spent),
      ]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      tb.append(tr);
    }
    t.append(tb);
    wrap.append(t);
    return wrap;
  };
  const favTables = favoriteBlock("Любимые столы", stats.favorite_tables ?? []);
  const favTariffs = favoriteBlock("Любимые тарифы", stats.favorite_tariffs ?? []);
  if (favTables) body.append(favTables);
  if (favTariffs) body.append(favTariffs);

  // Действующие чеки клиента — сразу видно, есть ли ему что доиграть.
  try {
    const vouchers = await api(`/api/vouchers?client_id=${client.id}`);
    if (vouchers.length) {
      const title = document.createElement("h4");
      title.className = "limit-title";
      title.textContent = "Чеки на остаток";
      body.append(title);
      const list = document.createElement("div");
      list.className = "voucher-list";
      for (const voucher of vouchers) {
        const chip = document.createElement("span");
        chip.className = "voucher-chip";
        chip.textContent = `${voucher.code} · ${money(voucher.balance)}`;
        list.append(chip);
      }
      body.append(list);
    }
  } catch {
    // Чеки не загрузились — статистику всё равно показываем.
  }

  openModal(`Клиент — ${stats.name}`, body, null, { wide: true });
}

const CLIENT_PHONE_PREFIX = "+998";

async function addClient() {
  try {
    const phone = document.getElementById("new-client-phone").value.trim();
    await api("/api/clients", {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("new-client-name").value.trim(),
        // Если кассир не дописал номер после префикса, это не номер.
        phone: phone === CLIENT_PHONE_PREFIX ? "" : phone,
      }),
    });
    document.getElementById("new-client-name").value = "";
    document.getElementById("new-client-phone").value = CLIENT_PHONE_PREFIX;
    showToast("Клиент добавлен", true);
    await refreshClientsTab();
  } catch (error) {
    showToast(error.message);
  }
}

// ---------------------------------------------------------------- cashdesk (Касса)

/** Показывает баланс и действующие чеки клиента, найденного в поле ввода. */
async function refreshTopupClientCard() {
  const card = document.getElementById("topup-client-card");
  const clientId = clientIdFromInput(document.getElementById("topup-client").value);
  if (!clientId) {
    card.hidden = true;
    return;
  }
  const client = state.clients.find((c) => c.id === clientId);
  let vouchers;
  try {
    vouchers = await api(`/api/vouchers?client_id=${clientId}`);
  } catch {
    card.hidden = true;
    return;
  }
  document.getElementById("topup-client-title").textContent = client?.name ?? "Клиент";
  const balance = vouchers.reduce((sum, v) => sum + v.balance, 0);
  document.getElementById("topup-client-balance").textContent =
    balance > 0 ? `На счету: ${money(balance)}` : "На счету пока пусто";
  const list = document.getElementById("topup-client-vouchers");
  list.replaceChildren();
  for (const voucher of vouchers) {
    const chip = document.createElement("span");
    chip.className = "voucher-chip";
    chip.textContent = `${voucher.code} · ${money(voucher.balance)}`;
    list.append(chip);
  }
  card.hidden = false;
}

async function topUpClientAccount() {
  const status = document.getElementById("topup-status");
  const clientInput = document.getElementById("topup-client");
  const clientId = clientIdFromInput(clientInput.value);
  if (!clientId) {
    showToast("Выберите клиента из подсказки — сначала добавьте его на вкладке «Клиенты»");
    return;
  }
  const amountInput = document.getElementById("topup-amount");
  const amount = Number(amountInput.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    showToast("Сумма должна быть больше нуля");
    return;
  }
  const btn = document.getElementById("topup-btn");
  btn.disabled = true;
  status.replaceChildren();
  try {
    const voucher = await api(`/api/clients/${clientId}/topup`, {
      method: "POST",
      body: JSON.stringify({
        amount,
        payment_method: document.getElementById("topup-method").value,
      }),
    });
    amountInput.value = "";
    showToast(`Счёт пополнен — чек ${voucher.code}`, true);
    // Наличное пополнение меняет расчётные наличные в открытой смене —
    // без обновления окно закрытия смены показало бы старые цифры.
    await Promise.all([refreshTopupClientCard(), refreshTopupFeed(), refreshShift()]);
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message);
  } finally {
    btn.disabled = false;
  }
}

/** Лента последних пополнений — «кому закинули счёт», справа на вкладке. */
async function refreshTopupFeed() {
  const feed = document.getElementById("topup-feed");
  const empty = document.getElementById("topup-feed-empty");
  const topups = await api("/api/vouchers?kind=topup&status=all&limit=20");
  feed.replaceChildren();
  empty.hidden = topups.length > 0;
  for (const voucher of topups) {
    const row = document.createElement("div");
    row.className = "cash-move in";
    row.textContent =
      `+${money(voucher.amount)} — ${voucher.client_name ?? "без клиента"} ` +
      `(${voucher.code}, ${formatDateTime(voucher.created_at)}, ${voucher.created_by_name ?? "—"})`;
    feed.append(row);
  }
}

/** Последние сеансы столов — «время столов по списку», справа на вкладке. */
async function refreshCashdeskSessions() {
  const rows = document.getElementById("cashdesk-sessions-rows");
  const sessions = await api("/api/history?limit=15");
  rows.replaceChildren();
  for (const s of sessions) {
    const tr = document.createElement("tr");
    for (const text of [
      s.table_name,
      `${formatDateTime(s.started_at)} — ${s.ended_at ? formatDateTime(s.ended_at) : "идёт"}`,
      s.client_name ?? "—",
    ]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    rows.append(tr);
  }
}

async function refreshCashdeskTab() {
  await Promise.all([refreshTopupFeed(), refreshCashdeskSessions(), refreshTopupClientCard()]);
}

// ---------------------------------------------------------------- users

const ROLE_LABELS = {
  developer: "Разработчик",
  owner: "Владелец",
  manager: "Управляющий",
  admin: "Администратор",
  cashier: "Кассир",
};

// Роли developer/owner/manager назначает только владелец/разработчик —
// то же правило, что и на сервере (там оно и решает, здесь лишь для UI).
const RESTRICTED_ROLE_OPTIONS = new Set(["developer", "owner", "manager"]);

async function refreshUsers() {
  // Матрицу прав грузим тем, кому она открыта: владельцу, разработчику
  // и — пока владельца в системе нет — тому, кто настраивает клуб первым
  // (иначе карточка была бы видна, но пуста).
  if (state.ownerLevel) {
    await refreshPermissionsMatrix().catch(() => {}); // не должно ронять список сотрудников
  }
  const users = await api("/api/users");
  const rows = document.getElementById("user-rows");
  rows.replaceChildren();
  for (const user of users) {
    const tr = document.createElement("tr");
    if (!user.is_active) tr.classList.add("row-off");

    for (const text of [user.login, user.name, ROLE_LABELS[user.role] ?? user.role]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }

    const statusCell = document.createElement("td");
    statusCell.textContent = user.is_active ? "активен" : "отключён";
    if (user.custom_limits) {
      const mark = document.createElement("span");
      mark.className = "limit-mark";
      mark.textContent = "личные ограничения";
      mark.title = "Права этого сотрудника отличаются от прав его роли";
      statusCell.append(document.createElement("br"), mark);
    }
    tr.append(statusCell);

    const actionsCell = document.createElement("td");
    actionsCell.className = "user-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "mini";
    editBtn.textContent = "Изменить";
    editBtn.addEventListener("click", () => openUserModal(user));
    actionsCell.append(editBtn);

    if (user.id !== state.user.id) {
      const activeBtn = document.createElement("button");
      activeBtn.className = "mini";
      activeBtn.textContent = user.is_active ? "Отключить" : "Включить";
      activeBtn.addEventListener("click", async () => {
        try {
          await api(`/api/users/${user.id}`, {
            method: "PUT",
            body: JSON.stringify({ is_active: !user.is_active }),
          });
          await refreshUsers();
        } catch (error) {
          showToast(error.message);
        }
      });
      actionsCell.append(activeBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "mini danger";
      deleteBtn.textContent = "Удалить";
      deleteBtn.addEventListener("click", () => deleteUserConfirm(user));
      actionsCell.append(deleteBtn);
    }

    tr.append(actionsCell);
    rows.append(tr);
  }
}

/**
 * Личные ограничения сотрудника — той же таблицей с галочками, что и
 * «Роли и права» в настройках, и с таким же мгновенным сохранением.
 *
 * Галочка «Доступ» — что человек может на самом деле. Пока личного
 * решения нет, она повторяет право роли, а в колонке «Откуда» написано
 * «по роли». Как только галочку тронули, решение становится личным
 * (сильнее роли) — кнопка «↺ по роли» возвращает всё как у роли.
 */
async function renderUserLimits(box, user) {
  const data = await api(`/api/users/${user.id}/permissions`);
  box.replaceChildren();

  const title = document.createElement("h4");
  title.className = "limit-title";
  title.textContent = "Личные ограничения";
  box.append(title);

  const isSelf = user.id === state.user.id;
  const locked = isSelf || data.ignored;

  const hint = document.createElement("p");
  hint.className = "hint";
  if (data.ignored) {
    hint.textContent =
      "У разработчика полный доступ всегда — личные ограничения к нему не применяются.";
  } else if (isSelf) {
    hint.textContent =
      "Это ваш аккаунт: себе ограничения менять нельзя, чтобы не закрыть себе доступ.";
  } else {
    hint.textContent =
      `Права роли (${ROLE_LABELS[data.role] ?? data.role}) настраиваются в ` +
      "«Настройки → Роли и права» и действуют на всех с этой ролью. Здесь " +
      "можно решить иначе для этого человека. Изменения применяются сразу.";
  }
  box.append(hint);

  const table = document.createElement("table");
  table.className = "data-table limit-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(document.createElement("th"));
  for (const text of ["Доступ", "Откуда"]) {
    const th = document.createElement("th");
    th.textContent = text;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const perm of data.permissions) {
    const tr = document.createElement("tr");

    const label = document.createElement("td");
    label.textContent = perm.label;
    tr.append(label);

    const accessCell = document.createElement("td");
    accessCell.className = "limit-access";
    const boxInput = document.createElement("input");
    boxInput.type = "checkbox";
    boxInput.checked = perm.effective;
    boxInput.disabled = locked;
    boxInput.title = perm.by_role
      ? "Роль это разрешает"
      : "Роль это запрещает";
    accessCell.append(boxInput);
    tr.append(accessCell);

    const sourceCell = document.createElement("td");
    sourceCell.className = "limit-source";
    tr.append(sourceCell);

    /** Подпись «откуда» право и кнопка возврата к роли. */
    const renderSource = (own) => {
      sourceCell.replaceChildren();
      const mark = document.createElement("span");
      if (own === null) {
        mark.className = "limit-from-role";
        mark.textContent = "по роли";
      } else {
        mark.className = "limit-from-own";
        mark.textContent = own ? "лично разрешено" : "лично запрещено";
      }
      sourceCell.append(mark);

      if (own !== null && !locked) {
        const reset = document.createElement("button");
        reset.className = "mini limit-reset";
        reset.title = "Вернуть как у роли";
        reset.textContent = "↺ по роли";
        reset.addEventListener("click", () => save(null));
        sourceCell.append(reset);
      }
    };

    /** Сохранение: null — вернуть к роли, true/false — личное решение. */
    const save = async (value) => {
      const previous = { own: perm.own, effective: perm.effective };
      try {
        const saved = await api(`/api/users/${user.id}/permissions`, {
          method: "PUT",
          body: JSON.stringify({ permissions: { [perm.key]: value } }),
        });
        const fresh = saved.permissions.find((p) => p.key === perm.key);
        perm.own = fresh.own;
        perm.effective = fresh.effective;
        boxInput.checked = fresh.effective;
        renderSource(fresh.own);
        showToast(
          value === null ? "Вернули как у роли" : "Ограничение сохранено",
          true
        );
        // В списке сотрудников отметка «личные ограничения» появляется
        // или исчезает — обновляем его сразу.
        await refreshUsers().catch(() => {});
      } catch (error) {
        perm.own = previous.own;
        perm.effective = previous.effective;
        boxInput.checked = previous.effective;
        renderSource(previous.own);
        showToast(error.message);
      }
    };

    boxInput.addEventListener("change", () => save(boxInput.checked));
    renderSource(perm.own);
    tbody.append(tr);
  }
  table.append(tbody);
  box.append(table);
}

/** Список ролей для выбора: чужие привилегии показываем только тем, кто их выдаёт. */
function roleOptions(currentRole) {
  const canGrantRestricted = ["developer", "owner"].includes(state.user.role);
  const select = document.createElement("select");
  for (const [value, label] of Object.entries(ROLE_LABELS)) {
    // Роль сотрудника всегда в списке — иначе её нельзя было бы сохранить.
    if (
      RESTRICTED_ROLE_OPTIONS.has(value) &&
      !canGrantRestricted &&
      value !== currentRole
    ) {
      continue;
    }
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = currentRole;
  return select;
}

/** Карточка сотрудника: логин, имя, роль, доступ, смена пароля. */
function openUserModal(user) {
  const body = document.createElement("div");
  const grid = document.createElement("div");
  grid.className = "settings-grid";

  const loginInput = document.createElement("input");
  loginInput.type = "text";
  loginInput.autocomplete = "off";
  loginInput.spellcheck = false;
  loginInput.value = user.login;

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.autocomplete = "off";
  nameInput.value = user.name;

  const roleSelect = roleOptions(user.role);
  const isSelf = user.id === state.user.id;
  roleSelect.disabled = isSelf; // свою роль менять нельзя (и на сервере тоже)

  const passwordInput = document.createElement("input");
  passwordInput.type = "password";
  passwordInput.autocomplete = "new-password";
  passwordInput.placeholder = "оставьте пустым — не менять";

  // Оплата труда: часы берутся из кассовых смен, поэтому отдельный
  // табель не нужен — достаточно ставки и процента.
  const rateInput = document.createElement("input");
  rateInput.type = "number";
  rateInput.min = "0";
  rateInput.step = "0.01";
  rateInput.value = String(user.hourly_rate ?? 0);

  const percentInput = document.createElement("input");
  percentInput.type = "number";
  percentInput.min = "0";
  percentInput.max = "100";
  percentInput.step = "1";
  percentInput.value = String(user.revenue_percent ?? 0);

  grid.append(
    makeField("Логин", loginInput),
    makeField("Имя", nameInput),
    makeField("Роль", roleSelect),
    makeField("Новый пароль", withPasswordEye(passwordInput)),
    makeField(`Ставка за час, ${cur()}`, rateInput),
    makeField("Процент от выручки, %", percentInput)
  );
  body.append(grid);

  const payHint = document.createElement("p");
  payHint.className = "hint";
  payHint.textContent =
    "Начисление считается в «Отчётах» → «Зарплата»: часы работы (по " +
    "кассовым сменам) × ставка + выручка его смен × процент. " +
    "Ноль — эта часть не начисляется.";
  body.append(payHint);

  const activeRow = document.createElement("label");
  activeRow.className = "switch-row";
  const activeBox = document.createElement("input");
  activeBox.type = "checkbox";
  activeBox.checked = Boolean(user.is_active);
  activeBox.disabled = isSelf; // себя отключить нельзя
  activeRow.append(activeBox, document.createTextNode(" Доступ разрешён (может входить)"));
  body.append(activeRow);

  if (isSelf) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent =
      "Это ваш аккаунт: роль и доступ к себе менять нельзя — чтобы не закрыть себе вход.";
    body.append(note);
  }

  // Личные ограничения: сильнее прав роли. Нужны, когда двум кассирам
  // положено разное — иначе пришлось бы плодить роли под каждого человека.
  const limitsBox = document.createElement("div");
  limitsBox.className = "user-limits";
  body.append(limitsBox);
  renderUserLimits(limitsBox, user).catch((error) => {
    limitsBox.replaceChildren();
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = `Личные ограничения недоступны: ${error.message}`;
    limitsBox.append(note);
  });

  const saveBtn = document.createElement("button");
  saveBtn.className = "primary";
  saveBtn.textContent = "Сохранить";
  saveBtn.addEventListener("click", async () => {
    const patch = {
      login: loginInput.value.trim(),
      name: nameInput.value.trim(),
    };
    if (!isSelf) {
      patch.role = roleSelect.value;
      patch.is_active = activeBox.checked;
    }
    patch.hourly_rate = Number(rateInput.value);
    patch.revenue_percent = Number(percentInput.value);
    if (passwordInput.value) patch.password = passwordInput.value;
    try {
      await api(`/api/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      closeModal();
      showToast("Сотрудник сохранён", true);
      await refreshUsers();
    } catch (error) {
      showToast(error.message);
    }
  });

  const actions = document.createElement("div");
  actions.className = "settings-actions";
  actions.append(saveBtn);

  if (!isSelf) {
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "mini danger";
    deleteBtn.textContent = "Удалить сотрудника";
    deleteBtn.addEventListener("click", () => deleteUserConfirm(user));
    actions.append(deleteBtn);
  }
  body.append(actions);

  openModal(`Сотрудник — ${user.name}`, body, null, { wide: true });
}

/** Удаление сотрудника с подтверждением. */
async function deleteUserConfirm(user) {
  const confirmed = await confirmModal(
    "Удаление сотрудника",
    `Удалить сотрудника «${user.name}» (${user.login})? Если за ним есть ` +
      "смены, сеансы или брони, аккаунт не удаляется, а отключается — иначе " +
      "порвалась бы история.",
    "Удалить"
  );
  if (!confirmed) return;
  try {
    const result = await api(`/api/users/${user.id}`, { method: "DELETE" });
    showToast(
      result.deleted
        ? "Сотрудник удалён"
        : "За сотрудником есть история — аккаунт отключён, а не удалён",
      true
    );
    await refreshUsers();
  } catch (error) {
    showToast(error.message);
  }
}

async function addUser() {
  try {
    await api("/api/users", {
      method: "POST",
      body: JSON.stringify({
        login: document.getElementById("new-user-login").value.trim(),
        name: document.getElementById("new-user-name").value.trim(),
        password: document.getElementById("new-user-password").value,
        role: document.getElementById("new-user-role").value,
      }),
    });
    for (const id of ["new-user-login", "new-user-name", "new-user-password"]) {
      document.getElementById(id).value = "";
    }
    showToast("Аккаунт создан", true);
    await refreshUsers();
  } catch (error) {
    showToast(error.message);
  }
}

// ---------------------------------------------------------------- settings

const SWITCH_CODES = ["switch_1", "switch_2", "switch_3", "switch_4"];

function deviceLabel(device) {
  const online =
    device.online === null ? "" : device.online ? "" : " (офлайн)";
  return `${device.name}${online}`;
}

function buildDeviceSelect(current) {
  const select = document.createElement("select");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "— не привязано —";
  select.append(none);
  for (const device of state.devices) {
    const option = document.createElement("option");
    option.value = device.id;
    option.textContent = deviceLabel(device);
    select.append(option);
  }
  // Привязанное ранее устройство, которого нет в загруженном списке.
  if (current && !state.devices.some((d) => d.id === current)) {
    const option = document.createElement("option");
    option.value = current;
    option.textContent = current;
    select.append(option);
  }
  select.value = current ?? "";
  return select;
}

/** Типы реле: свет над столом и устройства зала управляются одними и теми же. */
const LIGHT_KINDS = [
  ["", "— без реле —"],
  ["tuya", "Tuya / MOES (через облако)"],
  ["tasmota", "Tasmota — Sonoff и др. (в локальной сети)"],
  ["shelly", "Shelly (в локальной сети)"],
  ["url", "Своё устройство — два адреса"],
];

/**
 * Ячейки привязки к реле — общие для стола и устройства зала: тип
 * устройства и поля под него. У облачных Tuya это список устройств и
 * канал, у локальных — адрес в сети, у «своего устройства» — два адреса.
 * save зовётся при каждом изменении; payload() — то, что шлём серверу.
 */
function buildRelayFields(item, save) {
  const kindCell = document.createElement("td");
  const kindSelect = document.createElement("select");
  for (const [value, label] of LIGHT_KINDS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    kindSelect.append(option);
  }
  // Старые базы: тип не записан, но устройство Tuya привязано.
  kindSelect.value = item.light_kind ?? (item.tuya_device_id ? "tuya" : "");
  kindCell.append(kindSelect);

  // Поля настройки — своя ячейка, содержимое зависит от типа.
  const settingsCell = document.createElement("td");
  settingsCell.className = "binding-fields";

  const deviceSelect = buildDeviceSelect(item.tuya_device_id);
  const switchSelect = document.createElement("select");
  for (const code of SWITCH_CODES) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = code.replace("switch_", "Канал ");
    switchSelect.append(option);
  }
  switchSelect.value = item.tuya_switch_code ?? "switch_1";

  const hostInput = document.createElement("input");
  hostInput.type = "text";
  hostInput.placeholder = "192.168.1.50";
  hostInput.value = item.light_host ?? "";
  hostInput.size = 16;

  const channelInput = document.createElement("input");
  channelInput.type = "number";
  channelInput.min = "0";
  channelInput.max = "7";
  channelInput.title = "Номер канала на модуле (0 — первый)";
  channelInput.value = String(item.light_channel ?? 0);
  channelInput.size = 3;

  const onInput = document.createElement("input");
  onInput.type = "text";
  onInput.placeholder = "http://…/on";
  onInput.value = item.light_on_url ?? "";
  const offInput = document.createElement("input");
  offInput.type = "text";
  offInput.placeholder = "http://…/off";
  offInput.value = item.light_off_url ?? "";

  const wrap = (label, node) => {
    const box = document.createElement("label");
    box.className = "binding-field";
    box.append(label, node);
    return box;
  };
  const tuyaFields = document.createElement("span");
  tuyaFields.append(wrap("Устройство", deviceSelect), wrap("Канал", switchSelect));
  const localFields = document.createElement("span");
  localFields.append(wrap("Адрес в сети", hostInput), wrap("Канал", channelInput));
  const urlFields = document.createElement("span");
  urlFields.append(wrap("Включить", onInput), wrap("Выключить", offInput));
  settingsCell.append(tuyaFields, localFields, urlFields);

  const applyKind = () => {
    const kind = kindSelect.value;
    tuyaFields.hidden = kind !== "tuya";
    localFields.hidden = kind !== "tasmota" && kind !== "shelly";
    urlFields.hidden = kind !== "url";
  };
  applyKind();

  kindSelect.addEventListener("change", () => {
    applyKind();
    // Пустой тип сохраняем сразу — это «отвязать»; остальное после
    // заполнения полей, иначе сервер справедливо отругает за пустой адрес.
    if (!kindSelect.value) save();
  });
  for (const field of [deviceSelect, switchSelect, hostInput, channelInput, onInput, offInput]) {
    field.addEventListener("change", save);
  }

  const payload = () => ({
    kind: kindSelect.value || null,
    device_id: deviceSelect.value || null,
    switch_code: switchSelect.value,
    host: hostInput.value,
    channel: Number(channelInput.value),
    on_url: onInput.value,
    off_url: offInput.value,
  });
  return { kindCell, settingsCell, payload };
}

/** Кнопка «Тест»: щёлкнуть реле на две секунды. powerUrl принимает {on}. */
function buildTestButton(powerUrl) {
  const testBtn = document.createElement("button");
  testBtn.className = "mini";
  testBtn.textContent = "Тест";
  testBtn.title = "Включить на 2 секунды";
  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    try {
      await api(powerUrl, { method: "POST", body: JSON.stringify({ on: true }) });
      setTimeout(async () => {
        try {
          await api(powerUrl, { method: "POST", body: JSON.stringify({ on: false }) });
        } finally {
          testBtn.disabled = false;
        }
      }, 2000);
    } catch (error) {
      showToast(error.message);
      testBtn.disabled = false;
    }
  });
  return testBtn;
}

/** Строка привязки стола к реле. */
function buildBindingRow(table) {
  const tr = document.createElement("tr");
  const nameCell = document.createElement("td");
  nameCell.textContent = table.name;

  const save = async () => {
    try {
      await api(`/api/tables/${table.id}/device`, {
        method: "PUT",
        body: JSON.stringify(relay.payload()),
      });
      showToast(`${table.name}: привязка сохранена`, true);
    } catch (error) {
      showToast(error.message);
    }
  };
  const relay = buildRelayFields(table, save);

  const testCell = document.createElement("td");
  testCell.append(buildTestButton(`/api/tables/${table.id}/light`));

  tr.append(nameCell, relay.kindCell, relay.settingsCell, testCell);
  return tr;
}

/**
 * Строка устройства зала (кондиционер, вытяжка, приток): название, цикл
 * «работает/стоит» в минутах и та же привязка к реле, что у столов.
 * Сохраняется при любом изменении — сервер получает всю строку целиком.
 */
function buildDeviceRow(device) {
  const tr = document.createElement("tr");
  const numberInput = (value, min) => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    input.max = "1440";
    input.step = "1";
    input.value = String(value);
    input.size = 4;
    return input;
  };
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.maxLength = 100;
  nameInput.value = device.name;
  nameInput.size = 14;
  const workInput = numberInput(device.work_minutes, 1);
  const restInput = numberInput(device.rest_minutes, 0);

  const typeSelect = document.createElement("select");
  typeSelect.className = "device-type";
  for (const [value, meta] of Object.entries(DEVICE_TYPES)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = meta.label;
    typeSelect.append(option);
  }
  typeSelect.value = device.type in DEVICE_TYPES ? device.type : "exhaust";

  const positionsInput = document.createElement("input");
  positionsInput.type = "text";
  positionsInput.placeholder = "30,50,70";
  positionsInput.title = "Положения решётки в процентах через запятую; одно положение — заслонка открыто/закрыто";
  positionsInput.value = device.positions.join(",");
  positionsInput.size = 10;

  // Вытяжке — цикл, решётке — положения: в одной ячейке, по виду.
  const cycleFields = document.createElement("span");
  cycleFields.className = "cycle-fields";
  cycleFields.append(workInput, "/", restInput);
  const applyType = () => {
    const damper = typeSelect.value === "damper";
    cycleFields.hidden = damper;
    positionsInput.hidden = !damper;
  };
  applyType();

  const save = async () => {
    try {
      await api(`/api/devices/${device.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: nameInput.value.trim(),
          type: typeSelect.value,
          positions: positionsInput.value,
          work_minutes: Number(workInput.value),
          rest_minutes: Number(restInput.value),
          ...relay.payload(),
        }),
      });
      showToast(`${nameInput.value.trim()}: сохранено`, true);
    } catch (error) {
      showToast(error.message);
    }
  };
  const relay = buildRelayFields(device, save);
  typeSelect.addEventListener("change", () => {
    applyType();
    save();
  });
  for (const field of [nameInput, workInput, restInput, positionsInput]) {
    field.addEventListener("change", save);
  }

  const actionsCell = document.createElement("td");
  const del = document.createElement("button");
  del.className = "mini danger";
  del.textContent = "Удалить";
  del.addEventListener("click", async () => {
    if (!confirm(`Удалить устройство «${device.name}»?`)) return;
    try {
      await api(`/api/devices/${device.id}`, { method: "DELETE" });
      showToast("Устройство удалено", true);
      renderDeviceRows(await api("/api/devices"));
    } catch (error) {
      showToast(error.message);
    }
  });
  actionsCell.append(buildTestButton(`/api/devices/${device.id}/power`), " ", del);

  const cell = (node) => {
    const td = document.createElement("td");
    td.append(node);
    return td;
  };
  const cycleCell = document.createElement("td");
  cycleCell.append(cycleFields, positionsInput);
  tr.append(
    cell(nameInput),
    cell(typeSelect),
    cycleCell,
    relay.kindCell,
    relay.settingsCell,
    actionsCell
  );
  return tr;
}

function renderDeviceRows(devices) {
  const rows = document.getElementById("device-rows");
  rows.replaceChildren();
  for (const device of devices) rows.append(buildDeviceRow(device));
}

function renderBindings(tables) {
  const rows = document.getElementById("binding-rows");
  rows.replaceChildren();
  for (const table of tables) rows.append(buildBindingRow(table));
}

function showDriverStatus(settings) {
  const status = document.getElementById("settings-status");
  status.replaceChildren();
  if (settings.driver_error) {
    status.append(...withIcon("warning", `${settings.driver_error} — работает Mock`));
  } else if (settings.driver_active === "tuya") {
    status.append(...withIcon("check", "Подключено к Tuya"));
  } else {
    status.textContent = "Свет сейчас не управляется (Mock)";
  }
}

function fillCurrencyFields(currency) {
  const select = document.getElementById("set-currency-select");
  const custom = document.getElementById("set-currency-custom");
  const preset = [...select.options].some((opt) => opt.value === currency);
  if (preset) {
    select.value = currency;
    custom.hidden = true;
    custom.value = "";
  } else {
    select.value = "__custom__";
    custom.hidden = false;
    custom.value = currency;
  }
}

function currentCurrencyValue() {
  const select = document.getElementById("set-currency-select");
  if (select.value === "__custom__") {
    return document.getElementById("set-currency-custom").value.trim();
  }
  return select.value;
}

async function refreshSettings() {
  const [settings, tables, devices] = await Promise.all([
    api("/api/settings"),
    api("/api/tables"),
    api("/api/devices"),
  ]);
  document.getElementById("set-driver").value = settings.lighting_driver;
  document.getElementById("set-host").value = settings.tuya_api_host;
  document.getElementById("set-access-id").value = settings.tuya_access_id;
  document.getElementById("set-access-secret").value = settings.tuya_access_secret;
  document.getElementById("set-club-name").value = settings.club_name;
  fillCurrencyFields(settings.currency);
  document.getElementById("set-rounding").value = settings.rounding_step_kopecks;
  document.getElementById("set-min-minutes").value = settings.min_session_minutes;
  document.getElementById("set-receipt-width").value = settings.receipt_width;
  document.getElementById("set-warn-minutes").value = settings.warn_before_minutes;
  document.getElementById("set-warn-sound").value = settings.warn_sound;
  document.getElementById("set-tz").value = settings.tz_offset_minutes;
  showDriverStatus(settings);
  renderLogoPreview(settings.club_logo);
  setupLogoScale(settings.club_logo_height);
  renderBindings(tables);
  renderDeviceRows(devices);
  document.getElementById("board-url").textContent = `${location.origin}/board`;
  document.getElementById("set-tg-token").value = settings.telegram_bot_token;
  document.getElementById("set-tg-chat").value = settings.telegram_chat_id;
  document.getElementById("set-tg-before").value = settings.telegram_before_minutes;
  await renderTelegramStatus().catch(() => {});
  document.getElementById("set-sub-url").value = settings.wespro_hub_url;
  document.getElementById("set-sub-key").value = settings.wespro_club_key;
  renderSubscriptionStatus(settings.wespro_club_key);
  await renderDemoStatus().catch(() => {});
  await renderNetworkList().catch(() => {}); // сеть — справка, без неё можно
  await renderDiagnostics().catch(() => {}); // диагностика тоже необязательна
}

// --- Диагностика ---------------------------------------------------------

const BYTES_IN_MB = 1024 * 1024;

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "нет файла";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < BYTES_IN_MB) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / BYTES_IN_MB).toFixed(1)} МБ`;
}

/**
 * Состояние программы и базы + последние внутренние ошибки. Нужна, чтобы
 * причину «внутренней ошибки сервера» было видно без залезания в консоль.
 */
async function renderDiagnostics() {
  const info = await api("/api/diagnostics");
  const summary = document.getElementById("diag-summary");
  const infoBox = document.getElementById("diag-info");
  const errorsBox = document.getElementById("diag-errors");

  const db = info.database;
  const troubles = [];
  if (db.integrity !== "ok") troubles.push(`база повреждена: ${db.integrity}`);
  if (!db.folder_writable) troubles.push("нет прав на запись в папку с базой");
  if (db.in_cloud_folder) {
    troubles.push("папка в облачной синхронизации — база может блокироваться");
  }
  if (info.errors.length) troubles.push(`ошибок в журнале: ${info.errors.length}`);

  summary.replaceChildren(
    ...(troubles.length
      ? withIcon("warning", troubles.join("; "))
      : withIcon("check", "Проблем не найдено"))
  );

  if (info.restart_required) troubles.unshift("сервер работает на старом коде — перезапустите");

  const rows = [
    ["Версия программы", info.version],
    [
      "Код на диске",
      info.restart_required
        ? `новее запущенного сервера (${formatDateTime(info.code_changed_at)}) — ПЕРЕЗАПУСТИТЕ СЕРВЕР`
        : "совпадает с запущенным сервером",
    ],
    ["Node.js", info.node],
    ["Система", info.platform],
    ["Сервер запущен", formatDateTime(info.started_at)],
    ["Работает без перезапуска", formatDuration(info.uptime_seconds)],
    ["Файл базы", db.path],
    ["Размер базы", `${formatBytes(db.size_bytes)} (журнал WAL: ${formatBytes(db.wal_size_bytes)})`],
    ["Проверка целостности базы", db.integrity],
    ["Запись в папку базы", db.folder_writable ? "разрешена" : "ЗАПРЕЩЕНА"],
    [
      "Версия схемы базы",
      db.schema_version === db.schema_version_expected
        ? `${db.schema_version} (совпадает с программой)`
        : `${db.schema_version} — программа рассчитана на ${db.schema_version_expected}`,
    ],
  ];
  // Автоматические копии: страховка от «полетел компьютер».
  if (info.backups) {
    const last = info.backups.files[0];
    rows.push(
      ["Папка автокопий", info.backups.folder],
      [
        "Последняя копия",
        last
          ? `${last.name} (${formatBytes(last.size_bytes)}, ${formatDateTime(last.created_at)})`
          : "ещё не сделана",
      ],
      [
        "Копий сохранено",
        `${info.backups.files.length}, хранится последних ${info.backups.keep}`,
      ]
    );
  }
  infoBox.replaceChildren();
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "diag-row";
    const name = document.createElement("span");
    name.className = "diag-label";
    name.textContent = label;
    const val = document.createElement("span");
    val.className = "diag-value";
    val.textContent = String(value);
    row.append(name, val);
    infoBox.append(row);
  }

  errorsBox.replaceChildren();
  const title = document.createElement("h4");
  title.className = "diag-title";
  title.textContent = info.errors.length
    ? `Последние ошибки (${info.errors.length})`
    : "Ошибок не было";
  errorsBox.append(title);
  for (const entry of info.errors) {
    const pre = document.createElement("pre");
    pre.className = "diag-error";
    pre.textContent = entry;
    errorsBox.append(pre);
  }
}

// --- Поддержка и обслуживание (для разработчика) -------------------------

/** Общая рамка для результата: заголовок + содержимое. */
function supportBox(title) {
  const box = document.getElementById("support-result");
  box.replaceChildren();
  const head = document.createElement("h4");
  head.className = "diag-title";
  head.textContent = title;
  box.append(head);
  return box;
}

/**
 * Доктор данных: показывает найденные нестыковки и предлагает починить
 * те, которые можно исправить без человека.
 */
async function runCheckup() {
  const box = supportBox("Проверка данных");
  let report;
  try {
    report = await api("/api/support/checkup");
  } catch (error) {
    showToast(error.message);
    return;
  }
  if (report.healthy) {
    box.append(
      ...withIcon("check", `Нестыковок не найдено (проверок: ${report.checks_total})`)
    );
    return;
  }

  const summary = document.createElement("p");
  summary.className = "hint";
  summary.textContent =
    `Найдено проблем: ${report.issues.length} из ${report.checks_total} проверок. ` +
    "То, что помечено «решает человек», программа не трогает.";
  box.append(summary);

  for (const issue of report.issues) {
    const row = document.createElement("div");
    row.className = "support-issue";

    const title = document.createElement("div");
    title.className = "support-issue-title";
    title.textContent = `${issue.title} — ${issue.count}`;
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = issue.hint;
    const detail = document.createElement("div");
    detail.className = "support-issue-detail";
    detail.textContent = issue.detail;
    row.append(title, hint, detail);

    if (issue.fixable) {
      const fix = document.createElement("button");
      fix.className = "mini";
      fix.textContent = "Починить";
      fix.addEventListener("click", async () => {
        fix.disabled = true;
        try {
          const result = await api("/api/support/fix", {
            method: "POST",
            body: JSON.stringify({ code: issue.code }),
          });
          showToast(`Исправлено записей: ${result.total}`, true);
          await runCheckup();
          await refreshDashboard().catch(() => {});
        } catch (error) {
          showToast(error.message);
          fix.disabled = false;
        }
      });
      row.append(fix);
    } else {
      const mark = document.createElement("div");
      mark.className = "support-manual";
      mark.textContent = "решает человек";
      row.append(mark);
    }
    box.append(row);
  }

  const fixAll = document.createElement("button");
  fixAll.className = "primary";
  fixAll.textContent = "Починить всё, что можно";
  fixAll.addEventListener("click", async () => {
    fixAll.disabled = true;
    try {
      const result = await api("/api/support/fix", { method: "POST", body: "{}" });
      showToast(
        result.total ? `Исправлено записей: ${result.total}` : "Нечего чинить",
        true
      );
      await runCheckup();
      await refreshDashboard().catch(() => {});
    } catch (error) {
      showToast(error.message);
      fixAll.disabled = false;
    }
  });
  box.append(fixAll);
}

/** Журнал запросов: что нажимали и чем это кончилось. */
async function showRequestLog() {
  const box = supportBox("Последние запросы");
  let data;
  try {
    data = await api("/api/support/requests");
  } catch (error) {
    showToast(error.message);
    return;
  }
  if (!data.requests.length) {
    box.append(
      ...withIcon("check", "Журнал пуст — с запуска сервера запросов не было")
    );
    return;
  }

  const table = document.createElement("table");
  table.className = "data-table";
  const head = document.createElement("thead");
  head.innerHTML =
    "<tr><th>Время</th><th>Запрос</th><th>Ответ</th><th>мс</th><th>Сотрудник</th></tr>";
  const body = document.createElement("tbody");
  for (const item of data.requests) {
    const tr = document.createElement("tr");
    if (item.status >= 400) tr.classList.add("row-off");
    for (const text of [
      formatDateTime(item.at),
      `${item.method} ${item.path}`,
      String(item.status),
      String(item.ms),
      item.user ?? "—",
    ]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);

  const scroll = document.createElement("div");
  scroll.className = "table-scroll support-log";
  scroll.append(table);
  box.append(scroll);

  const clear = document.createElement("button");
  clear.className = "mini";
  clear.textContent = "Очистить журнал";
  clear.addEventListener("click", async () => {
    try {
      await api("/api/support/requests", { method: "DELETE" });
      await showRequestLog();
    } catch (error) {
      showToast(error.message);
    }
  });
  box.append(clear);
}

/**
 * Загрузка настройки клуба из файла. История не затрагивается — в отличие
 * от загрузки копии базы, поэтому и подтверждение мягче.
 */
async function importClubConfig(event) {
  const file = event.target.files?.[0];
  event.target.value = ""; // чтобы можно было выбрать тот же файл снова
  if (!file) return;

  const status = document.getElementById("config-status");
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showToast("Это не файл настройки — он должен быть в формате .json");
    return;
  }

  const confirmed = await confirmModal(
    "Загрузка настройки",
    `Файл: ${file.name}` +
      (data.club_name ? ` (клуб «${data.club_name}»)` : "") +
      ". Тарифы, расписания и акции заменятся целиком, столы и меню " +
      "добавятся к имеющимся. История, клиенты и сотрудники не тронутся.",
    "Загрузить"
  );
  if (!confirmed) return;

  try {
    const result = await api("/api/config/import", {
      method: "POST",
      body: JSON.stringify(data),
    });
    status.replaceChildren(
      ...withIcon(
        "check",
        `Загружено: тарифов ${result.tariffs}, акций ${result.promotions}, ` +
          `столов ${result.tables}, правил ${result.tariff_rules}`
      )
    );
    showToast("Настройка загружена — обновите страницу (F5)", true);
  } catch (error) {
    showToast(error.message);
  }
}

/** Выполняет запрос на чтение и показывает таблицу результата. */
async function runSqlQuery() {
  const sql = document.getElementById("sql-text").value.trim();
  if (!sql) {
    showToast("Напишите запрос");
    return;
  }
  let result;
  try {
    result = await api("/api/support/query", {
      method: "POST",
      body: JSON.stringify({ sql }),
    });
  } catch (error) {
    showToast(error.message);
    return;
  }

  const box = supportBox(
    `Результат: строк ${result.row_count}` +
      (result.truncated ? ` (показаны первые ${result.rows.length})` : "") +
      `, ${result.ms} мс`
  );
  if (!result.rows.length) {
    box.append(...withIcon("check", "Запрос выполнен, строк нет"));
    return;
  }

  const table = document.createElement("table");
  table.className = "data-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of result.columns) {
    const th = document.createElement("th");
    th.textContent = column;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const row of result.rows) {
    const tr = document.createElement("tr");
    for (const column of result.columns) {
      const td = document.createElement("td");
      td.textContent = row[column] === null ? "—" : String(row[column]);
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);

  const scroll = document.createElement("div");
  scroll.className = "table-scroll support-log";
  scroll.append(table);
  box.append(scroll);
}

/** Подсказка: какие есть таблицы и колонки. */
async function showSchema() {
  let data;
  try {
    data = await api("/api/support/schema");
  } catch (error) {
    showToast(error.message);
    return;
  }
  const box = supportBox(`Таблицы базы (${data.tables.length})`);
  const list = document.createElement("div");
  list.className = "support-log";
  for (const item of data.tables) {
    const row = document.createElement("div");
    row.className = "support-issue-detail";
    row.textContent = `${item.table}: ${item.columns.join(", ")}`;
    list.append(row);
  }
  box.append(list);
}

/** Показывает, есть ли сейчас демо-данные в базе. */
async function renderDemoStatus() {
  const box = document.getElementById("demo-status");
  if (!box) return;
  try {
    const status = await api("/api/demo");
    box.replaceChildren(
      ...(status.present
        ? withIcon("warning", `В базе есть демо-данные: столов ${status.tables}, клиентов ${status.clients}`)
        : withIcon("check", "Демо-данных в базе нет"))
    );
  } catch {
    box.textContent = "";
  }
}

/** Наполняет базу показательными данными за месяц. */
async function fillDemo() {
  const confirmed = await confirmModal(
    "Демо-данные",
    "В базу добавятся показательные столы, клиенты и история за 30 дней — " +
      "чтобы отчёты и графики было на чём показать. Все они помечены " +
      "словом «Демо» и стираются одной кнопкой. Рабочие данные не тронутся.",
    "Наполнить"
  );
  if (!confirmed) return;
  try {
    const result = await api("/api/demo", {
      method: "POST",
      body: JSON.stringify({ days: 30 }),
    });
    showToast(
      `Добавлено: столов ${result.tables}, клиентов ${result.clients}, ` +
        `сеансов ${result.sessions}`,
      true
    );
    await renderDemoStatus();
    await refreshDashboard().catch(() => {});
  } catch (error) {
    showToast(error.message);
  }
}

/** Стирает демо-данные, не трогая рабочие. */
async function clearDemo() {
  const confirmed = await confirmModal(
    "Стереть демо-данные",
    "Удалятся только записи с пометкой «Демо»: столы, клиенты, их сеансы " +
      "и смены. Настоящие данные клуба останутся на месте.",
    "Стереть"
  );
  if (!confirmed) return;
  try {
    const result = await api("/api/demo", { method: "DELETE" });
    showToast(
      `Стёрто: сеансов ${result.sessions}, столов ${result.tables}, ` +
        `клиентов ${result.clients}`,
      true
    );
    await renderDemoStatus();
    await refreshDashboard().catch(() => {});
  } catch (error) {
    showToast(error.message);
  }
}

/**
 * Перезапуск программы. Нужен после обновления файлов: страница уже
 * новая, а сервер работает на старом коде.
 */
async function restartServer() {
  const confirmed = await confirmModal(
    "Перезапуск программы",
    "Программа остановится и запустится заново — это 5–10 секунд. " +
      "Открытые сеансы и данные не пострадают: всё уже в базе. " +
      "Кассирам в эти секунды страница ответит ошибкой.",
    "Перезапустить"
  );
  if (!confirmed) return;
  try {
    await api("/api/system/restart", { method: "POST" });
  } catch {
    // Сервер закрывает соединение на полуслове — это нормально.
  }
  const box = supportBox("Перезапуск");
  const line = document.createElement("p");
  line.className = "hint";
  line.textContent = "Программа перезапускается… Страница обновится сама.";
  box.append(line);
  // Ждём, пока сервер снова начнёт отвечать, и перезагружаем страницу.
  let tries = 0;
  const wait = setInterval(async () => {
    tries += 1;
    try {
      const res = await fetch("/api/brand", { cache: "no-store" });
      if (res.ok) {
        clearInterval(wait);
        location.reload();
      }
    } catch {
      // ещё не поднялся
    }
    if (tries > 30) {
      clearInterval(wait);
      line.textContent =
        "Сервер не поднялся сам — запустите start-club.bat на компьютере клуба.";
    }
  }, 1000);
}

// --- Напоминания о бронях в Telegram -------------------------------------

/** Честная строка состояния: настроено или выключено. */
async function renderTelegramStatus() {
  const box = document.getElementById("tg-status");
  const status = await api("/api/telegram/status");
  box.replaceChildren(
    ...(status.configured
      ? withIcon("check", `Включено: напомним за ${status.before_minutes} мин до брони`)
      : withIcon("warning", "Выключено: не заданы токен бота и номер чата"))
  );
}

async function saveTelegramSettings() {
  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        telegram_bot_token: document.getElementById("set-tg-token").value.trim(),
        telegram_chat_id: document.getElementById("set-tg-chat").value.trim(),
        telegram_before_minutes: document.getElementById("set-tg-before").value,
      }),
    });
    showToast("Настройки Telegram сохранены", true);
    await renderTelegramStatus();
  } catch (error) {
    showToast(error.message);
  }
}

async function testTelegram() {
  try {
    await api("/api/telegram/test", { method: "POST" });
    showToast("Проверочное сообщение отправлено — посмотрите в чат", true);
  } catch (error) {
    showToast(error.message);
  }
}

// --- Подписка: связь с центральной панелью сети WesPro --------------------

const SUBSCRIPTION_STATUS_LABELS = {
  trial: "пробный период",
  active: "активна",
  overdue: "просрочена",
  blocked: "заблокирован",
  archived: "в архиве",
};

/** Честная строка «настроено / нет» — без похода в сеть (как у Telegram). */
function renderSubscriptionStatus(clubKey) {
  const box = document.getElementById("sub-status");
  if (!box) return;
  box.replaceChildren(
    ...(clubKey?.trim()
      ? withIcon("check", "Ключ сохранён — нажмите «Проверить подписку»")
      : withIcon("warning", "Ключ ещё не введён — подписка не проверяется"))
  );
}

async function saveSubscriptionSettings() {
  try {
    const settings = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        wespro_hub_url: document.getElementById("set-sub-url").value.trim(),
        wespro_club_key: document.getElementById("set-sub-key").value.trim(),
      }),
    });
    showToast("Настройки подписки сохранены", true);
    renderSubscriptionStatus(settings.wespro_club_key);
  } catch (error) {
    showToast(error.message);
  }
}

async function testSubscription() {
  const box = document.getElementById("sub-status");
  try {
    const status = await api("/api/subscription/check", { method: "POST" });
    if (!status.connected) {
      box.replaceChildren(...withIcon("warning", status.error ?? "Не удалось связаться с хабом"));
      return;
    }
    const label = SUBSCRIPTION_STATUS_LABELS[status.status] ?? status.status;
    const parts = [`Подписка: ${label}`];
    if (status.plan_name) parts.push(`тариф «${status.plan_name}»`);
    if (typeof status.days_left === "number") {
      parts.push(status.days_left >= 0 ? `осталось ${status.days_left} дн.` : "срок истёк");
    }
    box.replaceChildren(...withIcon(status.blocked ? "warning" : "check", parts.join(", ")));
  } catch (error) {
    box.replaceChildren(...withIcon("warning", error.message));
  }
}

// --- Доступ по сети ------------------------------------------------------

/**
 * Адреса, по которым клуб открывается с других устройств. Сервер слушает
 * все интерфейсы, поэтому работает любой из них — важно лишь, чтобы
 * устройство было в той же подсети.
 */
async function renderNetworkList() {
  const box = document.getElementById("network-list");
  const info = await api("/api/network");
  box.replaceChildren();

  if (!info.addresses.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent =
      "Адрес в локальной сети не найден: компьютер не подключён к Wi-Fi или кабелю.";
    box.append(empty);
    return;
  }

  for (const item of info.addresses) {
    const row = document.createElement("div");
    row.className = "network-row" + (item.virtual ? " network-row-virtual" : "");

    const link = document.createElement("a");
    link.className = "network-url";
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = item.url;

    const note = document.createElement("span");
    note.className = "network-note";
    note.textContent = item.virtual
      ? `${item.iface} — виртуальная сеть программы, с телефона не откроется`
      : item.iface;

    const copyBtn = document.createElement("button");
    copyBtn.className = "mini";
    copyBtn.textContent = "Скопировать";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.url);
        showToast("Адрес скопирован", true);
      } catch {
        showToast(`Скопируйте вручную: ${item.url}`);
      }
    });

    row.append(link, note, copyBtn);
    box.append(row);
  }

  const host = document.createElement("p");
  host.className = "hint";
  host.textContent = `Имя компьютера: ${info.hostname}, порт: ${info.port}.`;
  box.append(host);
}

// --- Логотип клуба -------------------------------------------------------

/** Превью логотипа в настройках (пусто — подпись «не задан»). */
/**
 * Ползунок масштаба логотипа. Пока тянут — логотип в шапке меняется
 * сразу, чтобы было видно результат; в базу пишется по кнопке.
 */
function setupLogoScale(currentHeight) {
  const range = document.getElementById("logo-height");
  const value = document.getElementById("logo-height-value");
  const saveBtn = document.getElementById("logo-height-save");
  const logo = document.getElementById("club-logo");
  const preview = document.getElementById("logo-preview");

  const apply = (height) => {
    value.textContent = `${height} px`;
    logo.style.height = `${height}px`;
    logo.style.maxHeight = `${height}px`;
    preview.style.height = `${height}px`;
    preview.style.maxHeight = `${height}px`;
  };

  range.value = String(Number(currentHeight) || 28);
  apply(range.value);
  range.oninput = () => apply(range.value);
  saveBtn.onclick = async () => {
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ club_logo_height: range.value }),
      });
      showToast("Масштаб логотипа сохранён", true);
    } catch (error) {
      showToast(error.message);
    }
  };
}

function renderLogoPreview(dataUri) {
  const img = document.getElementById("logo-preview");
  const empty = document.getElementById("logo-empty");
  if (dataUri) {
    img.src = dataUri;
    img.hidden = false;
    empty.hidden = true;
  } else {
    img.removeAttribute("src");
    img.hidden = true;
    empty.hidden = false;
  }
}

// Ограничение на файл логотипа — сервер проверяет то же самое, здесь просто
// понятная ошибка до отправки. 1 МБ файла ≈ 1.37 МБ в base64.
const LOGO_MAX_BYTES = 1024 * 1024;

/** Сохраняет логотип (data-URI) или убирает его (пустая строка). */
async function saveLogo(dataUri) {
  const settings = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ club_logo: dataUri }),
  });
  renderLogoPreview(settings.club_logo);
  applyBrand({
    club_name: settings.club_name,
    club_logo: settings.club_logo,
    club_logo_height: settings.club_logo_height,
  });
  showToast(dataUri ? "Логотип сохранён" : "Логотип убран", true);
}

async function onLogoFilePicked(event) {
  const file = event.target.files?.[0];
  event.target.value = ""; // чтобы можно было выбрать тот же файл повторно
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showToast("Логотип: нужен файл картинки (PNG, JPG, WebP, SVG)");
    return;
  }
  if (file.size > LOGO_MAX_BYTES) {
    showToast("Логотип: файл больше 1 МБ — возьмите картинку поменьше");
    return;
  }
  try {
    const dataUri = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
      reader.readAsDataURL(file);
    });
    await saveLogo(dataUri);
  } catch (error) {
    showToast(error.message);
  }
}

// --- Загрузка базы из копии ---------------------------------------------

let importFile = null;

function onImportFilePicked(event) {
  importFile = event.target.files?.[0] ?? null;
  document.getElementById("import-name").textContent = importFile
    ? `${importFile.name} · ${(importFile.size / 1024 / 1024).toFixed(1)} МБ`
    : "";
  document.getElementById("import-db").disabled = !importFile;
  document.getElementById("import-status").replaceChildren();
}

async function importDatabase() {
  if (!importFile) return;
  const confirmed = await confirmModal(
    "Загрузка базы из копии",
    `Данные из файла «${importFile.name}» заменят все текущие: столы, тарифы, ` +
      "историю, клиентов, сотрудников и настройки. Отменить это будет нельзя — " +
      "перед загрузкой лучше сделать «Экспорт базы». Продолжить?",
    "Загрузить и заменить"
  );
  if (!confirmed) return;

  const status = document.getElementById("import-status");
  const button = document.getElementById("import-db");
  button.disabled = true;
  status.replaceChildren(...withIcon("clock", "Загружаю…"));
  try {
    const response = await fetch("/api/backup/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: importFile,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail ?? `Ошибка загрузки (${response.status})`);
    }
    status.replaceChildren(
      ...withIcon("check", "База загружена — сейчас откроется вход")
    );
    showToast("База восстановлена из копии — войдите заново", true);
    setTimeout(() => {
      window.location.href = "/login";
    }, 1500);
  } catch (error) {
    status.replaceChildren(...withIcon("warning", error.message));
    showToast(error.message);
    button.disabled = false;
  }
}

/** Матрица прав ролей: владелец/разработчик настраивают, что кому можно. */
async function refreshPermissionsMatrix() {
  const wrap = document.getElementById("permissions-matrix");
  const { permissions, roles, matrix } = await api("/api/permissions");
  const table = document.createElement("table");
  table.className = "data-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(document.createElement("th"));
  for (const role of roles) {
    const th = document.createElement("th");
    th.textContent = ROLE_LABELS[role] ?? role;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const perm of permissions) {
    const tr = document.createElement("tr");
    const label = document.createElement("td");
    label.textContent = perm.label;
    tr.append(label);
    for (const role of roles) {
      const td = document.createElement("td");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = Boolean(matrix[role][perm.key]);
      box.addEventListener("change", async () => {
        try {
          await api("/api/permissions", {
            method: "PUT",
            body: JSON.stringify({
              entries: [{ role, permission: perm.key, allowed: box.checked }],
            }),
          });
          showToast("Права сохранены", true);
        } catch (error) {
          box.checked = !box.checked;
          showToast(error.message);
        }
      });
      td.append(box);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.replaceChildren(table);
}

async function saveClubSettings() {
  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        club_name: document.getElementById("set-club-name").value.trim(),
        currency: currentCurrencyValue(),
        rounding_step_kopecks: document.getElementById("set-rounding").value,
        min_session_minutes: document.getElementById("set-min-minutes").value,
        receipt_width: document.getElementById("set-receipt-width").value,
        warn_before_minutes: document.getElementById("set-warn-minutes").value,
        warn_sound: document.getElementById("set-warn-sound").value,
        tz_offset_minutes: document.getElementById("set-tz").value,
      }),
    });
    state.receiptWidth = document.getElementById("set-receipt-width").value;
    state.warnBeforeMinutes = Number(
      document.getElementById("set-warn-minutes").value
    );
    state.warnSound = document.getElementById("set-warn-sound").value === "1";
    document.getElementById("club-title").textContent =
      document.getElementById("set-club-name").value.trim();
    document.title = document.getElementById("set-club-name").value.trim();
    const newCurrency = currentCurrencyValue();
    if (newCurrency && newCurrency !== state.currency) {
      showToast("Валюта сохранена — обновите страницу (F5), чтобы она применилась везде", true);
    } else {
      showToast("Настройки клуба сохранены", true);
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function saveConnectionSettings() {
  const payload = {
    lighting_driver: document.getElementById("set-driver").value,
    tuya_api_host: document.getElementById("set-host").value,
    tuya_access_id: document.getElementById("set-access-id").value.trim(),
    tuya_access_secret: document.getElementById("set-access-secret").value.trim(),
  };
  try {
    const settings = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    showDriverStatus(settings);
    showToast(
      settings.driver_active === "tuya"
        ? "Настройки сохранены, Tuya подключена"
        : "Настройки сохранены",
      true
    );
  } catch (error) {
    showToast(error.message);
  }
}

async function loadDevices() {
  const status = document.getElementById("devices-status");
  status.textContent = "Загружаем…";
  try {
    state.devices = await api("/api/settings/devices");
    status.textContent = `Найдено устройств: ${state.devices.length}`;
    renderBindings(await api("/api/tables"));
    renderDeviceRows(await api("/api/devices"));
  } catch (error) {
    status.textContent = "";
    showToast(error.message);
  }
}

// ---------------------------------------------------------------- tabs

/** Строка истории смены — переиспользуется в таблице «История смен». */
function buildShiftRow(shift) {
  const tr = document.createElement("tr");
  const cashBox =
    shift.closing_cash !== null || shift.expected_cash !== null
      ? `${shift.closing_cash !== null ? formatMoney(shift.closing_cash) : "—"} / ` +
        `${shift.expected_cash !== null ? formatMoney(shift.expected_cash) : "—"}`
      : "—";
  const cells = [
    shift.user_name,
    formatDateTime(shift.opened_at),
    shift.closed_at ? formatDateTime(shift.closed_at) : "открыта",
    String(shift.sessions_count),
    formatMoney(shift.revenue),
    `${formatMoney(shift.cash)} / ${formatMoney(shift.card)} / ${formatMoney(shift.transfer)}`,
    `${formatMoney(shift.cash_in ?? 0)} / ${formatMoney(shift.cash_out ?? 0)}`,
    cashBox,
  ];
  for (const text of cells) {
    const td = document.createElement("td");
    td.textContent = text;
    tr.append(td);
  }
  const discrepancyCell = document.createElement("td");
  if (shift.cash_discrepancy === null) {
    discrepancyCell.textContent = "—";
  } else if (shift.cash_discrepancy === 0) {
    discrepancyCell.textContent = "сошлось";
    discrepancyCell.className = "ok-text";
  } else {
    discrepancyCell.textContent = `${money(shift.cash_discrepancy)}`;
    discrepancyCell.className = "bad-text";
  }
  tr.append(discrepancyCell);
  return tr;
}

/** Отдельный мониторинг кассовых смен: кто сейчас на смене + вся история. */
/** Заполняет выпадающий список кассиров теми, у кого вообще были смены. */
function fillShiftUserFilter(allShifts) {
  const select = document.getElementById("shift-filter-user");
  const current = select.value;
  const byId = new Map(allShifts.map((s) => [s.user_id, s.user_name]));
  select.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "Все";
  select.append(allOption);
  for (const [id, name] of [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"))) {
    const option = document.createElement("option");
    option.value = String(id);
    option.textContent = name;
    select.append(option);
  }
  // Сохраняем выбор, если сотрудник всё ещё есть в списке.
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

async function refreshShiftsTab() {
  // Панель «сейчас на смене» — всегда без фильтра: открытую смену со
  // вчерашнего дня фильтр «по дате: сегодня» иначе спрятал бы совсем.
  // Заодно из неё же берём список кассиров для выпадающего фильтра.
  const allShifts = await api("/api/shifts?limit=500");
  fillShiftUserFilter(allShifts);

  const live = allShifts.filter((s) => !s.closed_at);
  const liveWrap = document.getElementById("live-shifts");
  liveWrap.replaceChildren();
  for (const shift of live) {
    const card = document.createElement("div");
    card.className = "live-shift-card";
    const openedAgo = formatDuration((Date.now() - Date.parse(shift.opened_at)) / 1000);
    card.innerHTML = `
      <div class="live-shift-name">${shift.user_name}</div>
      <div class="live-shift-meta">на смене ${openedAgo} · с ${formatDateTime(shift.opened_at)}</div>
      <div class="live-shift-stats">${shift.sessions_count} сеансов · выручка ${money(shift.revenue)}</div>
    `;
    liveWrap.append(card);
  }
  document.getElementById("live-shifts-empty").hidden = live.length > 0;

  // «История смен» — та же выборка, но уже с фильтром по дате и кассиру.
  const params = new URLSearchParams();
  const from = document.getElementById("shift-filter-from").value;
  const to = document.getElementById("shift-filter-to").value;
  const userId = document.getElementById("shift-filter-user").value;
  if (from) params.set("date_from", from);
  if (to) params.set("date_to", to);
  if (userId) params.set("user_id", userId);
  const query = params.toString();
  const shifts = query ? await api(`/api/shifts?${query}`) : allShifts;

  const shiftRows = document.getElementById("shift-rows");
  shiftRows.replaceChildren();
  for (const shift of shifts) shiftRows.append(buildShiftRow(shift));
  document.getElementById("shifts-empty").hidden = shifts.length > 0;
}

const TAB_LOADERS = {
  dashboard: refreshDashboard,
  history: refreshHistory,
  journal: refreshJournal,
  tariffs: refreshTariffs,
  settings: refreshSettings,
  reports: refreshReports,
  shifts: refreshShiftsTab,
  users: refreshUsers,
  clients: refreshClientsTab,
  cashdesk: refreshCashdeskTab,
  devices: refreshDevicesTab,
};

// Вкладки с формами не перезагружаем по таймеру, чтобы не мешать вводу.
const NO_POLL_TABS = new Set(["settings", "users", "clients", "tariffs", "cashdesk"]);

let activeTab = "dashboard";

function switchTab(name) {
  // Из редактора зала не уходим молча: несохранённая расстановка иначе
  // пропадёт незаметно.
  if (state.editMode && name !== activeTab) {
    confirmLeavePlanEditor(() => switchTab(name));
    return;
  }
  activeTab = name;
  for (const button of document.querySelectorAll(".tab")) {
    button.classList.toggle("active", button.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.hidden = panel.id !== `tab-${name}`;
  }
  TAB_LOADERS[name]().catch((error) => showToast(error.message));
}

// ---------------------------------------------------------------- init

document.addEventListener("DOMContentLoaded", async () => {
  // Кто вошёл: настраиваем интерфейс под роль до первой отрисовки.
  try {
    const me = await api("/api/auth/me");
    state.user = me.user;
    state.shift = me.shift;
    state.permissions = me.permissions ?? {};
    state.me = me;
    applyBrand({
      club_name: me.club_name,
      club_logo: me.club_logo,
      club_logo_height: me.club_logo_height,
    });
    // Файлы программы обновили, а сервер работает на старом коде: тогда
    // новая страница просит то, чего старый сервер не знает (404), и
    // натыкается на уже исправленные ошибки (500). Предупреждаем сразу.
    if (me.restart_required) showRestartBanner();
    if (me.currency) state.currency = me.currency;
    if (me.receipt_width) state.receiptWidth = me.receipt_width;
    if (me.warn_before_minutes !== undefined) {
      state.warnBeforeMinutes = Number(me.warn_before_minutes);
      state.warnSound = Boolean(me.warn_sound);
    }
    applyCurrencyToStatic();
  } catch {
    return; // api() уже отправил на /login
  }
  renderUserChip();
  renderShiftBar();
  loadClients().catch(() => {});
  // Кассиру смена нужна для работы — предлагаем открыть её сразу при входе.
  if (state.user.role === "cashier" && !state.shift) {
    toggleShift();
  }
  for (const el of document.querySelectorAll("[data-permission]")) {
    el.hidden = !state.permissions[el.dataset.permission];
  }
  // Матрицу прав, роли «Владелец»/«Разработчик» и загрузку базы видит
  // владелец/разработчик — жёстко, а не через саму матрицу. Признак даёт
  // сервер: на свежей установке, где владельца ещё нет, эти блоки
  // открыты тому, кто управляет сотрудниками, — иначе владельца не
  // создать (роль спрятана) и права не настроить (доступ у владельца).
  // Для <option> одного hidden мало (нативный список select его не
  // всегда прячет), поэтому дублируем через disabled.
  state.ownerLevel = Boolean(state.me?.owner_level);
  const isRealOwner = ["developer", "owner"].includes(state.user.role);
  const applyVisibility = (selector, allowed) => {
    for (const el of document.querySelectorAll(selector)) {
      el.hidden = !allowed;
      if (el.tagName === "OPTION") el.disabled = !allowed;
    }
  };
  applyVisibility("[data-owner-only]", state.ownerLevel);
  applyVisibility("[data-developer-only]", state.user?.role === "developer");
  // Роль «Управляющий» — только для настоящего владельца: на первом
  // запуске администратор создаёт владельца, а не почти-владельца.
  applyVisibility("[data-strict-owner]", isRealOwner);

  // Свежая установка: владельца ещё нет — подсказываем, что делать.
  if (state.me?.owner_setup_pending && state.permissions.manage_users) {
    showOwnerSetupHint();
  }

  document.getElementById("logout-btn").addEventListener("click", handleLogout);
  document.getElementById("shift-toggle").addEventListener("click", toggleShift);
  document
    .getElementById("cash-move-btn")
    .addEventListener("click", openCashMoveModal);
  document.getElementById("x-report").addEventListener("click", () => {
    openXReport().catch((error) => showToast(error.message));
  });
  for (const id of ["shift-filter-from", "shift-filter-to", "shift-filter-user"]) {
    document.getElementById(id).addEventListener("change", () => {
      refreshShiftsTab().catch((error) => showToast(error.message));
    });
  }
  document.getElementById("shift-filter-reset").addEventListener("click", () => {
    document.getElementById("shift-filter-from").value = "";
    document.getElementById("shift-filter-to").value = "";
    document.getElementById("shift-filter-user").value = "";
    refreshShiftsTab().catch((error) => showToast(error.message));
  });
  document.getElementById("add-user-btn").addEventListener("click", addUser);
  // Пароль нового сотрудника: скрыт, с глазком для проверки.
  (() => {
    const input = document.getElementById("new-user-password");
    input.type = "password";
    // Сначала вынимаем поле из разметки (иначе обёртка будет содержать
    // собственного родителя), потом ставим обёртку на его место.
    const holder = document.createComment("password");
    input.replaceWith(holder);
    holder.replaceWith(withPasswordEye(input));
  })();
  document.getElementById("add-client-btn").addEventListener("click", addClient);
  document.getElementById("topup-btn").addEventListener("click", topUpClientAccount);
  document
    .getElementById("topup-client")
    .addEventListener("change", () => refreshTopupClientCard().catch(() => {}));
  // Номера у клиентов почти всегда узбекские — не набирать же код руками
  // каждый раз. Подставляем префикс сразу и возвращаем его, если поле
  // пусто при возврате в него.
  const newClientPhone = document.getElementById("new-client-phone");
  newClientPhone.value = CLIENT_PHONE_PREFIX;
  newClientPhone.addEventListener("focus", () => {
    if (!newClientPhone.value.trim()) newClientPhone.value = CLIENT_PHONE_PREFIX;
  });
  // Контекстное меню столов закрывается по клику и прокрутке.
  document.addEventListener("click", hideContextMenu);
  document.addEventListener("scroll", hideContextMenu, true);
  document.getElementById("select-all").addEventListener("click", toggleSelectAll);
  document.getElementById("selection-chip").addEventListener("click", clearSelection);
  // Тёмная/светлая тема с запоминанием.
  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    const toggle = document.getElementById("theme-toggle");
    toggle.title = theme === "light" ? "Включить тёмную тему" : "Включить светлую тему";
  };
  let theme = "light"; // основная тема — светлая «сталь»
  try {
    theme = localStorage.getItem("billiards_theme") === "dark" ? "dark" : "light";
  } catch {}
  applyTheme(theme);
  document.getElementById("theme-toggle").addEventListener("click", () => {
    theme = theme === "light" ? "dark" : "light";
    applyTheme(theme);
    try {
      localStorage.setItem("billiards_theme", theme);
    } catch {}
  });

  // Боковое меню: сворачивание с запоминанием. На телефоне/планшете, если
  // пользователь ещё не выбирал сам, по умолчанию сворачиваем — там оно
  // занимает слишком много места.
  const sidebar = document.getElementById("sidebar");
  const arrow = document.getElementById("sidebar-arrow");
  const applySidebar = (collapsed) => {
    sidebar.classList.toggle("collapsed", collapsed);
    arrow.textContent = collapsed ? "»" : "«";
    fitPlanToViewport();
  };
  let sidebarCollapsed = window.innerWidth < 860;
  try {
    const stored = localStorage.getItem("billiards_sidebar");
    if (stored) sidebarCollapsed = stored === "collapsed";
  } catch {}
  applySidebar(sidebarCollapsed);
  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    sidebarCollapsed = !sidebarCollapsed;
    applySidebar(sidebarCollapsed);
    try {
      localStorage.setItem(
        "billiards_sidebar",
        sidebarCollapsed ? "collapsed" : "open"
      );
    } catch {}
  });
  // Пересчитываем масштаб плана при любом изменении реальной ширины
  // контейнера (поворот экрана, догрузка шрифтов, ресайз окна) —
  // ResizeObserver ловит это надёжнее, чем гадать по конкретным событиям.
  let fitTimer = null;
  const scheduleFit = () => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitPlanToViewport, 80);
  };
  const planScrollEl = document.querySelector(".plan-scroll");
  if (planScrollEl && "ResizeObserver" in window) {
    new ResizeObserver(scheduleFit).observe(planScrollEl);
  } else {
    window.addEventListener("resize", scheduleFit);
  }

  // Редактор зала (только администратор).
  document.getElementById("plan").addEventListener("mousedown", planDrawStart);
  document.getElementById("edit-plan").addEventListener("click", enterPlanEditor);
  document.getElementById("plan-save").addEventListener("click", savePlanEditor);
  document.getElementById("plan-cancel").addEventListener("click", exitPlanEditor);
  for (const btn of document.querySelectorAll(".pal-tool")) {
    btn.addEventListener("click", () => setEditorTool(btn.dataset.tool));
  }
  for (const id of ["plan-cols", "plan-rows"]) {
    document.getElementById(id).addEventListener("change", () => {
      if (!state.edit) return;
      state.edit.cols = Math.max(10, Math.min(120, Number(document.getElementById("plan-cols").value) || 40));
      state.edit.rows = Math.max(8, Math.min(80, Number(document.getElementById("plan-rows").value) || 25));
      renderMap();
    });
  }
  setDashView();
  document.getElementById("save-club-btn").addEventListener("click", saveClubSettings);
  // Браузер разрешает звук только после действия пользователя — ловим
  // первый же клик по странице и готовим звуковой контекст заранее.
  document.addEventListener("pointerdown", unlockSound, { once: true });
  // Горячие клавиши: Esc, Enter, быстрый поиск, номера столов.
  document.addEventListener("keydown", handleShortcut);
  // Повернули телефон или изменили размер окна — перерисовываем зал.
  PHONE_MEDIA.addEventListener("change", () => {
    if (activeTab === "dashboard") renderTables();
  });
  document.getElementById("help-keys").addEventListener("click", openShortcutsHelp);
  // Логотип клуба: выбор файла сохраняет сразу, кнопка рядом — убирает.
  document.getElementById("logo-file").addEventListener("change", onLogoFilePicked);
  document.getElementById("logo-remove").addEventListener("click", async () => {
    try {
      await saveLogo("");
    } catch (error) {
      showToast(error.message);
    }
  });
  // Загрузка базы из своей копии (владелец/разработчик).
  document.getElementById("diag-refresh").addEventListener("click", () => {
    renderDiagnostics().catch((error) => showToast(error.message));
  });
  document.getElementById("sync-lighting").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const result = await api("/api/lighting/sync", { method: "POST" });
      showToast(
        result.synced
          ? `Свет приведён в порядок: столов — ${result.synced}`
          : "Свет уже в порядке — менять нечего",
        true
      );
      await refreshDashboard();
    } catch (error) {
      showToast(error.message);
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById("support-checkup").addEventListener("click", () => {
    runCheckup().catch((error) => showToast(error.message));
  });
  document.getElementById("support-requests").addEventListener("click", () => {
    showRequestLog().catch((error) => showToast(error.message));
  });
  document.getElementById("support-restart").addEventListener("click", restartServer);
  document.getElementById("config-import").addEventListener("click", () => {
    document.getElementById("config-file").click();
  });
  document.getElementById("config-file").addEventListener("change", importClubConfig);
  document.getElementById("sql-run").addEventListener("click", runSqlQuery);
  document.getElementById("sql-schema").addEventListener("click", showSchema);
  document.getElementById("demo-fill").addEventListener("click", fillDemo);
  document.getElementById("demo-clear").addEventListener("click", clearDemo);
  document.getElementById("save-tg-btn").addEventListener("click", saveTelegramSettings);
  document.getElementById("test-tg-btn").addEventListener("click", testTelegram);
  document.getElementById("save-sub-btn").addEventListener("click", saveSubscriptionSettings);
  document.getElementById("test-sub-btn").addEventListener("click", testSubscription);
  document.getElementById("open-board").addEventListener("click", () => {
    window.open("/board", "_blank", "noopener");
  });
  document.getElementById("backup-now").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const made = await api("/api/backup/now", { method: "POST" });
      showToast(`Копия сделана: ${made.name}`, true);
      await renderDiagnostics();
    } catch (error) {
      showToast(error.message);
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById("import-file").addEventListener("change", onImportFilePicked);
  document.getElementById("import-db").addEventListener("click", importDatabase);
  document.getElementById("set-currency-select").addEventListener("change", (event) => {
    const custom = document.getElementById("set-currency-custom");
    custom.hidden = event.target.value !== "__custom__";
    if (!custom.hidden) custom.focus();
  });
  document.getElementById("add-rule-btn").addEventListener("click", addTariffRule);
  document.getElementById("add-promo-btn").addEventListener("click", addPromotion);
  document.getElementById("save-bonus-btn").addEventListener("click", async () => {
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          bonus_every_hours: document.getElementById("bonus-every").value,
        }),
      });
      showToast("Сохранено", true);
    } catch (error) {
      showToast(error.message);
    }
  });
  let searchTimer = null;
  document.getElementById("client-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refreshClientsTab().catch(() => {}), 300);
  });
  document
    .getElementById("modal-overlay")
    .addEventListener("click", (event) => {
      if (event.target.id === "modal-overlay") closeModal();
    });
  for (const id of ["stats-days", "revenue-days"]) {
    document
      .getElementById(id)
      .addEventListener("change", () => refreshReports().catch(() => {}));
  }

  for (const button of document.querySelectorAll(".tab")) {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  }

  document.getElementById("add-table-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("new-table-name");
    const kindSelect = document.getElementById("new-table-kind");
    try {
      await api("/api/tables", {
        method: "POST",
        body: JSON.stringify({ name: input.value.trim(), kind: kindSelect.value }),
      });
      input.value = "";
      kindSelect.value = "billiard";
      showToast("Стол добавлен — перетащите его на место", true);
      await reloadTablesKeepingEditor();
    } catch (error) {
      showToast(error.message);
    }
  });

  // Опросить реле сейчас, не дожидаясь тика.
  document.getElementById("relays-probe").addEventListener("click", async (event) => {
    const status = document.getElementById("relays-status");
    event.target.disabled = true;
    status.textContent = "Опрашиваем…";
    try {
      const result = await api("/api/relays/probe", { method: "POST" });
      await refreshDevicesTab();
      status.textContent = `Опрошено реле: ${result.probed}`;
    } catch (error) {
      status.textContent = "";
      showToast(error.message);
    } finally {
      event.target.disabled = false;
    }
  });
  // Решётке — положения вместо цикла.
  document.getElementById("new-device-type").addEventListener("change", (e) => {
    const damper = e.target.value === "damper";
    document.getElementById("new-device-positions").hidden = !damper;
    document.getElementById("new-device-work").hidden = damper;
    document.getElementById("new-device-rest").hidden = damper;
  });
  document.getElementById("device-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById("new-device-name");
    try {
      await api("/api/devices", {
        method: "POST",
        body: JSON.stringify({
          name: nameInput.value.trim(),
          type: document.getElementById("new-device-type").value,
          positions: document.getElementById("new-device-positions").value,
          work_minutes: Number(document.getElementById("new-device-work").value),
          rest_minutes: Number(document.getElementById("new-device-rest").value),
        }),
      });
      nameInput.value = "";
      showToast("Устройство добавлено — выберите ему реле", true);
      renderDeviceRows(await api("/api/devices"));
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById("add-tariff-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById("new-tariff-name");
    const priceInput = document.getElementById("new-tariff-price");
    try {
      await api("/api/tariffs", {
        method: "POST",
        body: JSON.stringify({
          name: nameInput.value.trim(),
          price_per_hour: Number(priceInput.value),
        }),
      });
      nameInput.value = "";
      priceInput.value = "";
      showToast("Тариф добавлен", true);
      await refreshTariffs();
    } catch (error) {
      showToast(error.message);
    }
  });

  switchTab("dashboard");

  document
    .getElementById("save-settings")
    .addEventListener("click", saveConnectionSettings);
  document.getElementById("load-devices").addEventListener("click", loadDevices);

  setInterval(tick, TICK_MS);
  setInterval(() => {
    if (NO_POLL_TABS.has(activeTab)) return;
    TAB_LOADERS[activeTab]().catch(() => { /* сеть мигнула — следующий опрос */ });
    refreshShift().catch(() => {});
  }, POLL_MS);
});
