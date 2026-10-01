// ===== 状态管理 =====
const STORAGE_KEY = 'pokerScoreV2';
const SAVE_URL = '/save';
const LOAD_URL = '/load';

function loadState() {
  // 先从 localStorage 读取（本地快速）
  let localData = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) localData = JSON.parse(raw);
  } catch (e) {
    console.warn('Failed to load from localStorage', e);
  }
  return ensureAllTimeLog(localData || defaultState());
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  // 异步同步到服务器（不阻塞 UI）
  saveToServer();
}

function saveToServer() {
  try {
    fetch(SAVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    }).then(r => {
      if (r.status === 409) {
        // 其他设备已经写过 → 采用服务端最新版本，不覆盖别人
        return r.json().then(payload => {
          if (payload && payload.state) {
            state = payload.state;
            state.rev = payload.rev || 0;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            render();
          }
          setSyncStatus('已载入其他设备的最新数据', 'sync-warn');
          toast('其他设备已更新，本地已同步为最新');
        });
      }
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json().then(res => {
        if (res && res.rev) {
          state.rev = res.rev;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        }
        setSyncStatus('已同步 ' + ((res && res.server_time) ? res.server_time.slice(11) : ''), 'sync-ok');
      });
    }).catch(() => {
      setSyncStatus('离线 · 仅本机保存', 'sync-off');
    });
  } catch (_) {}
}

function setSyncStatus(text, cls) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'sync-status ' + (cls || '');
}

function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}

function loadFromServer() {
  fetch(LOAD_URL)
    .then(r => r.ok ? r.json() : null)
    .then(serverData => {
      if (serverData && serverData.players && serverData.players.length > 0) {
        // 服务端数据有效 → 覆盖本地
        state = serverData;
        state.rev = serverData.rev || 0;
        // 修复兼容性：给没有 deleted 字段的玩家补上
        state.players.forEach(p => { if (p.deleted === undefined) p.deleted = false; });
        state = ensureAllTimeLog(state);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        setSyncStatus('已同步 ' + (serverData.updatedAt ? serverData.updatedAt.replace('T', ' ').slice(11) : ''), 'sync-ok');
        render();
      } else if (serverData === null && state.players.length > 0) {
        // 服务端还是空的 → 把本地这份推上去
        saveToServer();
      }
    })
    .catch(() => {
      setSyncStatus('离线 · 仅本机保存', 'sync-off');
    });
}

function defaultState() {
  return {
    players: [],          // [{id, name, cumulativeScore, deleted: false}]
    dealerIndex: 0,       // current dealer index
    currentRound: 1,      // 1-5
    rounds: [],           // [{round, scores: {playerId: value}}]
    gameHistory: [],      // [{uid, dealerId, dealerName, roundRecords, roundScoreSummary, completedAt}] 仅本次 session
    currentRoundScore: {},// running scores for current round being input
    roster: [],           // 永久玩家档案库：[{id, name, createdAt}] 跨 session，改名/离场都不丢历史
    allTimeLog: [],       // 永久账本：一条 = 一局；跨 session 累积，不被"开始新的一局"清空
    allTimeSeeded: false, // 是否已从 gameHistory 迁移过（防重复计入）
    rev: 0                // 服务端版本号（冲突检测用）
  };
}

// ===== 永久账本 =====
// 设计：只存"事件"（每局一条），总积分/总胜率/排名全部由它现算 —— 不存冗余计数器，永远自洽。
function ensureAllTimeLog(s) {
  ensureRoster(s);
  if (!Array.isArray(s.allTimeLog)) s.allTimeLog = [];
  if (!s.allTimeSeeded) {
    // 首次迁移：把已有 session 历史并进永久账本（只做一次）
    (s.gameHistory || []).forEach((g, i) => {
      const uid = g.uid || ('mig' + i + '_' + (g.completedAt || 'x'));
      g.uid = uid;
      s.allTimeLog.push(logEntryFromGame(s, g, uid));
    });
    s.allTimeSeeded = true;
  }
  return s;
}

// 玩家档案库：id 是永久账号，永久榜按它关联。
// 迁移时把在场玩家 + 历史账本里出现过的所有人补进档案库，保证老数据不丢人。
function ensureRoster(s) {
  if (!Array.isArray(s.roster)) s.roster = [];
  const byId = id => s.roster.find(r => r.id === id);

  (s.players || []).forEach(p => {
    const r = byId(p.id);
    if (!r) s.roster.push({ id: p.id, name: p.name, createdAt: null });
    else if (!r.name) r.name = p.name;
  });

  (s.allTimeLog || []).forEach(e => {
    (e.summary || []).forEach(({ id, name }) => {
      if (!byId(id)) s.roster.push({ id: id, name: name, createdAt: null });
    });
  });

  return s;
}

function roundWinCounts(g) {
  const out = {};
  (g.roundRecords || []).forEach(r => {
    Object.entries(r.scores || {}).forEach(([pid, v]) => {
      if (v > 0) out[pid] = (out[pid] || 0) + 1;
    });
  });
  return out;
}

// 每人的逐盘胜负序列（1=赢该盘），用于按盘算胜率与连胜
function roundSeqFromGame(g) {
  const out = {};
  (g.roundRecords || []).forEach(r => {
    Object.entries(r.scores || {}).forEach(([pid, v]) => {
      (out[pid] = out[pid] || []).push(v > 0 ? 1 : 0);
    });
  });
  return out;
}

// 账本条目自带玩家名字快照 —— 就算以后玩家被删/被重置，永久榜也能独立算出来
function logEntryFromGame(s, g, uid) {
  const names = {};
  (s.players || []).forEach(p => { names[p.id] = p.name; });
  return {
    uid: uid,
    at: g.completedAt || null,
    dealer: g.dealerName || '',
    rounds: (g.roundRecords || []).length,
    summary: Object.entries(g.roundScoreSummary || {}).map(([id, score]) => ({
      id: id, name: names[id] || id, score: score
    })),
    roundWins: roundWinCounts(g),
    roundSeq: roundSeqFromGame(g)   // 逐盘胜负，胜率/连胜都按盘算
  };
}

