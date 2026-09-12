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
  live: {},          // что в клубах прямо сейчас (только сеть клубов)
  clubFilter: "all", // фишка над плитками
};

const TAB_TITLES = {
  overview: "Сводка",
  clubs: "Клубы",
  club: "",
  plans: "Тарифы сервиса",
  messages: "Сообщения клубам",
  journal: "Журнал сети",
  settings: "Настройки панели",
};

const RELAY_LABELS = { tuya: "Tuya / MOES", tasmota: "Tasmota", shelly: "Shelly", url: "Своё устройство" };
function relayKindLabel(kind) {
  return RELAY_LABELS[kind] ?? kind ?? "—";
}

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

/** Число набегает до значения за ~0,9 с — видно, что сводка живая. */
function animateNumber(node, target, format) {
  const from = Number(node.dataset.value ?? 0);
  node.dataset.value = String(target);
  if (from === target || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    node.textContent = format(target);
    return;
  }
  const started = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - started) / 900);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = format(Math.round(from + (target - from) * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Короткие деньги для плиток: «3,96 млн сум», «640 тыс сум». */
function moneyShort(value) {
  const num = Number(value) || 0;
  if (Math.abs(num) >= 1e6) return `${(num / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} млн ${cur()}`;
  if (Math.abs(num) >= 1e4) return `${Math.round(num / 1e3).toLocaleString("ru-RU")} тыс ${cur()}`;
  return money(num);
}

/** «2 ч», «40 мин», «3 дн.» — сколько прошло с момента. */
function since(iso) {
  if (!iso) return "";
  const minutes = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 60) return `${Math.round(minutes)} мин`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} ч`;
  return `${Math.round(minutes / 1440)} дн.`;
}

function kpiCard(value, label, format, extra = null) {
  const node = el("div", "kpi");
  const num = el("b");
  node.append(num, el("small", null, label));
  if (extra) {
    const delta = el("span", `delta ${extra.cls}`, extra.text);
    node.append(delta);
  }
  if (typeof value === "number") animateNumber(num, value, format);
  else num.textContent = value;
  return node;
}

/** График «сеть сегодня»: столбцы по часам, поверх — линия «вчера». */
function renderDayChart(liveRows) {
  const host = document.getElementById("day-chart");
  const today = new Array(24).fill(0);
  const yesterday = new Array(24).fill(0);
  for (const row of liveRows) {
    row.hours_today.forEach((v, h) => { today[h] += v; });
    row.hours_yesterday.forEach((v, h) => { yesterday[h] += v; });
  }
  // Часы показываем с 8 утра по кругу до 7 утра: клуб живёт вечером.
  const order = [...Array(24).keys()].map((i) => (i + 8) % 24);
  const nowHour = new Date().getHours();
  const max = Math.max(1, ...today, ...yesterday);
  const W = 640, H = 170, bw = W / 24;
  const parts = [];
  for (const y of [0.25, 0.5, 0.75, 1]) {
    parts.push(`<line class="grid" x1="0" x2="${W}" y1="${H - H * y}" y2="${H - H * y}"></line>`);
  }
  order.forEach((h, i) => {
    const past = (h - 8 + 24) % 24 <= (nowHour - 8 + 24) % 24;
    const v = past ? today[h] : yesterday[h];
    const height = (v / max) * H;
    const cls = h === nowHour ? "now" : past ? "" : "future";
    parts.push(
      `<rect class="bar ${cls}" x="${(i * bw + 4).toFixed(1)}" y="${(H - height).toFixed(1)}" ` +
        `width="${(bw - 8).toFixed(1)}" height="${height.toFixed(1)}" rx="3" style="animation-delay: ${i * 30}ms"></rect>`
    );
    if (i % 2 === 0) {
      parts.push(`<text class="lbl" x="${(i * bw + bw / 2).toFixed(1)}" y="${H + 14}" text-anchor="middle">${String(h).padStart(2, "0")}</text>`);
    }
  });
  const points = order.map((h, i) => `${(i * bw + bw / 2).toFixed(1)},${(H - (yesterday[h] / max) * H).toFixed(1)}`).join(" ");
  parts.push(`<polyline class="yday" points="${points}"></polyline>`);
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H + 20}" preserveAspectRatio="none">${parts.join("")}</svg>`;
}

function renderClubsNow(clubs, live) {
  const host = document.getElementById("clubs-now");
  host.replaceChildren();
  const rows = clubs
    .filter((c) => c.status !== "archived")
    .map((c) => ({ club: c, live: live[c.id] }))
    .sort((a, b) => (b.live?.tables_busy ?? -1) - (a.live?.tables_busy ?? -1));
  for (const { club, live: l } of rows) {
    const row = el("div", "club-row");
    const link = linkState(club, l);
    const dot = el("span", `dot ${link.silent ? (club.status === "blocked" ? "grey" : "off") : "on"}`);
    const name = el("span");
    name.append(el("b", null, club.name), " ", el("span", "muted", club.city ?? ""));
    const bar = el("div", "occ");
    if (l?.tables_total) {
      const fill = el("b");
      fill.style.setProperty("--w", `${Math.round((l.tables_busy / l.tables_total) * 100)}%`);
      bar.append(fill);
    }
    const num = el("span", "num");
    if (l) {
      num.append(`${l.tables_busy}/${l.tables_total} · `, el("b", null, moneyShort(l.revenue_today)));
    } else {
      num.className = "num muted";
      num.textContent = club.status_label;
    }
    row.append(dot, name, bar, num);
    row.addEventListener("click", () => openClubCard(club.id));
    host.append(row);
  }
  if (!rows.length) host.append(el("p", "hub-empty", "Клубов пока нет."));
}

