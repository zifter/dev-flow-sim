// Проверки движка визуализации. Запуск: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const F = require('../flow.js');

const copy = o => JSON.parse(JSON.stringify(o));
// Узкая специализация: второй бэкендер берёт только Client — три клиентщика и один бэкендер.
const narrowTeam = () => { const c = copy(F.EXAMPLE); Object.assign(c.team.find(m => m.id === 'be2'), { name: 'Client 3', domains: ['Client'] }); return c; };

// Простой процесс для проверок правил: PM → бэклог → разработка → ревью → QA, одна роль разработчика.
const BASIC = {
  version: 2, name: 'Базовый процесс', humanHours: 8, agentHours: 24, humanDays: 5, agentDays: 7,
  roles: [{ id: 'pm', name: 'Product Manager' }, { id: 'dev', name: 'Разработчик' }, { id: 'qa', name: 'QA' }],
  team: [
    { id: 'pm1', name: 'Product Manager', role: 'pm', kind: 'human' },
    { id: 'dev1', name: 'Разработчик 1', role: 'dev', kind: 'human' },
    { id: 'dev2', name: 'Разработчик 2', role: 'dev', kind: 'human' },
    { id: 'qa1', name: 'QA', role: 'qa', kind: 'human' },
  ],
  stages: [
    { id: 'spec', name: 'Постановка', role: 'pm' },
    { id: 'backlog', name: 'Бэклог', role: null, limit: 0 },
    { id: 'dev', name: 'Разработка', role: 'dev' },
    { id: 'review', name: 'Код-ревью', role: 'dev' },
    { id: 'qa', name: 'Тестирование', role: 'qa' },
  ],
  types: [
    { id: 'xs', name: 'Story XS', weight: 1, sp: 1, hours: { spec: 0.5, dev: 1, review: 0.25, qa: 0.5 } },
    { id: 's', name: 'Story S', weight: 2, sp: 2, hours: { spec: 1, dev: 3, review: 0.5, qa: 1 } },
    { id: 'm', name: 'Story M', weight: 3, sp: 3, hours: { spec: 2, dev: 6, review: 1.5, qa: 3 } },
    { id: 'l', name: 'Story L', weight: 2, sp: 5, hours: { spec: 3, dev: 12, review: 2, qa: 5 } },
    { id: 'xl', name: 'Story XL', weight: 1, sp: 8, hours: { spec: 4, dev: 24, review: 3, qa: 8 } },
    { id: 'bug', name: 'Bug', weight: 3, sp: 1, hours: { spec: 0.5, dev: 3, review: 0.5, qa: 1.5 } },
  ],
};
const doneAt = events => events.filter(e => e.type === 'done').map(e => +e.at.toFixed(6));

function run(cfg, hours, dt, onStep) {
  const st = F.create(cfg);
  const events = [];
  for (let h = 0; h < hours; h += dt) {
    events.push(...F.step(st, dt));
    if (onStep) onStep(st);
  }
  return { st, events };
}

// Один этап, одна роль, один исполнитель: удобно проверять календарь.
function solo(kind, extra) {
  return Object.assign({
    version: 2, humanHours: 8, agentHours: 24,
    roles: [{ id: 'dev', name: 'Разработчик' }],
    team: [{ id: 'w', name: 'Исполнитель', role: 'dev', kind, speed: 1 }],
    stages: [{ id: 'dev', name: 'Разработка', role: 'dev' }],
    types: [{ id: 't', name: 'Задача', weight: 1, hours: { dev: 6 } }],
  }, extra);
}

test('задачи не теряются: создано = готово + в работе', () => {
  const { st, events } = run(BASIC, 400, 0.5);
  const created = events.filter(e => e.type === 'new').length;
  assert.ok(st.doneCount > 10, `готово ${st.doneCount}`);
  assert.strictEqual(created, st.doneCount + st.tasks.length);
});

test('у участника одна задача, роль совпадает с этапом, бэклог не больше лимита', () => {
  const cfg = copy(BASIC);
  cfg.stages[1].limit = 5;
  const S = F.normalize(cfg).stages;
  run(cfg, 400, 0.25, st => {
    st.people.forEach(p => {
      const mine = st.tasks.filter(t => t.person === p.id);
      assert.ok(mine.length <= 1);
      if (p.task != null) assert.strictEqual(mine[0].id, p.task);
    });
    st.tasks.filter(t => t.state === 'work').forEach(t => {
      const p = st.people.find(x => x.id === t.person);
      assert.strictEqual(p.role, F.performer(S[t.stage]));
    });
    assert.ok(st.tasks.filter(t => t.stage <= 1).length <= S[1].limit);
  });
});

test('ревью делает не автор кода', () => {
  const { events } = run(BASIC, 400, 0.5);
  const by = {};
  events.filter(e => e.type === 'start').forEach(e => { (by[e.task] = by[e.task] || {})[e.stage] = e.person; });
  const reviewed = Object.values(by).filter(x => x[3]);
  assert.ok(reviewed.length > 5);
  reviewed.forEach(x => assert.notStrictEqual(x[2], x[3]));
});

test('один разработчик сначала доводит начатое: ревью раньше новой задачи из бэклога', () => {
  const cfg = copy(BASIC);
  cfg.team = cfg.team.filter(m => m.id !== 'dev2');
  const { events } = run(cfg, 120, 0.5);
  const dev = events.filter(e => e.type === 'start' && e.person === 'dev1');
  assert.deepStrictEqual(dev.slice(0, 4).map(e => [e.task, e.stage]), [[1, 2], [1, 3], [2, 2], [2, 3]]);
});

test('очередь в конце процесса сразу отдаёт задачу в «Готово»', () => {
  const cfg = copy(BASIC);
  cfg.stages.push({ id: 'release', name: 'Ждёт релиза', role: null, limit: 0 });
  const { st, events } = run(cfg, 200, 0.5);
  assert.ok(st.doneCount > 0);
  assert.strictEqual(st.tasks.filter(t => t.stage === 5).length, 0);
  assert.strictEqual(events.filter(e => e.type === 'new').length, st.doneCount + st.tasks.length);
});

test('бэклог без лимита: PM ставит задачи весь рабочий день', () => {
  assert.strictEqual(F.normalize(BASIC).stages[1].limit, 0);
  const { st } = run(BASIC, 200, 0.25, s => {
    const pm = s.people.find(p => p.role === 'pm');
    if (F.isOn(s, pm, s.t)) assert.notStrictEqual(pm.task, null, `PM простаивает в ${s.t} ч`);
  });
  assert.ok(st.tasks.filter(t => t.stage === 1).length > 10, 'бэклог должен расти');
});

test('типы задач идут в потоке по долям', () => {
  const { events } = run(BASIC, 700, 0.5);
  const T = F.normalize(BASIC).types, total = T.reduce((x, t) => x + t.weight, 0);
  const kinds = events.filter(e => e.type === 'new').map(e => e.kind);
  const cycles = Math.floor(kinds.length / total);
  assert.ok(cycles >= 5, `создано ${kinds.length}`);
  const got = T.map((_, i) => kinds.slice(0, cycles * total).filter(k => k === i).length);
  assert.deepStrictEqual(got, T.map(t => t.weight * cycles));
});

test('время задачи на этапе берётся из её типа', () => {
  let checked = 0;
  run(BASIC, 300, 0.25, st => {
    st.tasks.filter(t => t.state === 'work').forEach(t => {
      assert.strictEqual(t.total, st.cfg.types[t.type].hours[st.cfg.stages[t.stage].id]);
      checked++;
    });
  });
  assert.ok(checked > 100);
});

test('0 часов: задача этого типа пропускает этап', () => {
  const cfg = copy(BASIC);
  const bug = cfg.types.findIndex(t => t.id === 'bug');
  cfg.types[bug].hours.review = 0;
  const { st, events } = run(cfg, 400, 0.5);
  const kind = {};
  events.filter(e => e.type === 'new').forEach(e => { kind[e.task] = e.kind; });
  const starts = events.filter(e => e.type === 'start');
  assert.ok(starts.some(e => e.stage === 3), 'стори ревьюят');
  assert.ok(!starts.some(e => e.stage === 3 && kind[e.task] === bug), 'баги ревью не проходят');
  assert.ok(starts.some(e => e.stage === 4 && kind[e.task] === bug), 'баги доходят до QA');
  assert.strictEqual(events.filter(e => e.type === 'new').length, st.doneCount + st.tasks.length);
});

test('люди работают только в рабочие часы, задача ждёт утра', () => {
  const { events } = run(solo('human'), 60, 0.5);
  const done = doneAt(events);
  // 0–6, затем 6–8 и утром 24–28, затем 28–32 и 48–50.
  assert.deepStrictEqual(done.slice(0, 3), [6, 28, 50]);
  events.filter(e => e.type === 'start').forEach(e => assert.ok(e.at % 24 < 8, `старт в ${e.at}`));
});

test('агент работает круглосуточно, часы агентов настраиваются', () => {
  assert.deepStrictEqual(doneAt(run(solo('agent'), 30, 0.5).events), [6, 12, 18, 24, 30]);
  const half = doneAt(run(solo('agent', { agentHours: 12 }), 40, 0.5).events);
  assert.deepStrictEqual(half, [6, 12, 30, 36]);
});

test('агент в команде: берёт этапы своей роли и делает их в speed раз быстрее', () => {
  const cfg = copy(BASIC);
  cfg.team.push({ id: 'ai1', name: 'ИИ-разработчик', role: 'dev', kind: 'agent', speed: 4 });
  let checked = 0;
  const { st, events } = run(cfg, 300, 0.25, s => {
    s.tasks.filter(t => t.state === 'work' && t.person === 'ai1').forEach(t => {
      assert.strictEqual(t.total, F.hoursFor(s, t, t.stage) / 4);
      checked++;
    });
  });
  assert.ok(checked > 0);
  const ai = events.filter(e => e.type === 'start' && e.person === 'ai1');
  assert.ok(ai.length > 10);
  assert.ok(ai.every(e => [2, 3].includes(e.stage)), 'агент берёт только этапы разработчика');
  assert.ok(ai.some(e => e.at % 24 >= 8), 'агент работает и ночью');
  assert.ok(st.doneCount > run(BASIC, 300, 0.25).st.doneCount, 'с агентом готово больше');
});

