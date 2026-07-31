/* =============================================
   ERA DAILY ROUTINE TRACKER - App Logic
   Firebase v9 Modular SDK
   ============================================= */

// ── Firebase v9 imports ──────────────────────────────────────────────────────
import { auth, database } from './firebase.js';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut as firebaseSignOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  ref,
  set,
  update,
  get,
  onValue,
  off,
  child
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ===================== STATE =====================
let currentUser = null;
let userUid = null;
/** Unsubscribe functions returned by onValue() – stored so we can detach all */
let dbUnsubscribers = [];

/** tasks[] is the in-memory array the whole app uses. Derived from the
 *  Firebase object map { taskId: taskObject } on every sync. */
let tasks = [];
let routines = {"Morning":[],"Afternoon":[],"Evening":[],"Night":[]};
let notes = {"daily":"","shopping":"","ideas":"","reminders":""};
let dateNotes = {};
let currentTheme = "dark";

// ── Convert between array <-> Firebase object map ────────────────────────────
function tasksToMap(arr) {
  const map = {};
  arr.forEach(t => { if (t && t.id) map[t.id] = t; });
  return map;
}
function mapToTasks(map) {
  if (!map) return [];
  return Object.values(map).filter(Boolean);
}

/** Convenience: return a database ref for the current user's path */
function userRef(path) {
  return ref(database, `users/${userUid}/${path}`);
}

// ── Detach all real-time listeners ───────────────────────────────────────────
function detachAllListeners() {
  dbUnsubscribers.forEach(unsub => { try { unsub(); } catch(_) {} });
  dbUnsubscribers = [];
}

// ---- Auth UI State ----
let isAuthModeLogin = true;

function toggleAuthMode() {
  isAuthModeLogin = !isAuthModeLogin;
  document.getElementById("authTitle").textContent       = isAuthModeLogin ? "Welcome Back"          : "Create Account";
  document.getElementById("authActionBtn").textContent   = isAuthModeLogin ? "Sign In"               : "Sign Up";
  document.getElementById("authToggleText").textContent  = isAuthModeLogin ? "Don't have an account?" : "Already have an account?";
  document.getElementById("authToggleBtn").textContent   = isAuthModeLogin ? "Sign Up"               : "Sign In";
}

function formatAuthError(err) {
  const code = err.code || "";
  console.error("Firebase Auth Error:", err);
  if (code === "auth/operation-not-allowed") {
    return "⚠️ Email/Password Auth is disabled in Firebase Console! Go to Firebase Console -> Authentication -> Sign-in method and enable Email/Password.";
  }
  if (code === "auth/unauthorized-domain") {
    return "⚠️ Domain not authorized! Add your domain in Firebase Console -> Authentication -> Settings -> Authorized Domains.";
  }
  if (code === "auth/invalid-credential" || code === "auth/user-not-found" || code === "auth/wrong-password") {
    return "Invalid email or password. If you don't have an account yet, click 'Sign Up' below.";
  }
  if (code === "auth/email-already-in-use") {
    return "An account with this email already exists. Please click 'Sign In' to log in.";
  }
  if (code === "auth/weak-password") {
    return "Password must be at least 6 characters long.";
  }
  return err.message || "Authentication failed. Please try again.";
}

async function handleAuthAction() {
  const email = document.getElementById("authEmail").value.trim();
  const pass  = document.getElementById("authPassword").value;
  if (!email || !pass) { showToast("Please enter email and password.", "error"); return; }

  const btn = document.getElementById("authActionBtn");
  btn.disabled = true;
  btn.textContent = "Please wait...";
  const restore = () => { btn.disabled = false; btn.textContent = isAuthModeLogin ? "Sign In" : "Sign Up"; };

  try {
    if (isAuthModeLogin) {
      try {
        await signInWithEmailAndPassword(auth, email, pass);
      } catch (err) {
        // If user not found / invalid credential, auto-attempt account creation
        if (err.code === "auth/user-not-found" || err.code === "auth/invalid-credential") {
          try {
            await createUserWithEmailAndPassword(auth, email, pass);
            showToast("Account created and signed in successfully! 🎉", "success");
            return;
          } catch (createErr) {
            if (createErr.code !== "auth/email-already-in-use") {
              throw createErr;
            }
          }
        }
        throw err;
      }
    } else {
      await createUserWithEmailAndPassword(auth, email, pass);
      showToast("Account created and signed in successfully! 🎉", "success");
    }
  } catch (err) {
    showToast(formatAuthError(err), "error");
    restore();
  }
}

function handleSignInWithGoogle() {
  const provider = new GoogleAuthProvider();
  signInWithPopup(auth, provider)
    .catch(err => showToast(formatAuthError(err), "error"));
}

function handleSignOut() {
  detachAllListeners();
  firebaseSignOut(auth);
}

// ── Real-time per-path listeners ─────────────────────────────────────────────
function listenToDatabase() {
  const onDbError = (err) => {
    console.error("Firebase Database error:", err);
    if (err.code === "PERMISSION_DENIED" || err.message?.includes("PERMISSION_DENIED")) {
      showToast("⚠️ Realtime Database Permission Denied! Check your Firebase Console Rules.", "error");
    }
  };

  // Tasks
  const unsubTasks = onValue(userRef('tasks'), snap => {
    tasks = mapToTasks(snap.val());
    renderAll();
    if (document.getElementById("page-calendar")?.classList.contains("active")) renderCalendar();
  }, onDbError);

  // Notes
  const unsubNotes = onValue(userRef('notes'), snap => {
    const data = snap.val();
    if (data) { notes = data; loadNotes(); }
  }, onDbError);

  // Date Notes
  const unsubDateNotes = onValue(userRef('dateNotes'), snap => {
    dateNotes = snap.val() || {};
    loadDateNotesForSelectedDate();
  }, onDbError);

  // Routines
  const unsubRoutines = onValue(userRef('routines'), snap => {
    const data = snap.val();
    if (data) routines = data;
  }, onDbError);

  // Settings / theme
  const unsubTheme = onValue(userRef('settings/theme'), snap => {
    const theme = snap.val() || "dark";
    if (theme !== currentTheme) { currentTheme = theme; applyTheme(theme, false); }
  }, onDbError);

  dbUnsubscribers = [unsubTasks, unsubNotes, unsubDateNotes, unsubRoutines, unsubTheme];
}

