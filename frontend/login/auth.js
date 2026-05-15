const USERS_KEY = "acct_users_v1";
const SESSION_KEY = "acct_session_v1";

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function getUsers() {
  return readJSON(USERS_KEY, []);
}

export function registerUser({ email, password, name, role }) {
  const users = getUsers();
  const exists = users.some((u) => u.email.toLowerCase() === email.toLowerCase());
  if (exists) throw new Error("Email already registered.");

  const user = {
    id: crypto?.randomUUID?.() || String(Date.now()),
    email,
    password, // ⚠️ demo only (backend should hash)
    name: name || "",
    role: role || "Accountant",
    createdAt: new Date().toISOString(),
  };

  writeJSON(USERS_KEY, [...users, user]);
  return user;
}

export function loginUser({ email, password, remember }) {
  const users = getUsers();
  const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());

  if (!user || user.password !== password) {
    throw new Error("Invalid email or password.");
  }

  const session = {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    createdAt: new Date().toISOString(),
    remember: !!remember,
  };

  if (remember) {
    writeJSON(SESSION_KEY, session);
    sessionStorage.removeItem(SESSION_KEY);
  } else {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    localStorage.removeItem(SESSION_KEY);
  }

  return session.user;
}

export function getSessionUser() {
  const s1 = readJSON(SESSION_KEY, null);
  if (s1?.user) return s1.user;

  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const s2 = raw ? JSON.parse(raw) : null;
    return s2?.user || null;
  } catch {
    return null;
  }
}

export function logout() {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
}