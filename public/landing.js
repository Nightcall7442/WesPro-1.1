// Лендинг: переключатель темы (тот же ключ localStorage, что и в рабочем
// интерфейсе — если гость потом войдёт в систему, тема не «прыгнет»).
"use strict";

(() => {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;
  const apply = (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("billiards_theme", theme);
    } catch (e) {
      // Приватное окно или отключён localStorage — тема просто не запомнится.
    }
  };
  toggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    apply(next);
  });
})();
