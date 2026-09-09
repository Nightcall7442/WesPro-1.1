// Панель сети клубов. Отдельный скрипт от app.js: там карта зала и
// касса, здесь — подписки и деньги сервиса. Общего кода почти нет, а
// смешивать два рабочих места в одном файле — верный способ однажды
// показать кассиру чужие оплаты.
"use strict";

const state = {
  user: null,
  tab: "overview",
  clubs: [],
  plans: [],
  settings: {},
};

// --- Мелкие помощники -------------------------------------------------------

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (response.status === 401) {
    window.location.href = "/hub/login";
    throw new Error("Требуется вход");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail ?? `Ошибка ${response.status}`);
  return body;
}

const cur = () => state.settings.currency ?? "сум";

/** Деньги с разделителями разрядов: «1 200 000 сум». */
function money(value) {
  const num = Number(value) || 0;
  return `${num.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${cur()}`;
}

function date(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ru-RU");
}

function dateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showToast(text, ok = false) {
  const box = document.getElementById("hub-toasts");
  const toast = el("div", `toast ${ok ? "ok" : "bad"}`);
  toast.style.pointerEvents = "auto";
  toast.append(el("div", "toast-text", text));
  box.append(toast);
  setTimeout(() => toast.remove(), 5000);
}

/** Оборачивает обработчик: ошибки показываем всплывашкой, а не в консоли. */
function guard(handler) {
  return async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      showToast(error.message);
    }
  };
}

// --- Окно -------------------------------------------------------------------

function openModal(title, body) {
  document.getElementById("hub-modal-title").textContent = title;
  const host = document.getElementById("hub-modal-body");
  host.replaceChildren(body);
  document.getElementById("hub-modal-overlay").hidden = false;
}

function closeModal() {
  document.getElementById("hub-modal-overlay").hidden = true;
}

function field(label, input) {
  const wrap = el("label", "field", `${label} `);
  wrap.append(input);
  return wrap;
}

function textInput(value = "", placeholder = "") {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value ?? "";
  input.placeholder = placeholder;
  return input;
}

function numberInput(value = "", min = null) {
  const input = document.createElement("input");
  input.type = "number";
  input.value = value ?? "";
  if (min !== null) input.min = String(min);
  return input;
}

function actionsRow(...buttons) {
  const row = el("div", "hub-modal-actions");
  row.append(...buttons);
  return row;
}

function button(text, className, onClick) {
  const btn = el("button", className, text);
  btn.addEventListener("click", onClick);
  return btn;
}

// --- Таблицы ----------------------------------------------------------------

/**
 * Рисует таблицу целиком: шапка, строки и понятная заглушка на пустом
 * месте. Пустая таблица без слов пугает — кажется, что всё сломалось.
 */
function renderTable(table, columns, rows, emptyText) {
  table.replaceChildren();
  if (!rows.length) {
    const caption = el("caption", "hub-empty", emptyText);
    caption.style.captionSide = "bottom";
    caption.style.textAlign = "left";
    table.append(caption);
    return;
  }
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of columns) {
    const th = el("th", column.className, column.title);
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const column of columns) {
      const td = el("td", column.className);
      const value = column.render(row);
      if (value instanceof Node) td.append(value);
      else td.textContent = value ?? "";
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);
}

function statusPill(club) {
  return el("span", `pill pill-${club.status}`, club.status_label);
}

// --- Сводка -----------------------------------------------------------------