// ── One-time migration from localStorage ────────────────────────────────────
async function migrateDataIfNeeded() {
  const migSnap = await get(userRef('migrated'));
  if (migSnap.exists()) return;   // already migrated

  const localTasks     = JSON.parse(localStorage.getItem("era_tasks")      || "[]");
  const localNotes     = JSON.parse(localStorage.getItem("era_notes")      || "{}");
  const localDateNotes = JSON.parse(localStorage.getItem("era_date_notes") || "{}");
  const localTheme     = localStorage.getItem("era_theme") || "dark";

  const upd = { migrated: true, settings: { theme: localTheme } };
  if (localTasks.length > 0)             upd.tasks     = tasksToMap(localTasks);
  if (Object.keys(localNotes).length)    upd.notes     = localNotes;
  if (Object.keys(localDateNotes).length) upd.dateNotes = localDateNotes;

  await update(ref(database, `users/${userUid}`), upd);
  showToast("Local data migrated to cloud! ☁️", "success");
}

// ===================== SAVE HELPERS =====================
function saveTasks()     { if (userUid) set(userRef('tasks'),     tasksToMap(tasks)); }
function saveRoutines()  { if (userUid) set(userRef('routines'),  routines); }
function saveNoteData()  { if (userUid) set(userRef('notes'),     notes); }
function saveDateNotes() { if (userUid) set(userRef('dateNotes'), dateNotes); }
function saveTheme(t)    { if (userUid) set(userRef('settings/theme'), t); }

// Selected category in the add-task form
let selectedCategory = "Morning";
let editSelectedCategory = "Morning";

// ===================== CALENDAR STATE =====================
const now_init = new Date();
let calYear = now_init.getFullYear();
let calMonth = now_init.getMonth();  // 0-indexed
let calSelectedDate = null;           // "YYYY-MM-DD"
let calFilter = "all";

// ===================== TODAY'S TASKS STATE =====================
let todaySelectedDate = now_init.toISOString().split("T")[0];
let currentQuickFilter = "today"; // "today", "tomorrow", "week", "upcoming", "all"

// ===================== INIT =====================
document.addEventListener("DOMContentLoaded", () => {
  // Auth state listener
  onAuthStateChanged(auth, user => {
    if (user) {
      currentUser = user;
      userUid = user.uid;
      document.getElementById("authOverlay").classList.add("hidden");
      showToast("Signed in as " + (user.displayName || user.email), "success");

      migrateDataIfNeeded();
      listenToDatabase();
    } else {
      currentUser = null;
      userUid = null;
      detachAllListeners();
      document.getElementById("authOverlay").classList.remove("hidden");

      // Reset state
      tasks = [];
      notes = {"daily":"","shopping":"","ideas":"","reminders":""};
      dateNotes = {};
      renderAll();
      loadNotes();
    }
  });

  applyTheme(currentTheme, false);
  initClock();
  initDateFields();
  initCategoryPills();
  initNavigation();
  updateTodayPageHeader();
  renderAll();
  // Enter key to submit auth form
  document.getElementById("authPassword")?.addEventListener("keydown", e => { if (e.key === "Enter") handleAuthAction(); });
  document.getElementById("authEmail")?.addEventListener("keydown", e => { if (e.key === "Enter") handleAuthAction(); });
});

// ── Expose functions to window for HTML onclick= handlers ────────────────
window.toggleAuthMode        = toggleAuthMode;
window.handleAuthAction      = handleAuthAction;
window.signInWithGoogle      = handleSignInWithGoogle;
window.signOut               = handleSignOut;
window.addTask               = addTask;
window.toggleTask            = toggleTask;
window.openEditTask          = openEditTask;
window.saveEditTask          = saveEditTask;
window.deleteTask            = deleteTask;
window.openCopyTask          = openCopyTask;
window.addCopyDate           = addCopyDate;
window.removeCopyDate        = removeCopyDate;
window.executeCopyTask       = executeCopyTask;
window.copyYesterdaysTasks   = copyYesterdaysTasks;
window.openCopyFromModal     = openCopyFromModal;
window.executeCopyFrom       = executeCopyFrom;
window.dashCopyYesterday     = dashCopyYesterday;
window.dashOpenCopyFrom      = dashOpenCopyFrom;
window.saveNote              = saveNote;
window.setTheme              = setTheme;
window.confirmDeleteAll      = confirmDeleteAll;
window.exportData            = exportData;
window.importData            = importData;
window.exportToPDF           = exportToPDF;
window.filterTasks           = filterTasks;
window.setQuickFilter        = setQuickFilter;
window.prevTodayDate         = prevTodayDate;
window.nextTodayDate         = nextTodayDate;
window.onTodayDateSelect     = onTodayDateSelect;
window.saveDateNoteForSelectedDate = saveDateNoteForSelectedDate;
window.openModal             = openModal;
window.closeModal            = closeModal;
window.prevMonth             = prevMonth;
window.nextMonth             = nextMonth;
window.selectCalDate         = selectCalDate;
window.setCalFilter          = setCalFilter;
window.addCalendarTask       = addCalendarTask;
window.calToggleTask         = calToggleTask;
window.calDeleteTask         = calDeleteTask;
window.toggleSidebar         = toggleSidebar;
window.navigateTo            = navigateTo;
window.openRoutineModal      = openRoutineModal;
window.saveRoutineItem       = saveRoutineItem;


// ===================== CLOCK =====================
function initClock() {
  updateClock();
  setInterval(updateClock, 1000);
}

function updateClock() {
  const now = new Date();
  const hours = now.getHours();
  const mins = String(now.getMinutes()).padStart(2, "0");
  const secs = String(now.getSeconds()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 || 12;

  const timeEl = document.getElementById("timeDisplay");
  if (timeEl) timeEl.textContent = `${String(h12).padStart(2,"0")}:${mins}:${secs} ${ampm}`;

  const greetEl = document.getElementById("greeting");
  if (greetEl) {
    const gr = hours < 12 ? "Good Morning!" : hours < 17 ? "Good Afternoon!" : hours < 20 ? "Good Evening!" : "Good Night!";
    greetEl.textContent = gr;
  }

  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  ["headerDate", "todayPageDate"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = dateStr;
  });
}

// ===================== DATE DEFAULTS =====================
function initDateFields() {
  const today = new Date().toISOString().split("T")[0];
  const tf = document.getElementById("taskDate");
  if (tf) tf.value = today;
}

// ===================== NAVIGATION =====================
function initNavigation() {
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", e => {
      e.preventDefault();
      navigateTo(item.dataset.page);
      closeSidebar();
    });
  });
}

function toggleSidebar() {
  document.body.classList.toggle('sidebar-open');
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
}

function navigateTo(page) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));

  const pageEl = document.getElementById("page-" + page);
  const navEl = document.getElementById("nav-" + page);
  if (pageEl) pageEl.classList.add("active");
  if (navEl) navEl.classList.add("active");

  if (page === "today") renderTaskTable();
  if (page === "dashboard") renderDashboard();
  if (page === "calendar") renderCalendar();
}