// 由永久账本现算每个人的总积分/胜负/连胜/总胜率
function computeAllTimeStats() {
  const out = {};
  // 显示名以档案库为准（改过名，永久榜立刻跟着改）；账本里的快照只作兜底
  const rosterName = {};
  (state.roster || []).forEach(r => { rosterName[r.id] = r.name; });

  const touch = (id, name) => {
    if (!out[id]) out[id] = {
      id: id, name: name || id, games: 0, wins: 0, draws: 0, losses: 0,
      total: 0, bestStreak: 0, curStreak: 0,
      roundsTotal: 0, roundsWon: 0, roundBestStreak: 0, roundCurStreak: 0
    };
    if (rosterName[id]) out[id].name = rosterName[id];
    else if (name) out[id].name = name;
    return out[id];
  };

  (state.allTimeLog || []).forEach(e => {
    const entries = (e.summary || []);
    entries.forEach(({ id, name, score }) => {
      const s = touch(id, name);
      s.games++;
      s.total += score;
      if (score > 0) {
        s.wins++;
        s.curStreak++;
        if (s.curStreak > s.bestStreak) s.bestStreak = s.curStreak;
      } else {
        if (score < 0) s.losses++; else s.draws++;
        s.curStreak = 0;
      }
    });

    // 盘：胜率与连胜都以「盘」为单位（逐盘序列现算）
    const seq = e.roundSeq;
    if (seq) {
      Object.entries(seq).forEach(([id, arr]) => {
        const s = touch(id);
        arr.forEach(v => {
          s.roundsTotal++;
          if (v > 0) {
            s.roundsWon++;
            s.roundCurStreak++;
            if (s.roundCurStreak > s.roundBestStreak) s.roundBestStreak = s.roundCurStreak;
          } else {
            s.roundCurStreak = 0;
          }
        });
      });
    } else if (e.roundWins) {
      Object.entries(e.roundWins).forEach(([id, n]) => {
        const s = touch(id);
        s.roundsTotal += (e.rounds || 0);
        s.roundsWon += n;
      });
    }
  });

  return Object.values(out);
}

function getActivePlayers() {
  return state.players.filter(p => !p.deleted);
}

let state = loadState();
let editingRoundIndex = null; // null = new round, number = editing existing
let currentStep = 5; // 当前步长（可调）
const STEP_OPTIONS = [1, 2, 3, 5, 7, 15, 30]; // 可选步长
let roundsOpen = false; // 已录入盘数是否展开（默认收起，让记分页一屏放完）

// ===== DOM References =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const tabs = {
  score: $('#tab-score'),
  players: $('#tab-players'),
  summary: $('#tab-summary')
};

// ===== Tab Switching =====
$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    Object.keys(tabs).forEach(k => tabs[k].classList.remove('active'));
    tabs[tab].classList.add('active');
    render();
  });
});

// ===== Round Select =====
$('#round-select').addEventListener('change', (e) => {
  state.currentRound = parseInt(e.target.value);
  saveState();
  render();
});

const roundsToggleBtn = document.getElementById('btn-toggle-rounds');
if (roundsToggleBtn) {
  roundsToggleBtn.addEventListener('click', () => {
    roundsOpen = !roundsOpen;
    roundsToggleBtn.textContent = roundsOpen ? '收起' : '展开';
    renderRoundsList();
  });
}

// ===== Player Management =====
$('#btn-add-player').addEventListener('click', addPlayer);
$('#new-player-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addPlayer();
});

function addPlayer() {
  const input = $('#new-player-name');
  const name = input.value.trim();
  if (!name) return;
  const activePlayers = getActivePlayers();
  if (activePlayers.find(p => p.name === name)) {
    alert('该玩家已在场');
    return;
  }
  if (activePlayers.length >= 8) {
    alert('最多支持8位活跃玩家');
    return;
  }

  ensureRoster(state);
  // 同名 = 同一个档案账号：复用永久 id，他的历史战绩自然延续
  const profile = state.roster.find(r => r.name === name);

  if (profile) {
    joinProfile(profile.id, true);
  } else {
    const id = 'p' + Date.now();
    state.roster.push({ id: id, name: name, createdAt: new Date().toISOString() });
    state.players.push({ id: id, name: name, cumulativeScore: 0, deleted: false });
    saveState();
    render();
  }
  input.value = '';
}

// 档案账号入场（复用它原来的 id，永久榜不会分裂成两个人）
function joinProfile(id, keepName) {
  ensureRoster(state);
  const profile = state.roster.find(r => r.id === id);
  if (!profile) return;
  const activePlayers = getActivePlayers();
  if (activePlayers.find(p => p.id === id)) return;
  if (activePlayers.length >= 8) {
    alert('最多支持8位活跃玩家');
    return;
  }
  const existing = state.players.find(p => p.id === id);
  if (existing) {
    existing.deleted = false;
    existing.name = profile.name;
  } else {
    state.players.push({ id: id, name: profile.name, cumulativeScore: 0, deleted: false });
  }
  if (!keepName) { saveState(); render(); }
}

// 改档案名：档案库、在场列表、永久榜同时生效（历史账本仍留着当时的名字快照）
function renameProfile(id) {
  ensureRoster(state);
  const profile = state.roster.find(r => r.id === id);
  if (!profile) return;
  const next = prompt('档案新名字', profile.name);
  if (next === null) return;
  const name = next.trim();
  if (!name) return;
  if (state.roster.some(r => r.id !== id && r.name === name)) {
    alert('已经有同名档案了');
    return;
  }
  profile.name = name;
  state.players.forEach(p => { if (p.id === id) p.name = name; });
  saveState();
  render();
}

function removePlayer(id) {
  const activePlayers = getActivePlayers();
  if (activePlayers.length <= 2) {
    alert('至少需要2位活跃玩家才能删除');
    return;
  }
  if (!confirm('确定让他离场？档案和永久战绩都保留，随时可以再加入。')) return;
  const p = state.players.find(x => x.id === id);
  p.deleted = true;
  // 清掉他当前盘待录入的分数，避免遗留键干扰零和校验
  delete state.currentRoundScore[id];
  if (state.dealerIndex >= activePlayers.length - 1) {
    state.dealerIndex = 0;
  }
  saveState();
  render();
}

function restorePlayer(id) {
  const p = state.players.find(x => x.id === id);
  if (!p || !p.deleted) return;
  const activePlayers = getActivePlayers();
  if (activePlayers.length >= 8) {
    alert('已达8位玩家上限');
    return;
  }
  p.deleted = false;
  saveState();
  render();
}

// 调整在场顺序 = 调整做庄轮转顺序（完成一局后庄家顺延到下一位）
function movePlayer(id, delta) {
  const active = getActivePlayers();
  const i = active.findIndex(p => p.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= active.length) return;

  const dealerId = active[state.dealerIndex] ? active[state.dealerIndex].id : null;
  const a = active[i], b = active[j];
  const ia = state.players.indexOf(a), ib = state.players.indexOf(b);
  state.players[ia] = b;
  state.players[ib] = a;

  // 换序后庄家仍是同一个人
  if (dealerId) {
    const k = getActivePlayers().findIndex(p => p.id === dealerId);
    if (k >= 0) state.dealerIndex = k;
  }
  saveState();
  render();
}

