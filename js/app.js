// ═══════════════════════════════════════════
// GLOBAL STATE & FIREBASE CONFIGURATION
// ═══════════════════════════════════════════
let FB_BASE = 'https://greenhouse-monitor-e40fa-default-rtdb.asia-southeast1.firebasedatabase.app';
let FB_PATH = '/';
let REFRESH_RATE = 3000;
let refreshTimer = null;
let historyTimer = null;
let rawDB = null;
let chartMode = 'temperature';
let fbApp = null;
let fbDb = null;
let fbListenerRef = null;

// Firebase SDK Config (from user's Firebase project)
const firebaseConfig = {
  apiKey: "AIzaSyDu-3H9SEWa1j_abFKQ26UJ4s0nhwA4_P0",
  authDomain: "greenhouse-monitor-e40fa.firebaseapp.com",
  databaseURL: "https://greenhouse-monitor-e40fa-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "greenhouse-monitor-e40fa",
  storageBucket: "greenhouse-monitor-e40fa.firebasestorage.app",
  messagingSenderId: "704436732093",
  appId: "1:704436732093:web:ba88bb34045561c2f937d4",
  measurementId: "G-VWQ3QJ96W0"
};

// Live telemetry state — all null initially (shows "—" until Firebase data arrives)
let liveData = {
  temperature: null,
  humidity: null,
  co2: null,
  smoke: null,
  ldr: null,
  fanStatus: null,
  pumpStatus: null,
  windowStatus: null,
  lightStatus: null,
  soil1: null,
  soil2: null,
  soil3: null,
  soil4: null,
  soil5: null,
  soil6: null,
  npk_n: null,
  npk_p: null,
  npk_k: null,
  lastUpdated: null,
  timestamp: null
};

// 5-Minute History records buffer
let historyRecords = [];
const timeLabels = [];
const historyBuffers = { temperature:[], humidity:[], co2:[], smoke:[], ldr:[], npk_n:[], npk_p:[], npk_k:[] };

// Alert & Log Stores
let alerts = [];
let alertUnread = 0;
let ctrlLog = [];
let plants = [];
let charts = {};
let currentUser = null;
let editingUserId = null;
const AUTH_STORAGE_KEY = 'greenhouse-auth-users';
const SESSION_STORAGE_KEY = 'greenhouse-auth-session';

function getUsers() {
  try {
    const data = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!data) {
      const defaultAdmin = { id: 1, username: 'admin', password: 'admin', role: 'admin', fullName: 'System Administrator', email: 'admin@greenhouse.com', phone: '', location: 'Main Office', status: 'active' };
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify([defaultAdmin]));
      return [defaultAdmin];
    }
    const parsed = JSON.parse(data);
    if (!parsed.some(u => u.username === 'admin')) {
      parsed.unshift({ id: 1, username: 'admin', password: 'admin', role: 'admin', fullName: 'System Administrator', email: 'admin@greenhouse.com', phone: '', location: 'Main Office', status: 'active' });
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(parsed));
    }
    return parsed;
  } catch (e) {
    return [];
  }
}

function saveUsers(users) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(users));
}

function setCurrentUser(user) {
  currentUser = user;
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(user));
  updateAuthUI();
}

function clearSession() {
  currentUser = null;
  localStorage.removeItem(SESSION_STORAGE_KEY);
  updateAuthUI();
}

function restoreSession() {
  try {
    const saved = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!saved) return;
    const parsed = JSON.parse(saved);
    const users = getUsers();
    const found = users.find(u => u.username === parsed.username && u.password === parsed.password);
    if (found) {
      currentUser = found;
      updateAuthUI();
    } else {
      clearSession();
    }
  } catch (e) {
    clearSession();
  }
}

function showAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(btn => btn.classList.toggle('active', btn.textContent.includes(tab === 'login' ? 'Login' : 'Register')));
  document.getElementById('login-form').classList.toggle('active', tab === 'login');
  document.getElementById('register-form').classList.toggle('active', tab === 'register');
}

function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const users = getUsers();
  const found = users.find(u => u.username === username && u.password === password);
  if (found) {
    setCurrentUser(found);
    toast(`Welcome ${found.fullName || found.username}`, 'success');
    go('dashboard');
  } else {
    toast('Invalid username or password', 'error');
  }
}

function doRegister() {
  const fullName = document.getElementById('reg-name').value.trim();
  const username = document.getElementById('reg-username').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const location = document.getElementById('reg-location').value.trim();
  const users = getUsers();
  if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    toast('Username already exists', 'warning');
    return;
  }
  const newUser = { id: Date.now(), username, password, role: 'farmer', fullName, email, phone: '', location, status: 'active' };
  users.push(newUser);
  saveUsers(users);
  setCurrentUser(newUser);
  toast('Registration successful. You can now monitor the greenhouse.', 'success');
  go('dashboard');
}

function logoutUser() {
  clearSession();
  toast('You have been logged out', 'info');
}

function isAdminUser() {
  return !!currentUser && currentUser.role === 'admin';
}

function updateAuthUI() {
  document.body.classList.toggle('auth-logged-in', !!currentUser);
  document.body.classList.toggle('auth-logged-out', !currentUser);
  const chip = document.getElementById('user-chip-name');
  const adminNavItems = ['nav-database', 'nav-settings', 'nav-grp-admin', 'nav-users'];
  const actions = document.getElementById('dashboard-actions');
  const banner = document.getElementById('farmer-mode-banner');
  const topbar = document.querySelector('.dashboard-topbar');
  const isAdmin = isAdminUser();
  if (chip) chip.textContent = currentUser ? `${currentUser.fullName || currentUser.username} (${currentUser.role})` : 'Guest';
  adminNavItems.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isAdmin ? '' : 'none';
  });
  if (actions) actions.style.display = 'flex'; // Give users access to Dashboard quick actions too
  if (banner) banner.style.display = 'none'; // Banner no longer needed
  if (topbar) topbar.style.display = isAdmin ? '' : 'none'; // Hide DB topbar for farmers
  const title = document.getElementById('ptitle');
  if (title && currentUser && !isAdmin) {
    title.textContent = 'Farmer Monitoring';
  } else if (title && !currentUser) {
    title.textContent = 'Dashboard';
  }
}