async function loadOverview() {
  const data = await api("/hub/api/overview");
  state.settings = data.settings;
  const { stats } = data;

  const cards = [
    { value: stats.clubs_living, label: "клубов в сети" },
    { value: stats.by_status.active, label: "платят сейчас" },
    { value: stats.by_status.trial, label: "на пробном периоде" },
    { value: stats.by_status.overdue, label: "просрочили оплату" },
    { value: stats.by_status.blocked, label: "заблокированы" },
    { value: `${stats.online}/${stats.clubs_living}`, label: "на связи" },
    { value: money(stats.mrr), label: "выручка в месяц" },
    { value: money(stats.paid_total), label: "получено всего" },
  ];
  const host = document.getElementById("stat-cards");
  host.replaceChildren();
  for (const card of cards) {
    const node = el("div", "hub-card");
    node.append(el("div", "hub-card-value", String(card.value)), el("div", "hub-card-label", card.label));
    host.append(node);
  }

  const attention = document.getElementById("attention-list");
  attention.replaceChildren();
  if (!data.attention.length) {
    attention.append(el("p", "hub-empty", "Всё спокойно: никого не надо догонять."));
  }
  for (const item of data.attention) {
    const node = el("div", `attention-item attention-${item.kind}`);
    node.append(el("b", null, item.club_name), el("span", null, item.text));
    node.addEventListener("click", () => {
      switchTab("clubs");
      const club = state.clubs.find((c) => c.id === item.club_id);
      if (club) openClubCard(club.id);
    });
    attention.append(node);
  }

  renderTable(
    document.getElementById("growth-table"),
    [
      { title: "Месяц", render: (r) => r.month },
      { title: "Новых клубов", className: "num", render: (r) => String(r.clubs) },
      { title: "Получено", className: "num", render: (r) => money(r.income) },
    ],
    stats.by_month,
    "Пока нет данных — они появятся, когда добавите первый клуб."
  );
}

// --- Клубы ------------------------------------------------------------------

async function loadClubs() {
  const params = new URLSearchParams({
    status: document.getElementById("clubs-status").value,
    query: document.getElementById("clubs-search").value,
  });
  state.clubs = await api(`/hub/api/clubs?${params}`);
  renderTable(
    document.getElementById("clubs-table"),
    [
      {
        title: "Клуб",
        render: (club) => {
          const wrap = el("span");
          const dot = el("span", `dot ${club.offline ? "dot-off" : "dot-on"}`);
          dot.title = club.last_seen_at
            ? `На связи: ${dateTime(club.last_seen_at)}`
            : "Ни разу не выходил на связь";
          wrap.append(dot, document.createTextNode(club.name));
          if (club.city) wrap.append(el("span", "hub-card-label", club.city));
          return wrap;
        },
      },
      { title: "Контакты", render: (club) => [club.owner_name, club.phone].filter(Boolean).join(", ") || "—" },
      { title: "Тариф", render: (club) => club.plan_name ?? "не назначен" },
      { title: "Подписка", render: statusPill },
      {
        title: "Оплачено до",
        render: (club) => {
          if (!club.paid_until) return "—";
          const text = date(club.paid_until);
          if (club.days_left === null) return text;
          const suffix =
            club.days_left < 0 ? ` (${-club.days_left} дн. назад)` : ` (${club.days_left} дн.)`;
          return text + suffix;
        },
      },
      { title: "На связи", render: (club) => dateTime(club.last_seen_at) },
      {
        title: "",
        className: "row-actions-cell",
        render: (club) => {
          const wrap = el("div", "row-actions");
          wrap.append(
            button("Открыть", "mini", () => openClubCard(club.id)),
            button("Оплата", "mini", () => openPaymentModal(club))
          );
          return wrap;
        },
      },
    ],
    state.clubs,
    "Клубов пока нет. Нажмите «Добавить клуб» — и он появится здесь."
  );
}

function planSelect(selectedId) {
  const select = document.createElement("select");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "не назначен";
  select.append(none);
  for (const plan of state.plans) {
    const option = document.createElement("option");
    option.value = String(plan.id);
    option.textContent = `${plan.name} — ${money(plan.price)} / ${plan.period_days} дн.`;
    select.append(option);
  }
  select.value = selectedId ? String(selectedId) : "";
  return select;
}