function setDealer(index) {
  state.dealerIndex = index;
  startNewRound();
  saveState();
  render();
}

// ===== Round Input =====
// 只统计"当前活跃玩家"的分数 —— 已删除玩家遗留的旧键不再破坏零和校验
function getSum(scores) {
  const active = new Set(getActivePlayers().map(p => p.id));
  return Object.entries(scores || {})
    .filter(([pid]) => active.has(pid))
    .reduce((a, [, v]) => a + (v || 0), 0);
}

function isSumZero(scores) {
  return Object.keys(scores).length > 0 && getSum(scores) === 0;
}

function startNewRound() {
  state.currentRound = 1;
  state.currentRoundScore = {};
  state.rounds = [];
  editingRoundIndex = null;
}

function resetCurrentRound() {
  state.currentRoundScore = {};
  editingRoundIndex = null;
  renderScoreInput();
}

function adjustScore(playerId, delta) {
  if (delta === 0) {
    // 归零
    state.currentRoundScore[playerId] = 0;
  } else {
    const current = state.currentRoundScore[playerId] || 0;
    state.currentRoundScore[playerId] = current + delta;
  }
  calculateDealerScore();
  saveState();
  renderScoreInput();
}

function calculateDealerScore() {
  const activePlayers = getActivePlayers();
  const dealer = activePlayers[state.dealerIndex];
  if (!dealer) return;
  const nonDealerSum = activePlayers
    .filter((_, i) => i !== state.dealerIndex)
    .reduce((sum, p) => sum + (state.currentRoundScore[p.id] || 0), 0);
  state.currentRoundScore[dealer.id] = -nonDealerSum;
}

function updateSumCheck() {
  const el = $('#sum-check');
  const sum = getSum(state.currentRoundScore);
  const activePlayers = getActivePlayers();
  const nonDealerPlayers = activePlayers.filter((_, i) => i !== state.dealerIndex);
  const allNonDealerFilled = nonDealerPlayers.every(p => p.id in state.currentRoundScore);

  const dealer = activePlayers[state.dealerIndex];
  const dealerScore = dealer ? (state.currentRoundScore[dealer.id] || 0) : 0;

  el.textContent = `庄家${dealer ? '「' + dealer.name + '」' : ''}: ${dealerScore > 0 ? '+' : ''}${dealerScore} | 总和: ${sum}`;
  el.className = 'sum-check';

  if (nonDealerPlayers.length === 0) {
    // empty
  } else if (!allNonDealerFilled) {
    el.classList.add('invalid');
    el.textContent += '（请为闲家输入积分）';
  } else {
    el.classList.add('valid');
  }
}

// Submit current round
$('#btn-complete-round').addEventListener('click', () => {
  // 确保庄家积分已计算
  calculateDealerScore();

  // 只取当前活跃玩家的输入（忽略已删除玩家遗留的键）
  const scores = {};
  const filled = {};
  getActivePlayers().forEach(p => {
    if (p.id in state.currentRoundScore) {
      scores[p.id] = state.currentRoundScore[p.id];
      filled[p.id] = true;
    }
  });

  // 所有闲家必须有输入
  const activePlayers = getActivePlayers();
  const nonDealerPlayers = activePlayers.filter((_, i) => i !== state.dealerIndex);
  const allNonDealerFilled = nonDealerPlayers.every(p => filled[p.id]);

  if (!allNonDealerFilled) {
    alert('请为所有闲家选择积分');
    return;
  }

  // Sum must be 0 (should always be true since dealer auto-balances)
  if (getSum(scores) !== 0) {
    alert('积分总和不为0，请检查输入');
    return;
  }

  // Max 5 rounds
  if (state.rounds.length >= 5) {
    alert('已达到5盘限制');
    return;
  }

  const roundRecord = {
    round: state.currentRound,
    scores: { ...scores }
  };

  state.rounds.push(roundRecord);

  // Check if 5 rounds complete
  if (state.rounds.length === 5) {
    completeRound();
    return;
  }

  // Next round
  state.currentRound++;
  state.currentRoundScore = {};
  editingRoundIndex = null;
  $('#round-select').value = String(state.currentRound);
  saveState();
  render();
});

function completeRound() {
  // Calculate round summary
  const activePlayers = getActivePlayers();
  const dealer = activePlayers[state.dealerIndex];
  const roundSummary = {};
  state.players.forEach(p => {
    roundSummary[p.id] = state.rounds.reduce((acc, r) => acc + (r.scores[p.id] || 0), 0);
  });

  const gameRecord = {
    uid: 'g' + Date.now() + Math.random().toString(36).slice(2, 7),
    dealerId: dealer.id,
    dealerName: dealer.name,
    roundRecords: JSON.parse(JSON.stringify(state.rounds)),
    roundScoreSummary: roundSummary,
    completedAt: new Date().toISOString()
  };
  state.gameHistory.push(gameRecord);

  // 写进永久账本（跨 session 累积，不受"开始新的一局"影响）
  if (!Array.isArray(state.allTimeLog)) state.allTimeLog = [];
  state.allTimeLog.push(logEntryFromGame(state, gameRecord, gameRecord.uid));

  // Update cumulative scores (all players, deleted ones also accumulate)
  state.players.forEach(p => {
    if (roundSummary[p.id]) {
      p.cumulativeScore += roundSummary[p.id];
    }
  });

  toast('本局完成，已计入累计积分');

  // Switch dealer
  advanceDealer();
  saveState();
  render();
}

function advanceDealer() {
  // Move to next active player
  const activePlayers = getActivePlayers();
  state.dealerIndex = (state.dealerIndex + 1) % activePlayers.length;
  startNewRound();
}

// Delete a round
function deleteRound(index) {
  if (!confirm('确定删除第 ' + (index + 1) + ' 盘？')) return;
  const removed = state.rounds[index];
  state.rounds.splice(index, 1);
  state.currentRound = Math.max(1, state.rounds.length + 1);
  $('#round-select').value = String(state.currentRound);
  state.currentRoundScore = {};
  editingRoundIndex = null;
  saveState();
  render();
}

// Delete a game history record
function deleteGameHistory(index) {
  if (!confirm('确定删除该局记录？')) return;
  const record = state.gameHistory[index];
  // Restore cumulative scores
  state.players.forEach(p => {
    if (record.roundScoreSummary[p.id]) {
      p.cumulativeScore -= record.roundScoreSummary[p.id];
    }
  });
  // 永久账本同步删除对应那一局（改错要能改回来）
  if (record.uid && Array.isArray(state.allTimeLog)) {
    state.allTimeLog = state.allTimeLog.filter(e => e.uid !== record.uid);
  }
  state.gameHistory.splice(index, 1);
  saveState();
  render();
}

