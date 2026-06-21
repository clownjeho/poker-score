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
    }).catch(() => {
      // 服务器未运行（用 python3 -m http.server 时），静默忽略
    });
  } catch (_) {}
}

function loadFromServer() {
  fetch(LOAD_URL)
    .then(r => r.ok ? r.json() : null)
    .then(serverData => {
      if (serverData && serverData.players && serverData.players.length > 0) {
        // 服务端数据有效 → 覆盖本地
        state = serverData;
        // 修复兼容性：给没有 deleted 字段的玩家补上
        state.players.forEach(p => { if (p.deleted === undefined) p.deleted = false; });
        saveState();
        render();
      }
    })
    .catch(() => {
      // 服务器未运行，保持本地数据
    });
}

function defaultState() {
  return {
    players: [],          // [{id, name, cumulativeScore, deleted: false}]
    dealerIndex: 0,       // current dealer index
    currentRound: 1,      // 1-5
    rounds: [],           // [{round, scores: {playerId: value}}]
    gameHistory: [],      // [{dealerId, roundRecords: [{round, scores}], roundScoreSummary: {playerId: total}}]
    currentRoundScore: {} // running scores for current round being input
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
function getSum(scores) {
  return Object.values(scores).reduce((a, b) => a + (b || 0), 0);
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
  const scores = state.currentRoundScore;

  // 确保庄家积分已计算
  calculateDealerScore();

  // 所有闲家必须有输入
  const activePlayers = getActivePlayers();
  const nonDealerPlayers = activePlayers.filter((_, i) => i !== state.dealerIndex);
  const allNonDealerFilled = nonDealerPlayers.every(p => p.id in scores && scores[p.id] !== undefined);

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
    roundScoreSummary: roundSummary
  });

  // Update cumulative scores (all players, deleted ones also accumulate)
  state.players.forEach(p => {
    if (roundSummary[p.id]) {
      p.cumulativeScore += roundSummary[p.id];
    }
  });

  alert('本局完成！已统计累计积分。');

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

  container.innerHTML = sorted.map((p, i) => {
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
  }).join('');
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
    const dealer = getActivePlayers()[state.dealerIndex];
    html += `<div class="gd-header">🎴 庄家：<span>${dealer ? escapeHtml(dealer.name) : '-'}</span></div>`;

    state.rounds.forEach((r, i) => {
      const scoresHtml = state.players.map(p => {
        const s = r.scores[p.id] || 0;
        const cls = s > 0 ? 'pos-score' : s < 0 ? 'neg-score' : '';
        return `<span class="${cls}">${escapeHtml(p.name)} ${s > 0 ? '+' : ''}${s}</span>`;
      }).join(' <span class="gd-sep">·</span> ');

      html += `<div class="gd-round">
        <span class="gd-round-label">第 ${r.round} 盘</span>
        <span class="gd-round-scores">${scoresHtml}</span>
      </div>`;
    });

    // 本局合计
    const totals = {};
    state.players.forEach(p => {
      totals[p.id] = state.rounds.reduce((sum, r) => sum + (r.scores[p.id] || 0), 0);
    });
    const totalHtml = state.players.map(p => {
      const s = totals[p.id] || 0;
      const cls = s > 0 ? 'pos-score' : s < 0 ? 'neg-score' : '';
      return `<span class="gd-total-score ${cls}">${escapeHtml(p.name)} ${s > 0 ? '+' : ''}${s}</span>`;
    }).join(' <span class="gd-sep">·</span> ');

    html += `<div class="gd-total-line">
      <span class="gd-total-label">本局合计</span>
      <span class="gd-total-scores">${totalHtml}</span>
    </div>`;
  }

  // 如果还有已完成的局，显示已完成局的信息
  if (hasHistory) {
    const lastGame = state.gameHistory[state.gameHistory.length - 1];
    if (hasRounds) {
      html += '<div class="gd-divider"></div>';
    }
    html += `<div class="gd-completed-info">已完成 ${state.gameHistory.length} 局记录，详见下方</div>`;
  }

  container.innerHTML = html;
}

function renderHistory() {
  const list = $('#history-list');
  list.innerHTML = '';

  if (state.gameHistory.length === 0) {
    list.innerHTML = '<div class="lb-empty">暂无历史记录</div>';
    return;
  }

  state.gameHistory.forEach((g, i) => {
    const div = document.createElement('div');
    div.className = 'history-item';

    let rowsHtml = '';
    g.roundRecords.forEach(r => {
      const scoresHtml = state.players.map(p => {
        const s = r.scores[p.id] || 0;
        const cls = s > 0 ? 'pos-score' : s < 0 ? 'neg-score' : '';
        return `<span class="${cls}">${escapeHtml(p.name)} ${s > 0 ? '+' : ''}${s}</span>`;
      }).join(' <span class="gd-sep">·</span> ');
      rowsHtml += `<div class="gd-round">
        <span class="gd-round-label">第${r.round}盘</span>
        <span class="gd-round-scores">${scoresHtml}</span>
      </div>`;
    });

    // 该局合计
    const totalHtml = state.players.map(p => {
      const s = g.roundScoreSummary[p.id] || 0;
      const cls = s > 0 ? 'pos-score' : s < 0 ? 'neg-score' : '';
      return `<span class="gd-total-score ${cls}">${escapeHtml(p.name)} ${s > 0 ? '+' : ''}${s}</span>`;
    }).join(' <span class="gd-sep">·</span> ');

    const gameIdx = state.gameHistory.length - i; // 倒数序号

    div.innerHTML = `
      <div class="history-item-header">
        第 ${gameIdx} 局 · 庄家：<span>${escapeHtml(g.dealerName)}</span>
        <button class="round-item-delete" onclick="deleteGameHistory(${i})">×</button>
      </div>
      <div class="history-item-rows">${rowsHtml}</div>
      <div class="gd-total-line history-total-line">
        <span class="gd-total-label">合计</span>
        <span class="gd-total-scores">${totalHtml}</span>
      </div>
    `;

    list.appendChild(div);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== Init =====
render();
loadFromServer();
