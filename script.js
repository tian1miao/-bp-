// ================= 全局变量 =================
let heroDict = {};
let idToName = {};
let posCache = {};
let wrCache = {};
let anaCache = {};
let periodCache = {};
let globalWinRate = {};
let equipCache = {};      // 新增装备缓存
let sessionWrOverrides = {}; // 手动输入覆盖

const POSITION_MAP = {"0":"对抗路","1":"中路","2":"发育路","3":"打野","4":"辅助"};
const POSITIONS = Object.values(POSITION_MAP);
const POSITION_TO_NUM = Object.fromEntries(Object.entries(POSITION_MAP).map(([k,v])=>[v,k]));

let sideIsBlue = true;
let userPosition = "";
let myTeam = [];
let enemyTeam = [];
let myPositions = [];
let pickedHeroes = new Set();
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
    const [heroesRes, posRes, wrRes, anaRes, periodRes, globalRes, equipRes] = await Promise.all([
      fetch('data/hero_list.json'),
      fetch('data/position_cache.json'),
      fetch('data/win_rate_cache.json'),
      fetch('data/hero_analysis_cache.json'),
      fetch('data/hero_period_cache.json'),
      fetch('data/global_win_rate_cache.json'),
      fetch('data/equip_cache.json')
    ]);
    heroDict = await heroesRes.json();
    idToName = Object.fromEntries(Object.entries(heroDict).map(([k,v])=>[v,k]));
    posCache = await posRes.json();
    wrCache = await wrRes.json();
    anaCache = await anaRes.json();
    periodCache = await periodRes.json();
    globalWinRate = await globalRes.json();
    equipCache = await equipRes.json();
    log('✅ 数据加载成功');
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
      if (wr === null) wr = await ensureWinrate(heroDict[myName], myName, myPos);
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
      if (wr === null) wr = await ensureWinrate(heroDict[eName], eName, ePos);
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
  sideIsBlue = document.getElementById('side-select').value === 'blue';
  userPosition = document.getElementById('pos-select').value;
  return true;
}

function getDefaultStatus() {
  if (!dataLoaded) return '英雄数据加载失败，请刷新页面重试。';
  if (!myTeam.length && !enemyTeam.length) return '请直接在左右两侧选择英雄，无需按照选人顺序填写。';
  if (myTeam.length === 5 && enemyTeam.length === 5) {
    return userPosition
      ? '双方阵容已完整，可以开始最终胜率与强势期分析。'
      : '双方阵容已完整，请选择“我的位置”后开始分析。';
  }
  if (myTeam.length && enemyTeam.length) {
    return `当前已选：我方 ${myTeam.length}/5，敌方 ${enemyTeam.length}/5。可继续调整或获取推荐。`;
  }
  return `当前已选：我方 ${myTeam.length}/5，敌方 ${enemyTeam.length}/5。双方至少各选一名英雄后可获取推荐。`;
}

function refreshUI(statusMessage = null) {
  document.getElementById('my-count').textContent = `${myTeam.length} / 5`;
  document.getElementById('enemy-count').textContent = `${enemyTeam.length} / 5`;
  document.getElementById('status-text').textContent = statusMessage || getDefaultStatus();

  const recommendBtn = document.getElementById('recommend-btn');
  const analyzeBtn = document.getElementById('analyze-btn');
  recommendBtn.disabled = !dataLoaded || isCalculating || !myTeam.length || !enemyTeam.length || myTeam.length >= 5;
  analyzeBtn.disabled = !dataLoaded || isCalculating || myTeam.length !== 5 || enemyTeam.length !== 5 || !userPosition;
}

function handleDraftChange() {
  syncTeamsFromSlots(false);
  document.getElementById('rec-card').hidden = true;
  document.getElementById('rec-content').innerHTML = '';
  refreshUI();
}

function updateSideLabels() {
  const blue = document.getElementById('side-select').value === 'blue';
  document.getElementById('my-side-label').textContent = blue ? '蓝方' : '红方';
  document.getElementById('enemy-side-label').textContent = blue ? '红方' : '蓝方';
  document.getElementById('my-panel').classList.toggle('red-side', !blue);
  document.getElementById('enemy-panel').classList.toggle('blue-side', blue);
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
  log('🔄 已清空双方阵容，阵营和位置设置保持不变。');
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
  if (!myTeam.length || !enemyTeam.length) {
    alert('双方至少各选一名英雄后才能获取推荐。');
    return;
  }

  const recCard = document.getElementById('rec-card');
  const recContent = document.getElementById('rec-content');
  recCard.hidden = false;
  recContent.textContent = '正在计算推荐...';
  isCalculating = true;
  let resultStatus = '推荐已更新；阵容有任何变化后，可重新获取推荐。';
  refreshUI('正在根据当前双方阵容计算推荐...');

  try {
    const availablePositions = POSITIONS.filter(pos => !myPositions.includes(pos));
    if (!availablePositions.length) {
      recContent.textContent = '我方五个位置已满，可以直接进行完整阵容分析。';
      resultStatus = '我方五个位置已满，可以直接进行完整阵容分析。';
      return;
    }

    const candidates = {};
    const finalResults = {};
    availablePositions.forEach(pos => {
      candidates[pos] = [];
      finalResults[pos] = [];
    });

    for (const [heroName, heroId] of Object.entries(heroDict)) {
      if (pickedHeroes.has(heroName)) continue;
      const posData = posCache[heroId] || {};
      for (const pos of availablePositions) {
        if (posData[pos] >= 10) candidates[pos].push(heroName);
      }
    }

    for (const pos of availablePositions) {
      for (const name of candidates[pos]) {
        const simTeam = myTeam.concat([[name, pos]]);
        const score = await predictLineupWinrate(simTeam, enemyTeam, sideIsBlue);
        finalResults[pos].push({ score, name });
      }
    }

    displayRecommendations(finalResults, availablePositions);
    resultStatus = '推荐已更新；可以直接填入推荐英雄，也可以继续手动调整阵容。';
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
  updateSideLabels();
  syncTeamsFromSlots(false);
  refreshUI('正在加载英雄数据...');

  document.getElementById('side-select').addEventListener('change', () => {
    sideIsBlue = document.getElementById('side-select').value === 'blue';
    updateSideLabels();
    document.getElementById('rec-card').hidden = true;
    refreshUI();
  });
  document.getElementById('pos-select').addEventListener('change', () => {
    userPosition = document.getElementById('pos-select').value;
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
});

async function showFinalAnalysis() {
  isCalculating = true;
  refreshUI('正在分析双方完整阵容...');
  try {
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