// ===================== CATEGORY PILLS =====================
function initCategoryPills() {
  setupPills("categoryPills", (cat) => { selectedCategory = cat; });
  setupPills("editCategoryPills", (cat) => { editSelectedCategory = cat; });
}

function setupPills(containerId, onSelect) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll(".pill").forEach(pill => {
    pill.addEventListener("click", () => {
      container.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      onSelect(pill.dataset.cat);
    });
  });
}

function setPillActive(containerId, cat) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll(".pill").forEach(p => {
    p.classList.toggle("active", p.dataset.cat === cat);
  });
}

// ===================== SAVE HELPERS =====================
// Tasks are stored as an id-keyed object map in Firebase for atomic updates
function saveTasks()     { if (userUid) set(userRef('tasks'),     tasksToMap(tasks)); }
function saveRoutines()  { if (userUid) set(userRef('routines'),  routines); }
function saveNoteData()  { if (userUid) set(userRef('notes'),     notes); }
function saveDateNotes() { if (userUid) set(userRef('dateNotes'), dateNotes); }

// ===================== ROUTINE MODAL =====================
function openRoutineModal(section, editId) {
  document.getElementById('routineModalSection').value = section || '';
  document.getElementById('routineModalEditId').value  = editId  || '';
  document.getElementById('routineItemName').value     = '';
  document.getElementById('routineItemTime').value     = '';
  document.getElementById('routineModalTitle').textContent = editId ? 'Edit Routine' : 'Add Routine';

  if (editId) {
    const item = (routines[section] || []).find(r => r.id === editId);
    if (item) {
      document.getElementById('routineItemName').value = item.name || '';
      document.getElementById('routineItemTime').value = item.time || '';
    }
  }
  document.getElementById('routineModal').classList.add('active');
}

function saveRoutineItem() {
  const name    = document.getElementById('routineItemName').value.trim();
  const time    = document.getElementById('routineItemTime').value;
  const section = document.getElementById('routineModalSection').value || 'Morning';
  const editId  = document.getElementById('routineModalEditId').value;

  if (!name) { showToast('Please enter a routine name.', 'error'); return; }

  if (!routines[section]) routines[section] = [];

  if (editId) {
    // Edit existing
    const idx = routines[section].findIndex(r => r.id === editId);
    if (idx !== -1) routines[section][idx] = { id: editId, name, time };
  } else {
    // Add new
    routines[section].push({ id: Date.now().toString(), name, time });
  }

  saveRoutines();
  closeModal('routineModal');
  showToast(editId ? 'Routine updated!' : 'Routine added!', 'success');
}

// ===================== ADD TASK =====================
function addTask() {
  const name = document.getElementById("taskName").value.trim();
  if (!name) { showToast("Please enter a task name.", "error"); return; }

  const date = document.getElementById("taskDate").value;
  const time = document.getElementById("taskTime").value;
  const priority = document.getElementById("taskPriority").value;
  const taskNotes = (document.getElementById("taskNotes")?.value || "").trim();

  const task = {
    id: Date.now().toString(),
    name,
    date,
    time,
    priority,
    category: selectedCategory || "Morning",
    notes: taskNotes,
    status: "Pending",
    createdAt: new Date().toISOString()
  };

  tasks.push(task);
  saveTasks();

  // Reset form
  document.getElementById("taskName").value = "";
  document.getElementById("taskTime").value = "";
  document.getElementById("taskPriority").value = "Medium";
  if (document.getElementById("taskNotes")) document.getElementById("taskNotes").value = "";
  initDateFields();
  selectedCategory = "Morning";

  renderDashboard();
  if (document.getElementById("page-today").classList.contains("active")) renderTaskTable();
  if (document.getElementById("page-calendar").classList.contains("active")) renderCalendar();
  showToast("Task added successfully!", "success");
}

// ===================== RENDER ALL =====================
function renderAll() {
  renderDashboard();
  renderTaskTable();
  updateStats();
}

