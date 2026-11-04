const $ = (selector) => document.querySelector(selector);
const SUPABASE_URL = "https://evxfkpcxpsxuuglkmphy.supabase.co";
const SUPABASE_KEY = "sb_publishable_O9vpdr13x-iKfX5-f1Bitg_T6Fwy7KB";
const API_URL = `${SUPABASE_URL}/functions/v1/personalbot-api`;

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; }
  catch { return fallback; }
}

const state = {
  tasks: readJson("pb_tasks", []), view: "tasks", session: readJson("pb_session", null),
  user: null, linked: false, authMode: "signin", refreshing: false,
};
const labels = {
  tasks: ["ՕՐՎԱ ՊԼԱՆ", "Առաջադրանքներ"],
  projects: ["ԱՇԽԱՏԱՆՔԱՅԻՆ ՏԱՐԱԾՔ", "Նախագծեր"],
  goals: ["ԵՐԿԱՐԱԺԱՄԿԵՏ ԱՌԱՋԸՆԹԱՑ", "Նպատակներ"],
  habits: ["ՕՐԱԿԱՆ ԿԱՅՈՒՆՈՒԹՅՈՒՆ", "Սովորություններ"],
  family: ["ԸՆՏԱՆԵԿԱՆ ԿԱՌԱՎԱՐՈՒՄ", "Ընտանիք"],
  reports: ["ԱՐԴՅՈՒՆՔՆԵՐ", "Հաշվետվություն"],
};

function localBackupKey() { return `pb_local_backup_${state.user?.id ?? ""}`; }
function importedKey() { return `pb_local_imported_${state.user?.id ?? ""}`; }

function save() {
  localStorage.setItem("pb_tasks", JSON.stringify(state.tasks));
  if (state.user && !state.linked) localStorage.setItem(localBackupKey(), JSON.stringify(state.tasks));
  render();
}

function setMessage(message, kind = "") {
  const el = $("#sync-status");
  el.textContent = message;
  el.className = `sync-status ${kind}`;
}

function authMessage(message) { $("#auth-message").textContent = message; }

async function authFetch(path, body, token = "") {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.msg || payload.message || payload.error_description || "Մուտքը չհաջողվեց։");
  return payload;
}

function storeSession(payload) {
  state.session = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000,
    user: payload.user,
  };
  localStorage.setItem("pb_session", JSON.stringify(state.session));
  state.user = payload.user;
}

async function accessToken() {
  if (!state.session?.access_token || !state.session?.refresh_token) throw new Error("Մուտքի ժամկետն ավարտվել է։ Մուտք գործիր կրկին։");
  if (state.session.expires_at - Date.now() > 45_000) return state.session.access_token;
  storeSession(await authFetch("token?grant_type=refresh_token", { refresh_token: state.session.refresh_token }));
  return state.session.access_token;
}

