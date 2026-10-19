// Проверки модели: закон Литтла и согласие симулированной загрузки с аналитикой.
// Запуск: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const sim = require('../sim.js');
const EXAMPLE = require('../example.js');

const long = Object.assign({}, EXAMPLE, { horizonWeeks: 104, warmupWeeks: 8 });

for (const which of ['A', 'B']) {
  test(`закон Литтла выполняется, сценарий ${which}`, () => {
    const r = sim.simulate(long, which);
    const littleWip = (r.throughput / sim.HOURS_PER_WEEK) * r.leadMean;
    const err = Math.abs(littleWip - r.wipAvg) / r.wipAvg;
    assert.ok(err < 0.08, `WIP ${r.wipAvg.toFixed(2)} vs λ·W ${littleWip.toFixed(2)} (ошибка ${(err * 100).toFixed(1)}%)`);
  });

  test(`загрузка ролей совпадает с аналитикой, сценарий ${which}`, () => {
    const r = sim.simulate(long, which);
    const a = sim.analyze(long, which);
    for (const p of a.pools) {
      const s = r.pools.find(x => x.key === p.key);
      assert.ok(s, `нет роли ${p.key} в симуляции`);
      assert.ok(Math.abs(s.util - p.rho) < 0.06, `${p.label}: симуляция ${(s.util * 100).toFixed(1)}%, аналитика ${(p.rho * 100).toFixed(1)}%`);
    }
  });
}

test('рабочий календарь', () => {
  const s = sim.makeSchedule(8, 5);
  assert.strictEqual(s.addWork(0, 8), 8);
  assert.strictEqual(s.addWork(0, 9), 25);
  assert.strictEqual(s.addWork(4 * 24, 9), 7 * 24 + 1); // пятница → понедельник
  assert.strictEqual(s.workBetween(0, 168), 40);
});

test('перегрузка видна в аналитике', () => {
  const cfg = JSON.parse(JSON.stringify(EXAMPLE));
  cfg.arrival.perWeek = 30;
  const a = sim.analyze(cfg, 'A');
  assert.ok(a.pools.some(p => p.rho > 1));
  const r = sim.simulate(cfg, 'A');
  assert.ok(r.wipEnd > r.wipStart * 2);
});