// ===== Reset =====
$('#btn-reset-all').addEventListener('click', () => {
  if (!confirm('确定重置本次数据？（在场玩家、当前局、本次历史都会清空；档案库和永久榜单保留）')) return;
  const keepLog = state.allTimeLog || [];
  const keepRoster = state.roster || [];
  state = defaultState();
  state.allTimeLog = keepLog;      // 永久榜单不被"重置本次"清掉
  state.roster = keepRoster;       // 档案库同理，id 不能换
  state.allTimeSeeded = true;
  saveState();
  render();
});

// 永久榜单没有清空入口 —— 永久数据只增不减（要清只能在服务端删 scores.json 的 allTimeLog）

$('#btn-new-game').addEventListener('click', () => {
  if (!confirm('开始新的一局：本次累计积分清零、本次历史清空；档案库与永久榜单继续累积。确定？')) return;
  state.players.forEach(p => p.cumulativeScore = 0);
  state.gameHistory = [];
  startNewRound();
  saveState();
  render();
});

// ===== Render Functions =====
function render() {
  renderGameTotal();
  renderPlayerManagement();
  renderRoster();
  renderCurrentInfo();
  renderScoreInput();
  renderRoundsList();
  renderLeaderboard();
  renderStats();
  renderSessionStats();
  renderAllTime();
  renderTrend();
  renderPeriodStats();
  renderLookup();
  renderCurrentGameDetail();
  renderHistory();
}

function renderGameTotal() {
  const container = $('#game-total-players');
  if (!container) return;

  if (state.players.length < 2 || state.rounds.length === 0) {
    container.innerHTML = '<div class="game-total-empty">暂无数据</div>';
    return;
  }

  // 计算每人在所有已完成盘数中的总积分
  const totals = {};
  state.players.forEach(p => {
    totals[p.id] = state.rounds.reduce((sum, r) => sum + (r.scores[p.id] || 0), 0);
  });

  container.innerHTML = state.players.map(p => {
    const score = totals[p.id] || 0;
    const cls = score > 0 ? 'pos-score' : score < 0 ? 'neg-score' : '';
    return `
      <div class="game-total-card ${score > 0 ? 'card-pos' : score < 0 ? 'card-neg' : 'card-zero'}">
        <div class="game-total-name">${escapeHtml(p.name)}</div>
        <div class="game-total-score ${cls}">${score > 0 ? '+' : ''}${score}</div>
      </div>
    `;
  }).join('');
}

function renderPlayerManagement() {
  const list = $('#players-list');
  const countEl = $('#player-count');
  const activePlayers = getActivePlayers();
  countEl.textContent = activePlayers.length;

  list.innerHTML = '';

  // 在场玩家（身份 = 档案账号）
  activePlayers.forEach((p, i) => {
    const li = document.createElement('li');
    const isDealer = i === state.dealerIndex;
    li.innerHTML = `
      <div class="player-name-cell">
        ${escapeHtml(p.name)}
        <span class="player-badge ${isDealer ? 'badge-dealer' : 'badge-player'}">
          ${isDealer ? '庄家' : '闲家'}
        </span>
      </div>
      <div class="player-actions">
        ${!isDealer ? `<button onclick="setDealer(${i})">设庄</button>` : ''}
        ${i > 0 ? `<button onclick="movePlayer('${p.id}',-1)">↑</button>` : ''}
        ${i < activePlayers.length - 1 ? `<button onclick="movePlayer('${p.id}',1)">↓</button>` : ''}
        <button onclick="renameProfile('${p.id}')">改名</button>
        <button class="del-btn" onclick="removePlayer('${p.id}')">离场</button>
      </div>
    `;
    list.appendChild(li);
  });
}

// 档案库：永久账号 + 关联的累计战绩（离场的也在这，可随时重新加入）
function renderRoster() {
  const list = document.getElementById('roster-list');
  if (!list) return;
  ensureRoster(state);

  const stats = {};
  computeAllTimeStats().forEach(s => { stats[s.id] = s; });
  const activeIds = new Set(getActivePlayers().map(p => p.id));
  const countEl = document.getElementById('roster-count');
  if (countEl) countEl.textContent = state.roster.length;

  list.innerHTML = '';
  const rows = [...state.roster].sort((a, b) => {
    const ta = stats[a.id] ? stats[a.id].total : 0;
    const tb = stats[b.id] ? stats[b.id].total : 0;
    return tb - ta;
  });

  rows.forEach(r => {
    const st = stats[r.id] || { games: 0, total: 0, wins: 0 };
    const inGame = activeIds.has(r.id);
    const wr = st.games ? Math.round(st.wins / st.games * 100) : 0;
    const sign = v => (v > 0 ? '+' : '') + v;
    const li = document.createElement('li');
    li.className = 'roster-item';
    li.innerHTML = `
      <div class="roster-main">
        <div class="roster-line1">
          <span class="roster-name">${escapeHtml(r.name)}</span>
          <span class="player-badge ${inGame ? 'badge-dealer' : 'badge-deleted'}">${inGame ? '在场' : '离场'}</span>
        </div>
        <div class="roster-stats">
          ${st.games} 局 · 总积分
          <b class="${st.total > 0 ? 'pos-score' : st.total < 0 ? 'neg-score' : ''}">${sign(st.total)}</b>
          · 胜率 ${wr}%
        </div>
      </div>
      <div class="player-actions">
        ${inGame ? '' : `<button onclick="joinProfile('${r.id}')">加入</button>`}
        <button onclick="renameProfile('${r.id}')">改名</button>
      </div>
    `;
    list.appendChild(li);
  });
}

function renderCurrentInfo() {
  const activePlayers = getActivePlayers();
  const dealer = activePlayers[state.dealerIndex];
  const dealerEl = $('#dealer-name');
  dealerEl.textContent = dealer ? dealer.name : '-';

  const playersDisplay = $('#players-list-display');
  if (activePlayers.length > 1) {
    playersDisplay.innerHTML = activePlayers
      .filter((_, i) => i !== state.dealerIndex)
      .map(p => `<span class="player-chip">${escapeHtml(p.name)}</span>`)
      .join('');
  } else {
    playersDisplay.innerHTML = '<span style="color:#5a6a7a;font-size:13px;">至少需要2位玩家</span>';
  }
}

function setStep(step) {
  currentStep = step;
  renderScoreInput();
}