// ===================== UPDATE STATS =====================
function updateStats() {
  const total = tasks.length;
  const done = tasks.filter(t => t.status === "Completed").length;
  const pending = tasks.filter(t => t.status !== "Completed").length;
  const high = tasks.filter(t => t.status !== "Completed" && t.priority === "High").length;
  const medium = tasks.filter(t => t.status !== "Completed" && t.priority === "Medium").length;
  const low = tasks.filter(t => t.status !== "Completed" && t.priority === "Low").length;

  setText("statTotal", total);
  setText("statDone", done);
  setText("statPending", pending);
  setText("statHigh", high);
  setText("statMedium", medium);
  setText("statLow", low);

  // Progress Bar
  const progressText = document.getElementById("progressText");
  const progressBarFill = document.getElementById("progressBarFill");
  const progressPercentage = document.getElementById("progressPercentage");
  
  if (progressText && progressBarFill && progressPercentage) {
    progressText.textContent = `${done} / ${total} Tasks Completed`;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressBarFill.style.width = pct + "%";
    progressPercentage.textContent = pct + "%";
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ===================== DASHBOARD TASK LIST =====================
function renderDashboard() {
  updateStats();
  
  // Today's Tasks Preview
  const container = document.getElementById("dashboardTaskList");
  if (container) {
    const today = new Date().toISOString().split("T")[0];
    const todayTasks = tasks.filter(t => t.date === today && t.status !== "Completed").slice(0, 5);

    if (todayTasks.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No pending tasks for today!</p></div>';
    } else {
      container.innerHTML = todayTasks.map(t => `
        <div class="dash-task-item">
          <input type="checkbox" class="task-checkbox" onchange="toggleTask('${t.id}')" />
          <span class="dash-task-name">${escHtml(t.name)}</span>
          <div class="dash-task-meta">
            ${t.time ? `<span>${formatTime12(t.time)}</span>` : ""}
            <span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span>
          </div>
        </div>
      `).join("");
    }
  }

  // Upcoming Tasks
  const upcomingContainer = document.getElementById("upcomingTaskList");
  if (upcomingContainer) {
    const today = new Date().toISOString().split("T")[0];
    const upcomingTasks = tasks
      .filter(t => t.status !== "Completed" && t.date && t.date >= today)
      .sort((a, b) => {
        const dA = new Date(a.date + "T" + (a.time || "23:59") + ":00");
        const dB = new Date(b.date + "T" + (b.time || "23:59") + ":00");
        return dA - dB;
      })
      .slice(0, 5);

    if (upcomingTasks.length === 0) {
      upcomingContainer.innerHTML = '<div class="empty-state"><p>No upcoming tasks.</p></div>';
    } else {
      upcomingContainer.innerHTML = upcomingTasks.map(t => `
        <div class="dash-task-item">
          <span class="dash-task-name" style="flex:1;">${escHtml(t.name)}</span>
          <div class="dash-task-meta">
            <span>${formatDate(t.date)}</span>
            ${t.time ? `<span>${formatTime12(t.time)}</span>` : ""}
            <span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span>
          </div>
        </div>
      `).join("");
    }
  }
}

// ===================== TASK TABLE =====================
function renderTaskTable(filtered) {
  if (filtered === undefined) {
    filterTasks();
    return;
  }
  const list = filtered;
  const tbody = document.getElementById("taskTableBody");
  const empty = document.getElementById("emptyTasks");
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = "";
    if (empty) empty.style.display = "flex";
    return;
  }
  if (empty) empty.style.display = "none";

  tbody.innerHTML = list.map(t => {
    const isDone = t.status === "Completed";
    return `
    <tr class="${isDone ? "completed-row" : ""}">
      <td data-label="Done">
        <input type="checkbox" class="task-checkbox" ${isDone ? "checked" : ""} onchange="toggleTask('${t.id}')" />
      </td>
      <td data-label="Task Name">
        <span class="task-name ${isDone ? "done" : ""}">${escHtml(t.name)}</span>
        ${t.notes ? `<div class="task-notes-hint" style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">📝 ${escHtml(t.notes)}</div>` : ""}
      </td>
      <td data-label="Date">${t.date ? formatDate(t.date) : "—"}</td>
      <td data-label="Time">${t.time ? formatTime12(t.time) : "—"}</td>
      <td data-label="Category"><span class="cat-badge">${catIcon(t.category)} ${t.category}</span></td>
      <td data-label="Priority"><span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span></td>
      <td data-label="Status">
        <span class="status-badge ${isDone ? "status-done" : "status-pending"}" style="${isDone ? "background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid rgba(34,197,94,0.3)" : ""}">
          ${isDone ? "Completed" : "Not Completed"}
        </span>
      </td>
      <td data-label="Actions" style="text-align: right;">
        <div class="action-btns" style="justify-content: flex-end;">
          <button class="btn-icon" title="Copy" onclick="openCopyTask('${t.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
          <button class="btn-icon" title="Edit" onclick="openEditTask('${t.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-icon delete" title="Delete" onclick="deleteTask('${t.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join("");
}

// ===================== TODAY'S TASKS NAV =====================
function updateTodayPageHeader() {
  const displayEl = document.getElementById("todayPageDate");
  const pickerEl = document.getElementById("todayDatePicker");
  if (!displayEl || !pickerEl) return;

  pickerEl.value = todaySelectedDate;
  const d = new Date(todaySelectedDate + "T00:00:00");
  displayEl.textContent = d.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  loadDateNotesForSelectedDate();
}

function loadDateNotesForSelectedDate() {
  const el = document.getElementById("todayDateNotes");
  const sub = document.getElementById("dateNoteSubtitle");
  if (el) el.value = dateNotes[todaySelectedDate] || "";
  if (sub) sub.textContent = "Notes for " + formatDate(todaySelectedDate);
}

function saveDateNoteForSelectedDate() {
  const el = document.getElementById("todayDateNotes");
  if (!el) return;
  dateNotes[todaySelectedDate] = el.value;
  saveDateNotes();
}

function prevTodayDate() {
  const d = new Date(todaySelectedDate + "T00:00:00");
  d.setDate(d.getDate() - 1);
  todaySelectedDate = d.toISOString().split("T")[0];
  setQuickFilter("custom");
}

function nextTodayDate() {
  const d = new Date(todaySelectedDate + "T00:00:00");
  d.setDate(d.getDate() + 1);
  todaySelectedDate = d.toISOString().split("T")[0];
  setQuickFilter("custom");
}

function onTodayDateSelect() {
  const val = document.getElementById("todayDatePicker").value;
  if (val) {
    todaySelectedDate = val;
    setQuickFilter("custom");
  }
}

function setQuickFilter(filter) {
  currentQuickFilter = filter;
  document.querySelectorAll("#todayQuickFilters .pill").forEach(p => {
    p.classList.toggle("active", p.dataset.qf === filter);
  });
  
  const today = new Date();
  if (filter === "today") todaySelectedDate = today.toISOString().split("T")[0];
  else if (filter === "tomorrow") {
    const tmrw = new Date(today);
    tmrw.setDate(tmrw.getDate() + 1);
    todaySelectedDate = tmrw.toISOString().split("T")[0];
  }
  
  updateTodayPageHeader();
  filterTasks();
}

// ===================== FILTER / SEARCH =====================
function filterTasks() {
  const search = (document.getElementById("searchInput")?.value || "").toLowerCase();
  const priority = document.getElementById("filterPriority")?.value || "";
  const category = document.getElementById("filterCategory")?.value || "";
  const sortBy = document.getElementById("sortSelect")?.value || "date";

  const todayStr = new Date().toISOString().split("T")[0];
  const todayObj = new Date(todayStr + "T00:00:00");

  let filtered = tasks.filter(t => {
    const matchName = t.name.toLowerCase().includes(search) || (t.notes || "").toLowerCase().includes(search);
    const matchPri = priority ? t.priority === priority : true;
    const matchCat = category ? t.category === category : true;
    
    let matchDate = true;
    if (currentQuickFilter === "today" || currentQuickFilter === "tomorrow" || currentQuickFilter === "custom") {
      matchDate = t.date === todaySelectedDate;
    } else if (currentQuickFilter === "week") {
      if (!t.date) { matchDate = false; }
      else {
        const tDate = new Date(t.date + "T00:00:00");
        const diff = (tDate - todayObj) / (1000 * 60 * 60 * 24);
        matchDate = diff >= 0 && diff <= 7;
      }
    } else if (currentQuickFilter === "upcoming") {
      if (!t.date) { matchDate = false; }
      else {
        const tDate = new Date(t.date + "T00:00:00");
        matchDate = tDate > todayObj;
      }
    } else if (currentQuickFilter === "all") {
      matchDate = true;
    }

    return matchName && matchPri && matchCat && matchDate;
  });

  // Sorting
  filtered.sort((a, b) => {
    if (sortBy === "date") return (a.date || "").localeCompare(b.date || "");
    if (sortBy === "time") return (a.time || "").localeCompare(b.time || "");
    if (sortBy === "priority") {
      const p = { "High": 1, "Medium": 2, "Low": 3 };
      return (p[a.priority] || 4) - (p[b.priority] || 4);
    }
    if (sortBy === "category") return (a.category || "").localeCompare(b.category || "");
    return 0;
  });

  renderTaskTable(filtered);
}

// ===================== TOGGLE TASK =====================
function toggleTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  if (task.status === "Completed") {
    task.status = "Pending";
    showToast("Task marked as not completed", "info");
  } else {
    task.status = "Completed";
    const now = new Date();
    task.completedDate = now.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    task.completedTime = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    showToast("Task completed!", "success");
  }

  saveTasks();
  renderAll();
  if (document.getElementById("page-calendar")?.classList.contains("active")) renderCalendar();
}

// ===================== EDIT TASK =====================
function openEditTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  document.getElementById("editTaskId").value = task.id;
  document.getElementById("editTaskName").value = task.name;
  document.getElementById("editTaskDate").value = task.date;
  document.getElementById("editTaskTime").value = task.time;
  document.getElementById("editTaskPriority").value = task.priority;
  if (document.getElementById("editTaskNotes")) document.getElementById("editTaskNotes").value = task.notes || "";
  
  editSelectedCategory = task.category;
  setPillActive("editCategoryPills", editSelectedCategory);
  
  openModal("editModal");
}

function saveEditTask() {
  const id = document.getElementById("editTaskId").value;
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  const name = document.getElementById("editTaskName").value.trim();
  if (!name) { showToast("Name cannot be empty.", "error"); return; }

  task.name = name;
  task.date = document.getElementById("editTaskDate").value;
  task.time = document.getElementById("editTaskTime").value;
  task.priority = document.getElementById("editTaskPriority").value;
  task.category = editSelectedCategory;
  if (document.getElementById("editTaskNotes")) task.notes = document.getElementById("editTaskNotes").value.trim();

  saveTasks();
  closeModal("editModal");
  renderAll();
  showToast("Task updated!", "success");
}

// ===================== DELETE TASK =====================
function deleteTask(id) {
  showConfirm("Delete Task", "Are you sure you want to permanently delete this task?", () => {
    tasks = tasks.filter(t => t.id !== id);
    saveTasks();
    renderAll();
    showToast("Task deleted.", "info");
  });
}



// ===================== NOTES =====================
function loadNotes() {
  ["daily", "shopping", "ideas", "reminders"].forEach(key => {
    const el = document.getElementById("note-" + key);
    if (el) el.value = notes[key] || "";
  });
}

let noteTimer = null;
function saveNote(key) {
  const el = document.getElementById("note-" + key);
  if (!el) return;
  notes[key] = el.value;
  saveNoteData();
  updateStats();

  const ind = document.getElementById("saveIndicator");
  if (ind) { ind.textContent = "Saved ✓"; clearTimeout(noteTimer); noteTimer = setTimeout(() => { ind.textContent = ""; }, 2000); }
}

// ===================== SETTINGS =====================
function setTheme(theme) {
  currentTheme = theme;
  applyTheme(theme, true);
  if (dbRef) dbRef.child('settings/theme').set(theme);
}

function applyTheme(theme, showMsg) {
  document.documentElement.setAttribute("data-theme", theme);
  const dark = document.getElementById("darkModeBtn");
  const light = document.getElementById("lightModeBtn");
  if (dark && light) {
    dark.classList.toggle("active", theme === "dark");
    light.classList.toggle("active", theme === "light");
  }
  if (showMsg) showToast(theme === "dark" ? "Dark mode enabled." : "Light mode enabled.", "info");
}

function confirmDeleteAll() {
  showConfirm("Delete All Data", "This will permanently delete ALL tasks and notes. This cannot be undone.", () => {
    tasks = [];
    notes = { daily: "", shopping: "", ideas: "", reminders: "" };
    dateNotes = {};
    saveTasks();
    saveNoteData();
    saveDateNotes();
    renderAll();
    loadNotes();
    const dateNotesEl = document.getElementById("todayDateNotes");
    if (dateNotesEl) dateNotesEl.value = "";
    showToast("All data deleted.", "info");
  });
}

function exportData() {
  const data = { 
    tasks, 
    notes, 
    dateNotes, 
    exportedAt: new Date().toISOString() 
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "era-routine-backup-" + new Date().toISOString().split("T")[0] + ".json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Data exported successfully!", "success");
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.tasks) {
        tasks = data.tasks;
      }
      // Import legacy completedTasks if they exist in older backups
      if (data.completedTasks && data.completedTasks.length > 0) {
        data.completedTasks.forEach(ct => {
          if (!tasks.some(t => t.id === ct.id)) {
            ct.status = "Completed";
            if (!ct.date && ct.calDate) ct.date = ct.calDate;
            tasks.push(ct);
          }
        });
      }
      if (data.notes) { 
        notes = data.notes; 
        loadNotes(); 
      }
      if (data.dateNotes) {
        dateNotes = data.dateNotes;
        saveDateNotes();
      }
      saveTasks();
      saveNoteData();
      renderAll();
      showToast("Data imported successfully!", "success");
    } catch (err) {
      showToast("Invalid file. Please use a valid export file.", "error");
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

function exportToPDF() {
  const exportAll = confirm("Export all tasks? Click Cancel to export tasks for the currently selected date (" + formatDate(todaySelectedDate) + ") only.");
  
  let reportTitle = "";
  let filteredTasks = [];
  let includeNotes = false;
  
  if (exportAll) {
    reportTitle = "ERA DAILY ROUTINE TRACKER - ALL-TIME REPORT";
    filteredTasks = [...tasks];
    filteredTasks.sort((a, b) => {
      const dateCompare = (a.date || "").localeCompare(b.date || "");
      if (dateCompare !== 0) return dateCompare;
      return (a.time || "").localeCompare(b.time || "");
    });
  } else {
    reportTitle = "ERA DAILY ROUTINE TRACKER - DAILY REPORT (" + formatDate(todaySelectedDate) + ")";
    filteredTasks = tasks.filter(t => t.date === todaySelectedDate);
    filteredTasks.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    includeNotes = true;
  }
  
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    showToast("Popup blocked! Please allow popups to export PDF.", "error");
    return;
  }
  
  const total = filteredTasks.length;
  const completed = filteredTasks.filter(t => t.status === "Completed").length;
  const pending = total - completed;
  const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
  
  let tasksHtml = "";
  if (total === 0) {
    tasksHtml = `<div class="empty-state">No tasks recorded for this report.</div>`;
  } else {
    tasksHtml = `
      <table>
        <thead>
          <tr>
            <th style="width: 80px;">Status</th>
            <th>Task Name</th>
            ${exportAll ? `<th style="width: 120px;">Date</th>` : ""}
            <th style="width: 100px;">Time</th>
            <th style="width: 100px;">Category</th>
            <th style="width: 90px;">Priority</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${filteredTasks.map(t => `
            <tr class="${t.status === "Completed" ? "completed" : ""}">
              <td>
                <span class="status-indicator ${t.status === "Completed" ? "done" : "pending"}">
                  ${t.status === "Completed" ? "✓ Done" : "○ Pending"}
                </span>
              </td>
              <td><span class="task-name">${escHtml(t.name)}</span></td>
              ${exportAll ? `<td>${formatDate(t.date)}</td>` : ""}
              <td>${t.time ? formatTime12(t.time) : "—"}</td>
              <td>${t.category || "—"}</td>
              <td><span class="priority-${t.priority.toLowerCase()}">${t.priority}</span></td>
              <td><span class="task-notes-text">${t.notes ? escHtml(t.notes) : "—"}</span></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }
  
  let notesHtml = "";
  if (includeNotes) {
    const activeNote = dateNotes[todaySelectedDate] || "";
    if (activeNote.trim()) {
      notesHtml = `
        <div class="section-title">Date Notes</div>
        <div class="notes-box">${escHtml(activeNote).replace(/\n/g, "<br>")}</div>
      `;
    }
  } else if (exportAll) {
    let generalNotesHtml = "";
    Object.keys(notes).forEach(k => {
      if (notes[k] && notes[k].trim()) {
        const title = k.charAt(0).toUpperCase() + k.slice(1) + " Notes";
        generalNotesHtml += `
          <div style="flex: 1; min-width: 200px; margin: 10px; border: 1px solid #ddd; padding: 12px; border-radius: 8px; background: #fafafa;">
            <strong style="display:block; margin-bottom: 6px; color:#E50914;">${title}</strong>
            <div style="font-size: 12px; color: #555; line-height: 1.5;">${escHtml(notes[k]).replace(/\n/g, "<br>")}</div>
          </div>
        `;
      }
    });
    if (generalNotesHtml) {
      notesHtml = `
        <div class="section-title">General Notes Workspace</div>
        <div style="display:flex; flex-wrap: wrap; margin: -10px;">
          ${generalNotesHtml}
        </div>
      `;
    }
  }
  
  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${reportTitle}</title>
      <style>
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #111;
          background: #fff;
          margin: 40px;
          line-height: 1.4;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          border-bottom: 2px solid #E50914;
          padding-bottom: 15px;
          margin-bottom: 25px;
        }
        .brand {
          font-size: 24px;
          font-weight: 800;
          letter-spacing: 0.5px;
        }
        .brand span {
          color: #E50914;
        }
        .report-info {
          text-align: right;
          font-size: 12px;
          color: #666;
        }
        .report-title {
          font-size: 18px;
          font-weight: 700;
          margin-bottom: 20px;
          color: #111;
          text-transform: uppercase;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 15px;
          margin-bottom: 30px;
        }
        .stat-card {
          border: 1px solid #eee;
          border-radius: 8px;
          padding: 12px;
          background: #fbfbfb;
          text-align: center;
        }
        .stat-val {
          font-size: 20px;
          font-weight: 700;
          color: #111;
        }
        .stat-val.rate {
          color: #2e7d32;
        }
        .stat-lbl {
          font-size: 11px;
          color: #777;
          margin-top: 4px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 30px;
        }
        th, td {
          padding: 10px 12px;
          text-align: left;
          font-size: 13px;
          border-bottom: 1px solid #eee;
        }
        th {
          background: #f5f5f5;
          font-weight: 600;
          color: #333;
        }
        tr.completed td {
          color: #777;
        }
        tr.completed .task-name {
          text-decoration: line-through;
          color: #888;
        }
        .status-indicator {
          display: inline-block;
          font-weight: 600;
          font-size: 11px;
          padding: 3px 8px;
          border-radius: 12px;
        }
        .status-indicator.done {
          background: #e8f5e9;
          color: #2e7d32;
        }
        .status-indicator.pending {
          background: #ffe0b2;
          color: #f57c00;
        }
        .priority-high {
          color: #d32f2f;
          font-weight: 600;
        }
        .priority-medium {
          color: #f57c00;
          font-weight: 500;
        }
        .priority-low {
          color: #388e3c;
        }
        .section-title {
          font-size: 14px;
          font-weight: 700;
          text-transform: uppercase;
          border-bottom: 1px solid #ddd;
          padding-bottom: 6px;
          margin-bottom: 12px;
          color: #E50914;
        }
        .notes-box {
          background: #f9f9f9;
          border-left: 3px solid #E50914;
          padding: 15px;
          border-radius: 4px;
          font-size: 13px;
          color: #333;
          white-space: pre-wrap;
          line-height: 1.5;
        }
        .empty-state {
          padding: 30px;
          text-align: center;
          color: #888;
          font-size: 14px;
          border: 1px dashed #ccc;
          border-radius: 8px;
        }
        @media print {
          body {
            margin: 20px;
          }
          button {
            display: none;
          }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="brand">ERA <span>DAILY ROUTINE TRACKER</span></div>
        <div class="report-info">
          Generated: ${new Date().toLocaleString()}<br>
          Format: PDF Report
        </div>
      </div>
      
      <div class="report-title">${reportTitle}</div>
      
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-val">${total}</div>
          <div class="stat-lbl">Total Tasks</div>
        </div>
        <div class="stat-card">
          <div class="stat-val" style="color: #2e7d32;">${completed}</div>
          <div class="stat-lbl">Completed</div>
        </div>
        <div class="stat-card">
          <div class="stat-val" style="color: #d32f2f;">${pending}</div>
          <div class="stat-lbl">Pending</div>
        </div>
        <div class="stat-card">
          <div class="stat-val rate">${rate}%</div>
          <div class="stat-lbl">Completion Rate</div>
        </div>
      </div>
      
      <div class="section-title">Tasks & Routines List</div>
      ${tasksHtml}
      
      ${notesHtml}
      
      <script>
        window.onload = function() {
          setTimeout(function() {
            window.print();
          }, 300);
        };
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

// ===================== COPY TASK =====================
let copySelectedDates = [];

function openCopyTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  document.getElementById("copyTaskId").value = id;
  document.getElementById("copyTaskNameDisplay").textContent = task.name;
  copySelectedDates = [];
  document.getElementById("copyTaskDateInput").value = "";
  renderCopySelectedDates();
  openModal("copyTaskModal");
}