function resetUserForm() {
  editingUserId = null;
  ['user-fullname','user-username','user-email','user-password','user-location'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

function saveUserFromForm() {
  if (!currentUser || currentUser.role !== 'admin') {
    toast('Only admin can manage farmer accounts', 'warning');
    return;
  }
  const users = getUsers();
  const fullName = document.getElementById('user-fullname').value.trim();
  const username = document.getElementById('user-username').value.trim();
  const email = document.getElementById('user-email').value.trim();
  const password = document.getElementById('user-password').value;
  const location = document.getElementById('user-location').value.trim();
  if (!username || !fullName) {
    toast('Full name and username are required', 'warning');
    return;
  }
  const existing = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (existing && existing.id !== editingUserId) {
    toast('Username already exists', 'warning');
    return;
  }
  if (editingUserId) {
    const target = users.find(u => u.id === editingUserId);
    if (target) {
      target.fullName = fullName;
      target.username = username;
      target.email = email;
      target.location = location;
      if (password) target.password = password;
      toast('Farmer account updated', 'success');
    }
  } else {
    users.push({ id: Date.now(), username, password: password || 'greenhouse123', role: 'farmer', fullName, email, phone: '', location, status: 'active' });
    toast('Farmer account created', 'success');
  }
  saveUsers(users);
  renderUsersPage();
  resetUserForm();
}

function renderUsersPage() {
  const users = getUsers().filter(u => u.role === 'farmer' || u.username === 'admin');
  const tbody = document.getElementById('user-table-body');
  if (!tbody) return;
  tbody.innerHTML = users.map(u => `
    <tr>
      <td><b>${u.username}</b></td>
      <td>${u.fullName || '—'}</td>
      <td><span class="badge ${u.role === 'admin' ? 'g' : 'b'}">${u.role}</span></td>
      <td>${u.email || '—'}</td>
      <td>${u.location || '—'}</td>
      <td>
        <button class="btn s" style="padding:4px 8px;font-size:10px" onclick="editUser(${u.id})">✏️</button>
        <button class="btn s" style="padding:4px 8px;font-size:10px" onclick="resetUserPassword(${u.id})">🔐</button>
        <button class="btn d" style="padding:4px 8px;font-size:10px" onclick="deleteUser(${u.id})">🗑️</button>
      </td>
    </tr>
  `).join('');
}

function editUser(id) {
  const users = getUsers();
  const user = users.find(u => u.id === id);
  if (!user) return;
  editingUserId = id;
  document.getElementById('user-fullname').value = user.fullName || '';
  document.getElementById('user-username').value = user.username || '';
  document.getElementById('user-email').value = user.email || '';
  document.getElementById('user-location').value = user.location || '';
  document.getElementById('user-password').value = '';
  toast(`Editing ${user.fullName || user.username}`, 'info');
  go('users');
}

function resetUserPassword(id) {
  const users = getUsers();
  const user = users.find(u => u.id === id);
  if (!user) return;
  user.password = 'greenhouse123';
  saveUsers(users);
  toast(`${user.username} password reset to greenhouse123`, 'success');
  renderUsersPage();
}

function deleteUser(id) {
  if (!confirm('Delete this user account?')) return;
  const users = getUsers().filter(u => u.id !== id);
  saveUsers(users);
  renderUsersPage();
  toast('User removed', 'success');
}

// ═══════════════════════════════════════════
// FIREBASE SDK REAL-TIME LISTENER
// ═══════════════════════════════════════════
function initFirebaseSDK() {
  try {
    fbApp = firebase.initializeApp(firebaseConfig);
    fbDb = firebase.database(fbApp);
    console.log('✅ Firebase SDK initialized successfully');
    
    // Attach real-time listener to root
    fbListenerRef = fbDb.ref('/');
    fbListenerRef.on('value', (snapshot) => {
      const data = snapshot.val();
      if (data && typeof data === 'object') {
        rawDB = data;
        processLiveDataFromSnapshot(data);
        showDBTree(data);
        setLiveStatus(true);
        document.getElementById('db-perm-warning').style.display = 'none';
      } else {
        console.warn('Empty snapshot received from Firebase');
        setLiveStatus(true); // Connected but no data
      }
    }, (error) => {
      console.error('Firebase SDK listener error:', error);
      setLiveStatus(false);
      document.getElementById('db-perm-warning').style.display = 'block';
    });
  } catch (e) {
    console.error('Firebase SDK init failed:', e);
    // Fallback: show warning and try REST polling
    document.getElementById('db-perm-warning').style.display = 'block';
    document.getElementById('db-perm-warning').querySelector('pre').textContent = 
      '⚠️ Firebase SDK failed to load. Check your internet connection and Firebase config.';
    startRESTFallback();
  }
}

// REST fallback for when SDK fails
let restFallbackTimer = null;
function startRESTFallback() {
  if (restFallbackTimer) clearInterval(restFallbackTimer);
  restFallbackTimer = setInterval(fetchDB_REST, 5000);
  fetchDB_REST();
}

async function fetchDB_REST() {
  const url = `${FB_BASE}.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && typeof data === 'object' && !data.error) {
      rawDB = data;
      processLiveDataFromSnapshot(data);
      showDBTree(data);
      setLiveStatus(true);
      document.getElementById('db-perm-warning').style.display = 'none';
    }
  } catch (e) {
    console.warn('REST fallback sync warning:', e.message);
  }
}

function setLiveStatus(ok) {
  const el = document.getElementById('live-ind');
  const txt = document.getElementById('live-txt');
  const pill = document.getElementById('mode-pill');
  const pillTxt = document.getElementById('pill-txt');
  const pillDot = document.getElementById('pill-dot');
  
  if (ok) {
    el.style.background = 'var(--g8)'; el.style.borderColor = 'var(--g7)'; el.style.color = 'var(--g2)';
    txt.textContent = 'Firebase Connected';
    pill.className = 'sim-pill live'; pillTxt.textContent = '🔴 Live Firebase'; pillDot.className = 'pill-dot live';
  } else {
    el.style.background = '#fee2e2'; el.style.borderColor = '#fca5a5'; el.style.color = '#991b1b';
    txt.textContent = 'Disconnected';
    pill.className = 'sim-pill offline'; pillTxt.textContent = '⚠️ Firebase Disconnected'; pillDot.className = 'pill-dot offline';
  }
  document.getElementById('lut').textContent = liveData.lastUpdated || new Date().toLocaleTimeString();
  document.getElementById('loading-spin').style.display = 'none';
}

function checkFirebaseConnection() {
  toast('Checking Firebase connection...', 'info');
  document.getElementById('loading-spin').style.display = 'inline-block';
  
  if (firebase.apps.length > 0) {
    const db = firebase.database();
    db.goOffline();
    setTimeout(() => {
      db.goOnline();
      toast('Firebase disconnected and reconnected successfully! ✅', 'success');
      document.getElementById('loading-spin').style.display = 'none';
      manualRefresh();
    }, 1200);
  } else {
    toast('Initializing Firebase connection...', 'info');
    applyFBConfig();
    document.getElementById('loading-spin').style.display = 'none';
  }
}

// ═══════════════════════════════════════════
// LIVE DATA PROCESSOR (from Firebase SDK snapshot)
// ═══════════════════════════════════════════
function getValueByAliases(obj, aliases) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const lower = {};
  Object.entries(obj).forEach(([k, v]) => { lower[k.toLowerCase()] = v; });
  for (const alias of aliases) {
    const direct = lower[alias.toLowerCase()];
    if (direct !== undefined) return direct;
    const normalizedAlias = alias.toLowerCase().replace(/[^a-z]/g, '');
    const match = Object.entries(lower).find(([k]) => k.replace(/[^a-z]/g, '') === normalizedAlias);
    if (match) return match[1];
  }
  return null;
}

function findDataObject(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const lowerKeys = Object.keys(node).map(k => k.toLowerCase());
  const hasTelemetry = [
    'temperature','temp','tempc','humidity','humid','co2','smoke','ldr','light','lightlevel','lux',
    'soil1','soil2','soil3','soil4','soil5','soil6','soilSensor1','soilSensor2','soilSensor3','soilSensor4','soilSensor5','soilSensor6',
    'fanstatus','pumpstatus','windowstatus','lightstatus','fan','pump','window','lights'
  ].some(key => lowerKeys.includes(key));

  if (hasTelemetry) return node;

  for (const child of Object.values(node)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const found = findDataObject(child);
      if (found) return found;
    }
  }
  return null;
}

function getPrimaryDataNode(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const preferred = [data.live, data.greenhouse, data.current, data.latest, data.status, data.snapshot];
  for (const candidate of preferred) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const found = findDataObject(candidate);
      if (found) return found;
      return candidate;
    }
  }

  const namedMatches = Object.entries(data).filter(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const normalized = key.toLowerCase();
    return normalized === 'live' || normalized === 'greenhouse' || normalized === 'current' || normalized === 'latest' || normalized === 'status' || normalized === 'snapshot';
  });
  if (namedMatches.length > 0) {
    const found = findDataObject(namedMatches[0][1]);
    return found || namedMatches[0][1];
  }

  const found = findDataObject(data);
  return found || data;
}

function getHistoryItems(data) {
  if (!data || typeof data !== 'object') return [];
  const candidates = [data.history, data.History, data.historyData, data.histories];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) return candidate.filter(item => item && typeof item === 'object');
    if (typeof candidate === 'object') {
      const values = Object.values(candidate).filter(item => item && typeof item === 'object');
      if (values.length > 0) return values;
    }
  }
  return [];
}

function formatTimestamp(value) {
  if (value === null || value === undefined || value === '') return new Date().toLocaleTimeString();
  const d = new Date(value);
  return isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function normalizeStatus(v, fallback = 'OFF') {
  if (v === true || v === 'ON' || v === '1' || v === 1 || v === 'true') return 'ON';
  if (v === false || v === 'OFF' || v === '0' || v === 0 || v === 'false') return 'OFF';
  return fallback;
}

function processLiveDataFromSnapshot(data) {
  if (!data) return;

  const source = getPrimaryDataNode(data) || data;
  const historyItems = getHistoryItems(data);

  liveData.temperature   = parseNum(getValueByAliases(source, ['temperature','temp','tempc','temp_c'])) ?? liveData.temperature;
  liveData.humidity      = parseNum(getValueByAliases(source, ['humidity','humid','humiditypct','humidity_percent'])) ?? liveData.humidity;
  liveData.co2           = parseNum(getValueByAliases(source, ['co2','co2level','carbon_dioxide'])) ?? liveData.co2;
  liveData.smoke         = parseNum(getValueByAliases(source, ['smoke','mq135','gas'])) ?? liveData.smoke;
  liveData.ldr           = parseNum(getValueByAliases(source, ['ldr','light','lightlevel','lux'])) ?? liveData.ldr;
  
liveData.fanMode = data.fanMode ?? 'AUTO';
  liveData.pumpMode = data.pumpMode ?? 'AUTO';
  liveData.windowMode = data.windowMode ?? 'AUTO';
  liveData.lightMode = data.lightMode ?? 'AUTO';

  liveData.espFan = parseBool(getValueByAliases(source, ['fanStatus','fan'])) ?? false;
  liveData.espPump = parseBool(getValueByAliases(source, ['pumpStatus','pump'])) ?? false;
  liveData.espWindow = parseBool(getValueByAliases(source, ['windowStatus','window'])) ?? false;
  liveData.espLight = parseBool(getValueByAliases(source, ['lightStatus','light','lights'])) ?? false;

  // Handle Manual Overrides and Reject Sensor Overwrites
  if (liveData.fanMode === 'MANUAL') {
      if (liveData.espFan !== liveData.fanStatus && liveData.fanStatus !== null && fbDb) {
          fbDb.ref('/greenhouse/live/fanStatus').set(liveData.fanStatus ? 'ON' : 'OFF');
      }
  } else {
      liveData.fanStatus = liveData.espFan;
  }

  if (liveData.windowMode === 'MANUAL') {
      if (liveData.espWindow !== liveData.windowStatus && liveData.windowStatus !== null && fbDb) {
          fbDb.ref('/greenhouse/live/windowStatus').set(liveData.windowStatus ? 'ON' : 'OFF');
      }
  } else {
      liveData.windowStatus = liveData.espWindow;
  }

  if (liveData.pumpMode === 'MANUAL') {
      if (liveData.espPump !== liveData.pumpStatus && liveData.pumpStatus !== null && fbDb) {
          fbDb.ref('/greenhouse/live/pumpStatus').set(liveData.pumpStatus ? 'ON' : 'OFF');
      }
  } else {
      liveData.pumpStatus = liveData.espPump;
  }

  if (liveData.lightMode === 'MANUAL') {
      if (liveData.espLight !== liveData.lightStatus && liveData.lightStatus !== null && fbDb) {
          fbDb.ref('/greenhouse/live/lightStatus').set(liveData.lightStatus ? 'ON' : 'OFF');
      }
  } else {
      liveData.lightStatus = liveData.espLight;
  }

  liveData.soil1 = parseNum(getValueByAliases(source, ['soil1','soilSensor1','soilmoisture1','moisture1'])) ?? liveData.soil1;
  liveData.soil2 = parseNum(getValueByAliases(source, ['soil2','soilSensor2','soilmoisture2','moisture2'])) ?? liveData.soil2;
  liveData.soil3 = parseNum(getValueByAliases(source, ['soil3','soilSensor3','soilmoisture3','moisture3'])) ?? liveData.soil3;
  liveData.soil4 = parseNum(getValueByAliases(source, ['soil4','soilSensor4','soilmoisture4','moisture4'])) ?? liveData.soil4;
  liveData.soil5 = parseNum(getValueByAliases(source, ['soil5','soilSensor5','soilmoisture5','moisture5'])) ?? liveData.soil5;
  liveData.soil6 = parseNum(getValueByAliases(source, ['soil6','soilSensor6','soilmoisture6','moisture6'])) ?? liveData.soil6;
  liveData.npk = source.npk || {};
  // Just read the NPK values. If they are missing in the live payload, fallback to the existing state.

  const hasAnyLiveValue = [liveData.temperature, liveData.humidity, liveData.co2, liveData.smoke, liveData.ldr, liveData.soil1].some(v => v !== null && v !== undefined);
  if (!hasAnyLiveValue && source && typeof source === 'object') {
    const fallback = Object.values(source).find(v => v && typeof v === 'object' && !Array.isArray(v));
    if (fallback) {
      liveData.temperature   = parseNum(getValueByAliases(fallback, ['temperature','temp','tempc','temp_c'])) ?? liveData.temperature;
      liveData.humidity      = parseNum(getValueByAliases(fallback, ['humidity','humid','humiditypct','humidity_percent'])) ?? liveData.humidity;
      liveData.co2           = parseNum(getValueByAliases(fallback, ['co2','co2level','carbon_dioxide'])) ?? liveData.co2;
      liveData.smoke         = parseNum(getValueByAliases(fallback, ['smoke','mq135','gas'])) ?? liveData.smoke;
      liveData.ldr           = parseNum(getValueByAliases(fallback, ['ldr','light','lightlevel','lux'])) ?? liveData.ldr;
      liveData.soil1 = parseNum(getValueByAliases(fallback, ['soil1','soilSensor1','soilmoisture1','moisture1'])) ?? liveData.soil1;
      liveData.soil2 = parseNum(getValueByAliases(fallback, ['soil2','soilSensor2','soilmoisture2','moisture2'])) ?? liveData.soil2;
      liveData.soil3 = parseNum(getValueByAliases(fallback, ['soil3','soilSensor3','soilmoisture3','moisture3'])) ?? liveData.soil3;
      liveData.soil4 = parseNum(getValueByAliases(fallback, ['soil4','soilSensor4','soilmoisture4','moisture4'])) ?? liveData.soil4;
      liveData.soil5 = parseNum(getValueByAliases(fallback, ['soil5','soilSensor5','soilmoisture5','moisture5'])) ?? liveData.soil5;
      liveData.soil6 = parseNum(getValueByAliases(fallback, ['soil6','soilSensor6','soilmoisture6','moisture6'])) ?? liveData.soil6;
    }
  }

  const lastUpdatedRaw = getValueByAliases(source, ['lastUpdated','timestamp','time','updatedAt']) || data.lastUpdated || data.timestamp || data.time;
  liveData.lastUpdated = lastUpdatedRaw || null;
  liveData.timestamp = formatTimestamp(lastUpdatedRaw);

  if (liveData.temperature !== null) {
    timeLabels.push(liveData.timestamp);
    if (timeLabels.length > 30) timeLabels.shift();
    historyBuffers.temperature.push(liveData.temperature); if (historyBuffers.temperature.length > 30) historyBuffers.temperature.shift();
    historyBuffers.humidity.push(liveData.humidity);       if (historyBuffers.humidity.length > 30) historyBuffers.humidity.shift();
    historyBuffers.co2.push(liveData.co2);                 if (historyBuffers.co2.length > 30) historyBuffers.co2.shift();
    historyBuffers.smoke.push(liveData.smoke);             if (historyBuffers.smoke.length > 30) historyBuffers.smoke.shift();
    historyBuffers.ldr.push(liveData.ldr);                 if (historyBuffers.ldr.length > 30) historyBuffers.ldr.shift();
    if (liveData.npk_n !== null) {
      historyBuffers.npk_n.push(liveData.npk_n); if (historyBuffers.npk_n.length > 30) historyBuffers.npk_n.shift();
      historyBuffers.npk_p.push(liveData.npk_p); if (historyBuffers.npk_p.length > 30) historyBuffers.npk_p.shift();
      historyBuffers.npk_k.push(liveData.npk_k); if (historyBuffers.npk_k.length > 30) historyBuffers.npk_k.shift();
    }
  }

  if (historyItems.length > 0) {
    historyRecords = historyItems
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        return {
          ...item,
          temperature: parseNum(item.temperature) ?? null,
          humidity: parseNum(item.humidity) ?? null,
          co2: parseNum(item.co2) ?? null,
          smoke: parseNum(item.smoke) ?? null,
          ldr: parseNum(item.ldr) ?? null,
          soil1: parseNum(item.soil1) ?? parseNum(item.soilSensor1) ?? null,
          soil2: parseNum(item.soil2) ?? parseNum(item.soilSensor2) ?? null,
          soil3: parseNum(item.soil3) ?? parseNum(item.soilSensor3) ?? null,
          soil4: parseNum(item.soil4) ?? parseNum(item.soilSensor4) ?? null,
          soil5: parseNum(item.soil5) ?? parseNum(item.soilSensor5) ?? null,
          soil6: parseNum(item.soil6) ?? parseNum(item.soilSensor6) ?? null,
          npk: item.npk || {},
          fanStatus: normalizeStatus(item.fanStatus, 'OFF'),
          pumpStatus: normalizeStatus(item.pumpStatus, 'OFF'),
          windowStatus: normalizeStatus(item.windowStatus, 'CLOSED'),
          lightStatus: normalizeStatus(item.lightStatus, 'OFF')
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  }

  updateDashboardSensors();
  updateActuatorsUI();
  updatePlantGrid();
  checkThresholdAlerts();
  updateCharts();
  if (document.getElementById('page-analytics').classList.contains('active')) {
    renderAnalyticsPage();
  }
}

function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && !isNaN(v)) return parseFloat(v);
  return null;
}

function parseBool(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (v === 'ON' || v === 'OPEN' || v === '1' || v === 1 || v === 'true') return true;
  if (v === 'OFF' || v === 'CLOSED' || v === '0' || v === 0 || v === 'false') return false;
  return null;
}

// REST fetchDB — kept for DB Inspector page only
async function fetchDB() {
  const url = `${FB_BASE}.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && typeof data === 'object' && !data.error) {
      rawDB = data;
      showDBTree(data);
      setEl('db-status', '✅ Active DB', 'badge g');
      return data;
    } else {
      throw new Error(data && data.error ? data.error : 'Empty response');
    }
  } catch (e) {
    console.warn('REST fetch error:', e.message);
    setEl('db-status', '⚠️ Fetch Error', 'badge r');
    return null;
  }
}