function renderSubscriptions(stats, clubs) {
  const host = document.getElementById("subs-donut");
  host.replaceChildren();
  const parts = [
    ["active", "var(--green-text)", "платят"],
    ["trial", "#2f5fa8", "пробный"],
    ["overdue", "var(--orange-text)", "просрочен"],
    ["blocked", "var(--red)", "заблокирован"],
  ];
  const total = parts.reduce((s, [key]) => s + (stats.by_status[key] ?? 0), 0);
  const circumference = 2 * Math.PI * 46;
  let offsetShare = 0;
  let svg = `<svg viewBox="0 0 110 110">`;
  for (const [key, color] of parts) {
    const share = total ? (stats.by_status[key] ?? 0) / total : 0;
    if (!share) continue;
    svg +=
      `<circle cx="55" cy="55" r="46" stroke="${color}" stroke-dasharray="${circumference.toFixed(1)}" ` +
      `style="--off: ${(circumference * (1 - share)).toFixed(1)}; transform: rotate(${(offsetShare * 360).toFixed(1)}deg)"></circle>`;
    offsetShare += share;
  }
  svg += `</svg>`;
  const wrap = el("div", "donut");
  wrap.innerHTML = svg;
  const legend = el("div", "lg");
  for (const [key, color, label] of parts) {
    const n = stats.by_status[key] ?? 0;
    if (!n) continue;
    const item = el("span");
    const sw = el("i");
    sw.style.background = color;
    item.append(sw, `${n} ${label}${key === "active" ? ` · ${moneyShort(stats.mrr)}/мес` : ""}`);
    legend.append(item);
  }
  if (!total) legend.append(el("span", "muted", "Клубов пока нет."));
  wrap.append(legend);
  host.append(wrap);

  // Ближайшие оплаты: по дате «оплачено до», просроченные — сверху.
  const upcoming = document.getElementById("upcoming");
  upcoming.replaceChildren();
  const due = clubs
    .filter((c) => ["trial", "active", "overdue"].includes(c.status) && c.paid_until)
    .sort((a, b) => Date.parse(a.paid_until) - Date.parse(b.paid_until))
    .slice(0, 5);
  for (const club of due) {
    const row = el("div", "pay-row");
    const left = el("span");
    left.append(club.name, " ", el("span", "muted", club.status === "trial" ? "конец пробного" : club.status === "overdue" ? "просрочена" : ""));
    const right = el("span", `num${club.status === "overdue" ? " bad" : ""}`);
    right.textContent = `${club.plan_price ? moneyShort(club.plan_price) + " · " : ""}${date(club.paid_until)}`;
    row.append(left, right);
    row.addEventListener("click", () => openClubCard(club.id));
    upcoming.append(row);
  }
}

function renderEvents(entries, labels) {
  const host = document.getElementById("events");
  const latest = entries.slice(0, 6);
  const known = new Set([...host.querySelectorAll("[data-id]")].map((n) => Number(n.dataset.id)));
  host.replaceChildren();
  for (const entry of latest) {
    const row = el("div", `ev${known.size && !known.has(entry.id) ? " new" : ""}`);
    row.dataset.id = String(entry.id);
    const when = el("span", "when", new Date(entry.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));
    when.title = dateTime(entry.created_at);
    const text = el("span");
    if (entry.club_name) text.append(el("b", null, entry.club_name), " ");
    text.append(`${labels[entry.event] ?? entry.event}: ${entry.message}`);
    row.append(when, text);
    if (entry.club_id) row.addEventListener("click", () => openClubCard(entry.club_id));
    host.append(row);
  }
  if (!latest.length) host.append(el("p", "hub-empty", "Событий пока нет."));
}

