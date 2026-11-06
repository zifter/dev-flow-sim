// Движок визуализации: задачи идут по этапам, участники команды берут их по ролям. Без случайности и статистики.
// Работает и в браузере (window.DevFlow), и в node (module.exports).
(function (root) {
  'use strict';

  const MAX_TASKS = 200; // предохранитель, если очередь за первым этапом без лимита
  const EPS = 1e-9;
  const SPRINT_DAYS = 14; // спринт — две календарные недели с понедельника
  const SPRINT_H = SPRINT_DAYS * 24;
  const WEEK_H = 7 * 24;
  const THROUGHPUT_H = 2 * WEEK_H; // пропускная способность — по задачам, закрытым за последние 2 недели модели
  // Нехватка домена сглаживается, чтобы плашка не мигала: доля рабочего времени с нехваткой за последние ~8 ч,
  // плашка появляется выше SHORT_ON и гаснет ниже SHORT_OFF. После изменения настроек считается заново.
  const SHORT_TAU = 8, SHORT_ON = 0.4, SHORT_OFF = 0.05;

  const EXAMPLE = {
    version: 2,
    name: 'Classic',
    description: 'Два клиентщика и два бэкендера, каждый берёт задачи только своего домена',
    humanHours: 8,  // люди работают 8 ч в сутки
    agentHours: 24, // агенты — круглосуточно
    humanDays: 5,   // люди работают 5 дней в неделю, суббота и воскресенье — выходные
    agentDays: 7,   // агенты — без выходных
    currency: '$',  // ставки условные
    agentRate: 3,   // ставка часа работы агента по умолчанию
    assistSpeed: 1.25, // человек с ИИ-ассистентом (assist: true) работает в 1,25 раза быстрее
    // Домены — области работы. Задачу с доменом берут только участники с этим доменом.
    domains: ['Client', 'Backend'],
    roles: [
      // rate — ставка роли в час, участники берут её по умолчанию; creates — какие типы задач роль заводит.
      { id: 'pm', name: 'Product Manager', rate: 45, creates: 'all' },
      { id: 'dev', name: 'Разработчик', rate: 50 },
      { id: 'qa', name: 'QA', rate: 35, creates: ['bug'] }, // QA заводят только баги
    ],
    // Команда: каждый участник — человек или агент со своей ролью. Агент быстрее в speed раз.
    // domains — домены участника; не указаны — все. Два клиентщика и два бэкендера, фулстека нет. rate — ставка в час.
    team: [
      { id: 'pm1', name: 'Product Manager', role: 'pm', kind: 'human' },
      { id: 'cl1', name: 'Client 1', role: 'dev', kind: 'human', domains: ['Client'] },
      { id: 'cl2', name: 'Client 2', role: 'dev', kind: 'human', domains: ['Client'] },
      { id: 'be1', name: 'Backend 1', role: 'dev', kind: 'human', domains: ['Backend'] },
      { id: 'be2', name: 'Backend 2', role: 'dev', kind: 'human', domains: ['Backend'] },
      { id: 'qa1', name: 'QA 1', role: 'qa', kind: 'human' },
      { id: 'qa2', name: 'QA 2', role: 'qa', kind: 'human' },
    ],
    stages: [
      { id: 'spec', name: 'Постановка', role: 'pm' },
      { id: 'backlog', name: 'Бэклог', role: null, limit: 25 }, // WIP-лимит: PM пишет задачи, пока в бэклоге меньше 25
      { id: 'dev', name: 'Разработка', role: 'dev', spawn: { percent: 20 } }, // у 20% задач разработчик заводит техдолг — ещё одну такую же задачу
      { id: 'review', name: 'Код-ревью', role: 'dev' },
      { id: 'qa', name: 'Тестирование', role: 'qa', bugs: true }, // QA находят баги, они уходят в бэклог
    ],
    // Типы задач: доля в потоке, оценка в Story Points, домен и часы человека на каждом этапе.
    // Задачу и её ревью берут только участники её домена. 0 часов — этап пропускается.
    // bugChance — у какой доли задач на тестировании находят баг.
    // Клиентских задач чуть больше (7 против 6 из 13), и по часам разработки Client перевешивает — около 60% против 40%.
    types: [
      { id: 'cl-s', name: 'Client S', color: '#a8d4ff', weight: 3, sp: 2, domain: 'Client', hours: { spec: 1, dev: 2, review: 0.5, qa: 1.25 }, bugChance: 20 },
      { id: 'cl-m', name: 'Client M', color: '#5aa9f0', weight: 3, sp: 3, domain: 'Client', hours: { spec: 3, dev: 6, review: 1, qa: 2.5 }, bugChance: 20 },
      { id: 'cl-l', name: 'Client L', color: '#2f7fd6', weight: 1, sp: 5, domain: 'Client', hours: { spec: 6, dev: 18, review: 2, qa: 8.75 }, bugChance: 20 },
      { id: 'be-s', name: 'Backend S', color: '#ffd29a', weight: 3, sp: 2, domain: 'Backend', hours: { spec: 1, dev: 2, review: 0.5, qa: 1.5 }, bugChance: 20 },
      { id: 'be-m', name: 'Backend M', color: '#f0a34a', weight: 2, sp: 3, domain: 'Backend', hours: { spec: 3, dev: 6, review: 1, qa: 3.75 }, bugChance: 20 },
      { id: 'be-l', name: 'Backend L', color: '#c77422', weight: 1, sp: 5, domain: 'Backend', hours: { spec: 6, dev: 15, review: 2, qa: 8.75 }, bugChance: 20 },
      // Bug — обязательный тип: все найденные баги этого типа, домен баг берёт у задачи, в которой его нашли.
      // Доля 0 — PM баги не ставит, их находят QA.
      { id: 'bug', name: 'Bug', color: '#ebebeb', weight: 0, sp: 1, hours: { spec: 0, dev: 3, review: 0.5, qa: 1.9 }, bugChance: 20 }, // постановка 0: баг заводит тестировщик, это в часах тестирования
    ],
    startBacklog: 20, // в момент 0 в бэклоге уже 20 задач — процесс стартует не с пустой доски
    // Микс по неделям: доля часов работы над клиентскими задачами каждую неделю случайная, от 50 до 60%,
    // последовательность задана seed и на каждом прогоне одна и та же. Расчёт — по среднему, 55%.
    mix: { domain: 'Client', from: 50, to: 60, weeks: 1, seed: 7 },
  };

  // Убрать специализацию: те же участники, но каждый берёт задачи всех доменов.
  const isSpecialized = rawCfg => { const c = normalize(rawCfg); return c.domains.length > 0 && c.team.some(m => m.active !== false && Array.isArray(m.domains) && c.domains.some(d => !m.domains.includes(d))); };
  const unspecialize = rawCfg => { const c = JSON.parse(JSON.stringify(rawCfg)); (c.team || []).forEach(m => { delete m.domains; delete m.skills; }); return c; };

  // Встроенные пресеты — цепочка сцен: каждый следующий строится на предыдущем.
  // Порядок — порядок кнопок быстрого переключения. Новый пресет — новая запись здесь.
  const clone = o => JSON.parse(JSON.stringify(o));
  const named = (cfg, name, description) => Object.assign(clone(cfg), { name, description });
  // ИИ-ассистент у всех людей ролей roles ('*' — у всей команды).
  const withAssist = (cfg, roles) => Object.assign(clone(cfg), { team: cfg.team.map(m => ((roles === '*' || [].concat(roles).includes(m.role)) && m.kind !== 'agent' ? Object.assign({}, m, { assist: true }) : Object.assign({}, m))) });
  // ИИ-ревью после разработки: отдельная роль с одним агентом, быстрый проход по каждой задаче.
  // routes — куда задачи идут после него мимо ревью людьми: { qa: 60 } — 60% сразу в тест, { qa: 30, done: 30 } — ещё и сразу в «Готово».
  const AI_REVIEW_H = { 'cl-s': 0.2, 'cl-m': 0.3, 'cl-l': 0.5, 'be-s': 0.2, 'be-m': 0.3, 'be-l': 0.5, bug: 0.2 };
  function withAIReview(cfg, after, routes) {
    const c = clone(cfg), at = c.stages.findIndex(s => s.id === after) + 1;
    c.roles.push({ id: 'ai-review', name: 'ИИ-ревью' });
    c.team.push({ id: 'ai-rev', name: 'ИИ-ревьюер', role: 'ai-review', kind: 'agent', speed: 1 });
    c.stages.splice(at, 0, { id: 'ai-review', name: 'ИИ-ревью', role: 'ai-review', routes });
    c.types.forEach(t => { t.hours = Object.assign({}, t.hours, { 'ai-review': AI_REVIEW_H[t.id] != null ? AI_REVIEW_H[t.id] : 0.3 }); });
    return c;
  }
  const DEV_ASSISTED = withAssist(EXAMPLE, 'dev'), ASSISTED = withAssist(EXAMPLE, '*');
  const FULLSTACK = unspecialize(ASSISTED);
  // Второй PM с ассистентом: постановка — следующее узкое место после снятия специализации.
  const FULLSTACK_PM = Object.assign(clone(FULLSTACK), { team: FULLSTACK.team.map(m => Object.assign({}, m)).concat([{ id: 'pm2', name: 'Product Manager 2', role: 'pm', kind: 'human', assist: true }]) });
  // Dark Factory (бывший AI-Native): постановку делают люди (PM), всё остальное — один этап «Фабрика агентов», где агенты сразу
  // разрабатывают, ревьюят и тестируют. Время задачи на фабрике — сумма часов разработки, ревью и тестирования.
  // Разработчиков и QA нет; ни багов, ни техдолга фабрика не заводит.
  function aiNative(cfg, agents, speed) {
    const c = clone(cfg);
    c.roles = c.roles.filter(r => r.id === 'pm').concat([{ id: 'factory', name: 'Фабрика агентов', creates: [] }]);
    c.team = c.team.filter(m => m.role === 'pm').concat(Array.from({ length: agents }, (_, i) => ({ id: 'factory-' + (i + 1), name: 'Агент ' + (i + 1), role: 'factory', kind: 'agent', speed })));
    c.stages = c.stages.filter(s => s.id === 'spec' || s.id === 'backlog').map(s => Object.assign({}, s))
      .concat([{ id: 'factory', name: 'Фабрика', role: 'factory' }]);
    c.types.forEach(t => { const h = t.hours || {}; t.hours = { spec: h.spec, factory: (h.dev || 0) + (h.review || 0) + (h.qa || 0) }; });
    return c;
  }
  // Dark Factory + Continuous Discovery: людей нет совсем — задачи ставят ИИ-агенты в роли PM, остальное — фабрика; все агенты ×speed.
  // Бэклога нет: постановка сразу передаёт задачу фабрике, ставится ровно столько, сколько фабрика успевает взять.
  function darkFactory(cfg, speed) {
    const c = clone(cfg);
    c.stages = c.stages.filter(s => s.id !== 'backlog');
    delete c.startBacklog;
    c.team = c.team.map(m => (m.role === 'pm'
      ? { id: 'pm-ai-' + m.id, name: 'ИИ-PM' + (m.id === 'pm1' ? '' : ' 2'), role: 'pm', kind: 'agent', speed }
      : Object.assign({}, m, m.kind === 'agent' ? { speed } : {})));
    return c;
  }
  const AI_NATIVE = aiNative(FULLSTACK_PM, 2, 4);
  // short — подпись на кнопке над схемой (полное имя — в подсказке и описании); «+» значит «предыдущий пресет плюс».
  const PRESETS = [
    { id: 'classic', short: 'Classic', name: 'Classic', cfg: EXAMPLE }, // описание — в EXAMPLE.description
    // Классическая команда, ИИ-ассистент только у разработчиков.
    { id: 'dev-ai-assisted', short: 'Dev AI', name: 'Dev AI-Assisted', cfg: named(DEV_ASSISTED, 'Dev AI-Assisted', 'Та же команда, ИИ-ассистент у разработчиков: каждый работает в 1,25 раза быстрее') },
    // ИИ-ассистент у всей команды — PM, разработчиков и QA. Дальше цепочка строится на нём.
    { id: 'ai-assisted', short: 'AI-Assisted', name: 'AI-Assisted', cfg: named(ASSISTED, 'AI-Assisted', 'ИИ-ассистент у всей команды — PM, разработчиков и QA: все работают в 1,25 раза быстрее') },
    // То же без специализации: любой разработчик берёт любую задачу.
    { id: 'fullstack-ai-assisted', short: 'Fullstack', name: 'Fullstack AI-Assisted', cfg: named(FULLSTACK, 'Fullstack AI-Assisted', 'Ассистент и без специализации: любой разработчик берёт любую задачу') },
    // Плюс второй PM с ассистентом: снимает упор в постановку.
    { id: 'fullstack-pm', short: '+ PM', name: 'Fullstack AI-Assisted + PM', cfg: named(FULLSTACK_PM, 'Fullstack AI-Assisted + PM', 'Плюс второй PM с ИИ-ассистентом: постановка перестаёт быть узким местом') },
    // Плюс ИИ-ревью: 60% задач после него идут сразу в тест, остальные — на ревью людьми.
    { id: 'fullstack-ai-review', short: '+ AI-Review', name: 'Fullstack AI-Assisted AI-Review', cfg: named(withAIReview(FULLSTACK_PM, 'dev', { qa: 60 }), 'Fullstack AI-Assisted AI-Review', 'Плюс ИИ-ревью после разработки: 60% задач сразу в тест, остальные — на ревью людьми') },
    // ИИ-ревью ещё и оценивает влияние: из него задача идёт на ревью людьми, сразу в тест или сразу в «Готово».
    { id: 'ai-impact', short: '+ AI-Impact', name: 'AI-Impact Analysis', cfg: named(withAIReview(FULLSTACK_PM, 'dev', { qa: 30, done: 30 }), 'AI-Impact Analysis', 'ИИ-ревью оценивает влияние: 40% задач на ревью людьми, 30% сразу в тест, 30% сразу в «Готово»') },
    // Dark Factory: люди (двое PM) задают требования и приёмочные сценарии, разработку, ревью и тестирование делают два агента ×4 в одном этапе.
    // id 'ai-native' оставлен для совместимости сохранённого активного пресета.
    { id: 'ai-native', short: 'Dark Factory', name: 'Dark Factory', cfg: named(AI_NATIVE, 'Dark Factory', 'Люди (двое PM) задают требования и приёмочные сценарии, а разработку, ревью и тестирование одним этапом делает фабрика ИИ-агентов') },
    // Dark Factory + Continuous Discovery: людей нет — в модели и постановку автоматизирует ИИ-PM (допущение, а не проверка реального discovery); все агенты ×5, круглосуточно.
    { id: 'dark-factory', short: '+ Continuous Discovery', name: 'Dark Factory + Continuous Discovery', cfg: named(darkFactory(AI_NATIVE, 5), 'Dark Factory + Continuous Discovery', 'Модельное допущение: и постановку делают ИИ-агенты (ИИ-PM), разработку, ревью и тестирование — фабрика агентов; все ×5, круглосуточно') },
  ];

  const SPEEDS = [1, 2, 4, 8, 24, 168];
  const BUG_ID = 'bug', BUG_COLOR = '#ebebeb';
  // Ориентир ставки в час по названию роли, если своей нет. Числа условные.
  function refRate(name) {
    const n = name.toLowerCase();
    if (/product|менеджер|manager|owner|\bpm\b/.test(n)) return 45;
    if (/qa|тест|test/.test(n)) return 35;
    if (/devops|sre|\bops\b/.test(n)) return 55;
    if (/дизайн|design|\bux\b|\bui\b/.test(n)) return 40;
    if (/разраб|dev|client|backend|front|engineer|инженер|программ/.test(n)) return 50;
    return 40;
  }
  // Ставка участника: своя, иначе агентам — agentRate, людям — ставка роли.
  const rateOf = (cfg, m) => (m.rate > 0 ? m.rate : m.kind === 'agent' ? cfg.agentRate : ((cfg.roles.find(r => r.id === m.role) || {}).rate || 0));
  const num = (v, d) => (v != null && v !== '' && Number.isFinite(+v) ? +v : d);
  const clampDay = (v, d) => Math.min(24, Math.max(1, num(v, d)));
  const clampWeek = (v, d) => Math.min(7, Math.max(1, Math.round(num(v, d))));

  // Этап без роли — очередь: задачи ждут, пока их заберёт исполнитель следующего этапа.
  function normalize(cfg) {
    const c = JSON.parse(JSON.stringify(cfg));
    c.currency = String(c.currency || '$').slice(0, 4);
    // Однострочное описание пресета для экрана; пустое — нет.
    if (typeof c.description === 'string' && c.description.trim()) c.description = c.description.replace(/\s+/g, ' ').trim().slice(0, 160); else delete c.description;
    c.agentRate = Math.max(0, num(c.agentRate, 3));
    c.assistSpeed = Math.min(5, Math.max(0.5, num(c.assistSpeed, 1.25)));
    // startBacklog — сколько задач лежит в бэклоге в момент 0, 0–200 (не больше WIP-лимита бэклога, если он есть).
    if (num(c.startBacklog, 0) > 0) c.startBacklog = Math.min(MAX_TASKS, Math.round(num(c.startBacklog, 0))); else delete c.startBacklog;
    delete c.speed; // скорость анимации — настройка экрана, не пресета: старое поле отбрасывается
    c.humanHours = clampDay(c.humanHours, 8);
    c.agentHours = clampDay(c.agentHours, 24);
    c.humanDays = clampWeek(c.humanDays, 5);
    c.agentDays = clampWeek(c.agentDays, 7);
    const rawRoles = c.roles || [];
    // Домены — общий список областей работы (Client, Backend…). Раньше это были направления роли (roles[].skills) —
    // такие конфиги переносятся: направления всех ролей становятся доменами.
    const list = v => [...new Set((Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(Boolean))];
    c.domains = list(Array.isArray(c.domains) ? c.domains : rawRoles.flatMap(r => r.skills || []));
    const domains = new Set(c.domains);
    // Ставка роли: задана — она, нет или 0 — ориентир по названию роли.
    c.roles = rawRoles.map(r => ({ id: String(r.id), name: String(r.name || r.id), rate: num(r.rate, 0) > 0 ? +r.rate : refRate(String(r.name || r.id)) }));
    const ids = new Set(c.roles.map(r => r.id));
    const rawStages = c.stages || [];
    c.stages = rawStages.map(s => {
      const role = s.role && ids.has(s.role) ? s.role : null;
      const st = { id: String(s.id), name: String(s.name || s.id), role };
      if (role) {
        if (s.hours != null) st.hours = Math.max(0.1, +s.hours || 1); // часы по умолчанию для типов без своих
        if (s.bugs) st.bugs = true; // на этом этапе находят баги — см. bugChance у типов
      }
      else st.limit = Math.max(0, Math.round(+s.limit || 0)); // 0 — без лимита
      return st;
    });
    // routes — развилка после этапа с ролью: { id дальнего этапа или 'done': доля в процентах }, остальные задачи идут на следующий этап.
    // Цель — этап через один и дальше или «Готово»; сумма долей не больше 100. Старое skipNext: N — то же, что N% через один этап.
    rawStages.forEach((s, i) => {
      const st = c.stages[i];
      if (!st.role) return;
      const raw = s.routes && typeof s.routes === 'object' ? Object.assign({}, s.routes) : {};
      if (num(s.skipNext, 0) > 0 && i + 1 < c.stages.length) { const k = i + 2 < c.stages.length ? c.stages[i + 2].id : 'done'; raw[k] = num(s.skipNext, 0); }
      const later = new Set(c.stages.slice(i + 2).map(x => x.id).concat(['done']));
      const r = {};
      Object.keys(raw).forEach(k => { const v = Math.min(100, Math.max(0, Math.round(num(raw[k], 0)))); if (later.has(k) && v > 0 && i + 1 < c.stages.length) r[k] = v; });
      const sum = Object.values(r).reduce((a, v) => a + v, 0);
      if (sum > 100) Object.keys(r).forEach(k => { r[k] = Math.floor(r[k] * 100 / sum); });
      if (Object.keys(r).length) st.routes = r;
    });
    // Первый этап — источник задач, у него всегда есть исполнитель.
    if (c.stages.length && !c.stages[0].role && c.roles.length) c.stages[0] = { id: c.stages[0].id, name: c.stages[0].name, role: c.roles[0].id };

    // Команда. Старый конфиг без team: люди по count ролей, агенты из этапов с agent.on.
    let team = c.team;
    if (!Array.isArray(team)) {
      team = [];
      rawRoles.forEach(r => {
        const n = Math.max(0, Math.round(+r.count || 0));
        for (let k = 1; k <= n; k++) team.push({ id: r.id + '-' + k, name: n > 1 ? `${r.name} ${k}` : r.name, role: r.id, kind: 'human' });
      });
      rawStages.forEach(s => {
        if (s.role && ids.has(s.role) && s.agent && s.agent.on) team.push({ id: 'agent-' + s.id, name: 'Агент · ' + s.name, role: s.role, kind: 'agent', speed: s.agent.speed });
      });
    }
    // Ускорение у агента своё (speed), у человека с ИИ-ассистентом — общее assistSpeed. Домены участника — выбранные из общего списка; поле не указано — все домены,
    // включая добавленные потом.
    c.team = c.roles.length ? team.slice(0, 40).map(m => {
      const own = Array.isArray(m.domains) ? m.domains : Array.isArray(m.skills) ? m.skills : null;
      // active: false — участник отключён: остаётся в настройках, но не работает и не входит в расчёт.
      return Object.assign({
        id: String(m.id), name: String(m.name || m.id),
        role: ids.has(m.role) ? m.role : c.roles[0].id,
        kind: m.kind === 'agent' ? 'agent' : 'human',
      }, own ? { domains: list(own).filter(k => domains.has(k)) } : {}, m.kind === 'agent' ? { speed: Math.max(0.1, +m.speed || 5) } : m.assist ? { assist: true } : {}, // assist — человек с ИИ-ассистентом
      num(m.rate, 0) > 0 ? { rate: +m.rate } : {}, // своя ставка в час; нет или 0 — ставка роли, у агента — agentRate
      m.active === false ? { active: false } : {});
    }) : [];

    // Конфиг без типов — один тип «Задача» с часами из этапов.
    let types = Array.isArray(c.types) && c.types.length ? c.types : [{ id: 'task', name: 'Задача', weight: 1, hours: {} }];
    types = types.map(t => {
      const hours = {};
      c.stages.forEach((st, i) => {
        if (!st.role) return;
        const h = t.hours && t.hours[st.id] != null ? +t.hours[st.id] : (st.hours != null ? st.hours : 1);
        // Источник не может быть мгновенным, иначе задачи появятся все разом. Исключение — тип с долей 0
        // (Bug, Доработка): PM его не ставит, задачу заводит тестировщик или разработчик в своё рабочее время.
        const notByPM = !(+t.weight > 0);
        hours[st.id] = Math.max(i === 0 && !notByPM ? 0.1 : 0, Number.isFinite(h) ? h : 1);
      });
      // agents: false — задачи этого типа агенты не берут ни на одном этапе.
      // domain — домен задачи (Client, Backend…); берут её только участники с этим доменом. null — любой.
      const d = t.domain != null ? t.domain : t.skill;
      const domain = d != null && domains.has(String(d)) ? String(d) : null;
      // bugChance — какая доля задач этого типа приносит баг на этапе с bugs (баг — всегда тип Bug).
      // color — цвет карточки задачи на схеме (#rrggbb), без него интерфейс берёт цвет из палитры по порядку.
      return Object.assign({ id: String(t.id), name: String(t.name || t.id), color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? String(t.color).toLowerCase() : null,
        weight: Math.max(0, +t.weight || 0), sp: Math.max(0, num(t.sp, 1)), domain, hours, agents: t.agents !== false,
        bugChance: Math.min(95, Math.max(0, num(t.bugChance, 0))) },
        // tag — короткая подпись на карточке, до 4 символов; нет — интерфейс сокращает название сам.
        typeof t.tag === 'string' && t.tag.trim() ? { tag: t.tag.trim().slice(0, 4) } : {});
    });
    // Bug — обязательный тип: есть всегда, найденные баги — этого типа. Нет в настройках — добавляется
    // с долей 0 (PM его не ставит), 0,5 ч на первом этапе и 1 ч на остальных.
    let bug = types.find(t => t.id === BUG_ID);
    if (!bug) {
      const hours = {};
      c.stages.forEach((st, i) => { if (st.role) hours[st.id] = i === 0 ? 0 : 1; }); // постановки нет: баг заводит тестировщик
      bug = { id: BUG_ID, name: 'Bug', color: null, weight: 0, sp: 1, domain: null, hours, agents: true, bugChance: 0 };
      types.push(bug);
    }
    bug.bug = true;
    if (!bug.color) bug.color = BUG_COLOR;
    const typeIds = new Set(types.map(t => t.id));
    if (!types.some(t => t.weight > 0)) types.forEach(t => { t.weight = 1; });
    // Микс по неделям: домен, доля его часов от/до в процентах, длина периода в неделях, seed. Нет домена — микса нет.
    const mx = c.mix && typeof c.mix === 'object' ? c.mix : null;
    if (mx && domains.has(String(mx.domain))) {
      const pct = (v, d) => Math.min(99, Math.max(1, num(v, d)));
      const from = pct(mx.from, 50), to = pct(mx.to, 60);
      c.mix = { domain: String(mx.domain), from: Math.min(from, to), to: Math.max(from, to), weeks: Math.min(52, Math.max(1, Math.round(num(mx.weeks, 1)))), seed: Math.round(num(mx.seed, 1)) };
    } else delete c.mix;
    delete c.phases;
    c.types = types;
    // spawn — этап с ролью заводит новые задачи: { percent: доля задач, у которых появляется новая, 1–95, type: id типа }.
    // Без type новая задача — такая же, как исходная: того же типа и домена. Идёт в бэклог мимо PM.
    rawStages.forEach((s, i) => {
      const st = c.stages[i], sp = s.spawn;
      if (!st.role || !sp || typeof sp !== 'object') return;
      const pct = Math.min(95, Math.max(0, Math.round(num(sp.percent, 0))));
      if (!(pct > 0)) return;
      if (sp.type == null) st.spawn = { percent: pct };
      else if (types.some(t => t.id === String(sp.type))) st.spawn = { type: String(sp.type), percent: pct };
    });
    // creates — какие типы задач роль заводит: 'all' или список id. Исполнитель первого этапа ставит новые задачи
    // только этих типов, исполнитель этапа с bugs находит баги только этих типов. Не задано (старые настройки) —
    // роль первого этапа заводит все типы, роли этапов с bugs — типы своих багов, остальные — ничего.
    rawRoles.forEach((r, i) => {
      const role = c.roles[i];
      if (r.creates === 'all') role.creates = 'all';
      else if (Array.isArray(r.creates)) {
        role.creates = r.creates.map(String).filter(id => typeIds.has(id));
        // Ссылки на прежние отдельные типы багов (Bug Client, Bug Backend…) у роли, которая находит баги, — это Bug.
        const stale = r.creates.some(id => !typeIds.has(String(id)));
        if (stale && c.stages.some(s => s.bugs && s.role === role.id) && !role.creates.includes(BUG_ID)) role.creates.push(BUG_ID);
      }
      else role.creates = c.stages[0] && c.stages[0].role === role.id ? 'all' : c.stages.some(s => s.bugs && s.role === role.id) ? [BUG_ID] : [];
    });
    return c;
  }

  // Кто выполняет этап: роль. null — очередь.
  const performer = stage => stage.role || null;

  function initials(name) {
    const w = name.trim().split(/\s+/).filter(Boolean);
    if (w.length > 1) return w.map(x => x[0]).join('').slice(0, 3).toUpperCase();
    return name.length <= 3 ? name : name[0].toUpperCase();
  }

  // Время модели — часы от 9:00 понедельника. Каждые сутки рабочее окно с 0 до humanHours (agentHours),
  // в неделе рабочие первые humanDays (agentDays) суток.
  const mod24 = t => ((t % 24) + 24) % 24;
  const schedule = (cfg, agent) => (agent ? [cfg.agentHours, cfg.agentDays] : [cfg.humanHours, cfg.humanDays]);
  const workday = (t, days) => Math.floor((t + EPS) / 24) % 7 < days;
  function isOn(st, p, t) {
    const [len, days] = schedule(st.cfg, p.agent);
    return workday(t, days) && (len >= 24 || mod24(t + EPS) < len - EPS);
  }
  // Ближайшая смена рабочего и нерабочего времени у кого-нибудь из команды или граница спринта (для стоимости по спринтам).
  function nextBoundary(st, t) {
    let b = (Math.floor((t + EPS) / SPRINT_H) + 1) * SPRINT_H;
    [false, true].forEach(agent => {
      const [len, days] = schedule(st.cfg, agent);
      if ((len >= 24 && days >= 7) || !st.people.some(p => p.agent === agent)) return;
      const rel = mod24(t + EPS), base = t + EPS - rel;
      b = Math.min(b, workday(t, days) && len < 24 && rel < len - EPS ? base + len : base + 24);
    });
    return b;
  }

  function create(rawCfg) {
    const cfg = normalize(rawCfg);
    const team = cfg.team.filter(m => m.active !== false);
    const agents = team.filter(m => m.kind === 'agent').length;
    let a = 0;
    const people = team.map(m => ({
      id: m.id, role: m.role, agent: m.kind === 'agent', assist: !!m.assist, speed: m.kind === 'agent' ? m.speed : m.assist ? cfg.assistSpeed : 1,
      label: m.kind === 'agent' ? 'ИИ' + (agents > 1 ? ++a : '') : initials(m.name),
      name: m.name, domains: m.domains || cfg.domains.slice(), rate: rateOf(cfg, m), task: null, idle: '', done: 0,
      onH: 0, busyH: 0, // часы рабочего времени и из них занятые — для фактической загрузки
    }));
    // Баги попадают в первую очередь после источника (бэклог), а если очереди нет — на второй этап.
    const q = cfg.stages.findIndex((s, i) => i > 0 && !s.role);
    const bugEntry = q > 0 ? q : Math.min(1, cfg.stages.length - 1);
    const st = {
      cfg, t: 0, nextId: 1, seq: 0, people, tasks: [], doneCount: 0, storiesDone: 0, done: [], doneAt: [], short: {}, mix: cfg.types.map(() => 0), spDone: 0, sprints: [],
      bugEntry, bugAcc: cfg.types.map(() => 0), bugsFound: 0, changes: [], routeAcc: {}, routed: {}, spawnAcc: {}, spawned: 0,
      cost: { humans: 0, agents: 0, idle: 0 }, sprintCost: [], pending: [],
    };
    seedBacklog(st);
    return st;
  }
  // Стартовый бэклог: startBacklog задач уже лежат в первой очереди в момент 0 — процесс начинается не с нуля.
  // Типы — по долям, которые ставит роль первого этапа (с миксом первой недели), без случайности.
  // События «new» о них отдаёт первый step, чтобы счётчики сходились: создано = готово + в процессе.
  function seedBacklog(st) {
    const cfg = st.cfg, q = cfg.stages[st.bugEntry];
    if (!cfg.startBacklog || !q || q.role) return;
    const n = q.limit > 0 ? Math.min(cfg.startBacklog, q.limit) : cfg.startBacklog;
    const W = weightsAt(cfg, 0), src = performer(cfg.stages[0]);
    const ok = cfg.types.map((t, i) => W[i] > 0 && creates(cfg, src, i));
    const total = cfg.types.reduce((a, t, i) => a + (ok[i] ? W[i] : 0), 0);
    if (!(total > 0)) return;
    for (let k = 0; k < n; k++) {
      let best = -1;
      cfg.types.forEach((t, i) => { if (!ok[i]) return; st.mix[i] += W[i]; if (best < 0 || st.mix[i] > st.mix[best]) best = i; });
      st.mix[best] -= total;
      const t = { id: st.nextId++, type: best, stage: st.bugEntry, state: 'wait', seq: st.seq++, person: null, last: null, left: 0, total: 0 };
      st.tasks.push(t);
      st.pending.push({ type: 'new', task: t.id, kind: best, to: st.bugEntry, seed: true, at: 0 });
    }
  }

  // Может ли участник работать с задачей этого типа: агентам доступны только типы с agents.
  // и только задачи своих доменов.
  // domain — домен конкретной задачи, если он свой (у бага — домен задачи, в которой его нашли); иначе домен типа.
  function canDo(st, p, type, domain) {
    const t = st.cfg.types[type], d = domain === undefined ? t.domain : domain;
    if (p.agent && !t.agents) return false;
    return !d || p.domains.includes(d);
  }
  const domOf = (st, t) => (t.domain !== undefined ? t.domain : st.cfg.types[t.type].domain);

  // Новые настройки посреди процесса: время, история спринтов, задачи и счётчики сохраняются,
  // меняются команда, этапы и типы. Задача остаётся у исполнителя, если он есть и может её делать,
  // иначе возвращается в очередь своего этапа. Задачи удалённого типа снимаются, с удалённого этапа — встают на этап с тем же номером.
  function reconfigure(old, rawCfg) {
    const st = create(rawCfg);
    st.tasks = []; st.pending = (old.pending || []).slice(); // стартовый бэклог — только у нового процесса, задачи переносятся из старого
    const S = st.cfg.stages, T = st.cfg.types;
    const typeIdx = i => (old.cfg.types[i] ? T.findIndex(t => t.id === old.cfg.types[i].id) : -1);
    Object.assign(st, {
      t: old.t, nextId: old.nextId, seq: old.seq, doneCount: old.doneCount, storiesDone: old.storiesDone || 0, spDone: old.spDone,
      sprints: old.sprints.slice(), sprintCost: old.sprintCost.slice(), cost: Object.assign({}, old.cost),
      bugsFound: old.bugsFound, changes: (old.changes || []).concat([old.t]), doneAt: (old.doneAt || []).slice(), routeAcc: JSON.parse(JSON.stringify(old.routeAcc || {})), routed: JSON.parse(JSON.stringify(old.routed || {})), spawnAcc: Object.assign({}, old.spawnAcc), spawned: old.spawned || 0,
      done: old.done.map(d => ({ id: d.id, type: typeIdx(d.type), domain: d.domain, spawned: d.spawned })).filter(d => d.type >= 0),
    });
    old.cfg.types.forEach((t, i) => { const j = typeIdx(i); if (j >= 0) { st.mix[j] = old.mix[i]; st.bugAcc[j] = old.bugAcc[i]; } });
    st.people.forEach(p => { const q = old.people.find(x => x.id === p.id); if (q) Object.assign(p, { onH: q.onH, busyH: q.busyH, done: q.done }); });
    old.tasks.forEach(t => {
      const type = typeIdx(t.type);
      if (type < 0) return;
      const was = old.cfg.stages[t.stage], j = S.findIndex(x => x.id === was.id);
      const nt = Object.assign({}, t, { type, stage: j >= 0 ? j : Math.min(t.stage, S.length - 1) });
      if (nt.state === 'work') {
        const p = st.people.find(x => x.id === nt.person);
        if (p && p.task == null && performer(S[nt.stage]) === p.role && canDo(st, p, type, nt.domain) && hoursFor(st, nt, nt.stage) > 0) p.task = nt.id;
        else Object.assign(nt, { state: 'wait', person: null, left: 0, total: 0, seq: st.seq++ });
      }
      st.tasks.push(nt);
    });
    return st;
  }

  // Тип следующей задачи: взвешенная очередь без случайности (smooth weighted round-robin).
  // При весах 3 и 1 из каждых четырёх задач три будут первого типа, и они перемешаны.
  // Агент ставит только типы, доступные агентам; очередь идёт по ним.
  // Заводит ли роль задачи этого типа.
  const creates = (cfg, role, type) => { const r = cfg.roles.find(x => x.id === role); return !!r && (r.creates === 'all' || (r.creates || []).includes(cfg.types[type].id)); };
  // Микс по неделям: в каждом периоде доля часов работы над задачами домена — случайная между from и to.
  // Случайность детерминированная: число периода и seed дают одно и то же значение на каждом прогоне.
  const rand01 = (seed, k) => { let x = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0; x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d) >>> 0; x ^= x >>> 12; x = Math.imul(x, 0x297a2d39) >>> 0; x ^= x >>> 15; return (x >>> 0) / 4294967296; };
  const typeHours = t => Object.keys(t.hours).reduce((a, k) => a + (t.hours[k] || 0), 0);
  function mixAt(cfg, t) {
    const m = cfg.mix;
    if (!m) return null;
    const period = Math.floor((t + EPS) / (m.weeks * WEEK_H));
    return { domain: m.domain, share: (m.from + (m.to - m.from) * rand01(m.seed, period)) / 100, period, start: period * m.weeks * WEEK_H, end: (period + 1) * m.weeks * WEEK_H };
  }
  // Доли типов, при которых задачи домена дают share часов работы: доли типов домена умножаются на один коэффициент.
  function weightsFor(cfg, share) {
    const W = cfg.types.map(t => t.weight);
    if (!cfg.mix || share == null) return W;
    let hd = 0, ho = 0;
    cfg.types.forEach((t, i) => { const h = W[i] * typeHours(t); if (t.domain === cfg.mix.domain) hd += h; else ho += h; });
    if (!(hd > 0) || !(ho > 0)) return W;
    const k = share * ho / ((1 - share) * hd);
    return cfg.types.map((t, i) => (t.domain === cfg.mix.domain ? W[i] * k : W[i]));
  }
  const weightsAt = (cfg, t) => { const m = mixAt(cfg, t); return weightsFor(cfg, m && m.share); };
  // Расчёт — по средней доле: (from + to) / 2.
  const avgWeights = cfg => weightsFor(cfg, cfg.mix ? (cfg.mix.from + cfg.mix.to) / 200 : null);

  function nextType(st, p) {
    const T = st.cfg.types, W = weightsAt(st.cfg, st.t), ok = T.map((t, i) => canDo(st, p, i) && W[i] > 0 && creates(st.cfg, p.role, i));
    const total = T.reduce((x, t, i) => x + (ok[i] ? W[i] : 0), 0);
    let best = -1;
    T.forEach((t, i) => { if (!ok[i]) return; st.mix[i] += W[i]; if (best < 0 || st.mix[i] > st.mix[best]) best = i; });
    st.mix[best] -= total;
    return best;
  }

  const hoursFor = (st, t, s) => st.cfg.types[t.type].hours[st.cfg.stages[s].id] || 0;
  // Сколько участников роли могут взять эту задачу.
  const ableCount = (st, role, t) => st.people.filter(p => p.role === role && canDo(st, p, t.type, t.domain)).length;
  const taskById = (st, id) => st.tasks.find(t => t.id === id);

  function move(st, t, to, ev) {
    const from = t.stage;
    if (to >= st.cfg.stages.length) {
      st.tasks.splice(st.tasks.indexOf(t), 1);
      st.doneCount++;
      st.done.push({ id: t.id, type: t.type, domain: domOf(st, t) || null, spawned: !!t.spawned });
      // Производительность — только стори, которые поставил PM: баги и техдолг — работа, но не результат.
      const story = !t.bug && !t.spawned;
      if (story) {
        st.storiesDone++;
        st.doneAt.push(st.t);
        while (st.doneAt.length && st.doneAt[0] <= st.t - THROUGHPUT_H) st.doneAt.shift();
      }
      // Story Points стори засчитываются в спринт, в котором она дошла до «Готово».
      const sp = story ? st.cfg.types[t.type].sp : 0, k = Math.floor((st.t + EPS) / SPRINT_H);
      while (st.sprints.length <= k) st.sprints.push(0);
      st.sprints[k] += sp; st.spDone += sp;
      if (st.done.length > 12) st.done.shift();
      ev.push({ type: 'done', task: t.id, from, to, at: st.t });
      return;
    }
    t.stage = to; t.state = 'wait'; t.seq = st.seq++;
    ev.push({ type: 'move', task: t.id, from, to, at: st.t });
  }

  function start(st, p, t, ev) {
    t.state = 'work'; t.person = p.id; t.total = t.left = hoursFor(st, t, t.stage) / p.speed;
    p.task = t.id; p.idle = '';
    ev.push({ type: 'start', task: t.id, stage: t.stage, person: p.id, at: st.t });
  }

  // Что возьмёт свободный участник: сначала задачи с поздних этапов, внутри этапа — кто раньше пришёл.
  // Следующий этап задачи не берёт тот, кто последним делал её в своей роли, если в роли есть кто-то ещё, кто может её взять.
  // Считается по роли, а не по соседнему этапу: ИИ-ревью между разработкой и ревью не даёт автору ревьюить свой код.
  const ownWork = (t, p) => !!t.lastBy && t.lastBy[p.role] === p.id;
  function pick(st, p) {
    const S = st.cfg.stages;
    let best = null, bestTo = -1;
    st.tasks.forEach(t => {
      if (t.state !== 'wait') return;
      const to = S[t.stage].role ? t.stage : t.stage + 1;
      if (to >= S.length || performer(S[to]) !== p.role || !canDo(st, p, t.type, t.domain)) return;
      if (hoursFor(st, t, to) === 0) return; // этап этой задаче не нужен — её проведёт дальше assign, без исполнителя
      if (ownWork(t, p) && ableCount(st, p.role, t) > 1) return;
      if (to > bestTo || (to === bestTo && t.seq < best.seq)) { best = t; bestTo = to; }
    });
    return best ? { t: best, to: bestTo } : null;
  }

  // Может ли участник начать новую задачу на первом этапе: очередь за ним не должна быть полна.
  function canCreate(st, p) {
    const S = st.cfg.stages;
    if (!S.length || performer(S[0]) !== p.role) return false;
    if (st.tasks.length >= MAX_TASKS) { p.idle = 'задач слишком много'; return false; }
    const W = weightsAt(st.cfg, st.t);
    if (!st.cfg.types.some((t, i) => W[i] > 0 && creates(st.cfg, p.role, i))) { p.idle = 'роль не заводит задачи'; return false; }
    if (!st.cfg.types.some((t, i) => W[i] > 0 && creates(st.cfg, p.role, i) && canDo(st, p, i))) { p.idle = 'нет типов задач для агентов'; return false; }
    const next = S[1];
    if (next && !next.role && next.limit > 0) {
      const n = st.tasks.filter(t => t.stage <= 1).length;
      if (n >= next.limit) { p.idle = `${next.name.toLowerCase()}: полно`; return false; }
    }
    // Очереди за постановкой нет — система вытягивающая: новая задача ставится, только пока у следующего этапа
    // ждущих (и ставящихся) задач меньше, чем у него исполнителей. Иначе источник заваливал бы процесс задачами.
    if (next && next.role) {
      const crew = st.people.filter(q => q.role === next.role).length || 1;
      const n = st.tasks.filter(t => t.stage === 0 || (t.stage === 1 && t.state === 'wait')).length;
      if (n >= crew) { p.idle = `${next.name.toLowerCase()}: есть запас`; return false; }
    }
    return true;
  }

  // Ждёт ли задача участника этой роли: на этапе роли или в очереди перед ним.
  function waitsForRole(st, t, role) {
    const S = st.cfg.stages;
    if (t.state !== 'wait') return false;
    const to = S[t.stage].role ? t.stage : t.stage + 1;
    return to < S.length && performer(S[to]) === role;
  }
  // Почему участник без дела: работа для роли есть, но ему её брать нельзя. Перечисляем все причины
  // с числом задач, самая частая — первой. p.idle — коротко для карточки («не берёт: 25 только люди · 3 своё ревью»),
  // p.idleWhy — подробно, с типами и доменами («только для людей: 25 (M, L, XL); ревью своего кода: 3»).
  function idleReason(st, p) {
    const waiting = st.tasks.filter(t => waitsForRole(st, t, p.role));
    const T = st.cfg.types, names = list => [...new Set(list)].join(', ');
    const human = p.agent ? waiting.filter(t => !T[t.type].agents) : [];
    const domain = waiting.filter(t => !human.includes(t) && !canDo(st, p, t.type, t.domain));
    const own = waiting.filter(t => !human.includes(t) && !domain.includes(t) && ownWork(t, p));
    const parts = [
      [human.length, 'только люди', `только для людей: ${human.length} (${names(human.map(t => T[t.type].name))})`],
      [domain.length, 'др. домен', `другой домен: ${domain.length} (${names(domain.map(t => domOf(st, t) || 'любой'))})`],
      [own.length, 'своё ревью', `ревью своего кода: ${own.length}`],
    ].filter(([n]) => n > 0).sort((a, b) => b[0] - a[0]);
    if (!parts.length) return ['ждёт задач', ''];
    return ['не берёт: ' + parts.map(([n, short]) => `${n} ${short}`).join(' · '), 'не может взять — ' + parts.map(x => x[2]).join('; ')];
  }

  function assign(st, ev) {
    const S = st.cfg.stages;
    st.people.forEach(p => { if (p.task == null) p.idle = p.idleWhy = ''; });
    for (let changed = true; changed;) {
      changed = false;
      // Задача проходит этап без исполнителя, если для её типа на нём 0 часов.
      // Очередь в конце, перед другой очередью или перед таким этапом задачу не держит.
      const skip = (t, s) => s < S.length && S[s].role && hoursFor(st, t, s) === 0;
      st.tasks.slice().forEach(t => {
        if (t.state !== 'wait') return;
        const s = t.stage, q = !S[s].role;
        if (skip(t, s) || (q && (s + 1 >= S.length || !S[s + 1].role || skip(t, s + 1)))) { move(st, t, s + 1, ev); changed = true; }
      });
      st.people.forEach(p => {
        if (p.task != null) return;
        if (!isOn(st, p, st.t)) { p.idle = 'нерабочее время'; return; }
        const c = pick(st, p);
        if (c) {
          if (c.to !== c.t.stage) move(st, c.t, c.to, ev);
          start(st, p, c.t, ev);
          changed = true;
        } else if (canCreate(st, p)) {
          const t = { id: st.nextId++, type: nextType(st, p), stage: 0, state: 'wait', seq: st.seq++, person: null, last: null, left: 0, total: 0 };
          st.tasks.push(t);
          ev.push({ type: 'new', task: t.id, kind: t.type, to: 0, at: st.t });
          start(st, p, t, ev);
          changed = true;
        } else if (!p.idle) [p.idle, p.idleWhy] = idleReason(st, p);
      });
    }
  }

  // На этапе с bugs исполнитель находит баги: точно у bugChance% задач типа, без случайности (накопитель по типу).
  // Баги у задачи на этапе si: находит роль этапа; by — кто нашёл (у пропущенного этапа — никто, дефект всплыл позже).
  function findBugs(st, t, si, role, by, ev) {
    const tp = st.cfg.types[t.type];
    if (!st.cfg.stages[si].bugs || !tp.bugChance) return;
    const bt = st.cfg.types.findIndex(x => x.bug);
    if (!creates(st.cfg, role, bt)) return; // роль не заводит такие баги
    st.bugAcc[t.type] += tp.bugChance / 100;
    while (st.bugAcc[t.type] >= 1 - EPS) {
      st.bugAcc[t.type] -= 1;
      if (st.tasks.length >= MAX_TASKS) continue;
      const domain = domOf(st, t) || st.cfg.types[bt].domain || null; // баг клиентской задачи — клиентский
      const b = { id: st.nextId++, type: bt, domain, stage: st.bugEntry, state: 'wait', seq: st.seq++, person: null, last: null, left: 0, total: 0, bug: true };
      st.tasks.push(b);
      st.bugsFound++;
      ev.push({ type: 'new', task: b.id, kind: bt, domain, to: st.bugEntry, from: si, bug: true, of: t.id, by, at: st.t });
    }
  }

  function finish(st, t, ev) {
    const p = st.people.find(x => x.id === t.person);
    p.task = null; p.done++;
    t.last = p.id; t.lastBy = Object.assign({}, t.lastBy, { [p.role]: p.id }); t.person = null;
    findBugs(st, t, t.stage, p.role, p.id, ev);
    spawnTasks(st, t, t.stage, p.id, ev);
    // Развилка: задача идёт на следующий этап или сразу дальше. Пропущенные этапы, где ищут баги, дефекты не прячут — они всплывут позже.
    const to = routeNext(st, t.stage);
    for (let k = t.stage + 1; k < to && k < st.cfg.stages.length; k++) if (st.cfg.stages[k].bugs) findBugs(st, t, k, st.cfg.stages[k].role, null, ev);
    move(st, t, to, ev);
  }
  // Этап со spawn заводит новые задачи: у доли percent задач появляется новая — такая же, как исходная
  // (или типа spawn.type, если он задан). Доля точная, без случайности (при 15% — три новых на каждые двадцать задач);
  // новая идёт в бэклог мимо PM, домен берёт у исходной задачи. Счётчик — st.spawned.
  function spawnTasks(st, t, si, by, ev) {
    const s = st.cfg.stages[si], sp = s.spawn;
    if (!sp) return;
    const ti = sp.type ? st.cfg.types.findIndex(x => x.id === sp.type) : t.type;
    if (ti < 0) return;
    st.spawnAcc[s.id] = (st.spawnAcc[s.id] || 0) + sp.percent / 100;
    while (st.spawnAcc[s.id] >= 1 - EPS) {
      st.spawnAcc[s.id] -= 1;
      if (st.tasks.length >= MAX_TASKS) continue;
      const domain = domOf(st, t) || st.cfg.types[ti].domain || null;
      const n = Object.assign({ id: st.nextId++, type: ti, domain, stage: st.bugEntry, state: 'wait', seq: st.seq++, person: null, last: null, left: 0, total: 0, spawned: true }, st.cfg.types[ti].bug ? { bug: true } : {});
      st.tasks.push(n);
      st.spawned++;
      ev.push({ type: 'new', task: n.id, kind: ti, domain, to: st.bugEntry, from: si, spawn: true, of: t.id, by, at: st.t });
    }
  }
  // Куда идёт задача после этапа i: по долям routes, точно и без случайности (smooth weighted round-robin) —
  // при 40/30/30 из каждых десяти задач четыре, три и три, и они перемешаны. Счётчики — st.routed[id этапа][цель].
  function routeNext(st, i) {
    const S = st.cfg.stages, s = S[i];
    if (!s.routes) return i + 1;
    const keys = Object.keys(s.routes), rest = 100 - keys.reduce((a, k) => a + s.routes[k], 0);
    const opts = [['next', rest]].concat(keys.map(k => [k, s.routes[k]])).filter(([, w]) => w > 0);
    const acc = st.routeAcc[s.id] = st.routeAcc[s.id] || {};
    let best = null;
    opts.forEach(([k, w]) => { acc[k] = (acc[k] || 0) + w; if (!best || acc[k] > acc[best]) best = k; });
    acc[best] -= 100;
    const r = st.routed[s.id] = st.routed[s.id] || {};
    r[best] = (r[best] || 0) + 1;
    if (best === 'next') return i + 1;
    if (best === 'done') return S.length;
    const j = S.findIndex(x => x.id === best);
    return j > i ? j : i + 1;
  }

  // Продвинуть время на dt часов. Работа идёт только в рабочее время исполнителя;
  // в нерабочее задача остаётся за ним и ждёт утра. Возвращает события: new, start, move, done.
  function step(st, dt) {
    const ev = (st.pending || []).splice(0);
    assign(st, ev);
    let rem = Math.max(0, dt);
    for (let guard = 0; guard < 10000 && rem > EPS; guard++) {
      const busy = st.tasks.filter(t => t.state === 'work' && isOn(st, st.people.find(p => p.id === t.person), st.t));
      const m = busy.reduce((a, t) => Math.min(a, t.left), Infinity);
      const seg = Math.max(0, Math.min(rem, m, nextBoundary(st, st.t) - st.t));
      busy.forEach(t => { t.left -= seg; });
      const k = Math.floor((st.t + EPS) / SPRINT_H);
      while (st.sprintCost.length <= k) st.sprintCost.push(0);
      st.people.forEach(p => {
        if (!isOn(st, p, st.t)) return;
        const working = p.task != null;
        p.onH += seg; if (working) p.busyH += seg;
        // Людям платим за рабочее время целиком, простой — его незанятая часть; агентам — только за работу.
        const c = p.agent ? (working ? seg * p.rate : 0) : seg * p.rate;
        if (p.agent) st.cost.agents += c; else { st.cost.humans += c; if (!working) st.cost.idle += c; }
        st.sprintCost[k] += c;
      });
      trackShortage(st, seg);
      st.t += seg; rem -= seg;
      busy.filter(t => t.left <= EPS).forEach(t => finish(st, t, ev));
      assign(st, ev);
    }
    return ev;
  }

  // Нехватка домена: задачи домена D ждут роль R, а кто-то из R на работе и без дела, но домена D у него нет.
  // Копится сглаженно и только пока кто-то из роли на работе — ночью и в выходные сигнал не меняется.
  function shortageNow(st) {
    const S = st.cfg.stages, now = {};
    st.cfg.roles.forEach(r => {
      const team = st.people.filter(p => p.role === r.id);
      if (!team.some(p => isOn(st, p, st.t))) return;
      const free = team.filter(p => p.task == null && isOn(st, p, st.t));
      st.cfg.domains.forEach(d => {
        const waiting = st.tasks.filter(t => waitsForRole(st, t, r.id) && domOf(st, t) === d).length;
        now[r.id + '|' + d] = waiting > 0 && free.some(p => !p.domains.includes(d)) ? 1 : 0;
      });
    });
    return now;
  }
  function trackShortage(st, dt) {
    if (!(dt > 0) || !st.cfg.domains.length) return;
    const now = shortageNow(st), k = 1 - Math.exp(-dt / SHORT_TAU);
    Object.keys(now).forEach(key => {
      const s = st.short[key] || { level: 0, on: false };
      s.level += (now[key] - s.level) * k;
      s.on = s.on ? s.level > SHORT_OFF : s.level > SHORT_ON;
      st.short[key] = s;
    });
  }
  // Видимые нехватки: роль, домен, этап роли, сколько задач домена ждут сейчас.
  function shortages(st) {
    const S = st.cfg.stages;
    return Object.keys(st.short || {}).filter(key => st.short[key].on).map(key => {
      const [role, domain] = key.split('|');
      if (!st.cfg.roles.some(r => r.id === role) || !st.cfg.domains.includes(domain)) return null;
      const stage = S.findIndex(s => s.role === role);
      const waiting = st.tasks.filter(t => waitsForRole(st, t, role) && domOf(st, t) === domain).length;
      return { role, domain, stage, waiting };
    }).filter(Boolean);
  }
  // Производительность: стори в неделю (только от PM — без багов и техдолга), закрытых за последние 2 недели
  // (в первые 2 недели — за всё время). До конца первой недели цифры нет.
  function throughput(st) {
    if (st.t < WEEK_H - EPS) return null;
    const win = Math.min(THROUGHPUT_H, st.t);
    return (st.doneAt || []).filter(t => t > st.t - win + EPS).length / (win / WEEK_H);
  }

  // Расчётная скорость: сколько SP за спринт выдержит команда, если работа не простаивает.
  // Ёмкость роли — часы людей и агентов за спринт (агентский час стоит speed человеческих, час человека с ассистентом — assistSpeed),
  // нагрузка — средние часы роли на задачу по долям типов. Предел — самая загруженная роль.
  // Задачи «только для людей» и задачи каждого направления отдельно проверяются по ёмкости тех, кто может их делать.
  function forecast(rawCfg) {
    const cfg = normalize(rawCfg);
    const weeks = SPRINT_DAYS / 7;
    // Доли — среди типов, которые заводит роль первого этапа.
    const src = cfg.stages[0] ? cfg.stages[0].role : null;
    // Доли — по средней доле микса: неделя к неделе прогон отличается от расчёта, в среднем сходится.
    const AW = avgWeights(cfg);
    const made = cfg.types.map((t, i) => creates(cfg, src, i) && AW[i] > 0);
    const total = cfg.types.reduce((a, t, i) => a + (made[i] ? AW[i] : 0), 0);
    const share = cfg.types.map((t, i) => (made[i] && total > 0 ? AW[i] / total : 0));
    // Доля задач, которая доходит до каждого этапа: развилки (routes) уводят часть задач дальше, мимо промежуточных этапов.
    const reach = cfg.stages.map(() => 0);
    if (reach.length) reach[0] = 1;
    cfg.stages.forEach((s, i) => {
      const r = s.routes || {}, sum = Object.values(r).reduce((a, v) => a + v, 0);
      if (i + 1 < reach.length) reach[i + 1] += reach[i] * (1 - sum / 100);
      Object.keys(r).forEach(k => { const j = cfg.stages.findIndex(x => x.id === k); if (j > i) reach[j] += reach[i] * r[k] / 100; });
    });
    const pass = si => reach[si];
    // Баги: сколько задач каждого типа появляется от багов на одну задачу PM (с багами от багов).
    // Задача, ушедшая мимо тестирования, дефекты не теряет — их находят позже, доля та же.
    const bugStages = cfg.stages.map((s, i) => (s.bugs ? i : -1)).filter(i => i >= 0);
    const q = cfg.stages.findIndex((s, i) => i > 0 && !s.role), entry = q > 0 ? q : Math.min(1, cfg.stages.length - 1);
    const bi = cfg.types.findIndex(t => t.bug);
    const tested = t => bugStages.some(i => t.hours[cfg.stages[i].id] > 0 && creates(cfg, cfg.stages[i].role, bi));
    // Потоки задач на одну задачу PM: (тип, домен, от PM, от багов). Баг берёт домен задачи, в которой его нашли.
    // Рождённые задачи — баги от QA и задачи от этапов со spawn (доработки от разработки): идут с бэклога,
    // домен берут у исходной задачи и сами могут рождать новые. Поле bug у потока — их количество на одну задачу PM.
    const flows = cfg.types.map((t, i) => ({ i, d: t.domain, full: share[i], bug: 0 }));
    // ti: null — новая задача того же типа, что исходная.
    const spawnAt = cfg.stages.map((s, si) => (s.spawn ? { si, ti: s.spawn.type ? cfg.types.findIndex(t => t.id === s.spawn.type) : null, p: s.spawn.percent / 100 } : null)).filter(x => x && x.ti !== -1);
    const bornFlow = (ti, d) => { let e = flows.find(x => x.born && x.i === ti && x.d === d); if (!e) { e = { i: ti, d, full: 0, bug: 0, born: true }; flows.push(e); } return e; };
    let spawnSum = 0, bugSum = 0; // сколько задач на задачу PM заводят этапы со spawn и находят QA — по происхождению, а не по типу
    for (let it = 0; it < 60; it++) {
      spawnSum = 0; bugSum = 0;
      const next = new Map(), add = (ti, d, v) => { const k = ti + '|' + d; next.set(k, { ti, d, v: ((next.get(k) || {}).v || 0) + v }); };
      flows.forEach(e => {
        const t = cfg.types[e.i], amt = e.full + e.bug;
        if (t.bugChance && tested(t)) { const v = amt * t.bugChance / 100; add(bi, e.d != null ? e.d : cfg.types[bi].domain, v); bugSum += v; }
        spawnAt.forEach(sp => { const ti = sp.ti == null ? e.i : sp.ti, v = amt * pass(sp.si) * sp.p; if (t.hours[cfg.stages[sp.si].id] > 0) { add(ti, e.d != null ? e.d : cfg.types[ti].domain, v); spawnSum += v; } });
      });
      flows.forEach(e => { if (e.born) e.bug = 0; });
      next.forEach(({ ti, d, v }) => { bornFlow(ti, d).bug = v; });
    }
    const flow = 1 + flows.reduce((a, e) => a + e.bug, 0);

    // SP — только стори от PM: баги и техдолг нагружают людей, но в скорость не входят.
    const spPerPm = flows.reduce((a, e) => a + e.full * cfg.types[e.i].sp, 0);
    const cap = m => (m.kind === 'agent' ? m.speed * cfg.agentHours * cfg.agentDays : (m.assist ? cfg.assistSpeed : 1) * cfg.humanHours * cfg.humanDays) * weeks;
    const roles = cfg.roles.map(r => {
      const team = cfg.team.filter(m => m.role === r.id && m.active !== false);
      // Нагрузка на задачу PM: задачи PM проходят все этапы (кроме ушедших мимо развилки), баги — с бэклога.
      const loadOf = keep => cfg.stages.reduce((a, s, si) => (s.role !== r.id ? a
        : a + pass(si) * flows.reduce((b, e) => { const t = cfg.types[e.i]; return b + (keep(t, e.d) ? (e.full + (si >= entry ? e.bug : 0)) * t.hours[s.id] : 0); }, 0)), 0);
      const limit = (members, keep, by) => { const l = loadOf(keep); return { v: l > 0 ? members.reduce((a, m) => a + cap(m), 0) / l : Infinity, by }; };
      // Что ограничивает роль: вся роль (by: null), только люди или участники одного домена.
      const lims = [limit(team, () => true, null), limit(team.filter(m => m.kind === 'human'), t => !t.agents, 'люди')];
      cfg.domains.forEach(k => lims.push(limit(team.filter(m => !m.domains || m.domains.includes(k)), (t, d) => d === k, k)));
      const lim = lims.reduce((a, b) => (b.v < a.v - 1e-9 ? b : a));
      return { id: r.id, name: r.name, capacity: team.reduce((a, m) => a + cap(m), 0), load: loadOf(() => true), tasksPerSprint: lim.v, limitBy: lim.v < Infinity ? lim.by : null };
    });
    const busy = roles.filter(r => r.load > 0);
    const bottleneck = busy.reduce((b, r) => (!b || r.tasksPerSprint < b.tasksPerSprint ? r : b), null);
    const pmPerSprint = bottleneck ? bottleneck.tasksPerSprint : 0;
    // Загрузка роли при работе системы на пределе: 1 — узкое место, меньше — запас.
    roles.forEach(r => { r.util = r.load > 0 && Number.isFinite(r.tasksPerSprint) && r.tasksPerSprint > 0 ? pmPerSprint / r.tasksPerSprint : 0; });
    // Стоимость спринта: люди — за всё рабочее время, простой — незанятая доля; агенты — только часы работы.
    const util = id => (roles.find(r => r.id === id) || {}).util || 0;
    const team = cfg.team.filter(m => m.active !== false);
    const hoursOf = m => (m.kind === 'agent' ? cfg.agentHours * cfg.agentDays : cfg.humanHours * cfg.humanDays) * weeks;
    const rate = m => rateOf(cfg, m);
    const humans = team.filter(m => m.kind === 'human').reduce((a, m) => a + rate(m) * hoursOf(m), 0);
    const idle = team.filter(m => m.kind === 'human').reduce((a, m) => a + rate(m) * hoursOf(m) * (1 - Math.min(1, util(m.role))), 0);
    const agents = team.filter(m => m.kind === 'agent').reduce((a, m) => a + rate(m) * hoursOf(m) * Math.min(1, util(m.role)), 0);
    const spPerSprint = pmPerSprint * spPerPm;
    return {
      roles, bottleneck: bottleneck && bottleneck.id,
      tasksPerSprint: pmPerSprint * flow, tasksPerWeek: pmPerSprint * flow * WEEK_H / SPRINT_H, spPerTask: spPerPm, spPerSprint,
      storiesPerSprint: pmPerSprint, storiesPerWeek: pmPerSprint * WEEK_H / SPRINT_H,
      bugsPerSprint: pmPerSprint * bugSum, spawnedPerSprint: pmPerSprint * spawnSum,
      cost: { humans, agents, idle, total: humans + agents, perSP: spPerSprint > 0 ? (humans + agents) / spPerSprint : Infinity },
    };
  }

  // Настройки из JSON-текста (пресет, файл, ручная правка): проверка формы и приведение к допустимым значениям.
  function fromJSON(text) {
    let c;
    try { c = JSON.parse(text); } catch (e) { throw new Error('это не JSON: ' + e.message); }
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('нужен объект с настройками');
    if (!Array.isArray(c.roles) || !c.roles.length) throw new Error('нужен непустой список ролей roles');
    if (!Array.isArray(c.stages) || !c.stages.length) throw new Error('нужен непустой список этапов stages');
    const bad = c.stages.find(s => !s || s.id == null);
    if (bad) throw new Error('у каждого этапа нужен id');
    // Название и версия — первыми, чтобы файл было удобно читать.
    return Object.assign({ version: 2, name: String(c.name || 'Без названия') }, normalize(c), { version: 2, name: String(c.name || 'Без названия') });
  }

  const api = { EXAMPLE, PRESETS, SPEEDS, mixAt, avgWeights, isSpecialized, unspecialize, WEEK_H, shortages, throughput, BUG_ID, refRate, rateOf, fromJSON, SPRINT_H, normalize, create, reconfigure, step, forecast, performer, initials, taskById, hoursFor, isOn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DevFlow = api;
})(typeof window !== 'undefined' ? window : this);