test('старый конфиг: команда из count ролей и агентов этапов, один тип из часов этапов', () => {
  const old = {
    version: 2,
    roles: [{ id: 'pm', name: 'Product Manager', count: 1 }, { id: 'dev', name: 'Разработчик', count: 2 }],
    stages: [
      { id: 'spec', name: 'Постановка', role: 'pm', hours: 2 },
      { id: 'dev', name: 'Разработка', role: 'dev', hours: 6, agent: { on: true, speed: 4 } },
    ],
  };
  const n = F.normalize(old);
  assert.deepStrictEqual(n.team.map(m => [m.role, m.kind]), [['pm', 'human'], ['dev', 'human'], ['dev', 'human'], ['dev', 'agent']]);
  assert.strictEqual(n.team[3].speed, 4);
  assert.deepStrictEqual(n.types[0].hours, { spec: 2, dev: 6 });
  assert.ok(run(old, 200, 0.5).st.doneCount > 5);
});

test('агент без коллег на ревью ждёт ревью своего кода, а не задач', () => {
  const cfg = copy(BASIC);
  cfg.team.push({ id: 'ai1', name: 'ИИ-разработчик', role: 'dev', kind: 'agent', speed: 4 });
  const reasons = new Set();
  run(cfg, 72, 1 / 15, st => {
    const ai = st.people.find(p => p.id === 'ai1');
    if (ai.task == null) reasons.add(ai.idleWhy);
    // Причина «своё ревью» — только когда его задача правда ждёт следующего этапа его роли.
    if (ai.task == null && ai.idle.includes('своё ревью')) {
      assert.ok(st.tasks.some(t => t.state === 'wait' && t.last === 'ai1' && t.stage === 3));
    }
  });
  assert.ok([...reasons].some(r => /^не может взять — .*ревью своего кода: \d+/.test(r)), [...reasons].join(' | '));
  const st = run(cfg, 72, 0.5).st;
  assert.strictEqual(st.people.reduce((a, p) => a + p.done, 0) >= st.doneCount * 3, true, 'счётчик сделанных этапов растёт');
});

test('тип «только для людей»: агенты его не берут, задачи всё равно доходят до «Готово»', () => {
  const cfg = copy(BASIC);
  cfg.types.find(t => t.id === 'xl').agents = false;
  cfg.team.push({ id: 'ai1', name: 'ИИ-разработчик', role: 'dev', kind: 'agent', speed: 4 });
  const xl = cfg.types.findIndex(t => t.id === 'xl');
  assert.strictEqual(F.normalize(cfg).types[xl].agents, false);
  assert.strictEqual(F.normalize(BASIC).types[xl].agents, true, 'по умолчанию агентам можно');
  const { st, events } = run(cfg, 500, 0.5);
  const kind = {};
  events.filter(e => e.type === 'new').forEach(e => { kind[e.task] = e.kind; });
  const starts = events.filter(e => e.type === 'start');
  assert.ok(!starts.some(e => e.person === 'ai1' && kind[e.task] === xl), 'агент не берёт XL');
  assert.ok(starts.some(e => e.person === 'ai1'), 'другие типы агент берёт');
  assert.ok(events.some(e => e.type === 'done' && kind[e.task] === xl), 'XL доходят до «Готово»');
  assert.strictEqual(events.filter(e => e.type === 'new').length, st.doneCount + st.tasks.length);
});

test('один человек и агент в роли: задачу «только для людей» ревьюит тот же человек, а не вешается', () => {
  const cfg = copy(BASIC);
  cfg.types = [{ id: 'xl', name: 'Story XL', weight: 1, agents: false, hours: { spec: 1, dev: 4, review: 1, qa: 1 } }];
  cfg.team = cfg.team.filter(m => m.id !== 'dev2');
  cfg.team.push({ id: 'ai1', name: 'ИИ-разработчик', role: 'dev', kind: 'agent', speed: 4 });
  const { st, events } = run(cfg, 200, 0.5, s => {
    const ai = s.people.find(p => p.id === 'ai1');
    if (ai.task == null && F.isOn(s, ai, s.t) && s.tasks.some(t => t.state === 'wait' && t.stage >= 1 && t.stage <= 3)) {
      assert.match(ai.idle, /^не берёт: \d+ только люди/);
      assert.match(ai.idleWhy, /^не может взять — только для людей: \d+ \(Story XL\)/);
    }
  });
  const reviews = events.filter(e => e.type === 'start' && e.stage === 3);
  assert.ok(reviews.length > 3);
  reviews.forEach(e => assert.strictEqual(e.person, 'dev1'));
  assert.ok(st.doneCount > 3);
});

test('агент-PM ставит только типы, доступные агентам', () => {
  const cfg = copy(BASIC);
  cfg.types.find(t => t.id === 'bug').agents = false;
  cfg.team = cfg.team.map(m => (m.id === 'pm1' ? { id: 'pm1', name: 'ИИ-PM', role: 'pm', kind: 'agent', speed: 2 } : m));
  const bug = cfg.types.findIndex(t => t.id === 'bug');
  const kinds = run(cfg, 200, 0.5).events.filter(e => e.type === 'new').map(e => e.kind);
  assert.ok(kinds.length > 20);
  assert.ok(!kinds.includes(bug));
});

test('выходные: люди не работают в субботу и воскресенье, агенты работают', () => {
  const weekendStarts = (cfg, hours) => run(cfg, hours, 0.5).events
    .filter(e => e.type === 'start' && Math.floor((e.at + 1e-9) / 24) % 7 >= 5);
  assert.strictEqual(weekendStarts(solo('human'), 24 * 14).length, 0);
  assert.ok(weekendStarts(solo('agent'), 24 * 14).length > 0);
  // Задачи по 6 ч подряд при 8-часовом дне: в пятницу (рабочие часы 32–40) одна заканчивается на 36-м часу,
  // следующая начинается в пятницу и доделывается в понедельник на 42-м рабочем часу.
  const done = doneAt(run(solo('human'), 24 * 8, 0.5).events);
  assert.ok(done.includes(4 * 24 + 4), 'пятница, 4-й час дня');
  assert.ok(done.includes(7 * 24 + 2), 'понедельник, 2-й час дня');
  assert.ok(!done.some(t => t > 4 * 24 + 8 && t < 7 * 24), 'в выходные ничего не заканчивается');
});

test('Story Points считаются по спринтам: сумма по спринтам = SP готовых задач', () => {
  const { st, events } = run(BASIC, F.SPRINT_H * 3, 0.5);
  const kind = {};
  events.filter(e => e.type === 'new').forEach(e => { kind[e.task] = e.kind; });
  const sp = events.filter(e => e.type === 'done').reduce((a, e) => a + st.cfg.types[kind[e.task]].sp, 0);
  assert.strictEqual(st.spDone, sp);
  assert.strictEqual(st.sprints.reduce((a, x) => a + x, 0), sp);
  assert.strictEqual(st.sprints.length, 3);
  assert.deepStrictEqual(F.normalize(BASIC).types.map(t => t.sp), [1, 2, 3, 5, 8, 1]);
});

test('расчёт SP за спринт: точный на простом процессе', () => {
  // Один человек, задача 4 ч, 2 SP: 8 ч × 5 дней × 2 недели / 4 ч = 20 задач = 40 SP.
  const cfg = solo('human', { types: [{ id: 't', name: 'Задача', weight: 1, sp: 2, hours: { dev: 4 } }] });
  const f = F.forecast(cfg);
  assert.strictEqual(f.tasksPerSprint, 20);
  assert.strictEqual(f.spPerSprint, 40);
  assert.deepStrictEqual(run(cfg, F.SPRINT_H * 3, 0.5).st.sprints, [40, 40, 40]);
  // Агент ×2 круглосуточно без выходных: 24 × 7 × 2 × 2 / 4 = 168 задач.
  assert.strictEqual(F.forecast(solo('agent', { team: [{ id: 'w', name: 'ИИ', role: 'dev', kind: 'agent', speed: 2 }], types: cfg.types })).tasksPerSprint, 168);
});

test('расчёт SP за спринт близок к прогону и находит узкое место', () => {
  const avg = cfg => { const s = run(cfg, F.SPRINT_H * 6, 0.5).st.sprints.slice(1); return s.reduce((a, x) => a + x, 0) / s.length; };
  const f = F.forecast(BASIC);
  assert.strictEqual(f.bottleneck, 'dev');
  assert.ok(Math.abs(avg(BASIC) - f.spPerSprint) / f.spPerSprint < 0.1, `расчёт ${f.spPerSprint}, прогон ${avg(BASIC)}`);
  const cfg = copy(BASIC);
  cfg.team.push({ id: 'ai1', name: 'ИИ-разработчик', role: 'dev', kind: 'agent', speed: 4 });
  const g = F.forecast(cfg);
  assert.strictEqual(g.bottleneck, 'qa', 'с агентом узкое место переезжает на QA');
  assert.ok(g.spPerSprint > f.spPerSprint);
  assert.ok(Math.abs(avg(cfg) - g.spPerSprint) / g.spPerSprint < 0.1, `расчёт ${g.spPerSprint}, прогон ${avg(cfg)}`);
});

test('расчёт учитывает задачи только для людей', () => {
  const types = [{ id: 't', name: 'Задача', weight: 1, sp: 1, agents: false, hours: { dev: 4 } }];
  const cfg = solo('human', { types, team: [{ id: 'h', name: 'Человек', role: 'dev', kind: 'human' }, { id: 'a', name: 'ИИ', role: 'dev', kind: 'agent', speed: 10 }] });
  assert.strictEqual(F.forecast(cfg).tasksPerSprint, 20, 'агент не помогает: ёмкость только человека');
});