// ═══════════════════════════════════════════
// DASHBOARD UI UPDATER
// ═══════════════════════════════════════════
function updateDashboardSensors() {
  // Handle null/loading state — show — for all values when no data yet
  const temp = liveData.temperature;
  const hum = liveData.humidity;
  const co2 = liveData.co2;
  const smoke = liveData.smoke;
  const ldr = liveData.ldr;

  setTxt('e-temp', temp !== null ? temp.toFixed(1) : '—');
  setTxt('e-hum', hum !== null ? Math.round(hum) : '—');
  setTxt('e-co2', co2 !== null ? Math.round(co2) : '—');
  setTxt('e-smoke', smoke !== null ? Math.round(smoke) : '—');
  setTxt('e-ldr', ldr !== null ? Math.round(ldr) : '—');

  setW('eb-temp', temp !== null ? Math.min(100, Math.max(0, ((temp - 10)/30)*100)) : 0);
  setW('eb-hum', hum !== null ? hum : 0);
  setW('eb-co2', co2 !== null ? Math.min(100, (co2 / 1200)*100) : 0);
  setW('eb-smoke', smoke !== null ? Math.min(100, (smoke / 800)*100) : 0);
  setW('eb-ldr', ldr !== null ? Math.min(100, (ldr / 1000)*100) : 0);

  setTxt('e-temp-st', temp === null ? '⏳ Waiting...' : temp > 26 ? '🔴 HIGH (Fan ON)' : temp < 20 ? '🔵 LOW' : '✅ Normal');
  setTxt('e-hum-st', hum === null ? '⏳ Waiting...' : hum < 50 ? '🔴 LOW' : '✅ Normal');
  setTxt('e-co2-st', co2 === null ? '⏳ Waiting...' : co2 > 1000 ? '🚨 HIGH CO₂' : '✅ Normal');
  setTxt('e-smoke-st', smoke === null ? '⏳ Waiting...' : smoke > 700 ? '🚨 SMOKE ALERT' : '✅ Clean Air');
  setTxt('e-ldr-st', ldr === null ? '⏳ Waiting...' : ldr < 500 ? '⚠️ LOW LIGHT' : '✅ Optimal');

  // Environment page targets
  setTxt('env-T', temp !== null ? temp.toFixed(1)+'°C' : '—');
  setTxt('env-H', hum !== null ? Math.round(hum)+'%' : '—');
  setTxt('env-L', ldr !== null ? Math.round(ldr)+' lux' : '—');
  setTxt('env-C', co2 !== null ? Math.round(co2)+' ppm' : '—');

  // NPK Sensor UI (6 Pots)
  for (let i = 1; i <= 6; i++) {
    const pNpk = liveData.npk && liveData.npk[i] ? liveData.npk[i] : {};
    setTxt(`npk-${i}-n`, pNpk.N !== undefined ? Math.round(pNpk.N) + ' mg/kg' : '-');
    setTxt(`npk-${i}-p`, pNpk.P !== undefined ? Math.round(pNpk.P) + ' mg/kg' : '-');
    setTxt(`npk-${i}-k`, pNpk.K !== undefined ? Math.round(pNpk.K) + ' mg/kg' : '-');
  }

  // Render 6x Soil Moisture Sensors Grid
  const soilGrid = document.getElementById('dash-soil-grid');
  if (soilGrid) {
    let html = '';
    for (let i = 1; i <= 6; i++) {
      const v = liveData[`soil${i}`];
      if (v === null) {
        html += `
          <div class="soil-card" style="opacity:0.5">
            <div class="soil-num">Soil Sensor ${i}</div>
            <div class="soil-val">—</div>
            <div style="font-size:10px;color:var(--muted)">Waiting...</div>
            <div class="soil-st ok">⏳</div>
          </div>`;
      } else {
        const st = v < 30 ? 'dry' : v > 70 ? 'wet' : 'ok';
        const stTxt = v < 30 ? 'DRY' : v > 70 ? 'WET' : 'NORMAL';
        html += `
          <div class="soil-card">
            <div class="soil-num">Soil Sensor ${i}</div>
            <div class="soil-val">${v.toFixed(1)}%</div>
            <div style="font-size:10px;color:var(--muted)">Plant ${i}</div>
            <div class="soil-st ${st}">${stTxt}</div>
          </div>`;
      }
    }
    soilGrid.innerHTML = html;
  }
}