function renderScoreInput() {
  const tbody = $('#score-input-body');
  const activePlayers = getActivePlayers();
  tbody.innerHTML = '';

  if (activePlayers.length < 2) {
    tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;color:#5a6a7a;padding:30px;">请先添加至少2位玩家</td></tr>';
    return;
  }

  calculateDealerScore();

  activePlayers.forEach((p, i) => {
    const isDealer = i === state.dealerIndex;
    const val = state.currentRoundScore[p.id] ?? '';
    const row = document.createElement('tr');
    row.className = isDealer ? 'dealer-row' : '';
    const displayVal = val === '' || val === undefined ? 0 : val;

    if (isDealer) {
      row.innerHTML = `
        <td class="player-label">${escapeHtml(p.name)}</td>
        <td class="dealer-auto-score">
          <span class="auto-score-value ${displayVal > 0 ? 'pos-score' : displayVal < 0 ? 'neg-score' : ''}">
            ${displayVal > 0 ? '+' : ''}${displayVal}
          </span>
          <span class="auto-score-label">自动计算</span>
        </td>
      `;
    } else {
      // 闲家 — 可调步长加减器
      const steps = STEP_OPTIONS;
      row.innerHTML = `
        <td colspan="2" class="player-score-cell">
          <div class="score-player-header">
            <span class="player-label">${escapeHtml(p.name)}</span>
            <span class="score-value ${displayVal > 0 ? 'pos-score' : displayVal < 0 ? 'neg-score' : ''}">
              ${displayVal > 0 ? '+' : ''}${displayVal}
            </span>
          </div>
          <div class="step-selector">
            <span class="step-label">步长</span>
            ${steps.map(s =>
              `<button class="step-btn ${s === currentStep ? 'step-active' : ''}" onclick="setStep(${s})">${s}</button>`
            ).join('')}
          </div>
          <div class="stepper-actions">
            <button class="stepper-btn stepper-minus" onclick="adjustScore('${p.id}', -${currentStep})">−${currentStep}</button>
            <button class="stepper-btn stepper-plus" onclick="adjustScore('${p.id}', ${currentStep})">+${currentStep}</button>
            <button class="stepper-reset" onclick="adjustScore('${p.id}', 0)">归零</button>
          </div>
        </td>
      `;
    }

    tbody.appendChild(row);
  });

  updateSumCheck();
  updateCompleteButton();
}

function renderRoundsList() {
  const list = $('#rounds-list');
  const countEl = document.getElementById('rounds-count');
  if (countEl) countEl.textContent = state.rounds.length;
  if (list) list.classList.toggle('collapsed', !roundsOpen);   // 默认收起，省一屏高度
  list.innerHTML = '';

  if (state.rounds.length === 0) {
    list.innerHTML = '<div class="history-empty">暂无录入</div>';
    return;
  }

  state.rounds.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'round-item';
    const scoreText = state.players.map(p =>
      `${escapeHtml(p.name)}: ${r.scores[p.id] || 0}`
    ).join(' | ');
    div.innerHTML = `
      <div class="round-item-left">
        <span class="round-item-round">第 ${r.round} 盘</span>
        <span class="round-item-scores">${scoreText}</span>
      </div>
      <button class="round-item-delete" onclick="deleteRound(${i})">×</button>
    `;
    list.appendChild(div);
  });

  updateCompleteButton();
}

function updateCompleteButton() {
  const btn = $('#btn-complete-round');
  if (state.rounds.length >= 5) {
    btn.disabled = false;
    btn.textContent = '提交本局结果';
  } else {
    btn.disabled = getActivePlayers().length < 2;
    btn.textContent = '录入本盘';
  }
}

