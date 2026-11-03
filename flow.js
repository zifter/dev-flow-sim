// Движок визуализации: задачи идут по этапам, участники команды берут их по ролям. Без случайности и статистики.
// Работает и в браузере (window.DevFlow), и в node (module.exports).
(function (root) {
  'use strict';

  const MAX_TASKS = 200; // предохранитель, если очередь за первым этапом без лимита
  const EPS = 1e-9;
  const SPRINT_DAYS = 14; // спринт — две календарные недели с понедельника
  const SPRINT_H = SPRINT_DAYS * 24;

  const EXAMPLE = {
    version: 2,
    name: 'Пример: продуктовая команда',
    humanHours: 8,  // люди работают 8 ч в сутки
    agentHours: 24, // агенты — круглосуточно
    humanDays: 5,   // люди работают 5 дней в неделю, суббота и воскресенье — выходные
    agentDays: 7,   // агенты — без выходных
    currency: '$',  // ставки условные
    agentRate: 3,   // ставка часа работы агента по умолчанию
    speed: 4,       // скорость анимации, часов модели в секунду
    // Домены — области работы. Задачу с доменом берут только участники с этим доменом.
    domains: ['Client', 'Backend'],
    roles: [
      // rate — ставка роли в час, участники берут её по умолчанию; creates — какие типы задач роль заводит.
      { id: 'pm', name: 'Product Manager', rate: 45, creates: 'all' },
      { id: 'dev', name: 'Разработчик', rate: 50 },
      { id: 'qa', name: 'QA', rate: 35, creates: ['bug'] }, // QA заводят только баги
    ],
    // Команда: каждый участник — человек или агент со своей ролью. Агент быстрее в speed раз.
    // domains — домены участника; не указаны — все. rate — ставка в час.
    team: [
      { id: 'pm1', name: 'Product Manager', role: 'pm', kind: 'human' },
      { id: 'cl1', name: 'Client 1', role: 'dev', kind: 'human' },
      { id: 'cl2', name: 'Client 2', role: 'dev', kind: 'human' },
      { id: 'be1', name: 'Backend 1', role: 'dev', kind: 'human' },
      { id: 'fs1', name: 'Fullstack', role: 'dev', kind: 'human', rate: 55 }, // своя ставка выше ставки роли
      { id: 'qa1', name: 'QA 1', role: 'qa', kind: 'human' },
      { id: 'qa2', name: 'QA 2', role: 'qa', kind: 'human' },
    ],
    stages: [
      { id: 'spec', name: 'Постановка', role: 'pm' },
      { id: 'backlog', name: 'Бэклог', role: null, limit: 25 }, // WIP-лимит: PM пишет задачи, пока в бэклоге меньше 25
      { id: 'dev', name: 'Разработка', role: 'dev' },
      { id: 'review', name: 'Код-ревью', role: 'dev' },
      { id: 'qa', name: 'Тестирование', role: 'qa', bugs: true }, // QA находят баги, они уходят в бэклог
    ],
    // Типы задач: доля в потоке, оценка в Story Points, домен и часы человека на каждом этапе.
    // Задачу и её ревью берут только участники её домена. 0 часов — этап пропускается.
    // bugChance — у какой доли задач на тестировании находят баг.
    types: [
      { id: 'cl-s', name: 'Client S', color: '#5aa9e6', weight: 3, sp: 2, domain: 'Client', hours: { spec: 1, dev: 4.5, review: 0.5, qa: 1 }, bugChance: 20 },
      { id: 'cl-m', name: 'Client M', color: '#2f80d1', weight: 2, sp: 3, domain: 'Client', hours: { spec: 2, dev: 9, review: 1, qa: 2 }, bugChance: 30 },
      { id: 'cl-l', name: 'Client L', color: '#1d4f91', weight: 1, sp: 5, domain: 'Client', hours: { spec: 3, dev: 18, review: 1.5, qa: 4 }, bugChance: 40 },
      { id: 'be-s', name: 'Backend S', color: '#c77dd8', weight: 3, sp: 2, domain: 'Backend', hours: { spec: 1, dev: 3, review: 0.5, qa: 1 }, bugChance: 15 },
      { id: 'be-m', name: 'Backend M', color: '#9b4fc0', weight: 3, sp: 3, domain: 'Backend', hours: { spec: 2, dev: 7.5, review: 1, qa: 2 }, bugChance: 25 },
      { id: 'be-l', name: 'Backend L', color: '#6a2c91', weight: 1, sp: 5, domain: 'Backend', hours: { spec: 3, dev: 15, review: 1.5, qa: 3 }, bugChance: 35 },
      // Bug — обязательный тип: все найденные баги этого типа, домен баг берёт у задачи, в которой его нашли.
      // Доля 0 — PM баги не ставит, их находят QA.
      { id: 'bug', name: 'Bug', color: '#d64545', weight: 0, sp: 1, hours: { spec: 0.5, dev: 3, review: 0.5, qa: 1 }, bugChance: 10 },
    ],
  };

  const SPEEDS = [1, 2, 4, 8, 24, 168];
  const BUG_ID = 'bug', BUG_COLOR = '#d64545';
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
    c.agentRate = Math.max(0, num(c.agentRate, 3));
    c.speed = SPEEDS.includes(+c.speed) ? +c.speed : 4;
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
    // Ускорение есть только у агента. Домены участника — выбранные из общего списка; поле не указано — все домены,
    // включая добавленные потом.
    c.team = c.roles.length ? team.slice(0, 40).map(m => {
      const own = Array.isArray(m.domains) ? m.domains : Array.isArray(m.skills) ? m.skills : null;
      // active: false — участник отключён: остаётся в настройках, но не работает и не входит в расчёт.
      return Object.assign({
        id: String(m.id), name: String(m.name || m.id),
        role: ids.has(m.role) ? m.role : c.roles[0].id,
        kind: m.kind === 'agent' ? 'agent' : 'human',
      }, own ? { domains: list(own).filter(k => domains.has(k)) } : {}, m.kind === 'agent' ? { speed: Math.max(0.1, +m.speed || 5) } : {},
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
        // Источник не может быть мгновенным, иначе задачи появятся все разом.
        hours[st.id] = Math.max(i === 0 ? 0.1 : 0, Number.isFinite(h) ? h : 1);
      });
      // agents: false — задачи этого типа агенты не берут ни на одном этапе.
      // domain — домен задачи (Client, Backend…); берут её только участники с этим доменом. null — любой.
      const d = t.domain != null ? t.domain : t.skill;
      const domain = d != null && domains.has(String(d)) ? String(d) : null;
      // bugChance — какая доля задач этого типа приносит баг на этапе с bugs (баг — всегда тип Bug).
      // color — цвет карточки задачи на схеме (#rrggbb), без него интерфейс берёт цвет из палитры по порядку.
      return { id: String(t.id), name: String(t.name || t.id), color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? String(t.color).toLowerCase() : null,
        weight: Math.max(0, +t.weight || 0), sp: Math.max(0, num(t.sp, 1)), domain, hours, agents: t.agents !== false,
        bugChance: Math.min(95, Math.max(0, num(t.bugChance, 0))) };
    });
    // Bug — обязательный тип: есть всегда, найденные баги — этого типа. Нет в настройках — добавляется
    // с долей 0 (PM его не ставит), 0,5 ч на первом этапе и 1 ч на остальных.
    let bug = types.find(t => t.id === BUG_ID);
    if (!bug) {
      const hours = {};
      c.stages.forEach((st, i) => { if (st.role) hours[st.id] = i === 0 ? 0.5 : 1; });
      bug = { id: BUG_ID, name: 'Bug', color: null, weight: 0, sp: 1, domain: null, hours, agents: true, bugChance: 0 };
      types.push(bug);
    }
    bug.bug = true;
    if (!bug.color) bug.color = BUG_COLOR;
    const typeIds = new Set(types.map(t => t.id));
    if (!types.some(t => t.weight > 0)) types.forEach(t => { t.weight = 1; });
    c.types = types;
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
      id: m.id, role: m.role, agent: m.kind === 'agent', speed: m.kind === 'agent' ? m.speed : 1,
      label: m.kind === 'agent' ? 'ИИ' + (agents > 1 ? ++a : '') : initials(m.name),
      name: m.name, domains: m.domains || cfg.domains.slice(), rate: rateOf(cfg, m), task: null, idle: '', done: 0,
      onH: 0, busyH: 0, // часы рабочего времени и из них занятые — для фактической загрузки
    }));
    // Баги попадают в первую очередь после источника (бэклог), а если очереди нет — на второй этап.
    const q = cfg.stages.findIndex((s, i) => i > 0 && !s.role);
    const bugEntry = q > 0 ? q : Math.min(1, cfg.stages.length - 1);
    return {
      cfg, t: 0, nextId: 1, seq: 0, people, tasks: [], doneCount: 0, done: [], mix: cfg.types.map(() => 0), spDone: 0, sprints: [],
      bugEntry, bugAcc: cfg.types.map(() => 0), bugsFound: 0, changes: [],
      cost: { humans: 0, agents: 0, idle: 0 }, sprintCost: [],
    };
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
    const S = st.cfg.stages, T = st.cfg.types;
    const typeIdx = i => (old.cfg.types[i] ? T.findIndex(t => t.id === old.cfg.types[i].id) : -1);
    Object.assign(st, {
      t: old.t, nextId: old.nextId, seq: old.seq, doneCount: old.doneCount, spDone: old.spDone,
      sprints: old.sprints.slice(), sprintCost: old.sprintCost.slice(), cost: Object.assign({}, old.cost),
      bugsFound: old.bugsFound, changes: (old.changes || []).concat([old.t]),
      done: old.done.map(d => ({ id: d.id, type: typeIdx(d.type) })).filter(d => d.type >= 0),
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
  function nextType(st, p) {
    const T = st.cfg.types, ok = T.map((t, i) => canDo(st, p, i) && t.weight > 0 && creates(st.cfg, p.role, i));
    const total = T.reduce((x, t, i) => x + (ok[i] ? t.weight : 0), 0);
    let best = -1;
    T.forEach((t, i) => { if (!ok[i]) return; st.mix[i] += t.weight; if (best < 0 || st.mix[i] > st.mix[best]) best = i; });
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
      st.done.push({ id: t.id, type: t.type });
      // Story Points засчитываются в спринт, в котором задача дошла до «Готово».
      const sp = st.cfg.types[t.type].sp, k = Math.floor((st.t + EPS) / SPRINT_H);
      while (st.sprints.length <= k) st.sprints.push(0);
      st.sprints[k] += sp; st.spDone += sp;
      if (st.done.length > 12) st.done.shift();
      ev.push({ type: 'done', task: t.id, from, at: st.t });
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
  // Следующий этап задачи не берёт тот, кто делал предыдущий, если в роли есть кто-то ещё, кто может её взять.
  function pick(st, p) {
    const S = st.cfg.stages;
    let best = null, bestTo = -1;
    st.tasks.forEach(t => {
      if (t.state !== 'wait') return;
      const to = S[t.stage].role ? t.stage : t.stage + 1;
      if (to >= S.length || performer(S[to]) !== p.role || !canDo(st, p, t.type, t.domain)) return;
      if (hoursFor(st, t, to) === 0) return; // этап этой задаче не нужен — её проведёт дальше assign, без исполнителя
      if (t.last === p.id && ableCount(st, p.role, t) > 1) return;
      if (to > bestTo || (to === bestTo && t.seq < best.seq)) { best = t; bestTo = to; }
    });
    return best ? { t: best, to: bestTo } : null;
  }

  // Может ли участник начать новую задачу на первом этапе: очередь за ним не должна быть полна.
  function canCreate(st, p) {
    const S = st.cfg.stages;
    if (!S.length || performer(S[0]) !== p.role) return false;
    if (st.tasks.length >= MAX_TASKS) { p.idle = 'задач слишком много'; return false; }
    if (!st.cfg.types.some((t, i) => t.weight > 0 && creates(st.cfg, p.role, i))) { p.idle = 'роль не заводит задачи'; return false; }
    if (!st.cfg.types.some((t, i) => t.weight > 0 && creates(st.cfg, p.role, i) && canDo(st, p, i))) { p.idle = 'нет типов задач для агентов'; return false; }
    const next = S[1];
    if (next && !next.role && next.limit > 0) {
      const n = st.tasks.filter(t => t.stage <= 1).length;
      if (n >= next.limit) { p.idle = `${next.name.toLowerCase()}: полно`; return false; }
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
    const own = waiting.filter(t => !human.includes(t) && !domain.includes(t) && t.last === p.id);
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
  function findBugs(st, t, p, ev) {
    const tp = st.cfg.types[t.type];
    if (!st.cfg.stages[t.stage].bugs || !tp.bugChance) return;
    const bt = st.cfg.types.findIndex(x => x.bug);
    if (!creates(st.cfg, p.role, bt)) return; // роль не заводит такие баги
    st.bugAcc[t.type] += tp.bugChance / 100;
    while (st.bugAcc[t.type] >= 1 - EPS) {
      st.bugAcc[t.type] -= 1;
      if (st.tasks.length >= MAX_TASKS) continue;
      const domain = domOf(st, t) || st.cfg.types[bt].domain || null; // баг клиентской задачи — клиентский
      const b = { id: st.nextId++, type: bt, domain, stage: st.bugEntry, state: 'wait', seq: st.seq++, person: null, last: null, left: 0, total: 0, bug: true };
      st.tasks.push(b);
      st.bugsFound++;
      ev.push({ type: 'new', task: b.id, kind: bt, domain, to: st.bugEntry, from: t.stage, bug: true, of: t.id, by: p.id, at: st.t });
    }
  }

  function finish(st, t, ev) {
    const p = st.people.find(x => x.id === t.person);
    p.task = null; p.done++;
    t.last = p.id; t.person = null;
    findBugs(st, t, p, ev);
    move(st, t, t.stage + 1, ev);
  }

  // Продвинуть время на dt часов. Работа идёт только в рабочее время исполнителя;
  // в нерабочее задача остаётся за ним и ждёт утра. Возвращает события: new, start, move, done.
  function step(st, dt) {
    const ev = [];
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
      st.t += seg; rem -= seg;
      busy.filter(t => t.left <= EPS).forEach(t => finish(st, t, ev));
      assign(st, ev);
    }
    return ev;
  }

  // Расчётная скорость: сколько SP за спринт выдержит команда, если работа не простаивает.
  // Ёмкость роли — часы людей и агентов за спринт (агентский час стоит speed человеческих),
  // нагрузка — средние часы роли на задачу по долям типов. Предел — самая загруженная роль.
  // Задачи «только для людей» и задачи каждого направления отдельно проверяются по ёмкости тех, кто может их делать.
  function forecast(rawCfg) {
    const cfg = normalize(rawCfg);
    const weeks = SPRINT_DAYS / 7;
    // Доли — среди типов, которые заводит роль первого этапа.
    const src = cfg.stages[0] ? cfg.stages[0].role : null;
    const made = cfg.types.map((t, i) => creates(cfg, src, i) && t.weight > 0);
    const total = cfg.types.reduce((a, t, i) => a + (made[i] ? t.weight : 0), 0);
    const share = cfg.types.map((t, i) => (made[i] && total > 0 ? t.weight / total : 0));
    // Баги: сколько задач каждого типа появляется от багов на одну задачу PM (с багами от багов).
    const bugStages = cfg.stages.map((s, i) => (s.bugs ? i : -1)).filter(i => i >= 0);
    const q = cfg.stages.findIndex((s, i) => i > 0 && !s.role), entry = q > 0 ? q : Math.min(1, cfg.stages.length - 1);
    const bi = cfg.types.findIndex(t => t.bug);
    const tested = t => bugStages.some(i => t.hours[cfg.stages[i].id] > 0 && creates(cfg, cfg.stages[i].role, bi));
    // Потоки задач на одну задачу PM: (тип, домен, от PM, от багов). Баг берёт домен задачи, в которой его нашли.
    const flows = cfg.types.map((t, i) => ({ i, d: t.domain, full: share[i], bug: 0 }));
    const bugFlow = d => { let e = flows.find(x => x.born && x.d === d); if (!e) { e = { i: bi, d, full: 0, bug: 0, born: true }; flows.push(e); } return e; };
    for (let it = 0; it < 60; it++) {
      const next = new Map();
      flows.forEach(e => {
        const t = cfg.types[e.i];
        if (!t.bugChance || !tested(t)) return;
        const d = e.d != null ? e.d : cfg.types[bi].domain;
        next.set(d, (next.get(d) || 0) + (e.full + e.bug) * t.bugChance / 100);
      });
      flows.forEach(e => { if (e.born) e.bug = 0; });
      next.forEach((v, d) => { bugFlow(d).bug = v; });
    }
    const flow = 1 + flows.reduce((a, e) => a + e.bug, 0);
    const spPerPm = flows.reduce((a, e) => a + (e.full + e.bug) * cfg.types[e.i].sp, 0);
    const cap = m => (m.kind === 'agent' ? m.speed * cfg.agentHours * cfg.agentDays : cfg.humanHours * cfg.humanDays) * weeks;
    const roles = cfg.roles.map(r => {
      const team = cfg.team.filter(m => m.role === r.id && m.active !== false);
      // Нагрузка на задачу PM: задачи PM проходят все этапы, баги — с бэклога.
      const loadOf = keep => cfg.stages.reduce((a, s, si) => (s.role !== r.id ? a
        : a + flows.reduce((b, e) => { const t = cfg.types[e.i]; return b + (keep(t, e.d) ? (e.full + (si >= entry ? e.bug : 0)) * t.hours[s.id] : 0); }, 0)), 0);
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
      tasksPerSprint: pmPerSprint * flow, spPerTask: flow ? spPerPm / flow : 0, spPerSprint,
      bugsPerSprint: pmPerSprint * (flow - 1),
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

  const api = { EXAMPLE, SPEEDS, BUG_ID, refRate, rateOf, fromJSON, SPRINT_H, normalize, create, reconfigure, step, forecast, performer, initials, taskById, hoursFor, isOn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DevFlow = api;
})(typeof window !== 'undefined' ? window : this);
