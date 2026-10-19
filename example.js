// Пример конфигурации: условная продуктовая команда. Цифры придуманы для демонстрации.
(function (root) {
  'use strict';
  const EXAMPLE = {
    version: 1,
    name: 'Пример: продуктовая команда',
    arrival: { mode: 'flow', perWeek: 12, backlog: 120, multB: 1 },
    horizonWeeks: 26,
    warmupWeeks: 4,
    seed: 42,
    hoursPerDay: 8,
    daysPerWeek: 5,
    agents247: true,
    downstreamFirst: true,
    reworkFactor: 40,
    pools: [
      { id: 'dev', name: 'Разработчики', count: 6 },
      { id: 'lead', name: 'Ревьюеры', count: 2 },
      { id: 'qa', name: 'QA', count: 2 },
      { id: 'ops', name: 'DevOps', count: 1 },
    ],
    stages: [
      {
        id: 'dev', name: 'Разработка', pool: 'dev', min: 4, mode: 8, max: 24, rework: null,
        agent: { on: true, speed: 10, count: 4, oversight: 1.5, oversightPool: 'dev' },
      },
      {
        id: 'review', name: 'Код-ревью', pool: 'lead', min: 0.5, mode: 1.5, max: 4,
        rework: { to: 'dev', p: 30, pAgent: 40 },
        agent: { on: false, speed: 5, count: 2, oversight: 0.5, oversightPool: 'lead' },
      },
      {
        id: 'qa', name: 'Тестирование', pool: 'qa', min: 1, mode: 3, max: 8,
        rework: { to: 'dev', p: 20, pAgent: 25 },
        agent: { on: false, speed: 4, count: 2, oversight: 1, oversightPool: 'qa' },
      },
      {
        id: 'deploy', name: 'Мерж и деплой', pool: 'ops', min: 0.25, mode: 0.5, max: 2, rework: null,
        agent: { on: false, speed: 5, count: 1, oversight: 0.25, oversightPool: 'ops' },
      },
    ],
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = EXAMPLE;
  else root.DEVFLOW_EXAMPLE = EXAMPLE;
})(typeof window !== 'undefined' ? window : this);
