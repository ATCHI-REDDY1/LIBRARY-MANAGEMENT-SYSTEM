const { useState, useEffect, useRef } = React;
const html = htm.bind(React.createElement);
const API = window.location.port === "5500" ? "http://localhost:3000/api" : "/api";
const TOKEN_KEY = "lms_token";
const request = async (path, options) => {
  let r;
  const token = sessionStorage.getItem(TOKEN_KEY);
  try {
    r = await fetch(API + path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    });
  } catch {
    throw new Error("Cannot reach the server. Check that the backend is running.");
  }
  let data = null;
  try {
    data = await r.json();
  } catch {
    // empty or non-JSON body
  }
  if (!r.ok) {
    // An expired or invalid login: go back to the login page.
    if (r.status === 401 && !path.startsWith("/auth/")) {
      sessionStorage.removeItem(TOKEN_KEY);
      window.location.reload();
    }
    throw Object.assign(new Error((data && data.error) || "Request failed (" + r.status + ")"), { status: r.status });
  }
  return data;
};
const pdfRequest = async (path, options) => {
  let response;
  const token = sessionStorage.getItem(TOKEN_KEY);
  try {
    response = await fetch(API + path, {
      ...options,
      headers: { ...(options.headers || {}), ...(token ? { Authorization: "Bearer " + token } : {}) },
    });
  } catch {
    throw new Error("Cannot reach the server. Check that the backend is running.");
  }
  if (!response.ok) {
    let data = null;
    try {
      data = await response.json();
    } catch {
      // The server may return a non-JSON error body.
    }
    if (response.status === 401) {
      sessionStorage.removeItem(TOKEN_KEY);
      window.location.reload();
    }
    throw new Error((data && data.error) || "PDF request failed (" + response.status + ").");
  }
  return response;
};
const uploadBookPdf = async (bookId, file) => {
  const response = await pdfRequest("/books/" + encodeURIComponent(bookId) + "/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: file,
  });
  return response.json();
};
const downloadBookPdf = async (book) => {
  const response = await pdfRequest("/books/" + encodeURIComponent(book.id) + "/pdf");
  const blobUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = (String(book.title || "book").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100) || "book") + ".pdf";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
};
const DEFAULT_PREF = { lang: "en", theme: "light" };
// The server stores preferences as {} on a fresh database; without merging in the
// defaults, T[pref.lang] is undefined and the app crashes right after login.
const normPref = (p) => {
  const m = { ...DEFAULT_PREF, ...(p || {}) };
  if (!T[m.lang]) m.lang = DEFAULT_PREF.lang;
  if (m.theme !== "light" && m.theme !== "dark") m.theme = DEFAULT_PREF.theme;
  return m;
};

const T = {
  en: {
    home: "Home",
    features: "Features",
    about: "About",
    contact: "Contact",
    dash: "Dashboard",
    my: "My Profile",
    edit: "Edit Profile",
    settings: "Settings",
    lang: "Language",
    theme: "Theme",
    light: "Light",
    dark: "Dark",
    logout: "Log out",
    save: "Save Changes",
    login: "Login",
    signup: "Sign Up",
    h1: "Find it.",
    h2: "Book it.",
    h3: "Read it.",
    sub: "Search the catalog, book your copy in seconds and track your due dates. No queues, no paperwork.",
    welcome: "Welcome back",
  },
};
const SEED = []; // catalog starts empty; the administrator adds books
const FEATS = [
  [
    "🔍",
    "Smart Book Search",
    "Find books instantly using title, author, ISBN or category.",
  ],
  [
    "📚",
    "Manage Your Books",
    "Track borrowed books, due dates, renewals and history.",
  ],
  [
    "🕘",
    "Easy Reservations",
    "Reserve unavailable books and monitor your queue position.",
  ],
  [
    "💻",
    "Digital Library",
    "Access digital books, PDFs and online learning resources.",
  ],
  [
    "🔔",
    "Smart Notifications",
    "Receive reminders about due dates, reservations and fines.",
  ],
  [
    "📊",
    "Library Analytics",
    "Administrators can monitor books, students and library activity.",
  ],
];

const AFEATS = [
  [
    "📊",
    "Dashboard",
    "View live counts of books, issued items and registered students.",
    "dash",
  ],
  [
    "📚",
    "Manage Books",
    "Add new books to the catalog and remove old ones.",
    "books",
  ],
  ["📤", "Issue Book", "Student responses are recorded here.", "issue"],
  [
    "📥",
    "Return Book",
    "Mark issued books as returned and make them available again.",
    "return",
  ],
  [
    "💳",
    "Manage Fines & Payments",
    "Record fines for students and track the payments received.",
    "fines",
  ],
  [
    "📜",
    "History",
    "See everything done in the student and administrator logins.",
    "history",
  ],
];

const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 6e4)
    .toISOString()
    .slice(0, 10);
};
const fd = (s) => (s ? s.split("-").reverse().join("-") : "-");
const cp = (b) => (b.copies == null ? 1 : b.copies); // copies available now
const tot = (b, bk) =>
  b.total != null
    ? b.total
    : cp(b) +
      (bk || [])
        .filter((x) => x.bookId === b.id)
        .reduce((s, x) => s + (x.copies || 1), 0); // all copies the library owns

// One copy handed back to the library (never above the number of copies it owns).
const giveBack = (b) => (b.total != null ? Math.min(cp(b) + 1, b.total) : cp(b) + 1);

function Avatar({ u, cls }) {
  return u && u.pic
    ? html`<img class=${"av " + (cls || "")} src=${u.pic} alt="profile" />`
    : html`<span class=${"av " + (cls || "")}
        >${u && u.name ? u.name[0].toUpperCase() : "?"}</span
      >`;
}

function BookCover({ src, title }) {
  if (!src)
    return html`<div class="book-cover book-cover-empty" role="img" aria-label=${title + " cover not uploaded"}>
        <span>No cover</span>
      </div>`;
  return html`<img class="book-cover" src=${src} alt=${title + " cover"} />`;
}

async function squareCoverFromFile(file) {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file for the book cover.");
  if (file.size > 10 * 1024 * 1024) throw new Error("Book cover image must be smaller than 10 MB.");

  const imageData = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected cover image."));
    reader.onload = () => {
      if (typeof reader.result !== "string") reject(new Error("Could not read the selected cover image."));
      else resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const loadedImage = new Image();
    loadedImage.onerror = () => reject(new Error("Could not open the selected cover image."));
    loadedImage.onload = () => resolve(loadedImage);
    loadedImage.src = imageData;
  });
  if (!image.naturalWidth || !image.naturalHeight) throw new Error("The selected cover image is empty or invalid.");

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1024;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser could not process the cover image.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);

  const pngCover = canvas.toDataURL("image/png");
  if (pngCover.length <= 250_000) return pngCover;
  for (const quality of [0.9, 0.84, 0.78, 0.7, 0.62, 0.55]) {
    const compressed = canvas.toDataURL("image/jpeg", quality);
    if (compressed.length <= 250_000) return compressed;
  }
  throw new Error("Could not resize the cover small enough. Choose a smaller image.");
}

const YEARS = ["1st Year", "2nd Year", "3rd Year", "4th Year"];
const ADMIN_ID = /^LIB\d{3,5}$/;
const EMAIL_ID = /^\S+@\S+\.\S+$/;
function Auth({ onLogin }) {
  const [mode, setMode] = useState("login"),
    [f, setF] = useState({}),
    [err, setErr] = useState(""),
    [ok, setOk] = useState(""),
    [codeLen, setCodeLen] = useState(4);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const signup = mode === "signup";
  const forgot = mode === "forgot";
  const reset = mode === "reset";
  const id = (f.id || "").trim();
  const isAdminId = ADMIN_ID.test(id.toUpperCase());
  const swap = (m) => (e) => {
    e.preventDefault();
    setMode(m);
    setErr("");
    setOk("");
    setF({ id: f.id || "" });
  };
  const submit = async () => {
    setErr("");
    setOk("");
    if (forgot) {
      if (!id) return setErr("Enter your username or email.");
      try {
        const result = await request("/auth/forgot", {
          method: "POST",
          body: JSON.stringify({ identifier: id }),
        });
        setF({ id });
        setCodeLen(result.codeLength || 4);
        setMode("reset");
        return setOk(result.message || "If this account has an email address on file, a code has been sent to it.");
      } catch (e) {
        return setErr(e.message);
      }
    }
    if (reset) {
      if (!id) return setErr("Enter your username or email.");
      if (!new RegExp("^\\d{" + codeLen + "}$").test((f.code || "").trim()))
        return setErr("Enter the " + codeLen + "-digit code from your email.");
      if (!f.pw || f.pw.length < 6) return setErr("Password must be at least 6 characters.");
      if (f.pw !== f.pw2) return setErr("Passwords do not match.");
      try {
        await request("/auth/reset", {
          method: "POST",
          body: JSON.stringify({ identifier: id, code: f.code.trim(), newPassword: f.pw }),
        });
        setF({ id });
        setMode("login");
        return setOk("Password changed! Please login with your new password.");
      } catch (e) {
        return setErr(e.message);
      }
    }
    if (!id || !f.pw) return setErr("Enter your user number and password.");
    if (!signup) {
      try {
        const result = await request("/auth/login", {
          method: "POST",
          body: JSON.stringify({ identifier: id, password: f.pw }),
        });
        sessionStorage.setItem(TOKEN_KEY, result.token);
        return await onLogin(result.user);
      } catch (e) {
        return setErr(e.message);
      }
    }
    const up = id.toUpperCase();
    if (up.startsWith("LIB") && !ADMIN_ID.test(up))
      return setErr("Administrator numbers are LIB followed by 3 to 5 digits, e.g. LIB001.");
    if (!isAdminId && !EMAIL_ID.test(id) && !/^[A-Za-z0-9._-]{3,30}$/.test(id))
      return setErr("Enter your college mail ID or roll number.");
    if (f.pw.length < 6) return setErr("Password must be at least 6 characters.");
    if (f.pw !== f.pw2) return setErr("Passwords do not match.");
    if (isAdminId && !f.code) return setErr("Enter the administrator code.");
    const roll = isAdminId ? up : EMAIL_ID.test(id) ? id.toLowerCase() : up;
    const role = isAdminId ? "admin" : "student";
    const name = EMAIL_ID.test(id)
      ? id.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : roll;
    try {
      await request("/auth/signup", {
        method: "POST",
        body: JSON.stringify({ name, roll, email: EMAIL_ID.test(id) ? id.toLowerCase() : "", role, password: f.pw, adminCode: f.code || "" }),
      });
      setF({ id });
      setMode("login");
      setOk("Account created! Please login.");
    } catch (e) {
      setErr(e.message);
    }
  };
  const title = signup ? "Create your account" : forgot ? "Forgot your password?" : reset ? "Reset your password" : "Welcome back";
  const subtitle = signup
    ? "Sign up with your user number."
    : forgot
      ? "Enter your username or email and we will email you a verification code."
      : reset
        ? "Enter the code from your email and choose a new password."
        : "Login with your user number and password.";
  const button = signup ? "Create Account" : forgot ? "Send Reset Code" : reset ? "Reset Password" : "Login";
  return html`<div class="auth">
    <div class="box" onKeyDown=${(e) => e.key === "Enter" && submit()}>
      <div class="brand">
        <div class="logo">📚</div>
        Library Management System
      </div>
      <h2 style=${{ margin: "18px 0 2px" }}>${title}</h2>
      <p class="mut" style=${{ fontSize: 13, margin: 0 }}>${subtitle}</p>
      <label>${forgot || reset ? "Username / Email" : "User Number"}</label>
      <input
        value=${f.id || ""}
        onInput=${set("id")}
        placeholder=${forgot || reset ? "Enter your username or email" : ""}
        autocomplete="username"
      />
      ${reset &&
      html`<div>
        <label>Reset Code</label
        ><input value=${f.code || ""} onInput=${set("code")} inputmode="numeric" maxlength=${codeLen} placeholder=${"Enter the " + codeLen + "-digit code"} autocomplete="one-time-code" />
      </div>`}
      ${!forgot &&
      html`<div>
        <label>${signup ? "Create Password" : reset ? "New Password" : "Password"}</label
        ><input
          type="password"
          value=${f.pw || ""}
          onInput=${set("pw")}
          autocomplete=${signup || reset ? "new-password" : "current-password"}
        />
      </div>`}
      ${(signup || reset) &&
      html`<div>
        <label>${reset ? "Confirm New Password" : "Confirm Password"}</label
        ><input type="password" value=${f.pw2 || ""} onInput=${set("pw2")} autocomplete="new-password" />
      </div>`}
      ${signup &&
      isAdminId &&
      html`<div>
        <label>Administrator Code</label
        ><input type="password" value=${f.code || ""} onInput=${set("code")} autocomplete="off" />
      </div>`}
      ${mode === "login" &&
      html`<p class="swap" style=${{ textAlign: "right", margin: "8px 0 0" }}>
        <a href="#" onClick=${swap("forgot")}>Forgot password?</a>
      </p>`}
      ${err && html`<div class="err">${err}</div>`}${ok && html`<div class="ok">${ok}</div>`}
      <button class="btn" style=${{ width: "100%", marginTop: 18 }} onClick=${submit}>
        ${button}
      </button>
      ${forgot || reset
        ? html`<p class="swap">
            ${reset && html`<a href="#" onClick=${swap("forgot")}>Resend code</a> · `}
            <a href="#" onClick=${swap("login")}>Back to login</a>
          </p>`
        : html`<p class="swap">
            ${signup ? "Already have an account? " : "Don't have an account? "}
            <a href="#" onClick=${swap(signup ? "login" : "signup")}>${signup ? "Login" : "Sign up"}</a>
          </p>`}
    </div>
  </div>`;
}

