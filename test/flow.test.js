// Проверки движка визуализации. Запуск: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const F = require('../flow.js');

const copy = o => JSON.parse(JSON.stringify(o));

// Пример с разделением разработчиков по доменам: в самом примере у них «все» домены.
const withDevDomains = () => {
  const c = copy(F.EXAMPLE);
  const own = { cl1: ['Client'], cl2: ['Client'], be1: ['Backend'], fs1: ['Client', 'Backend'] };
  c.team.forEach(m => { if (own[m.id]) m.domains = own[m.id]; });
  return c;
};

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

test('пример по умолчанию: одна разработка, разработчики берут оба домена', () => {
  const ex = F.normalize(F.EXAMPLE);
  assert.deepStrictEqual(ex.stages.map(s => s.id), ['spec', 'backlog', 'dev', 'review', 'qa']);
  assert.deepStrictEqual(ex.domains, ['Client', 'Backend']);
  const { st, events } = run(F.EXAMPLE, F.SPRINT_H * 4, 0.5);
  const kind = {};
  // Домен задачи: у бага — домен задачи, в которой его нашли.
  events.filter(e => e.type === 'new').forEach(e => { kind[e.task] = e.domain !== undefined ? e.domain : ex.types[e.kind].domain; });
  const starts = events.filter(e => e.type === 'start' && [2, 3].includes(e.stage));
  const doms = Object.fromEntries(ex.team.map(m => [m.id, m.domains || ex.domains]));
  // Разработку и ревью берут только участники домена задачи.
  starts.forEach(e => assert.ok(doms[e.person].includes(kind[e.task]), `${e.person} взял задачу ${kind[e.task]}`));
  ['cl1', 'cl2', 'be1', 'fs1'].forEach(id => assert.ok(starts.some(e => e.person === id), `${id} без задач`));
  assert.ok(starts.some(e => e.person === 'fs1' && kind[e.task] === 'Client') && starts.some(e => e.person === 'fs1' && kind[e.task] === 'Backend'), 'Fullstack делает оба направления');
  assert.strictEqual(events.filter(e => e.type === 'new').length, st.doneCount + st.tasks.length);
  // Узкое место — разработка, расчёт близок к прогону; бэкендер даёт больше, чем клиентщик.
  const f = F.forecast(F.EXAMPLE);
  assert.strictEqual(f.bottleneck, 'dev');
  const s = st.sprints.slice(1), avg = s.reduce((a, x) => a + x, 0) / s.length;
  assert.ok(Math.abs(avg - f.spPerSprint) / f.spPerSprint < 0.1, `расчёт ${f.spPerSprint}, прогон ${avg}`);
  assert.ok(ex.team.filter(m => m.role === 'dev').every(m => !m.domains), 'у разработчиков примера домены не заданы');
  const plus = m => { const c = withDevDomains(); c.team.push(m); return F.forecast(c).spPerSprint; };
  assert.ok(plus({ id: 'be2', name: 'Backend 2', role: 'dev', kind: 'human', domains: ['Backend'] }) > plus({ id: 'cl3', name: 'Client 3', role: 'dev', kind: 'human', domains: ['Client'] }) + 10);
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
  const off = withDevDomains();
  off.team.find(m => m.id === 'fs1').active = false;
  const g = F.forecast(off);
  assert.strictEqual(g.bottleneck, 'dev');
  assert.strictEqual(g.roles.find(r => r.id === 'dev').limitBy, 'Backend', 'без Fullstack упираемся в бэкенд');
  // Фактическая: один исполнитель без перерыва занят всё рабочее время.
  const solo1 = run(solo('human'), 24 * 7, 0.5).st.people[0];
  assert.ok(solo1.onH > 0 && Math.abs(solo1.busyH / solo1.onH - 1) < 1e-9);
  // В примере разработчики загружены больше, чем QA.
  const { st } = run(F.EXAMPLE, F.SPRINT_H * 2, 0.5);
  const util = id => { const p = st.people.find(x => x.id === id); return p.busyH / p.onH; };
  assert.ok(util('be1') > 0.9, `be1 ${util('be1')}`);
  assert.ok(util('qa1') < util('be1'));
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
  assert.strictEqual(humans, (45 + 50 * 3 + 55 + 35 * 2) * 80);
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
  assert.strictEqual(F.create(F.EXAMPLE).people.find(p => p.id === 'fs1').rate, 55);
  assert.deepStrictEqual(['DevOps', 'UX-дизайнер', 'Аналитик'].map(F.refRate), [55, 40, 40]);
});

test('скорость анимации хранится в настройках и проверяется', () => {
  assert.strictEqual(F.normalize(F.EXAMPLE).speed, 4);
  assert.strictEqual(F.fromJSON(JSON.stringify(Object.assign(copy(BASIC), { speed: 24 }))).speed, 24);
  assert.strictEqual(F.normalize(Object.assign(copy(BASIC), { speed: 5 })).speed, 4, 'нет такой скорости — 4 ч/с');
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
  // Добавить бэкендера.
  const cfg = JSON.parse(JSON.stringify(F.EXAMPLE));
  cfg.team.push({ id: 'be2', name: 'Backend 2', role: 'dev', kind: 'human', domains: ['Backend'] });
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
  assert.ok(after(next) > after(same) * 1.1, `с бэкендером ${after(next)}, без ${after(same)}`);
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
  assert.ok(news.filter(e => !e.bug).every(e => !bugIdx.includes(e.kind)), 'PM не ставит баги');
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

test('Bug — обязательный тип: добавляется сам, красный, все баги этого типа и с доменом задачи', () => {
  // В настройках без Bug он появляется с долей 0 и красным цветом.
  const noBug = copy(BASIC); noBug.types = noBug.types.filter(t => t.id !== 'bug');
  const n = F.normalize(noBug), bug = n.types.find(t => t.id === F.BUG_ID);
  assert.ok(bug && bug.bug);
  assert.strictEqual(bug.weight, 0);
  assert.strictEqual(bug.color, '#d64545');
  assert.deepStrictEqual(bug.hours, { spec: 0.5, dev: 1, review: 1, qa: 1 });
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
  const f = F.forecast(F.EXAMPLE), st = run(F.EXAMPLE, F.SPRINT_H * 6, 0.5).st;
  const s = st.sprints.slice(1), avg = s.reduce((a, x) => a + x, 0) / s.length;
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