async function loadOverview() {
  // Сначала живое: в сети оно же отмечает клубы «на связи», и сводка
  // считается уже с учётом этого.
  const live = await api("/hub/api/live").catch(() => ({}));
  const [data, clubs, journal] = await Promise.all([
    api("/hub/api/overview"),
    api("/hub/api/clubs?status=all"),
    api("/hub/api/journal").catch(() => ({ entries: [], labels: {} })),
  ]);
  state.settings = data.settings;
  state.live = live;
  state.clubs = clubs;
  const { stats } = data;
  const liveRows = Object.values(live).filter(Boolean);
  const hasLive = liveRows.length > 0;

  const cards = document.getElementById("stat-cards");
  cards.replaceChildren();
  if (hasLive) {
    const busy = liveRows.reduce((s, r) => s + r.tables_busy, 0);
    const total = liveRows.reduce((s, r) => s + r.tables_total, 0);
    const today = liveRows.reduce((s, r) => s + r.revenue_today, 0);
    const yesterday = liveRows.reduce((s, r) => s + r.revenue_yesterday, 0);
    const relaysOff = liveRows.reduce((s, r) => s + r.relays_offline, 0);
    const load = total ? Math.round((busy / total) * 100) : 0;
    cards.append(
      kpiCard(busy, "занято столов сейчас", (v) => `${v} / ${total}`, { cls: load >= 50 ? "up" : "flat", text: `загрузка ${load} %` }),
      kpiCard(today, "выручка клубов сегодня", moneyShort, yesterday
        ? { cls: today >= yesterday ? "up" : "down", text: `${today >= yesterday ? "+" : ""}${Math.round(((today - yesterday) / yesterday) * 100)} % к вчера` }
        : { cls: "flat", text: "вчера без выручки" })
    );
    const relays = kpiCard(relaysOff, "реле не отвечают", (v) => String(v), { cls: relaysOff ? "down" : "up", text: relaysOff ? `в ${liveRows.filter((r) => r.relays_offline).length} клубах` : "все на связи" });
    if (relaysOff) relays.classList.add("warn");
    cards.append(relays);
  }
  cards.append(
    kpiCard(stats.online, "клубов на связи", (v) => `${v} / ${stats.clubs_living}`, { cls: stats.offline ? "down" : "up", text: stats.offline ? `${stats.offline} молчат` : "все" }),
    kpiCard(stats.mrr, "подписки в месяц", moneyShort, { cls: "flat", text: `${stats.by_status.active} платят` }),
    kpiCard(stats.by_status.trial, "на пробном периоде", (v) => String(v)),
    kpiCard(stats.paid_total, "получено всего", moneyShort)
  );
  const overdue = kpiCard(stats.by_status.overdue, "просрочили оплату", (v) => String(v));
  if (stats.by_status.overdue) overdue.classList.add("bad");
  const attention = kpiCard(data.attention.length, "требуют внимания", (v) => String(v));
  if (data.attention.length) attention.classList.add("warn");
  cards.append(overdue, attention);

  document.getElementById("live-panels").hidden = !hasLive;
  if (hasLive) {
    renderDayChart(liveRows);
    renderClubsNow(clubs, live);
  }

  const attentionHost = document.getElementById("attention-list");
  attentionHost.replaceChildren();
  document.getElementById("attention-count").textContent = data.attention.length ? String(data.attention.length) : "";
  if (!data.attention.length) {
    attentionHost.append(el("p", "hub-empty", "Всё спокойно: никого не надо догонять."));
  }
  data.attention.forEach((item, index) => {
    const node = el("div", `attention-item attention-${item.kind}`);
    node.style.animationDelay = `${index * 60}ms`;
    const text = el("div");
    text.append(el("b", null, item.club_name), " ", el("span", null, item.text));
    node.append(text);
    node.addEventListener("click", () => openClubCard(item.club_id));
    attentionHost.append(node);
  });

  renderSubscriptions(stats, clubs);
  renderEvents(journal.entries ?? [], journal.labels ?? {});

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
  state.refreshedAt = Date.now();
}

// --- Клубы ------------------------------------------------------------------

/**
 * Связь с клубом: по последнему сигналу его программы или последней
 * записи в его журнале (в сети клубов база под рукой, пинги не нужны).
 */
function linkState(club, live) {
  const seen = club.last_seen_at ? Date.parse(club.last_seen_at) : 0;
  const active = live?.last_activity_at ? Date.parse(live.last_activity_at) : 0;
  const last = Math.max(seen, active);
  if (!last) return { cls: "", text: "не выходил на связь", silent: true };
  const hours = (Date.now() - last) / 3600000;
  const limit = Number(state.settings.offline_hours ?? 24);
  if (hours <= limit) return { cls: "ok", text: "на связи", silent: false };
  const since =
    hours < 48 ? `${Math.round(hours)} ч` : `${Math.round(hours / 24)} дн.`;
  return { cls: "bad", text: `молчит ${since}`, silent: true };
}

/** Есть ли у клуба, что чинить: молчит, просрочен, заблокирован, реле молчат. */
function hasProblems(club, live) {
  return (
    linkState(club, live).silent ||
    club.status === "overdue" ||
    club.status === "blocked" ||
    (live?.relays_offline ?? 0) > 0
  );
}

function subscriptionTag(club) {
  if (club.status === "trial") {
    return el("span", "club-tag warn", `пробный${club.days_left !== null ? ` · ${Math.max(0, club.days_left)} дн.` : ""}`);
  }
  if (club.status === "active") return el("span", "club-tag", `оплачено до ${date(club.paid_until)}`);
  if (club.status === "overdue") {
    return el("span", "club-tag bad", `просрочена ${club.days_left !== null ? `${-club.days_left} дн.` : ""}`.trim());
  }
  return el("span", `club-tag ${club.status === "blocked" ? "bad" : ""}`.trim(), club.status_label);
}