function addCopyDate() {
  const d = document.getElementById("copyTaskDateInput").value;
  if (!d) { showToast("Please select a date.", "error"); return; }
  if (copySelectedDates.includes(d)) { showToast("Date already added.", "error"); return; }
  copySelectedDates.push(d);
  document.getElementById("copyTaskDateInput").value = "";
  renderCopySelectedDates();
}

function removeCopyDate(dateStr) {
  copySelectedDates = copySelectedDates.filter(d => d !== dateStr);
  renderCopySelectedDates();
}

function renderCopySelectedDates() {
  const list = document.getElementById("copySelectedDatesList");
  if (!list) return;
  if (copySelectedDates.length === 0) {
    list.innerHTML = `<span style="font-size:12px; color:var(--text-muted);">No dates selected yet.</span>`;
    return;
  }
  list.innerHTML = copySelectedDates.map(d => `
    <div class="pill">
      ${formatDate(d)}
      <span class="remove-date" onclick="removeCopyDate('${d}')">×</span>
    </div>
  `).join("");
}

function executeCopyTask() {
  if (copySelectedDates.length === 0) {
    showToast("Please add at least one date.", "error");
    return;
  }
  const id = document.getElementById("copyTaskId").value;
  const originalTask = tasks.find(t => t.id === id);
  if (!originalTask) return;

  copySelectedDates.forEach(dateStr => {
    const newTask = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      name: originalTask.name,
      date: dateStr,
      time: originalTask.time,
      priority: originalTask.priority,
      category: originalTask.category,
      notes: originalTask.notes,
      status: "Pending",
      createdAt: new Date().toISOString()
    };
    tasks.push(newTask);
  });

  saveTasks();
  closeModal("copyTaskModal");
  renderAll();
  if (document.getElementById("page-calendar").classList.contains("active")) renderCalendar();
  showToast(`Task copied to ${copySelectedDates.length} date(s).`, "success");
}

