// Ядро симуляции: дискретно-событийная модель потока задач через этапы workflow.
// Работает и в браузере (window.DevFlowSim), и в node (module.exports).
(function (root) {
  'use strict';

  const HOURS_PER_WEEK = 168;
  const SNAP_HOURS = 4;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Треугольное распределение: мин, типичное, макс.
  function tri(rng, a, c, b) {
    if (b <= a) return a;
    const u = rng();
    const f = (c - a) / (b - a);
    return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
  }

  // Рабочий календарь: hoursPerDay часов в день, daysPerWeek дней в неделю.
  // Время модели — календарные часы от понедельника, начала рабочего дня.
  function makeSchedule(hoursPerDay, daysPerWeek) {
    const H = Math.min(24, Math.max(1, hoursPerDay));
    const D = Math.min(7, Math.max(1, daysPerWeek));
    function addWork(t, w) {
      let day = Math.floor(t / 24);
      let off = t - day * 24;
      for (;;) {
        if (day % 7 < D && off < H) {
          const avail = H - off;
          if (w <= avail + 1e-9) return day * 24 + off + w;
          w -= avail;
        }
        day++; off = 0;
      }
    }
    function workBetween(t0, t1) {
      if (t1 <= t0) return 0;
      let sum = 0;
      for (let d = Math.floor(t0 / 24), end = Math.floor(t1 / 24); d <= end; d++) {
        if (d % 7 >= D) continue;
        const a = Math.max(t0, d * 24), b = Math.min(t1, d * 24 + H);
        if (b > a) sum += b - a;
      }
      return sum;
    }
    return { addWork, workBetween, H, D };
  }

  function normalize(cfg) {
    const c = JSON.parse(JSON.stringify(cfg));
    c.hoursPerDay = Math.min(24, Math.max(1, +c.hoursPerDay || 8));
    c.daysPerWeek = Math.min(7, Math.max(1, Math.round(+c.daysPerWeek || 5)));
    c.horizonWeeks = Math.min(104, Math.max(1, +c.horizonWeeks || 26));
    c.warmupWeeks = Math.max(0, +c.warmupWeeks || 0);
    c.seed = (Math.round(+c.seed) || 1) >>> 0;
    c.reworkFactor = Math.max(0, +c.reworkFactor || 0);
    c.pools.forEach(p => { p.count = Math.max(0, Math.round(+p.count || 0)); });
    c.stages.forEach(s => {
      const v = [+s.min || 0, +s.mode || 0, +s.max || 0].map(x => Math.max(0, x)).sort((x, y) => x - y);
      s.min = v[0]; s.mode = v[1]; s.max = v[2];
      if (s.agent) {
        s.agent.speed = Math.max(0.01, +s.agent.speed || 1);
        s.agent.count = Math.max(1, Math.round(+s.agent.count || 1));
        s.agent.oversight = Math.max(0, +s.agent.oversight || 0);
      }
    });
    return c;
  }

  // Сценарий A — только люди. Сценарий B — включены агенты, поток умножен на multB.
  function scenarioOf(cfg, which) {
    const withAgents = which === 'B';
    const mult = withAgents ? (+cfg.arrival.multB || 1) : 1;
    return {
      stages: cfg.stages.map(s => Object.assign({}, s, { agentOn: !!(withAgents && s.agent && s.agent.on) })),
      perWeek: Math.max(0, +cfg.arrival.perWeek || 0) * mult,
      backlog: Math.max(0, Math.round(+cfg.arrival.backlog || 0)),
      mode: cfg.arrival.mode === 'backlog' ? 'backlog' : 'flow',
    };
  }

  function reworkTarget(sc, s, idx) {
    const r = sc.stages[s].rework;
    if (!r || !(r.to in idx)) return -1;
    const ti = idx[r.to];
    return ti < s ? ti : -1;
  }

  function reworkProb(sc, s, ti) {
    const r = sc.stages[s].rework;
    const p = sc.stages[ti].agentOn && r.pAgent != null ? +r.pAgent : +r.p;
    return Math.min(0.99, Math.max(0, (p || 0) / 100));
  }

  // Аналитика: ожидаемое число визитов на этап, нагрузка на роли и предельная пропускная способность.
  function analyze(rawCfg, which) {
    const cfg = normalize(rawCfg);
    const sc = scenarioOf(cfg, which);
    const n = sc.stages.length;
    const idx = Object.fromEntries(sc.stages.map((s, i) => [s.id, i]));
    let v = new Array(n).fill(0);
    for (let it = 0; it < 2000; it++) {
      const nv = new Array(n).fill(0);
      nv[0] = 1;
      for (let s = 0; s < n; s++) {
        const ti = reworkTarget(sc, s, idx);
        const p = ti >= 0 ? reworkProb(sc, s, ti) : 0;
        if (ti >= 0) nv[ti] += v[s] * p;
        if (s + 1 < n) nv[s + 1] += v[s] * (1 - p);
      }
      v = nv;
    }
    const rf = cfg.reworkFactor / 100;
    const weekWork = cfg.hoursPerDay * cfg.daysPerWeek;
    const pools = {};
    cfg.pools.forEach(p => {
      pools['p:' + p.id] = { key: 'p:' + p.id, label: p.name, agent: false, count: p.count, cap: p.count * weekWork, load: 0 };
    });
    sc.stages.forEach((st, s) => {
      const mean = (st.min + st.mode + st.max) / 3;
      const effort = mean * (1 + Math.max(0, v[s] - 1) * rf);
      if (st.agentOn) {
        const key = 'a:' + st.id;
        pools[key] = {
          key, label: 'Агенты · ' + st.name, agent: true, count: st.agent.count,
          cap: st.agent.count * (cfg.agents247 ? HOURS_PER_WEEK : weekWork), load: effort / st.agent.speed,
        };
        const op = pools['p:' + st.agent.oversightPool];
        if (op) op.load += v[s] * st.agent.oversight;
      } else {
        const p = pools['p:' + st.pool];
        if (p) p.load += effort;
      }
    });
    const list = Object.values(pools).filter(p => p.load > 0 || !p.agent);
    let maxTp = Infinity, bottleneck = null;
    list.forEach(p => {
      p.maxTp = p.load > 0 ? (p.cap > 0 ? p.cap / p.load : 0) : Infinity;
      p.rho = sc.mode === 'flow' ? (p.load > 0 ? (p.cap > 0 ? sc.perWeek * p.load / p.cap : Infinity) : 0) : null;
      if (p.maxTp < maxTp) { maxTp = p.maxTp; bottleneck = p.key; }
    });
    const bottleneckStages = sc.stages.map((st, i) => {
      if (!bottleneck) return false;
      if (st.agentOn) return bottleneck === 'a:' + st.id || bottleneck === 'p:' + st.agent.oversightPool;
      return bottleneck === 'p:' + st.pool;
    });
    return { visits: v, pools: list, maxTp, bottleneck, bottleneckStages, perWeek: sc.perWeek, mode: sc.mode };
  }

  function Heap() { this.a = []; }
  Heap.prototype.less = function (x, y) { return x.t < y.t || (x.t === y.t && x.seq < y.seq); };
  Heap.prototype.push = function (x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]]; i = p;
    }
  };
  Heap.prototype.pop = function () {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  };

  function percentile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function simulate(rawCfg, which) {
    const cfg = normalize(rawCfg);
    const sc = scenarioOf(cfg, which);
    const sched = makeSchedule(cfg.hoursPerDay, cfg.daysPerWeek);
    const n = sc.stages.length;
    const T = cfg.horizonWeeks * HOURS_PER_WEEK;
    const W0 = sc.mode === 'backlog' ? 0 : Math.min(cfg.warmupWeeks * HOURS_PER_WEEK, T / 2);
    const idx = Object.fromEntries(sc.stages.map((s, i) => [s.id, i]));

    const res = {};
    cfg.pools.forEach(p => {
      res['p:' + p.id] = { key: 'p:' + p.id, label: p.name, agent: false, count: p.count, busy: 0, queue: [], work: 0 };
    });
    sc.stages.forEach(s => {
      if (s.agentOn) res['a:' + s.id] = { key: 'a:' + s.id, label: 'Агенты · ' + s.name, agent: true, count: s.agent.count, busy: 0, queue: [], work: 0 };
    });
    const finishAt = (r, t, w) => (r.agent && cfg.agents247 ? t + w : sched.addWork(t, w));

    const heap = new Heap();
    let seq = 0;
    const push = (t, type, data) => heap.push({ t, seq: seq++, type, data });

    const waiting = new Array(n).fill(0), working = new Array(n).fill(0);
    const qArea = new Array(n).fill(0), kArea = new Array(n).fill(0);
    const waitSum = new Array(n).fill(0), waitN = new Array(n).fill(0);
    const touchSum = new Array(n).fill(0), touchN = new Array(n).fill(0);
    const visitSum = new Array(n).fill(0);
    let wipArea = 0, inSystem = 0, arrived = 0, doneCount = 0, lastT = 0, reworks = 0;
    const leads = [], leadsWork = [];
    let effortDone = 0, leadWorkDone = 0, doneInWin = 0, drainT = null, wipAtW0 = null;
    const frames = [];

    function tick(t) {
      const a = Math.max(lastT, W0), b = Math.min(t, T);
      if (b > a) {
        const dt = b - a;
        for (let s = 0; s < n; s++) { qArea[s] += waiting[s] * dt; kArea[s] += working[s] * dt; }
        wipArea += inSystem * dt;
      }
      lastT = Math.max(lastT, t);
    }

    function pickNext(r) {
      const q = r.queue;
      let best = 0;
      for (let i = 1; i < q.length; i++) {
        if (q[i].prio > q[best].prio || (q[i].prio === q[best].prio && q[i].seq < q[best].seq)) best = i;
      }
      return q.splice(best, 1)[0];
    }

    function start(r, job, t) {
      tick(t);
      waiting[job.s]--; working[job.s]++; r.busy++;
      if (t >= W0) { waitSum[job.s] += t - job.qt; waitN[job.s]++; }
      const fin = finishAt(r, t, job.w);
      if (t >= W0 && t < T) r.work += fin > T ? job.w * (T - t) / (fin - t) : job.w;
      job.task.effort += job.w;
      if (job.phase === 'work') { touchSum[job.s] += job.w; touchN[job.s]++; }
      push(fin, 'fin', { r, job });
    }

    function request(r, job, t) {
      tick(t);
      waiting[job.s]++;
      job.qt = t; job.seq = seq++;
      job.prio = cfg.downstreamFirst ? job.s : 0;
      if (r && r.busy < r.count) start(r, job, t);
      else if (r) r.queue.push(job);
    }

    function enterStage(task, s, t) {
      task.visits[s]++;
      const st = sc.stages[s];
      let w = tri(task.rng, st.min, st.mode, st.max);
      if (task.visits[s] > 1) w *= cfg.reworkFactor / 100;
      let r;
      if (st.agentOn) { w /= st.agent.speed; r = res['a:' + st.id]; } else r = res['p:' + st.pool];
      request(r, { task, s, phase: 'work', w }, t);
    }

    function completeStage(task, s, t) {
      const ti = reworkTarget(sc, s, idx);
      if (ti >= 0) {
        const u = task.rng();
        if (u < reworkProb(sc, s, ti)) { task.reworks++; enterStage(task, ti, t); return; }
      }
      if (s + 1 < n) enterStage(task, s + 1, t);
      else finishTask(task, t);
    }

    function finishTask(task, t) {
      tick(t);
      inSystem--; doneCount++;
      if (t >= W0 && t <= T) {
        doneInWin++;
        leads.push(t - task.arrive);
        const lw = sched.workBetween(task.arrive, t);
        leadsWork.push(lw);
        effortDone += task.effort; leadWorkDone += lw;
        reworks += task.reworks;
        for (let s = 0; s < n; s++) visitSum[s] += task.visits[s];
      }
      if (sc.mode === 'backlog' && doneCount === sc.backlog) drainT = t;
    }

    function onFinish(r, job, t) {
      tick(t);
      working[job.s]--; r.busy--;
      if (r.queue.length) start(r, pickNext(r), t);
      const st = sc.stages[job.s];
      if (job.phase === 'work' && st.agentOn && st.agent.oversight > 0) {
        const w = st.agent.oversight * tri(job.task.rng, 0.5, 1, 1.5);
        request(res['p:' + st.agent.oversightPool], { task: job.task, s: job.s, phase: 'check', w }, t);
        return;
      }
      completeStage(job.task, job.s, t);
    }

    function newTask(t) {
      const id = arrived++;
      const rng = mulberry32((Math.imul(cfg.seed, 0x9e3779b1) ^ Math.imul(id + 1, 0x85ebca77)) >>> 0);
      tick(t);
      inSystem++;
      const task = { id, arrive: t, rng, visits: new Array(n).fill(0), effort: 0, reworks: 0 };
      if (n) enterStage(task, 0, t);
    }

    const arrRng = mulberry32(cfg.seed);
    let ta = 0;
    function scheduleArrival() {
      if (sc.perWeek <= 0) return;
      ta += -Math.log(1 - arrRng()) * HOURS_PER_WEEK / sc.perWeek;
      if (ta <= T) push(ta, 'arr', null);
    }
    if (sc.mode === 'backlog') for (let i = 0; i < sc.backlog; i++) push(0, 'arr', null);
    else scheduleArrival();

    function snap(t) {
      if (wipAtW0 === null && t >= W0) wipAtW0 = inSystem;
      frames.push({ t, w: waiting.slice(), k: working.slice(), done: doneCount, arr: arrived });
    }

    let nextSnap = 0, events = 0;
    while (heap.a.length && events < 3e6) {
      const e = heap.a[0];
      if (e.t > T) break;
      while (nextSnap <= e.t) { snap(nextSnap); nextSnap += SNAP_HOURS; }
      heap.pop(); events++;
      if (e.type === 'arr') { newTask(e.t); if (sc.mode === 'flow') scheduleArrival(); }
      else onFinish(e.data.r, e.data.job, e.t);
    }
    while (nextSnap <= T) { snap(nextSnap); nextSnap += SNAP_HOURS; }
    tick(T);

    const win = T - W0;
    const winWork = sched.workBetween(W0, T);
    const sortedLeads = leads.slice().sort((a, b) => a - b);
    const pools = Object.values(res).filter(r => !r.agent || r.work > 0 || sc.stages.some(s => s.agentOn && 'a:' + s.id === r.key)).map(r => {
      const cap = r.count * (r.agent && cfg.agents247 ? win : winWork);
      return { key: r.key, label: r.label, agent: r.agent, count: r.count, util: cap > 0 ? r.work / cap : (r.work > 0 ? Infinity : 0), queueEnd: r.queue.length };
    });

    return {
      which, mode: sc.mode, perWeek: sc.perWeek, backlog: sc.backlog, T, W0,
      frames,
      stages: sc.stages.map((s, i) => ({
        id: s.id, name: s.name, agentOn: s.agentOn,
        avgQueue: win > 0 ? qArea[i] / win : 0,
        avgWorking: win > 0 ? kArea[i] / win : 0,
        avgWait: waitN[i] ? waitSum[i] / waitN[i] : 0,
        avgTouch: touchN[i] ? touchSum[i] / touchN[i] : 0,
        visits: doneInWin ? visitSum[i] / doneInWin : 0,
        queueEnd: waiting[i],
      })),
      pools,
      arrived, doneCount, doneInWin,
      throughput: win > 0 ? doneInWin / (win / HOURS_PER_WEEK) : 0,
      leadMean: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : NaN,
      leadP50: percentile(sortedLeads, 0.5),
      leadP85: percentile(sortedLeads, 0.85),
      wipAvg: win > 0 ? wipArea / win : 0,
      wipStart: wipAtW0 || 0,
      wipEnd: inSystem,
      flowEff: leadWorkDone > 0 ? Math.min(1, effortDone / leadWorkDone) : NaN,
      reworksPerTask: doneInWin ? reworks / doneInWin : 0,
      drainT,
    };
  }

  const api = { simulate, analyze, normalize, makeSchedule, tri, mulberry32, HOURS_PER_WEEK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DevFlowSim = api;
})(typeof window !== 'undefined' ? window : this);