function updateActuatorsUI() {
  applyActUI('act-fan', 'act-fan-st', 'act-fan-card', 'cf', 'cf-st', liveData.fanStatus, 'ON', 'OFF', liveData.fanMode, 'act-fan-mode', 'cf-mode');
  applyActUI('act-pump', 'act-pump-st', 'act-pump-card', null, null, liveData.pumpStatus, 'ON', 'OFF', liveData.pumpMode, 'act-pump-mode', 'cp-mode');
  applyActUI('act-win', 'act-win-st', 'act-win-card', 'cw', 'cw-st', liveData.windowStatus, 'OPEN', 'CLOSED', liveData.windowMode, 'act-win-mode', 'cw-mode');
  applyActUI('act-light', 'act-light-st', 'act-light-card', 'cl', 'cl-st', liveData.lightStatus, 'ON', 'OFF', liveData.lightMode, 'act-light-mode', 'cl-mode');
  
  // Update new Sensor Output block
  setEl('esp-fan-st', liveData.espFan ? 'ON' : 'OFF');
  setEl('esp-pump-st', liveData.espPump ? 'ON' : 'OFF');
  setEl('esp-win-st', liveData.espWindow ? 'OPEN' : 'CLOSED');
  setEl('esp-light-st', liveData.espLight ? 'ON' : 'OFF');
}

function applyActUI(tog1, st1, card1, tog2, st2, val, onTxt, offTxt, mode, modeId, modeId2) {
  const on = val === true || val === 'ON' || val === 1;
  
  const eTog1 = document.getElementById(tog1); if (eTog1) eTog1.checked = on;
  const eTog2 = document.getElementById(tog2); if (eTog2) eTog2.checked = on;
  
  setEl(st1, on ? onTxt : offTxt, 'ac-st ' + (on ? 'on' : 'off'));
  if (st2) setEl(st2, on ? onTxt : offTxt, 'ac-st ' + (on ? 'on' : 'off'));
  
  const card = document.getElementById(card1); if (card) card.className = 'ac' + (on ? ' on' : '');

  const eMode = document.getElementById(modeId);
  const eMode2 = document.getElementById(modeId2);
  
  if (mode === 'MANUAL') {
    if (eMode) eMode.style.display = 'block';
    if (eMode2) eMode2.style.display = 'block';
  } else {
    if (eMode) eMode.style.display = 'none';
    if (eMode2) eMode2.style.display = 'none';
  }
}




// ═══════════════════════════════════════════
// 5-MINUTE AUTOMATED HISTORY RECORDING
// ═══════════════════════════════════════════
function triggerHistorySnapshot() {
  const now = new Date();
  const record = {
    id: now.getTime(),
    timestamp: now.toLocaleString(),
    timeString: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    dateString: now.toLocaleDateString(),
    temperature: liveData.temperature,
    humidity: liveData.humidity,
    co2: liveData.co2,
    smoke: liveData.smoke,
    ldr: liveData.ldr,
    npk: liveData.npk || {},
    fanStatus: liveData.fanStatus ? 'ON' : 'OFF',
    pumpStatus: liveData.pumpStatus ? 'ON' : 'OFF',
    windowStatus: liveData.windowStatus ? 'OPEN' : 'CLOSED',
    lightStatus: liveData.lightStatus ? 'ON' : 'OFF',
    soil1: liveData.soil1,
    soil2: liveData.soil2,
    soil3: liveData.soil3,
    soil4: liveData.soil4,
    soil5: liveData.soil5,
    soil6: liveData.soil6
  };

  historyRecords.unshift(record);
  if (historyRecords.length > 200) historyRecords.pop();

  // POST record to Firebase /history.json
  fetch(`${FB_BASE}/history.json`, {
    method: 'POST',
    body: JSON.stringify(record),
    headers: { 'Content-Type': 'application/json' }
  }).catch(e => console.warn('History push offline mode:', e.message));

  toast(`📸 5-Min History snapshot recorded!`, 'success');
  if (document.getElementById('page-analytics').classList.contains('active')) {
    renderAnalyticsPage();
  }
}

function initHistoryEngine() {
  // Generate initial seed history (e.g. past 12 records, 5 mins apart) if empty
  if (historyRecords.length === 0) {
    const now = Date.now();
    for (let i = 12; i >= 1; i--) {
      const t = new Date(now - i * 5 * 60 * 1000);
      historyRecords.push({
        id: t.getTime(),
        timestamp: t.toLocaleString(),
        timeString: t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        dateString: t.toLocaleDateString(),
        temperature: +(24 + Math.sin(i)*2 + (Math.random()*0.8 - 0.4)).toFixed(1),
        humidity: Math.round(60 + Math.cos(i)*6 + (Math.random()*2 - 1)),
        co2: Math.round(520 + i*8 + (Math.random()*20 - 10)),
        smoke: Math.round(170 + (Math.random()*15)),
        ldr: Math.round(700 + Math.sin(i)*100),
        npk: {
          1: { N: Math.round(80 + Math.sin(i)*10), P: Math.round(40 + Math.cos(i)*5), K: Math.round(110 + Math.sin(i)*15) },
          2: { N: Math.round(85 + Math.sin(i)*10), P: Math.round(38 + Math.cos(i)*5), K: Math.round(112 + Math.sin(i)*15) },
          3: { N: Math.round(82 + Math.sin(i)*10), P: Math.round(42 + Math.cos(i)*5), K: Math.round(115 + Math.sin(i)*15) },
          4: { N: Math.round(88 + Math.sin(i)*10), P: Math.round(41 + Math.cos(i)*5), K: Math.round(108 + Math.sin(i)*15) },
          5: { N: Math.round(79 + Math.sin(i)*10), P: Math.round(45 + Math.cos(i)*5), K: Math.round(105 + Math.sin(i)*15) },
          6: { N: Math.round(90 + Math.sin(i)*10), P: Math.round(39 + Math.cos(i)*5), K: Math.round(120 + Math.sin(i)*15) }
        },
        fanStatus: i % 4 === 0 ? 'ON' : 'OFF',
        pumpStatus: 'OFF',
        windowStatus: 'CLOSED',
        lightStatus: i > 6 ? 'OFF' : 'ON',
        soil1: +(55 + Math.sin(i)*4).toFixed(1),
        soil2: +(45 + Math.cos(i)*5).toFixed(1),
        soil3: +(62 + Math.sin(i)*3).toFixed(1),
        soil4: +(28 + (i*0.5)).toFixed(1),
        soil5: +(50 + Math.cos(i)*4).toFixed(1),
        soil6: +(58 + Math.sin(i)*3).toFixed(1)
      });
    }
  }

  // Setup 5-Minute interval (300,000 ms)
  if (historyTimer) clearInterval(historyTimer);
  historyTimer = setInterval(triggerHistorySnapshot, 300000);
}

