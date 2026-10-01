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
  return localData || defaultState();
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
    gameHistory: [],      // [{dealerId, dealerName, roundRecords, roundScoreSummary, completedAt}]
    currentRoundScore: {},// running scores for current round being input
    rev: 0                // 服务端版本号（冲突检测用）
  };
}

function getActivePlayers() {
  return state.players.filter(p => !p.deleted);
}

let state = loadState();
let editingRoundIndex = null; // null = new round, number = editing existing
let currentStep = 10; // 当前步长（可调）

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

// ===== Player Management =====
$('#btn-add-player').addEventListener('click', addPlayer);
$('#new-player-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addPlayer();
});

function addPlayer() {
  const input = $('#new-player-name');
  const name = input.value.trim();
  if (!name) return;
  if (state.players.find(p => p.name === name && !p.deleted)) {
    alert('该玩家已存在');
    return;
  }
  const activePlayers = getActivePlayers();
  if (activePlayers.length >= 8) {
    alert('最多支持8位活跃玩家');
    return;
  }
  state.players.push({
    id: 'p' + Date.now(),
    name,
    cumulativeScore: 0,
    deleted: false
  });
  input.value = '';
  saveState();
  render();
}

function removePlayer(id) {
  const activePlayers = getActivePlayers();
  if (activePlayers.length <= 2) {
    alert('至少需要2位活跃玩家才能删除');
    return;
  }
  if (!confirm('确定删除该玩家？积分将保留，可随时恢复。')) return;
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

  state.gameHistory.push({
    dealerId: dealer.id,
    dealerName: dealer.name,
    roundRecords: JSON.parse(JSON.stringify(state.rounds)),
    roundScoreSummary: roundSummary,
    completedAt: new Date().toISOString()
  });

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
  state.gameHistory.splice(index, 1);
  saveState();
  render();
}

// ===== Reset =====
$('#btn-reset-all').addEventListener('click', () => {
  if (!confirm('确定重置全部数据？')) return;
  state = defaultState();
  saveState();
  render();
});