// Shown right after a student logs in while Email, Year or Department is still empty.
// Saving goes through the normal state save, so the data reaches the backend and
// then appears in My Profile.
function ProfileSetup({ user, users, onSave, onLogout }) {
  const [em, setEm] = useState(user.email || ""),
    [yr, setYr] = useState(user.year || ""),
    [dp, setDp] = useState(user.dept || ""),
    [sc, setSc] = useState(user.section || ""),
    [err, setErr] = useState("");
  const save = () => {
    const email = em.trim().toLowerCase();
    if (!email) return setErr("Enter your college email.");
    if (!EMAIL_ID.test(email)) return setErr("Enter a valid email address.");
    if (users.some((u) => u.roll !== user.roll && (u.email || "").toLowerCase() === email))
      return setErr("This email is already used by another account.");
    if (!yr) return setErr("Select your year.");
    if (!dp.trim()) return setErr("Enter your department.");
    onSave({ email, year: yr, dept: dp.trim(), section: sc.trim() });
  };
  return html`<div class="ov">
    <div class="modal" onKeyDown=${(e) => e.key === "Enter" && save()}>
      <div class="mh"><b>Complete your profile</b></div>
      <p class="mut" style=${{ fontSize: 13, margin: "0 0 4px" }}>
        Hi ${user.name}, please add your details to continue.
      </p>
      <label>College Email</label>
      <input
        type="email"
        placeholder="you@college.edu"
        value=${em}
        onInput=${(e) => setEm(e.target.value)}
      />
      <label>Year</label>
      <select value=${yr} onChange=${(e) => setYr(e.target.value)}>
        <option value="">Select year</option>
        ${YEARS.map((y) => html`<option key=${y} value=${y}>${y}</option>`)}
      </select>
      <label>Department</label>
      <input
        placeholder="e.g. Computer Science"
        maxlength="150"
        value=${dp}
        onInput=${(e) => setDp(e.target.value)}
      />
      <label>Section (optional)</label>
      <input placeholder="e.g. A" maxlength="30" value=${sc} onInput=${(e) => setSc(e.target.value)} />
      ${err && html`<div class="err">${err}</div>`}
      <div class="foot" style=${{ gap: 10 }}>
        <button class="btn red" onClick=${onLogout}>Logout</button>
        <button class="btn" onClick=${save}>Save</button>
      </div>
    </div>
  </div>`;
}

function ProfileModal({ user, users, pref, setPref, update, onClose, onLogout }) {
  const t = T[pref.lang];
  const [tab, setTab] = useState("edit"),
    [pic, setPic] = useState(user.pic),
    [em, setEm] = useState(user.email || ""),
    [yr, setYr] = useState(user.year || ""),
    [dp, setDp] = useState(user.dept || ""),
    [sc, setSc] = useState(user.section || ""),
    [p0, setP0] = useState(""),
    [p1, setP1] = useState(""),
    [p2, setP2] = useState(""),
    [msg, setMsg] = useState(""),
    [bad, setBad] = useState(false);
  const pick = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = 160;
        const x = c.getContext("2d");
        const s = Math.min(im.width, im.height);
        x.drawImage(
          im,
          (im.width - s) / 2,
          (im.height - s) / 2,
          s,
          s,
          0,
          0,
          160,
          160,
        );
        setPic(c.toDataURL("image/jpeg", 0.8));
      };
      im.src = r.result;
    };
    r.readAsDataURL(file);
  };
  const save = async () => {
    setMsg("");
    setBad(true);
    const student = user.role !== "admin";
    const email = em.trim().toLowerCase();
    if (student) {
      if (email && !EMAIL_ID.test(email)) return setMsg("Enter a valid email address.");
      if (email && users.some((u) => u.roll !== user.roll && (u.email || "").toLowerCase() === email))
        return setMsg("This email is already used by another account.");
    }
    if (p1 || p2) {
      if (p1.length < 6)
        return setMsg("New password must be at least 6 characters.");
      if (p1 !== p2) return setMsg("Passwords do not match.");
      if (!p0) return setMsg("Enter your current password to change it.");
      try {
        // The password is changed on the server only; it never sits in the app state.
        await request("/auth/password", {
          method: "POST",
          body: JSON.stringify({ roll: user.roll, currentPassword: p0, newPassword: p1 }),
        });
      } catch (e) {
        return setMsg(e.message);
      }
    }
    update(
      student ? { pic, email, year: yr, dept: dp.trim(), section: sc.trim() } : { pic },
      !!p1,
    );
    setP0("");
    setP1("");
    setP2("");
    setBad(false);
    setMsg("Changes saved successfully.");
  };
  return html`<div class="ov" onClick=${onClose}>
    <div class="modal" onClick=${(e) => e.stopPropagation()}>
      <div class="mh">
        <b>${t.my}</b><button class="x" onClick=${onClose}>×</button>
      </div>
      <div class="tabs">
        <button
          class=${tab === "edit" ? "on" : ""}
          onClick=${() => setTab("edit")}
        >
          ${t.edit}</button
        ><button
          class=${tab === "set" ? "on" : ""}
          onClick=${() => setTab("set")}
        >
          ${t.settings}
        </button>
      </div>
      ${tab === "edit"
        ? html`<div
            style=${{ display: "flex", flexDirection: "column", flex: 1 }}
          >
            <div style=${{ display: "flex", gap: 14, alignItems: "center" }}>
              <${Avatar} u=${{ ...user, pic }} cls="big" />
              <div>
                <b>${user.name}</b>
                <div class="mut" style=${{ fontSize: 12 }}>
                  ${user.role === "admin"
                    ? "Administrator"
                    : [
                        user.roll,
                        user.email && user.email !== user.roll ? user.email : "",
                        user.year,
                        user.dept,
                        user.section && "Section " + user.section,
                        "Student",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </div>
              </div>
            </div>
            <label>Change Profile Picture</label
            ><input type="file" accept="image/*" onChange=${pick} />
            ${user.role !== "admin" &&
            html`<div>
              <label>College Email</label>
              <input
                type="email"
                placeholder="you@college.edu"
                value=${em}
                onInput=${(e) => setEm(e.target.value)}
              />
              <label>Year</label>
              <select value=${yr} onChange=${(e) => setYr(e.target.value)}>
                <option value="">Select year</option>
                ${YEARS.map((y) => html`<option key=${y} value=${y}>${y}</option>`)}
              </select>
              <label>Department</label>
              <input
                placeholder="e.g. Computer Science"
                maxlength="150"
                value=${dp}
                onInput=${(e) => setDp(e.target.value)}
              />
              <label>Section</label>
              <input
                placeholder="e.g. A"
                maxlength="30"
                value=${sc}
                onInput=${(e) => setSc(e.target.value)}
              />
            </div>`}
            <label>Current Password</label
          ><input
            type="password"
            placeholder="Only needed to change your password"
            value=${p0}
            onInput=${(e) => setP0(e.target.value)}
            autocomplete="current-password"
          />
          <label>Change Password</label
            ><input
              type="password"
              placeholder="New password"
              value=${p1}
              onInput=${(e) => setP1(e.target.value)}
            />
            <input
              style=${{ marginTop: 8 }}
              type="password"
              placeholder="Confirm new password"
              value=${p2}
              onInput=${(e) => setP2(e.target.value)}
            />
            ${msg && html`<div class=${bad ? "err" : "ok"}>${msg}</div>`}
            <div class="foot">
              <button class="btn" onClick=${save}>${t.save}</button>
            </div>
          </div>`
        : html`<div>
            <label>${t.theme}</label>
            <div class="tabs">
              ${["light", "dark"].map(
                (m) =>
                  html`<button
                    key=${m}
                    class=${pref.theme === m ? "on" : ""}
                    onClick=${() => setPref({ ...pref, theme: m })}
                  >
                    ${t[m]}
                  </button>`,
              )}
            </div>
            <button
              class="btn red"
              style=${{ marginTop: 18, width: "100%" }}
              onClick=${onLogout}
            >
              ${t.logout}
            </button>
          </div>`}
    </div>
  </div>`;
}

const QUOTES = [
  ["A reader lives a thousand lives before he dies.", "George R.R. Martin"],
  ["Small steps every day beat big plans someday.", "Study tip"],
  ["Read 20 pages a day and finish 20+ books a year.", "Study tip"],
  ["The more that you read, the more things you will know.", "Dr. Seuss"],
];
const QUICK_S = [["🔍", "Find a book", 0], ["📚", "My books", 1], ["🕘", "Reserve", 2], ["💻", "Digital library", 3]];
const QUICK_A = [["📊", "Dashboard", "dash"], ["📚", "Books", "books"], ["📤", "Issue", "issue"], ["📥", "Return", "return"], ["💳", "Fines", "fines"], ["📜", "History", "history"]];
const GOAL = 30;
const dkey = (d) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);

function Hub({ t, user, admin, onExplore, storage, setStorage }) {
  const gk = "lms_goal_" + user.roll;
  const goal = storage[gk] || {};
  const [qi, setQi] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setQi((i) => (i + 1) % QUOTES.length), 6000);
    return () => clearInterval(id);
  }, []);
  const add = (n) => {
    const g = { ...goal, [today()]: Math.max(0, (goal[today()] || 0) + n) };
    setStorage({ ...storage, [gk]: g });
  };
  const days = [...Array(7)].map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return { d, k: dkey(d), m: goal[dkey(d)] || 0 };
  });
  const mins = goal[today()] || 0;
  let streak = 0;
  for (let i = 6; i >= 0; i--) {
    if (days[i].m > 0) streak++;
    else if (i !== 6) break;
  }
  const pct = Math.min(1, mins / GOAL);
  const C = 2 * Math.PI * 42;
  const q = QUOTES[qi];
  return html`<div class="portal hub">
    <div class="hub-top">
      <div>
        <b class="hub-hi">${t.welcome}, ${user.name.split(" ")[0]} 👋</b>
        <div class="mut" style=${{ fontSize: 12 }}>
          ${new Date().toLocaleDateString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </div>
      </div>
      ${!admin &&
      html`<div class="streak" title="Days in a row you read">
        🔥 <b>${streak}</b> day${streak === 1 ? "" : "s"}
      </div>`}
    </div>
    ${!admin &&
    html`<div class="goal">
      <div class="ring">
        <svg viewBox="0 0 100 100">
          <circle class="ring-bg" cx="50" cy="50" r="42" />
          <circle
            class="ring-fg"
            cx="50"
            cy="50"
            r="42"
            strokeDasharray=${C}
            strokeDashoffset=${C * (1 - pct)}
          />
        </svg>
        <div class="ring-n"><b>${mins}</b><small>/ ${GOAL} min</small></div>
      </div>
      <div class="goal-r">
        <b>${pct >= 1 ? "Goal reached! 🎉" : "Today's reading goal"}</b>
        <div class="mut" style=${{ fontSize: 12 }}>
          ${pct >= 1 ? "Great work, keep the streak alive." : GOAL - mins + " min to go"}
        </div>
        <div class="week">
          ${days.map(
            (x, i) =>
              html`<span
                key=${x.k}
                class=${"dot" + (x.m > 0 ? " on" : "") + (i === 6 ? " now" : "")}
                title=${x.k + ": " + x.m + " min"}
                >${x.d.toLocaleDateString(undefined, { weekday: "narrow" })}</span
              >`,
          )}
        </div>
        <div class="row" style=${{ marginTop: 10, gap: 6 }}>
          <button class="chip" onClick=${() => add(10)}>+10 min</button>
          <button class="chip" onClick=${() => add(30)}>+30 min</button>
          ${mins > 0 &&
          html`<button class="chip ghost" onClick=${() => add(-mins)}>Reset</button>`}
        </div>
      </div>
    </div>`}
    <div class="quote" key=${qi}>
      <span>“${q[0]}”</span><small>${q[1]}</small>
    </div>
    <div class="quick">
      ${(admin ? QUICK_A : QUICK_S).map(
        (a) =>
          html`<button class="qa" key=${a[1]} onClick=${() => onExplore(a[2])}>
            <span>${a[0]}</span>${a[1]}
          </button>`,
      )}
    </div>
  </div>`;
}

