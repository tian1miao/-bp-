// ================= 全局变量 =================
let heroDict = {};          // name -> id
let idToName = {};          // id -> name
let posCache = {};          // heroId -> {position: pickRate}
let wrCache = {};           // heroId -> {position: winRate}
let anaCache = {};          // heroId -> analysis object
let periodCache = {};       // heroId -> period winrates
let globalWinRate = {};     // date -> {blue, red}
let sessionWrOverrides = {}; // 手动或实时填充的胜率，仅当前会话

const POSITION_MAP = {"0":"对抗路","1":"中路","2":"发育路","3":"打野","4":"辅助"};
const POSITIONS = Object.values(POSITION_MAP);
const POSITION_TO_NUM = Object.fromEntries(Object.entries(POSITION_MAP).map(([k,v])=>[v,k]));
const API_BASE = 'https://tianyuanzhiyi.com/api';

let sideIsBlue = true;
let userPosition = "";
let myTeam = [];
let enemyTeam = [];
let myPositions = [];
let pickedHeroes = new Set();
let currentStep = 0;
let draftSequence = [];
let isCalculating = false;

// ================= 工具函数 =================
function log(msg) {
  const logEl = document.getElementById('log-output');
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function formatAdvantage(adv) {
  const prefix = adv > 0 ? '+' : '';
  return `${prefix}${adv.toFixed(2)}%`;
}

function getVerdict(wr) {
  if (wr > 53) return '妙手';
  if (wr > 50.5) return '不错';
  if (wr > 47) return '中规';
  return '臭手';
}

function getContributionVerdict(impact) {
  if (impact > 2.0) return '妙手';
  if (impact > 0.5) return '不错';
  if (impact > -3.0) return '中规';
  return '臭手';
}

function isMainPosition(heroName, pos) {
  const heroId = heroDict[heroName];
  const positions = posCache[heroId] || {};
  return positions[pos] >= 50;
}

function cleanText(text) {
  return text.replace(/[，、和以及]/g, ',').replace(/[（）]/g, (m) => m === '（' ? '(' : ')').replace(/\s+/g, '').replace(/,,/g, ',').replace(/^,|,$/g, '');
}

function parseHeroInput(text) {
  text = cleanText(text);
  if (heroDict[text]) return { name: text, pos: null };

  let pos = null;
  const lastStart = text.lastIndexOf('(');
  const lastEnd = text.lastIndexOf(')');
  if (lastStart !== -1 && lastEnd !== -1 && lastStart < lastEnd) {
    const posRaw = text.substring(lastStart + 1, lastEnd).trim();
    if (POSITIONS.includes(posRaw)) {
      const candidate = text.substring(0, lastStart).trim();
      if (heroDict[candidate]) return { name: candidate, pos: posRaw };
    }
  }

  for (const p of POSITIONS) {
    if (text.includes(p)) {
      const candidate = text.replace(p, '').trim();
      if (heroDict[candidate]) return { name: candidate, pos: p };
      break;
    }
  }
  return { name: text, pos: null };
}

function resolveHeroName(rawName) {
  if (heroDict[rawName]) return { name: rawName, msg: '' };
  let best = null, bestScore = 0;
  const keys = Object.keys(heroDict);
  for (const k of keys) {
    const score = similarity(rawName, k);
    if (score > bestScore) { bestScore = score; best = k; }
  }
  if (bestScore > 0.5) {
    return { name: best, msg: `未找到“${rawName}”，您是指“${best}”吗？` };
  }
  return { name: null, msg: `找不到“${rawName}”` };
}

function similarity(s1, s2) {
  const len1 = s1.length, len2 = s2.length;
  if (len1 === 0) return len2 === 0 ? 1 : 0;
  if (len2 === 0) return 0;
  const dp = Array(len1+1).fill().map(()=>Array(len2+1).fill(0));
  for (let i=0; i<=len1; i++) dp[i][0] = i;
  for (let j=0; j<=len2; j++) dp[0][j] = j;
  for (let i=1; i<=len1; i++) {
    for (let j=1; j<=len2; j++) {
      const cost = s1[i-1] === s2[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  const maxLen = Math.max(len1, len2);
  return 1 - dp[len1][len2] / maxLen;
}

// ================= 数据加载 =================
async function loadData() {
  try {
    const [heroesRes, posRes, wrRes, anaRes, periodRes, globalRes] = await Promise.all([
      fetch('data/hero_list.json'),
      fetch('data/position_cache.json'),
      fetch('data/win_rate_cache.json'),
      fetch('data/hero_analysis_cache.json'),
      fetch('data/hero_period_cache.json'),
      fetch('data/global_win_rate_cache.json')
    ]);
    heroDict = await heroesRes.json();
    idToName = Object.fromEntries(Object.entries(heroDict).map(([k,v])=>[v,k]));
    posCache = await posRes.json();
    wrCache = await wrRes.json();
    anaCache = await anaRes.json();
    periodCache = await periodRes.json();
    globalWinRate = await globalRes.json();
    log('✅ 数据加载成功');
    return true;
  } catch (e) {
    log('❌ 数据加载失败，请刷新页面或检查网络');
    console.error(e);
    return false;
  }
}

// ================= 实时 fallback 获取缺失胜率 =================
async function fetchFallbackWinrate(heroName, heroPos) {
  const heroId = heroDict[heroName];
  const posNum = POSITION_TO_NUM[heroPos];
  if (!posNum) return null;

  const fallbackOpponents = [
    ["狂铁", "0"],
    ["沈梦溪", "1"],
    ["敖隐", "2"],
    ["裴擒虎", "3"],
    ["少司缘", "4"]
  ];

  for (const [oppName, oppPosNum] of fallbackOpponents) {
    if (oppName === heroName || !heroDict[oppName]) continue;
    const camp1 = { [posNum]: heroId };
    const camp2 = { [oppPosNum]: heroDict[oppName] };
    const params = new URLSearchParams({
      camp1Heroes: JSON.stringify(camp1),
      camp2Heroes: JSON.stringify(camp2),
      days: 30
    });
    try {
      const resp = await fetch(`${API_BASE}/match/find?${params.toString()}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const comps = data.heroComparisons || [];
      const target = comps.find(c => c.heroName === heroName);
      if (target && target.averageWinRate !== undefined) {
        let wr = parseFloat(target.averageWinRate);
        if (wr > 1) wr /= 100;
        wr = Math.max(0.01, Math.min(0.99, wr));
        return wr;
      }
    } catch (e) {
      console.warn('fallback fetch error', e);
      // 继续尝试下一个对手
    }
  }
  return null;
}

function getBaseWinrate(heroId, targetPosition, heroName) {
  const idStr = String(heroId);
  // 先检查会话覆盖
  if (sessionWrOverrides[idStr] && sessionWrOverrides[idStr][targetPosition] !== undefined) {
    return sessionWrOverrides[idStr][targetPosition];
  }
  // 检查缓存
  const wrMap = wrCache[idStr] || {};
  if (wrMap[targetPosition] !== undefined) {
    let wr = wrMap[targetPosition];
    if (wr > 1) wr /= 100;
    return Math.max(0.01, Math.min(0.99, wr));
  }
  // 缺失：返回 null 并触发异步填充
  return null;
}

async function ensureWinrate(heroId, heroName, targetPos) {
  const idStr = String(heroId);
  // 再次检查（可能已填充）
  const cached = getBaseWinrate(heroId, targetPos, heroName);
  if (cached !== null) return cached;

  log(`⚠️ 缺少 ${heroName} 在 ${targetPos} 的胜率，尝试实时获取...`);
  const fallbackWr = await fetchFallbackWinrate(heroName, targetPos);
  if (fallbackWr !== null) {
    if (!sessionWrOverrides[idStr]) sessionWrOverrides[idStr] = {};
    sessionWrOverrides[idStr][targetPos] = fallbackWr;
    log(`✅ 已获取 ${heroName} 在 ${targetPos} 的胜率：${(fallbackWr*100).toFixed(2)}%`);
    return fallbackWr;
  } else {
    // 手动输入
    const input = prompt(`无法获取 ${heroName} 在 ${targetPos} 的胜率。\n请手动输入胜率（0-100 或 0-1）：`);
    let wr = 0.5;
    if (input !== null && input.trim() !== '') {
      let val = parseFloat(input.trim().replace('%', ''));
      if (!isNaN(val)) {
        if (val > 1) val /= 100;
        wr = Math.max(0.01, Math.min(0.99, val));
      }
    }
    if (!sessionWrOverrides[idStr]) sessionWrOverrides[idStr] = {};
    sessionWrOverrides[idStr][targetPos] = wr;
    log(`📝 已手动设置 ${heroName} 在 ${targetPos} 的胜率为 ${(wr*100).toFixed(2)}%`);
    return wr;
  }
}

function getPeriodWinrate(heroId, periodKey) {
  const idStr = String(heroId);
  const periods = periodCache[idStr] || [];
  if (!periods.length) return 0.5;
  for (const p of periods) {
    const dr = p.durationRange || '';
    let wr = null;
    if (periodKey === 'early' && dr.includes('0-12')) wr = p.winRate;
    else if (periodKey === 'mid' && dr.includes('12-18')) wr = p.winRate;
    else if (periodKey === 'late' && dr.includes('18') && !dr.includes('12-18')) wr = p.winRate;
    if (wr !== null) {
      if (wr > 1) wr /= 100;
      return Math.max(0.01, Math.min(0.99, wr));
    }
  }
  return 0.5;
}

function getAnalysis(heroId) {
  const idStr = String(heroId);
  return anaCache[idStr] || { counters: [], counteredBy: [], goodSynergies: [], badSynergies: [] };
}

function computeHeroFeatures(heroName, heroPos, heroWr, team, enemyTeam) {
  const heroId = heroDict[heroName];
  const analysis = getAnalysis(heroId);
  const discount = Math.max(0, 1 - Math.abs(heroWr - 0.5) * 5.8843);

  const counters = {};
  analysis.counters.forEach(item => counters[item.heroName] = item.advantageIndex);
  const counteredBy = {};
  analysis.counteredBy.forEach(item => counteredBy[item.heroName] = item.advantageIndex);

  let posAdvList = [];
  let negAdvSum = 0;

  for (const [eName, ePos] of enemyTeam) {
    let adv = counters[eName] || counteredBy[eName] || 0;
    if (adv > 0) {
      if (ePos === heroPos) adv *= 1.0605;
      posAdvList.push(adv);
    } else if (adv < 0) {
      let R = adv / 100;
      let fR = R * (1 + Math.abs(R) * 7.8882);
      let penalized = fR * 100;
      if (ePos === heroPos) penalized *= 1.0605;
      negAdvSum += penalized;
    }
  }
  posAdvList.sort((a,b)=>b-a);
  let decayedPosAdv = 0;
  posAdvList.forEach((val, idx) => {
    if (idx === 0) decayedPosAdv += val * 1.0;
    else if (idx === 1) decayedPosAdv += val * 0.5649;
    else decayedPosAdv += val * 0.1178;
  });
  const finalCounterScore = decayedPosAdv + negAdvSum;

  const goodSyn = {};
  analysis.goodSynergies.forEach(item => goodSyn[item.heroName] = item.synergyIndex);
  const badSyn = {};
  analysis.badSynergies.forEach(item => badSyn[item.heroName] = item.synergyIndex);

  let discountedCombo = 0;
  for (const [tName] of team) {
    if (tName !== heroName) {
      const syn = goodSyn[tName] || badSyn[tName] || 0;
      discountedCombo += syn * discount;
    }
  }
  return [finalCounterScore, discountedCombo];
}

async function predictLineupWinrate(myTeam, enemyTeam, sideIsBlue, periodKey = null) {
  const W_base = 1.0267, W_hero = 1.1811, W_counter = 1.2668, W_combo = 1.3774;
  const S_base = getGlobalWinrateLog(sideIsBlue);

  let myLogits = [], enemyLogits = [];
  let totalCounterIndex = 0, totalComboIndex = 0;

  for (const [myName, myPos] of myTeam) {
    let wr;
    if (periodKey) {
      wr = getPeriodWinrate(heroDict[myName], periodKey);
    } else {
      wr = getBaseWinrate(heroDict[myName], myPos, myName);
      if (wr === null) {
        wr = await ensureWinrate(heroDict[myName], myName, myPos);
      }
    }
    myLogits.push(Math.log(wr / (1 - wr)));
    const [cScore, sScore] = computeHeroFeatures(myName, myPos, wr, myTeam, enemyTeam);
    totalCounterIndex += cScore;
    totalComboIndex += sScore;
  }
  for (const [eName, ePos] of enemyTeam) {
    let wr;
    if (periodKey) {
      wr = getPeriodWinrate(heroDict[eName], periodKey);
    } else {
      wr = getBaseWinrate(heroDict[eName], ePos, eName);
      if (wr === null) {
        wr = await ensureWinrate(heroDict[eName], eName, ePos);
      }
    }
    enemyLogits.push(Math.log(wr / (1 - wr)));
    const [cScore, sScore] = computeHeroFeatures(eName, ePos, wr, enemyTeam, myTeam);
    totalCounterIndex -= cScore;
    totalComboIndex -= sScore;
  }

  const S_counter = totalCounterIndex / 100;
  const S_combo = (totalComboIndex / 2) / 100;
  const avgMy = myLogits.reduce((a,b)=>a+b,0) / myLogits.length;
  const avgEnemy = enemyLogits.reduce((a,b)=>a+b,0) / enemyLogits.length;
  const S_hero = avgMy - avgEnemy;

  const S_total = W_base * S_base + W_hero * S_hero + W_counter * S_counter + W_combo * S_combo;
  return (1 / (1 + Math.exp(-S_total))) * 100;
}

function getGlobalWinrateLog(sideIsBlue) {
  const now = new Date();
  const offset = 8 * 60;
  const localTime = new Date(now.getTime() + offset * 60000);
  const dateStr = localTime.toISOString().slice(0,10);
  const cache = globalWinRate[dateStr];
  if (cache) {
    const blueRatio = cache.blue / 100;
    const redRatio = cache.red / 100;
    return sideIsBlue ? Math.log(blueRatio / redRatio) : -Math.log(blueRatio / redRatio);
  }
  return 0;
}

async function evaluateHeroContribution(heroName, heroPos, myTeam, enemyTeam) {
  const heroId = heroDict[heroName];
  let wr = getBaseWinrate(heroId, heroPos, heroName);
  if (wr === null) wr = await ensureWinrate(heroId, heroName, heroPos);
  const heroLogit = Math.log(wr / (1 - wr));

  const teamLogits = [];
  for (const [n,p] of myTeam) {
    let w = getBaseWinrate(heroDict[n], p, n);
    if (w === null) w = await ensureWinrate(heroDict[n], n, p);
    teamLogits.push(Math.log(w / (1 - w)));
  }
  const teamAvg = teamLogits.reduce((a,b)=>a+b,0) / teamLogits.length;
  const baseContrib = heroLogit - teamAvg;

  const [cScore, sScore] = computeHeroFeatures(heroName, heroPos, wr, myTeam, enemyTeam);
  const counterContrib = (cScore / 100) * 1.2668;
  const synergyContrib = ((sScore / 2) / 100) * 1.3774;

  const totalLogit = baseContrib + counterContrib + synergyContrib;
  const impactWr = (1 / (1 + Math.exp(-totalLogit)) - 0.5) * 100;
  return impactWr;
}

function evaluateSingleHeroDetails(heroName, heroPos, myTeam, enemyTeam) {
  const heroId = heroDict[heroName];
  const analysis = getAnalysis(heroId);
  const counters = {};
  analysis.counters.forEach(item => counters[item.heroName] = item.advantageIndex);
  const counteredBy = {};
  analysis.counteredBy.forEach(item => counteredBy[item.heroName] = item.advantageIndex);
  const goodSyn = {};
  analysis.goodSynergies.forEach(item => goodSyn[item.heroName] = item.synergyIndex);
  const badSyn = {};
  analysis.badSynergies.forEach(item => badSyn[item.heroName] = item.synergyIndex);

  const details = [];
  for (const [eName, ePos] of enemyTeam) {
    const adv = counters[eName] || counteredBy[eName] || 0;
    details.push({ type:'counter', target:eName, value:adv, isMatchup: heroPos === ePos });
  }
  for (const [tName] of myTeam) {
    if (tName === heroName) continue;
    const syn = goodSyn[tName] || badSyn[tName] || 0;
    if (Math.abs(syn) >= 1.5) {
      details.push({ type:'synergy', target:tName, value:syn, isMatchup:false });
    }
  }
  return details;
}

// ================= 推荐展示（字体调整） =================
function displayRecommendations(finalResults, availablePositions) {
  const recContent = document.getElementById('rec-content');
  let html = '';
  for (const pos of availablePositions) {
    const sorted = finalResults[pos].sort((a,b)=>b.score-a.score);
    if (!sorted.length) continue;
    let displayList = sorted.slice(0, 3);
    const mainCount = displayList.filter(item => isMainPosition(item.name, pos)).length;
    if (mainCount < 3) {
      for (const item of sorted.slice(3)) {
        if (mainCount >= 3) break;
        if (isMainPosition(item.name, pos)) {
          displayList.push(item);
          break;
        }
      }
    }
    html += `<div class="hero-group"><strong>${pos}</strong></div>`;
    for (const { score, name } of displayList) {
      const heroId = heroDict[name];
      const posData = posCache[heroId] || {};
      const posStr = Object.entries(posData).map(([p, rate]) => `${p} ${rate}%`).join(' / ');
      const verdict = getVerdict(score);
      // 主行加粗加大
      html += `<div class="hero-item"><span class="hero-item-main">${name} (${posStr}) [胜率:${score.toFixed(2)}%] [${verdict}]</span></div>`;
      // 细节行小字体灰黑
      const details = evaluateSingleHeroDetails(name, pos, myTeam, enemyTeam);
      for (const d of details) {
        if (d.type === 'counter') {
          const mark = d.value > 0 ? '克制' : (d.value < 0 ? '被克制' : '无克制');
          const tag = d.isMatchup ? ' (同分路)' : '';
          html += `<div class="hero-item-detail">  对位 ${d.target}: ${mark} 指数 ${formatAdvantage(d.value)}${tag}</div>`;
        } else if (d.type === 'synergy') {
          const mark = d.value > 0 ? '优异' : '冲突';
          html += `<div class="hero-item-detail">  配合 ${d.target}: ${mark} 指数 ${formatAdvantage(d.value)}</div>`;
        }
      }
    }
  }
  html += '<hr>';
  recContent.innerHTML = html;
}

// ================= BP 流程 =================
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();

  document.getElementById('start-btn').addEventListener('click', startBP);
  document.getElementById('submit-btn').addEventListener('click', submitPick);
  document.getElementById('hero-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submitPick();
  });
  // 重置按钮
  const resetBtn = document.createElement('button');
  resetBtn.textContent = '重置本轮';
  resetBtn.className = 'btn';
  resetBtn.style.background = '#757575';
  resetBtn.addEventListener('click', resetSession);
  document.getElementById('bp-area').appendChild(resetBtn);
});

function resetSession() {
  myTeam = [];
  enemyTeam = [];
  myPositions = [];
  pickedHeroes = new Set();
  currentStep = 0;
  document.getElementById('my-team').textContent = '无';
  document.getElementById('enemy-team').textContent = '无';
  document.getElementById('hero-input').value = '';
  document.getElementById('rec-content').innerHTML = '';
  document.getElementById('log-output').textContent = '';
  // 保留数据缓存，不刷新页面
  log('🔄 已重置，可重新开始 BP');
  // 显示设置界面
  document.getElementById('setup-card').style.display = 'block';
  document.getElementById('bp-area').style.display = 'none';
}

function startBP() {
  const sideSel = document.getElementById('side-select').value;
  sideIsBlue = (sideSel === 'blue');
  userPosition = document.getElementById('pos-select').value;
  if (!userPosition) {
    alert('请选择你的位置');
    return;
  }
  myTeam = [];
  enemyTeam = [];
  myPositions = [];
  pickedHeroes = new Set();
  currentStep = 0;

  if (sideIsBlue) {
    draftSequence = [['mine',1], ['enemy',2], ['mine',2], ['enemy',2], ['mine',2], ['enemy',1]];
  } else {
    draftSequence = [['enemy',1], ['mine',2], ['enemy',2], ['mine',2], ['enemy',2], ['mine',1]];
  }

  document.getElementById('setup-card').style.display = 'none';
  document.getElementById('bp-area').style.display = 'block';
  log(`✅ 开始 BP，阵营：${sideIsBlue ? '蓝方' : '红方'}，你的位置：${userPosition}`);
  updateUI();
}

function updateUI() {
  const statusEl = document.getElementById('status-text');
  const myTeamEl = document.getElementById('my-team');
  const enemyTeamEl = document.getElementById('enemy-team');

  myTeamEl.textContent = myTeam.map(([n,p]) => `${n}(${p})`).join(' ') || '无';
  enemyTeamEl.textContent = enemyTeam.map(([n,p]) => `${n}(${p})`).join(' ') || '无';

  if (currentStep >= draftSequence.length) {
    statusEl.textContent = 'BP 已结束，正在分析...';
    showFinalAnalysis();
    return;
  }
  const [turn, count] = draftSequence[currentStep];
  const sideStr = turn === 'mine' ? '我方' : '敌方';
  const index = turn === 'mine' ? myTeam.length + 1 : enemyTeam.length + 1;
  let prompt = `【${sideStr}】本轮需选第 ${index}`;
  if (count > 1) prompt += `、${index+1}`;
  prompt += ` 个英雄`;
  statusEl.textContent = prompt;
}

async function submitPick() {
  if (isCalculating) return;
  if (currentStep >= draftSequence.length) return;
  const [turn, count] = draftSequence[currentStep];
  const input = document.getElementById('hero-input').value.trim();
  if (!input) { alert('请输入英雄名称'); return; }

  const inputs = cleanText(input).split(',');
  if (inputs.length < count) {
    alert(`数量不足，需要 ${count} 个英雄`);
    return;
  }

  const picks = [];
  const currentPositions = [];
  for (let i = 0; i < count; i++) {
    let { name, pos } = parseHeroInput(inputs[i]);
    if (!heroDict[name]) {
      const resolved = resolveHeroName(name);
      if (resolved.name) {
        const confirm = window.confirm(resolved.msg + '\n是否使用？');
        if (!confirm) return;
        name = resolved.name;
      } else {
        alert(resolved.msg);
        return;
      }
    }
    if (pickedHeroes.has(name)) {
      alert(`${name} 已被选过！`);
      return;
    }
    if (!pos) {
      const heroId = heroDict[name];
      const positions = posCache[heroId] || {};
      const defaultPos = Object.keys(positions).sort((a,b)=>positions[b]-positions[a])[0];
      if (defaultPos) {
        const confirm = window.confirm(`识别 ${name} 为【${defaultPos}】，是否确认？`);
        if (confirm) pos = defaultPos;
      }
      if (!pos) {
        pos = prompt(`请输入 ${name} 的位置（${POSITIONS.join('/')}）`);
        if (!pos || !POSITIONS.includes(pos)) {
          alert('位置无效');
          return;
        }
      }
    }
    if (turn === 'mine' && (myPositions.includes(pos) || currentPositions.includes(pos))) {
      alert(`位置【${pos}】已被我方锁定！`);
      return;
    }
    currentPositions.push(pos);
    picks.push({ name, pos });
  }

  for (const { name, pos } of picks) {
    pickedHeroes.add(name);
    if (turn === 'mine') {
      myTeam.push([name, pos]);
      myPositions.push(pos);
    } else {
      enemyTeam.push([name, pos]);
    }
  }

  document.getElementById('hero-input').value = '';

  if (turn === 'enemy' && currentStep !== 0) {
    await showRecommendations();
  }

  currentStep++;
  updateUI();
}

// ================= 推荐功能 =================
async function showRecommendations() {
  const recCard = document.getElementById('rec-card');
  const recContent = document.getElementById('rec-content');
  recCard.style.display = 'block';
  recContent.innerHTML = '正在计算推荐...';
  isCalculating = true;

  const availablePositions = POSITIONS.filter(p => !myPositions.includes(p));
  if (availablePositions.length === 0) {
    recContent.innerHTML = '我方位置已满';
    isCalculating = false;
    return;
  }

  const candidates = {};
  availablePositions.forEach(p => candidates[p] = []);
  for (const [heroName, heroId] of Object.entries(heroDict)) {
    if (pickedHeroes.has(heroName)) continue;
    const posData = posCache[heroId] || {};
    for (const pos of availablePositions) {
      if (posData[pos] >= 10) {
        candidates[pos].push(heroName);
      }
    }
  }

  const finalResults = {};
  availablePositions.forEach(p => finalResults[p] = []);

  // 分批计算，避免阻塞
  const tasks = [];
  for (const pos of availablePositions) {
    for (const name of candidates[pos]) {
      tasks.push({ name, pos });
    }
  }

  for (let i = 0; i < tasks.length; i++) {
    const { name, pos } = tasks[i];
    const simTeam = myTeam.concat([[name, pos]]);
    const wr = await predictLineupWinrate(simTeam, enemyTeam, sideIsBlue);
    finalResults[pos].push({ score: wr, name });
  }

  displayRecommendations(finalResults, availablePositions);
  isCalculating = false;
}

// ================= 最终分析（含装备与强势期） =================
async function showFinalAnalysis() {
  isCalculating = true;
  try {
    // 整体预测
    const finalWr4d = await predictLineupWinrate(myTeam, enemyTeam, sideIsBlue);
    const periodLabels = { early:'前期(0-12min)', mid:'中期(12-18min)', late:'后期(18min+)' };
    const periodResults = {};
    for (const key of Object.keys(periodLabels)) {
      periodResults[key] = await predictLineupWinrate(myTeam, enemyTeam, sideIsBlue, key);
    }

    let analysis = '\n=== 最终胜率预测 ===\n';
    analysis += `【整体预测】我方阵容胜率：${finalWr4d.toFixed(2)}% | 敌方：${(100 - finalWr4d).toFixed(2)}%\n`;
    for (const [key, label] of Object.entries(periodLabels)) {
      const wr = periodResults[key];
      analysis += `【${label}】我方阵容胜率：${wr.toFixed(2)}% | 敌方：${(100 - wr).toFixed(2)}%\n`;
    }

    const earlyWr = periodResults.early, midWr = periodResults.mid, lateWr = periodResults.late;
    if (earlyWr > midWr && earlyWr > lateWr) analysis += '💡 分析：我方阵容前期强势，应尽量在前期建立优势。\n';
    else if (midWr > earlyWr && midWr > lateWr) analysis += '💡 分析：我方阵容中期发力，注意中期团战节奏。\n';
    else if (lateWr > earlyWr && lateWr > midWr) analysis += '💡 分析：我方阵容后期更强，注意拖发育避战。\n';
    else analysis += '⚖️ 分析：双方阵容各时期强度相对均衡。\n';

    analysis += '\n--- 我方阵容深度评估 ---\n';
    for (const pos of POSITIONS) {
      for (const [heroName, heroPos] of myTeam) {
        if (heroPos === pos) {
          const impact = await evaluateHeroContribution(heroName, heroPos, myTeam, enemyTeam);
          const impactVerdict = getContributionVerdict(impact);
          const sign = impact > 0 ? '+' : '';
          analysis += `\n【已选】${heroName} (位置: ${heroPos})\n`;
          analysis += `   📈 对总胜率影响: ${sign}${impact.toFixed(2)}% [${impactVerdict}]\n`;
          const details = evaluateSingleHeroDetails(heroName, heroPos, myTeam, enemyTeam);
          for (const d of details) {
            if (d.type === 'counter') {
              const mark = d.value > 0 ? '克制' : (d.value < 0 ? '被克制' : '无克制');
              const tag = d.isMatchup ? ' (同分路)' : '';
              analysis += `   对位 ${d.target}: ${mark} 指数 ${formatAdvantage(d.value)}${tag}\n`;
            } else if (d.type === 'synergy') {
              const mark = d.value > 0 ? '优异' : '冲突';
              analysis += `   配合 ${d.target}: ${mark} 指数 ${formatAdvantage(d.value)}\n`;
            }
          }
          break;
        }
      }
    }

    // 尝试获取用户英雄的装备推荐和强势期
    const userHero = myTeam.find(([n,p]) => p === userPosition);
    if (userHero) {
      const [uName, uPos] = userHero;
      analysis += `\n【出装推荐】${uName} (${uPos})\n`;
      try {
        const heroId = heroDict[uName];
        const posNum = POSITION_TO_NUM[uPos];
        const equipUrl = `${API_BASE}/hero/equip?date=${getDateStr()}&heroId=${heroId}&position=${posNum}`;
        const resp = await fetch(equipUrl);
        if (resp.ok) {
          const data = await resp.json();
          const equipList = data.equipmentWinRates || [];
          const filtered = equipList.filter(e => e.pickRate > 10).sort((a,b)=>b.pickRate-a.pickRate);
          if (filtered.length) {
            for (const e of filtered) {
              analysis += `${e.equipmentName} 登场率:${e.pickRate.toFixed(2)}% 胜率:${e.winRate.toFixed(2)}%\n`;
            }
          } else {
            analysis += '暂无出装数据\n';
          }
        } else {
          analysis += '获取出装失败（可能跨域限制）\n';
        }
      } catch (e) {
        analysis += '获取出装失败（可能跨域限制）\n';
      }

      analysis += `\n【强势期分析】${uName}\n`;
      try {
        const heroId = heroDict[uName];
        const periodUrl = `${API_BASE}/detail/specifyheroperiod?heroId=${heroId}`;
        const resp = await fetch(periodUrl);
        if (resp.ok) {
          const data = await resp.json();
          const periods = data.winRateByDuration || [];
          if (periods.length) {
            for (const item of periods) {
              analysis += `${item.durationRange}胜率：${item.winRate.toFixed(2)}%\n`;
            }
          } else {
            analysis += '暂无强势期数据\n';
          }
        } else {
          analysis += '获取强势期失败（可能跨域限制）\n';
        }
      } catch (e) {
        analysis += '获取强势期失败（可能跨域限制）\n';
      }
    }

    log(analysis);
    alert('BP 分析完成，请查看下方日志区域。');
  } catch (e) {
    console.error(e);
    log(`分析出错：${e}`);
    alert(`分析出错：${e}`);
  } finally {
    isCalculating = false;
  }
}

function getDateStr() {
  const now = new Date();
  const offset = 8 * 60;
  const localTime = new Date(now.getTime() + offset * 60000);
  return localTime.toISOString().slice(0,10);
}