function renderLeaderboard() {
  const container = $('#leaderboard-list');
  if (!container) return;

  if (state.players.length === 0) {
    container.innerHTML = '<div class="lb-empty">暂无玩家</div>';
    return;
  }

  // 按累计积分从高到低排序
  const sorted = [...state.players].sort((a, b) => (b.cumulativeScore || 0) - (a.cumulativeScore || 0));
  const medals = null; // iOS 风格：只用名次数字，不用奖牌图形

  // 计算总分
  const totalScore = sorted.reduce((sum, p) => sum + (p.cumulativeScore || 0), 0);

  container.innerHTML = `
    <div class="lb-header">
      <div class="lb-total">总积分: <span class="${totalScore > 0 ? 'pos-score' : totalScore < 0 ? 'neg-score' : ''}">${totalScore}</span></div>
    </div>
    <div class="lb-items">
      ${sorted.map((p, i) => {
        const score = p.cumulativeScore || 0;
        const rank = String(i + 1);
        const cls = score > 0 ? 'pos-score' : score < 0 ? 'neg-score' : '';
        return `
          <div class="lb-item ${score > 0 ? 'item-pos' : score < 0 ? 'item-neg' : 'item-zero'}">
            <span class="lb-rank">${rank}</span>
            <span class="lb-name">${escapeHtml(p.name)}</span>
            <span class="lb-score ${cls}">${score > 0 ? '+' : ''}${score}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderCurrentGameDetail() {
  const container = $('#current-game-detail');
  if (!container) return;

  const hasRounds = state.rounds.length > 0;
  const hasHistory = state.gameHistory.length > 0;

  if (!hasRounds && !hasHistory) {
    container.innerHTML = '<div class="lb-empty">暂无本局数据</div>';
    return;
  }

  let html = '';

  // 当前局（尚未完成的局）的盘数详情
  if (hasRounds) {
    const activePlayers = getActivePlayers();
    const dealer = activePlayers[state.dealerIndex];
    
    html += `<div class="gd-game-header">
      <div class="gd-game-title">当前局 · 庄家：<span class="dealer-name">${dealer ? escapeHtml(dealer.name) : '-'}</span></div>
    </div>`;

    // 每个盘显示为一行表格
    html += '<div class="gd-rounds-table">';
    html += '<div class="gd-table-header">';
    html += '<span class="gd-col-round">盘</span>';
    state.players.forEach(p => {
      html += `<span class="gd-col-player">${escapeHtml(p.name)}</span>`;
    });
    html += '<span class="gd-col-total">合计</span>';
    html += '</div>';

    state.rounds.forEach((r, i) => {
      const rowScores = state.players.map(p => r.scores[p.id] || 0);
      const rowTotal = rowScores.reduce((a, b) => a + b, 0);
      
      html += `<div class="gd-table-row">`;
      html += `<span class="gd-col-round">第${r.round}盘</span>`;
      state.players.forEach(p => {
        const s = r.scores[p.id] || 0;
        const cls = s > 0 ? 'pos-score' : s < 0 ? 'neg-score' : '';
        html += `<span class="gd-col-player ${cls}">${s > 0 ? '+' : ''}${s}</span>`;
      });
      const totalCls = rowTotal > 0 ? 'pos-score' : rowTotal < 0 ? 'neg-score' : '';
      html += `<span class="gd-col-total ${totalCls}">${rowTotal > 0 ? '+' : ''}${rowTotal}</span>`;
      html += `</div>`;
    });

    // 本局合计行
    const totals = {};
    state.players.forEach(p => {
      totals[p.id] = state.rounds.reduce((sum, r) => sum + (r.scores[p.id] || 0), 0);
    });
    const gameTotal = Object.values(totals).reduce((a, b) => a + b, 0);
    
    html += '<div class="gd-table-footer">';
    html += '<span class="gd-col-round">本局</span>';
    state.players.forEach(p => {
      const s = totals[p.id] || 0;
      const cls = s > 0 ? 'pos-score' : s < 0 ? 'neg-score' : '';
      html += `<span class="gd-col-player ${cls}">${s > 0 ? '+' : ''}${s}</span>`;
    });
    const ftCls = gameTotal > 0 ? 'pos-score' : gameTotal < 0 ? 'neg-score' : '';
    html += `<span class="gd-col-total ${ftCls}">${gameTotal > 0 ? '+' : ''}${gameTotal}</span>`;
    html += '</div>';
    html += '</div>';
  }

  // 如果还有已完成的局，显示已完成局的信息
  if (hasHistory) {
    if (hasRounds) {
      html += '<div class="gd-divider"></div>';
    }
    html += `<div class="gd-completed-info">已完成 ${state.gameHistory.length} 局记录，详见下方历史记录</div>`;
  }

  container.innerHTML = html;
}

// 永久总榜：总积分 / 总胜率 / 总排名
function renderAllTime() {
  const container = document.getElementById('alltime-board');
  if (!container) return;

  const stats = computeAllTimeStats().filter(s => s.games > 0);
  if (stats.length === 0) {
    container.innerHTML = '<div class="lb-empty">还没有累计对局</div>';
    return;
  }

  const ranked = stats.sort((a, b) =>
    (b.total - a.total) || (b.wins - a.wins) || (b.games - a.games));
  const totalGames = (state.allTimeLog || []).length;

  let html = `<div class="at-meta">累计 ${totalGames} 局 · ${ranked.length} 位玩家 · 胜率按盘计算</div>`;
  html += `<div class="at-row at-head">
    <span>排名</span><span class="at-name">玩家</span><span>总积分</span><span>局数</span><span>盘数</span><span>胜率</span>
  </div>`;

  ranked.forEach((s, i) => {
    const wr = s.roundsTotal ? s.roundsWon / s.roundsTotal * 100 : 0;
    const sign = v => (v > 0 ? '+' : '') + v;
    html += `<div class="at-row">
      <span class="at-rank">${i + 1}</span>
      <span class="at-name">${escapeHtml(s.name)}</span>
      <span class="st-num ${s.total > 0 ? 'pos-score' : s.total < 0 ? 'neg-score' : ''}">${sign(s.total)}</span>
      <span>${s.games}</span>
      <span>${s.roundsTotal}</span>
      <span class="st-num ${wr >= 50 ? 'pos-score' : ''}">${Math.round(wr)}%</span>
    </div>`;
  });

  container.innerHTML = html;
}

function renderStatsTable(container, stats, emptyText) {
  if (!container) return;

  const played = stats.filter(s => s.games > 0);

  if (played.length === 0) {
    container.innerHTML = `<div class="lb-empty">${emptyText}</div>`;
    return;
  }

  // 排序：盘胜率 → 总积分
  const ranked = played.sort((a, b) => {
    const wa = a.roundsTotal ? a.roundsWon / a.roundsTotal : 0;
    const wb = b.roundsTotal ? b.roundsWon / b.roundsTotal : 0;
    return (wb - wa) || (b.total - a.total);
  });

  let html = `<div class="st-row st-head">
    <span class="st-name">玩家</span>
    <span>局数</span>
    <span>局胜负</span>
    <span>盘数</span>
    <span>胜率</span>
    <span>盘最长连</span>
    <span>盘当前连</span>
    <span>局均分</span>
  </div>`;

  ranked.forEach(s => {
    const wr = s.roundsTotal ? s.roundsWon / s.roundsTotal * 100 : 0;
    const avg = s.games ? s.total / s.games : 0;
    const num = v => (v > 0 ? '+' : '') + v.toFixed(1);
    html += `<div class="st-row">
      <span class="st-name">${escapeHtml(s.name)}</span>
      <span>${s.games}</span>
      <span><b class="pos-score">${s.wins}</b>/<i>${s.draws}</i>/<b class="neg-score">${s.losses}</b></span>
      <span>${s.roundsTotal}</span>
      <span class="st-num ${wr >= 50 ? 'pos-score' : ''}">${Math.round(wr)}%</span>
      <span class="st-num">${s.roundBestStreak}</span>
      <span class="st-num ${s.roundCurStreak > 0 ? 'pos-score' : ''}">${s.roundCurStreak}</span>
      <span class="st-num ${avg > 0 ? 'pos-score' : avg < 0 ? 'neg-score' : ''}">${num(avg)}</span>
    </div>`;
  });

  container.innerHTML = html;
}

// 永久战绩明细
function renderStats() {
  renderStatsTable($('#stats-table'), computeAllTimeStats(), '还没有已完成的对局');
}

// 本次（当前 session）胜率 —— 口径与永久榜一致：按盘计算，只算本次 gameHistory
function computeSessionStats() {
  const out = {};
  const rosterName = {};
  (state.roster || []).forEach(r => { rosterName[r.id] = r.name; });

  const touch = (id, name) => {
    if (!out[id]) out[id] = {
      id: id, name: rosterName[id] || name || id,
      games: 0, wins: 0, draws: 0, losses: 0, total: 0,
      roundsTotal: 0, roundsWon: 0, roundBestStreak: 0, roundCurStreak: 0, roundCur: 0
    };
    if (rosterName[id]) out[id].name = rosterName[id];
    return out[id];
  };

  (state.gameHistory || []).forEach(g => {
    Object.entries(g.roundScoreSummary || {}).forEach(([id, score]) => {
      const s = touch(id);
      s.games++;
      s.total += score;
      if (score > 0) s.wins++;
      else if (score < 0) s.losses++;
      else s.draws++;
    });

    const seq = roundSeqFromGame(g);
    Object.entries(seq).forEach(([id, arr]) => {
      const s = touch(id);
      arr.forEach(v => {
        s.roundsTotal++;
        if (v > 0) {
          s.roundsWon++;
          s.roundCurStreak++;
          if (s.roundCurStreak > s.roundBestStreak) s.roundBestStreak = s.roundCurStreak;
        } else {
          s.roundCurStreak = 0;
        }
      });
    });
  });

  return Object.values(out);
}

function renderSessionStats() {
  renderStatsTable(document.getElementById('session-stats'), computeSessionStats(), '本次还没有完成的对局');
}

// 单局胜负的统计逻辑已统一到 computeAllTimeStats()（读永久账本）。
// 这里不再保留按 session 计算的重复实现，避免两处口径不一致。

// ===== 查分：选一位玩家，列出他的全部对局 =====
function shortTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderLookup() {
  const sel = document.getElementById('lookup-player');
  const out = document.getElementById('lookup-result');
  if (!sel || !out) return;

  ensureRoster(state);

  // 重建下拉（保留当前选择）
  const cur = sel.value;
  const stats = {};
  computeAllTimeStats().forEach(s => { stats[s.id] = s; });
  sel.innerHTML = '<option value="">选择玩家…</option>' +
    state.roster
      .slice()
      .sort((a, b) => ((stats[b.id] ? stats[b.id].total : 0) - (stats[a.id] ? stats[a.id].total : 0)))
      .map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`)
      .join('');
  if (cur && state.roster.some(r => r.id === cur)) sel.value = cur;

  const id = sel.value;
  if (!id) {
    out.innerHTML = '<div class="lb-empty">选择一位玩家，查看他的全部对局</div>';
    return;
  }

  const st = stats[id] || { name: '', games: 0, wins: 0, draws: 0, losses: 0, total: 0, roundsTotal: 0, roundsWon: 0, roundBestStreak: 0 };
  const wr = st.roundsTotal ? Math.round(st.roundsWon / st.roundsTotal * 100) : 0;
  const entries = (state.allTimeLog || []).filter(e => (e.summary || []).some(x => x.id === id));

  let html = `<div class="lk-summary">
    <span class="lk-name">${escapeHtml(st.name)}</span>
    <span class="st-num ${st.total > 0 ? 'pos-score' : st.total < 0 ? 'neg-score' : ''}">总积分 ${st.total > 0 ? '+' : ''}${st.total}</span>
    <span>${st.games} 局 · ${st.roundsTotal} 盘 · 胜率 ${wr}%</span>
    <span>局 ${st.wins}胜 ${st.draws}平 ${st.losses}负 · 盘最长连 ${st.roundBestStreak}</span>
  </div>
  <div class="lk-row lk-head"><span>时间</span><span>本局得分</span><span>同桌</span></div>`;

  [...entries].reverse().slice(0, 40).forEach(e => {
    const me = (e.summary || []).find(x => x.id === id);
    if (!me) return;
    const others = (e.summary || []).filter(x => x.id !== id).map(x => x.name).join('、');
    html += `<div class="lk-row">
      <span>${shortTime(e.at)}</span>
      <span class="st-num ${me.score > 0 ? 'pos-score' : me.score < 0 ? 'neg-score' : ''}">${me.score > 0 ? '+' : ''}${me.score}</span>
      <span class="lk-others">${escapeHtml(others)}</span>
    </div>`;
  });

  out.innerHTML = html;
}

const lookupSel = document.getElementById('lookup-player');
if (lookupSel) lookupSel.addEventListener('change', renderLookup);

// ===== 走势图：累计总积分随时间的折线（纯 SVG，无外部依赖）=====
function renderTrend() {
  const wrap = document.getElementById('trend-chart');
  if (!wrap) return;

  const log = state.allTimeLog || [];
  if (log.length < 2) {
    wrap.innerHTML = '<div class="lb-empty">至少完成 2 局才能画走势</div>';
    return;
  }

  const stats = computeAllTimeStats().filter(s => s.games > 0)
    .sort((a, b) => (b.total - a.total) || (b.games - a.games));
  if (!stats.length) { wrap.innerHTML = '<div class="lb-empty">暂无数据</div>'; return; }

  const COLORS = ['#007AFF', '#FF3B30', '#34C759', '#FF9500', '#AF52DE', '#30B0C7', '#8E8E93', '#A2845E'];
  const series = stats.map((s, i) => ({
    id: s.id, name: s.name, color: COLORS[i % COLORS.length], pts: []
  }));

  // 逐局累加
  const acc = {};
  log.forEach(e => {
    (e.summary || []).forEach(({ id, score }) => { acc[id] = (acc[id] || 0) + score; });
    series.forEach(se => se.pts.push(acc[se.id] || 0));
  });

  const W = Math.max(320, log.length * 14 + 44);
  const H = 190, padL = 38, padR = 12, padT = 14, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;

  let maxY = 0, minY = 0;
  series.forEach(se => se.pts.forEach(v => { maxY = Math.max(maxY, v); minY = Math.min(minY, v); }));
  const span = Math.max(10, maxY - minY);
  const x = i => padL + (log.length === 1 ? innerW / 2 : innerW * i / (log.length - 1));
  const y = v => padT + innerH * (1 - (v - minY) / span);

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="trend-svg">`;

  // 横向网格 + 纵轴刻度（0 线加重，因为是零和）
  [minY, minY + span / 2, maxY].forEach(v => {
    const t = Math.round(v);
    svg += `<line x1="${padL}" y1="${y(t).toFixed(1)}" x2="${W - padR}" y2="${y(t).toFixed(1)}"
      class="trend-grid${t === 0 ? ' trend-zero' : ''}"/>`;
    svg += `<text x="${padL - 6}" y="${(y(t) + 3.5).toFixed(1)}" class="trend-axis" text-anchor="end">${t > 0 ? '+' : ''}${t}</text>`;
  });

  // 时间刻度：首 / 中 / 末
  const idxs = [...new Set([0, Math.floor((log.length - 1) / 2), log.length - 1])];
  idxs.forEach(i => {
    const st = shortTime(log[i].at);
    const label = st === '—' ? `第${i + 1}局` : st.slice(0, 5);
    svg += `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="trend-axis" text-anchor="middle">${label}</text>`;
    svg += `<line x1="${x(i).toFixed(1)}" y1="${padT}" x2="${x(i).toFixed(1)}" y2="${H - padB}" class="trend-grid"/>`;
  });

  // 曲线 + 端点
  series.forEach(se => {
    const d = se.pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    svg += `<path d="${d}" class="trend-line" stroke="${se.color}"/>`;
    const n = se.pts.length - 1;
    svg += `<circle cx="${x(n).toFixed(1)}" cy="${y(se.pts[n]).toFixed(1)}" r="2.5" fill="${se.color}"/>`;
  });
  svg += '</svg>';

  const legend = series.map(se =>
    `<span class="trend-key"><i style="background:${se.color}"></i>${escapeHtml(se.name)}</span>`).join('');

  wrap.innerHTML = `<div class="trend-legend">${legend}</div><div class="trend-scroll">${svg}</div>
    <div class="trend-note">共 ${log.length} 局 · 纵向为该玩家累计积分</div>`;

  const sc = wrap.querySelector('.trend-scroll');
  if (sc) sc.scrollLeft = sc.scrollWidth;   // 默认停在最新一端
}

// ===== 月度 / 年度统计（按永久账本的时间戳分桶）=====
let periodMode = 'month';

function setPeriodMode(mode) {
  periodMode = mode;
  document.querySelectorAll('.period-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  renderPeriodStats();
}

function periodKey(iso, mode) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = n => String(n).padStart(2, '0');
  return mode === 'year' ? String(d.getFullYear()) : `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

function computePeriodStats(mode) {
  const rosterName = {};
  (state.roster || []).forEach(r => { rosterName[r.id] = r.name; });
  const buckets = {};

  (state.allTimeLog || []).forEach(e => {
    const key = periodKey(e.at, mode) || '未标日期';
    const b = buckets[key] || (buckets[key] = { key: key, games: 0, per: {} });
    b.games++;
    (e.summary || []).forEach(({ id, name, score }) => {
      const p = b.per[id] || (b.per[id] = { id: id, name: rosterName[id] || name || id, total: 0, rounds: 0, roundWins: 0 });
      p.total += score;
      p.rounds += (e.rounds || 0);
      const seq = e.roundSeq && e.roundSeq[id];
      if (Array.isArray(seq)) p.roundWins += seq.filter(v => v > 0).length;
      else p.roundWins += ((e.roundWins && e.roundWins[id]) || 0);
      if (rosterName[id]) p.name = rosterName[id];
    });
  });

  return Object.values(buckets).sort((a, b) => {
    if (a.key === '未标日期') return 1;    // 无日期的排最后
    if (b.key === '未标日期') return -1;
    return a.key < b.key ? 1 : -1;         // 新的在前
  });
}

function renderPeriodStats() {
  const box = document.getElementById('period-stats');
  if (!box) return;

  const rows = computePeriodStats(periodMode);
  if (!rows.length) {
    box.innerHTML = '<div class="lb-empty">还没有对局</div>';
    return;
  }

  const dated = rows.filter(r => r.key !== '未标日期').length;
  let html = '';
  if (!dated) {
    html += `<div class="period-note">历史对局没有时间戳，月度/年度要等新记录累积。下面是全部未标日期的记录。</div>`;
  }

  rows.forEach(b => {
    const players = Object.values(b.per).sort((a, c) => c.total - a.total);
    const chips = players.map(p => {
      const wr = p.rounds ? Math.round(p.roundWins / p.rounds * 100) : 0;
      const cls = p.total > 0 ? 'pos-score' : p.total < 0 ? 'neg-score' : '';
      const label = periodMode === 'year' ? `${b.key} 年` : b.key;
      return `<span class="period-chip" title="${p.rounds} 盘 · 胜率 ${wr}%">
        <span class="pname">${escapeHtml(p.name)}</span><b class="${cls}">${p.total > 0 ? '+' : ''}${p.total}</b>
      </span>`;
    }).join('');
    const head = b.key === '未标日期' ? `未标日期 · ${b.games} 局` : `${b.key} · ${b.games} 局`;
    html += `<div class="period-block">
      <div class="period-head">${head}</div>
      <div class="period-players">${chips}</div>
    </div>`;
  });

  box.innerHTML = html;
}

function renderHistory() {
  const list = $('#history-list');
  list.innerHTML = '';

  if (state.gameHistory.length === 0) {
    list.innerHTML = '<div class="lb-empty">暂无历史记录</div>';
    return;
  }

  // 按时间倒序显示（最新的在前面）
  const reversedHistory = [...state.gameHistory].reverse();

  reversedHistory.forEach((g, i) => {
    const originalIndex = state.gameHistory.length - 1 - i;
    const div = document.createElement('div');
    div.className = 'history-item';

    // 表格形式显示每局数据
    let html = `<div class="gd-game-header">
      <div class="gd-game-title">第 ${originalIndex + 1} 局 · 庄家：<span class="dealer-name">${escapeHtml(g.dealerName)}</span><span class="gd-game-time">${formatTime(g.completedAt)}</span></div>
      <button class="round-item-delete" onclick="deleteGameHistory(${originalIndex})">×</button>
    </div>`;

    html += '<div class="gd-rounds-table">';
    
    // 表头
    html += '<div class="gd-table-header">';
    html += '<span class="gd-col-round">盘</span>';
    state.players.forEach(p => {
      html += `<span class="gd-col-player">${escapeHtml(p.name)}</span>`;
    });
    html += '<span class="gd-col-total">合计</span>';
    html += '</div>';

    // 每盘数据
    g.roundRecords.forEach(r => {
      const rowScores = state.players.map(p => r.scores[p.id] || 0);
      const rowTotal = rowScores.reduce((a, b) => a + b, 0);
      
      html += `<div class="gd-table-row">`;
      html += `<span class="gd-col-round">第${r.round}盘</span>`;
      state.players.forEach(p => {
        const s = r.scores[p.id] || 0;
        const cls = s > 0 ? 'pos-score' : s < 0 ? 'neg-score' : '';
        html += `<span class="gd-col-player ${cls}">${s > 0 ? '+' : ''}${s}</span>`;
      });
      const totalCls = rowTotal > 0 ? 'pos-score' : rowTotal < 0 ? 'neg-score' : '';
      html += `<span class="gd-col-total ${totalCls}">${rowTotal > 0 ? '+' : ''}${rowTotal}</span>`;
      html += `</div>`;
    });

    // 合计行
    html += '<div class="gd-table-footer">';
    html += '<span class="gd-col-round">本局</span>';
    state.players.forEach(p => {
      const s = g.roundScoreSummary[p.id] || 0;
      const cls = s > 0 ? 'pos-score' : s < 0 ? 'neg-score' : '';
      html += `<span class="gd-col-player ${cls}">${s > 0 ? '+' : ''}${s}</span>`;
    });
    html += '<span class="gd-col-total gd-col-check">✓</span>';
    html += '</div>';
    html += '</div>';

    div.innerHTML = html;
    list.appendChild(div);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 老记录没有 completedAt → 返回占位，不编造时间
function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return ` ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ===== Init =====
render();
loadFromServer();
