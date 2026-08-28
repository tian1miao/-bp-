// ================= 全局变量 =================
let heroDict = {};          // name -> id
let idToName = {};          // id -> name
let posCache = {};          // heroId -> {position: pickRate}
let wrCache = {};           // heroId -> {position: winRate}
let anaCache = {};          // heroId -> analysis object
let periodCache = {};       // heroId -> period winrates
let globalWinRate = {};     // date -> {blue, red}

const POSITION_MAP = {"0":"对抗路","1":"中路","2":"发育路","3":"打野","4":"辅助"};
const POSITIONS = Object.values(POSITION_MAP);
const POSITION_TO_NUM = Object.fromEntries(Object.entries(POSITION_MAP).map(([k,v])=>[v,k]));

let sideIsBlue = true;
let userPosition = "";
let myTeam = [];            // [{name, pos}]
let enemyTeam = [];
let myPositions = [];
let pickedHeroes = new Set();
let currentStep = 0;
let draftSequence = [];

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
  // 精确匹配
  if (heroDict[rawName]) return { name: rawName, msg: '' };
  // 模糊匹配（简单包含或编辑距离，这里简化：找一个相似度最高的）
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

// 简单相似度（莱文斯坦距离）
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
    // 假设数据文件在 data/ 目录下
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

// ================= 核心计算函数（与桌面版一致） =================
function getGlobalWinrateLog(sideIsBlue) {
  // 获取当天日期（与更新脚本保持一致，使用 UTC+8 的日期）
  const now = new Date();
  const offset = 8 * 60; // UTC+8
  const localTime = new Date(now.getTime() + offset * 60000);
  const dateStr = localTime.toISOString().slice(0,10);
  const cache = globalWinRate[dateStr];
  if (cache) {
    const blueRatio = cache.blue / 100;
    const redRatio = cache.red / 100;
    return sideIsBlue ? Math.log(blueRatio / redRatio) : -Math.log(blueRatio / redRatio);
  }
  // 无数据时返回0
  return 0;
}

function getHeroStats(heroId) {
  const idStr = String(heroId);
  return [posCache[idStr] || {}, wrCache[idStr] || {}];
}

function getBaseWinrate(heroId, targetPosition) {
  const idStr = String(heroId);
  const wrMap = wrCache[idStr] || {};
  if (wrMap[targetPosition] !== undefined) {
    let wr = wrMap[targetPosition];
    if (wr > 1) wr /= 100;
    return Math.max(0.01, Math.min(0.99, wr));
  }
  // 回退：使用默认0.5
  log(`⚠️ 缺少 ${idToName[heroId]} 在 ${targetPosition} 的胜率，使用50%`);
  return 0.5;
}

