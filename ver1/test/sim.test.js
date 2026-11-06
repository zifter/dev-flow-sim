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

for (const which of ['A', 'B']) {
  test(`переходы в кадрах сходятся с числом задач на этапах, сценарий ${which}`, () => {
    const r = sim.simulate(EXAMPLE, which);
    const n = r.stages.length;
    assert.ok(r.stages.some(s => s.reworkTo >= 0), 'в примере должны быть возвраты');
    const inStage = (f, i) => f.w[i] + f.k[i];
    let done = 0;
    for (let j = 1; j < r.frames.length; j++) {
      const f = r.frames[j], p = r.frames[j - 1];
      for (let i = 0; i < n; i++) {
        let inflow = i === 0 ? f.arr - p.arr : f.mv[i - 1];
        r.stages.forEach((s, k) => { if (s.reworkTo === i) inflow += f.rw[k]; });
        const outflow = f.mv[i] + f.rw[i];
        assert.strictEqual(inStage(f, i) - inStage(p, i), inflow - outflow, `кадр ${j}, этап ${r.stages[i].name}`);
      }
      done += f.mv[n - 1];
    }
    assert.strictEqual(done + r.frames[0].mv[n - 1], r.frames[r.frames.length - 1].done);
  });
}

test('CI/CD не ускоряется агентом, не стоит в очереди и не занимает людей', () => {
  const cfg = JSON.parse(JSON.stringify(long));
  cfg.stages.find(s => s.id === 'ci').agent.on = true;
  const b = sim.simulate(cfg, 'B');
  const st = b.stages.find(s => s.id === 'ci');
  assert.strictEqual(st.agentOn, false);
  assert.strictEqual(st.avgWait, 0);
  assert.ok(Math.abs(st.avgTouch - 7 / 12) < 0.03, `сборка ${st.avgTouch}`); // среднее (0,25 + 0,5 + 1) / 3
  assert.ok(!b.pools.some(p => p.key.endsWith(':ci')));
  assert.ok(!sim.analyze(cfg, 'B').bottleneckStages[1]);
});

test('деньги на CI/CD: симуляция совпадает с аналитикой', () => {
  for (const which of ['A', 'B']) {
    const r = sim.simulate(long, which), a = sim.analyze(long, which);
    const err = Math.abs(r.ci.costPerWeek - a.ci.costPerWeek) / a.ci.costPerWeek;
    assert.ok(err < 0.06, `${which}: ${r.ci.costPerWeek} vs ${a.ci.costPerWeek}`);
  }
});

test('мощность укорачивает сборку по Амдалу и дорожает', () => {
  const at = power => {
    const cfg = JSON.parse(JSON.stringify(EXAMPLE));
    cfg.stages.find(s => s.id === 'ci').ci.power = power;
    return sim.analyze(cfg, 'A').ci;
  };
  const x1 = at(1), x4 = at(4), inf = at(1e6);
  assert.ok(Math.abs(x4.hoursPerTask / x1.hoursPerTask - (0.3 + 0.7 / 4)) < 1e-6);
  assert.ok(inf.hoursPerTask / x1.hoursPerTask > 0.29); // потолок — непараллельная доля 30%
  assert.ok(x4.costPerTask > x1.costPerTask);
});
