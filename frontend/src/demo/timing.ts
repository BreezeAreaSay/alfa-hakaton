// Длительности работы конвейера. Масштаб меняет только проверка demo-selfcheck, чтобы не ждать минутами.
export const timing = { scale: 1 };

export const scaled = (ms: number): number => ms * timing.scale;

/** Случайный разброс ±30 % — как задержки симулятора внешних систем. */
export const jitter = (ms: number): number => scaled(ms * (0.7 + Math.random() * 0.6));

// Паузы постоянные: задания берутся строго по очереди, как из очереди заданий на сервере.

/** Пауза, через которую обработчик берёт новое задание из очереди. */
export const pickupDelay = (): number => scaled(500);

/** Пауза между шагами: обработчик сразу берёт следующее задание. */
export const stepGap = (): number => scaled(150);

/** Время ответа имитации на запрос интерфейса, как у сети до настоящего сервера. */
export const requestLatency = (): number => scaled(30 + Math.random() * 60);