/** Плитка клуба: что в нём сейчас, подписка, действия. */
function buildClubTile(club) {
  const live = state.live[club.id];
  const link = linkState(club, live);
  const tile = el("div", "club-tile");
  if (club.status === "archived" || club.status === "blocked") tile.classList.add("off");
  else if (hasProblems(club, live)) tile.classList.add("problem");

  const head = el("div", "club-head");
  const title = el("div");
  title.append(el("div", "club-name", club.name));
  const tables = live?.tables_total ?? club.tables_count;
  title.append(
    el("div", "club-city", [club.city, tables ? `${tables} столов` : null].filter(Boolean).join(" · "))
  );
  const linkEl = el("span", `club-link ${link.cls}`, link.text);
  linkEl.title = club.last_seen_at ? `Последний сигнал: ${dateTime(club.last_seen_at)}` : "";
  head.append(title, linkEl);
  tile.append(head);

  // Живая часть — только когда база клуба под рукой (сеть клубов).
  if (Object.keys(state.live).length) {
    if (live) {
      const row = el("div", "club-live");
      const ring = el("div", "club-ring");
      const circumference = 2 * Math.PI * 29;
      const share = live.tables_total ? live.tables_busy / live.tables_total : 0;
      ring.innerHTML =
        `<svg viewBox="0 0 72 72"><circle class="track" cx="36" cy="36" r="29"></circle>` +
        `<circle class="fill" cx="36" cy="36" r="29" stroke-dasharray="${circumference.toFixed(1)}" ` +
        `stroke-dashoffset="${(circumference * (1 - share)).toFixed(1)}"></circle></svg>`;
      ring.append(el("b", null, `${live.tables_busy}/${live.tables_total}`));
      const figures = el("div");
      figures.append(el("div", "club-money", money(live.revenue_today)), el("div", "club-money-label", "сегодня"));
      figures.append(
        el(
          "div",
          "club-shift",
          live.shift
            ? `${live.shift.cashier} на смене с ${new Date(live.shift.opened_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
            : "смена не открыта"
        )
      );
      row.append(ring, figures);
      tile.append(row);
    } else {
      tile.append(el("div", "club-none", "Программа клуба ещё не открывалась"));
    }
  }

  const tags = el("div", "club-tags");
  if (live?.relays_offline) {
    tags.append(el("span", "club-tag warn", `${live.relays_offline} реле не отвечают`));
  }
  tags.append(subscriptionTag(club));
  if (club.plan_name) tags.append(el("span", "club-tag", club.plan_name));
  if (live?.mirror) {
    const tag = el("span", "club-tag", `снимок ${new Date(live.snapshot_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`);
    tag.title = "Клуб работает у себя и присылает снимок базы, когда есть интернет";
    tags.append(tag);
  }
  if (live?.version) {
    const v = live.version;
    const tag = el("span", `club-tag ${v.current ? "ok" : "warn"}`, `версия ${v.version}`);
    tag.title = v.current ? "Текущая версия" : "Клуб на прежней версии — обновления на его странице";
    tags.append(tag);
  } else if (club.app_version) {
    tags.append(el("span", "club-tag", club.app_version));
  }
  tile.append(tags);

  const actions = el("div", "club-actions");
  actions.append(
    button("Карточка", "mini", () => openClubCard(club.id)),
    button("Оплата", "mini", () => openPaymentModal(club)),
    button("Написать", "mini", () => openMessageForm(club))
  );
  tile.append(actions);
  return tile;
}

async function loadClubs() {
  const params = new URLSearchParams({
    status: "all",
    query: document.getElementById("clubs-search").value,
  });
  const live = await api("/hub/api/live").catch(() => ({}));
  const clubs = await api(`/hub/api/clubs?${params}`);
  state.clubs = clubs;
  state.live = live;
  if (!Object.keys(state.settings).length) {
    state.settings = await api("/hub/api/settings").catch(() => ({}));
  }

  const filter = state.clubFilter;
  const shown = clubs.filter((club) => {
    const isLive = state.live[club.id];
    switch (filter) {
      case "online": return !linkState(club, isLive).silent && club.status !== "archived";
      case "problems": return hasProblems(club, isLive) && club.status !== "archived";
      case "trial": case "overdue": case "blocked": case "archived": return club.status === filter;
      default: return club.status !== "archived";
    }
  });
  // Проблемные — первыми: за ними и заходят в панель.
  shown.sort((a, b) => Number(hasProblems(b, state.live[b.id])) - Number(hasProblems(a, state.live[a.id])));

  const grid = document.getElementById("clubs-grid");
  grid.replaceChildren(...shown.map(buildClubTile));
  const empty = document.getElementById("clubs-empty");
  empty.hidden = shown.length > 0;
  empty.textContent = clubs.length
    ? "Под этот фильтр клубов нет."
    : "Клубов пока нет. Нажмите «Добавить клуб» — и он появится здесь.";
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
          await refreshCurrentTab();
        })
      )
    )
  );
  openModal(club ? `Клуб — ${club.name}` : "Новый клуб", body);
  name.focus();
}

// --- Страница клуба ---------------------------------------------------------
//
// Всё про один клуб в одном месте: что в нём сейчас, подписка и оплаты,
// сотрудники, журнал, копия базы и опасные действия. «Сейчас»,
// «Сотрудники», «Журнал» и «Копия» — из базы клуба: в сети она под
// рукой, у одиночной установки этих вкладок нет.

const CLUB_TABS = [
  ["now", "Сейчас", true],
  ["subscription", "Подписка и оплаты", false],
  ["updates", "Обновления", true],
  ["staff", "Сотрудники", true],
  ["journal", "Журнал клуба", true],
  ["danger", "Копия и опасное", false],
];

const ROLE_LABELS = {
  developer: "разработчик",
  owner: "владелец",
  manager: "управляющий",
  admin: "администратор",
  cashier: "кассир",
};

function formatSeconds(total) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h ? `${h} ч ${String(m).padStart(2, "0")} мин` : `${m} мин`;
}

/** Открывает страницу клуба (раньше — окно). */
async function openClubCard(clubId, tab = null) {
  state.club = { id: clubId, tab: tab ?? state.club?.tab ?? "now" };
  await switchTab("club");
}

function clubTabButton([key, label]) {
  const chip = el("button", `chip${state.club.tab === key ? " on" : ""}`, label);
  chip.dataset.ctab = key;
  chip.addEventListener("click", () => {
    state.club.tab = key;
    loadClubPage();
  });
  return chip;
}

async function loadClubPage() {
  const { id } = state.club;
  const club = await api(`/hub/api/clubs/${id}`);
  // Программа клуба под рукой? В сети — да, если клуб её открывал.
  const program = await api(`/hub/api/clubs/${id}/program/live`).catch(() => null);
  state.clubProgram = program;
  if (!program && ["now", "staff", "journal", "updates"].includes(state.club.tab)) {
    state.club.tab = "subscription";
  }

  document.getElementById("hub-page-title").textContent = club.name;
  document.getElementById("club-page-name").textContent = club.name;
  const tables = program?.tables_total ?? club.tables_count;
  document.getElementById("club-page-sub").textContent = [
    club.city,
    tables ? `${tables} столов` : null,
    [club.owner_name, club.phone].filter(Boolean).join(", ") || null,
    club.email,
  ]
    .filter(Boolean)
    .join(" · ");
  const link = linkState(club, program);
  const linkEl = document.getElementById("club-page-link");
  linkEl.className = `club-link ${link.cls}`;
  linkEl.textContent = link.text;

  const actions = document.getElementById("club-page-actions");
  actions.replaceChildren();
  if (program && !program.mirror) {
    const open = el("a", "primary btn-link", "Войти разработчиком");
    open.title = "Вход в программу клуба своим аккаунтом поддержки; клуб увидит предупреждение";
    open.href = `/hub/api/clubs/${id}/program/open`;
    open.target = "_blank";
    open.rel = "noopener";
    actions.append(open);
  } else if (program?.mirror) {
    const note = el("span", "club-tag");
    note.textContent = `Клуб у себя · снимок ${new Date(program.snapshot_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
    note.title = "Клуб работает на своём компьютере и присылает снимок базы, когда есть интернет. Войти в него — ключом поддержки.";
    actions.append(note);
  }
  actions.append(
    button("Оплата", "mini", () => openPaymentModal(club)),
    button("Написать", "mini", () => openMessageForm(club)),
    button("Изменить", "mini", () => openClubForm(club))
  );

  const tabs = document.getElementById("club-tabs");
  tabs.replaceChildren(
    ...CLUB_TABS.filter(([, , needsProgram]) => !needsProgram || program).map(clubTabButton)
  );

  const body = document.getElementById("club-tab-body");
  body.replaceChildren();
  switch (state.club.tab) {
    case "now": body.append(buildNowTab(program)); break;
    case "staff": body.append(await buildStaffTab(id)); break;
    case "updates": body.append(await buildUpdatesTab(id)); break;
    case "journal": body.append(await buildJournalTab(id)); break;
    case "danger": body.append(buildDangerTab(club, program)); break;
    default: body.append(await buildSubscriptionTab(club));
  }
}

function buildNowTab(live) {
  const wrap = el("div", "hub-page");
  const cards = el("div", "kpis");
  cards.append(
    kpiCard(live.tables_busy, "занято столов", (v) => `${v} / ${live.tables_total}`),
    kpiCard(live.revenue_today, "сегодня", moneyShort, { cls: "flat", text: `${live.sessions_today} сеансов` }),
    kpiCard(live.revenue_yesterday, "вчера", moneyShort),
    kpiCard(live.revenue_week, "за 7 дней", moneyShort),
    kpiCard(
      live.shift ? live.shift.cashier : "—",
      live.shift
        ? `на смене с ${new Date(live.shift.opened_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
        : "смена не открыта",
      (v) => v
    ),
    kpiCard(live.relays_offline, "реле не отвечают", (v) => `${v} / ${live.relays_total}`)
  );
  wrap.append(cards);

  const tablesPanel = el("div", "hub-panel");
  tablesPanel.append(el("h2", null, "Столы"));
  const table = el("table", "hub-table");
  renderTable(
    table,
    [
      { title: "Стол", render: (t) => t.name },
      {
        title: "Состояние",
        render: (t) => {
          const pill = el("span", `pill ${t.busy ? "pill-active" : "pill-archived"}`, t.busy ? (t.prepaid ? "предоплата" : "занят") : "свободен");
          return pill;
        },
      },
      { title: "Время", render: (t) => (t.busy ? formatSeconds(t.elapsed_seconds) : "—") },
      { title: "Сумма", className: "num", render: (t) => (t.busy ? money(t.cost) : "—") },
      {
        title: "Реле",
        render: (t) => {
          if (!t.relay) return el("span", "muted", "без реле");
          const state = t.relay.online === true ? ["ok", "в сети"] : t.relay.online === false ? ["bad", "нет связи"] : ["muted", "не проверяется"];
          return el("span", `device-link ${state[0]}`, `${relayKindLabel(t.relay.kind)} · ${state[1]}`);
        },
      },
    ],
    live.tables,
    "Столов в клубе ещё нет."
  );
  tablesPanel.append(table);
  wrap.append(tablesPanel);

  if (live.devices.length) {
    const devPanel = el("div", "hub-panel");
    devPanel.append(el("h2", null, "Устройства зала"));
    const dev = el("table", "hub-table");
    renderTable(
      dev,
      [
        { title: "Устройство", render: (d) => d.name },
        {
          title: "Состояние",
          render: (d) =>
            d.type === "damper"
              ? d.position ? `открыта на ${d.position}%` : "закрыта"
              : d.is_on ? "работает" : "стоит",
        },
        { title: "Цикл", render: (d) => (d.type === "damper" ? "—" : d.cycle_on ? `${d.work_minutes}/${d.rest_minutes} мин` : "выключен") },
        {
          title: "Реле",
          render: (d) => {
            if (!d.relay) return el("span", "muted", "без реле");
            const state = d.relay.online === true ? ["ok", "в сети"] : d.relay.online === false ? ["bad", "нет связи"] : ["muted", "не проверяется"];
            return el("span", `device-link ${state[0]}`, state[1]);
          },
        },
      ],
      live.devices,
      ""
    );
    devPanel.append(dev);
    wrap.append(devPanel);
  }
  return wrap;
}

/** Новшества клуба: код общий, а что видит клуб — решает эта вкладка. */
async function buildUpdatesTab(clubId) {
  const data = await api(`/hub/api/clubs/${clubId}/program/features`);
  const { features, enabled, versions, version } = data;
  const panel = el("div", "hub-panel");
  const onCount = features.filter((f) => enabled[f.key]).length;
  panel.append(
    el("h2", null, `Обновления клуба`),
    el(
      "p",
      "hint",
      "Программа у всех клубов одна, но новшества включаются каждому клубу отдельно: " +
        "пилотному включили — остальные сидят на прежнем, пока не проверили. " +
        `Сейчас включено ${onCount} из ${features.length}.`
    )
  );
  const save = guard(async (patch, text) => {
    await api(`/hub/api/clubs/${clubId}/program/features`, { method: "PUT", body: JSON.stringify(patch) });
    showToast(text, true);
    await loadClubPage();
  });

  // Версия ступенью: выбрал — получил ровно то, что было в той версии.
  const versionBox = el("div", "version-box");
  const current = el("div");
  current.append(
    el("span", "hint", "Версия клуба: "),
    el("b", "version-now", `${version.version}${version.current ? " (текущая)" : ""}`)
  );
  const select = document.createElement("select");
  for (const step of versions) {
    const option = document.createElement("option");
    option.value = step.version;
    option.textContent = `${step.version} — ${step.label}`;
    select.append(option);
  }
  select.value = version.version;
  const pick = el("div", "row-actions");
  pick.append(
    select,
    button("Поставить версию", "primary", () =>
      save({ version: select.value }, `Клубу поставлена версия ${select.value}`)
    )
  );
  versionBox.append(current, pick);
  panel.append(versionBox);
  const list = el("div", "feature-list");
  for (const feature of features) {
    const row = el("div", `feature-row${enabled[feature.key] ? " on" : ""}`);
    const text = el("div");
    text.append(el("b", null, feature.label), el("div", "hint", `${feature.hint} С версии ${feature.since}.`));
    const toggle = button(
      enabled[feature.key] ? "Включено" : "Выключено",
      `mini${enabled[feature.key] ? " on" : ""}`,
      () => save({ [feature.key]: !enabled[feature.key] }, `${feature.label}: ${enabled[feature.key] ? "выключено" : "включено"}`)
    );
    row.append(text, toggle);
    list.append(row);
  }
  panel.append(list);
  const newest = versions[versions.length - 1].version;
  const base = versions[0].version;
  panel.append(
    actionsRow(
      button("Обновить до текущей версии", "primary", () => save({ version: newest }, `Клубу поставлена текущая версия ${newest}`)),
      button("Откатить всё новое", "mini danger", () => save({ version: base }, `Клуб откатан на ${base} — без новшеств`))
    )
  );
  return panel;
}

async function buildStaffTab(clubId) {
  const users = await api(`/hub/api/clubs/${clubId}/program/users`);
  const panel = el("div", "hub-panel");
  panel.append(el("h2", null, "Сотрудники клуба"));
  panel.append(
    el("p", "hint", "Новый пароль, отключение и роль — то же, что делает владелец клуба у себя; каждое действие подписывается панелью сети в журнале клуба.")
  );
  const table = el("table", "hub-table");
  const reload = () => loadClubPage();
  const mirror = Boolean(state.clubProgram?.mirror);
  if (mirror) {
    panel.append(el("p", "hint", "Клуб работает у себя: панель видит снимок его базы. Пароли и доступ меняют в самой программе клуба."));
  }
  renderTable(
    table,
    [
      { title: "Логин", render: (u) => u.login },
      { title: "Имя", render: (u) => u.name },
      { title: "Роль", render: (u) => ROLE_LABELS[u.role] ?? u.role },
      { title: "Доступ", render: (u) => el("span", `pill ${u.is_active ? "pill-active" : "pill-archived"}`, u.is_active ? "открыт" : "закрыт") },
      {
        title: "",
        className: "row-actions-cell",
        render: (u) => {
          const wrap = el("div", "row-actions");
          if (mirror) return wrap;
          wrap.append(
            button("Новый пароль", "mini", () => openPasswordModal(clubId, u, reload)),
            button(
              u.is_active ? "Закрыть доступ" : "Открыть доступ",
              `mini${u.is_active ? " danger" : ""}`,
              guard(async () => {
                await api(`/hub/api/clubs/${clubId}/program/users/${u.id}`, {
                  method: "PUT",
                  body: JSON.stringify({ is_active: !u.is_active }),
                });
                showToast(u.is_active ? `${u.login}: доступ закрыт` : `${u.login}: доступ открыт`, true);
                await reload();
              })
            )
          );
          return wrap;
        },
      },
    ],
    users,
    "В программе клуба ещё нет сотрудников."
  );
  panel.append(table);
  return panel;
}

function openPasswordModal(clubId, user, reload) {
  const body = el("div");
  body.append(el("p", "hint", `Новый пароль для ${user.name} (${user.login}). Старый перестанет работать сразу.`));
  const input = textInput("", "минимум 4 символа");
  input.type = "text";
  body.append(field("Пароль", input));
  body.append(
    actionsRow(
      button("Поставить пароль", "primary", guard(async () => {
        await api(`/hub/api/clubs/${clubId}/program/users/${user.id}`, {
          method: "PUT",
          body: JSON.stringify({ password: input.value }),
        });
        closeModal();
        showToast(`${user.login}: пароль обновлён`, true);
        await reload();
      }))
    )
  );
  openModal(`Пароль — ${user.login}`, body);
  input.focus();
}

async function buildJournalTab(clubId) {
  const entries = await api(`/hub/api/clubs/${clubId}/program/journal`);
  const panel = el("div", "hub-panel");
  panel.append(el("h2", null, "Журнал клуба"), el("p", "hint", "Последние 100 записей из программы клуба: кто что нажимал."));
  const table = el("table", "hub-table");
  renderTable(
    table,
    [
      { title: "Когда", render: (e) => dateTime(e.created_at) },
      { title: "Что", render: (e) => e.message },
    ],
    entries,
    "Журнал клуба пуст."
  );
  panel.append(table);
  return panel;
}

async function buildSubscriptionTab(club) {
  const clubId = club.id;
  const payments = await api(`/hub/api/clubs/${clubId}/payments`);
  const body = el("div", "hub-page");
  const split = el("div", "hub-split");

  const info = el("div", "hub-panel");
  info.append(el("h2", null, "Подписка"));
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
  line("Статус", statusPill(club));
  line("Тариф", club.plan_name ?? "не назначен");
  line("Оплачено до", date(club.paid_until));
  if (club.grace_until) line("Отсрочка до", date(club.grace_until));
  line("Получено всего", money(club.paid_total));
  line("Клуб в сети с", date(club.created_at));
  if (club.note) line("Заметка", club.note);
  info.append(lines);
  info.append(
    actionsRow(
      button("Отметить оплату", "primary", () => openPaymentModal(club)),
      button("Дать отсрочку", "mini", () => openGraceModal(club))
    )
  );

  // Ключ доступа: его вписывают в программу клуба один раз.
  const key = el("details");
  key.append(el("summary", null, "Ключ доступа для программы клуба"));
  key.append(el("div", "key-box", club.api_key));
  key.append(
    el("p", "hint", "Вписывается в программе клуба один раз. Если ключ утёк — выдайте новый: старый перестанет работать сразу."),
    button("Выдать новый ключ", "mini danger", guard(async () => {
      await api(`/hub/api/clubs/${clubId}/key`, { method: "POST" });
      showToast("Выдан новый ключ — впишите его в программе клуба", true);
      await loadClubPage();
    }))
  );
  info.append(key);
  split.append(info);

  const history = el("div", "hub-panel");
  history.append(el("h2", null, "История оплат"));
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
  history.append(table);
  split.append(history);
  body.append(split);
  return body;
}

function buildDangerTab(club, program) {
  const clubId = club.id;
  const wrap = el("div", "hub-page");

  if (program) {
    const backup = el("div", "hub-panel");
    backup.append(el("h2", null, "Копия базы клуба"));
    backup.append(el("p", "hint", "Файл .db со всем клубом: столы, история, клиенты, сотрудники, настройки. Скачивание пишется в журнал сети."));
    const link = el("a", "mini btn-link", "Скачать копию базы");
    link.href = `/hub/api/clubs/${clubId}/program/backup`;
    backup.append(actionsRow(link));
    wrap.append(backup);

    const shift = el("div", "hub-panel");
    shift.append(el("h2", null, "Смена"));
    shift.append(
      el("p", "hint", program.shift
        ? `Открыта: ${program.shift.cashier} с ${dateTime(program.shift.opened_at)}.` +
          (program.mirror ? " Клуб работает у себя — закрыть смену можно только в его программе." : " Закрыть можно отсюда — от имени того, кто открывал, с пометкой панели сети.")
        : "Открытой смены нет.")
    );
    if (program.shift && !program.mirror) {
      shift.append(
        actionsRow(
          button("Закрыть смену", "mini danger", guard(async () => {
            await api(`/hub/api/clubs/${clubId}/program/shift/close`, { method: "POST" });
            showToast("Смена закрыта", true);
            await loadClubPage();
          }))
        )
      );
    }
    wrap.append(shift);
  }

  const danger = el("div", "hub-panel");
  danger.append(el("h2", null, "Доступ клуба к сети"));
  danger.append(
    el("p", "hint", "Блокировка сильнее любых дат: программа клуба перестаёт пускать сотрудников, пока клуб не разблокируют. Архив — клуб выбывает из сети, но его данные остаются.")
  );
  const actions = el("div", "hub-modal-actions");
  if (club.status === "archived") {
    actions.append(
      button("Вернуть из архива", "mini", guard(async () => {
        await api(`/hub/api/clubs/${clubId}/restore`, { method: "POST" });
        showToast("Клуб возвращён в сеть", true);
        await loadClubPage();
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
          await loadClubPage();
        })
      ),
      button("В архив", "mini danger", guard(async () => {
        await api(`/hub/api/clubs/${clubId}/archive`, { method: "POST" });
        showToast("Клуб отправлен в архив", true);
        state.club = null;
        await switchTab("clubs");
      })),
      button("Ключ для поддержки", "mini", () => openSupportModal(club))
    );
  }
  danger.append(actions);
  wrap.append(danger);
  return wrap;
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

/** Новшества по всей сети: у скольких включено, включить/выключить всем. */
async function renderNetworkFeatures() {
  const host = document.getElementById("network-features");
  const data = await api("/hub/api/features").catch(() => null);
  host.replaceChildren();
  if (!data || !data.clubs_total) {
    host.append(el("p", "hub-empty", "Клубов с программой пока нет — включать новшества некому."));
    return;
  }
  const versionRow = el("div", "feature-row");
  const versionText = el("div");
  versionText.append(el("b", null, "Версия всем клубам"), el("div", "hint", `Текущая версия программы — ${data.current_version}. Выбранная ступень ставится всем клубам разом.`));
  const select = document.createElement("select");
  for (const step of data.versions) {
    const option = document.createElement("option");
    option.value = step.version;
    option.textContent = `${step.version} — ${step.label}`;
    select.append(option);
  }
  select.value = data.current_version;
  const versionActions = el("div", "row-actions");
  versionActions.append(
    select,
    button("Поставить всем", "primary", guard(async () => {
      const result = await api("/hub/api/features/version", { method: "PUT", body: JSON.stringify({ version: select.value }) });
      showToast(`Версия ${result.version} поставлена ${result.updated} клубам`, true);
      await renderNetworkFeatures();
    }))
  );
  versionRow.append(versionText, versionActions);
  host.append(versionRow);

  for (const feature of data.features) {
    const row = el("div", "feature-row");
    const text = el("div");
    text.append(
      el("b", null, feature.label),
      el("div", "hint", `${feature.hint} С версии ${feature.since}. Включено у ${feature.enabled_count} из ${data.clubs_total} клубов.`)
    );
    const set = (enabled) =>
      guard(async () => {
        const result = await api(`/hub/api/features/${feature.key}`, {
          method: "PUT",
          body: JSON.stringify({ enabled }),
        });
        showToast(`${feature.label}: ${enabled ? "включено" : "выключено"} у ${result.updated} клубов`, true);
        await renderNetworkFeatures();
      });
    const actions = el("div", "row-actions");
    actions.append(button("Включить всем", "mini", set(true)), button("Выключить всем", "mini danger", set(false)));
    row.append(text, actions);
    host.append(row);
  }
}

async function loadSettings() {
  await renderNetworkFeatures();
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
  club: loadClubPage,
};

function refreshCurrentTab() {
  return guard(LOADERS[state.tab])();
}

async function switchTab(tab) {
  state.tab = tab;
  document.getElementById("hub-page-title").textContent = TAB_TITLES[tab] ?? "";
  // Страница клуба живёт под пунктом «Клубы».
  const navTab = tab === "club" ? "clubs" : tab;
  for (const button of document.querySelectorAll(".hub-tab")) {
    button.classList.toggle("on", button.dataset.tab === navTab);
  }
  for (const page of document.querySelectorAll(".hub-page")) {
    page.hidden = page.dataset.page !== tab;
  }
  // Список клубов нужен окнам «написать клубу» и карточкам, а тарифы —
  // выпадающему списку в карточке клуба: держим их наготове.
  if ((tab === "clubs" || tab === "club") && !state.plans.length) {
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
  for (const chip of document.querySelectorAll("#clubs-filters .chip")) {
    chip.addEventListener("click", () => {
      state.clubFilter = chip.dataset.filter;
      for (const other of document.querySelectorAll("#clubs-filters .chip")) {
        other.classList.toggle("on", other === chip);
      }
      loadClubs();
    });
  }

  // Тема — общая с программой клуба.
  const themeToggle = document.getElementById("theme-toggle");
  themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("billiards_theme", next);
    } catch (e) {
      // приватный режим — тема живёт до перезагрузки
    }
  });

  // Плитки клубов и сводка живут: раз в полминуты перечитываем, пока
  // открыта соответствующая вкладка. Открытое окно это не трогает.
  setInterval(() => {
    if (["clubs", "overview", "club"].includes(state.tab)) refreshCurrentTab();
  }, 30000);
  document.getElementById("club-back").addEventListener("click", () => switchTab("clubs"));
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