function openClubForm(club = null) {
  const body = el("div");
  const name = textInput(club?.name, "Например: WesPro Чиланзар");
  const city = textInput(club?.city, "Город");
  const owner = textInput(club?.owner_name, "Кто владелец");
  const phone = textInput(club?.phone, "+998 ...");
  const email = textInput(club?.email, "почта");
  const note = textInput(club?.note, "заметка для себя");
  const plan = planSelect(club?.plan_id);
  const grid = el("div", "settings-grid");
  grid.append(
    field("Название", name),
    field("Город", city),
    field("Владелец", owner),
    field("Телефон", phone),
    field("Почта", email),
    field("Тариф", plan)
  );
  body.append(grid, field("Заметка", note));

  body.append(
    actionsRow(
      button(
        club ? "Сохранить" : "Добавить клуб",
        "primary",
        guard(async () => {
          const payload = {
            name: name.value,
            city: city.value,
            owner_name: owner.value,
            phone: phone.value,
            email: email.value,
            note: note.value,
            plan_id: plan.value || null,
          };
          if (club) await api(`/hub/api/clubs/${club.id}`, { method: "PUT", body: JSON.stringify(payload) });
          else await api("/hub/api/clubs", { method: "POST", body: JSON.stringify(payload) });
          closeModal();
          showToast(club ? "Карточка клуба сохранена" : "Клуб добавлен в сеть", true);
          await loadClubs();
        })
      )
    )
  );
  openModal(club ? `Клуб — ${club.name}` : "Новый клуб", body);
  name.focus();
}

async function openClubCard(clubId) {
  const club = await api(`/hub/api/clubs/${clubId}`);
  const payments = await api(`/hub/api/clubs/${clubId}/payments`);
  const body = el("div");

  const lines = el("div", "check-lines");
  const line = (label, value) => {
    const row = el("div", "check-line");
    row.append(el("span", null, label));
    const right = el("span");
    if (value instanceof Node) right.append(value);
    else right.textContent = value;
    row.append(right);
    lines.append(row);
  };
  line("Подписка", statusPill(club));
  line("Тариф", club.plan_name ?? "не назначен");
  line("Оплачено до", date(club.paid_until));
  if (club.grace_until) line("Отсрочка до", date(club.grace_until));
  line("Город", club.city || "—");
  line("Владелец", [club.owner_name, club.phone].filter(Boolean).join(", ") || "—");
  line("Почта", club.email || "—");
  line("На связи", dateTime(club.last_seen_at));
  line("Версия программы", club.app_version ?? "—");
  line("Столов в клубе", club.tables_count === null ? "—" : String(club.tables_count));
  line("Получено всего", money(club.paid_total));
  if (club.note) line("Заметка", club.note);
  body.append(lines);

  // Ключ доступа: его вписывают в программу клуба один раз.
  const key = el("details");
  key.append(el("summary", null, "Ключ доступа для программы клуба"));
  key.append(el("div", "key-box", club.api_key));
  const keyHint = el("p", "hint",
    "Вписывается в программе клуба один раз. Если ключ утёк — выдайте новый: " +
    "старый перестанет работать сразу.");
  key.append(keyHint);
  key.append(
    button("Выдать новый ключ", "mini danger", guard(async () => {
      await api(`/hub/api/clubs/${clubId}/key`, { method: "POST" });
      showToast("Выдан новый ключ — впишите его в программе клуба", true);
      await openClubCard(clubId);
    }))
  );
  body.append(key);

  body.append(el("h4", null, "История оплат"));
  const table = el("table", "hub-table");
  renderTable(
    table,
    [
      { title: "Когда", render: (p) => date(p.created_at) },
      { title: "Сумма", className: "num", render: (p) => money(p.amount) },
      { title: "Дней", className: "num", render: (p) => String(p.days) },
      { title: "До", render: (p) => date(p.paid_until) },
      { title: "Кто провёл", render: (p) => p.created_by_name ?? "—" },
    ],
    payments,
    "Оплат ещё не было."
  );
  body.append(table);

  const actions = el("div", "hub-modal-actions");
  actions.append(
    button("Отметить оплату", "primary", () => openPaymentModal(club)),
    button("Изменить", "mini", () => openClubForm(club)),
    button("Дать отсрочку", "mini", () => openGraceModal(club)),
    button("Написать клубу", "mini", () => openMessageForm(club)),
    button("Войти для поддержки", "mini", () => openSupportModal(club))
  );
  if (club.status === "archived") {
    actions.append(
      button("Вернуть из архива", "mini", guard(async () => {
        await api(`/hub/api/clubs/${clubId}/restore`, { method: "POST" });
        closeModal();
        showToast("Клуб возвращён в сеть", true);
        await refreshCurrentTab();
      }))
    );
  } else {
    actions.append(
      button(
        club.blocked_manually ? "Разблокировать" : "Заблокировать",
        "mini danger",
        guard(async () => {
          await api(`/hub/api/clubs/${clubId}/block`, {
            method: "POST",
            body: JSON.stringify({ blocked: !club.blocked_manually }),
          });
          showToast(club.blocked_manually ? "Клуб разблокирован" : "Клуб заблокирован", true);
          await openClubCard(clubId);
          await loadClubs();
        })
      ),
      button("В архив", "mini danger", guard(async () => {
        await api(`/hub/api/clubs/${clubId}/archive`, { method: "POST" });
        closeModal();
        showToast("Клуб отправлен в архив", true);
        await refreshCurrentTab();
      }))
    );
  }
  body.append(actions);

  openModal(club.name, body);
}