// ===================== COPY YESTERDAY'S / PAST TASKS =====================

function copyYesterdaysTasks() {
  const currentSelectedStr = todaySelectedDate;
  const currentSelectedDateObj = new Date(currentSelectedStr + "T00:00:00");
  currentSelectedDateObj.setDate(currentSelectedDateObj.getDate() - 1);
  const yesterdayStr = currentSelectedDateObj.toISOString().split("T")[0];

  showConfirm("Copy Yesterday's Tasks", `Copy all tasks from yesterday (${formatDate(yesterdayStr)}) to today (${formatDate(currentSelectedStr)})?`, () => {
    performCopyTasksBetweenDates(yesterdayStr, currentSelectedStr);
  });
}

function openCopyFromModal() {
  document.getElementById("copyFromDestinationDisplay").textContent = formatDate(todaySelectedDate);
  document.getElementById("copyFromDateInput").value = "";
  openModal("copyFromModal");
}

function executeCopyFrom() {
  const dateInput = document.getElementById("copyFromDateInput");
  const sourceDateStr = dateInput.value;
  // If opened from Dashboard, use the stored real today date; otherwise use todaySelectedDate
  const destDateStr = dateInput.dataset.dashDest || todaySelectedDate;
  delete dateInput.dataset.dashDest; // clean up after use

  if (!sourceDateStr) {
    showToast("Please select a source date.", "error");
    return;
  }

  if (sourceDateStr === destDateStr) {
    showToast("Source and destination dates cannot be the same.", "error");
    return;
  }

  performCopyTasksBetweenDates(sourceDateStr, destDateStr);
  closeModal("copyFromModal");
}

