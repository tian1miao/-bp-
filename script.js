// ================= 全局变量 =================
let heroDict = {};
let idToName = {};
let posCache = {};
let wrCache = {};
let anaCache = {};
let periodCache = {};
let equipCache = {};      // 新增装备缓存
let sessionWrOverrides = {}; // 手动输入覆盖
let pairShrinkageK = null;

const POSITION_MAP = {"0":"对抗路","1":"中路","2":"发育路","3":"打野","4":"辅助"};
const POSITIONS = Object.values(POSITION_MAP);
const POSITION_TO_NUM = Object.fromEntries(Object.entries(POSITION_MAP).map(([k,v])=>[v,k]));

let userPosition = "";
let myTeam = [];
let enemyTeam = [];
let myPositions = [];
let pickedHeroes = new Set();
let isCalculating = false;
let draftRevision = 0;
let liveWinrateRequestId = 0;
let liveWinrateState = {
  value: null,
  note: '双方至少各选一名英雄后计算',
  busy: false,
  tone: 'idle'
};

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
    const [heroesRes, posRes, wrRes, anaRes, periodRes, equipRes] = await Promise.all([
      fetch('data/hero_list.json'),
      fetch('data/position_cache.json'),
      fetch('data/win_rate_cache.json'),
      fetch('data/hero_analysis_cache.json'),
      fetch('data/hero_period_cache.json'),
      fetch('data/equip_cache.json')
    ]);
    heroDict = await heroesRes.json();
    idToName = Object.fromEntries(Object.entries(heroDict).map(([k,v])=>[v,k]));
    posCache = await posRes.json();
    wrCache = await wrRes.json();
    anaCache = await anaRes.json();
    periodCache = await periodRes.json();
    equipCache = await equipRes.json();
    pairShrinkageK = null;
    const priorStrength = getPairShrinkageK();
    log(`✅ 数据加载成功（英雄对收缩先验强度 ${priorStrength.toFixed(1)} 场）`);
    return true;
  } catch (e) {
    log('❌ 数据加载失败，请刷新页面或检查网络');
    console.error(e);
    return false;
  }
}

// ================= 胜率获取（不实时请求） =================
function getBaseWinrate(heroId, targetPosition, heroName) {
  const idStr = String(heroId);
  // 会话覆盖
  if (sessionWrOverrides[idStr] && sessionWrOverrides[idStr][targetPosition] !== undefined) {
    return sessionWrOverrides[idStr][targetPosition];
  }
  // 缓存
  const wrMap = wrCache[idStr] || {};
  if (wrMap[targetPosition] !== undefined) {
    let wr = wrMap[targetPosition];
    if (wr > 1) wr /= 100;
    return Math.max(0.01, Math.min(0.99, wr));
  }
  return null; // 缺失
}