function Home({ t, user, onExplore, storage, setStorage }) {
  const admin = user.role === "admin";
  return html`<div>
    <div class="hero" id="home">
      <div>
        <div class="tag">■ SMART DIGITAL LIBRARY</div>
        <h1>${t.h1}<br /><span>${t.h2}</span><br />${t.h3}</h1>
        <p class="mut" style=${{ maxWidth: 460 }}>${t.sub}</p>
        <div class="stats">
          <div><b>24/7</b><small>Digital Access</small></div>
          <div><b>10K+</b><small>Books</small></div>
          <div><b>100%</b><small>Digital</small></div>
        </div>
      </div>
      <${Hub} t=${t} user=${user} admin=${admin} onExplore=${onExplore} storage=${storage} setStorage=${setStorage} />
    </div>
    <footer id="contact">
      <b style=${{ color: "#fff" }}>Library Management System</b><br />Smart.
      Simple. Digital.
      <hr style=${{ borderColor: "#25324d", margin: "16px 0" }} />
      © 2026 Library Management System. All rights reserved.
    </footer>
  </div>`;
}

function Dashboard({ user, users, books, setBooks, log, onBack }) {
  const [ti, setTi] = useState(""),
    [au, setAu] = useState("");
  const isAdmin = user.role === "admin";
  const act = (id, by) => {
    const bk = books.find((b) => b.id === id);
    if (!bk || (by && (bk.by || cp(bk) < 1))) return;
    setBooks(
      books.map((b) =>
        b.id === id ? { ...b, by, copies: by ? cp(b) - 1 : giveBack(b) } : b,
      ),
    );
    log(
      "student",
      user.name,
      (by ? "Borrowed" : "Returned") + ' "' + (bk ? bk.title : "") + '"',
      { roll: user.roll, email: user.email, book: bk ? bk.title : "" },
    );
  };
  const add = () => {
    if (!ti || !au) return;
    setBooks([...books, { id: Date.now(), title: ti, author: au, by: null }]);
    setTi("");
    setAu("");
  };
  return html`<div class="wrap">
    <${Back} onBack=${onBack} />
    <h2>${isAdmin ? "Administrator Dashboard" : "Student Dashboard"}</h2>
    ${isAdmin &&
    html`<div class="card" style=${{ marginBottom: 16 }}>
      <b>Add a book</b>
      <div class="row" style=${{ marginTop: 10 }}>
        <input
          placeholder="Title"
          value=${ti}
          onInput=${(e) => setTi(e.target.value)}
        /><input
          placeholder="Author"
          value=${au}
          onInput=${(e) => setAu(e.target.value)}
        /><button class="btn" onClick=${add}>Add</button>
      </div>
    </div>`}
    <div class="card tw">
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Author</th>
            <th>Status</th>
            ${!isAdmin && html`<th></th>`}${isAdmin && html`<th></th>`}
          </tr>
        </thead>
        <tbody>
          ${books.map(
            (b) =>
              html`<tr key=${b.id}>
                <td>
                  <div class="book-title-cell">
                    <${BookCover} src=${b.cover} title=${b.title} />
                    <span>${b.title}</span>
                  </div>
                </td>
                <td>${b.author}</td>
                <td>
                  ${b.by
                    ? b.by === user.roll
                      ? "Borrowed by you"
                      : isAdmin
                        ? "Borrowed (" + b.by + ")"
                        : "Borrowed"
                    : cp(b) > 0
                      ? "Available"
                      : "Not available"}
                </td>
                <td>
                  ${isAdmin
                    ? html`<button
                        class="btn alt"
                        onClick=${() =>
                          setBooks(books.filter((x) => x.id !== b.id))}
                      >
                        Remove
                      </button>`
                    : !b.by
                      ? html`<button
                          class="btn"
                          disabled=${cp(b) < 1}
                          onClick=${() => act(b.id, user.roll)}
                        >
                          Borrow
                        </button>`
                      : b.by === user.roll
                        ? html`<button
                            class="btn alt"
                            onClick=${() => act(b.id, null)}
                          >
                            Return
                          </button>`
                        : html`<span class="mut">Reserved queue</span>`}
                </td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>
    ${isAdmin &&
    html`<div class="card tw" style=${{ marginTop: 16 }}>
      <b>Registered students</b>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Roll No</th>
            <th>Email</th>
          </tr>
        </thead>
        <tbody>
          ${users
            .filter((u) => u.role === "student")
            .map(
              (u) =>
                html`<tr key=${u.roll}>
                  <td>${u.name}</td>
                  <td>${u.roll}</td>
                  <td>${u.email}</td>
                </tr>`,
            )}
        </tbody>
      </table>
    </div>`}
  </div>`;
}
// Adds days to a YYYY-MM-DD date and returns YYYY-MM-DD (no timezone shift)
const addDays = (s, n) => {
  if (!s) return "";
  const [y, m, d] = s.split("-").map(Number);
  const x = new Date(y, m - 1, d + n);
  return (
    x.getFullYear() +
    "-" +
    String(x.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(x.getDate()).padStart(2, "0")
  );
};

function NeedModal({ book, user, sent, mode, onClose, onOk }) {
  const t0 = today();
  const [st, setSt] = useState(t0),
    [en, setEn] = useState(""), // return date: entered by the student
    [acc, setAcc] = useState(false),
    [err, setErr] = useState(""),
    [n, setN] = useState("1"),
    [note, setNote] = useState("");
  const endDate = addDays(st, 15); // end date = start date + 15 days
  const late =
    en && endDate && en > endDate
      ? Math.round((new Date(en) - new Date(endDate)) / 864e5)
      : 0;
  const ok = () => {
    // Name, roll, email, year and department always come from the student's profile.
    const ex = {
      name: user.name,
      roll: user.roll,
      email: user.email || "",
      note: note.trim(),
    };
    if (mode === "issue") {
      const missing = [!user.email && "Email", !user.year && "Year", !user.dept && "Department"].filter(Boolean);
      if (missing.length)
        return setErr(
          "Please complete your profile first (" + missing.join(", ") + "): open My Profile, then Edit Profile.",
        );
      return onOk(book, t0, "", false, 1, ex);
    }
    if (!st || !en)
      return setErr("Please select the start date and return date.");
    if (st < t0) return setErr("Start date cannot be in the past.");
    if (en < st) return setErr("Return date cannot be before the start date.");
    const k = Math.floor(Number(n));
    if (!(k >= 1)) return setErr("Enter the number of copies needed.");
    if (k > cp(book))
      return setErr(
        "Only " +
          cp(book) +
          " " +
          (cp(book) === 1 ? "copy is" : "copies are") +
          " available.",
      );
    onOk(book, st, en, acc, k, ex);
  };
  if (sent)
    return html`<div class="ov">
      <div class="modal" style=${{ textAlign: "center", alignItems: "center" }}>
        <div style=${{ fontSize: 46, color: "#16a34a" }}>✔</div>
        <h3 style=${{ margin: "8px 0 4px" }}>
          ${mode === "issue" ? "Issue request submitted" : "Booking confirmed"}
        </h3>
        <div class="mut" style=${{ fontSize: 13 }}>${book.title}</div>
        <div class="mut" style=${{ fontSize: 12, marginTop: 8 }}>
          Returning to the search page…
        </div>
      </div>
    </div>`;
  return html`<div class="ov" onClick=${onClose}>
    <div class="modal" onClick=${(e) => e.stopPropagation()}>
      <div class="mh">
        <b>${mode === "issue" ? "Issue about this book" : "Need this book"}</b
        ><button class="x" onClick=${onClose}>×</button>
      </div>
      <h3 style=${{ margin: "10px 0 2px" }}>${book.title}</h3>
      <${BookCover} src=${book.cover} title=${book.title} />
      <div class="mut" style=${{ fontSize: 13 }}>
        ${book.author}${book.cat ? " · " + book.cat : ""}
      </div>
      <div class="row" style=${{ margin: "14px 0 0" }}>
        ${[
          ["Copies available", cp(book)],
          ["End date", fd(endDate)],
          ["Fine per day", "₹" + (book.fine || 0)],
        ]
          .filter((x, i) => mode === "need" || i === 0)
          .map(
            (x) =>
              html`<div
                class="card"
                key=${x[0]}
                style=${{ flex: 1, padding: 10, minWidth: 90 }}
              >
                <p>${x[0]}</p>
                <b>${x[1]}</b>
              </div>`,
          )}
      </div>
      ${mode === "issue" &&
      html`<div>
        <div class="mut" style=${{ fontSize: 12, marginTop: 10 }}>
          These details are taken from your profile.
        </div>
        ${[
          ["Student Name", user.name],
          ["Roll Number", user.roll],
          ["College Email", user.email],
          ["Year", user.year],
          ["Department", user.dept],
          ["Section", user.section],
        ].map(
          (x) =>
            html`<div key=${x[0]}>
              <label>${x[0]}</label>
              <input value=${x[1] || ""} placeholder="Not set - update your profile" disabled />
            </div>`,
        )}
      </div>`}
      ${mode === "need" &&
      html`<div>
        <label>No. of Copies Needed</label
        ><input
          type="number"
          min="1"
          max=${mode === "need" ? cp(book) : undefined}
          value=${n}
          onInput=${(e) => setN(e.target.value)}
        />
        <label>Start Date</label
        ><input
          type="date"
          min=${t0}
          value=${st}
          onInput=${(e) => setSt(e.target.value)}
        />
        <label>Return Date</label
        ><input
          type="date"
          min=${st}
          value=${en}
          onInput=${(e) => setEn(e.target.value)}
        />
      </div>`}
      ${mode === "issue" &&
      html`<div>
        <label>Reason / Note (optional)</label
        ><input
          value=${note}
          onInput=${(e) => setNote(e.target.value)}
          placeholder="Why do you need this book?"
        />
      </div>`}
      ${mode === "need" &&
      html`<div>
        ${late > 0 &&
        html`<div class="err">
          Returning ${late} day(s) after the end date. Fine:
          ₹${late * (book.fine || 0)}
        </div>`}
        <label class="chk"
          ><input
            type="checkbox"
            checked=${acc}
            onChange=${(e) => setAcc(e.target.checked)}
          />I accept the fine of ₹${book.fine || 0} per day${" "}
          ${endDate
            ? "if I return after " + fd(endDate)
            : "if I return late"}</label
        >
      </div>`}
      ${err && html`<div class="err">${err}</div>`}
      <div class="foot" style=${{ gap: 8 }}>
        <button class="btn alt" onClick=${onClose}>Cancel</button
        ><button class="btn" onClick=${ok}>
          ${mode === "issue" ? "Submit" : "OK"}
        </button>
      </div>
    </div>
  </div>`;
}


function Back({ onBack }) {
  return html`<button
    class="back"
    onClick=${() => {
      onBack();
      window.scrollTo(0, 0);
    }}
  >
    ← Back
  </button>`;
}

// ---------------------------------------------------------------------------
// Student bookshelf + book recommendations
// The shelf is saved per student in storage["lms_shelf_<roll>"].
// ---------------------------------------------------------------------------
const SHELF = [
  ["wishlist", "Want to read"],
  ["reading", "Reading now"],
  ["finished", "Finished"],
];

function recommend(user, books, shelf, bookings, issues) {
  const byId = new Map(books.map((b) => [String(b.id), b]));
  const seen = new Set();
  const catW = {},
    authW = {};
  const learn = (book, w) => {
    if (!book) return;
    if (book.cat) catW[book.cat] = (catW[book.cat] || 0) + w;
    if (book.author) authW[book.author] = (authW[book.author] || 0) + w;
  };
  for (const s of shelf) {
    seen.add(String(s.bookId));
    const w = s.status === "finished" ? (s.rating ? s.rating - 2 : 2) : s.status === "reading" ? 2 : 1;
    learn(byId.get(String(s.bookId)), w);
  }
  const touched = [
    ...books.filter((b) => b.by === user.roll),
    ...bookings.filter((x) => x.roll === user.roll).map((x) => byId.get(String(x.bookId))),
    ...issues.filter((x) => x.roll === user.roll).map((x) => byId.get(String(x.bookId))),
  ];
  for (const b of touched) {
    if (!b) continue;
    seen.add(String(b.id));
    learn(b, 2);
  }
  const rows = books
    .filter((b) => !seen.has(String(b.id)) && cp(b) > 0)
    .map((b) => {
      const c = catW[b.cat] || 0,
        a = authW[b.author] || 0;
      return {
        book: b,
        match: c * 2 + a * 3,
        hot: b.total != null ? b.total - cp(b) : 0,
        reason: a > 0 ? "More by " + b.author : c > 0 ? "You like " + b.cat : "Popular right now",
      };
    })
    .filter((r) => r.match >= 0);
  const personal = rows.filter((r) => r.match > 0).sort((x, y) => y.match - x.match);
  const popular = rows.filter((r) => r.match === 0).sort((x, y) => y.hot - x.hot);
  return [...personal, ...popular].slice(0, 6);
}

function MyShelf({ user, books, bookings, issues, storage, setStorage }) {
  const key = "lms_shelf_" + user.roll;
  const raw = Array.isArray(storage[key]) ? storage[key] : [];
  const byId = new Map(books.map((b) => [String(b.id), b]));
  const shelf = raw.filter((s) => byId.has(String(s.bookId)));
  const same = (s, id) => String(s.bookId) === String(id);
  const save = (next) => setStorage({ ...storage, [key]: next });
  const addTo = (book, status) => {
    if (shelf.some((s) => same(s, book.id))) return;
    save([...shelf, { bookId: book.id, status, rating: 0, addedAt: today() }]);
  };
  const patch = (id, change) => save(shelf.map((s) => (same(s, id) ? { ...s, ...change } : s)));
  const remove = (id) => save(shelf.filter((s) => !same(s, id)));
  const recs = recommend(user, books, shelf, bookings, issues);

  return html`<div style=${{ marginTop: 22 }}>
    <b>My bookshelf</b>
    ${shelf.length === 0 &&
    html`<p class="mut">Your shelf is empty. Add a book from "Recommended for you" below.</p>`}
    ${SHELF.map(([status, label]) => {
      const list = shelf.filter((s) => s.status === status);
      return (
        list.length > 0 &&
        html`<div style=${{ margin: "12px 0" }} key=${status}>
          <small class="mut">${label} (${list.length})</small>
          ${list.map((s) => {
            const b = byId.get(String(s.bookId));
            return html`<div class="li book-result" key=${s.bookId}>
              <${BookCover} src=${b.cover} title=${b.title} />
              <span class="book-result-info">${b.title} <small class="mut">— ${b.author}</small></span>
              <span style=${{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                ${status === "finished" &&
                html`<span class="stars">
                  ${[1, 2, 3, 4, 5].map(
                    (n) =>
                      html`<button
                        key=${n}
                        class=${s.rating >= n ? "on" : ""}
                        onClick=${() => patch(s.bookId, { rating: n })}
                      >
                        ★
                      </button>`,
                  )}
                </span>`}
                <select value=${s.status} onChange=${(e) => patch(s.bookId, { status: e.target.value })}>
                  ${SHELF.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
                </select>
                <button class="btn alt" onClick=${() => remove(s.bookId)}>Remove</button>
              </span>
            </div>`;
          })}
        </div>`
      );
    })}

    <b style=${{ display: "block", marginTop: 18 }}>Recommended for you</b>
    ${recs.length === 0
      ? html`<p class="mut">No recommendations yet. They appear as books are added to the catalog.</p>`
      : html`<div class="student-card-grid book-card-grid shelf-recommendations">
          ${recs.map(
            (r) =>
              html`<article class="student-card book-card student-book-card" key=${r.book.id}>
                <${BookCover} src=${r.book.cover} title=${r.book.title} />
                <div class="student-card-details">
                  <p class="book-card-title"><span>Title:</span> <strong>${r.book.title}</strong></p>
                  <p><span>Author:</span> <strong>${r.book.author}</strong></p>
                  <p><span>Category:</span> <strong>${r.book.cat || "-"}</strong></p>
                  <p><span>Fine per day:</span> <strong>₹${r.book.fine || 0}</strong></p>
                  <p><span>Availability:</span> <strong>${cp(r.book)} ${cp(r.book) === 1 ? "copy" : "copies"} available</strong></p>
                  <p><span>Recommended because:</span> <strong>${r.reason}</strong></p>
                </div>
                <button class="btn" onClick=${() => addTo(r.book, "wishlist")}>+ Want to read</button>
              </article>`,
          )}
        </div>`}
  </div>`;
}

function Feature({
  i,
  user,
  users,
  books,
  setBooks,
  fines,
  bookings,
  setBookings,
  issues,
  setIssues,
  storage,
  setStorage,
  log,
  onBack,
}) {
  const f = FEATS[i];
  const [q, setQ] = useState(""),
    [bookFilter, setBookFilter] = useState(""),
    [rs, setRs] = useState([]),
    [need, setNeed] = useState(null),
    [done, setDone] = useState(""),
    [sent, setSent] = useState(false),
    [mode, setMode] = useState("need"),
    [pdfDownloads, setPdfDownloads] = useState({}),
    [digitalSearch, setDigitalSearch] = useState(""),
    [digitalFilter, setDigitalFilter] = useState("");
  const mine = books.filter((b) => b.by === user.roll);
  const downloadPdf = async (book) => {
    setPdfDownloads((current) => ({ ...current, [book.id]: { status: "downloading" } }));
    try {
      await downloadBookPdf(book);
      setPdfDownloads((current) => ({ ...current, [book.id]: { status: "done" } }));
    } catch (error) {
      setPdfDownloads((current) => ({
        ...current,
        [book.id]: { status: "error", message: error.message },
      }));
    }
  };
  const confirmNeed = (b, start, due, acc, k, ex) => {
    const rec = {
      id: Date.now(),
      bookId: b.id,
      title: b.title,
      name: ex.name || user.name,
      roll: ex.roll || user.roll,
      email: ex.email || user.email,
      start,
      due,
      fineAccepted: acc,
      copies: k,
      note: ex.note,
    };
    if (mode === "issue") {
      setIssues([...issues, rec]);
      log(
        "student",
        rec.name,
        'Submitted an issue request for "' + b.title + '"',
        { roll: rec.roll, email: rec.email, book: b.title },
      );
      setDone('Issue request submitted for "' + b.title + '".');
    } else {
      setBookings([...bookings, rec]);
      log(
        "student",
        rec.name,
        "Booked " +
          k +
          " " +
          (k === 1 ? "copy" : "copies") +
          ' of "' +
          b.title +
          '" (start ' +
          fd(start) +
          ", due " +
          fd(due) +
          ", " +
          (acc ? "fine accepted" : "fine not accepted") +
          ")",
        {
          roll: rec.roll,
          email: rec.email,
          book: b.title,
          copies: k,
          start,
          due,
          fine: acc ? "Fine accepted" : "Fine not accepted",
        },
      );
      setBooks(
        books.map((x) => (x.id === b.id ? { ...x, copies: cp(x) - k } : x)),
      );
      setDone(
        'Booking confirmed for "' +
          b.title +
          '" (' +
          k +
          " " +
          (k === 1 ? "copy" : "copies") +
          ").",
      );
    }
    setSent(true);
    setTimeout(() => {
      setSent(false);
      setNeed(null);
      setQ("");
      window.scrollTo(0, 0);
    }, 1000); // back to the search page after 1 second
  };
  const ret = (id) => {
    const bk = books.find((b) => b.id === id);
    setBooks(
      books.map((b) =>
        b.id === id && b.by ? { ...b, by: null, copies: giveBack(b) } : b,
      ),
    );
    log("student", user.name, 'Returned "' + (bk ? bk.title : "") + '"', {
      roll: user.roll,
      email: user.email,
      book: bk ? bk.title : "",
    });
  };
  let body;
  if (i === 0) {
    const r = books.filter((b) =>
      (b.title + " " + b.author + " " + (b.cat || ""))
        .toLowerCase()
        .includes(bookFilter.toLowerCase()),
    );
    body = html`<div>
      <form
        class="book-search-form"
        onSubmit=${(e) => {
          e.preventDefault();
          setBookFilter(q.trim());
        }}
      >
        <input
          placeholder="Search by title or author"
          value=${q}
          onInput=${(e) => setQ(e.target.value)}
        />
        <button class="btn" type="submit">Find</button>
        <button
          class="btn book-search-reset"
          type="button"
          aria-label="Show all books and clear search"
          title="Show all books"
          onClick=${() => {
            setQ("");
            setBookFilter("");
          }}
        >↻</button>
      </form>
      <div style=${{ marginTop: 12 }}>
        ${r.length
          ? html`<div class="student-card-grid book-card-grid">
              ${r.map(
              (b) =>
                html`<article class="student-card book-card student-book-card" key=${b.id}>
                  <${BookCover} src=${b.cover} title=${b.title} />
                  <div class="student-card-details">
                    <p class="book-card-title"><span>Title:</span> <strong>${b.title}</strong></p>
                    <p><span>Author:</span> <strong>${b.author}</strong></p>
                    <p><span>Category:</span> <strong>${b.cat || "-"}</strong></p>
                    <p><span>Fine per day:</span> <strong>₹${b.fine || 0}</strong></p>
                    <p>
                      <span>Availability:</span>
                      <strong>${cp(b) > 0
                        ? cp(b) + " " + (cp(b) === 1 ? "copy" : "copies") + " available"
                        : "Not available"}</strong>
                    </p>
                  </div>
                  ${cp(b) > 0
                    ? html`<button
                        class="btn"
                        onClick=${() => {
                          setDone("");
                          setMode("need");
                          setNeed(b);
                        }}
                      >
                        Need
                      </button>`
                    : html`<button
                        class="btn alt"
                        onClick=${() => {
                          setDone("");
                          setMode("issue");
                          setNeed(b);
                        }}
                      >
                        Issue
                      </button>`}
                </article>`,
            )}
            </div>`
          : html`<p class="mut">
              ${books.length
                ? "No books found."
                : "No books have been added yet."}
            </p>`}
      </div>
    </div>`;
  } else if (i === 1) {
    const myB = bookings.filter((x) => x.roll === user.roll),
      myI = issues.filter((x) => x.roll === user.roll);
    const dueTag = (d) => {
      const n = Math.round((new Date(d) - new Date(today())) / 864e5);
      return n < 0
        ? "Overdue by " + -n + (n === -1 ? " day" : " days")
        : n === 0
          ? "Due today"
          : n + (n === 1 ? " day left" : " days left");
    };
    const row = (x, status) => {
      const book = books.find((item) => String(item.id) === String(x.bookId));
      return html`<article class="student-card book-card student-book-card" key=${status + x.id}>
          <${BookCover} src=${book && book.cover} title=${x.title} />
          <div class="student-card-details">
            <p class="book-card-title"><span>Title:</span> <strong>${x.title}</strong></p>
            <p><span>Author:</span> <strong>${book ? book.author : "-"}</strong></p>
            <p><span>Copies:</span> <strong>${x.copies || 1}</strong></p>
            <p><span>Start date:</span> <strong>${fd(x.start)}</strong></p>
            <p><span>Return date:</span> <strong>${fd(x.due)}</strong></p>
            <p><span>Status:</span> <strong>${status || dueTag(x.due)}</strong></p>
            ${x.fineAccepted && html`<p><span>Fine:</span> <strong>Accepted</strong></p>`}
          </div>
      </article>`;
    };
    const sec = (title, list) =>
      list.length > 0 &&
      html`<div style=${{ marginBottom: 16 }}>
          <b style=${{ fontSize: 13 }}>${title}</b>
          <div class="student-card-grid book-card-grid">${list}</div>
      </div>`;
    body =
      myB.length || myI.length || mine.length
        ? html`<div>
            ${sec(
              "Booked books",
              myB.map((x) => row(x, "")),
            )}
            ${sec(
              "Issue requests",
              myI.map((x) => row(x, x.accepted ? "Approved" : "Waiting for approval")),
            )}
            ${sec(
              "Borrowed books",
              mine.map(
                (b) =>
                  html`<div class="li" key=${b.id}>
                    <span>${b.title}</span
                    ><button class="btn alt" onClick=${() => ret(b.id)}>
                      Return
                    </button>
                  </div>`,
              ),
            )}
          </div>`
        : html`<p class="mut">
            You have not booked or borrowed any books yet. Search for a book and
            click Need to book it.
          </p>`;
  } else if (i === 2) {
    const un = books.filter((b) => b.by && b.by !== user.roll);
    body = un.length
      ? un.map(
          (b, k) =>
            html`<div class="li" key=${b.id}>
              <span>${b.title}</span>${rs.includes(b.id)
                ? html`<small>Queue position: ${rs.indexOf(b.id) + 1}</small>`
                : html`<button
                    class="btn alt"
                    onClick=${() => {
                      setRs([...rs, b.id]);
                      log("student", user.name, 'Reserved "' + b.title + '"', {
                        roll: user.roll,
                        email: user.email,
                        book: b.title,
                      });
                    }}
                  >
                    Reserve
                  </button>`}
            </div>`,
        )
      : html`<p class="mut">
          All books are currently available, so nothing needs to be reserved.
        </p>`;
  } else if (i === 3) {
    const digitalBooks = books.filter(
      (book) =>
        book.pdfId &&
        (book.title + " " + book.author + " " + (book.cat || ""))
          .toLowerCase()
          .includes(digitalFilter.toLowerCase()),
    );
    const hasDigitalBooks = books.some((book) => book.pdfId);
    body = html`<form
        class="book-search-form"
        onSubmit=${(e) => {
          e.preventDefault();
          setDigitalFilter(digitalSearch.trim());
        }}
      >
        <input
          type="search"
          aria-label="Search digital library by book title or author"
          placeholder="Search digital books"
          value=${digitalSearch}
          onInput=${(e) => setDigitalSearch(e.target.value)}
        />
        <button class="btn" type="submit">Find</button>
        <button
          class="btn book-search-reset"
          type="button"
          aria-label="Show all digital books and clear search"
          title="Show all digital books"
          onClick=${() => {
            setDigitalSearch("");
            setDigitalFilter("");
          }}
        >↻</button>
      </form>
      <div style=${{ marginTop: 12 }}>
        ${digitalBooks.length
      ? html`<div class="student-card-grid book-card-grid">
          ${digitalBooks.map(
            (book) =>
              html`<article class="student-card book-card student-book-card" key=${book.id}>
                <${BookCover} src=${book.cover} title=${book.title} />
                <div class="student-card-details">
                  <p class="book-card-title"><span>Title:</span> <strong>${book.title}</strong></p>
                  <p><span>Author:</span> <strong>${book.author}</strong></p>
                </div>
                <button
                  class="btn"
                  disabled=${pdfDownloads[book.id]?.status === "downloading"}
                  onClick=${() => downloadPdf(book)}
                >${pdfDownloads[book.id]?.status === "downloading" ? "Downloading…" : "Download PDF"}</button>
                ${pdfDownloads[book.id]?.status === "error" &&
                html`<small class="err">${pdfDownloads[book.id].message}</small>`}
              </article>`,
          )}
        </div>`
      : html`<p class="mut">${hasDigitalBooks ? "No digital books match your search." : "No downloadable books are available yet."}</p>`}
      </div>`;
  } else if (i === 4) {
    body = html`<div>
      ${fines
        .filter((x) => x.roll === user.roll && !x.paid)
        .map(
          (x) =>
            html`<div class="li" key=${x.id}>
              <span>Fine pending: ₹${x.amount} (${x.reason})</span>
            </div>`,
        )}${mine.map(
        (b) =>
          html`<div class="li" key=${b.id}>
            <span>Reminder: return "${b.title}" within 14 days</span>
          </div>`,
      )}
      <div class="li">
        <span>Welcome to the Library Management System</span>
      </div>
      <div class="li">
        <span>Late fines are applied after the due date</span>
      </div>
    </div>`;
  } else {
    const tc = books.reduce((s, b) => s + tot(b, bookings), 0),
      ac = books.reduce((s, b) => s + cp(b), 0);
    const myCopies = bookings
      .filter((x) => x.roll === user.roll)
      .reduce((s, x) => s + (x.copies || 1), 0);
    const st = [
      ["Total Books", tc],
      ["Borrowed", Math.max(0, tc - ac)],
      ["Borrowed by You", myCopies],
      ["Available", ac],
      ["Students", users.filter((u) => u.role === "student").length],
    ];
    body = html`<div class="grid" style=${{ marginTop: 0 }}>
      ${st.map(
        (s) =>
          html`<div class="card" key=${s[0]}>
            <p>${s[0]}</p>
            <h2 style=${{ margin: "6px 0 0" }}>${s[1]}</h2>
          </div>`,
      )}
    </div>`;
  }
  return html`<div class="wrap">
    <${Back} onBack=${onBack} />
    <div class="card">
      <div class="ic">${f[0]}</div>
      <h2 style=${{ margin: "10px 0 4px" }}>${f[1]}</h2>
      <div class="mut" style=${{ fontSize: 13, marginBottom: 14 }}>
        ${i === 0 ? "" : f[2]}
      </div>
      ${i === 0 &&
      done &&
      html`<div class="ok" style=${{ marginBottom: 10 }}>${done}</div>`}${body}
      ${i === 1 &&
      html`<${MyShelf}
        user=${user}
        books=${books}
        bookings=${bookings}
        issues=${issues}
        storage=${storage}
        setStorage=${setStorage}
      />`}
    </div>
    ${need &&
    html`<${NeedModal}
      book=${need}
      onClose=${() => setNeed(null)}
      onOk=${confirmNeed}
      sent=${sent}
      mode=${mode}
      user=${user}
    />`}
  </div>`;
}

function AdminDash({
  page,
  user,
  users,
  books,
  setBooks,
  setUsers,
  fines,
  setFines,
  bookings,
  setBookings,
  issues,
  setIssues,
  log,
  history,
  onBack,
  storage,
  setStorage,
  onStateVersion,
}) {
  const [ti, setTi] = useState(""),
    [au, setAu] = useState(""),
    [cat, setCat] = useState(""),
    [cover, setCover] = useState(""),
    [roll, setRoll] = useState(""),
    [bid, setBid] = useState(""),
    [msg, setMsg] = useState(""),
    [fr, setFr] = useState(""),
    [fa, setFa] = useState(""),
    [fw, setFw] = useState("");
  const [nc, setNc] = useState(""),
    [ed, setEd] = useState(""),
    [fn, setFn] = useState(""),
    [coverMessage, setCoverMessage] = useState(""),
    [coverError, setCoverError] = useState(false),
    [acc, setAcc] = useState(null),
    [addN, setAddN] = useState(""),
    [aerr, setAerr] = useState(""),
    [htab, setHtab] = useState(""),
    [addEnd, setAddEnd] = useState("");
  const [studentSearch, setStudentSearch] = useState(""),
    [studentFilter, setStudentFilter] = useState(""),
    [bookingSearch, setBookingSearch] = useState(""),
    [bookingFilter, setBookingFilter] = useState("");
  const [addingBook, setAddingBook] = useState(false);
  const [bookAdded, setBookAdded] = useState(false);
  const bookAddedTimer = useRef(null);
  const [bookCoverUploads, setBookCoverUploads] = useState({});
  const [bookPdfUploads, setBookPdfUploads] = useState({});
  useEffect(() => () => window.clearTimeout(bookAddedTimer.current), []);
  const students = users.filter((u) => u.role === "student");
  const visibleStudents = students.filter((student) =>
    String(student.roll || "").toLowerCase().includes(studentFilter.toLowerCase()),
  );
  const visibleBookings = bookings.filter((booking) =>
    String(booking.roll || "").toLowerCase().includes(bookingFilter.toLowerCase()),
  );
  // Rolls can be college e-mail addresses (stored lowercase) or upper-case numbers.
  const userOf = (r) =>
    users.find((u) => String(u.roll).toLowerCase() === String(r || "").toLowerCase());
  const profileOf = (r) => userOf(r) || {};
  const findStudent = (v) =>
    students.find((s) => s.roll.toLowerCase() === String(v).trim().toLowerCase());
  const issued = books.filter((b) => b.by);
  const free = books.filter((b) => !b.by);
  const totalCopies = books.reduce((s, b) => s + tot(b, bookings), 0),
    availCopies = books.reduce((s, b) => s + cp(b), 0),
    outCopies = Math.max(0, totalCopies - availCopies);
  const accBook = acc ? books.find((b) => b.id === acc.bookId) : null;
  const submitAccept = () => {
    const k = Math.floor(Number(addN));
    if (!accBook) return setAerr("This book no longer exists in the catalog.");
    if (!(k >= 1)) return setAerr("Enter how many copies should be added.");
    if (!addEnd) return setAerr("Select the end date for this book.");
    setBooks(
      books.map((b) =>
        b.id === accBook.id
          ? {
              ...b,
              copies: cp(b) + k,
              total: tot(b, bookings) + k,
              endDate: addEnd,
            }
          : b,
      ),
    );
    setIssues(
      issues.map((x) =>
        x.id === acc.id ? { ...x, accepted: true, added: k } : x,
      ),
    );
    log(
      "admin",
      user.name,
      "Accepted the issue request of " +
        acc.name +
        " (" +
        acc.roll +
        ') for "' +
        accBook.title +
        '" and added ' +
        k +
        " " +
        (k === 1 ? "copy" : "copies"),
      { book: accBook.title, copies: k, endDate: addEnd },
    );
    setAcc(null);
    setAddN("");
    setAddEnd("");
    setAerr("");
    setMsg(
      k +
        " " +
        (k === 1 ? "copy" : "copies") +
        ' added to "' +
        accBook.title +
        '". End date: ' +
        fd(addEnd),
    );
  };
  const nameOf = (r) => {
    const u = users.find((x) => x.roll === r);
    return u ? u.name : r;
  };
  const titles = {
    dash: "Dashboard",
    books: "Manage Books",
    issue: "Issue Book",
    return: "Return Book",
    fines: "Manage Fines & Payments",
    history: "History",
  };
  const selectCover = (e) => {
    const input = e.currentTarget;
    const file = input.files && input.files[0];
    if (!file) return;
    setCover("");
    input.value = "";
    setCoverError(false);
    setCoverMessage("");
    squareCoverFromFile(file).then(
      (squareCover) => {
        setCover(squareCover);
        setCoverError(false);
        setCoverMessage("Cover image ready.");
      },
      (error) => {
        setCoverError(true);
        setCoverMessage(error.message);
      },
    );
  };
  const uploadBookCover = (book, e) => {
    const input = e.currentTarget;
    const file = input.files && input.files[0];
    input.value = "";
    if (!file || book.cover) return;
    setBookCoverUploads((current) => ({ ...current, [book.id]: { status: "uploading" } }));
    squareCoverFromFile(file).then(
      (coverImage) => {
        setBooks((current) =>
          current.map((item) => (item.id === book.id && !item.cover ? { ...item, cover: coverImage } : item)),
        );
        setBookCoverUploads((current) => ({ ...current, [book.id]: { status: "done" } }));
      },
      (error) => {
        setBookCoverUploads((current) => ({
          ...current,
          [book.id]: { status: "error", message: error.message },
        }));
      },
    );
  };
  const uploadBookDigitalCopy = async (book, e) => {
    const input = e.currentTarget;
    const file = input.files && input.files[0];
    input.value = "";
    if (!file || book.pdfId) return;
    setBookPdfUploads((current) => ({ ...current, [book.id]: { status: "uploading" } }));
    try {
      const result = await uploadBookPdf(book.id, file);
      onStateVersion(result.version);
      setBooks((current) =>
        current.map((item) => (item.id === book.id ? { ...item, pdfId: result.pdfId } : item)),
      );
      setBookPdfUploads((current) => ({ ...current, [book.id]: { status: "done" } }));
    } catch (error) {
      setBookPdfUploads((current) => ({
        ...current,
        [book.id]: { status: "error", message: error.message },
      }));
    }
  };
  const add = async () => {
    if (addingBook) return;
    if (!ti.trim() || !au.trim() || !nc || fn === "")
      return setMsg(
        "Please fill all book details: title, author, copies and fine.",
      );
    if (!(Number(nc) >= 1) || Number(fn) < 0)
      return setMsg("Copies must be at least 1 and fine cannot be negative.");
    window.clearTimeout(bookAddedTimer.current);
    setBookAdded(false);
    setAddingBook(true);
    setMsg("");
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      setBooks([
        ...books,
        {
          id: Date.now(),
          title: ti.trim(),
          author: au.trim(),
          cat: cat.trim(),
          copies: Math.floor(Number(nc)),
          total: Math.floor(Number(nc)),
          endDate: ed,
          fine: Number(fn),
          cover,
          by: null,
        },
      ]);
      log(
        "admin",
        user.name,
        'Added book "' +
          ti.trim() +
          '" with ' +
          nc +
          " " +
          (Number(nc) === 1 ? "copy" : "copies"),
        {
          book: ti.trim(),
          author: au.trim(),
          cat: cat.trim(),
          copies: Math.floor(Number(nc)),
          endDate: ed,
          fine: Number(fn),
        },
      );
      setTi("");
      setAu("");
      setCat("");
      setNc("");
      setEd("");
      setFn("");
      setCover("");
      setCoverMessage("");
      setCoverError(false);
      setBookAdded(true);
      bookAddedTimer.current = window.setTimeout(() => setBookAdded(false), 1800);
    } finally {
      setAddingBook(false);
    }
  };
  const issue = () => {
    const student = findStudent(roll);
    if (!student) return setMsg("No student found with that roll number.");
    const r = student.roll;
    const b = free.find((x) => String(x.id) === bid);
    if (!b) return setMsg("Select an available book.");
    if (cp(b) < 1) return setMsg("No copies of this book are available.");
    setBooks(books.map((x) => (x.id === b.id ? { ...x, by: r, copies: cp(x) - 1 } : x)));
    setRoll("");
    setBid("");
    setMsg("Book issued to " + nameOf(r) + ".");
  };
  const returnBook = (id) => {
    const bk = books.find((b) => b.id === id);
    setBooks(
      books.map((b) =>
        b.id === id && b.by ? { ...b, by: null, copies: giveBack(b) } : b,
      ),
    );
    setMsg("Book marked as returned.");
    log(
      "admin",
      user.name,
      'Marked "' + (bk ? bk.title : "") + '" as returned',
    );
  };
  const removeStudent = (r) => {
    log("admin", user.name, "Removed student " + nameOf(r) + " (" + r + ")");
    setUsers(users.filter((u) => u.role !== "student" || u.roll !== r));
    setBooks(books.map((b) => (b.by === r ? { ...b, by: null, copies: giveBack(b) } : b)));
    setFines(fines.filter((f) => f.roll !== r));
    setBookings(bookings.filter((x) => x.roll !== r));
    setIssues(issues.filter((x) => x.roll !== r));
  };
  const addFine = () => {
    const student = findStudent(fr),
      amt = Number(fa);
    if (!student) return setMsg("No student found with that roll number.");
    const r = student.roll;
    if (!amt || amt <= 0) return setMsg("Enter a valid fine amount.");
    setFines([
      ...fines,
      {
        id: Date.now(),
        roll: r,
        amount: amt,
        reason: fw.trim() || "Late return",
        paid: false,
      },
    ]);
    log(
      "admin",
      user.name,
      "Recorded a fine of ₹" + amt + " for " + nameOf(r) + " (" + r + ")",
    );
    setFr("");
    setFa("");
    setFw("");
    setMsg("Fine recorded for " + nameOf(r) + ".");
  };
  const total = fines.reduce((s, f) => s + f.amount, 0),
    paid = fines.filter((f) => f.paid).reduce((s, f) => s + f.amount, 0);
  const stat = (l, v) =>
    html`<div class="card" key=${l}>
      <p>${l}</p>
      <h2 style=${{ margin: "6px 0 0" }}>${v}</h2>
    </div>`;
  let body = null;
  if (page === "dash") {
    body = html`<div>
      <div class="card student-directory">
        <div class="student-directory-header">
          <h3 class="student-directory-title">Registered Students</h3>
          <form
            class="student-search-form"
            onSubmit=${(e) => {
              e.preventDefault();
              setStudentFilter(studentSearch.trim().toLowerCase());
            }}
          >
            <input
              class="student-search"
              type="search"
              aria-label="Search students by roll number"
              placeholder="Search by roll number"
              value=${studentSearch}
              onInput=${(e) => setStudentSearch(e.target.value)}
            />
            <button class="btn" type="submit">Find</button>
            <button
              class="btn alt student-search-reset"
              type="button"
              aria-label="Show all students and clear search"
              title="Show all students"
              onClick=${() => {
                setStudentSearch("");
                setStudentFilter("");
              }}
            >↻</button>
          </form>
        </div>${students.length
          ? visibleStudents.length
            ? html`<div class="student-card-grid">
              ${visibleStudents.map(
                (s) =>
                  html`<article class="student-card" key=${s.roll}>
                    <div class="student-card-details">
                      <p><span>Name:</span> <strong>${s.name || "-"}</strong></p>
                      <p><span>Roll No:</span> <strong>${s.roll || "-"}</strong></p>
                      <p><span>Email:</span> <strong>${s.email || "-"}</strong></p>
                      <p><span>Year:</span> <strong>${s.year || "-"}</strong></p>
                      <p><span>Department:</span> <strong>${s.dept || "-"}</strong></p>
                      <p><span>Section:</span> <strong>${s.section || "-"}</strong></p>
                    </div>
                    <button class="btn alt" onClick=${() => removeStudent(s.roll)}>Remove</button>
                  </article>`,
              )}
            </div>`
            : html`<p class="mut" style=${{ marginTop: 10 }}>
              No students match that roll number.
            </p>`
          : html`<p class="mut" style=${{ marginTop: 10 }}>
              No students have registered yet.
            </p>`}
      </div>
      <div class="card booking-directory" style=${{ marginTop: 16 }}>
        <div class="student-directory-header">
          <h3 class="student-directory-title">Booking Confirm Details</h3>
          <form
            class="student-search-form"
            onSubmit=${(e) => {
              e.preventDefault();
              setBookingFilter(bookingSearch.trim().toLowerCase());
            }}
          >
            <input
              class="student-search"
              type="search"
              aria-label="Search bookings by roll number"
              placeholder="Search by roll number"
              value=${bookingSearch}
              onInput=${(e) => setBookingSearch(e.target.value)}
            />
            <button class="btn" type="submit">Find</button>
            <button
              class="btn student-search-reset"
              type="button"
              aria-label="Show all bookings and clear search"
              title="Show all bookings"
              onClick=${() => {
                setBookingSearch("");
                setBookingFilter("");
              }}
            >↻</button>
          </form>
        </div>${bookings.length
          ? visibleBookings.length
            ? html`<div class="student-card-grid">
              ${visibleBookings.map((x) => {
                const student = profileOf(x.roll);
                return html`<article class="student-card booking-card" key=${x.id}>
                  <div class="student-card-details">
                    <p><span>Name:</span> <strong>${x.name || student.name || "-"}</strong></p>
                    <p><span>Roll No:</span> <strong>${x.roll || "-"}</strong></p>
                    <p><span>College Email:</span> <strong>${student.email || x.email || "-"}</strong></p>
                    <p><span>Year:</span> <strong>${student.year || "-"}</strong></p>
                    <p><span>Department:</span> <strong>${student.dept || "-"}</strong></p>
                    <p><span>Section:</span> <strong>${student.section || "-"}</strong></p>
                    <p><span>Book:</span> <strong>${x.title || "-"}</strong></p>
                    <p><span>Copies:</span> <strong>${x.copies || 1}</strong></p>
                    <p><span>Start Date:</span> <strong>${fd(x.start)}</strong></p>
                    <p><span>Due Date:</span> <strong>${fd(x.due)}</strong></p>
                    <p><span>Status:</span> <strong style=${{
                      color: x.fineAccepted ? "#16a34a" : "#e5484d",
                    }}>${x.fineAccepted ? "Fine accepted" : "Fine not accepted"}</strong></p>
                  </div>
                </article>`;
              })}
            </div>`
            : html`<p class="mut" style=${{ marginTop: 10 }}>
              No bookings match that roll number.
            </p>`
          : html`<p class="mut" style=${{ marginTop: 10 }}>
              No bookings confirmed yet.
            </p>`}
      </div>
    </div>`;
  } else if (page === "books") {
    body = html`<div>
      <div class="card" style=${{ marginBottom: 16 }}>
        <b>Add a book</b>
        <div class="row" style=${{ marginTop: 4 }}>
          <div style=${{ flex: 1, minWidth: 150 }}>
            <label>Book Title</label
            ><input
              placeholder="Title"
              disabled=${addingBook}
              value=${ti}
              onInput=${(e) => setTi(e.target.value)}
            />
          </div>
          <div style=${{ flex: 1, minWidth: 150 }}>
            <label>Author</label
            ><input
              placeholder="Author"
              disabled=${addingBook}
              value=${au}
              onInput=${(e) => setAu(e.target.value)}
            />
          </div>
          <div style=${{ flex: 1, minWidth: 150 }}>
            <label>Category</label
            ><input
              placeholder="Category"
              disabled=${addingBook}
              value=${cat}
              onInput=${(e) => setCat(e.target.value)}
            />
          </div>
          <div style=${{ flex: 1, minWidth: 150 }}>
            <label>No. of Copies Available</label
            ><input
              type="number"
              min="1"
              placeholder="e.g. 5"
              disabled=${addingBook}
              value=${nc}
              onInput=${(e) => setNc(e.target.value)}
            />
          </div>
          <div style=${{ flex: 1, minWidth: 150 }}>
            <label>Fine per Day (₹)</label
            ><input
              type="number"
              min="0"
              placeholder="e.g. 5"
              disabled=${addingBook}
              value=${fn}
              onInput=${(e) => setFn(e.target.value)}
            />
          </div>
          <div class="book-cover-upload">
            <label>Upload Book Cover Page</label>
            <input type="file" accept="image/*" disabled=${addingBook} onChange=${selectCover} />
            <small class="mut">Entire cover is fitted into a high-resolution square without cropping.</small>
            ${coverMessage && html`<small class=${coverError ? "err" : "ok"}>${coverMessage}</small>`}
            ${cover &&
            html`<div class="book-cover-preview">
              <${BookCover} src=${cover} title=${ti || "Book"} />
            </div>`}
          </div>
        </div>
        <button class="btn" style=${{ marginTop: 14 }} onClick=${add} disabled=${addingBook}>
          Add Book
        </button>
      </div>
      <div class="card book-directory">
        <h3 class="student-directory-title">Books in Catalog</h3>
        ${books.length
          ? html`<div class="student-card-grid book-card-grid">
              ${books.map(
                (b) =>
                  html`<article class="student-card book-card" key=${b.id}>
                    <${BookCover} src=${b.cover} title=${b.title} />
                    ${!b.cover &&
                    html`<div class="book-card-cover-upload">
                      <label>Upload cover page</label>
                      <input
                        type="file"
                        accept="image/*"
                        disabled=${bookCoverUploads[b.id]?.status === "uploading"}
                        onChange=${(e) => uploadBookCover(b, e)}
                      />
                      <small class=${bookCoverUploads[b.id]?.status === "error" ? "err" : "mut"}>
                        ${bookCoverUploads[b.id]?.status === "uploading"
                          ? "Preparing cover…"
                          : bookCoverUploads[b.id]?.message || "Select an image to add a cover."}
                      </small>
                    </div>`}
                    ${b.pdfId
                      ? html`<small class="ok">PDF uploaded and available in Digital Library.</small>`
                      : html`<div class="book-card-cover-upload">
                          <label>Upload Digital Book PDF</label>
                          <input
                            type="file"
                            accept="application/pdf,.pdf"
                            disabled=${bookPdfUploads[b.id]?.status === "uploading"}
                            onChange=${(e) => uploadBookDigitalCopy(b, e)}
                          />
                          <small class=${bookPdfUploads[b.id]?.status === "error" ? "err" : "mut"}>
                            ${bookPdfUploads[b.id]?.status === "uploading"
                              ? "Uploading PDF…"
                              : bookPdfUploads[b.id]?.message || "Select a PDF file."}
                          </small>
                        </div>`}
                    <div class="student-card-details">
                      <p class="book-card-title"><span>Title:</span> <strong>${b.title}</strong></p>
                      <p><span>Author:</span> <strong>${b.author}</strong></p>
                      <p><span>Category:</span> <strong>${b.cat || "-"}</strong></p>
                      <p><span>Available / Total:</span> <strong>${cp(b)} / ${tot(b, bookings)}</strong></p>
                      <p><span>Fine per day:</span> <strong>₹${b.fine || 0}</strong></p>
                      <p><span>Status:</span> <strong>${b.by ? "Issued to " + b.by : "Available"}</strong></p>
                    </div>
                    <button
                      class="btn alt"
                      onClick=${() => {
                        setBooks(books.filter((x) => x.id !== b.id));
                        setBookings(bookings.filter((x) => x.bookId !== b.id));
                        setIssues(issues.filter((x) => x.bookId !== b.id));
                        log("admin", user.name, 'Removed book "' + b.title + '"', { book: b.title });
                      }}
                    >
                      Remove
                    </button>
                  </article>`,
              )}
            </div>`
          : html`<p class="mut" style=${{ marginTop: 10 }}>No books have been added yet.</p>`}
      </div>
    </div>`;
  } else if (page === "issue") {
    body = html`<div>
      <div class="card tw">
        <b>Issue Requests</b>${issues.length
          ? html`<table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Roll No</th>
                  <th>College Email</th>
                  <th>Year</th>
                  <th>Department</th>
                  <th>Section</th>
                  <th>Book</th>
                  <th>Note</th>
                  <th>Submitted On</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${issues.map(
                  (x) =>
                    html`<tr key=${x.id}>
                      <td>${x.name}</td>
                      <td>${x.roll}</td>
                      <td>${profileOf(x.roll).email || x.email || "-"}</td>
                      <td>${profileOf(x.roll).year || "-"}</td>
                      <td>${profileOf(x.roll).dept || "-"}</td>
                      <td>${profileOf(x.roll).section || "-"}</td>
                      <td>${x.title}</td>
                      <td>${x.note || "-"}</td>
                      <td>${fd(x.start)}</td>
                      <td
                        style=${{
                          color: x.accepted ? "#16a34a" : "inherit",
                          fontWeight: 700,
                        }}
                      >
                        ${x.accepted
                          ? "Accepted (+" + x.added + ")"
                          : "Pending"}
                      </td>
                      <td style=${{ whiteSpace: "nowrap" }}>
                        ${!x.accepted &&
                        html`<button
                          class="btn"
                          onClick=${() => {
                            setAcc(x);
                            setAddN("");
                            setAddEnd(
                              (books.find((b) => b.id === x.bookId) || {})
                                .endDate || "",
                            );
                            setAerr("");
                          }}
                        >
                          Accepted
                        </button>`}${" "}<button
                          class="btn alt"
                          onClick=${() => {
                            setIssues(issues.filter((y) => y.id !== x.id));
                            log(
                              "admin",
                              user.name,
                              "Removed the issue request of " +
                                x.name +
                                " (" +
                                x.roll +
                                ') for "' +
                                x.title +
                                '"',
                            );
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="mut" style=${{ marginTop: 10 }}>
              No issue requests yet.
            </p>`}
      </div>
    </div>`;
  } else if (page === "return") {
    body = html`<div class="card tw">
      <b>Currently issued books</b>${issued.length
        ? html`<table>
            <thead>
              <tr>
                <th>Book</th>
                <th>Student</th>
                <th>Roll No</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${issued.map(
                (b) =>
                  html`<tr key=${b.id}>
                    <td>${b.title}</td>
                    <td>${nameOf(b.by)}</td>
                    <td>${b.by}</td>
                    <td>
                      <button class="btn alt" onClick=${() => returnBook(b.id)}>
                        Mark Returned
                      </button>
                    </td>
                  </tr>`,
              )}
            </tbody>
          </table>`
        : html`<p class="mut" style=${{ marginTop: 10 }}>
            No books are currently issued.
          </p>`}
    </div>`;
  } else if (page === "history") {
    const when = (h) => new Date(h.at).toLocaleString();
    const studentRows = history.filter((h) => h.by === "student"),
      adminRows = history.filter((h) => h.by === "admin");
    const studentTable = html`<div class="card tw">
      <b>Student Activity</b>${studentRows.length
        ? html`<table>
            <thead>
              <tr>
                <th>Date and Time</th>
                <th>Name</th>
                <th>Roll No</th>
                <th>College Email</th>
                <th>Year</th>
                <th>Department</th>
                <th>Section</th>
                <th>Activity</th>
                <th>Book</th>
                <th>Copies</th>
                <th>Start Date</th>
                <th>Return Date</th>
                <th>Fine Status</th>
              </tr>
            </thead>
            <tbody>
              ${studentRows.map((h) => {
                const d = h.data || {},
                  u = userOf(d.roll) || users.find((x) => x.name === h.actor) || {};
                return html`<tr key=${h.id}>
                  <td style=${{ whiteSpace: "nowrap" }}>${when(h)}</td>
                  <td>${h.actor}</td>
                  <td>${d.roll || u.roll || "-"}</td>
                  <td>${u.email || d.email || "-"}</td>
                  <td>${u.year || "-"}</td>
                  <td>${u.dept || "-"}</td>
                  <td>${u.section || "-"}</td>
                  <td>${h.text}</td>
                  <td>${d.book || "-"}</td>
                  <td>${d.copies == null ? "-" : d.copies}</td>
                  <td>${d.start ? fd(d.start) : "-"}</td>
                  <td>${d.due ? fd(d.due) : "-"}</td>
                  <td
                    style=${{
                      fontWeight: 700,
                      color:
                        d.fine === "Fine accepted"
                          ? "#16a34a"
                          : d.fine
                            ? "#e5484d"
                            : "inherit",
                    }}
                  >
                    ${d.fine || "-"}
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>`
        : html`<p class="mut" style=${{ marginTop: 10 }}>
            No student activity recorded yet.
          </p>`}
    </div>`;
    const adminTable = html`<div class="card tw">
      <b>Administrator Activity</b>${adminRows.length
        ? html`<table>
            <thead>
              <tr>
                <th>Date and Time</th>
                <th>Name</th>
                <th>Activity</th>
                <th>Book</th>
                <th>Author</th>
                <th>Category</th>
                <th>Copies</th>
                <th>End Date</th>
                <th>Fine per Day</th>
              </tr>
            </thead>
            <tbody>
              ${adminRows.map((h) => {
                const d = h.data || {};
                return html`<tr key=${h.id}>
                  <td style=${{ whiteSpace: "nowrap" }}>${when(h)}</td>
                  <td>${h.actor}</td>
                  <td>${h.text}</td>
                  <td>${d.book || "-"}</td>
                  <td>${d.author || "-"}</td>
                  <td>${d.cat || "-"}</td>
                  <td>${d.copies == null ? "-" : d.copies}</td>
                  <td>${d.endDate ? fd(d.endDate) : "-"}</td>
                  <td>${d.fine == null ? "-" : "₹" + d.fine}</td>
                </tr>`;
              })}
            </tbody>
          </table>`
        : html`<p class="mut" style=${{ marginTop: 10 }}>
            No administrator activity recorded yet.
          </p>`}
    </div>`;
    body = html`<div>
      <div class="row" style=${{ marginBottom: 16 }}>
        <button
          class=${htab === "student" ? "btn" : "btn alt"}
          onClick=${() => setHtab(htab === "student" ? "" : "student")}
        >
          Student Activity
        </button>
        <button
          class=${htab === "admin" ? "btn" : "btn alt"}
          onClick=${() => setHtab(htab === "admin" ? "" : "admin")}
        >
          Administrator Activity
        </button>
      </div>
      ${htab === "" &&
      html`<p class="mut">
        Click Student Activity or Administrator Activity to view the table.
      </p>`}
      ${htab === "student" && studentTable}${htab === "admin" && adminTable}
    </div>`;
  } else {
    body = html`<div>
      <div class="grid" style=${{ margin: "0 0 16px", maxWidth: "none" }}>
        ${stat("Total Fines", "₹" + total)}${stat(
          "Payments Received",
          "₹" + paid,
        )}${stat("Pending", "₹" + (total - paid))}
      </div>
      <div class="card" style=${{ marginBottom: 16 }}>
        <b>Record a fine</b>
        <div class="row" style=${{ marginTop: 10 }}>
          <input
            placeholder="Student roll number"
            value=${fr}
            onInput=${(e) => setFr(e.target.value)}
          />
          <input
            type="number"
            min="1"
            placeholder="Amount (₹)"
            value=${fa}
            onInput=${(e) => setFa(e.target.value)}
          />
          <input
            placeholder="Reason (e.g. Late return)"
            value=${fw}
            onInput=${(e) => setFw(e.target.value)}
          />
          <button class="btn" onClick=${addFine}>Add Fine</button>
        </div>
      </div>
      <div class="card tw">
        <b>Fines and payments</b>${fines.length
          ? html`<table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Roll No</th>
                  <th>Reason</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${fines.map(
                  (f) =>
                    html`<tr key=${f.id}>
                      <td>${nameOf(f.roll)}</td>
                      <td>${f.roll}</td>
                      <td>${f.reason}</td>
                      <td>₹${f.amount}</td>
                      <td>${f.paid ? "Paid" : "Pending"}</td>
                      <td>
                        ${!f.paid &&
                        html`<button
                          class="btn"
                          onClick=${() => {
                            setFines(
                              fines.map((x) =>
                                x.id === f.id ? { ...x, paid: true } : x,
                              ),
                            );
                            log(
                              "admin",
                              user.name,
                              "Marked the fine of ₹" +
                                f.amount +
                                " as paid for " +
                                nameOf(f.roll) +
                                " (" +
                                f.roll +
                                ")",
                            );
                          }}
                        >
                          Mark Paid
                        </button>`}${" "}<button
                          class="btn alt"
                          onClick=${() => {
                            setFines(fines.filter((x) => x.id !== f.id));
                            log(
                              "admin",
                              user.name,
                              "Removed a fine of ₹" +
                                f.amount +
                                " for " +
                                nameOf(f.roll) +
                                " (" +
                                f.roll +
                                ")",
                            );
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="mut" style=${{ marginTop: 10 }}>
              No fines recorded yet.
            </p>`}
      </div>
    </div>`;
  }
  return html`<div class="wrap">
    <${Back} onBack=${onBack} />
    <h2 style=${{ margin: "0 0 14px" }}>${titles[page] || "Dashboard"}</h2>
    ${msg && html`<div class="ok" style=${{ marginBottom: 10 }}>${msg}</div>`}
    ${body}
    ${acc &&
    html`<div class="ov" onClick=${() => setAcc(null)}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <div class="mh">
          <b>Accept issue request</b
          ><button class="x" onClick=${() => setAcc(null)}>×</button>
        </div>
        <h3 style=${{ margin: "10px 0 2px" }}>${acc.title}</h3>
        <div class="mut" style=${{ fontSize: 13 }}>
          Requested by ${acc.name} (${acc.roll})
        </div>
        <div class="mut" style=${{ fontSize: 13 }}>
          Copies currently available: ${accBook ? cp(accBook) : 0}
        </div>
        <label>No. of Copies to be Added</label
        ><input
          type="number"
          min="1"
          placeholder="e.g. 3"
          value=${addN}
          onInput=${(e) => setAddN(e.target.value)}
        />
        <label>End Date</label
        ><input
          type="date"
          min=${today()}
          value=${addEnd}
          onInput=${(e) => setAddEnd(e.target.value)}
        />
        ${aerr && html`<div class="err">${aerr}</div>`}
        <div class="foot" style=${{ gap: 8 }}>
          <button class="btn alt" onClick=${() => setAcc(null)}>Cancel</button
          ><button class="btn" onClick=${submitAccept}>Submit</button>
        </div>
      </div>
    </div>`}
    ${addingBook &&
    ReactDOM.createPortal(
      html`<div class="book-feedback-overlay" role="status" aria-live="polite">
        <div class="book-feedback-card">
          <span class="spinner-arc spinner-arc-large" aria-hidden="true"></span>
          <b>Adding book...</b>
        </div>
      </div>`,
      document.body,
    )}
    ${bookAdded &&
    ReactDOM.createPortal(
      html`<div class="book-feedback-overlay" role="status" aria-live="polite">
        <div class="book-feedback-card book-feedback-success">
          <span class="book-success-icon" aria-hidden="true">✓</span>
          <b>Book added successfully!</b>
        </div>
      </div>`,
      document.body,
    )}
  </div>`;
}

function getNotes(user, issues, fines, books, bookings) {
  const td = today(),
    out = [];
  const add = (x) => {
    if (!x.due || x.due > td) return;
    const late = x.due < td;
    out.push({
      ic: "📚",
      urgent: 1,
      tx:
        'Return "' +
        x.title +
        '" — ' +
        (late ? "it was due on " + fd(x.due) : "0 days left, due today"),
    });
  };
  bookings.filter((x) => x.roll === user.roll).forEach(add);
  issues.filter((x) => x.roll === user.roll && x.accepted).forEach(add);
  return out;
}

function Panel({ title, onClose, children }) {
  return html`<div class="ov" onClick=${onClose}>
    <div class="modal" onClick=${(e) => e.stopPropagation()}>
      <div class="mh">
        <b>${title}</b><button class="x" onClick=${onClose}>×</button>
      </div>
      <div style=${{ marginTop: 12 }}>${children}</div>
    </div>
  </div>`;
}

function NotifBody({ notes }) {
  return notes.length
    ? html`<div>
        ${notes.map(
          (n, i) =>
            html`<div class="li" key=${i}>
              <span style=${{ display: "flex", gap: 10, alignItems: "center" }}
                ><span class="ic">${n.ic}</span><span>${n.tx}</span></span
              >
            </div>`,
        )}
      </div>`
    : html`<p class="mut">No notifications right now.</p>`;
}

function ViewBody({ user, users, books, issues, fines }) {
  const admin = user.role === "admin";
  const unpaid = fines.filter((f) => !f.paid && (admin || f.roll === user.roll));
  const owed = unpaid.reduce((s, f) => s + Number(f.amount || 0), 0);
  const mine = books.filter((b) => b.by === user.roll);
  const totalBookCount = books.reduce((sum, book) => sum + (book.total ?? cp(book)), 0);
  const tiles = admin
    ? [
        ["📚", totalBookCount, "Total Books"],
        ["🎓", users.filter((u) => u.role !== "admin").length, "Students"],
        ["📤", issues.filter((x) => x.accepted).length, "Issued"],
        ["🕘", issues.filter((x) => !x.accepted).length, "Pending requests"],
        ["💳", "₹" + owed, "Unpaid fines"],
      ]
    : [
        ["📚", books.length, "Books in catalog"],
        ["✅", books.filter((b) => cp(b) > 0).length, "Available now"],
        ["📖", mine.length + issues.filter((x) => x.roll === user.roll && x.accepted).length, "Borrowed by me"],
        ["💳", "₹" + owed, "My unpaid fines"],
      ];
  return html`<div>
    <div class="vgrid">
      ${tiles.map(
        (x) =>
          html`<div class="vt" key=${x[2]}>
            <span>${x[0]}</span><b>${x[1]}</b><small>${x[2]}</small>
          </div>`,
      )}
    </div>
    ${!admin &&
    html`<div style=${{ marginTop: 14 }}>
      <b style=${{ fontSize: 13 }}>My borrowed books</b>
      ${mine.length
        ? mine.map((b) => html`<div class="li" key=${b.id}>${b.title}</div>`)
        : html`<p class="mut" style=${{ fontSize: 13 }}>No borrowed books yet.</p>`}
    </div>`}
  </div>`;
}

function MainPageSkeleton() {
  return html`<div class="main-skeleton" role="status" aria-label="Loading your library">
    <div class="main-skeleton-nav">
      <div class="main-skeleton-brand">
        <div class="startup-shimmer startup-logo"></div>
        <div class="startup-shimmer startup-brand-name"></div>
      </div>
      <div class="main-skeleton-actions">
        <div class="startup-shimmer main-skeleton-chip"></div>
        <div class="startup-shimmer main-skeleton-profile"></div>
      </div>
    </div>
    <div class="main-skeleton-content">
      <div class="main-skeleton-hero">
        <div class="main-skeleton-copy">
          <div class="startup-shimmer main-skeleton-eyebrow"></div>
          <div class="main-skeleton-title">
            <div class="startup-shimmer"></div>
            <div class="startup-shimmer"></div>
            <div class="startup-shimmer"></div>
          </div>
          <div class="main-skeleton-description">
            <div class="startup-shimmer"></div>
            <div class="startup-shimmer"></div>
          </div>
          <div class="main-skeleton-stats">
            ${[0, 1, 2].map(
              (item) => html`<div class="startup-shimmer main-skeleton-stat" key=${item}></div>`,
            )}
          </div>
        </div>
        <div class="startup-shimmer main-skeleton-panel">
          <div class="startup-shimmer main-skeleton-panel-line"></div>
          <div class="startup-shimmer main-skeleton-panel-feature"></div>
          <div class="startup-shimmer main-skeleton-panel-line short"></div>
        </div>
      </div>
      <div class="main-skeleton-cards">
        ${[0, 1, 2].map(
          (item) =>
            html`<div class="main-skeleton-card" key=${item}>
              <div class="startup-shimmer main-skeleton-card-icon"></div>
              <div class="startup-shimmer main-skeleton-card-title"></div>
              <div class="startup-shimmer main-skeleton-card-line"></div>
              <div class="startup-shimmer main-skeleton-card-line short"></div>
            </div>`,
        )}
      </div>
    </div>
  </div>`;
}

function App() {
  const [users, setUsers] = useState([]),
    [books, setBooks] = useState(SEED),
    [me, setMe] = useState(null),
    [pref, setPref] = useState({ lang: "en", theme: "light" });
  const [starting, setStarting] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [view, setView] = useState("home"),
    [open, setOpen] = useState(false),
    [feat, setFeat] = useState(0),
    [adm, setAdm] = useState("dash"),
    [pan, setPan] = useState(null);
  const [fines, setFines] = useState([]),
    [bookings, setBookings] = useState([]),
    [issues, setIssues] = useState([]),
    [history, setHistory] = useState([]),
    [storage, setStorage] = useState({}),
    [hydrated, setHydrated] = useState(false),
    [loadError, setLoadError] = useState(""),
    [saveError, setSaveError] = useState("");
  const saveChain = useRef(Promise.resolve());
  const versionRef = useRef(0), // version of the server data this screen is based on
    syncedRef = useRef(""), // the data last loaded from, or sent to, the server
    epochRef = useRef(0); // changes whenever the screen is refreshed from the server
  useEffect(() => {
    const timer = window.setTimeout(() => setStarting(false), 750);
    return () => window.clearTimeout(timer);
  }, []);
  const applyState = (state) => {
    const next = {
      users: state.users || [],
      books: state.books || SEED,
      fines: state.fines || [],
      bookings: state.bookings || [],
      issues: state.issues || [],
      history: state.history || [],
      preferences: normPref(state.preferences),
      storage: state.storage || {},
    };
    epochRef.current += 1;
    versionRef.current = state.version || 0;
    syncedRef.current = JSON.stringify(next);
    setUsers(next.users);
    setBooks(next.books);
    setFines(next.fines);
    setBookings(next.bookings);
    setIssues(next.issues);
    setHistory(next.history);
    setPref(next.preferences);
    setStorage(next.storage);
    setHydrated(true);
  };
  const user = users.find((u) => u.roll === me);
  // Forget the login token once the last save (e.g. the "Logged out" entry) has gone out.
  const signOut = () => setTimeout(() => saveChain.current.then(() => sessionStorage.removeItem(TOKEN_KEY)), 150);
  useEffect(() => {
    document.documentElement.dataset.theme = pref.theme;
    document.documentElement.lang = pref.lang;
  }, [pref]);
  useEffect(() => {
    if (!hydrated) return;
    const payload = { users, books, fines, bookings, issues, history, preferences: pref, storage };
    const body = JSON.stringify(payload);
    if (body === syncedRef.current) return; // nothing changed since the last load or save
    syncedRef.current = body;
    const epoch = epochRef.current;
    // Saves are queued so an older snapshot can never arrive after a newer one.
    saveChain.current = saveChain.current.then(() => {
      if (epoch !== epochRef.current) return; // the screen was refreshed; this snapshot is stale
      return request("/state", { method: "PUT", body: JSON.stringify({ ...payload, version: versionRef.current }) }).then(
        (res) => {
          versionRef.current = res.version;
          setSaveError("");
        },
        (e) =>
          e.status === 409
            ? // Someone else saved first: show their data instead of overwriting it.
              request("/state").then(applyState).then(
                () => setSaveError(e.message),
                () => setSaveError(e.message),
              )
            : setSaveError("Your latest changes could not be saved: " + (e.message || "unknown error")),
      );
    });
  }, [hydrated, users, books, fines, bookings, issues, history, pref, storage]);
  useEffect(() => {
    if (user?.role !== "admin" || view !== "adm" || adm !== "dash") return;
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      const pendingSave = saveChain.current;
      const currentSnapshot = syncedRef.current;
      try {
        await pendingSave;
        const state = await request("/state");
        if (!active || saveChain.current !== pendingSave || syncedRef.current !== currentSnapshot) return;
        applyState(state);
        setSaveError("");
      } catch (error) {
        if (active) setSaveError("Could not refresh registered students: " + error.message);
      } finally {
        refreshing = false;
      }
    };
    refresh();
    const interval = window.setInterval(refresh, 10000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [view, adm, user && user.role]);
  const t = T[pref.lang];
  const log = (by, actor, text, data) =>
    setHistory((h) =>
      [
        {
          id: Date.now() + Math.random(),
          at: new Date().toISOString(),
          by,
          actor,
          text,
          data: data || {},
        },
        ...h,
      ].slice(0, 500),
    );
  if (loadError)
    return html`<div class="auth">
      <div class="box">
        <h2>Cannot load the library</h2>
        <div class="err">${loadError}</div>
        <button class="btn" style=${{ width: "100%", marginTop: 18 }} onClick=${() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>`;
  if (pageLoading) return html`<${MainPageSkeleton} />`;
  if (starting)
    return html`<div class="auth startup-screen">
      <div class="box startup-box" role="status" aria-label="Loading Library Management System">
        <div class="startup-brand" aria-hidden="true">
          <div class="startup-shimmer startup-logo"></div>
          <div class="startup-shimmer startup-brand-name"></div>
        </div>
        <div class="startup-shimmer startup-title" aria-hidden="true"></div>
        <div class="startup-shimmer startup-subtitle" aria-hidden="true"></div>
        <div class="startup-shimmer startup-label" aria-hidden="true"></div>
        <div class="startup-shimmer startup-input" aria-hidden="true"></div>
        <div class="startup-shimmer startup-label" aria-hidden="true"></div>
        <div class="startup-shimmer startup-input" aria-hidden="true"></div>
        <div class="startup-shimmer startup-button" aria-hidden="true"></div>
      </div>
    </div>`;
  if (!hydrated || !user)
    return html`<${Auth}
      onLogin=${async (u) => {
        const loadingStartedAt = Date.now();
        setPageLoading(true);
        try {
          applyState(await request("/state"));
          setMe(u.roll);
          setView("home");
          const remainingLoadingTime = 500 - (Date.now() - loadingStartedAt);
          if (remainingLoadingTime > 0)
            await new Promise((resolve) => window.setTimeout(resolve, remainingLoadingTime));
        } catch (error) {
          setLoadError("Could not load the library: " + error.message);
        } finally {
          setPageLoading(false);
        }
      }}
    />`;
  const notes = getNotes(user, issues, fines, books, bookings),
    urgent = notes.filter((n) => n.urgent).length;
  const go = (id) => {
    setView("home");
    setTimeout(() => {
      const el = document.getElementById(id);
      el && el.scrollIntoView({ behavior: "smooth" });
    }, 30);
  };
  return html`<div>
    ${saveError &&
    html`<div
      class="err"
      role="alert"
      style=${{ position: "fixed", left: 12, right: 12, bottom: 12, zIndex: 1000, textAlign: "center" }}
    >
      ${saveError}
    </div>`}
    <nav>
      <div class="brand">
        <div class="logo">📚</div>
        <div>
          Library
          <div class="mut" style=${{ fontSize: 9 }}>Management System</div>
        </div>
      </div>
      <div class="links">
        <a onClick=${() => go("home")}>${t.home}</a
        ><a onClick=${() => go("contact")}>${t.contact}</a
        ><a
          class=${view === "dash" || view === "adm" ? "on" : ""}
          onClick=${() => {
            if (user.role === "admin") {
              setAdm("dash");
              setView("adm");
            } else setView("dash");
            window.scrollTo(0, 0);
          }}
          >${t.dash}</a
        >
      </div>
      <div style=${{ display: "flex", alignItems: "center", gap: 10 }}>
        ${user.role === "admin"
          ? html`<button
              class="bell"
              title="Issue requests"
              onClick=${() => {
                setAdm("issue");
                setView("adm");
                window.scrollTo(0, 0);
              }}
            >
              🔔${issues.filter((x) => !x.accepted).length > 0 &&
              html`<span class="badge"
                >${issues.filter((x) => !x.accepted).length > 99
                  ? "99+"
                  : issues.filter((x) => !x.accepted).length}</span
              >`}
            </button>`
          : html`<button
              class="bell"
              title="Notifications"
              onClick=${() => setPan("notif")}
            >
              🔔${urgent > 0 && html`<span class="badge">${urgent}</span>`}
            </button>`}
        <button
          class="bell"
          title=${user.role === "admin" ? "Quick view" : "Library analytics"}
          onClick=${() => {
            if (user.role === "admin") setPan("view");
            else {
              setFeat(5);
              setView("feat");
              window.scrollTo(0, 0);
            }
          }}
        >
          👁️
        </button>
        <button class="pbtn" onClick=${() => setOpen(true)}>
          <${Avatar} u=${user} />${t.my}
        </button>
      </div>
    </nav>
    ${view === "home"
      ? html`<${Home}
          t=${t}
          user=${user}
          storage=${storage}
          setStorage=${setStorage}
          onExplore=${(i) => {
            if (user.role === "admin") {
              setAdm(i);
              setView("adm");
            } else {
              setFeat(i);
              setView("feat");
            }
            window.scrollTo(0, 0);
          }}
        />`
      : view === "feat"
        ? html`<${Feature}
            i=${feat}
            user=${user}
            users=${users}
            books=${books}
            setBooks=${setBooks}
            log=${log}
            fines=${fines}
            bookings=${bookings}
            setBookings=${setBookings}
            issues=${issues}
            setIssues=${setIssues}
            storage=${storage}
            setStorage=${setStorage}
            onBack=${() => setView("home")}
          />`
        : view === "adm" && user.role === "admin"
          ? html`<${AdminDash}
              key=${adm}
              page=${adm}
              user=${user}
              users=${users}
              books=${books}
              setBooks=${setBooks}
              setUsers=${setUsers}
              fines=${fines}
              setFines=${setFines}
              log=${log}
              history=${history}
              bookings=${bookings}
              setBookings=${setBookings}
              issues=${issues}
              setIssues=${setIssues}
              storage=${storage}
              setStorage=${setStorage}
              onStateVersion=${(version) => {
                versionRef.current = version;
              }}
              onBack=${() => setView("home")}
            />`
          : html`<${Dashboard}
              user=${user}
              users=${users}
              books=${books}
              setBooks=${setBooks}
              log=${log}
              onBack=${() => setView("home")}
            />`}
    ${pan === "notif" &&
    html`<${Panel} title="Notifications" onClose=${() => setPan(null)}
      ><${NotifBody} notes=${notes}
    /></${Panel}>`}
    ${pan === "view" &&
    html`<${Panel} title="Quick view" onClose=${() => setPan(null)}
      ><${ViewBody}
        user=${user}
        users=${users}
        books=${books}
        issues=${issues}
        fines=${fines}
    /></${Panel}>`}
    ${user.role !== "admin" &&
    (!user.email || !user.year || !user.dept) &&
    html`<${ProfileSetup}
      user=${user}
      users=${users}
      onSave=${(p) => {
        setUsers(users.map((u) => (u.roll === me ? { ...u, ...p } : u)));
        log(user.role, user.name, "Completed profile", { roll: user.roll, email: p.email });
      }}
      onLogout=${() => {
        log(user.role, user.name, "Logged out", { roll: user.roll, email: user.email });
        setOpen(false);
        setMe(null);
        signOut();
      }}
    />`}
    ${open &&
    html`<${ProfileModal}
      user=${user}
      users=${users}
      pref=${pref}
      setPref=${setPref}
      update=${(p, pwChanged) => {
        setUsers(users.map((u) => (u.roll === me ? { ...u, ...p } : u)));
        log(
          user.role,
          user.name,
          "Updated profile" +
            (pwChanged ? " (password changed)" : "") +
            (p.pic !== user.pic ? " (profile picture changed)" : ""),
          { roll: user.roll, email: p.email || user.email },
        );
      }}
      onClose=${() => setOpen(false)}
      onLogout=${() => {
        log(user.role, user.name, "Logged out", {
          roll: user.roll,
          email: user.email,
        });
        setOpen(false);
        setMe(null);
        signOut();
      }}
    />`}
  </div>`;
}
ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);