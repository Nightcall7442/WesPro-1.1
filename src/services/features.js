// Новшества программы, которые включаются каждому клубу отдельно.
//
// Код у всех клубов один — сервер общий, — а «версия» клуба складывается
// из того, что ему включено. Так обновление раскатывается по клубам по
// одному: пилотному включили, остальные сидят на прежнем, пока не
// проверили. Флаги живут в настройках клуба (feature_<ключ>), по
// умолчанию всё включено: новый клуб получает программу целиком, а
// одиночная установка новшеств не прячет.
//
// Версии — это ступени: «поставить клубу 1.14.0» значит включить всё,
// что появилось до 1.14.0 включительно, и выключить остальное.
export const FEATURES = Object.freeze([
  {
    key: "board",
    label: "Экран для гостей",
    hint: "Страница /board для телевизора в зале: свободные столы и цены.",
    since: "1.9.0",
  },
  {
    key: "devices",
    label: "Устройства зала",
    hint:
      "Кондиционер, вытяжка, приток, решётки каналов: раздел «Устройства», " +
      "полоска в зале, устройства на плане, реле с IP и MAC.",
    since: "1.15.0",
  },
  {
    key: "motion",
    label: "Анимации интерфейса",
    hint: "Живые иконки устройств, счётчик на плитке стола, мерцание при загрузке.",
    since: "1.15.0",
  },
]);

/** Версия до всех перечисленных новшеств — «откатить всё новое». */
export const BASE_VERSION = "1.8.0";

/** Ключ настройки, в котором лежит флаг новшества. */
export function featureSettingKey(key) {
  return `feature_${key}`;
}

/** Сравнение версий «1.15.0» и «1.9.0» по числам, не по буквам. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/**
 * Ступени версий, на которые можно поставить клуб: базовая (без новшеств),
 * каждая версия, с которой что-то появилось, и текущая версия программы.
 * @param {string} current версия программы из package.json
 * @returns {Array<{version: string, features: string[], label: string}>}
 */
export function versionSteps(current) {
  const versions = new Set([BASE_VERSION, ...FEATURES.map((f) => f.since)]);
  if (compareVersions(current, BASE_VERSION) > 0) versions.add(current);
  return [...versions]
    .sort(compareVersions)
    .map((version) => ({
      version,
      features: FEATURES.filter((f) => compareVersions(f.since, version) <= 0).map((f) => f.key),
      label:
        version === BASE_VERSION
          ? "без новшеств"
          : version === current
            ? "текущая"
            : FEATURES.filter((f) => f.since === version).map((f) => f.label).join(", "),
    }));
}

/** Какие новшества включает версия: {devices: true, …}. */
export function featuresForVersion(version) {
  return Object.fromEntries(
    FEATURES.map((f) => [f.key, compareVersions(f.since, version) <= 0])
  );
}

/**
 * Версия клуба по включённым новшествам: всё включено — текущая; иначе
 * самая старшая ступень, которая включена целиком. Частично включённая
 * версия помечается — значит, кто-то включал по одному.
 * @param {Record<string, boolean>} enabled
 * @param {string} current
 */
export function versionOf(enabled, current) {
  const steps = versionSteps(current);
  let matched = steps[0];
  for (const step of steps) {
    if (step.features.every((key) => enabled[key])) matched = step;
  }
  const extra = FEATURES.some((f) => enabled[f.key] && !matched.features.includes(f.key));
  return { version: matched.version, partial: extra, current: matched.version === current };
}