async function ensureWinrate(heroId, heroName, targetPos) {
  const idStr = String(heroId);
  const cached = getBaseWinrate(heroId, targetPos, heroName);
  if (cached !== null) return cached;

  log(`⚠️ 缺少 ${heroName} 在 ${targetPos} 的胜率，请手动输入`);
  const input = prompt(`请手动输入 ${heroName} 在 ${targetPos} 的胜率（0-100 或 0-1）：`);
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

function clampProbability(value) {
  return Math.max(0.01, Math.min(0.99, value));
}

function logit(value) {
  const p = clampProbability(value);
  return Math.log(p / (1 - p));
}

function sigmoid(value) {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function findPairEntry(entries, heroName) {
  return (entries || []).find(item => item.heroName === heroName) || null;
}

function estimatePairShrinkageK() {
  const observations = [];
  const addObservation = (value, totalMatches) => {
    const n = Number(totalMatches);
    const index = Number(value);
    if (Number.isFinite(n) && n > 0 && Number.isFinite(index)) {
      observations.push({ p: clampProbability(0.5 + index / 100), n });
    }
  };

  for (const analysis of Object.values(anaCache)) {
    // counteredBy 与 counters 完全镜像，只取一侧避免重复样本。
    (analysis.counters || []).forEach(item => addObservation(item.advantageIndex, item.totalMatches));
    (analysis.goodSynergies || []).forEach(item => addObservation(item.synergyIndex, item.totalMatches));
    (analysis.badSynergies || []).forEach(item => addObservation(item.synergyIndex, item.totalMatches));
  }

  if (observations.length < 2) return 0;

  const mean = observations.reduce((sum, item) => sum + item.p, 0) / observations.length;
  const observedVariance = observations.reduce((sum, item) => sum + (item.p - mean) ** 2, 0) / observations.length;
  const samplingVariance = observations.reduce((sum, item) => sum + item.p * (1 - item.p) / item.n, 0) / observations.length;
  const betweenPairVariance = observedVariance - samplingVariance;
  if (!(betweenPairVariance > 1e-12)) return 0;

  // Beta-Binomial 的共同先验：Var(p) = 0.25 / (k + 1)。
  return Math.max(0, 0.25 / betweenPairVariance - 1);
}

function getPairShrinkageK() {
  if (pairShrinkageK === null) {
    pairShrinkageK = estimatePairShrinkageK();
  }
  return pairShrinkageK;
}

function getPairEffectSampleWeight(totalMatches) {
  const n = Math.max(0, Number(totalMatches) || 0);
  const k = getPairShrinkageK();
  return n > 0 && k > 0 ? n / (n + k) : 1;
}

function indexToRelativeLogit(index, baseline) {
  const p = clampProbability(baseline);
  return logit(clampProbability(p + Number(index) / 100)) - logit(p);
}

function pairLogitToRelativeIndex(pairLogit, baseline) {
  const p = clampProbability(baseline);
  return (sigmoid(logit(p) + pairLogit) - p) * 100;
}

function getPredictionBaseline(heroName, heroPos, periodKey = null) {
  if (periodKey) return getPeriodWinrate(heroDict[heroName], periodKey);
  return getBaseWinrate(heroDict[heroName], heroPos, heroName) ?? 0.5;
}

function getCounterItem(heroName, enemyName) {
  const analysis = getAnalysis(heroDict[heroName]);
  return findPairEntry(analysis.counters, enemyName) || findPairEntry(analysis.counteredBy, enemyName);
}

function getSynergyItem(heroName, teammateName) {
  const analysis = getAnalysis(heroDict[heroName]);
  const direct = findPairEntry(analysis.goodSynergies, teammateName) || findPairEntry(analysis.badSynergies, teammateName);
  if (direct) return direct;

  const reverseAnalysis = getAnalysis(heroDict[teammateName]);
  return findPairEntry(reverseAnalysis.goodSynergies, heroName) || findPairEntry(reverseAnalysis.badSynergies, heroName);
}

function getCounterPairLogit(heroName, heroPos, enemyName, enemyPos, periodKey = null) {
  const item = getCounterItem(heroName, enemyName);
  if (!item) return 0;

  const index = Number(item.advantageIndex);
  const ownBaseline = getPredictionBaseline(heroName, heroPos, periodKey);
  const enemyBaseline = getPredictionBaseline(enemyName, enemyPos, periodKey);
  const ownDelta = indexToRelativeLogit(index, ownBaseline);
  const enemyDelta = indexToRelativeLogit(-index, enemyBaseline);
  return (ownDelta - enemyDelta) * 0.5 * getPairEffectSampleWeight(item.totalMatches);
}

function computeCounterLogit(heroName, heroPos, enemyTeam, periodKey = null) {
  let total = 0;
  for (const [enemyName, enemyPos] of enemyTeam) {
    total += getCounterPairLogit(heroName, heroPos, enemyName, enemyPos, periodKey);
  }
  return total;
}

function getSynergyPairLogit(heroName, heroPos, teammateName, teammatePos, periodKey = null) {
  const item = getSynergyItem(heroName, teammateName);
  if (!item) return 0;

  const index = Number(item.synergyIndex);
  const ownBaseline = getPredictionBaseline(heroName, heroPos, periodKey);
  const teammateBaseline = getPredictionBaseline(teammateName, teammatePos, periodKey);
  const ownDelta = indexToRelativeLogit(index, ownBaseline);
  const teammateDelta = indexToRelativeLogit(index, teammateBaseline);
  return (ownDelta + teammateDelta) * 0.5 * getPairEffectSampleWeight(item.totalMatches);
}

function computeSynergyLogitForHero(heroName, heroPos, team, periodKey = null) {
  let total = 0;
  for (const [teammateName, teammatePos] of team) {
    if (teammateName === heroName) continue;
    total += getSynergyPairLogit(heroName, heroPos, teammateName, teammatePos, periodKey);
  }
  return total;
}

function computeTeamCounterLogit(team, enemyTeam, periodKey = null) {
  return team.reduce(
    (sum, [heroName, heroPos]) => sum + computeCounterLogit(heroName, heroPos, enemyTeam, periodKey),
    0
  );
}

function computeTeamSynergyLogit(team, periodKey = null) {
  // 每个同队英雄对从两端各出现一次，各分配一半即等价于只计算一次。
  return team.reduce(
    (sum, [heroName, heroPos]) => sum + computeSynergyLogitForHero(heroName, heroPos, team, periodKey) * 0.5,
    0
  );
}

async function getHeroWinrate(heroName, heroPos, periodKey, allowPrompt = true) {
  if (periodKey) return getPeriodWinrate(heroDict[heroName], periodKey);
  let wr = getBaseWinrate(heroDict[heroName], heroPos, heroName);
  if (wr === null && allowPrompt) {
    wr = await ensureWinrate(heroDict[heroName], heroName, heroPos);
  }
  return wr;
}

async function calculateLineupLogit(myTeam, enemyTeam, periodKey = null, allowPrompt = true) {
  const myLogits = [];
  const enemyLogits = [];
  const availableMyTeam = [];
  const availableEnemyTeam = [];

  for (const [heroName, heroPos] of myTeam) {
    const wr = await getHeroWinrate(heroName, heroPos, periodKey, allowPrompt);
    if (wr === null) continue;
    availableMyTeam.push([heroName, heroPos]);
    myLogits.push(logit(wr));
  }
  for (const [heroName, heroPos] of enemyTeam) {
    const wr = await getHeroWinrate(heroName, heroPos, periodKey, allowPrompt);
    if (wr === null) continue;
    availableEnemyTeam.push([heroName, heroPos]);
    enemyLogits.push(logit(wr));
  }
  if (!myLogits.length || !enemyLogits.length) return null;

  const avgMy = myLogits.reduce((sum, value) => sum + value, 0) / myLogits.length;
  const avgEnemy = enemyLogits.reduce((sum, value) => sum + value, 0) / enemyLogits.length;
  const heroLogit = avgMy - avgEnemy;

  const counterLogit = computeTeamCounterLogit(availableMyTeam, availableEnemyTeam, periodKey);
  const mySynergyLogit = computeTeamSynergyLogit(availableMyTeam, periodKey);
  const enemySynergyLogit = computeTeamSynergyLogit(availableEnemyTeam, periodKey);
  const synergyLogit = mySynergyLogit - enemySynergyLogit;

  return heroLogit + counterLogit + synergyLogit;
}

async function predictLineupWinrate(myTeam, enemyTeam, periodKey = null, allowPrompt = true) {
  const lineupLogit = await calculateLineupLogit(myTeam, enemyTeam, periodKey, allowPrompt);
  return lineupLogit === null ? null : sigmoid(lineupLogit) * 100;
}

async function evaluateHeroContribution(heroName, heroPos, myTeam, enemyTeam) {
  const heroId = heroDict[heroName];
  let wr = getBaseWinrate(heroId, heroPos, heroName);
  if (wr === null) wr = await ensureWinrate(heroId, heroName, heroPos);
  const heroLogit = logit(wr);

  const teamLogits = [];
  for (const [n,p] of myTeam) {
    let w = getBaseWinrate(heroDict[n], p, n);
    if (w === null) w = await ensureWinrate(heroDict[n], n, p);
    teamLogits.push(logit(w));
  }
  const teamAvg = teamLogits.reduce((a,b)=>a+b,0) / teamLogits.length;
  const baseContrib = heroLogit - teamAvg;

  const counterContrib = computeCounterLogit(heroName, heroPos, enemyTeam);
  const synergyContrib = computeSynergyLogitForHero(heroName, heroPos, myTeam) * 0.5;

  const totalLogit = baseContrib + counterContrib + synergyContrib;
  const impactWr = (sigmoid(totalLogit) - 0.5) * 100;
  return impactWr;
}

function evaluateSingleHeroDetails(heroName, heroPos, myTeam, enemyTeam) {
  const details = [];
  for (const [eName, ePos] of enemyTeam) {
    const pairLogit = getCounterPairLogit(heroName, heroPos, eName, ePos);
    const baseline = getPredictionBaseline(heroName, heroPos);
    const value = pairLogitToRelativeIndex(pairLogit, baseline);
    details.push({ type:'counter', target:eName, value, isMatchup: heroPos === ePos });
  }
  for (const [tName, tPos] of myTeam) {
    if (tName === heroName) continue;
    const pairLogit = getSynergyPairLogit(heroName, heroPos, tName, tPos);
    const syn = pairLogitToRelativeIndex(pairLogit, getPredictionBaseline(heroName, heroPos));
    if (Math.abs(syn) >= 1.5) {
      details.push({ type:'synergy', target:tName, value:syn, isMatchup:false });
    }
  }
  return details;
}

// ================= 自由阵容选择界面 =================
let dataLoaded = false;
const heroOrderCache = {};

function getSlotInput(team, pos) {
  return document.querySelector(`.combo-input[data-team="${team}"][data-pos="${pos}"]`);
}

function getAllSlotInputs() {
  return Array.from(document.querySelectorAll('.combo-input'));
}

function buildTeamSlots(team, containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = POSITIONS.map((pos, index) => {
    const inputId = `${team}-hero-${index}`;
    const menuId = `${team}-menu-${index}`;
    return `
      <div class="hero-slot">
        <label for="${inputId}">${pos}</label>
        <div class="combobox">
          <input
            id="${inputId}"
            class="combo-input"
            type="text"
            data-team="${team}"
            data-pos="${pos}"
            data-last-valid=""
            placeholder="选择或输入英雄"
            autocomplete="off"
            aria-autocomplete="list"
            aria-controls="${menuId}"
            aria-expanded="false"
            disabled
          />
          <button class="combo-toggle" type="button" aria-label="展开${pos}英雄列表" aria-controls="${menuId}" aria-expanded="false" disabled>▾</button>
          <div class="combo-menu" id="${menuId}" role="listbox" hidden></div>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('.combo-input').forEach(input => {
    const menu = input.parentElement.querySelector('.combo-menu');
    const toggle = input.parentElement.querySelector('.combo-toggle');

    input.addEventListener('focus', () => openHeroMenu(input));
    input.addEventListener('input', () => openHeroMenu(input));
    input.addEventListener('change', () => commitHeroInput(input));
    input.addEventListener('blur', () => {
      setTimeout(() => closeHeroMenu(input), 120);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        openHeroMenu(input);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        commitHeroInput(input);
        closeHeroMenu(input);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeHeroMenu(input);
        input.blur();
      }
    });

    toggle.addEventListener('mousedown', event => event.preventDefault());
    toggle.addEventListener('click', () => {
      if (menu.hidden) {
        input.focus();
        openHeroMenu(input);
      } else {
        closeHeroMenu(input);
      }
    });

    // 点击选项时保留输入框焦点，避免先触发未完成的输入校验。
    menu.addEventListener('pointerdown', event => {
      if (event.target.closest('.combo-option')) event.preventDefault();
    });
  });
}

function setHeroControlsEnabled(enabled) {
  getAllSlotInputs().forEach(input => { input.disabled = !enabled; });
  document.querySelectorAll('.combo-toggle').forEach(button => { button.disabled = !enabled; });
}

function getHeroOrder(pos) {
  if (heroOrderCache[pos]) return heroOrderCache[pos];
  heroOrderCache[pos] = Object.entries(heroDict)
    .sort(([nameA, idA], [nameB, idB]) => {
      const rateA = Number((posCache[idA] || {})[pos] || 0);
      const rateB = Number((posCache[idB] || {})[pos] || 0);
      return rateB - rateA || nameA.localeCompare(nameB, 'zh-CN');
    })
    .map(([name]) => name);
  return heroOrderCache[pos];
}

function openHeroMenu(input) {
  if (!dataLoaded || input.disabled) return;
  closeAllHeroMenus(input);
  renderHeroMenu(input);
  const menu = input.parentElement.querySelector('.combo-menu');
  const toggle = input.parentElement.querySelector('.combo-toggle');
  menu.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-expanded', 'true');
}

function closeHeroMenu(input) {
  const menu = input.parentElement.querySelector('.combo-menu');
  const toggle = input.parentElement.querySelector('.combo-toggle');
  menu.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-expanded', 'false');
}

function closeAllHeroMenus(exceptInput = null) {
  getAllSlotInputs().forEach(input => {
    if (input !== exceptInput) closeHeroMenu(input);
  });
}

function renderHeroMenu(input) {
  const pos = input.dataset.pos;
  const menu = input.parentElement.querySelector('.combo-menu');
  const committedName = input.dataset.lastValid || '';
  const query = input.value.trim() === committedName ? '' : input.value.trim();
  const selectedElsewhere = new Set(
    getAllSlotInputs()
      .filter(other => other !== input)
      .map(other => other.dataset.lastValid || '')
      .filter(Boolean)
  );
  const names = getHeroOrder(pos).filter(name => !query || name.includes(query));

  menu.innerHTML = '';
  if (!names.length) {
    const empty = document.createElement('div');
    empty.className = 'combo-empty';
    empty.textContent = '没有匹配英雄，可按 Enter 尝试模糊识别';
    menu.appendChild(empty);
    return;
  }

  for (const name of names) {
    const heroId = heroDict[name];
    const posRate = (posCache[heroId] || {})[pos];
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'combo-option';
    option.dataset.heroName = name;
    option.setAttribute('role', 'option');
    if (name === committedName) option.classList.add('selected');

    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    const rateSpan = document.createElement('small');
    const alreadySelected = selectedElsewhere.has(name);
    rateSpan.textContent = alreadySelected
      ? '已选择'
      : (posRate !== undefined ? `${Number(posRate).toFixed(2)}%` : '非常规分路');
    rateSpan.title = posRate !== undefined ? `${name}在${pos}的出场率` : '';

    option.append(nameSpan, rateSpan);
    option.disabled = alreadySelected;
    option.addEventListener('click', () => selectHero(input, name));
    menu.appendChild(option);
  }
}

function revertHeroInput(input) {
  const previous = input.dataset.lastValid || '';
  input.value = previous;
  input.classList.toggle('has-value', Boolean(previous));
  closeHeroMenu(input);
}

function commitHeroInput(input) {
  const rawName = input.value.trim();
  const previous = input.dataset.lastValid || '';
  if (rawName === previous) {
    input.classList.toggle('has-value', Boolean(previous));
    return true;
  }

  if (!rawName) {
    input.value = '';
    input.dataset.lastValid = '';
    input.classList.remove('has-value');
    closeHeroMenu(input);
    handleDraftChange();
    return true;
  }

  let heroName = rawName;
  if (!heroDict[heroName]) {
    const resolved = resolveHeroName(rawName);
    if (!resolved.name) {
      alert(resolved.msg);
      revertHeroInput(input);
      return false;
    }
    if (!window.confirm(`${resolved.msg}\n是否使用？`)) {
      revertHeroInput(input);
      return false;
    }
    heroName = resolved.name;
  }

  const duplicate = getAllSlotInputs().some(other =>
    other !== input && (other.dataset.lastValid || other.value.trim()) === heroName
  );
  if (duplicate) {
    alert(`${heroName} 已被选择，不能重复使用！`);
    revertHeroInput(input);
    return false;
  }

  input.value = heroName;
  input.dataset.lastValid = heroName;
  input.classList.add('has-value');
  closeHeroMenu(input);
  handleDraftChange();
  return true;
}

function selectHero(input, heroName) {
  input.value = heroName;
  input.dataset.lastValid = heroName;
  input.classList.add('has-value');
  closeHeroMenu(input);
  handleDraftChange();
}

function syncTeamsFromSlots(showErrors = false) {
  const nextMyTeam = [];
  const nextEnemyTeam = [];
  const nextPicked = new Set();

  for (const team of ['mine', 'enemy']) {
    for (const pos of POSITIONS) {
      const input = getSlotInput(team, pos);
      const heroName = input.value.trim();
      if (!heroName) continue;
      if (!heroDict[heroName]) {
        if (showErrors) alert(`请先确认${team === 'mine' ? '我方' : '敌方'}${pos}的英雄名称。`);
        return false;
      }
      if (nextPicked.has(heroName)) {
        if (showErrors) alert(`${heroName} 被重复选择，请检查阵容。`);
        return false;
      }
      nextPicked.add(heroName);
      (team === 'mine' ? nextMyTeam : nextEnemyTeam).push([heroName, pos]);
    }
  }

  myTeam = nextMyTeam;
  enemyTeam = nextEnemyTeam;
  myPositions = myTeam.map(([, pos]) => pos);
  pickedHeroes = nextPicked;
  userPosition = document.getElementById('pos-select').value;
  return true;
}

function getDefaultStatus() {
  if (!dataLoaded) return '英雄数据加载失败，请刷新页面重试。';
  if (!myTeam.length && !enemyTeam.length) {
    return '请先选择“我的位置”，再从左右两侧选择英雄；每次选人后会自动更新当前胜率。';
  }
  if (myTeam.length === 5 && enemyTeam.length === 5) {
    return userPosition
      ? '双方阵容已完整，可以开始最终胜率与强势期分析。'
      : '双方阵容已完整，请选择“我的位置”后开始分析。';
  }
  if (myTeam.length && enemyTeam.length) {
    return `当前已选：我方 ${myTeam.length}/5，敌方 ${enemyTeam.length}/5。当前胜率会自动更新。`;
  }
  return `当前已选：我方 ${myTeam.length}/5，敌方 ${enemyTeam.length}/5。双方至少各选一名英雄后可计算胜率。`;
}

function getRecommendationTargetPosition() {
  if (!userPosition || myPositions.includes(userPosition)) return null;
  return userPosition;
}

function renderLiveWinrate() {
  const valueEl = document.getElementById('live-winrate-value');
  const noteEl = document.getElementById('live-winrate-note');
  if (!valueEl || !noteEl) return;

  valueEl.className = 'live-winrate-value';
  if (liveWinrateState.busy) {
    valueEl.textContent = '计算中';
    valueEl.classList.add('is-busy');
  } else {
    valueEl.textContent = liveWinrateState.value === null ? '--' : `${liveWinrateState.value.toFixed(2)}%`;
    if (liveWinrateState.tone === 'positive') valueEl.classList.add('is-positive');
    if (liveWinrateState.tone === 'negative') valueEl.classList.add('is-negative');
  }
  noteEl.textContent = liveWinrateState.note;
}

function createLiveMatchupChip(detail) {
  const chip = document.createElement('span');
  chip.className = 'live-matchup-chip';
  if (detail.value > 0.01) chip.classList.add('positive');
  if (detail.value < -0.01) chip.classList.add('negative');

  const target = document.createElement('strong');
  target.textContent = detail.target;
  const relation = document.createElement('span');
  if (detail.type === 'counter') {
    const label = detail.value > 0.01 ? '克制' : (detail.value < -0.01 ? '被克制' : '无克制');
    relation.textContent = `${label} ${formatAdvantage(detail.value)}`;
  } else {
    const label = detail.value > 0.01 ? '协同' : '冲突';
    relation.textContent = `${label} ${formatAdvantage(detail.value)}`;
  }
  chip.append(target, relation);
  if (detail.isMatchup) {
    const tag = document.createElement('em');
    tag.textContent = '同分路';
    chip.appendChild(tag);
  }
  return chip;
}

function createLiveMatchupGroup(title, details, emptyText) {
  const group = document.createElement('div');
  group.className = 'live-matchup-group';
  const heading = document.createElement('span');
  heading.className = 'live-matchup-group-title';
  heading.textContent = title;
  const items = document.createElement('div');
  items.className = 'live-matchup-items';

  if (!details.length) {
    const empty = document.createElement('span');
    empty.className = 'live-matchup-empty';
    empty.textContent = emptyText;
    items.appendChild(empty);
  } else {
    details.forEach(detail => items.appendChild(createLiveMatchupChip(detail)));
  }
  group.append(heading, items);
  return group;
}

function renderLiveMatchups() {
  const section = document.getElementById('live-matchups');
  const list = document.getElementById('live-matchup-list');
  const label = document.getElementById('live-hero-label');
  if (!section || !list || !label) return;

  const userHero = userPosition ? myTeam.find(([, pos]) => pos === userPosition) : null;
  if (!dataLoaded || !userHero || !enemyTeam.length) {
    section.hidden = true;
    list.innerHTML = '';
    return;
  }

  const [heroName, heroPos] = userHero;
  const details = evaluateSingleHeroDetails(heroName, heroPos, myTeam, enemyTeam);
  const counters = details.filter(detail => detail.type === 'counter');
  const synergies = details.filter(detail => detail.type === 'synergy');
  label.textContent = `${heroName} · ${heroPos}`;
  list.innerHTML = '';
  list.append(
    createLiveMatchupGroup('对位敌方', counters, '暂无敌方对位数据'),
    createLiveMatchupGroup('同队协同', synergies, '暂无显著协同')
  );
  section.hidden = false;
}

function setLiveWinrateState(value, note, tone = 'idle', busy = false) {
  liveWinrateState = { value, note, tone, busy };
  renderLiveWinrate();
}

async function updateCurrentWinrate() {
  const requestId = ++liveWinrateRequestId;

  if (!dataLoaded) {
    setLiveWinrateState(null, '英雄数据尚未加载', 'idle');
    return;
  }
  if (!myTeam.length || !enemyTeam.length) {
    const note = !myTeam.length && !enemyTeam.length
      ? '双方至少各选一名英雄后计算'
      : `等待补齐${myTeam.length ? '敌方' : '我方'}阵容`;
    setLiveWinrateState(null, note, 'idle');
    return;
  }

  setLiveWinrateState(null, `正在计算当前 ${myTeam.length}v${enemyTeam.length} 阵容`, 'idle', true);
  try {
    const score = await predictLineupWinrate(myTeam, enemyTeam, null, false);
    if (requestId !== liveWinrateRequestId) return;
    if (score === null) {
      setLiveWinrateState(null, '双方已选英雄中暂无可用分路胜率数据', 'idle');
      return;
    }
    const tone = score > 50.5 ? 'positive' : (score < 49.5 ? 'negative' : 'idle');
    setLiveWinrateState(
      score,
      `我方胜率 · 敌方 ${(100 - score).toFixed(2)}% · 按已选 ${myTeam.length}v${enemyTeam.length} 阵容计算`,
      tone
    );
  } catch (error) {
    if (requestId !== liveWinrateRequestId) return;
    console.error(error);
    setLiveWinrateState(null, '当前胜率计算失败，请调整阵容后重试', 'idle');
  }
}

function refreshUI(statusMessage = null) {
  document.getElementById('my-count').textContent = `${myTeam.length} / 5`;
  document.getElementById('enemy-count').textContent = `${enemyTeam.length} / 5`;
  document.getElementById('status-text').textContent = statusMessage || getDefaultStatus();
  renderLiveWinrate();
  renderLiveMatchups();

  const recommendBtn = document.getElementById('recommend-btn');
  const analyzeBtn = document.getElementById('analyze-btn');
  const recommendationTarget = getRecommendationTargetPosition();
  recommendBtn.disabled = !dataLoaded || isCalculating || !myTeam.length || !enemyTeam.length || !recommendationTarget;
  recommendBtn.title = !userPosition
    ? '请先选择“我的位置”'
    : (myPositions.includes(userPosition) ? '指定位置已有英雄' : `推荐${userPosition}英雄`);
  analyzeBtn.disabled = !dataLoaded || isCalculating || myTeam.length !== 5 || enemyTeam.length !== 5 || !userPosition;
}

function handleDraftChange() {
  draftRevision++;
  syncTeamsFromSlots(false);
  document.getElementById('rec-card').hidden = true;
  document.getElementById('rec-content').innerHTML = '';
  refreshUI('阵容已更新，正在重新计算当前胜率…');
  void updateCurrentWinrate();
}

function resetSession() {
  closeAllHeroMenus();
  getAllSlotInputs().forEach(input => {
    input.value = '';
    input.dataset.lastValid = '';
    input.classList.remove('has-value');
  });
  myTeam = [];
  enemyTeam = [];
  myPositions = [];
  pickedHeroes = new Set();
  document.getElementById('rec-card').hidden = true;
  document.getElementById('rec-content').innerHTML = '';
  document.getElementById('log-output').textContent = '';
  draftRevision++;
  log('🔄 已清空双方阵容，位置设置保持不变。');
  setLiveWinrateState(null, '双方至少各选一名英雄后计算', 'idle');
  refreshUI('已清空阵容，可以重新自由选择双方英雄。');
}

// ================= 推荐展示 =================
function displayRecommendations(finalResults, availablePositions) {
  const recContent = document.getElementById('rec-content');
  recContent.innerHTML = '';

  for (const pos of availablePositions) {
    const sorted = finalResults[pos].sort((a, b) => b.score - a.score);
    if (!sorted.length) continue;
    const displayList = sorted.slice(0, 3);
    const mainCount = displayList.filter(item => isMainPosition(item.name, pos)).length;
    if (mainCount < 3) {
      for (const item of sorted.slice(3)) {
        if (isMainPosition(item.name, pos)) {
          displayList.push(item);
          break;
        }
      }
    }

    const group = document.createElement('div');
    group.className = 'hero-group';
    group.textContent = pos;
    recContent.appendChild(group);

    for (const { score, name } of displayList) {
      const heroId = heroDict[name];
      const posData = posCache[heroId] || {};
      const posStr = Object.entries(posData).map(([p, rate]) => `${p} ${rate}%`).join(' / ');
      const item = document.createElement('div');
      item.className = 'hero-item';

      const mainRow = document.createElement('div');
      mainRow.className = 'rec-main-row';
      const main = document.createElement('span');
      main.className = 'hero-item-main';
      main.textContent = `${name} · 阵容胜率 ${score.toFixed(2)}% · ${getVerdict(score)}`;
      main.title = posStr;
      const fillButton = document.createElement('button');
      fillButton.type = 'button';
      fillButton.className = 'rec-fill';
      fillButton.textContent = '填入我方';
      fillButton.addEventListener('click', () => {
        const input = getSlotInput('mine', pos);
        if (!input || input.value || pickedHeroes.has(name)) return;
        selectHero(input, name);
        log(`📝 已将推荐英雄 ${name} 填入我方${pos}。`);
      });
      mainRow.append(main, fillButton);
      item.appendChild(mainRow);

      const details = evaluateSingleHeroDetails(name, pos, myTeam, enemyTeam);
      for (const detail of details) {
        const detailEl = document.createElement('div');
        detailEl.className = 'hero-item-detail';
        if (detail.type === 'counter') {
          const mark = detail.value > 0 ? '克制' : (detail.value < 0 ? '被克制' : '无克制');
          const tag = detail.isMatchup ? '（同分路）' : '';
          detailEl.textContent = `对位 ${detail.target}：${mark}指数 ${formatAdvantage(detail.value)}${tag}`;
        } else {
          const mark = detail.value > 0 ? '配合优异' : '配合冲突';
          detailEl.textContent = `配合 ${detail.target}：${mark} ${formatAdvantage(detail.value)}`;
        }
        item.appendChild(detailEl);
      }
      recContent.appendChild(item);
    }
  }
}

// ================= 推荐与分析 =================
async function showRecommendations() {
  if (isCalculating || !dataLoaded || !syncTeamsFromSlots(true)) return;
  if (!userPosition) {
    alert('请先在“位置 / 推荐分路”中选择要推荐的位置。');
    return;
  }
  const targetPosition = getRecommendationTargetPosition();
  if (!targetPosition) {
    alert(`我方${userPosition}已经有英雄，请清空该位置或选择其他位置后再推荐。`);
    return;
  }
  if (!myTeam.length || !enemyTeam.length) {
    alert('双方至少各选一名英雄后才能获取推荐。');
    return;
  }

  const recCard = document.getElementById('rec-card');
  const recContent = document.getElementById('rec-content');
  const recSubtitle = document.getElementById('rec-subtitle');
  recCard.hidden = false;
  recSubtitle.textContent = `仅计算${targetPosition}候选英雄`;
  recContent.textContent = '正在计算推荐...';
  isCalculating = true;
  const revision = draftRevision;
  let resultStatus = `已更新${targetPosition}推荐；阵容变化后会自动清除。`;
  refreshUI(`正在计算我方${targetPosition}的下一手推荐...`);

  try {
    const availablePositions = [targetPosition];
    const candidates = [];
    const finalResults = { [targetPosition]: [] };
    for (const [heroName, heroId] of Object.entries(heroDict)) {
      if (pickedHeroes.has(heroName)) continue;
      const posData = posCache[heroId] || {};
      if (posData[targetPosition] >= 10) candidates.push(heroName);
    }

    for (const name of candidates) {
      if (revision !== draftRevision) {
        resultStatus = '阵容或推荐位置已变化，本次推荐已取消。';
        return;
      }
      const simTeam = myTeam.concat([[name, targetPosition]]);
      const score = await predictLineupWinrate(simTeam, enemyTeam);
      finalResults[targetPosition].push({ score, name });
    }

    if (revision !== draftRevision) {
      resultStatus = '阵容或推荐位置已变化，本次推荐已取消。';
      return;
    }
    if (!candidates.length) {
      recContent.textContent = `${targetPosition}暂无可用候选英雄。`;
      resultStatus = `${targetPosition}没有可推荐的英雄。`;
      return;
    }

    displayRecommendations(finalResults, availablePositions);
    resultStatus = `已按指定位置更新${targetPosition}推荐；可以直接填入我方。`;
  } catch (error) {
    console.error(error);
    recContent.textContent = `推荐计算出错：${error}`;
    log(`推荐计算出错：${error}`);
    resultStatus = '推荐计算失败，请调整阵容后重试。';
  } finally {
    isCalculating = false;
    refreshUI(resultStatus);
  }
}

async function runFinalAnalysis() {
  if (isCalculating || !dataLoaded || !syncTeamsFromSlots(true)) return;
  if (!userPosition) {
    alert('请先选择你的位置。');
    return;
  }
  if (myTeam.length !== 5 || enemyTeam.length !== 5) {
    alert('请先补齐我方和敌方各五名英雄。');
    return;
  }

  closeAllHeroMenus();
  document.getElementById('log-output').textContent = '';
  refreshUI('正在分析双方完整阵容...');
  await showFinalAnalysis();
  refreshUI('分析完成，结果已输出到下方日志区域。');
}

document.addEventListener('DOMContentLoaded', async () => {
  buildTeamSlots('mine', 'my-team-slots');
  buildTeamSlots('enemy', 'enemy-team-slots');
  syncTeamsFromSlots(false);
  refreshUI('正在加载英雄数据...');

  document.getElementById('pos-select').addEventListener('change', () => {
    userPosition = document.getElementById('pos-select').value;
    draftRevision++;
    document.getElementById('rec-card').hidden = true;
    document.getElementById('rec-content').innerHTML = '';
    refreshUI();
  });
  document.getElementById('recommend-btn').addEventListener('click', showRecommendations);
  document.getElementById('analyze-btn').addEventListener('click', runFinalAnalysis);
  document.getElementById('reset-btn').addEventListener('click', resetSession);
  document.addEventListener('click', event => {
    if (!event.target.closest('.combobox')) closeAllHeroMenus();
  });

  dataLoaded = await loadData();
  setHeroControlsEnabled(dataLoaded);
  refreshUI(dataLoaded ? null : '英雄数据加载失败，请刷新页面重试。');
  void updateCurrentWinrate();
});

async function showFinalAnalysis() {
  isCalculating = true;
  refreshUI('正在分析双方完整阵容...');
  try {
    const finalWr4d = await predictLineupWinrate(myTeam, enemyTeam);
    const periodLabels = { early:'前期(0-12min)', mid:'中期(12-18min)', late:'后期(18min+)' };
    const periodResults = {};
    for (const key of Object.keys(periodLabels)) {
      periodResults[key] = await predictLineupWinrate(myTeam, enemyTeam, key);
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

    // 出装推荐（从缓存读取）
    const userHero = myTeam.find(([n,p]) => p === userPosition);
    if (userHero) {
      const [uName, uPos] = userHero;
      analysis += `\n【出装推荐】${uName} (${uPos})\n`;
      const heroId = heroDict[uName];
      const idStr = String(heroId);
      const equipList = (equipCache[idStr] || {})[uPos];
      if (equipList && equipList.length) {
        for (const e of equipList) {
          analysis += `${e.equipmentName} 登场率:${e.pickRate.toFixed(2)}% 胜率:${e.winRate.toFixed(2)}%\n`;
        }
      } else {
        analysis += '暂无出装数据\n';
      }

      // 强势期分析（从缓存读取）
      analysis += `\n【强势期分析】${uName}\n`;
      const periods = periodCache[idStr] || [];
      if (periods.length) {
        for (const item of periods) {
          analysis += `${item.durationRange}胜率：${item.winRate.toFixed(2)}%\n`;
        }
      } else {
        analysis += '暂无强势期数据\n';
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
    refreshUI();
  }
}