function openPaymentModal(club) {
  const body = el("div");
  body.append(
    el("p", "hint",
      `Оплата продлевает подписку от ${club.paid_until && club.days_left > 0
        ? `текущей даты (${date(club.paid_until)})`
        : "сегодняшнего дня"}. Заблокированный клуб оплата разблокирует сразу.`)
  );
  const amount = numberInput(club.plan_price || "", 0);
  const days = numberInput(club.plan_period_days ?? 30, 1);
  const method = document.createElement("select");
  for (const [value, label] of [
    ["cash", "Наличные"],
    ["card", "Карта"],
    ["transfer", "Перевод"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    method.append(option);
  }
  const comment = textInput("", "например: оплатил за два месяца вперёд");
  const grid = el("div", "settings-grid");
  grid.append(field(`Сумма, ${cur()}`, amount), field("Дней", days), field("Чем платили", method));
  body.append(grid, field("Комментарий", comment));
  body.append(
    actionsRow(
      button("Отметить оплату", "primary", guard(async () => {
        await api(`/hub/api/clubs/${club.id}/payments`, {
          method: "POST",
          body: JSON.stringify({
            amount: Number(amount.value),
            days: Number(days.value),
            method: method.value,
            comment: comment.value,
          }),
        });
        closeModal();
        showToast(`Оплата клуба «${club.name}» отмечена`, true);
        await refreshCurrentTab();
      }))
    )
  );
  openModal(`Оплата — ${club.name}`, body);
  amount.focus();
}

function openGraceModal(club) {
  const body = el("div");
  body.append(
    el("p", "hint",
      "Отсрочка держит клуб включённым, пока оплата не пришла. По её окончании " +
      "клуб заблокируется сам.")
  );
  const days = numberInput(7, 1);
  body.append(field("Дней отсрочки", days));
  body.append(
    actionsRow(
      button("Дать отсрочку", "primary", guard(async () => {
        await api(`/hub/api/clubs/${club.id}/grace`, {
          method: "POST",
          body: JSON.stringify({ days: Number(days.value) }),
        });
        closeModal();
        showToast(`Клубу «${club.name}» дана отсрочка`, true);
        await refreshCurrentTab();
      }))
    )
  );
  openModal(`Отсрочка — ${club.name}`, body);
  days.focus();
}

function openSupportModal(club) {
  const body = el("div");
  body.append(
    el("p", "hint",
      "Одноразовый ключ, по которому можно войти в программу клуба для разбора " +
      "проблемы. Действует 30 минут, сгорает после первого входа, а причина " +
      "попадает в журнал сети — и клуб её видит.")
  );
  const reason = textInput("", "например: не печатается чек, разбираемся по заявке");
  body.append(field("Причина входа", reason));
  const result = el("div");
  body.append(result);
  body.append(
    actionsRow(
      button("Получить ключ входа", "primary", guard(async () => {
        const data = await api(`/hub/api/clubs/${club.id}/support`, {
          method: "POST",
          body: JSON.stringify({ reason: reason.value }),
        });
        result.replaceChildren(
          el("div", "key-box", data.token),
          el("p", "hint", `Действует ${data.expires_in_minutes} минут.`)
        );
      }))
    )
  );
  openModal(`Поддержка — ${club.name}`, body);
  reason.focus();
}

// --- Тарифы -----------------------------------------------------------------

async function loadPlans() {
  state.plans = await api("/hub/api/plans");
  renderTable(
    document.getElementById("plans-table"),
    [
      { title: "Тариф", render: (p) => p.name },
      { title: "Цена", className: "num", render: (p) => money(p.price) },
      { title: "Срок", className: "num", render: (p) => `${p.period_days} дн.` },
      { title: "Столов", className: "num", render: (p) => (p.max_tables ? String(p.max_tables) : "без лимита") },
      { title: "Что входит", render: (p) => p.description || "—" },
      { title: "Клубов", className: "num", render: (p) => String(p.clubs_count) },
      {
        title: "",
        render: (p) =>
          el("span", `pill ${p.is_active ? "pill-active" : "pill-archived"}`,
            p.is_active ? "включён" : "отключён"),
      },
      {
        title: "",
        render: (plan) => {
          const wrap = el("div", "row-actions");
          wrap.append(
            button("Изменить", "mini", () => openPlanForm(plan)),
            button("Удалить", "mini danger", guard(async () => {
              await api(`/hub/api/plans/${plan.id}`, { method: "DELETE" });
              showToast("Тариф удалён", true);
              await loadPlans();
            }))
          );
          return wrap;
        },
      },
    ],
    state.plans,
    "Тарифов пока нет. Заведите хотя бы один — на него будете сажать клубы."
  );
}

function openPlanForm(plan = null) {
  const body = el("div");
  const name = textInput(plan?.name, "Например: Базовый");
  const price = numberInput(plan?.price ?? "", 0);
  const period = numberInput(plan?.period_days ?? 30, 1);
  const maxTables = numberInput(plan?.max_tables ?? "", 1);
  const description = textInput(plan?.description, "что входит в тариф");
  const active = document.createElement("input");
  active.type = "checkbox";
  active.checked = plan ? plan.is_active : true;
  const activeRow = el("label", "switch-row");
  activeRow.append(active, document.createTextNode(" Тариф включён (можно назначать клубам)"));

  const grid = el("div", "settings-grid");
  grid.append(
    field("Название", name),
    field(`Цена, ${cur()}`, price),
    field("Период, дней", period),
    field("Лимит столов (пусто — без лимита)", maxTables)
  );
  body.append(grid, field("Что входит", description), activeRow);
  body.append(
    actionsRow(
      button(plan ? "Сохранить" : "Создать тариф", "primary", guard(async () => {
        const payload = {
          name: name.value,
          price: Number(price.value),
          period_days: Number(period.value),
          max_tables: maxTables.value === "" ? null : Number(maxTables.value),
          description: description.value,
          is_active: active.checked,
        };
        if (plan) await api(`/hub/api/plans/${plan.id}`, { method: "PUT", body: JSON.stringify(payload) });
        else await api("/hub/api/plans", { method: "POST", body: JSON.stringify(payload) });
        closeModal();
        showToast(plan ? "Тариф сохранён" : "Тариф создан", true);
        await loadPlans();
      }))
    )
  );
  openModal(plan ? `Тариф — ${plan.name}` : "Новый тариф", body);
  name.focus();
}

// --- Сообщения --------------------------------------------------------------

async function loadMessages() {
  const messages = await api("/hub/api/messages");
  renderTable(
    document.getElementById("messages-table"),
    [
      { title: "Когда", render: (m) => dateTime(m.created_at) },
      { title: "Кому", render: (m) => m.club_name ?? "всем клубам" },
      { title: "Заголовок", render: (m) => m.title },
      { title: "Текст", render: (m) => m.body },
      { title: "Прочитали", className: "num", render: (m) => `${m.read_count} / ${m.target_count}` },
      {
        title: "",
        render: (message) =>
          button("Удалить", "mini danger", guard(async () => {
            await api(`/hub/api/messages/${message.id}`, { method: "DELETE" });
            showToast("Сообщение удалено", true);
            await loadMessages();
          })),
      },
    ],
    messages,
    "Сообщений пока не было."
  );
}

function openMessageForm(club = null) {
  const body = el("div");
  body.append(
    el("p", "hint",
      "Сообщение появится в программе клуба, когда она выйдет на связь. " +
      "Выключенный сейчас клуб получит его при первом же включении.")
  );
  const title = textInput("", "Коротко: о чём речь");
  const text = document.createElement("textarea");
  text.rows = 5;
  text.placeholder = "Текст сообщения";
  text.style.width = "100%";
  const target = document.createElement("select");
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "Всем клубам сети";
  target.append(all);
  for (const item of state.clubs) {
    const option = document.createElement("option");
    option.value = String(item.id);
    option.textContent = item.name;
    target.append(option);
  }
  if (club) target.value = String(club.id);

  body.append(field("Кому", target), field("Заголовок", title), field("Текст", text));
  body.append(
    actionsRow(
      button("Отправить", "primary", guard(async () => {
        await api("/hub/api/messages", {
          method: "POST",
          body: JSON.stringify({
            title: title.value,
            body: text.value,
            club_id: target.value || null,
          }),
        });
        closeModal();
        showToast("Сообщение поставлено в очередь клубам", true);
        if (state.tab === "messages") await loadMessages();
      }))
    )
  );
  openModal("Сообщение клубам", body);
  title.focus();
}

// --- Журнал сети ------------------------------------------------------------

async function loadJournal() {
  const params = new URLSearchParams({ event: document.getElementById("journal-event").value });
  const data = await api(`/hub/api/journal?${params}`);

  const select = document.getElementById("journal-event");
  if (select.options.length <= 1) {
    for (const [value, label] of Object.entries(data.labels)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
  }

  renderTable(
    document.getElementById("journal-table"),
    [
      { title: "Когда", render: (e) => dateTime(e.created_at) },
      { title: "Событие", render: (e) => e.event_label },
      { title: "Клуб", render: (e) => e.club_name ?? "—" },
      { title: "Что произошло", render: (e) => e.message },
    ],
    data.entries,
    "Событий пока нет."
  );
}

// --- Настройки --------------------------------------------------------------

const SETTING_LABELS = {
  currency: "Валюта (как писать в панели)",
  trial_days: "Пробный период, дней",
  grace_days: "Отсрочка после просрочки, дней",
  offline_hours: "Считать клуб пропавшим через, часов",
  expiry_warning_days: "Предупреждать об окончании за, дней",
};

async function loadSettings() {
  const data = await api("/hub/api/settings");
  state.settings = data.settings;
  const form = document.getElementById("settings-form");
  form.replaceChildren();
  for (const [key, label] of Object.entries(SETTING_LABELS)) {
    const input = key === "currency" ? textInput(data.settings[key]) : numberInput(data.settings[key], 1);
    input.dataset.settingKey = key;
    form.append(field(label, input));
  }

  renderTable(
    document.getElementById("hub-users-table"),
    [
      { title: "Логин", render: (u) => u.login },
      { title: "Имя", render: (u) => u.name },
      {
        title: "",
        render: (user) =>
          button("Сменить пароль", "mini", () => {
            const body = el("div");
            const password = document.createElement("input");
            password.type = "password";
            password.autocomplete = "new-password";
            body.append(field("Новый пароль (минимум 8 символов)", password));
            body.append(
              actionsRow(
                button("Сохранить", "primary", guard(async () => {
                  await api(`/hub/api/users/${user.id}/password`, {
                    method: "POST",
                    body: JSON.stringify({ password: password.value }),
                  });
                  closeModal();
                  showToast("Пароль изменён", true);
                }))
              )
            );
            openModal(`Пароль — ${user.name}`, body);
            password.focus();
          }),
      },
    ],
    data.users,
    "Нет ни одного сотрудника панели."
  );
}

function openHubUserForm() {
  const body = el("div");
  const login = textInput("", "логин");
  const name = textInput("", "имя");
  const password = document.createElement("input");
  password.type = "password";
  password.autocomplete = "new-password";
  body.append(field("Логин", login), field("Имя", name), field("Пароль (минимум 8 символов)", password));
  body.append(
    actionsRow(
      button("Добавить", "primary", guard(async () => {
        await api("/hub/api/users", {
          method: "POST",
          body: JSON.stringify({ login: login.value, name: name.value, password: password.value }),
        });
        closeModal();
        showToast("Сотрудник добавлен", true);
        await loadSettings();
      }))
    )
  );
  openModal("Новый сотрудник панели", body);
  login.focus();
}

// --- Вкладки ----------------------------------------------------------------

const LOADERS = {
  overview: loadOverview,
  clubs: loadClubs,
  plans: loadPlans,
  messages: loadMessages,
  journal: loadJournal,
  settings: loadSettings,
};

function refreshCurrentTab() {
  return guard(LOADERS[state.tab])();
}

async function switchTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll(".hub-tab")) {
    button.classList.toggle("on", button.dataset.tab === tab);
  }
  for (const page of document.querySelectorAll(".hub-page")) {
    page.hidden = page.dataset.page !== tab;
  }
  // Список клубов нужен окнам «написать клубу» и карточкам, а тарифы —
  // выпадающему списку в карточке клуба: держим их наготове.
  if (tab === "clubs" && !state.plans.length) {
    state.plans = await api("/hub/api/plans").catch(() => []);
  }
  if ((tab === "messages" || tab === "overview") && !state.clubs.length) {
    state.clubs = await api("/hub/api/clubs?status=all").catch(() => []);
  }
  await refreshCurrentTab();
}

// --- Запуск -----------------------------------------------------------------

(async () => {
  try {
    state.user = await api("/hub/api/auth/me");
  } catch {
    return; // api уже увёл на страницу входа
  }
  document.getElementById("hub-user-name").textContent = state.user.name;

  for (const button of document.querySelectorAll(".hub-tab")) {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  }
  document.getElementById("hub-logout").addEventListener("click", async () => {
    await api("/hub/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/hub/login";
  });
  document.getElementById("hub-modal-close").addEventListener("click", closeModal);
  document.getElementById("hub-modal-overlay").addEventListener("click", (event) => {
    if (event.target.id === "hub-modal-overlay") closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
  });

  document.getElementById("club-add").addEventListener("click", () => openClubForm());
  document.getElementById("plan-add").addEventListener("click", () => openPlanForm());
  document.getElementById("message-add").addEventListener("click", () => openMessageForm());
  document.getElementById("hub-user-add").addEventListener("click", openHubUserForm);
  document.getElementById("clubs-status").addEventListener("change", () => loadClubs());
  document.getElementById("journal-event").addEventListener("change", () => loadJournal());
  document.getElementById("settings-save").addEventListener(
    "click",
    guard(async () => {
      const patch = {};
      for (const input of document.querySelectorAll("[data-setting-key]")) {
        patch[input.dataset.settingKey] = input.value;
      }
      state.settings = await api("/hub/api/settings", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      showToast("Настройки сохранены", true);
    })
  );

  // Поиск по клубам: ждём паузу в наборе, чтобы не дёргать сервер на
  // каждую букву.
  let searchTimer = null;
  document.getElementById("clubs-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadClubs(), 250);
  });

  await switchTab("overview");
})();