// ═══════════════════════════════════════════
// ANALYTICS PAGE (AVG, MAX, MIN strictly from History)
// ═══════════════════════════════════════════
function renderAnalyticsPage() {
  if (historyRecords.length === 0) {
    setTxt('an-t-avg', '—'); setTxt('an-t-max', '—'); setTxt('an-t-min', '—');
    setTxt('an-h-avg', '—'); setTxt('an-h-max', '—'); setTxt('an-h-min', '—');
    setTxt('an-c-avg', '—'); setTxt('an-c-max', '—'); setTxt('an-c-min', '—');
    setTxt('an-s-avg', '—'); setTxt('an-s-max', '—'); setTxt('an-s-min', '—');
    const tbody = document.getElementById('an-history-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:24px">No history records found yet.</td></tr>';
    renderHistoryCharts();
    return;
  }

  const validRecords = historyRecords.filter(r => r && typeof r === 'object');
  const temps = validRecords.map(r => parseNum(r.temperature)).filter(v => v !== null);
  const hums  = validRecords.map(r => parseNum(r.humidity)).filter(v => v !== null);
  const co2s  = validRecords.map(r => parseNum(r.co2)).filter(v => v !== null);
  const soils = validRecords.map(r => {
    const values = [parseNum(r.soil1), parseNum(r.soil2), parseNum(r.soil3), parseNum(r.soil4), parseNum(r.soil5), parseNum(r.soil6)].filter(v => v !== null);
    return values.length ? (values.reduce((a,b)=>a+b,0) / values.length) : null;
  }).filter(v => v !== null);

  const calc = (arr) => arr.length ? {
    avg: (arr.reduce((a,b)=>a+b, 0) / arr.length).toFixed(1),
    max: Math.max(...arr).toFixed(1),
    min: Math.min(...arr).toFixed(1)
  } : { avg: '—', max: '—', min: '—' };

  const tS = calc(temps);
  const hS = calc(hums);
  const cS = calc(co2s);
  const sS = calc(soils);

  // Update UI Metric Cards
  setTxt('an-t-avg', tS.avg + '°C'); setTxt('an-t-max', tS.max + '°C'); setTxt('an-t-min', tS.min + '°C');
  setTxt('an-h-avg', hS.avg + '%');  setTxt('an-h-max', hS.max + '%');  setTxt('an-h-min', hS.min + '%');
  setTxt('an-c-avg', Math.round(cS.avg) + ' ppm'); setTxt('an-c-max', Math.round(cS.max) + ' ppm'); setTxt('an-c-min', Math.round(cS.min) + ' ppm');
  setTxt('an-s-avg', sS.avg + '%');  setTxt('an-s-max', sS.max + '%');  setTxt('an-s-min', sS.min + '%');

  // Populate History Log Table
  const tbody = document.getElementById('an-history-tbody');
  if (tbody) {
    tbody.innerHTML = validRecords.slice(0, 15).map(r => {
      const soilValues = [parseNum(r.soil1), parseNum(r.soil2), parseNum(r.soil3), parseNum(r.soil4), parseNum(r.soil5), parseNum(r.soil6)].filter(v => v !== null);
      const sAvg = soilValues.length ? ((soilValues.reduce((a,b)=>a+b,0) / soilValues.length).toFixed(1)) : '—';
      const timeLabel = r.timestamp || r.timeString || '—';
      const fanStatus = normalizeStatus(r.fanStatus, 'OFF');
      const pumpStatus = normalizeStatus(r.pumpStatus, 'OFF');
      const windowStatus = normalizeStatus(r.windowStatus, 'CLOSED');
      return `<tr>
        <td style="font-size:11px"><b>${timeLabel}</b></td>
        <td>${parseNum(r.temperature) !== null ? parseNum(r.temperature).toFixed(1)+'°C' : '—'}</td>
        <td>${parseNum(r.humidity) !== null ? Math.round(parseNum(r.humidity))+'%' : '—'}</td>
        <td>${parseNum(r.co2) !== null ? Math.round(parseNum(r.co2))+' ppm' : '—'}</td>
        <td>${parseNum(r.smoke) !== null ? Math.round(parseNum(r.smoke))+' ppm' : '—'}</td>
        <td>${parseNum(r.ldr) !== null ? Math.round(parseNum(r.ldr))+' lux' : '—'}</td>
        <td><b>${sAvg}%</b></td>
        <td><span style="font-size:10px">See NPK Tab</span></td>
        <td><span class="badge ${fanStatus==='ON'?'g':'b'}">${fanStatus}</span></td>
        <td><span class="badge ${pumpStatus==='ON'?'g':'b'}">${pumpStatus}</span></td>
        <td><span class="badge ${windowStatus==='OPEN'?'g':'b'}">${windowStatus}</span></td>
      </tr>`;
    }).join('');
  }

  // Render Charts for History
  renderHistoryCharts();
}

function renderHistoryCharts() {
  const rev = [...historyRecords].reverse();
  const labels = rev.map(r => r.timeString || r.timestamp || '—');

  // Temp & Hum Chart
  const elTH = document.getElementById('anHistTempHum');
  if (elTH) {
    if (charts.anTH) charts.anTH.destroy();
    charts.anTH = new Chart(elTH.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Temperature (°C)', data: rev.map(r=>parseNum(r.temperature)), borderColor: '#22c55e', tension: .3 },
          { label: 'Humidity (%)', data: rev.map(r=>parseNum(r.humidity)), borderColor: '#3b82f6', tension: .3 }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  // CO2 Chart
  const elC = document.getElementById('anHistCO2');
  if (elC) {
    if (charts.anC) charts.anC.destroy();
    charts.anC = new Chart(elC.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{ label: 'CO₂ Level (ppm)', data: rev.map(r=>parseNum(r.co2)), borderColor: '#8b5cf6', backgroundColor: 'rgba(139,92,246,.1)', fill: true, tension: .3 }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  // Soil Chart (Sensors 1-6)
  const elS = document.getElementById('anHistSoil');
  if (elS) {
    if (charts.anS) charts.anS.destroy();
    charts.anS = new Chart(elS.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Soil 1 (Tomato)', data: rev.map(r=>parseNum(r.soil1)), borderColor: '#22c55e' },
          { label: 'Soil 2 (Pepper)', data: rev.map(r=>parseNum(r.soil2)), borderColor: '#f59e0b' },
          { label: 'Soil 3 (Basil)', data: rev.map(r=>parseNum(r.soil3)), borderColor: '#3b82f6' },
          { label: 'Soil 4 (Lettuce)', data: rev.map(r=>parseNum(r.soil4)), borderColor: '#ef4444' },
          { label: 'Soil 5 (Cucumber)', data: rev.map(r=>parseNum(r.soil5)), borderColor: '#8b5cf6' },
          { label: 'Soil 6 (Spinach)', data: rev.map(r=>parseNum(r.soil6)), borderColor: '#10b981' }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  // NPK Chart
  const elNPK = document.getElementById('anHistNPK');
  if (elNPK) {
    if (charts.anNPK) charts.anNPK.destroy();
    charts.anNPK = new Chart(elNPK.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Pot 1 Nitrogen (N) mg/kg', data: rev.map(r=>(r.npk && r.npk[1] ? r.npk[1].N : null)), borderColor: '#22c55e', tension: .3 },
          { label: 'Pot 1 Phosphorus (P) mg/kg', data: rev.map(r=>(r.npk && r.npk[1] ? r.npk[1].P : null)), borderColor: '#f59e0b', tension: .3 },
          { label: 'Pot 1 Potassium (K) mg/kg', data: rev.map(r=>(r.npk && r.npk[1] ? r.npk[1].K : null)), borderColor: '#3b82f6', tension: .3 }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }
}

function exportHistoryCSV() {
  let csv = 'Timestamp,Temperature_C,Humidity_Pct,CO2_ppm,Smoke_ppm,LDR_lux,Soil1,Soil2,Soil3,Soil4,Soil5,Soil6,NPK_N,NPK_P,NPK_K,Fan,Pump,Window\n';
  historyRecords.forEach(r => {
    csv += `"${r.timestamp}",${r.temperature},${r.humidity},${r.co2},${r.smoke},${r.ldr},${r.soil1},${r.soil2},${r.soil3},${r.soil4},${r.soil5},${r.soil6},${r.npk_n},${r.npk_p},${r.npk_k},${r.fanStatus},${r.pumpStatus},${r.windowStatus}\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `greenhouse_history_${Date.now()}.csv`; a.click();
  toast('History data exported as CSV', 'success');
}

// ═══════════════════════════════════════════
// PLANT MANAGEMENT (6x Sensors)
// ═══════════════════════════════════════════
const plantMeta = [
  { name: 'Tomato Plant 1', type: 'Vegetable', variety: 'Cherry' },
  { name: 'Tomato Plant 2', type: 'Vegetable', variety: 'Cherry' },
  { name: 'Tomato Plant 3', type: 'Vegetable', variety: 'Cherry' },
  { name: 'Tomato Plant 4', type: 'Vegetable', variety: 'Cherry' },
  { name: 'Tomato Plant 5', type: 'Vegetable', variety: 'Cherry' },
  { name: 'Tomato Plant 6', type: 'Vegetable', variety: 'Cherry' }
];

let _plantFilter = '', _plantStat = '';
function updatePlantGrid() {
  plants = [];
  for (let i = 1; i <= 6; i++) {
    const v = liveData[`soil${i}`];
    if (v === null) {
      plants.push({ id: i, ...plantMeta[i-1], moisture: null, status: 'waiting', health: 'waiting' });
    } else {
      const status = v < 30 ? 'dry' : v > 70 ? 'wet' : 'ok';
      const health = v < 20 ? 'critical' : v < 30 ? 'warning' : 'healthy';
      plants.push({ id: i, ...plantMeta[i-1], moisture: v, status, health });
    }
  }

  const grid = document.getElementById('plant-grid');
  if (!grid) return;

  const filtered = plants.filter(p => {
    const nm = !_plantFilter || p.name.toLowerCase().includes(_plantFilter.toLowerCase());
    const st = !_plantStat || p.status === _plantStat;
    return nm && st;
  });

  grid.innerHTML = filtered.map(p => {
    if (p.moisture === null) {
      return `
        <div class="pc" style="opacity:0.6">
          <div class="pc-hd"><div class="pc-id">${p.id}</div><span>⏳</span></div>
          <div class="pc-name">${p.name}</div>
          <div class="pc-type">${p.type} · ${p.variety}</div>
          <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:6px">
            <span style="color:var(--muted)">Soil Moisture Sensor ${p.id}</span><b>—</b>
          </div>
          <div class="mbar"><div class="mfill ok" style="width:0%"></div></div>
          <div style="display:flex;align-items:center;justify-content:center">
            <span style="font-size:10px;color:var(--muted)">⏳ Waiting for data...</span>
          </div>
        </div>`;
    }
    const hi = p.health === 'healthy' ? '🟢' : p.health === 'warning' ? '🟡' : '🔴';
    return `
      <div class="pc" onclick="toast('Plant ${p.id} Details: ${p.name}','info')">
        <div class="pc-hd"><div class="pc-id">${p.id}</div><span>${hi}</span></div>
        <div class="pc-name">${p.name}</div>
        <div class="pc-type">${p.type} · ${p.variety}</div>
        <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:6px">
          <span style="color:var(--muted)">Soil Moisture Sensor ${p.id}</span><b>${p.moisture.toFixed(1)}%</b>
        </div>
        <div class="mbar"><div class="mfill ${p.status}" style="width:${p.moisture}%"></div></div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span class="chip ${p.status}">${p.status.toUpperCase()}</span>
          <span style="font-size:10px;color:var(--muted)">Target: 40–70%</span>
        </div>
        <button class="wbtn" onclick="event.stopPropagation();pumpPlant(${p.id})">💧 Water Plant ${p.id}</button>
      </div>`;
  }).join('');

  renderSoilBarChart();

  // Populate Disease plant selector dropdown
  const sel = document.getElementById('disease-plant-sel');
  if (sel) sel.innerHTML = plants.map(p => `<option value="${p.id}">Plant ${p.id} – ${p.name} (${p.variety})</option>`).join('');
}

function filterP(v) { _plantFilter = v; updatePlantGrid(); }
function filterPS(v) { _plantStat = v; updatePlantGrid(); }
function pumpPlant(id) {
  liveData[`soil${id}`] = Math.min(85, liveData[`soil${id}`] + 18);
  updatePlantGrid();
  addCtrlLog(`Irrigation Pump Plant ${id} → ON (3s)`);
  toast(`💧 Watered Plant ${id} (Moisture increased to ${liveData[`soil${id}`].toFixed(1)}%)`, 'success');
}

// ═══════════════════════════════════════════
// ACTUATOR CONTROL — Write to Firebase
// ═══════════════════════════════════════════
function setAct(type, el) {
  const val = el.checked;
  const firebaseKey = type === 'window' ? 'windowStatus' : (type === 'light' || type === 'lights') ? 'lightStatus' : type + 'Status';
  const modeKey = (type === 'lights' ? 'light' : type) + 'Mode';

  liveData[firebaseKey] = val;
  liveData[modeKey] = 'MANUAL';
  updateActuatorsUI();

  if (fbDb) {
    // Write the manual status directly to greenhouse/live to override the sensor
    fbDb.ref('/greenhouse/live/' + firebaseKey).set(val ? 'ON' : 'OFF');
    
    // Set the mode to MANUAL at the root
    fbDb.ref('/' + modeKey).set('MANUAL').then(() => {
        addCtrlLog(type + ' ' + (val ? 'ON' : 'OFF') + ' (MANUAL MODE)');
        toast(type.toUpperCase() + ' set to ' + (val ? 'ON' : 'OFF') + ' (MANUAL)', 'success');
    }).catch((err) => {
        console.warn(err);
    });
  }
}

function setMode(type, mode) {
  const modeKey = type + 'Mode';
  liveData[modeKey] = mode;

  const espKey = 'esp' + type.charAt(0).toUpperCase() + type.slice(1);
  const statusKey = type === 'window' ? 'windowStatus' : type + 'Status';
  liveData[statusKey] = liveData[espKey];

  updateActuatorsUI();

  if (fbDb) {
    fbDb.ref('/' + modeKey).set(mode).then(() => {
        toast(type.toUpperCase() + ' restored to AUTO Mode', 'info');
    });
  }
}

function runPump() {
  const dur = parseInt(document.getElementById('pump-dur').value) || 3;
  liveData.pumpStatus = true;
  updateActuatorsUI();
  addCtrlLog(`Pump pulse ${dur}s → ON`);
  
  // Write ON to Firebase
  const writePump = (val) => {
    if (fbDb) {
      fbDb.ref('/pumpStatus').set(val).catch(() => {});
    } else {
      fetch(`${FB_BASE}/pumpStatus.json`, {
        method: 'PUT', body: JSON.stringify(val),
        headers: { 'Content-Type': 'application/json' }
      }).catch(() => {});
    }
  };
  
  writePump('ON');
  toast(`💧 Pump activated for ${dur} seconds...`, 'info');
  
  setTimeout(() => {
    liveData.pumpStatus = false;
    updateActuatorsUI();
    writePump('OFF');
    addCtrlLog(`Pump pulse ${dur}s → OFF (auto)`);
    toast('💧 Pump pulse completed', 'success');
  }, dur * 1000);
}

function renderSoilBarChart() {
  const el = document.getElementById('soilBarChart');
  if (!el) return;
  if (charts.soilBar) charts.soilBar.destroy();
  
  const hasData = plants.some(p => p.moisture !== null);
  if (!hasData) {
    charts.soilBar = new Chart(el.getContext('2d'), {
      type: 'bar',
      data: { labels: plants.map(p => `Sensor ${p.id}`), datasets: [{ data: [0,0,0,0,0,0], backgroundColor: ['rgba(200,200,200,0.3)'], borderRadius: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { min:0, max:100 } }, plugins: { legend: { display: false } } }
    });
    return;
  }
  
  const colors = plants.map(p => {
    if (p.moisture === null) return 'rgba(200,200,200,0.3)';
    return p.status==='dry'?'rgba(239,68,68,.8)':p.status==='wet'?'rgba(59,130,246,.8)':'rgba(34,197,94,.8)';
  });
  charts.soilBar = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: plants.map(p => `Sensor ${p.id} (${p.name})`),
      datasets: [{ data: plants.map(p => p.moisture || 0), backgroundColor: colors, borderRadius: 6 }]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { min:0, max:100 } } }
  });
}

// ═══════════════════════════════════════════
// ALERTS & THRESHOLD SAFETY ENGINE
// ═══════════════════════════════════════════
function checkThresholdAlerts() {
  if (liveData.temperature !== null && liveData.temperature > 26) addAlert('warning', `🌡️ High Temp Alert: ${liveData.temperature.toFixed(1)}°C > 26°C — Exhaust Fan Engaged`);
  if (liveData.humidity !== null && liveData.humidity < 50) addAlert('warning', `💧 Low Humidity Alert: ${liveData.humidity}% < 50%`);
  if (liveData.co2 !== null && liveData.co2 > 1000) addAlert('critical', `💨 Dangerous CO₂ Level: ${liveData.co2} ppm > 1000 ppm!`);
  if (liveData.smoke !== null && liveData.smoke > 700) addAlert('critical', `🔥 SMOKE DETECTED: ${liveData.smoke} ppm! Emergency Protocol & Alarm Active`);

  for (let i = 1; i <= 6; i++) {
    if (liveData[`soil${i}`] !== null && liveData[`soil${i}`] < 30) {
      addAlert('warning', `🌱 Soil Sensor ${i} (${plantMeta[i-1].name}) Dry: ${liveData[`soil${i}`].toFixed(1)}% < 30%`);
    }
  }
}

const alertDedupe = new Set();
function addAlert(type, msg) {
  const key = type + msg.slice(0, 35);
  if (alertDedupe.has(key)) return;
  alertDedupe.add(key);
  setTimeout(() => alertDedupe.delete(key), 45000);

  const a = { id: Date.now(), type, msg, time: new Date().toLocaleTimeString(), acked: false };
  alerts.unshift(a);
  if (alerts.length > 50) alerts.pop();
  alertUnread++;
  setTxt('ab', alertUnread); setTxt('nd', alertUnread);
  renderAlertFeed();
  renderAlertList();
  if (type === 'critical') toast(msg, 'error');
}

function renderAlertFeed() {
  const feed = document.getElementById('alert-feed');
  if (!feed) return;
  const items = alerts.slice(0, 4);
  if (items.length === 0) { feed.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:12px">All systems operating within safe parameters ✅</div>'; return; }
  feed.innerHTML = items.map(a => `
    <div class="al"><div class="al-dot ${a.type}"></div>
    <div style="flex:1"><div class="al-msg">${a.msg}</div><div class="al-time">${a.time}</div></div>
    ${!a.acked ? `<button class="al-ack" onclick="ack(${a.id})">Ack</button>` : '<span style="font-size:10px;color:var(--g4)">✓</span>'}
    </div>`).join('');
}

let _alertFilter = 'all';
function renderAlertList() {
  const list = document.getElementById('alert-list');
  if (!list) return;
  const items = _alertFilter === 'all' ? alerts : alerts.filter(a => a.type === _alertFilter);
  if (items.length === 0) { list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">No alerts logged ✅</div>'; return; }
  list.innerHTML = items.map(a => `
    <div class="al"><div class="al-dot ${a.type}"></div>
    <div style="flex:1"><div class="al-msg">${a.msg}</div><div class="al-time">${a.time}</div></div>
    <span class="badge ${a.type==='critical'?'r':a.type==='warning'?'y':'b'}">${a.type}</span>
    ${!a.acked ? `<button class="al-ack" onclick="ack(${a.id})">Ack</button>` : '<span style="font-size:10px;color:var(--g4);padding:0 6px">✓</span>'}
    </div>`).join('');
}

function ack(id) {
  const a = alerts.find(x => x.id === id);
  if (a) { a.acked = true; alertUnread = Math.max(0, alertUnread - 1); setTxt('ab', alertUnread || ''); setTxt('nd', alertUnread || '0'); renderAlertFeed(); renderAlertList(); }
}
function ackAll() { alerts.forEach(a => a.acked = true); alertUnread = 0; setTxt('ab',''); setTxt('nd','0'); renderAlertFeed(); renderAlertList(); toast('All alerts acknowledged', 'success'); }
function fAlert(t, btn) {
  _alertFilter = t;
  document.querySelectorAll('#page-alerts .btn').forEach(b => b.className = 'btn s');
  btn.className = 'btn p';
  renderAlertList();
}

// ═══════════════════════════════════════════
// TELEMETRY CHARTS ENGINE
// ═══════════════════════════════════════════
function initCharts() {
  const mc = document.getElementById('mainChart');
  if (mc) {
    charts.main = new Chart(mc.getContext('2d'), {
      type: 'line',
      data: { labels: [], datasets: [{ data: [], borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,.08)', fill: true, tension: .4, pointRadius: 2 }] },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  // Mini environment page charts
  ['ecT','ecH','ecL','ecC'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) {
      const c = ['#22c55e','#3b82f6','#f59e0b','#8b5cf6'][i];
      charts['mini'+i] = new Chart(el.getContext('2d'), {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: c, tension: .3, pointRadius: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
      });
    }
  });
}

function getChartSeriesForKey(key, fallback = []) {
  const fromHistory = historyRecords
    .slice(-24)
    .map(r => parseNum(r[key]))
    .filter(v => v !== null);
  if (fromHistory.length > 0) return fromHistory;
  return (fallback || []).filter(v => v !== null).slice(-24);
}

function getChartLabelsForSeries(fallbackLabels = [], count = 24) {
  if (historyRecords.length > 0) {
    return historyRecords.slice(-count).map(r => r.timeString || r.timestamp || '—');
  }
  return (fallbackLabels || []).slice(-count);
}

function updateCharts() {
  if (!charts.main) return;

  const mainSeries = getChartSeriesForKey(chartMode, historyBuffers[chartMode] || []);
  const mainLabels = getChartLabelsForSeries(timeLabels, mainSeries.length);

  charts.main.data.labels = mainLabels;
  charts.main.data.datasets[0].data = [...mainSeries];
  charts.main.update('none');

  const keys = ['temperature','humidity','ldr','co2'];
  keys.forEach((k, i) => {
    const c = charts['mini'+i];
    if (c) {
      const buf = getChartSeriesForKey(k, historyBuffers[k] || []);
      c.data.labels = getChartLabelsForSeries(timeLabels, buf.length);
      c.data.datasets[0].data = [...buf];
      c.update('none');
    }
  });
}

function switchChart(mode) {
  chartMode = mode;
  const colors = { temperature: '#22c55e', humidity: '#3b82f6', co2: '#8b5cf6', smoke: '#ef4444', ldr: '#f59e0b' };
  if (charts.main) { charts.main.data.datasets[0].borderColor = colors[mode]; updateCharts(); }
}

// ═══════════════════════════════════════════
// DATABASE INSPECTOR ENGINE
// ═══════════════════════════════════════════
function showDBTree(data) {
  const tree = document.getElementById('db-tree');
  const raw = document.getElementById('raw-json');
  
  let displayData = data;
  if (data && typeof data === 'object') {
    displayData = Object.assign({}, data);
    delete displayData.history;
    delete displayData.History;
    delete displayData.historyData;
    delete displayData.histories;
  }
  
  if (tree) tree.innerHTML = buildTreeHTML(displayData, 0);
  if (raw) raw.textContent = JSON.stringify(displayData, null, 2);
  setEl('db-status', '✅ Active DB', 'badge g');
}

function buildTreeHTML(obj, depth) {
  if (obj === null) return `<span style="color:#9e9e9e">null</span>`;
  if (typeof obj === 'boolean') return `<span style="color:${obj?'#4ade80':'#f87171'}">${obj}</span>`;
  if (typeof obj === 'number') return `<span style="color:#60a5fa">${obj}</span>`;
  if (typeof obj === 'string') return `<span style="color:#fcd34d">"${obj}"</span>`;
  if (typeof obj === 'object') {
    const indent = '  '.repeat(depth);
    const lines = Object.entries(obj).map(([k, v]) => `${indent}  <span style="color:#81c784;font-weight:700">"${k}"</span>: ${buildTreeHTML(v, depth+1)}`);
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return String(obj);
}

function copyJSON() {
  const text = document.getElementById('raw-json').textContent;
  navigator.clipboard.writeText(text).then(() => toast('Firebase JSON copied to clipboard!', 'success'));
}

// ═══════════════════════════════════════════
// DISEASE DETECTION SIMULATOR
// ═══════════════════════════════════════════
function triggerDiseaseAnalysis() {
  const pId = document.getElementById('disease-plant-sel').value || 1;
  const plant = plants.find(p => p.id == pId) || plants[0];

  toast(`🤖 Analyzing leaf photo for Plant ${plant.id} (${plant.name})…`, 'info');
  document.getElementById('disease-badge').textContent = 'Analyzing…';
  document.getElementById('disease-badge').className = 'badge y';

  setTimeout(() => {
    const diseases = [
      { name: 'Early Blight (Alternaria solani)', conf: '91.4%', sev: 'Moderate', tx: 'Apply copper-based fungicide spray. Remove lower infected foliage. Ensure fan circulation.' },
      { name: 'Powdery Mildew (Erysiphe cichoracearum)', conf: '88.7%', sev: 'Mild', tx: 'Spray neem oil or potassium bicarbonate solution. Reduce canopy crowding.' },
      { name: 'Bacterial Spot (Xanthomonas spp.)', conf: '94.1%', sev: 'High', tx: 'Apply bactericide/copper formulation. Avoid overhead watering completely.' },
      { name: 'Healthy Leaf Canopy', conf: '98.2%', sev: 'None', tx: 'No pathogen detected. Plant leaf tissue shows high chlorophyll density.' }
    ];

    const d = diseases[(plant.id - 1) % diseases.length];
    const isHealthy = d.sev === 'None';

    document.getElementById('disease-badge').textContent = isHealthy ? 'Healthy' : 'Disease Found';
    document.getElementById('disease-badge').className = isHealthy ? 'badge g' : 'badge r';

    document.getElementById('disease-result-box').innerHTML = `
      <div style="background:${isHealthy ? '#dcfce7' : '#fee2e2'};border-radius:10px;padding:16px;margin-bottom:14px;border:1px solid ${isHealthy ? '#86efac' : '#fca5a5'}">
        <div style="font-size:15px;font-weight:800;color:${isHealthy ? '#166534' : '#991b1b'};margin-bottom:4px">${isHealthy ? '✅ ' : '🦠 '}${d.name}</div>
        <div style="font-size:11.5px;color:${isHealthy ? '#14532d' : '#7f1d1d'};margin-bottom:8px">Confidence Score: <b>${d.conf}</b> · Severity: <b>${d.sev}</b></div>
        <div style="font-size:11.5px;color:${isHealthy ? '#166534' : '#991b1b'}">Subject: Plant ${plant.id} (${plant.name} - ${plant.variety})</div>
      </div>
      <div style="font-size:12.5px;font-weight:700;margin-bottom:6px">💊 Recommended Action</div>
      <div style="font-size:12px;color:var(--text);line-height:1.7;background:var(--g8);padding:12px;border-radius:8px;border:1px solid var(--g7)">${d.tx}</div>
      <button class="btn p" style="width:100%;margin-top:14px;justify-content:center" onclick="toast('Treatment logged to Firebase','success')">✅ Log Diagnostic Result</button>`;

    toast(`Analysis complete for Plant ${plant.id}`, 'success');
  }, 1200);
}

// ═══════════════════════════════════════════
// CONTROL LOG & NAVIGATION
// ═══════════════════════════════════════════
function addCtrlLog(action) {
  ctrlLog.unshift({ t: new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }), a: action, u: 'Operator' });
  const tbody = document.getElementById('ctrl-log');
  if (tbody) tbody.innerHTML = ctrlLog.slice(0, 10).map(l => `<tr><td>${l.t}</td><td>${l.a}</td><td>${l.u}</td></tr>`).join('');
}

function waterAll() {
  toast('💧 Initiating full greenhouse irrigation sequence…', 'info');
  for (let i = 1; i <= 6; i++) liveData[`soil${i}`] = Math.min(90, liveData[`soil${i}`] + 20);
  liveData.pumpStatus = true;
  updatePlantGrid();
  updateActuatorsUI();
  addCtrlLog('Water All Plants → EXECUTED');
  setTimeout(() => { liveData.pumpStatus = false; updateActuatorsUI(); toast('All 6 plant beds watered successfully ✅', 'success'); }, 3000);
}

function eStop() {
  liveData.fanStatus = false; liveData.pumpStatus = false; liveData.windowStatus = false; liveData.lightStatus = false;
  updateActuatorsUI();
  addCtrlLog('🛑 EMERGENCY STOP ALL ACTUATORS');
  toast('🛑 Emergency Stop Activated! All relays OFF', 'error');
}

const pageTitles = {
  dashboard:   ['Dashboard', 'Live data from Firebase Realtime Database'],
  analytics:   ['Analytics', 'Historical graphs & Avg, Max, Min metrics from 5-min history data'],
  plants:      ['Plant Management', '6x Capacitive Soil Moisture Sensors (Sensors 1 – 6)'],
  environment: ['Environmental Monitoring', 'DHT11 · LDR · MQ-135 · NPK Sensors'],
  controls:    ['Actuator Controls', 'Direct manual control & automation schedules'],
  alerts:      ['Alerts & Notifications', 'System safety triggers & warning feed'],
  database:    ['Firebase DB Explorer', 'Raw JSON inspector & REST API connection'],
  disease:     ['Disease Detection', 'AI plant health diagnosis & treatment plans'],
  settings:    ['System Settings', 'Firebase URL config & system parameters']
};

const loadedPages = new Set();

async function go(page) {
  if (!currentUser) {
    document.body.classList.remove('auth-logged-in');
    document.body.classList.add('auth-logged-out');
    return;
  }
  const adminOnlyPages = ['users','database','settings'];
  if (adminOnlyPages.includes(page) && !isAdminUser()) {
    toast('This section is for admin use only', 'warning');
    page = 'dashboard';
  }

  // Dynamically show page
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  
  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');
  
  const navItem = document.querySelector(`.nav-item[onclick*="'${page}'"]`);
  if (navItem) navItem.classList.add('active');

  const title = document.getElementById('ptitle');
  const sub = document.getElementById('psub');
  if (page === 'dashboard') {
    title.textContent = isAdminUser() ? 'Dashboard' : 'Farmer Monitoring';
    sub.textContent = 'Live telemetry from Firebase Realtime Database';
  } else if (page === 'analytics') {
    title.textContent = 'Analytics & Trends';
    sub.textContent = 'Historical data and graphical analysis';
    if(typeof renderHistoryCharts === 'function') renderHistoryCharts();
  } else if (page === 'database') {
    title.textContent = 'Database Snapshot';
    sub.textContent = 'Raw Firebase JSON tree view';
  } else if (page === 'alerts') {
    title.textContent = 'System Alerts';
    sub.textContent = 'Automated warnings and notifications';
  } else if (page === 'users') {
    title.textContent = 'Farmer Management';
    sub.textContent = 'Add, remove, or modify user access';
  } else if (page === 'controls') {
    title.textContent = 'Manual Operations';
    sub.textContent = 'Override automated systems';
  } else if (page === 'settings') {
    title.textContent = 'System Settings';
    sub.textContent = 'Configuration and preferences';
  } else {
    title.textContent = page.charAt(0).toUpperCase() + page.slice(1);
    sub.textContent = '';
  }
}

function envT(btn, sec) {
  document.querySelectorAll('#page-environment .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  ['et-rt','et-npk','et-thr'].forEach(id => { const el=document.getElementById(id); if(el) el.style.display='none'; });
  const map = { rt:'et-rt', npk:'et-npk', thr:'et-thr' };
  const el = document.getElementById(map[sec]); if (el) el.style.display = '';
}

function sTab(btn, sec) {
  document.querySelectorAll('#page-settings .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  ['st-g','st-fb','st-n','st-p'].forEach(id => { const el=document.getElementById(id); if(el) el.style.display='none'; });
  const el = document.getElementById('st-'+sec); if(el) el.style.display = '';
}

function setRefRate(v) {
  REFRESH_RATE = parseInt(v);
  setTxt('ref-rate', v.replace('000','')+'s');
  startAutoRefresh();
  toast(`Live refresh rate set to ${v/1000}s`, 'info');
}

function applyFBConfig() {
  const url = document.getElementById('fb-url-inp').value.trim();
  const path = document.getElementById('fb-path-inp').value.trim() || '/';
  if (url) {
    FB_BASE = url;
    setTxt('fb-url-disp', url.replace('https://','').split('.')[0]);
    
    // Reconnect Firebase SDK with new URL
    if (fbListenerRef) {
      fbListenerRef.off('value');
    }
    try {
      fbApp = firebase.initializeApp({ ...firebaseConfig, databaseURL: url }, 'secondary');
      fbDb = firebase.database(fbApp);
      fbListenerRef = fbDb.ref(path);
      fbListenerRef.on('value', (snapshot) => {
        const data = snapshot.val();
        if (data) {
          rawDB = data;
          processLiveDataFromSnapshot(data);
          showDBTree(data);
        }
      });
    } catch(e) {
      console.warn('Could not reconnect SDK, falling back to REST');
      startRESTFallback();
    }
    
    toast('Firebase endpoint updated! Reconnecting…', 'info');
    fetchDB();
  }
}

function saveThresholds() {
  toast('Safety thresholds updated & saved to Firebase', 'success');
}

// ═══════════════════════════════════════════
// UTILITY HELPERS & TOASTS
// ═══════════════════════════════════════════
function setTxt(id, v) { const el=document.getElementById(id); if(el) el.textContent=v; }
function setW(id, v) { const el=document.getElementById(id); if(el) el.style.width=v+'%'; }
function setEl(id, txt, cls) { const el=document.getElementById(id); if(!el)return; if(txt!==undefined) el.textContent=txt; if(cls) el.className=cls; }

function toast(msg, type='info') {
  const icons = { success:'✅', warning:'⚠️', error:'❌', info:'ℹ️' };
  const c = document.getElementById('tc');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span style="flex:1">${msg}</span>`;
  c.appendChild(el);
  setTimeout(() => { el.classList.add('tOut'); setTimeout(() => el.remove(), 280); }, 3800);
}

function startAutoRefresh() {
  // Auto-refresh is now handled by Firebase SDK real-time listener.
  // This is kept only as a manual refresh trigger for the DB inspector.
  if (refreshTimer) clearInterval(refreshTimer);
}

function manualRefresh() {
  document.getElementById('loading-spin').style.display = 'inline-block';
  // Re-fetch REST for DB Inspector
  fetchDB();
  toast('Manual refresh triggered', 'info');
  setTimeout(() => document.getElementById('loading-spin').style.display = 'none', 1500);
}

// ═══════════════════════════════════════════
// APPLICATION INITIALIZATION
// ═══════════════════════════════════════════


// ═══════════════════════════════════════════
// APPLICATION BOOTSTRAP (Modular Architecture)
// ═══════════════════════════════════════════
async function bootstrapApp() {
    try {
        // Load layout components
        const loginRes = await fetch('components/login.html');
        document.getElementById('login-container').innerHTML = await loginRes.text();
        
        const sbRes = await fetch('components/sidebar.html');
        document.getElementById('sidebar-container').innerHTML = await sbRes.text();

        // Pre-load all components so charting libraries find their DOM elements!
        const pages = ['dashboard', 'analytics', 'plants', 'environment', 'controls', 'alerts', 'users', 'database', 'disease', 'settings'];
        const contentDiv = document.getElementById('content');
        for (const page of pages) {
            const res = await fetch(`components/${page}.html`);
            const html = await res.text();
            const wrap = document.createElement('div');
            wrap.innerHTML = html;
            contentDiv.appendChild(wrap.firstElementChild);
            loadedPages.add(page);
        }

        // Initialize Firebase and all SDKs NOW
        initCharts();
        initHistoryEngine();
        updatePlantGrid();
        getUsers();
        restoreSession();
        renderUsersPage();
        initFirebaseSDK();
        startAutoRefresh();

        // Resume session if exists
        if (currentUser) {
            document.body.classList.add('auth-logged-in');
            document.body.classList.remove('auth-logged-out');
            updateAuthUI();
            go('dashboard');
            toast('✅ Smart Greenhouse Monitoring connected to Firebase!', 'success');
        } else {
            document.body.classList.remove('auth-logged-in');
            document.body.classList.add('auth-logged-out');
            toast('Please login to access the greenhouse dashboard', 'info');
        }
    } catch(e) {
        console.error("Failed to load components:", e);
        alert("Error loading app components! Please run the app using a local web server (e.g. run.bat).");
    }
}

document.addEventListener('DOMContentLoaded', bootstrapApp);