async function api(path, options = {}) {
  const token = await accessToken();
  const response = await fetch(`${API_URL}${path}`, {
    method: options.method || "GET",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = { not_linked: "Նախ կապիր Telegram հաշիվդ։", unauthorized: "Մուտքի ժամկետն ավարտվել է։ Մուտք գործիր կրկին։", already_linked: "Հաշիվն արդեն կապակցված է։" };
    throw new Error(messages[payload.error] || payload.message || "Համաժամեցումը չհաջողվեց։ Փորձիր կրկին։");
  }
  return payload;
}

function toLocalTask(task) {
  return { id: task.id, name: task.title, done: task.status === "completed", created: task.created_at, archivedAt: task.archived_at };
}

async function refreshCloudTasks(quiet = false) {
  if (!state.linked || state.refreshing) return;
  state.refreshing = true;
  try {
    const result = await api("/tasks");
    state.tasks = (result.tasks || []).map(toLocalTask);
    localStorage.setItem("pb_tasks", JSON.stringify(state.tasks));
    localStorage.setItem("pb_cloud_user", state.user.id);
    render();
    if (!quiet) setMessage("Առաջադրանքները համաժամացված են Telegram-ի հետ։", "success");
  } catch (error) {
    if (!quiet) setMessage(error.message, "error");
  } finally { state.refreshing = false; }
}

async function inspectLink() {
  if (!state.user || !state.session) return;
  const previousCloudUser = localStorage.getItem("pb_cloud_user");
  if (previousCloudUser && previousCloudUser !== state.user.id) state.tasks = [];
  if (!previousCloudUser && state.tasks.length && !localStorage.getItem(localBackupKey())) {
    localStorage.setItem(localBackupKey(), JSON.stringify(state.tasks));
  }
  try {
    const result = await api("/me");
    state.linked = result.linked === true;
    if (state.linked) {
      $("#account-state").textContent = `Կապակցված է՝ ${state.user.email || "Supabase հաշիվ"}`;
      $("#link-button").hidden = true;
      const backup = readJson(localBackupKey(), []);
      $("#import-local").hidden = !backup.length || Boolean(localStorage.getItem(importedKey()));
      await refreshCloudTasks(true);
      setMessage("Առաջադրանքները համաժամացվում են Telegram-ի հետ։", "success");
    } else {
      state.linked = false;
      $("#account-state").textContent = `Մուտք գործած է՝ ${state.user.email || "Supabase հաշիվ"}։ Հաջորդ քայլը Telegram-ի կապակցումն է։`;
      $("#link-button").hidden = false;
      $("#import-local").hidden = true;
      setMessage("Մինչ կապակցումը առաջադրանքները պահվում են այս սարքում։");
    }
    render();
  } catch (error) { setMessage(error.message, "error"); }
}

async function loadHashSession() {
  const query = new URLSearchParams(location.search);
  const tokenHash = query.get("token_hash");
  if (tokenHash) {
    const verified = await authFetch("verify", { token_hash: tokenHash, type: query.get("type") || "signup" });
    if (verified.access_token) {
      storeSession(verified);
      history.replaceState(null, "", location.pathname);
      return true;
    }
  }
  if (!location.hash.includes("access_token=")) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  const access = params.get("access_token"), refresh = params.get("refresh_token");
  if (!access || !refresh) return false;
  const user = await authFetch("user", undefined, access);
  storeSession({ access_token: access, refresh_token: refresh, expires_in: params.get("expires_in") || 3600, user });
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return true;
}

async function signInOrSignUp(event) {
  event.preventDefault();
  const email = $("#auth-email").value.trim(), password = $("#auth-password").value;
  const submit = $("#auth-submit");
  submit.disabled = true;
  try {
    if (state.authMode === "signup") {
      const result = await authFetch("signup", { email, password });
      if (!result.access_token) { authMessage("Հաստատման հղումն ուղարկվեց էլ․ փոստին։ Հաստատելուց հետո բացիր այս էջը կրկին։"); return; }
      storeSession(result);
      authMessage("Հաշիվը ստեղծվեց։");
    } else {
      storeSession(await authFetch("token?grant_type=password", { email, password }));
      authMessage("Մուտքը հաջողվեց։");
    }
    $("#auth-form").hidden = true;
    $("#account-panel").hidden = false;
    await inspectLink();
  } catch (error) { authMessage(error.message); }
  finally { submit.disabled = false; }
}

async function createLinkCode() {
  const button = $("#link-button");
  button.disabled = true;
  try {
    const result = await api("/link-codes", { method: "POST", body: {} });
    $("#link-code").textContent = result.code;
    $("#link-code-box").hidden = false;
    setMessage("Կոդը ստեղծվեց։ Telegram-ում ուղարկիր այն բոտին մինչև ժամկետի ավարտը։", "success");
  } catch (error) { setMessage(error.message, "error"); }
  finally { button.disabled = false; }
}

async function importLocalTasks() {
  const button = $("#import-local"), localTasks = readJson(localBackupKey(), []);
  if (!localTasks.length) return;
  if (!confirm(`Այս սարքում պահված ${localTasks.length} առաջադրանքը կավելացվեն քո Telegram հաշվի PersonalBot տվյալներին։ Շարունակե՞լ։`)) return;
  button.disabled = true;
  try {
    const result = await api("/tasks/import", { method: "POST", body: { tasks: localTasks } });
    const mapped = new Map((result.id_mapping || []).map((pair) => [pair.old_id, pair.new_id]));
    if (mapped.size) localStorage.setItem(localBackupKey(), JSON.stringify(localTasks.map((task) => ({ ...task, id: mapped.get(task.id) || task.id }))));
    localStorage.setItem(importedKey(), new Date().toISOString());
    localStorage.setItem(`pb_local_imported_backup_${state.user.id}`, JSON.stringify(localTasks));
    $("#import-local").hidden = true;
    await refreshCloudTasks(true);
    setMessage(`${result.imported || 0} առաջադրանք տեղափոխվեց։ Պահուստային պատճենը պահպանված է այս սարքում։`, "success");
  } catch (error) { setMessage(error.message, "error"); }
  finally { button.disabled = false; }
}

async function signOut() {
  try { if (state.session?.access_token) await authFetch("logout", {}, state.session.access_token); }
  catch { /* Local sign-out still clears this device's session. */ }
  localStorage.removeItem("pb_session");
  state.session = null; state.user = null; state.linked = false;
  $("#auth-form").hidden = false; $("#account-panel").hidden = true; $("#link-code-box").hidden = true;
  setMessage("Դուրս եկար։ Այս սարքի պահված տվյալները չեն ջնջվել։");
}

async function addTask() {
  const input = $("#task-input"), name = input.value.trim();
  if (!name) return;
  const task = { id: crypto.randomUUID(), name, done: false, created: new Date().toISOString() };
  if (state.linked) {
    try {
      const result = await api("/tasks", { method: "POST", body: { id: task.id, title: name, created_at: task.created } });
      state.tasks.unshift(toLocalTask(result.task)); input.value = ""; save();
      setMessage("Առաջադրանքը պահպանվեց և հասանելի է Telegram-ում։", "success");
    } catch (error) { setMessage(error.message, "error"); }
    return;
  }
  state.tasks.unshift(task); input.value = ""; save();
}

async function setTaskDone(id, done) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  if (state.linked) {
    try {
      const result = await api(`/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: done ? "completed" : "open" } });
      Object.assign(task, toLocalTask(result.task)); save(); setMessage("Առաջադրանքի կարգավիճակը համաժամացվեց։", "success");
    } catch (error) { render(); setMessage(error.message, "error"); }
    return;
  }
  task.done = done; save();
}

async function archiveTask(id) {
  if (state.linked) {
    try {
      await api(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
      state.tasks = state.tasks.filter((task) => task.id !== id); save(); setMessage("Առաջադրանքն արխիվացվեց։", "success");
    } catch (error) { setMessage(error.message, "error"); }
    return;
  }
  state.tasks = state.tasks.filter((task) => task.id !== id); save();
}

function render() {
  const visibleTasks = state.tasks.filter((task) => !task.archivedAt);
  const open = visibleTasks.filter((task) => !task.done).length, done = visibleTasks.length - open;
  $("#task-count").textContent = open; $("#task-sub").textContent = `${done} կատարված`;
  $("#section-kicker").textContent = labels[state.view][0]; $("#section-title").textContent = labels[state.view][1];
  $("#section-counter").textContent = state.view === "tasks" ? visibleTasks.length : "—";
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  const host = $("#view-content");
  if (state.view === "tasks") {
    host.innerHTML = visibleTasks.length
      ? '<div class="task-list">' + visibleTasks.map((task) => `<div class="task ${task.done ? "done" : ""}"><input type="checkbox" data-id="${task.id}" ${task.done ? "checked" : ""} aria-label="Կատարել"><span class="task-name"></span><button class="delete" data-delete="${task.id}" aria-label="Արխիվացնել">×</button></div>`).join("") + "</div>"
      : '<div class="empty">Առաջադրանքներ դեռ չկան։ Գրիր առաջինը վերևի դաշտում։</div>';
    host.querySelectorAll(".task-name").forEach((node, index) => { node.textContent = visibleTasks[index].name; });
    host.querySelectorAll("[data-id]").forEach((element) => element.addEventListener("change", () => setTaskDone(element.dataset.id, element.checked)));
    host.querySelectorAll("[data-delete]").forEach((element) => element.addEventListener("click", () => archiveTask(element.dataset.delete)));
  } else {
    const descriptions = {
      projects: "Նախագծերի կառավարումը կմիանա ընդհանուր PersonalBot API-ին։",
      goals: "Նպատակների տվյալները կկցվեն գործող PersonalBot համակարգին։",
      habits: "Սովորությունների գրանցումն ու առաջընթացը կհամաժամացվեն Telegram բոտի հետ։",
      family: "Ընտանիքի անդամների և հարցումների կառավարումը կմիանա ընդհանուր համակարգին։",
      reports: "Օրական ամփոփում՝ 22:00։ Շաբաթական ամփոփում՝ կիրակի 21:00։",
    };
    host.innerHTML = `<div class="notice">${descriptions[state.view]}<br><br>Այս բաժինը դեռ միացված չէ տվյալների բազային։</div>`;
  }
}

function showAccount() {
  const signedIn = Boolean(state.session && state.user);
  $("#auth-form").hidden = signedIn; $("#account-panel").hidden = !signedIn;
  $("#link-button").hidden = state.linked;
  $("#auth-title").textContent = signedIn ? "Հաշվի կարգավիճակ" : state.authMode === "signup" ? "Ստեղծել PersonalBot հաշիվ" : "Մուտք գործել PersonalBot";
  $("#auth-submit").textContent = state.authMode === "signup" ? "Ստեղծել հաշիվ" : "Մուտք գործել";
  $("#auth-mode").textContent = state.authMode === "signup" ? "Արդեն հաշիվ ունե՞ս․ մուտք գործել" : "Ստեղծել հաշիվ";
  $("#auth-mode").hidden = signedIn;
}

async function initialize() {
  $("#today").textContent = new Intl.DateTimeFormat("hy-AM", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  $("#add-task").addEventListener("click", addTask);
  $("#task-input").addEventListener("keydown", (event) => { if (event.key === "Enter") addTask(); });
  document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => { state.view = button.dataset.view; render(); }));
  $("#auth-form").addEventListener("submit", signInOrSignUp);
  $("#auth-mode").addEventListener("click", () => { state.authMode = state.authMode === "signin" ? "signup" : "signin"; showAccount(); });
  $("#link-button").addEventListener("click", createLinkCode);
  $("#import-local").addEventListener("click", importLocalTasks);
  $("#signout").addEventListener("click", signOut);
  try { await loadHashSession(); } catch { authMessage("Էլ․ փոստի հաստատումը չհաջողվեց։ Մուտք գործիր կրկին։"); }
  if (state.session?.access_token) {
    state.user = state.session.user;
    try { await accessToken(); } catch { localStorage.removeItem("pb_session"); state.session = null; state.user = null; }
  }
  showAccount(); render();
  if (state.user) await inspectLink();
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  window.setInterval(() => {
    if (state.linked && document.visibilityState === "visible") refreshCloudTasks(true);
    else if (state.user && !state.linked && document.visibilityState === "visible") inspectLink();
  }, 12_000);
  window.addEventListener("focus", () => { if (state.linked) refreshCloudTasks(true); else if (state.user) inspectLink(); });
}

initialize();

