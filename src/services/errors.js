// Доменные ошибки. Сервисы бросают их, а HTTP-слой единообразно
// превращает в ответы: NotFoundError -> 404, ConflictError -> 409.

export class DomainError extends Error {}

/** Запрошенная сущность не существует. */
export class NotFoundError extends DomainError {}

/** Действие противоречит текущему состоянию (занятый/свободный стол и т.п.). */
export class ConflictError extends DomainError {}

/** Пользователь не вошёл в систему. */
export class UnauthorizedError extends DomainError {}

/** Действие доступно только администратору. */
export class ForbiddenError extends DomainError {}