function performCopyTasksBetweenDates(sourceDateStr, destDateStr) {
  const sourceTasks = tasks.filter(t => t.date === sourceDateStr);
  
  if (sourceTasks.length === 0) {
    showToast(`No tasks found on ${formatDate(sourceDateStr)}.`, "error");
    return;
  }
  
  const destTasks = tasks.filter(t => t.date === destDateStr);
  let copiedCount = 0;
  let skippedCount = 0;

  sourceTasks.forEach(sourceTask => {
    const isDuplicate = destTasks.some(dt => 
      dt.name === sourceTask.name && dt.time === sourceTask.time
    );

    if (isDuplicate) {
      skippedCount++;
    } else {
      const newTask = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        name: sourceTask.name,
        date: destDateStr,
        time: sourceTask.time,
        priority: sourceTask.priority,
        category: sourceTask.category,
        notes: sourceTask.notes,
        status: "Pending", // Reset status
        createdAt: new Date().toISOString()
      };
      tasks.push(newTask);
      destTasks.push(newTask); // for dup checking of newly added
      copiedCount++;
    }
  });

  saveTasks();
  renderAll();
  if (document.getElementById("page-calendar").classList.contains("active")) renderCalendar();
  if (document.getElementById("page-today").classList.contains("active")) renderTaskTable();
  
  let msg = `✓ ${copiedCount} task${copiedCount === 1 ? '' : 's'} copied successfully.`;
  if (skippedCount > 0) {
    msg += ` ⚠ ${skippedCount} duplicate task${skippedCount === 1 ? '' : 's'} skipped.`;
  }
  
  showToast(msg, copiedCount > 0 ? "success" : "info");
}

// ===================== DASHBOARD COPY SHORTCUTS =====================
// These always copy TO today's real date (not todaySelectedDate)
function dashCopyYesterday() {
  const todayStr = new Date().toISOString().split("T")[0];
  const yestObj = new Date(todayStr + "T00:00:00");
  yestObj.setDate(yestObj.getDate() - 1);
  const yesterdayStr = yestObj.toISOString().split("T")[0];

  showConfirm(
    "Copy Yesterday's Tasks",
    `Copy all tasks from yesterday (${formatDate(yesterdayStr)}) to today (${formatDate(todayStr)})?`,
    () => { performCopyTasksBetweenDates(yesterdayStr, todayStr); }
  );
}

function dashOpenCopyFrom() {
  const todayStr = new Date().toISOString().split("T")[0];
  document.getElementById("copyFromDestinationDisplay").textContent = formatDate(todayStr);
  // Temporarily store today's real date so executeCopyFrom targets it
  document.getElementById("copyFromDateInput").dataset.dashDest = todayStr;
  document.getElementById("copyFromDateInput").value = "";
  openModal("copyFromModal");
}

// ===================== MODALS =====================
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add("open");
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("open");
}

// Close modal on overlay click
document.querySelectorAll(".modal-overlay").forEach(overlay => {
  overlay.addEventListener("click", e => {
    if (e.target === overlay) overlay.classList.remove("open");
  });
});

// ===================== CONFIRM DIALOG =====================
function showConfirm(title, message, onConfirm) {
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMessage").textContent = message;
  const btn = document.getElementById("confirmActionBtn");
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.addEventListener("click", () => {
    closeModal("confirmModal");
    onConfirm();
  });
  openModal("confirmModal");
}

// ===================== TOAST =====================
let toastTimer;
function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = "toast " + type + " show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.classList.remove("show"); }, 3000);
}