test('пресет в JSON: туда и обратно без потерь, ошибки понятные', () => {
  const text = JSON.stringify(BASIC, null, 2);
  const back = F.fromJSON(text);
  assert.strictEqual(back.name, 'Базовый процесс');
  assert.deepStrictEqual(back, F.fromJSON(JSON.stringify(back)), 'повторный разбор ничего не меняет');
  assert.deepStrictEqual(run(back, 200, 0.5).st.sprints, run(BASIC, 200, 0.5).st.sprints, 'из JSON процесс идёт так же');
  assert.throws(() => F.fromJSON('{ roles: '), /это не JSON/);
  assert.throws(() => F.fromJSON('[1, 2]'), /нужен объект/);
  assert.throws(() => F.fromJSON('{"roles": [], "stages": [{"id": "a"}]}'), /ролей/);
  assert.throws(() => F.fromJSON('{"roles": [{"id": "r"}]}'), /этапов/);
  assert.throws(() => F.fromJSON('{"roles": [{"id": "r"}], "stages": [{"name": "без id"}]}'), /id/);
  assert.strictEqual(F.fromJSON('{"roles": [{"id": "r"}], "stages": [{"id": "s", "role": "r"}]}').name, 'Без названия');
});

test('пример по умолчанию: одна разработка, домены Client и Backend, два клиентщика и два бэкендера', () => {
  const ex = F.normalize(F.EXAMPLE);
  assert.deepStrictEqual(ex.stages.map(s => s.id), ['spec', 'backlog', 'dev', 'review', 'qa']);
  assert.deepStrictEqual(ex.domains, ['Client', 'Backend']);
  const { st, events } = run(F.EXAMPLE, F.SPRINT_H * 10, 0.5);
  const kind = {};
  // Домен задачи: у бага — домен задачи, в которой его нашли.
  events.filter(e => e.type === 'new').forEach(e => { kind[e.task] = e.domain !== undefined ? e.domain : ex.types[e.kind].domain; });
  const starts = events.filter(e => e.type === 'start' && [2, 3].includes(e.stage));
  const doms = Object.fromEntries(ex.team.map(m => [m.id, m.domains || ex.domains]));
  // Разработку и ревью берут только участники домена задачи.
  starts.forEach(e => assert.ok(doms[e.person].includes(kind[e.task]), `${e.person} взял задачу ${kind[e.task]}`));
  ['cl1', 'cl2', 'be1', 'be2'].forEach(id => assert.ok(starts.some(e => e.person === id), `${id} без задач`));
  assert.deepStrictEqual(ex.team.filter(m => m.role === 'dev').map(m => m.domains), [['Client'], ['Client'], ['Backend'], ['Backend']], 'фулстека нет');
  assert.strictEqual(events.filter(e => e.type === 'new').length, st.doneCount + st.tasks.length);
  // Узкое место — разработка, упор в Client: клиентских часов больше; расчёт близок к прогону; клиентщик даёт больше, чем бэкендер.
  const f = F.forecast(F.EXAMPLE);
  assert.strictEqual(f.bottleneck, 'dev');
  assert.strictEqual(f.roles.find(r => r.id === 'dev').limitBy, 'Client');
  const s = st.sprints.slice(1), avg = s.reduce((a, x) => a + x, 0) / s.length;
  assert.ok(Math.abs(avg - f.spPerSprint) / f.spPerSprint < 0.1, `расчёт ${f.spPerSprint}, прогон ${avg}`);
  const plus = m => { const c = copy(F.EXAMPLE); c.team.push(m); return F.forecast(c).spPerSprint; };
  assert.ok(plus({ id: 'cl3', name: 'Client 3', role: 'dev', kind: 'human', domains: ['Client'] }) > plus({ id: 'be3', name: 'Backend 3', role: 'dev', kind: 'human', domains: ['Backend'] }), 'упор в Client: третий клиентщик полезнее третьего бэкендера');
});

test('домены: задачу и её ревью берёт только участник с доменом задачи', () => {
  const cfg = copy(BASIC);
  cfg.domains = ['Client', 'Backend'];
  cfg.team = cfg.team.filter(m => m.role !== 'dev').concat([
    { id: 'c1', name: 'Client 1', role: 'dev', kind: 'human', domains: ['Client'] },
    { id: 'c2', name: 'Client 2', role: 'dev', kind: 'human', domains: ['Client'] },
    { id: 'b1', name: 'Backend 1', role: 'dev', kind: 'human', domains: ['Backend'] },
  ]);
  cfg.types = [
    { id: 'c', name: 'Client', weight: 1, sp: 1, domain: 'Client', hours: { spec: 0.5, dev: 2, review: 0.5, qa: 0.5 } },
    { id: 'b', name: 'Backend', weight: 1, sp: 1, domain: 'Backend', hours: { spec: 0.5, dev: 2, review: 0.5, qa: 0.5 } },
  ];
  const { st, events } = run(cfg, 200, 0.5);
  const kind = {};
  events.filter(e => e.type === 'new').forEach(e => { kind[e.task] = e.kind; });
  const devStarts = events.filter(e => e.type === 'start' && [2, 3].includes(e.stage));
  devStarts.filter(e => kind[e.task] === 0).forEach(e => assert.ok(['c1', 'c2'].includes(e.person)));
  devStarts.filter(e => kind[e.task] === 1).forEach(e => assert.strictEqual(e.person, 'b1'));
  // Единственный бэкендер ревьюит свой код сам — иначе задачу некому взять.
  const beReviews = devStarts.filter(e => kind[e.task] === 1 && e.stage === 3);
  assert.ok(beReviews.length > 3);
  // Клиентский код ревьюит второй клиентщик.
  const by = {};
  devStarts.filter(e => kind[e.task] === 0).forEach(e => { (by[e.task] = by[e.task] || {})[e.stage] = e.person; });
  Object.values(by).filter(x => x[3]).forEach(x => assert.notStrictEqual(x[2], x[3]));
  assert.ok(st.doneCount > 10);
  // QA без поля domains берёт задачи всех доменов.
  assert.ok(events.some(e => e.type === 'start' && e.stage === 4 && kind[e.task] === 0) && events.some(e => e.type === 'start' && e.stage === 4 && kind[e.task] === 1));
  const n = F.normalize(cfg);
  assert.deepStrictEqual(n.team.find(m => m.id === 'b1').domains, ['Backend']);
  assert.strictEqual(n.team.find(m => m.id === 'qa1').domains, undefined, 'без domains — все домены, и будущие тоже');
  assert.deepStrictEqual(F.create(cfg).people.find(x => x.id === 'qa1').domains, ['Client', 'Backend']);
});

test('домены: старый формат с направлениями роли переносится', () => {
  const old = copy(BASIC);
  old.roles[1].skills = ['Client', 'Backend'];
  old.team = old.team.map(m => (m.id === 'dev1' ? Object.assign(m, { skills: ['Client'] }) : m));
  old.types[0].skill = 'Backend';
  const n = F.normalize(old);
  assert.deepStrictEqual(n.domains, ['Client', 'Backend']);
  assert.deepStrictEqual(n.team.find(m => m.id === 'dev1').domains, ['Client']);
  assert.strictEqual(n.types[0].domain, 'Backend');
  assert.strictEqual(n.roles[1].skills, undefined);
  // Домен, которого нет в списке, у типа сбрасывается в «любой».
  assert.strictEqual(F.normalize(Object.assign(copy(BASIC), { types: [Object.assign(copy(BASIC.types[0]), { domain: 'Нет такого' })] })).types[0].domain, null);
});

test('домены в расчёте: предел по тем, у кого есть домен', () => {
  // Два человека: один Client, один Backend, задачи по 4 ч. Каждый успевает 80 ч / 4 ч = 20 задач своего направления.
  const cfg = solo('human', {
    domains: ['Client', 'Backend'],
    team: [{ id: 'c', name: 'C', role: 'dev', kind: 'human', domains: ['Client'] }, { id: 'b', name: 'B', role: 'dev', kind: 'human', domains: ['Backend'] }],
    types: [
      { id: 'c', name: 'C', weight: 1, sp: 1, domain: 'Client', hours: { dev: 4 } },
      { id: 'b', name: 'B', weight: 3, sp: 1, domain: 'Backend', hours: { dev: 4 } },
    ],
  });
  // Бэкенда втрое больше: бэкендер успевает 20 задач, а это 3/4 потока — предел 26,7.
  assert.ok(Math.abs(F.forecast(cfg).tasksPerSprint - 80 / 3) < 1e-9);
});

test('отключённый участник не работает и не входит в расчёт, но остаётся в настройках', () => {
  const cfg = copy(BASIC);
  cfg.team.find(m => m.id === 'dev2').active = false;
  const n = F.normalize(cfg);
  assert.strictEqual(n.team.find(m => m.id === 'dev2').active, false);
  assert.strictEqual(n.team.find(m => m.id === 'dev1').active, undefined, 'включённым флаг не пишется');
  assert.strictEqual(F.fromJSON(JSON.stringify(cfg)).team.find(m => m.id === 'dev2').active, false, 'флаг переживает JSON');
  const { st, events } = run(cfg, 300, 0.5);
  assert.ok(!st.people.some(p => p.id === 'dev2'));
  assert.ok(!events.some(e => e.person === 'dev2'));
  assert.ok(st.doneCount > 5);
  // Расчёт — как будто участника нет.
  const without = copy(BASIC);
  without.team = without.team.filter(m => m.id !== 'dev2');
  assert.strictEqual(F.forecast(cfg).spPerSprint, F.forecast(without).spPerSprint);
  assert.ok(F.forecast(cfg).spPerSprint < F.forecast(BASIC).spPerSprint);
});

test('загрузка: расчёт по ролям и фактическая у участников', () => {
  // Расчёт: у узкого места 100%, у остальных меньше; что ограничивает роль — подписано.
  const f = F.forecast(F.EXAMPLE);
  const byId = Object.fromEntries(f.roles.map(r => [r.id, r]));
  assert.strictEqual(byId[f.bottleneck].util, 1);
  f.roles.filter(r => r.id !== f.bottleneck).forEach(r => assert.ok(r.util < 1));
  const off = copy(F.EXAMPLE);
  off.team.find(m => m.id === 'be2').active = false;
  const g = F.forecast(off);
  assert.strictEqual(g.bottleneck, 'dev');
  assert.strictEqual(g.roles.find(r => r.id === 'dev').limitBy, 'Backend', 'с одним бэкендером упираемся в бэкенд');
  // Фактическая: один исполнитель без перерыва занят всё рабочее время.
  const solo1 = run(solo('human'), 24 * 7, 0.5).st.people[0];
  assert.ok(solo1.onH > 0 && Math.abs(solo1.busyH / solo1.onH - 1) < 1e-9);
  // В примере разработчики загружены больше, чем QA.
  const { st } = run(F.EXAMPLE, F.SPRINT_H * 2, 0.5);
  const util = id => { const p = st.people.find(x => x.id === id); return p.busyH / p.onH; };
  assert.ok(util('cl1') > 0.9, `cl1 ${util('cl1')}`);
  assert.ok(util('qa1') < util('cl1'));
  st.people.forEach(p => assert.ok(p.busyH <= p.onH + 1e-9));
});