function getAnalysis(heroId) {
  const idStr = String(heroId);
  return anaCache[idStr] || { counters: [], counteredBy: [], goodSynergies: [], badSynergies: [] };
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

function predictLineupWinrate(myTeam, enemyTeam, sideIsBlue, periodKey = null) {
  const W_base = 1.0267, W_hero = 1.1811, W_counter = 1.2668, W_combo = 1.3774;
  const S_base = getGlobalWinrateLog(sideIsBlue);

  let myLogits = [], enemyLogits = [];
  let totalCounterIndex = 0, totalComboIndex = 0;

  for (const [myName, myPos] of myTeam) {
    let wr;
    if (periodKey) wr = getPeriodWinrate(heroDict[myName], periodKey);
    else wr = getBaseWinrate(heroDict[myName], myPos);
    myLogits.push(Math.log(wr / (1 - wr)));
    const [cScore, sScore] = computeHeroFeatures(myName, myPos, wr, myTeam, enemyTeam);
    totalCounterIndex += cScore;
    totalComboIndex += sScore;
  }
  for (const [eName, ePos] of enemyTeam) {
    let wr;
    if (periodKey) wr = getPeriodWinrate(heroDict[eName], periodKey);
    else wr = getBaseWinrate(heroDict[eName], ePos);
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

function evaluateHeroContribution(heroName, heroPos, myTeam, enemyTeam) {
  const heroId = heroDict[heroName];
  const wr = getBaseWinrate(heroId, heroPos);
  const heroLogit = Math.log(wr / (1 - wr));

  const teamLogits = myTeam.map(([n,p]) => {
    const w = getBaseWinrate(heroDict[n], p);
    return Math.log(w / (1 - w));
  });
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

// ================= BP 流程控制 =================
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();

  document.getElementById('start-btn').addEventListener('click', startBP);
  document.getElementById('submit-btn').addEventListener('click', submitPick);
  document.getElementById('hero-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submitPick();
  });
});

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

  // 添加英雄
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

  // 如果是敌方回合且不是第一步，触发推荐计算（异步）
  if (turn === 'enemy' && currentStep !== 0) {
    showRecommendations();
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

  // 计算可用位置
  const availablePositions = POSITIONS.filter(p => !myPositions.includes(p));
  if (availablePositions.length === 0) {
    recContent.innerHTML = '我方位置已满';
    return;
  }

  // 候选英雄：所有未选英雄，且在该位置有出场率
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

  // 计算每个候选英雄加入后的预测胜率
  const finalResults = {};
  availablePositions.forEach(p => finalResults[p] = []);

  // 使用异步分批计算，避免阻塞UI
  const tasks = [];
  for (const pos of availablePositions) {
    for (const name of candidates[pos]) {
      tasks.push({ name, pos });
    }
  }

  // 简化：直接同步计算（数据量可能大，但考虑到手机性能，使用 setTimeout 分批）
  const batchSize = 5;
  let index = 0;
  function processBatch() {
    const end = Math.min(index + batchSize, tasks.length);
    for (; index < end; index++) {
      const { name, pos } = tasks[index];
      const simTeam = myTeam.concat([[name, pos]]);
      const wr = predictLineupWinrate(simTeam, enemyTeam, sideIsBlue);
      finalResults[pos].push({ score: wr, name });
    }
    if (index < tasks.length) {
      setTimeout(processBatch, 0);
    } else {
      displayRecommendations(finalResults, availablePositions);
    }
  }
  processBatch();
}

function displayRecommendations(finalResults, availablePositions) {
  const recContent = document.getElementById('rec-content');
  let html = '';
  for (const pos of availablePositions) {
    const sorted = finalResults[pos].sort((a,b)=>b.score-a.score);
    if (!sorted.length) continue;
    let displayList = sorted.slice(0, 3);
    // 补充主位置英雄
    const mainCount = displayList.filter(item => isMainPosition(item.name, pos)).length;
    if (mainCount < 3) {
      for (const item of sorted.slice(3)) {
        if (mainCount >= 3) break;
        if (isMainPosition(item.name, pos)) {
          displayList.push(item);
          // 重新排序
          displayList.sort((a,b)=>b.score-a.score);
          // 可能超过3个，但保留全部，因为都是主位置
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
      html += `<div class="hero-item">${name} (${posStr}) [胜率:${score.toFixed(2)}%] [${verdict}]</div>`;
      // 显示细节
      const details = evaluateSingleHeroDetails(name, pos, myTeam, enemyTeam);
      for (const d of details) {
        if (d.type === 'counter') {
          const mark = d.value > 0 ? '克制' : (d.value < 0 ? '被克制' : '无克制');
          const tag = d.isMatchup ? ' (同分路)' : '';
          html += `<div class="detail">  对位 ${d.target}: ${mark} 指数 ${formatAdvantage(d.value)}${tag}</div>`;
        } else if (d.type === 'synergy') {
          const mark = d.value > 0 ? '优异' : '冲突';
          html += `<div class="detail">  配合 ${d.target}: ${mark} 指数 ${formatAdvantage(d.value)}</div>`;
        }
      }
    }
  }
  html += '<hr>';
  recContent.innerHTML = html;
}

// ================= 最终分析 =================
function showFinalAnalysis() {
  const finalWr4d = predictLineupWinrate(myTeam, enemyTeam, sideIsBlue);
  const periodLabels = { early:'前期(0-12min)', mid:'中期(12-18min)', late:'后期(18min+)' };
  const periodResults = {};
  for (const key of Object.keys(periodLabels)) {
    periodResults[key] = predictLineupWinrate(myTeam, enemyTeam, sideIsBlue, key);
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
        const impact = evaluateHeroContribution(heroName, heroPos, myTeam, enemyTeam);
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

  log(analysis);
  alert('BP 分析完成，请查看下方日志区域。');
}