// ===================== UTILS =====================
function escHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatTime12(time24) {
  if (!time24) return "";
  const [h, m] = time24.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2,"0")} ${ampm}`;
}

function catIcon(cat) {
  const icons = { Morning: "🌅", Afternoon: "☀️", Evening: "🌇", Night: "🌙" };
  return icons[cat] || "📌";
}

// ===================== KEYBOARD SHORTCUT =====================
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-overlay.open").forEach(m => m.classList.remove("open"));
  }
  if (e.key === "Enter" && e.target.id === "taskName") {
    addTask();
  }
});

/* ==========================================================
   CALENDAR MODULE
   Reads directly from unified tasks[] array
   ========================================================== */

// ---- Render Calendar Grid ----
function renderCalendar() {
  const grid = document.getElementById("calGrid");
  const label = document.getElementById("calMonthYear");
  if (!grid || !label) return;

  const monthNames = ["January","February","March","April","May","June",
                      "July","August","September","October","November","December"];
  label.textContent = monthNames[calMonth] + " " + calYear;

  // First day of month (0=Sun)
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  // Days in month
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  // Days in previous month
  const daysInPrev = new Date(calYear, calMonth, 0).getDate();

  const todayStr = new Date().toISOString().split("T")[0];

  // Build task-date index: dateStr -> {pending: n, done: n}
  const taskIndex = {};
  tasks.forEach(t => {
    if (t.date) {
      if (!taskIndex[t.date]) taskIndex[t.date] = { pending: 0, done: 0 };
      if (t.status === "Completed") taskIndex[t.date].done++;
      else taskIndex[t.date].pending++;
    }
  });

  let html = "";

  // Prev-month filler cells
  for (let i = 0; i < firstDay; i++) {
    const day = daysInPrev - firstDay + 1 + i;
    html += `<div class="cal-day other-month empty"><span class="cal-day-num">${day}</span></div>`;
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const isToday = dateStr === todayStr;
    const isSelected = dateStr === calSelectedDate;
    const info = taskIndex[dateStr];

    let dotsHtml = "";
    if (info) {
      dotsHtml = `<div class="cal-indicators">`;
      if (info.pending > 0 || info.done > 0) {
        dotsHtml += `<div class="cal-indicator-row">`;
        if (info.pending > 0) dotsHtml += `<span class="cal-dot red" title="Has pending tasks"></span>`;
        if (info.done > 0) dotsHtml += `<span class="cal-check" title="Has completed tasks">✔</span>`;
        dotsHtml += `</div>`;
        const total = info.pending + info.done;
        dotsHtml += `<div class="cal-indicator-row" style="margin-top:2px;">${total} task${total > 1 ? 's' : ''}</div>`;
      }
      dotsHtml += `</div>`;
    }

    html += `
      <div class="cal-day${isToday ? " today" : ""}${isSelected ? " selected" : ""}" onclick="selectCalDate('${dateStr}')">
        <span class="cal-day-num">${d}</span>
        ${dotsHtml}
      </div>`;
  }

  // Next-month filler cells
  const totalCells = firstDay + daysInMonth;
  const remainder = totalCells % 7;
  if (remainder !== 0) {
    for (let i = 1; i <= 7 - remainder; i++) {
      html += `<div class="cal-day other-month empty"><span class="cal-day-num">${i}</span></div>`;
    }
  }

  grid.innerHTML = html;

  if (calSelectedDate) renderCalendarPanel();
}

// ---- Month Navigation ----
function prevMonth() {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
}

function nextMonth() {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
}

// ---- Select a Date ----
function selectCalDate(dateStr) {
  calSelectedDate = dateStr;
  todaySelectedDate = dateStr;
  updateTodayPageHeader();
  renderCalendar();
  renderCalendarPanel();

  const btn = document.getElementById("calAddTaskBtn");
  if (btn) btn.disabled = false;
}

// ---- Render the Right Task Panel ----
function renderCalendarPanel() {
  if (!calSelectedDate) return;

  const panelDate = document.getElementById("calPanelDate");
  const taskList = document.getElementById("calTaskList");
  if (!panelDate || !taskList) return;

  const d = new Date(calSelectedDate + "T00:00:00");
  const formatted = d.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  panelDate.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px;flex-shrink:0;color:var(--primary)"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${formatted}`;
  panelDate.classList.add("has-date");

  let all = tasks.filter(t => t.date === calSelectedDate);
  all.sort((a, b) => (a.time || "").localeCompare(b.time || ""));

  if (calFilter === "pending") all = all.filter(t => t.status !== "Completed");
  if (calFilter === "completed") all = all.filter(t => t.status === "Completed");

  if (all.length === 0) {
    taskList.innerHTML = `<div class="cal-empty-hint"><p>No tasks for this date.<br>Click <strong>Add Task</strong> to add one.</p></div>`;
    return;
  }

  taskList.innerHTML = all.map(t => {
    const isDone = t.status === "Completed";
    return `
      <div class="cal-task-item">
        <input type="checkbox" class="cal-checkbox" ${isDone ? "checked" : ""} onchange="calToggleTask('${t.id}')" />
        <div class="cal-task-body">
          <span class="cal-task-name ${isDone ? "done" : ""}">${escHtml(t.name)}</span>
          <div class="cal-task-meta">
            ${t.time ? `<span class="cal-task-time">${formatTime12(t.time)}</span>` : ""}
            <span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span>
            <span class="cat-badge" style="font-size:11px">${catIcon(t.category)} ${t.category}</span>
          </div>
        </div>
        <div class="cal-task-actions">
          <button class="btn-icon" title="Copy" onclick="openCopyTask('${t.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
          <button class="btn-icon" title="Edit" onclick="openEditTask('${t.id}'); calAfterEdit=true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-icon delete" title="Delete" onclick="calDeleteTask('${t.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div>
      </div>`;
  }).join("");
}

// ---- Filter tabs ----
function setCalFilter(f) {
  calFilter = f;
  document.querySelectorAll(".cal-filter-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.filter === f);
  });
  renderCalendarPanel();
}

// ---- Add task from calendar (pre-fills date) ----
function addCalendarTask() {
  if (!calSelectedDate) return;
  navigateTo("dashboard");
  const tf = document.getElementById("taskDate");
  if (tf) tf.value = calSelectedDate;
  const nameEl = document.getElementById("taskName");
  if (nameEl) nameEl.focus();
  showToast("Date set to " + formatDate(calSelectedDate) + ". Enter task details.", "info");
}

// ---- Toggle task from calendar ----
function calToggleTask(id) {
  toggleTask(id);
  renderCalendar();
}

// ---- Delete from calendar ----
function calDeleteTask(id) {
  showConfirm("Delete Task", "Permanently delete this task?", () => {
    tasks = tasks.filter(t => t.id !== id);
    saveTasks();
    renderAll();
    renderCalendar();
    showToast("Task deleted.", "info");
  });
}

// Track if edit was opened from calendar
let calAfterEdit = false;

const _origSaveEditTask = saveEditTask;
saveEditTask = function() {
  _origSaveEditTask();
  if (calAfterEdit) {
    calAfterEdit = false;
    renderCalendar();
  }
};

// (window exports are set inside DOMContentLoaded above)