test('QA находят баги: точная доля, баг идёт в бэклог мимо PM, задачи не теряются', () => {
  const cfg = copy(BASIC);
  cfg.stages.find(s => s.id === 'qa').bugs = true;
  cfg.types.find(t => t.id === 'm').bugChance = 25;
  cfg.types.find(t => t.id === 'm').bugType = 'bug';
  const { st, events } = run(cfg, 1200, 0.5);
  const kind = {}, bug = {};
  events.filter(e => e.type === 'new').forEach(e => { kind[e.task] = e.kind; bug[e.task] = !!e.bug; });
  const m = cfg.types.findIndex(t => t.id === 'm'), b = cfg.types.findIndex(t => t.id === 'bug');
  const testedM = events.filter(e => e.type === 'move' && e.from === 4 && kind[e.task] === m || e.type === 'done' && e.from === 4 && kind[e.task] === m).length;
  const bugs = events.filter(e => e.type === 'new' && e.bug);
  assert.ok(testedM >= 8, `протестировано M: ${testedM}`);
  assert.strictEqual(bugs.length, Math.floor(testedM * 0.25 + 1e-9), 'ровно каждая четвёртая M приносит баг');
  bugs.forEach(e => { assert.strictEqual(e.kind, b); assert.strictEqual(e.to, 1, 'баг попадает в бэклог'); assert.strictEqual(kind[e.of], m); });
  assert.ok(!events.some(e => e.type === 'start' && e.stage === 0 && bug[e.task]), 'PM баги не ставит');
  assert.ok(events.some(e => e.type === 'done' && bug[e.task]), 'баги доходят до «Готово»');
  assert.strictEqual(st.bugsFound, bugs.length);
  assert.strictEqual(events.filter(e => e.type === 'new').length, st.doneCount + st.tasks.length);
  // Без этапа с bugs баги не появляются.
  const quiet = copy(cfg); quiet.stages.find(s => s.id === 'qa').bugs = false;
  assert.strictEqual(run(quiet, 400, 0.5).st.bugsFound, 0);
});

test('баги в расчёте: добавляют нагрузку и SP, сходится с прогоном', () => {
  const f = F.forecast(F.EXAMPLE);
  assert.ok(f.bugsPerSprint > 5, `багов ${f.bugsPerSprint}`);
  const quiet = copy(F.EXAMPLE); quiet.types.forEach(t => { t.bugChance = 0; });
  const g = F.forecast(quiet);
  assert.strictEqual(g.bugsPerSprint, 0);
  const qa = x => x.roles.find(r => r.id === 'qa').util;
  assert.ok(qa(f) / qa(g) > 0.99, 'QA с багами загружены не меньше');
  const { st } = run(F.EXAMPLE, F.SPRINT_H * 6, 0.5);
  const perSprint = st.bugsFound / 6;
  assert.ok(Math.abs(perSprint - f.bugsPerSprint) / f.bugsPerSprint < 0.15, `расчёт ${f.bugsPerSprint}, прогон ${perSprint}`);
});

test('стоимость: людям — за рабочее время, агентам — за часы работы', () => {
  // Люди: 8 ч × 5 дней × 2 недели × ставка — и в расчёте, и в каждом спринте прогона.
  const f = F.forecast(F.EXAMPLE);
  const ex = F.normalize(F.EXAMPLE);
  const humans = ex.team.reduce((a, m) => a + F.rateOf(ex, m) * 80, 0);
  assert.strictEqual(humans, (45 + 50 * 4 + 35 * 2) * 80);
  assert.strictEqual(f.cost.humans, humans);
  assert.strictEqual(f.cost.agents, 0);
  assert.ok(Math.abs(f.cost.perSP - humans / f.spPerSprint) < 1e-9);
  assert.ok(f.cost.idle > 0 && f.cost.idle < humans);
  const { st } = run(F.EXAMPLE, F.SPRINT_H * 3, 0.5);
  st.sprintCost.slice(0, 3).forEach(c => assert.ok(Math.abs(c - humans) < 1e-6, `спринт ${c}`));
  assert.ok(st.cost.idle > 0 && st.cost.idle < st.cost.humans);
  // Агент: платим только за часы, когда он работает.
  const a = solo('agent', { team: [{ id: 'w', name: 'ИИ', role: 'dev', kind: 'agent', speed: 1, rate: 10 }] });
  const s2 = run(a, 48, 0.5).st;
  const p = s2.people[0];
  assert.ok(Math.abs(s2.cost.agents - p.busyH * 10) < 1e-6);
  assert.strictEqual(s2.cost.humans, 0);
  // Без ставок — ориентиры по названию роли, у агента — agentRate.
  const b = F.normalize(BASIC);
  assert.deepStrictEqual(b.roles.map(r => r.rate), [45, 50, 35]);
  assert.strictEqual(b.team[0].rate, undefined);
  assert.deepStrictEqual(F.create(BASIC).people.map(p => p.rate), [45, 50, 50, 35]);
  assert.strictEqual(F.rateOf(b, { kind: 'agent', role: 'dev' }), 3);
  // 0 у участника — как у роли; своя ставка главнее.
  assert.strictEqual(F.rateOf(F.normalize(Object.assign(copy(BASIC), { team: [{ id: 'x', name: 'X', role: 'dev', kind: 'human', rate: 0 }] })), { kind: 'human', role: 'dev' }), 50);
  const own = copy(F.EXAMPLE); own.team.find(m => m.id === 'be2').rate = 55;
  assert.strictEqual(F.create(own).people.find(p => p.id === 'be2').rate, 55);
  assert.deepStrictEqual(['DevOps', 'UX-дизайнер', 'Аналитик'].map(F.refRate), [55, 40, 40]);
});

test('скорость анимации не входит в пресет: старое поле speed отбрасывается', () => {
  assert.strictEqual('speed' in F.normalize(F.EXAMPLE), false);
  assert.strictEqual('speed' in F.fromJSON(JSON.stringify(Object.assign(copy(BASIC), { speed: 24 }))), false);
  assert.deepStrictEqual(F.normalize(Object.assign(copy(BASIC), { speed: 24 })), F.normalize(BASIC), 'пресеты с разной скоростью одинаковые');
  assert.ok(F.SPEEDS.includes(4));
});