$('#btn-new-game').addEventListener('click', () => {
  if (!confirm('开始新的一局：当前累计积分将清零，所有记录保留。确定继续？')) return;
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
  renderCurrentInfo();
  renderScoreInput();
  renderRoundsList();
  renderLeaderboard();
  renderStats();
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

  // 活跃玩家
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
        ${!isDealer ? `<button onclick="setDealer(${i})">设为庄家</button>` : ''}
        <button class="del-btn" onclick="removePlayer('${p.id}')">删除</button>
      </div>
    `;
    list.appendChild(li);
  });

  // 已删除玩家
  const deletedPlayers = state.players.filter(p => p.deleted);
  if (deletedPlayers.length > 0) {
    const sep = document.createElement('li');
    sep.className = 'player-list-sep';
    sep.innerHTML = `<div class="sep-label">已删除玩家（可恢复）</div>`;
    list.appendChild(sep);

    deletedPlayers.forEach(p => {
      const li = document.createElement('li');
      li.className = 'player-deleted';
      li.innerHTML = `
        <div class="player-name-cell">
          <span class="deleted-name">${escapeHtml(p.name)}</span>
          <span class="player-badge badge-deleted">已删</span>
        </div>
        <div class="player-actions">
          <button class="restore-btn" onclick="restorePlayer('${p.id}')">恢复</button>
        </div>
      `;
      list.appendChild(li);
    });
  }
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
        <td class="player-label">🎴 ${escapeHtml(p.name)}</td>
        <td class="dealer-auto-score">
          <span class="auto-score-value ${displayVal > 0 ? 'pos-score' : displayVal < 0 ? 'neg-score' : ''}">
            ${displayVal > 0 ? '+' : ''}${displayVal}
          </span>
          <span class="auto-score-label">自动计算</span>
        </td>
      `;
    } else {
      // 闲家 — 可调步长加减器
      const steps = [1, 3, 5, 10];
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
          </div>
          <div class="stepper-reset-area">
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
  const medals = ['🥇', '🥈', '🥉'];

  // 计算总分
  const totalScore = sorted.reduce((sum, p) => sum + (p.cumulativeScore || 0), 0);

  container.innerHTML = `
    <div class="lb-header">
      <div class="lb-total">总积分: <span class="${totalScore > 0 ? 'pos-score' : totalScore < 0 ? 'neg-score' : ''}">${totalScore}</span></div>
    </div>
    <div class="lb-items">
      ${sorted.map((p, i) => {
        const score = p.cumulativeScore || 0;
        const rank = i < 3 ? medals[i] : `#${i + 1}`;
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
      <div class="gd-game-title">🎴 当前局 · 庄家：<span class="dealer-name">${dealer ? escapeHtml(dealer.name) : '-'}</span></div>
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

function renderStats() {
  const container = $('#stats-table');
  if (!container) return;

  const stats = computePlayerStats();
  const played = stats.filter(s => s.games > 0);

  if (played.length === 0) {
    container.innerHTML = '<div class="lb-empty">还没有已完成的对局</div>';
    return;
  }

  // 排序：胜局数 → 胜率 → 累计积分
  const ranked = played.sort((a, b) =>
    (b.wins - a.wins) ||
    (b.wins / b.games - a.wins / a.games) ||
    (b.total - a.total));

  let html = `<div class="st-row st-head">
    <span class="st-name">玩家</span>
    <span>局数</span>
    <span>胜平负</span>
    <span>胜率</span>
    <span>最长连</span>
    <span>当前连</span>
    <span>场均</span>
    <span>盘胜率</span>
  </div>`;

  ranked.forEach((s, i) => {
    const wr = s.games ? s.wins / s.games * 100 : 0;
    const rw = s.roundsTotal ? s.roundsWon / s.roundsTotal * 100 : 0;
    const avg = s.games ? s.total / s.games : 0;
    const num = v => (v > 0 ? '+' : '') + v.toFixed(1);
    html += `<div class="st-row${s.deleted ? ' st-deleted' : ''}">
      <span class="st-name">${i === 0 ? '🥇 ' : ''}${escapeHtml(s.name)}</span>
      <span>${s.games}</span>
      <span><b class="pos-score">${s.wins}</b>/<i>${s.draws}</i>/<b class="neg-score">${s.losses}</b></span>
      <span class="st-num ${wr >= 50 ? 'pos-score' : ''}">${Math.round(wr)}%</span>
      <span class="st-num">${s.bestStreak}</span>
      <span class="st-num ${s.curStreak > 0 ? 'pos-score' : ''}">${s.curStreak}</span>
      <span class="st-num ${avg > 0 ? 'pos-score' : avg < 0 ? 'neg-score' : ''}">${num(avg)}</span>
      <span class="st-num">${Math.round(rw)}%</span>
    </div>`;
  });

  container.innerHTML = html;
}

// 单局（gameHistory 一条）算一次胜负；盘胜负按 roundRecords 统计
function computePlayerStats() {
  const games = state.gameHistory || [];
  const out = {};

  state.players.forEach(p => {
    out[p.id] = {
      id: p.id, name: p.name, deleted: !!p.deleted,
      games: 0, wins: 0, draws: 0, losses: 0, total: 0,
      firsts: 0, bestStreak: 0, curStreak: 0,
      roundsTotal: 0, roundsWon: 0
    };
  });

  games.forEach(g => {
    const entries = Object.entries(g.roundScoreSummary || {});
    const maxScore = entries.length ? Math.max(...entries.map(e => e[1])) : 0;

    entries.forEach(([pid, score]) => {
      const s = out[pid];
      if (!s) return;              // 数据里已不存在的玩家 id，跳过
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
      if (maxScore > 0 && score === maxScore) s.firsts++;
    });

    (g.roundRecords || []).forEach(r => {
      Object.entries(r.scores || {}).forEach(([pid, v]) => {
        const s = out[pid];
        if (!s) return;
        s.roundsTotal++;
        if (v > 0) s.roundsWon++;
      });
    });
  });

  return Object.values(out);
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
      <div class="gd-game-title">📜 第 ${originalIndex + 1} 局 · 庄家：<span class="dealer-name">${escapeHtml(g.dealerName)}</span><span class="gd-game-time">${formatTime(g.completedAt)}</span></div>
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
