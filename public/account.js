// Кабинет владельца клуба: своя подписка, ключ доступа, история оплат,
// смена пароля. Отдельная страница от панели сети (/hub) — тут виден
// только собственный клуб, а не вся сеть.
"use strict";

const STATUS_LABELS = {
  trial: "пробный период",
  active: "активна",
  overdue: "просрочена",
  blocked: "заблокирован",
  archived: "в архиве",
};

function money(value) {
  return `${(Number(value) || 0).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} сум`;
}

function date(iso) {
  return iso ? new Date(iso).toLocaleDateString("ru-RU") : "—";
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  if (response.status === 401) {
    window.location.href = "/account/login";
    throw new Error("Требуется вход");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail ?? `Ошибка ${response.status}`);
  return body;
}

async function load() {
  const { club, payments, network } = await api("/account/api/account");
  document.getElementById("program-panel").hidden = !network;

  document.getElementById("club-title").textContent = club.name;
  document.title = `${club.name} — кабинет клуба`;

  const statusEl = document.getElementById("club-status");
  statusEl.textContent = STATUS_LABELS[club.status] ?? club.status;
  statusEl.className = `pill pill-${club.status}`;

  document.getElementById("club-plan").textContent = club.plan_name ?? "не назначен";
  document.getElementById("club-until").textContent = date(club.paid_until);
  document.getElementById("club-days").textContent =
    club.days_left === null ? "—" : club.days_left < 0 ? "истёк" : String(club.days_left);
  document.getElementById("club-key").textContent = club.api_key;
  document.getElementById("staff-link").textContent = club.slug
    ? `${window.location.origin}/login/adminpanel/${club.slug}`
    : "—";

  const table = document.getElementById("payments-table");
  if (!payments.length) {
    table.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "acc-empty";
    empty.textContent = "Оплат пока не было — идёт пробный период.";
    table.after(empty);
  } else {
    const head = document.createElement("tr");
    for (const title of ["Когда", "Сумма", "Дней", "До"]) {
      const th = document.createElement("th");
      th.textContent = title;
      head.append(th);
    }
    const rows = payments.map((p) => {
      const tr = document.createElement("tr");
      for (const text of [date(p.created_at), money(p.amount), String(p.days), date(p.paid_until)]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    });
    table.replaceChildren(head, ...rows);
  }
}

document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/account/api/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/account/login";
});

document.getElementById("password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("password-msg");
  msg.textContent = "";
  msg.className = "acc-msg";
  try {
    await api("/account/api/password", {
      method: "POST",
      body: JSON.stringify({
        old_password: document.getElementById("old-password").value,
        new_password: document.getElementById("new-password").value,
      }),
    });
    msg.textContent = "Пароль изменён";
    msg.className = "acc-msg ok";
    document.getElementById("password-form").reset();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "acc-msg err";
  }
});

// Тема — тот же ключ localStorage, что и везде в системе.
(() => {
  const toggle = document.getElementById("theme-toggle");
  toggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("billiards_theme", next);
    } catch (e) {
      // Приватное окно — тема просто не запомнится.
    }
  });
})();

load().catch((err) => {
  if (err.message !== "Требуется вход") console.error(err);
});