test('пример: бэклог до 25 задач, у типов свои цвета', () => {
  const ex = F.normalize(F.EXAMPLE);
  assert.strictEqual(ex.stages.find(s => s.id === 'backlog').limit, 25);
  run(F.EXAMPLE, F.SPRINT_H * 2, 0.5, st => {
    // PM не ставит новые задачи сверх лимита; баги от QA в бэклог приходят всё равно.
    const fromPm = st.tasks.filter(t => t.stage <= 1 && !t.bug).length;
    assert.ok(fromPm <= 25, `от PM в бэклоге ${fromPm}`);
  });
  ex.types.forEach(t => assert.match(t.color, /^#[0-9a-f]{6}$/));
  assert.strictEqual(F.normalize(Object.assign(copy(BASIC), { types: [Object.assign(copy(BASIC.types[0]), { color: 'red' })] })).types[0].color, null);
});

test('изменение настроек посреди процесса: история спринтов и задачи сохраняются', () => {
  const st = F.create(F.EXAMPLE), ev = [];
  for (let h = 0; h < F.SPRINT_H * 3 + 30; h += 0.5) ev.push(...F.step(st, 0.5));
  const before = { t: st.t, sprints: st.sprints.slice(), done: st.doneCount, tasks: st.tasks.length, sp: st.spDone };
  // Добавить клиентщика: клиентских часов больше, в них и упираемся.
  const cfg = JSON.parse(JSON.stringify(F.EXAMPLE));
  cfg.team.push({ id: 'cl3', name: 'Client 3', role: 'dev', kind: 'human', domains: ['Client'] });
  const next = F.reconfigure(st, cfg);
  assert.strictEqual(next.t, before.t);
  assert.deepStrictEqual(next.sprints, before.sprints);
  assert.strictEqual(next.doneCount, before.done);
  assert.strictEqual(next.tasks.length, before.tasks);
  assert.strictEqual(next.spDone, before.sp);
  assert.deepStrictEqual(next.changes, [before.t]);
  // Работа в руках у оставшихся продолжается с того же места.
  const work = st.tasks.filter(t => t.state === 'work');
  work.forEach(t => { const n = next.tasks.find(x => x.id === t.id); assert.strictEqual(n.state, 'work'); assert.strictEqual(n.left, t.left); });
  // Дальше процесс идёт, задачи не теряются, после изменения скорость выше, чем без него.
  for (let h = 0; h < F.SPRINT_H * 4; h += 0.5) ev.push(...F.step(next, 0.5));
  assert.strictEqual(ev.filter(e => e.type === 'new').length, next.doneCount + next.tasks.length);
  const same = F.reconfigure(st, F.EXAMPLE);
  for (let h = 0; h < F.SPRINT_H * 4; h += 0.5) F.step(same, 0.5);
  const after = x => x.sprints.slice(5, 7).reduce((a, b) => a + b, 0);
  assert.ok(after(next) > after(same), `с клиентщиком ${after(next)}, без ${after(same)}`);
});

test('изменение настроек: задачи убранного участника возвращаются в очередь, удалённый тип снимается', () => {
  const st = F.create(BASIC);
  for (let h = 0; h < 30; h += 0.5) F.step(st, 0.5);
  const busy = st.tasks.find(t => t.state === 'work' && t.person === 'dev1');
  assert.ok(busy, 'у dev1 есть задача');
  const cfg = JSON.parse(JSON.stringify(BASIC));
  cfg.team.find(m => m.id === 'dev1').active = false;
  const next = F.reconfigure(st, cfg);
  const t = next.tasks.find(x => x.id === busy.id);
  assert.strictEqual(t.state, 'wait');
  assert.strictEqual(t.person, null);
  const noM = JSON.parse(JSON.stringify(BASIC));
  noM.types = noM.types.filter(x => x.id !== 'm');
  const m = BASIC.types.findIndex(x => x.id === 'm');
  const n2 = F.reconfigure(st, noM);
  assert.strictEqual(n2.tasks.length, st.tasks.filter(x => x.type !== m).length);
});

test('роль заводит задачи: PM — все типы, QA — только баги; без отметки баги не находят', () => {
  const ex = F.normalize(F.EXAMPLE);
  assert.strictEqual(ex.roles.find(r => r.id === 'pm').creates, 'all');
  assert.deepStrictEqual(ex.roles.find(r => r.id === 'qa').creates, ['bug']);
  assert.deepStrictEqual(ex.roles.find(r => r.id === 'dev').creates, []);
  // PM заводит только стори — баги приходят только от QA.
  const cfg = copy(F.EXAMPLE);
  cfg.roles.find(r => r.id === 'pm').creates = ['cl-s', 'cl-m', 'cl-l', 'be-s', 'be-m', 'be-l'];
  const n = F.normalize(cfg);
  const bugIdx = [n.types.findIndex(t => t.id === 'bug')];
  const { events } = run(cfg, F.SPRINT_H * 2, 0.5);
  const news = events.filter(e => e.type === 'new');
  assert.ok(news.filter(e => !e.bug && !e.spawn).every(e => !bugIdx.includes(e.kind)), 'PM не ставит баги');
  assert.ok(news.some(e => e.bug), 'QA находит баги');
  assert.ok(F.forecast(cfg).bugsPerSprint > 0);
  // Если у Bug есть доля, PM со «всеми типами» ставит баги и сам.
  const pmBugs = copy(F.EXAMPLE); pmBugs.types.find(t => t.id === 'bug').weight = 3;
  const bi = F.normalize(pmBugs).types.findIndex(t => t.bug);
  assert.ok(run(pmBugs, F.SPRINT_H, 0.5).events.some(e => e.type === 'new' && !e.bug && e.kind === bi));
  // QA не заводит баги — их нет.
  const quiet = copy(F.EXAMPLE);
  quiet.roles.find(r => r.id === 'qa').creates = [];
  assert.strictEqual(run(quiet, F.SPRINT_H, 0.5).st.bugsFound, 0);
  assert.strictEqual(F.forecast(quiet).bugsPerSprint, 0);
  // Роль первого этапа ничего не заводит — задач нет.
  const none = copy(BASIC); none.roles[0].creates = [];
  const st = run(none, 100, 0.5).st;
  assert.strictEqual(st.nextId, 1);
  assert.strictEqual(st.people[0].idle, 'роль не заводит задачи');
  // Старые настройки без creates: PM — все, роль этапа с bugs — типы её багов.
  const old = copy(F.EXAMPLE); old.roles.forEach(r => { delete r.creates; });
  const o = F.normalize(old);
  assert.strictEqual(o.roles.find(r => r.id === 'pm').creates, 'all');
  assert.deepStrictEqual(o.roles.find(r => r.id === 'qa').creates, ['bug']);
});

test('Bug — обязательный тип: добавляется сам, светлый, все баги этого типа и с доменом задачи', () => {
  // В настройках без Bug он появляется с долей 0 и светлым цветом.
  const noBug = copy(BASIC); noBug.types = noBug.types.filter(t => t.id !== 'bug');
  const n = F.normalize(noBug), bug = n.types.find(t => t.id === F.BUG_ID);
  assert.ok(bug && bug.bug);
  assert.strictEqual(bug.weight, 0);
  assert.strictEqual(bug.color, '#ebebeb'); // светлый: баг выделяется светлотой и подписью, красный — только узкое место
  assert.deepStrictEqual(bug.hours, { spec: 0, dev: 1, review: 1, qa: 1 }, 'постановки нет — баг заводит тестировщик');
  // Баги клиентской задачи — клиентские, бэкендовой — бэкендовые; один тип на всех.
  const { events } = run(F.EXAMPLE, F.SPRINT_H * 2, 0.5);
  const ex = F.normalize(F.EXAMPLE), bi = ex.types.findIndex(t => t.bug);
  const kindOf = {};
  events.filter(e => e.type === 'new').forEach(e => { kindOf[e.task] = e; });
  const bugs = events.filter(e => e.type === 'new' && e.bug);
  assert.ok(bugs.length > 5);
  bugs.forEach(e => {
    assert.strictEqual(e.kind, bi);
    const parent = kindOf[e.of];
    const pd = parent.domain !== undefined ? parent.domain : ex.types[parent.kind].domain;
    assert.strictEqual(e.domain, pd);
  });
  assert.ok(bugs.some(e => e.domain === 'Client') && bugs.some(e => e.domain === 'Backend'));
  // Баг-задачи из бэклога берут только разработчики домена бага.
  const doms = Object.fromEntries(ex.team.map(m => [m.id, m.domains || ex.domains]));
  const bugIds = new Set(bugs.map(e => e.task));
  events.filter(e => e.type === 'start' && bugIds.has(e.task) && e.stage === 2).forEach(e => assert.ok(doms[e.person].includes(kindOf[e.task].domain)));
  // Расчёт сходится с прогоном.
  // Микс по неделям раскачивает спринты, поэтому сравниваем среднее за 11 спринтов после разгонного.
  const f = F.forecast(F.EXAMPLE), st = run(F.EXAMPLE, F.SPRINT_H * 12, 0.5).st;
  const s = st.sprints.slice(1, 12), avg = s.reduce((a, x) => a + x, 0) / s.length;
  assert.ok(Math.abs(avg - f.spPerSprint) / f.spPerSprint < 0.1, `расчёт ${f.spPerSprint}, прогон ${avg}`);
});

test('старый пресет: ссылки QA на прежние типы багов превращаются в Bug', () => {
  const old = copy(F.EXAMPLE);
  old.types = old.types.filter(t => t.id !== 'bug');
  old.roles.find(r => r.id === 'qa').creates = ['bug-cl', 'bug-be'];
  const n = F.normalize(old);
  assert.deepStrictEqual(n.roles.find(r => r.id === 'qa').creates, ['bug']);
  assert.deepStrictEqual(n.roles.find(r => r.id === 'dev').creates, [], 'роль без этапа с багами ничего не получает');
});

test('причина простоя агента: все причины с числом задач, самая частая первой', () => {
  const cfg = copy(F.EXAMPLE);
  cfg.types.filter(t => ['cl-m', 'cl-l', 'be-m', 'be-l'].includes(t.id)).forEach(t => { t.agents = false; });
  cfg.team.push({ id: 'ai', name: 'ИИ', role: 'dev', kind: 'agent', speed: 4 });
  const seen = new Set();
  run(cfg, F.SPRINT_H * 2, 0.25, st => { const a = st.people.find(p => p.id === 'ai'); if (a.task == null) seen.add(a.idleWhy); });
  const human = [...seen].filter(r => r.startsWith('не может взять — только для людей'));
  assert.ok(human.length, [...seen].join(' | '));
  assert.ok(human.some(r => /только для людей: \d+ \((Client|Backend) [ML](, (Client|Backend) [ML])*\)/.test(r)));
});

test('порядок команды меняется посреди процесса: задачи и счётчики остаются у тех же участников', () => {
  const cfg = copy(F.EXAMPLE);
  const { st } = run(cfg, 30, 0.25);
  const before = new Map(st.people.map(p => [p.id, { task: p.task, done: p.done }]));
  const next = copy(cfg);
  next.team.reverse();
  const nst = F.reconfigure(st, next);
  assert.deepStrictEqual(nst.people.map(p => p.id), next.team.map(m => m.id));
  nst.people.forEach(p => {
    assert.strictEqual(p.task, before.get(p.id).task, p.id);
    assert.strictEqual(p.done, before.get(p.id).done, p.id);
  });
  F.step(nst, F.SPRINT_H);
  assert.ok(nst.spDone > st.spDone);
});

test('ИИ-ассистент у человека: работает в assistSpeed раз быстрее, только в рабочие часы, расчёт это учитывает', () => {
  const ex = F.normalize(F.EXAMPLE);
  assert.strictEqual(ex.assistSpeed, 1.25, 'по умолчанию ×1,25');
  assert.ok(ex.team.every(m => !m.assist), 'в примере ассистента ни у кого нет');
  // Задача 5 ч: с ассистентом ×1,25 — 4 ч, за спринт 80 ч → 20 задач вместо 16.
  const types = [{ id: 't', name: 'Задача', weight: 1, sp: 1, hours: { dev: 5 } }];
  const plain = solo('human', { types });
  const help = solo('human', { types, team: [{ id: 'w', name: 'Исполнитель', role: 'dev', kind: 'human', assist: true }] });
  assert.strictEqual(F.forecast(plain).tasksPerSprint, 16);
  assert.strictEqual(F.forecast(help).tasksPerSprint, 20);
  assert.strictEqual(F.forecast(Object.assign(copy(help), { assistSpeed: 2 })).tasksPerSprint, 32);
  let checked = 0;
  const { st } = run(help, F.SPRINT_H * 2, 0.5, s => {
    s.tasks.filter(t => t.state === 'work').forEach(t => { assert.strictEqual(t.total, 4); checked++; });
  });
  assert.ok(checked > 0);
  assert.deepStrictEqual(st.sprints, [20, 20]);
  assert.strictEqual(st.people[0].onH, 160, 'ассистент не делает человека агентом: рабочих часов столько же');
  // Флаг сохраняется в JSON и не появляется у агента; коэффициент ограничен.
  const back = F.fromJSON(JSON.stringify(F.normalize(help)));
  assert.strictEqual(back.team[0].assist, true);
  const agent = F.normalize(solo('agent', { team: [{ id: 'w', name: 'ИИ', role: 'dev', kind: 'agent', speed: 2, assist: true }] }));
  assert.ok(!agent.team[0].assist);
  assert.strictEqual(F.normalize(Object.assign(copy(help), { assistSpeed: 100 })).assistSpeed, 5);
  assert.strictEqual(F.normalize(Object.assign(copy(help), { assistSpeed: 0 })).assistSpeed, 0.5);
});

test('встроенные пресеты: Classic → … → AI-Impact Analysis → Dark Factory → Dark Factory + Continuous Discovery', () => {
  assert.deepStrictEqual(F.PRESETS.map(p => p.name), ['Classic', 'Dev AI-Assisted', 'AI-Assisted', 'Fullstack AI-Assisted', 'Fullstack AI-Assisted + PM', 'Fullstack AI-Assisted AI-Review', 'AI-Impact Analysis', 'Dark Factory', 'Dark Factory + Continuous Discovery']);
  const [classic, devAi, ai, full, fullPm, review, impact, factory, dark] = F.PRESETS;
  assert.strictEqual(classic.cfg, F.EXAMPLE);
  const strip = (c, keys) => { const n = F.normalize(c); delete n.name; delete n.description; n.team.forEach(m => keys.forEach(k => delete m[k])); return n; };
  // Dev AI-Assisted — ассистент только у разработчиков; AI-Assisted — у всей команды-людей.
  assert.deepStrictEqual(strip(devAi.cfg, ['assist']), strip(classic.cfg, []));
  const d = F.normalize(devAi.cfg), a = F.normalize(ai.cfg);
  assert.ok(d.team.filter(m => m.role === 'dev').every(m => m.assist) && d.team.filter(m => m.role !== 'dev').every(m => !m.assist));
  assert.deepStrictEqual(strip(ai.cfg, ['assist']), strip(classic.cfg, []));
  assert.ok(a.team.every(m => m.assist), 'ассистент у PM, разработчиков и QA');
  assert.ok(!F.normalize(F.EXAMPLE).team.some(m => m.assist), 'EXAMPLE не испорчен');
  // Fullstack — AI-Assisted без специализации.
  assert.deepStrictEqual(strip(full.cfg, ['domains']), strip(ai.cfg, ['domains']));
  assert.ok(!F.isSpecialized(full.cfg) && F.normalize(full.cfg).team.every(m => m.assist));
  // + PM — тот же Fullstack и второй PM с ассистентом.
  const fp = F.normalize(fullPm.cfg);
  assert.deepStrictEqual(fp.team.filter(m => m.id !== 'pm2').map(m => m.id), F.normalize(full.cfg).team.map(m => m.id));
  assert.deepStrictEqual(fp.team.filter(m => m.role === 'pm').map(m => [m.kind, !!m.assist]), [['human', true], ['human', true]]);
  // AI-Review и AI-Impact — тот же процесс плюс этап ИИ-ревью с одним агентом; развилка 60% в тест или 30/30 в тест и «Готово».
  const r = F.normalize(review.cfg), im = F.normalize(impact.cfg);
  assert.deepStrictEqual(r.stages.map(x => x.id), ['spec', 'backlog', 'dev', 'ai-review', 'review', 'qa']);
  assert.deepStrictEqual(r.stages[3].routes, { qa: 60 });
  assert.deepStrictEqual(im.stages.map(x => x.id), r.stages.map(x => x.id));
  assert.deepStrictEqual(im.stages[3].routes, { qa: 30, done: 30 });
  assert.deepStrictEqual(r.team.filter(m => m.role === 'ai-review').map(m => m.kind), ['agent']);
  assert.deepStrictEqual(r.team.filter(m => m.role !== 'ai-review').map(m => m.id), fp.team.map(m => m.id), 'люди те же, что в + PM');
  // Dark Factory: постановка у двух PM, дальше один этап — фабрика агентов: разработка, ревью и тестирование сразу.
  const df = F.normalize(factory.cfg);
  assert.deepStrictEqual(df.stages.map(x => x.id), ['spec', 'backlog', 'factory']);
  assert.ok(!df.stages.some(x => x.bugs || x.spawn), 'фабрика не заводит ни багов, ни техдолга');
  assert.deepStrictEqual(df.team.filter(m => m.kind === 'human').map(m => m.role), ['pm', 'pm'], 'из людей — только PM');
  assert.ok(df.team.filter(m => m.role === 'factory').every(m => m.kind === 'agent') && df.team.some(m => m.role === 'factory'));
  const base = F.normalize(F.EXAMPLE);
  df.types.forEach(t => { const b = base.types.find(x => x.id === t.id); assert.strictEqual(t.hours.factory, b.hours.dev + b.hours.review + b.hours.qa, t.id); });
  // Dark Factory + Continuous Discovery: тот же процесс, людей нет — в роли PM тоже агенты; все агенты ×5.
  const dk = F.normalize(dark.cfg);
  assert.deepStrictEqual(dk.stages.map(x => x.id), ['spec', 'factory'], 'бэклога нет');
  // Без очереди за постановкой — вытягивание: ставится ровно столько, сколько фабрика успевает взять.
  const dst = F.create(dark.cfg);
  let most = 0;
  for (let h = 0; h < F.SPRINT_H; h += 0.25) { F.step(dst, 0.25); most = Math.max(most, dst.tasks.length); }
  const crew = dk.team.filter(m => m.role === 'factory').length, pms = dk.team.filter(m => m.role === 'pm').length;
  assert.ok(most <= crew * 2 + pms, `в процессе не больше ${crew * 2 + pms}, было ${most}`);
  assert.ok(dst.people.filter(p => p.role === 'factory').every(p => p.busyH / p.onH > 0.95), 'фабрика при этом не простаивает');
  assert.ok(dk.team.every(m => m.kind === 'agent' && m.speed === 5), 'только агенты ×5');
  assert.deepStrictEqual(dk.team.map(m => m.role), df.team.map(m => m.role), 'состав ролей тот же, что в Dark Factory');
  // Цепочка: ни один следующий не медленнее; ассистент у всей команды даёт ровно ×1,25 к Classic (все роли быстрее в 1,25 раза),
  // ассистент только разработчикам — не больше; без специализации — быстрее, чем со специализацией.
  const f = F.PRESETS.map(p => F.forecast(p.cfg));
  f.slice(1).forEach((x, k) => assert.ok(x.tasksPerWeek >= f[k].tasksPerWeek * (1 - 1e-6), `${F.PRESETS[k + 1].name}: ${x.tasksPerWeek} против ${f[k].tasksPerWeek}`));
  assert.strictEqual(f[0].bottleneck, 'dev');
  assert.ok(Math.abs(f[2].tasksPerWeek / f[0].tasksPerWeek - 1.25) < 0.01);
  assert.ok(f[1].tasksPerWeek <= f[2].tasksPerWeek + 1e-9 && f[1].tasksPerWeek > f[0].tasksPerWeek);
  assert.ok(f[3].tasksPerWeek > f[2].tasksPerWeek * 1.03);
  assert.strictEqual(f[3].bottleneck, 'pm', 'без специализации упираемся в постановку');
  assert.notStrictEqual(f[4].bottleneck, 'pm', 'второй PM снимает этот упор');
  assert.ok(f[5].tasksPerWeek > f[4].tasksPerWeek, 'ИИ-ревью ускоряет');
  assert.strictEqual(f[5].bottleneck, 'qa', 'ускорили код — встали тестировщики');
  assert.ok(f[6].tasksPerWeek > f[5].tasksPerWeek * 1.03 && f[6].bottleneck !== 'qa', 'анализ влияния отправляет часть задач мимо тестирования и снимает упор в QA');
  assert.strictEqual(f[7].bottleneck, 'pm', 'в Dark Factory всё упирается в постановку людьми');
  // У фабрики задачи — только стори, без багов и техдолга, поэтому сравниваем по SP.
  assert.ok(f[7].spPerSprint > f[6].spPerSprint * 1.2 && f[7].cost.perSP < f[6].cost.perSP / 2, 'фабрика заметно быстрее по SP и в разы дешевле за SP');
  assert.strictEqual(f[7].spawnedPerSprint, 0, 'техдолга фабрика не заводит');
  assert.strictEqual(f[7].bugsPerSprint, 0, 'багов тоже');
  assert.strictEqual(f[8].bottleneck, 'factory', 'когда и постановку делают агенты, упираемся в фабрику');
  assert.ok(f[8].storiesPerWeek > f[7].storiesPerWeek * 3 && f[8].cost.humans === 0, 'Dark Factory + Continuous Discovery в разы быстрее, людям не платим');
  assert.strictEqual(f[0].roles.find(x => x.id === 'dev').limitBy, 'Client');
  assert.strictEqual(f[3].roles.find(x => x.id === 'dev').limitBy, null);
  [1, 2, 3].forEach(k => assert.strictEqual(f[k].cost.humans, f[0].cost.humans, 'ассистент и снятие специализации не меняют оплату людей'));
  for (const p of F.PRESETS) assert.deepStrictEqual(F.fromJSON(JSON.stringify(p.cfg)), F.normalize(p.cfg));
  const ds = F.PRESETS.map(p => F.normalize(p.cfg).description);
  assert.ok(ds.every(x => x && x.length <= 160 && !x.includes('\n')) && new Set(ds).size === ds.length);
  assert.strictEqual('description' in F.normalize(Object.assign(copy(BASIC), { description: '  ' })), false);
  assert.strictEqual(F.normalize(Object.assign(copy(BASIC), { description: 'а\nб '.repeat(100) })).description.length, 160);
});

test('развилка после этапа: точные доли по путям, расчёт это учитывает, автор не ревьюит свой код и через ИИ-ревью', () => {
  const cfg = F.PRESETS.find(p => p.id === 'ai-impact').cfg;
  const { st, events } = run(cfg, F.SPRINT_H * 4, 0.5);
  const S = st.cfg.stages, ai = S.findIndex(s => s.id === 'ai-review'), rev = ai + 1, qa = S.findIndex(s => s.id === 'qa');
  const out = events.filter(e => (e.type === 'move' || e.type === 'done') && e.from === ai);
  const to = k => out.filter(e => e.to === k);
  assert.ok(out.length > 40);
  // 40 / 30 / 30: на ревью людьми, сразу в тест, сразу в «Готово» — с точностью до одной задачи.
  [[rev, 0.4], [qa, 0.3], [S.length, 0.3]].forEach(([k, p]) => assert.ok(Math.abs(to(k).length - out.length * p) <= 1, `${k}: ${to(k).length} из ${out.length}`));
  assert.strictEqual(to(rev).length + to(qa).length + to(S.length).length, out.length);
  assert.deepStrictEqual(st.routed['ai-review'], { next: to(rev).length, qa: to(qa).length, done: to(S.length).length });
  // Ушедшие мимо ревью его не начинают, ушедшие в «Готово» не тестируются.
  const past = new Set(to(qa).concat(to(S.length)).map(e => e.task)), done = new Set(to(S.length).map(e => e.task));
  assert.ok(!events.some(e => e.type === 'start' && e.stage === rev && past.has(e.task)));
  assert.ok(!events.some(e => e.type === 'start' && e.stage === qa && done.has(e.task)));
  // Дефекты ушедших мимо тестирования всплывают позже — баг без исполнителя, с этапа тестирования.
  const escaped = events.filter(e => e.type === 'new' && e.bug && done.has(e.of));
  assert.ok(escaped.length > 0 && escaped.every(e => e.by === null && e.from === qa));
  // Автор не ревьюит свою задачу, хотя между разработкой и ревью был агент.
  const author = {};
  events.filter(e => e.type === 'start' && e.stage === ai - 1).forEach(e => { author[e.task] = e.person; });
  events.filter(e => e.type === 'start' && e.stage === rev).forEach(e => assert.notStrictEqual(e.person, author[e.task], `задача ${e.task}`));
  assert.strictEqual(events.filter(e => e.type === 'new').length, st.doneCount + st.tasks.length);
  // Расчёт: без развилки нагрузка выше; баги развилка не меняет — дефекты не исчезают.
  const none = copy(cfg); delete none.stages.find(s => s.id === 'ai-review').routes;
  const per = f => f.bugsPerSprint / f.tasksPerSprint;
  assert.ok(F.forecast(cfg).roles.find(r => r.id === 'dev').load < F.forecast(none).roles.find(r => r.id === 'dev').load);
  assert.ok(F.forecast(cfg).roles.find(r => r.id === 'qa').load < F.forecast(none).roles.find(r => r.id === 'qa').load);
  assert.ok(Math.abs(per(F.forecast(cfg)) - per(F.forecast(none))) < 1e-9);
  // Нормализация: цель — только дальше чем через этап или «Готово», сумма не больше 100, старое skipNext переносится.
  const norm = routes => F.normalize(Object.assign(copy(cfg), { stages: cfg.stages.map(s => (s.id === 'ai-review' ? Object.assign({}, s, { routes }) : s)) })).stages[ai].routes;
  assert.deepStrictEqual(norm({ review: 50, dev: 10, nowhere: 5, qa: 20 }), { qa: 20 });
  assert.deepStrictEqual(norm({ qa: 80, done: 80 }), { qa: 50, done: 50 });
  assert.strictEqual(norm({ qa: 0 }), undefined);
  const legacy = Object.assign(copy(cfg), { stages: cfg.stages.map(s => (s.id === 'ai-review' ? { id: s.id, name: s.name, role: s.role, skipNext: 60 } : s)) });
  assert.deepStrictEqual(F.normalize(legacy).stages[ai].routes, { qa: 60 });
});

test('задач в неделю: расчёт и факт за последние 2 недели, баги считаются', () => {
  const f = F.forecast(F.EXAMPLE);
  assert.ok(Math.abs(f.tasksPerWeek - f.tasksPerSprint / 2) < 1e-9);
  const st = F.create(F.EXAMPLE);
  F.step(st, 24 * 6);
  assert.strictEqual(F.throughput(st), null, 'до конца первой недели цифры нет');
  for (let h = 0; h < F.SPRINT_H * 4; h += 0.5) F.step(st, 0.5);
  const doneLast2w = st.doneAt.filter(t => t > st.t - 2 * F.WEEK_H).length;
  assert.strictEqual(F.throughput(st), doneLast2w / 2);
  // В среднем на длинном прогоне — близко к расчёту (за две недели факт качается вместе с миксом).
  const d0 = st.doneCount, w0 = st.t;
  for (let h = 0; h < F.WEEK_H * 16; h += 0.5) F.step(st, 0.5);
  const avg = (st.doneCount - d0) / ((st.t - w0) / F.WEEK_H);
  assert.ok(Math.abs(avg - f.tasksPerWeek) / f.tasksPerWeek < 0.1, `${avg} против ${f.tasksPerWeek}`);
  // Тот же счёт после изменения настроек: история закрытых задач сохраняется.
  const r = F.reconfigure(st, F.EXAMPLE);
  assert.strictEqual(F.throughput(r), F.throughput(st));
});

test('нехватка домена: видна, когда задачи домена ждут, а другие участники роли простаивают; гаснет после правки', () => {
  const run = (st, hours, on) => { for (let h = 0; h < hours; h += 0.25) { F.step(st, 0.25); if (on) on(st); } return st; };
  const share = (cfg, domain, hours) => { let n = 0, k = 0; const st = run(F.create(cfg), hours, s => { k++; if (F.shortages(s).some(x => x.domain === domain)) n++; }); return { st, part: n / k }; };
  // Узкая специализация: один бэкендер, клиентщики простаивают — «не хватает: Backend» горит большую часть времени.
  const cfg = narrowTeam();
  // Бэклог сначала наполняется, клиентщикам есть что делать; нехватка видна после разгона.
  let seen = null, n = 0, k = 0;
  const st = run(F.create(cfg), F.SPRINT_H * 2);
  run(st, F.SPRINT_H * 2, s => { k++; const b = F.shortages(s).find(x => x.domain === 'Backend'); if (b) { n++; seen = seen || b; } });
  const part = n / k;
  assert.ok(part > 0.4, `горит ${part}`);
  assert.ok(seen, 'плашка Backend есть');
  assert.strictEqual(seen.role, 'dev');
  assert.strictEqual(seen.stage, st.cfg.stages.findIndex(x => x.id === 'dev'));
  assert.ok(seen.waiting > 0);
  // Сигнал сглажен: за 4 спринта переключается редко.
  let flips = 0, prev = false;
  run(F.create(cfg), F.SPRINT_H * 4, x => { const v = F.shortages(x).some(y => y.domain === 'Backend'); if (v !== prev) flips++; prev = v; });
  assert.ok(flips <= 6, `мигает: ${flips}`);
  // Классическая 2+2: иногда не хватает клиентщиков; без специализации нехватки нет никогда.
  assert.ok(share(F.EXAMPLE, 'Client', F.SPRINT_H * 4).part > 0.05);
  const anyone = F.unspecialize(F.EXAMPLE);
  assert.strictEqual(share(anyone, 'Client', F.SPRINT_H * 4).part + share(anyone, 'Backend', F.SPRINT_H * 4).part, 0);
  // Убрали специализацию — плашка гаснет сразу и не возвращается.
  const fixed = F.reconfigure(st, F.unspecialize(cfg));
  assert.deepStrictEqual(F.shortages(fixed), []);
  run(fixed, F.SPRINT_H);
  assert.deepStrictEqual(F.shortages(fixed), []);
});

test('убрать специализацию: те же люди берут все домены, предел как у классической, нехватка гаснет без перезапуска', () => {
  const narrow = narrowTeam();
  assert.ok(F.isSpecialized(narrow));
  assert.ok(F.isSpecialized(F.EXAMPLE), 'в классической все четверо — специалисты');
  const open = F.unspecialize(narrow);
  assert.ok(!F.isSpecialized(open));
  assert.deepStrictEqual(F.normalize(open).team.map(m => [m.id, m.role, m.kind]), F.normalize(narrow).team.map(m => [m.id, m.role, m.kind]), 'люди те же');
  assert.ok(F.normalize(narrow).team.some(m => m.domains), 'исходный конфиг не тронут');
  const before = F.forecast(narrow), after = F.forecast(open), anyone = F.forecast(F.unspecialize(F.EXAMPLE));
  assert.strictEqual(before.roles.find(r => r.id === 'dev').limitBy, 'Backend');
  assert.ok(Math.abs(after.tasksPerWeek - anyone.tasksPerWeek) < 1e-9, 'те же четверо без специализации — как классическая без специализации');
  assert.strictEqual(after.roles.find(r => r.id === 'dev').limitBy, null, 'упора в домен больше нет');
  const st = F.create(narrow);
  for (let h = 0; h < F.SPRINT_H * 3; h += 0.25) F.step(st, 0.25);
  assert.ok(F.shortages(st).length > 0);
  const t = st.t, done = st.doneCount, next = F.reconfigure(st, open);
  assert.strictEqual(next.t, t); assert.strictEqual(next.doneCount, done);
  assert.deepStrictEqual(F.shortages(next), []);
  assert.ok(!F.isSpecialized({ version: 2, roles: [{ id: 'dev', name: 'Р' }], stages: [{ id: 'dev', name: 'Р', role: 'dev' }], team: [{ id: 'a', name: 'А', role: 'dev', kind: 'human' }] }), 'без доменов специализации нет');
});

test('микс по неделям: доля Client случайная от 50 до 60%, но одна и та же на каждом прогоне; расчёт — по средней', () => {
  const ex = F.normalize(F.EXAMPLE);
  assert.deepStrictEqual(ex.mix, { domain: 'Client', from: 50, to: 60, weeks: 1, seed: 7 });
  const shares = Array.from({ length: 30 }, (_, k) => F.mixAt(ex, k * F.WEEK_H + 1).share);
  shares.forEach(x => assert.ok(x >= 0.5 && x <= 0.6, `${x}`));
  assert.ok(new Set(shares.map(x => x.toFixed(3))).size > 10, 'доля меняется от недели к неделе');
  assert.deepStrictEqual(shares, Array.from({ length: 30 }, (_, k) => F.mixAt(F.normalize(F.EXAMPLE), k * F.WEEK_H + 1).share), 'воспроизводится');
  assert.notDeepStrictEqual(F.mixAt(Object.assign(copy(ex), { mix: Object.assign({}, ex.mix, { seed: 8 }) }), 1).share, shares[0], 'другой seed — другая последовательность');
  // Расчёт: средние доли дают 55% часов работы на Client.
  const W = F.avgWeights(ex), hours = t => Object.values(t.hours).reduce((a, x) => a + x, 0);
  const part = d => ex.types.reduce((a, t, i) => a + (t.domain === d ? W[i] * hours(t) : 0), 0);
  assert.ok(Math.abs(part('Client') / (part('Client') + part('Backend')) - 0.55) < 1e-9);
  // В прогоне созданные за неделю задачи следуют доле недели (с точностью до округления потока).
  const { events, st } = run(F.EXAMPLE, F.WEEK_H * 8, 0.5);
  for (let k = 2; k < 8; k++) {
    const made = events.filter(e => e.type === 'new' && !e.bug && !e.spawn && e.at >= k * F.WEEK_H && e.at < (k + 1) * F.WEEK_H).map(e => st.cfg.types[e.kind]);
    const c = made.filter(t => t.domain === 'Client').reduce((a, t) => a + hours(t), 0), all = made.reduce((a, t) => a + hours(t), 0);
    assert.ok(Math.abs(c / all - F.mixAt(st.cfg, k * F.WEEK_H + 1).share) < 0.12, `неделя ${k + 1}: ${c / all}`);
  }
  // Без микса и с неизвестным доменом — постоянные доли.
  const plain = copy(F.EXAMPLE); delete plain.mix;
  assert.strictEqual(F.mixAt(F.normalize(plain), 1), null);
  assert.strictEqual(F.normalize(Object.assign(copy(F.EXAMPLE), { mix: { domain: 'Mobile', from: 50, to: 60 } })).mix, undefined);
  assert.deepStrictEqual(F.normalize(Object.assign(copy(F.EXAMPLE), { mix: { domain: 'Client', from: 70, to: 40, weeks: 0 } })).mix, { domain: 'Client', from: 40, to: 70, weeks: 1, seed: 1 });
  assert.deepStrictEqual(F.fromJSON(JSON.stringify(F.EXAMPLE)).mix, ex.mix);
});

test('постановка бага — 0 часов: баг заводит тестировщик; если PM ставит баги сам, постановка не мгновенная', () => {
  const ex = F.normalize(F.EXAMPLE), bug = ex.types.find(t => t.bug);
  assert.strictEqual(bug.hours.spec, 0);
  const { st, events } = run(F.EXAMPLE, F.SPRINT_H * 2, 0.5);
  assert.ok(st.bugsFound > 0);
  assert.ok(!events.some(e => e.type === 'start' && e.stage === 0 && st.cfg.types[(events.find(x => x.type === 'new' && x.task === e.task) || {}).kind] === bug), 'PM баги не берёт');
  // Bug с долей больше 0 PM ставит сам — тогда минимум 0,1 ч, иначе задачи появились бы все разом.
  const own = copy(F.EXAMPLE); own.types.find(t => t.id === 'bug').weight = 1;
  assert.strictEqual(F.normalize(own).types.find(t => t.bug).hours.spec, 0.1);
});

test('разработка заводит такие же задачи: точная доля, тот же тип и домен, в бэклог мимо PM, расчёт сходится с прогоном', () => {
  const ex = F.normalize(F.EXAMPLE);
  const dev = ex.stages.findIndex(s => s.id === 'dev');
  assert.deepStrictEqual(ex.stages[dev].spawn, { percent: 20 });
  assert.ok(!ex.types.some(t => t.id === 'rework'), 'отдельного типа нет');
  const { st, events } = run(F.EXAMPLE, F.SPRINT_H * 6, 0.5);
  const devDone = events.filter(e => (e.type === 'move' || e.type === 'done') && e.from === dev).length;
  const made = events.filter(e => e.type === 'new' && e.spawn);
  assert.strictEqual(made.length, Math.floor(devDone * 0.2 + 1e-9), 'ровно 20% задач после разработки');
  assert.strictEqual(st.spawned, made.length);
  const kind = {}, dom = {};
  events.filter(e => e.type === 'new').forEach(e => { kind[e.task] = e.kind; dom[e.task] = e.domain !== undefined ? e.domain : st.cfg.types[e.kind].domain; });
  made.forEach(e => {
    assert.strictEqual(e.kind, kind[e.of], 'тип — как у исходной');
    assert.strictEqual(e.domain, dom[e.of], 'домен — как у исходной');
    assert.strictEqual(e.to, st.bugEntry, 'в бэклог'); assert.strictEqual(e.from, dev);
  });
  const spawned = new Set(made.map(e => e.task));
  assert.ok(!events.some(e => e.type === 'start' && e.stage === 0 && spawned.has(e.task)), 'PM их не ставит');
  assert.ok(events.some(e => e.type === 'done' && spawned.has(e.task)), 'доходят до «Готово»');
  assert.strictEqual(events.filter(e => e.type === 'new').length, st.doneCount + st.tasks.length);
  // Расчёт: новых задач и багов за спринт столько же, сколько в прогоне (±15%); без spawn новых нет, а задач меньше.
  const f = F.forecast(F.EXAMPLE);
  assert.ok(Math.abs(st.spawned / 6 - f.spawnedPerSprint) / f.spawnedPerSprint < 0.15, `расчёт ${f.spawnedPerSprint}, прогон ${st.spawned / 6}`);
  assert.ok(Math.abs(st.bugsFound / 6 - f.bugsPerSprint) / f.bugsPerSprint < 0.15, `баги: расчёт ${f.bugsPerSprint}, прогон ${st.bugsFound / 6}`);
  const none = copy(F.EXAMPLE); delete none.stages.find(s => s.id === 'dev').spawn;
  assert.strictEqual(F.forecast(none).spawnedPerSprint, 0);
  assert.ok(F.forecast(none).tasksPerWeek < f.tasksPerWeek);
  // spawn с конкретным типом и с несуществующим.
  const typed = copy(F.EXAMPLE); typed.stages.find(s => s.id === 'dev').spawn = { type: 'bug', percent: 10 };
  assert.deepStrictEqual(F.normalize(typed).stages[dev].spawn, { type: 'bug', percent: 10 });
  const bad = copy(F.EXAMPLE); bad.stages.find(s => s.id === 'dev').spawn = { type: 'нет-такого', percent: 15 };
  assert.strictEqual(F.normalize(bad).stages[dev].spawn, undefined);
});

test('стартовый бэклог: процесс начинается с задачами в бэклоге, по долям; не больше лимита; reconfigure не добавляет новых', () => {
  const st = F.create(F.EXAMPLE), q = st.bugEntry;
  assert.strictEqual(F.normalize(F.EXAMPLE).startBacklog, 20);
  assert.strictEqual(st.tasks.length, 20);
  assert.ok(st.tasks.every(t => t.stage === q && t.state === 'wait'));
  const doms = st.tasks.map(t => st.cfg.types[t.type].domain);
  assert.ok(doms.includes('Client') && doms.includes('Backend'), 'оба домена');
  // События о них приходят первым шагом — счётчики сходятся.
  const { events, st: s2 } = run(F.EXAMPLE, F.SPRINT_H, 0.5);
  assert.strictEqual(events.filter(e => e.type === 'new' && e.seed).length, 20);
  assert.strictEqual(events.filter(e => e.type === 'new').length, s2.doneCount + s2.tasks.length);
  // Без startBacklog — пусто; больше лимита бэклога — по лимиту.
  assert.strictEqual(F.create(BASIC).tasks.length, 0);
  const big = copy(F.EXAMPLE); big.startBacklog = 100;
  assert.strictEqual(F.create(big).tasks.length, 25);
  // Изменение настроек задачи не удваивает.
  const r = F.reconfigure(st, F.EXAMPLE);
  assert.strictEqual(r.tasks.length, 20);
  assert.strictEqual(F.step(r, 0.1).filter(e => e.seed).length, 20, 'события стартового бэклога не теряются');
});

test('производительность — только стори от PM: баги и техдолг нагружают людей, но не входят в стори в неделю и SP', () => {
  const f = F.forecast(F.EXAMPLE);
  assert.ok(Math.abs(f.storiesPerWeek - f.storiesPerSprint / 2) < 1e-9);
  assert.ok(f.storiesPerWeek < f.tasksPerWeek, 'задач больше, чем стори: есть баги и техдолг');
  assert.ok(Math.abs(f.tasksPerSprint - f.storiesPerSprint - f.bugsPerSprint - f.spawnedPerSprint) < 1e-6, 'задачи = стори + баги + техдолг');
  const { st, events } = run(F.EXAMPLE, F.SPRINT_H * 6, 0.5);
  const kind = {}, origin = {};
  events.filter(e => e.type === 'new').forEach(e => { kind[e.task] = e.kind; origin[e.task] = e.bug ? 'bug' : e.spawn ? 'debt' : 'story'; });
  const done = events.filter(e => e.type === 'done');
  const stories = done.filter(e => origin[e.task] === 'story');
  assert.ok(stories.length < done.length && stories.length > 0);
  assert.strictEqual(st.storiesDone, stories.length);
  // SP за спринты — сумма SP только готовых стори.
  const sp = stories.reduce((a, e) => a + st.cfg.types[kind[e.task]].sp, 0);
  assert.strictEqual(st.spDone, sp);
  assert.strictEqual(st.sprints.reduce((a, x) => a + x, 0), sp);
  // Факт стори в неделю в среднем близок к расчёту.
  const d0 = st.storiesDone, t0 = st.t;
  for (let h = 0; h < F.WEEK_H * 16; h += 0.5) F.step(st, 0.5);
  const avg = (st.storiesDone - d0) / ((st.t - t0) / F.WEEK_H);
  assert.ok(Math.abs(avg - f.storiesPerWeek) / f.storiesPerWeek < 0.1, `${avg} против ${f.storiesPerWeek}`);
  const n = st.doneAt.filter(x => x > st.t - 2 * F.WEEK_H).length;
  assert.strictEqual(F.throughput(st), n / 2, 'факт — по стори');
});

test('у встроенных пресетов короткие подписи для кнопок', () => {
  assert.deepStrictEqual(F.PRESETS.map(p => p.short), ['Classic', 'Dev AI', 'AI-Assisted', 'Fullstack', '+ PM', '+ AI-Review', '+ AI-Impact', 'Dark Factory', '+ Continuous Discovery']);
  F.PRESETS.forEach(p => assert.ok(p.short.length <= p.name.length, p.id));
});
