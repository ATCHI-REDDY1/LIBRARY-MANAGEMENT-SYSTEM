const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const useWindowsAuth = process.env.MSSQL_WINDOWS_AUTH === "true";
const sql = useWindowsAuth ? require("mssql/msnodesqlv8") : require("mssql");
const bcrypt = require("bcryptjs");
const PORT = process.env.PORT || 3000;
const mssqlServer = process.env.MSSQL_SERVER || "localhost";
const mssqlInstance = process.env.MSSQL_INSTANCE_NAME;
const BCRYPT_ROUNDS = 12;
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const BOOK_PDF_DIR = path.join(__dirname, "uploads", "book-pdfs");
const ADMIN_ID = /^LIB\d{3,5}$/i;
// Login tokens are signed with AUTH_SECRET. Without it a random secret is used, so
// everybody has to log in again each time the server restarts.
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.AUTH_SECRET) console.warn("AUTH_SECRET is not set in .env: users must log in again after each restart.");
// Signing up with a LIB number needs this code. Empty means administrator signup is off.
const ADMIN_SIGNUP_CODE = process.env.ADMIN_SIGNUP_CODE || "";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const EMPTY_STATE = {
  version: 0,
  users: [],
  books: [],
  fines: [],
  bookings: [],
  issues: [],
  history: [],
  preferences: {},
  storage: {},
};
const LIST_KEYS = ["users", "books", "fines", "bookings", "issues", "history"];
const OBJECT_KEYS = ["preferences", "storage"];

const poolPromise = sql.connect({
  server: useWindowsAuth && mssqlInstance ? `${mssqlServer}\\${mssqlInstance}` : mssqlServer,
  database: process.env.MSSQL_DATABASE || "library_management",
  ...(useWindowsAuth
    ? { driver: "ODBC Driver 18 for SQL Server" }
    : {
        ...(process.env.MSSQL_PORT ? { port: Number(process.env.MSSQL_PORT) } : {}),
        user: process.env.MSSQL_USER || "sa",
        password: process.env.MSSQL_PASSWORD || "",
      }),
  options: {
    encrypt: process.env.MSSQL_ENCRYPT === "true",
    trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE !== "false",
    ...(useWindowsAuth ? { trustedConnection: true } : {}),
    ...(!useWindowsAuth && mssqlInstance
      ? { instanceName: mssqlInstance }
      : {}),
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isHash = (value) => typeof value === "string" && value.startsWith("$2");
const lower = (value) => String(value == null ? "" : value).toLowerCase();

// Every read-modify-write of the stored state runs one at a time. Without this,
// two overlapping requests (e.g. signup + a state save) can overwrite each other.
let stateLock = Promise.resolve();
function exclusive(task) {
  const result = stateLock.then(task);
  stateLock = result.then(
    () => {},
    () => {},
  );
  return result;
}

function publicUser(user) {
  const { pw, ...safeUser } = user;
  return safeUser;
}

// Password hashes must never leave the server.
function clientState(state) {
  return { ...state, users: (state.users || []).map(publicUser) };
}

// Drops rows that would violate the table constraints / foreign keys so that one
// orphaned record (e.g. a booking for a book that was removed) can never make the
// whole save fail or stop the server from starting.
function sanitizeState(state) {
  const users = [];
  const rolls = new Set();
  for (const user of state.users || []) {
    if (!user || !user.roll || !user.name || !user.pw) continue;
    if (user.role !== "admin" && user.role !== "student") continue;
    const key = lower(user.roll);
    if (rolls.has(key)) continue;
    rolls.add(key);
    users.push(user);
  }
  const books = (state.books || [])
    .filter((book) => book && book.id != null && book.title && book.author)
    .map((book) => (book.by && !rolls.has(lower(book.by)) ? { ...book, by: null } : book));
  const bookIds = new Set(books.map((book) => String(book.id)));
  const linked = (row) => row && bookIds.has(String(row.bookId)) && rolls.has(lower(row.roll));
  return {
    ...state,
    users,
    books,
    fines: (state.fines || []).filter((fine) => fine && rolls.has(lower(fine.roll)) && Number(fine.amount) > 0),
    bookings: (state.bookings || []).filter(linked),
    issues: (state.issues || []).filter(linked),
  };
}

// The SQL copy of the data is split by role: students and admins have their own
// tables. Books, fines, bookings and issues only ever point at students, so rows
// that point at an admin (or at nobody) are left out of the SQL copy. The saved
// app state itself is not changed by this.
// Accounts, fines, bookings and issues get their id from Date.now() when they are
// created, so the id tells us when the row really was created (in the server's local time).
function localStamp(id) {
  const ms = Number(id);
  if (!(ms > 9e11 && ms < 4e12)) return null;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const stamped = (row) => ({ ...row, createdAt: localStamp(row.id) });

function mirrorState(state) {
  const users = state.users || [];
  const students = [];
  const admins = [];
  const emails = new Set();
  for (const user of users) {
    // An email can only belong to one account per table; the first holder keeps it.
    const key = lower(user.email);
    const email = key && !emails.has(key) ? key : "";
    if (key) emails.add(key);
    (user.role === "admin" ? admins : students).push({ ...user, email, createdAt: localStamp(user.id) });
  }
  const studentRolls = new Set(students.map((student) => lower(student.roll)));
  const forStudent = (row) => row && studentRolls.has(lower(row.roll));
  return {
    ...state,
    students,
    admins,
    books: (state.books || []).map((book) =>
      book.by && !studentRolls.has(lower(book.by)) ? { ...book, by: null } : book,
    ),
    fines: (state.fines || []).filter(forStudent).map(stamped),
    bookings: (state.bookings || []).filter(forStudent).map(stamped),
    issues: (state.issues || []).filter(forStudent).map(stamped),
  };
}

// ---------------------------------------------------------------------------
// Login tokens, attempt limiting, per-role views and merges
// ---------------------------------------------------------------------------

function tokenSignature(body) {
  return crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
}

function signToken(user) {
  const body = Buffer.from(JSON.stringify({ roll: user.roll, exp: Date.now() + TOKEN_TTL_MS })).toString("base64url");
  return `${body}.${tokenSignature(body)}`;
}

function verifyToken(token) {
  if (typeof token !== "string") return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = Buffer.from(tokenSignature(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

// The role always comes from the stored account, never from the token or the request.
function authenticate(req, state) {
  const header = req.headers.authorization || "";
  const payload = verifyToken(header.startsWith("Bearer ") ? header.slice(7) : "");
  const user = payload && state.users.find((candidate) => lower(candidate.roll) === lower(payload.roll));
  if (!user) throw httpError(401, "Please log in again.");
  return user;
}

const digest = (value) => crypto.createHash("sha256").update(String(value)).digest();
const adminCodeMatches = (given) =>
  Boolean(ADMIN_SIGNUP_CODE) && crypto.timingSafeEqual(digest(given), digest(ADMIN_SIGNUP_CODE));

const attempts = new Map();
function throttleCheck(key) {
  const entry = attempts.get(key);
  if (!entry) return;
  if (Date.now() - entry.first >= LOCK_MS) return void attempts.delete(key);
  if (entry.count >= MAX_ATTEMPTS) throw httpError(429, "Too many failed attempts. Please try again in 15 minutes.");
}
function throttleFail(key) {
  if (attempts.size > 10000) attempts.clear();
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first >= LOCK_MS) attempts.set(key, { count: 1, first: Date.now() });
  else entry.count += 1;
}
const throttleKey = (req, name) => `${req.socket.remoteAddress}|${lower(name)}`;

// Students only receive their own account, fines, bookings and requests.
function viewFor(user, state) {
  if (user.role === "admin") return clientState(state);
  const own = (row) => row && lower(row.roll) === lower(user.roll);
  const goalKey = "lms_goal_" + user.roll;
  const shelfKey = "lms_shelf_" + user.roll;
  return {
    ...EMPTY_STATE,
    version: state.version || 0,
    users: [publicUser(user)],
    books: state.books,
    fines: state.fines.filter(own),
    bookings: state.bookings.filter(own),
    issues: state.issues.filter(own),
    history: [],
    preferences: state.preferences,
    storage: Object.fromEntries(
      Object.entries(state.storage || {}).filter(([key]) => key === goalKey || key === shelfKey),
    ),
  };
}

// Profile fields an account may change (never the password, role or number).
function profileUpdate(current, stored, sent) {
  const text = (value, max, fallback) => (typeof value === "string" ? value.trim().slice(0, max) : fallback);
  // A new email must look like an email and not belong to another account.
  const newEmail = typeof sent.email === "string" ? sent.email.trim().toLowerCase() : "";
  const emailTaken = current.users.some((other) => other !== stored && other.email && lower(other.email) === newEmail);
  const emailOk = newEmail && newEmail.length <= 255 && /^\S+@\S+\.\S+$/.test(newEmail) && !emailTaken;
  return {
    ...stored,
    pic: typeof sent.pic === "string" ? sent.pic : stored.pic,
    email: emailOk ? newEmail : stored.email,
    year: text(sent.year, 30, stored.year),
    dept: text(sent.dept, 150, stored.dept),
    section: text(sent.section, 30, stored.section || ""),
  };
}

function mergeAdmin(current, incoming) {
  const next = { ...current };
  for (const key of LIST_KEYS) if (key !== "users" && Array.isArray(incoming[key])) next[key] = incoming[key];
  if (Array.isArray(incoming.books)) {
    const storedById = new Map((current.books || []).map((book) => [String(book.id), book]));
    next.books = incoming.books.map((book) => {
      if (!book || typeof book !== "object") return book;
      const stored = storedById.get(String(book.id));
      const { pdfId: _untrustedPdfId, ...submitted } = book;
      return stored && stored.pdfId ? { ...submitted, pdfId: stored.pdfId } : submitted;
    });
  }
  for (const key of OBJECT_KEYS) {
    const value = incoming[key];
    if (value && typeof value === "object" && !Array.isArray(value)) next[key] = value;
  }
  // Accounts are only created through signup. An administrator can edit profile fields
  // and remove students, but never removes an administrator account.
  if (Array.isArray(incoming.users)) {
    const sentBy = new Map(incoming.users.filter((user) => user && user.roll).map((user) => [lower(user.roll), user]));
    next.users = current.users.flatMap((stored) => {
      const sent = sentBy.get(lower(stored.roll));
      if (!sent) return stored.role === "admin" ? [stored] : [];
      return [profileUpdate(current, stored, sent)];
    });
  }
  return next;
}

// A student's personal bookshelf (stored as storage["lms_shelf_<roll>"]). Whatever the
// browser sends is cleaned here: unknown books, duplicates, bad statuses and ratings
// are dropped, so a student can never store anything except their own shelf entries.
const SHELF_STATUS = ["wishlist", "reading", "finished"];
function cleanShelf(value, books) {
  if (!Array.isArray(value)) return [];
  const valid = new Set((books || []).map((book) => String(book.id)));
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (!item || item.bookId == null) continue;
    const id = String(item.bookId);
    if (!valid.has(id) || seen.has(id)) continue;
    seen.add(id);
    const rating = Math.floor(Number(item.rating));
    out.push({
      bookId: item.bookId,
      status: SHELF_STATUS.includes(item.status) ? item.status : "wishlist",
      rating: rating >= 1 && rating <= 5 ? rating : 0,
      addedAt: typeof item.addedAt === "string" ? item.addedAt.slice(0, 10) : "",
    });
    if (out.length >= 500) break;
  }
  return out;
}

// A student can change only their own profile, book/return a book, add their own
// requests and log their own actions. Everything else in the request is ignored.
function mergeStudent(current, incoming, me) {
  const roll = lower(me.roll);
  const own = (row) => row && lower(row.roll) === roll;
  const next = { ...current };

  if (Array.isArray(incoming.users)) {
    const sent = incoming.users.find(own);
    if (sent) next.users = current.users.map((user) => (user === me ? profileUpdate(current, user, sent) : user));
  }

  if (Array.isArray(incoming.books)) {
    const sentById = new Map(incoming.books.filter(Boolean).map((book) => [String(book.id), book]));
    next.books = current.books.map((book) => {
      const sent = sentById.get(String(book.id));
      if (!sent) return book;
      const out = { ...book };
      const copies = Math.floor(Number(sent.copies));
      const cap = book.total != null ? Number(book.total) : (book.copies == null ? 1 : Number(book.copies)) + 1;
      if (Number.isFinite(copies) && copies >= 0 && copies <= cap) out.copies = copies;
      if (!sent.by) {
        if (lower(book.by) === roll) out.by = null;
      } else if (lower(sent.by) === roll && !book.by) {
        out.by = me.roll;
      }
      return out;
    });
  }

  for (const key of ["bookings", "issues"]) {
    if (!Array.isArray(incoming[key])) continue;
    const have = new Set(current[key].map((row) => String(row.id)));
    const added = incoming[key]
      .filter((row) => own(row) && row.id != null && !have.has(String(row.id)))
      .map(({ added: _ignored, ...row }) => ({ ...row, accepted: false }));
    next[key] = [...current[key], ...added];
  }

  if (Array.isArray(incoming.history)) {
    const have = new Set(current.history.map((entry) => String(entry.id)));
    const added = incoming.history.filter(
      (entry) =>
        entry && entry.id != null && !have.has(String(entry.id)) && entry.by === "student" && entry.data && lower(entry.data.roll) === roll,
    );
    next.history = [...added, ...current.history].slice(0, 500);
  }

  const goalKey = "lms_goal_" + me.roll;
  if (incoming.storage && typeof incoming.storage === "object" && goalKey in incoming.storage)
    next.storage = { ...current.storage, [goalKey]: incoming.storage[goalKey] };
  const shelfKey = "lms_shelf_" + me.roll;
  if (incoming.storage && typeof incoming.storage === "object" && shelfKey in incoming.storage)
    next.storage = { ...next.storage, [shelfKey]: cleanShelf(incoming.storage[shelfKey], next.books) };
  if (incoming.preferences && typeof incoming.preferences === "object" && !Array.isArray(incoming.preferences))
    next.preferences = incoming.preferences;
  return next;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function schemaBatches() {
  for (const file of [path.join(__dirname, "..", "schema.sql"), path.join(__dirname, "schema.sql")]) {
    if (!fs.existsSync(file)) continue;
    return fs
      .readFileSync(file, "utf8")
      .split(/^\s*GO\s*$/im)
      .map((batch) => batch.trim())
      .filter((batch) => batch && !/^IF DB_ID/i.test(batch) && !/^USE\s/i.test(batch));
  }
  return [];
}

async function initDatabase() {
  const pool = await poolPromise;
  await pool.request().query(`
    IF OBJECT_ID('dbo.app_state', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.app_state (
        id TINYINT NOT NULL PRIMARY KEY,
        state_json NVARCHAR(MAX) NOT NULL,
        updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      )
    END
  `);
  // Make sure every table used by syncNormalizedState exists, even when
  // schema.sql was never run by hand.
  for (const batch of schemaBatches()) await pool.request().query(batch);
  await pool
    .request()
    .input("stateJson", sql.NVarChar(sql.MAX), JSON.stringify(EMPTY_STATE))
    .query(`
      IF NOT EXISTS (SELECT 1 FROM dbo.app_state WHERE id = 1)
        INSERT INTO dbo.app_state (id, state_json) VALUES (1, @stateJson)
    `);
  try {
    await syncNormalizedState(await readState());
  } catch (error) {
    // The JSON snapshot is the source of truth; don't refuse to start because the
    // reporting tables could not be refreshed.
    console.warn("Could not refresh the normalized tables on startup:", error.message);
  }
}

async function readState() {
  const pool = await poolPromise;
  const result = await pool.request().query("SELECT state_json FROM dbo.app_state WHERE id = 1");
  if (!result.recordset.length) return { ...EMPTY_STATE };
  return { ...EMPTY_STATE, ...JSON.parse(result.recordset[0].state_json) };
}

async function writeState(state) {
  const nextState = sanitizeState({ ...EMPTY_STATE, ...state });
  const pool = await poolPromise;
  await pool
    .request()
    .input("stateJson", sql.NVarChar(sql.MAX), JSON.stringify(nextState))
    .query("UPDATE dbo.app_state SET state_json = @stateJson, updated_at = SYSUTCDATETIME() WHERE id = 1");
  try {
    await syncNormalizedState(nextState);
  } catch (error) {
    // The saved app state is the source of truth; the SQL tables are a copy that is
    // rebuilt on the next save.
    console.warn("Saved, but could not refresh the SQL tables:", error.message);
  }
  return nextState;
}

async function syncNormalizedState(rawState) {
  const state = mirrorState(sanitizeState(rawState));
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  const request = () => transaction.request();
  const preferences = Object.entries(state.preferences || {}).map(([key, value]) => ({
    key,
    value: JSON.stringify(value),
  }));
  const storage = Object.entries(state.storage || {}).map(([key, value]) => ({
    key,
    value: JSON.stringify(value),
  }));

  await transaction.begin();
  try {
    await request().query(`
      DELETE FROM dbo.history;
      DELETE FROM dbo.preferences;
      DELETE FROM dbo.storage;
      DELETE FROM dbo.bookings;
      DELETE FROM dbo.issues;
      DELETE FROM dbo.fines;
      DELETE FROM dbo.books;
      DELETE FROM dbo.students;
      DELETE FROM dbo.admins;
    `);

    const syncRequest = request()
      .input("students", sql.NVarChar(sql.MAX), JSON.stringify(state.students))
      .input("admins", sql.NVarChar(sql.MAX), JSON.stringify(state.admins))
      .input("books", sql.NVarChar(sql.MAX), JSON.stringify(state.books || []))
      .input("fines", sql.NVarChar(sql.MAX), JSON.stringify(state.fines || []))
      .input("bookings", sql.NVarChar(sql.MAX), JSON.stringify(state.bookings || []))
      .input("issues", sql.NVarChar(sql.MAX), JSON.stringify(state.issues || []))
      .input("history", sql.NVarChar(sql.MAX), JSON.stringify(state.history || []))
      .input("preferences", sql.NVarChar(sql.MAX), JSON.stringify(preferences))
      .input("storage", sql.NVarChar(sql.MAX), JSON.stringify(storage));

    await syncRequest.query(`
           INSERT INTO dbo.students
        (student_id, roll, email, name, academic_year, department, class_section, password_hash, profile_picture, created_at)
      SELECT COALESCE(student_id, 900000000000000 + ROW_NUMBER() OVER (ORDER BY roll)),
        roll, NULLIF(email, ''), name, academic_year, department, class_section, password_hash, profile_picture,
        COALESCE(TRY_CONVERT(DATETIME2, created_text), SYSDATETIME())
      FROM OPENJSON(@students) WITH (
        created_text NVARCHAR(40) '$.createdAt',
        student_id BIGINT '$.id', roll NVARCHAR(50) '$.roll', email NVARCHAR(255) '$.email',
        name NVARCHAR(150) '$.name', academic_year NVARCHAR(30) '$.year',
        department NVARCHAR(150) '$.dept', class_section NVARCHAR(30) '$.section',
        password_hash NVARCHAR(255) '$.pw', profile_picture NVARCHAR(MAX) '$.pic'
      );

      INSERT INTO dbo.admins
        (admin_id, roll, email, name, password_hash, profile_picture, created_at)
      SELECT COALESCE(admin_id, 900000000000000 + ROW_NUMBER() OVER (ORDER BY roll)),
        roll, NULLIF(email, ''), name, password_hash, profile_picture,
        COALESCE(TRY_CONVERT(DATETIME2, created_text), SYSDATETIME())
      FROM OPENJSON(@admins) WITH (
        created_text NVARCHAR(40) '$.createdAt',
        admin_id BIGINT '$.id', roll NVARCHAR(50) '$.roll', email NVARCHAR(255) '$.email',
        name NVARCHAR(150) '$.name', password_hash NVARCHAR(255) '$.pw', profile_picture NVARCHAR(MAX) '$.pic'
      );
      INSERT INTO dbo.books
        (book_id, title, author, category, available_copies, total_copies, end_date, fine_per_day, borrowed_by_roll)
      SELECT book_id, title, author, category, COALESCE(available_copies, 1),
        COALESCE(total_copies, available_copies, 1), TRY_CONVERT(DATE, NULLIF(end_date_text, '')),
        COALESCE(fine_per_day, 0), NULLIF(borrowed_by_roll, '')
      FROM OPENJSON(@books) WITH (
        book_id BIGINT '$.id', title NVARCHAR(300) '$.title', author NVARCHAR(200) '$.author',
        category NVARCHAR(150) '$.cat', available_copies INT '$.copies', total_copies INT '$.total',
        end_date_text NVARCHAR(30) '$.endDate', fine_per_day DECIMAL(10, 2) '$.fine', borrowed_by_roll NVARCHAR(50) '$.by'
      );

      INSERT INTO dbo.fines (fine_id, roll, amount, reason, paid, created_at)
      SELECT fine_id, roll, amount, COALESCE(reason, N'Late return'), COALESCE(paid, 0),
        COALESCE(TRY_CONVERT(DATETIME2, created_text), SYSDATETIME())
      FROM OPENJSON(@fines) WITH (
        created_text NVARCHAR(40) '$.createdAt',
        fine_id BIGINT '$.id', roll NVARCHAR(50) '$.roll', amount DECIMAL(10, 2) '$.amount',
        reason NVARCHAR(300) '$.reason', paid BIT '$.paid'
      );

           INSERT INTO dbo.bookings
        (booking_id, book_id, title, name, roll, email, start_date, due_date, fine_accepted, copies, note, accepted, created_at)
      SELECT booking_id, book_id, title, name, roll, email, start_date, due_date, COALESCE(fine_accepted, 0), copies, note, COALESCE(accepted, 0),
        COALESCE(TRY_CONVERT(DATETIME2, created_text), SYSDATETIME())
      FROM OPENJSON(@bookings) WITH (
        created_text NVARCHAR(40) '$.createdAt',
        booking_id BIGINT '$.id', book_id BIGINT '$.bookId', title NVARCHAR(300) '$.title',
        name NVARCHAR(150) '$.name', roll NVARCHAR(50) '$.roll', email NVARCHAR(255) '$.email',
        start_date DATE '$.start', due_date DATE '$.due', fine_accepted BIT '$.fineAccepted',
        copies INT '$.copies', note NVARCHAR(1000) '$.note', accepted BIT '$.accepted'
      );
      INSERT INTO dbo.issues
        (issue_id, book_id, title, name, roll, email, start_date, due_date, fine_accepted, copies, note, accepted, added_copies, created_at)
      SELECT issue_id, book_id, title, name, roll, email, start_date, due_date, COALESCE(fine_accepted, 0), copies, note, COALESCE(accepted, 0), added_copies,
        COALESCE(TRY_CONVERT(DATETIME2, created_text), SYSDATETIME())
      FROM OPENJSON(@issues) WITH (
        created_text NVARCHAR(40) '$.createdAt',
        issue_id BIGINT '$.id', book_id BIGINT '$.bookId', title NVARCHAR(300) '$.title',
        name NVARCHAR(150) '$.name', roll NVARCHAR(50) '$.roll', email NVARCHAR(255) '$.email',
        start_date DATE '$.start', due_date DATE '$.due', fine_accepted BIT '$.fineAccepted',
        copies INT '$.copies', note NVARCHAR(1000) '$.note', accepted BIT '$.accepted', added_copies INT '$.added'
      );

      INSERT INTO dbo.history
        (history_id, happened_at, actor_type, actor, event_text, data_json)
      SELECT COALESCE(TRY_CONVERT(BIGINT, history_id_text), 800000000000000 + ROW_NUMBER() OVER (ORDER BY happened_at, actor)),
        happened_at, actor_type, actor, event_text, data_json
      FROM OPENJSON(@history) WITH (
        history_id_text NVARCHAR(100) '$.id', happened_at DATETIME2 '$.at', actor_type NVARCHAR(20) '$.by',
        actor NVARCHAR(150) '$.actor', event_text NVARCHAR(1000) '$.text', data_json NVARCHAR(MAX) '$.data' AS JSON
      );

      INSERT INTO dbo.preferences (preference_key, preference_value)
      SELECT preference_key, preference_value
      FROM OPENJSON(@preferences) WITH (
        preference_key NVARCHAR(100) '$.key', preference_value NVARCHAR(MAX) '$.value'
      );

      INSERT INTO dbo.storage (storage_key, storage_value)
      SELECT storage_key, storage_value
      FROM OPENJSON(@storage) WITH (
        storage_key NVARCHAR(255) '$.key', storage_value NVARCHAR(MAX) '$.value'
      );
    `);
    await transaction.commit();
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      // SQL Server may already have rolled back the transaction after a statement error.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function send(res, status, body) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  };
  if (status === 204) {
    res.writeHead(204, headers);
    return res.end();
  }
  res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function writePdfUpload(req, file) {
  let header = Buffer.alloc(0);
  const inspectHeader = new Transform({
    transform(chunk, encoding, callback) {
      if (header.length < 5) header = Buffer.concat([header, chunk.subarray(0, 5 - header.length)]);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(req, inspectHeader, fs.createWriteStream(file, { flags: "wx" }));
  } catch (error) {
    try {
      await fs.promises.unlink(file);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") console.error("Could not clean up an incomplete book PDF:", cleanupError.message);
    }
    throw error;
  }
  if (header.toString("ascii") !== "%PDF-") {
    await fs.promises.unlink(file);
    throw httpError(400, "The selected file is not a valid PDF.");
  }
}

function bookPdfPath(pdfId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pdfId || "")) return null;
  return path.join(BOOK_PDF_DIR, `${pdfId}.pdf`);
}

async function removeBookPdf(pdfId) {
  const file = bookPdfPath(pdfId);
  if (!file) return;
  try {
    await fs.promises.unlink(file);
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not remove a book PDF:", error.message);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(httpError(413, "Request body is too large."));
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        resolve(parsed);
      } catch {
        reject(httpError(400, "Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function serveFile(res, pathname) {
  let requested;
  try {
    requested = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (requested === "/") requested = "/index.html";
  const frontendDir = path.resolve(__dirname, "..", "frontend");
  const file = path.resolve(frontendDir, `.${requested}`);
  // The separator matters: "/frontend-secrets" also starts with "/frontend".
  if (!file.startsWith(frontendDir + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
  return true;
}

// ---------------------------------------------------------------------------
// Forgot password: a short numeric code is emailed to the address on the account.
// Set SMTP_HOST (and SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM / SMTP_SECURE)
// in .env to send real emails. Without SMTP_HOST the code is printed in this
// server console instead, which is handy while developing.
// ---------------------------------------------------------------------------
const RESET_TTL_MS = 10 * 60 * 1000;
const RESET_COOLDOWN_MS = 60 * 1000;
const RESET_MAX_TRIES = 5;
// Length of the emailed code. Set RESET_CODE_LENGTH in .env (4 to 8). Default: 4.
const RESET_CODE_LENGTH = Math.min(8, Math.max(4, Math.floor(Number(process.env.RESET_CODE_LENGTH)) || 4));
const resets = new Map();

function mailTransport() {
  const nodemailer = require("nodemailer");
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } } : {}),
  });
}

// Tells you at startup whether real emails can be sent.
function checkMail() {
  if (!process.env.SMTP_HOST) {
    console.warn("Email: SMTP_HOST is not set, so reset codes are printed here instead of being emailed.");
    return;
  }
  try {
    mailTransport()
      .verify()
      .then(
        () => console.log(`Email: connected to ${process.env.SMTP_HOST}, reset codes will be emailed.`),
        (error) => console.error("Email: could not log in to the SMTP server:", error.message),
      );
  } catch (error) {
    // e.g. nodemailer is not installed yet: warn, but keep the server running.
    console.error("Email: " + (error.code === "MODULE_NOT_FOUND" ? "run  npm install nodemailer  first." : error.message));
  }
}

async function sendResetMail(to, name, code) {
  // RESET_CODE_IN_CONSOLE=true prints the code in this server console (even when email is set up).
  if (!process.env.SMTP_HOST || process.env.RESET_CODE_IN_CONSOLE === "true") {
    console.log(`[password reset] Reset code for ${to}: ${code}`);
  }
  if (!process.env.SMTP_HOST) return;
  const transport = mailTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: "Your Library Management password reset code",
    text: `Hi ${name},\n\nYour password reset code is ${code}. It expires in 10 minutes.\n\nIf you did not ask for this, you can ignore this email.`,
  });
}

async function passwordMatches(user, password) {
  if (!user || !user.pw || !password) return false;
  return isHash(user.pw) ? bcrypt.compare(password, user.pw) : user.pw === password;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204);

  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    const bookPdfMatch = url.pathname.match(/^\/api\/books\/(\d+)\/pdf$/);
    if (bookPdfMatch && req.method === "POST") {
      const state = await readState();
      const user = authenticate(req, state);
      if (user.role !== "admin") throw httpError(403, "Administrators only.");
      const bookId = bookPdfMatch[1];
      const book = state.books.find((item) => String(item.id) === bookId);
      if (!book) return send(res, 404, { error: "Book not found." });
      if (book.pdfId) return send(res, 409, { error: "A PDF has already been uploaded for this book." });
      if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/pdf")
        return send(res, 415, { error: "Choose a PDF file to upload." });

      const pdfId = crypto.randomUUID();
      await fs.promises.mkdir(BOOK_PDF_DIR, { recursive: true });
      const file = bookPdfPath(pdfId);
      let pdfStored = false;
      try {
        await writePdfUpload(req, file);
        pdfStored = true;
        const version = await exclusive(async () => {
          const current = await readState();
          const latestUser = authenticate(req, current);
          if (latestUser.role !== "admin") throw httpError(403, "Administrators only.");
          const latestBook = current.books.find((item) => String(item.id) === bookId);
          if (!latestBook) throw httpError(404, "Book not found.");
          if (latestBook.pdfId) throw httpError(409, "A PDF has already been uploaded for this book.");
          latestBook.pdfId = pdfId;
          current.version = (Number(current.version) || 0) + 1;
          const saved = await writeState(current);
          return saved.version;
        });
        return send(res, 200, { pdfId, version });
      } catch (error) {
        if (pdfStored) await removeBookPdf(pdfId);
        throw error;
      }
    }

    if (bookPdfMatch && req.method === "GET") {
      const state = await readState();
      authenticate(req, state);
      const book = state.books.find((item) => String(item.id) === bookPdfMatch[1]);
      if (!book || !book.pdfId) return send(res, 404, { error: "No PDF is available for this book." });
      const file = bookPdfPath(book.pdfId);
      if (!file) return send(res, 404, { error: "No PDF is available for this book." });
      let pdf;
      try {
        pdf = await fs.promises.readFile(file);
      } catch (error) {
        if (error.code === "ENOENT") return send(res, 404, { error: "The book PDF file is missing." });
        throw error;
      }
      const safeTitle = String(book.title || "book").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 100) || "book";
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
        "Cache-Control": "private, no-store",
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeTitle}.pdf"`,
        "Content-Length": pdf.length,
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(pdf);
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const state = await readState();
      return send(res, 200, viewFor(authenticate(req, state), state));
    }

    if (req.method === "POST" && url.pathname === "/api/auth/signup") {
      const incoming = await readBody(req);
      const roll = String(incoming.roll || "").trim();
      const email = String(incoming.email || "").trim().toLowerCase();
      const password = typeof incoming.password === "string" ? incoming.password : "";
      if (!roll || password.length < 6)
        return send(res, 400, { error: "A user number and a password of at least 6 characters are required." });
      if (roll.length > 50 || email.length > 255)
        return send(res, 400, { error: "The user number or email is too long." });
      if (/^LIB/i.test(roll) && !ADMIN_ID.test(roll))
        return send(res, 400, { error: "Administrator numbers are LIB followed by 3 to 5 digits, e.g. LIB001." });
      const isAdmin = ADMIN_ID.test(roll);
      if (isAdmin) {
        const key = throttleKey(req, "admin-signup");
        throttleCheck(key);
        if (!ADMIN_SIGNUP_CODE)
          return send(res, 403, { error: "Administrator signup is turned off. Set ADMIN_SIGNUP_CODE in the .env file." });
        if (!adminCodeMatches(incoming.adminCode || "")) {
          throttleFail(key);
          return send(res, 403, { error: "Incorrect administrator code." });
        }
      }
      const normalizedRoll = isAdmin ? roll.toUpperCase() : roll;
      const pw = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const user = await exclusive(async () => {
        const state = await readState();
        if (state.users.some((existing) => lower(existing.roll) === lower(normalizedRoll)))
          throw httpError(409, "This user number is already registered. Please login.");
        if (email && state.users.some((existing) => lower(existing.email) === email))
          throw httpError(409, "This email is already registered. Please login.");
        const used = new Set(state.users.map((existing) => existing.id));
        let id = Date.now();
        while (used.has(id)) id += 1;
        const created = {
          id,
          name: String(incoming.name || normalizedRoll).trim().slice(0, 150) || normalizedRoll,
          roll: normalizedRoll,
          email,
          year: "",
          dept: "",
          pw,
          // The role is derived from the user number, never trusted from the request body.
          role: isAdmin ? "admin" : "student",
          pic: "",
        };
        await writeState({ ...state, users: [...state.users, created], version: (Number(state.version) || 0) + 1 });
        return created;
      });
      return send(res, 201, { user: publicUser(user) });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const incoming = await readBody(req);
      const identifier = String(incoming.identifier || "").trim().toLowerCase();
      const password = typeof incoming.password === "string" ? incoming.password : "";
      const key = throttleKey(req, identifier);
      throttleCheck(key);
      const state = await readState();
      const user = state.users.find(
        (candidate) => lower(candidate.roll) === identifier || (candidate.email && lower(candidate.email) === identifier),
      );
      if (!identifier || !(await passwordMatches(user, password))) {
        throttleFail(key);
        return send(res, 401, { error: "Incorrect user number or password." });
      }
      attempts.delete(key);
      if (!isHash(user.pw)) {
        // Upgrade a legacy plain-text password to a bcrypt hash.
        const upgraded = await bcrypt.hash(password, BCRYPT_ROUNDS);
        await exclusive(async () => {
          const latest = await readState();
          const target = latest.users.find((candidate) => candidate.roll === user.roll);
          if (target && !isHash(target.pw)) {
            target.pw = upgraded;
            await writeState(latest);
          }
        });
      }
      return send(res, 200, { user: publicUser(user), token: signToken(user) });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/forgot") {
      const incoming = await readBody(req);
      const identifier = String(incoming.identifier || "").trim().toLowerCase();
      if (!identifier) return send(res, 400, { error: "Enter your user number or email." });
      // Every request counts, so nobody can use this to spam an inbox.
      const key = throttleKey(req, "forgot|" + identifier);
      throttleCheck(key);
      throttleFail(key);
      const state = await readState();
      const user = state.users.find(
        (candidate) => lower(candidate.roll) === identifier || (candidate.email && lower(candidate.email) === identifier),
      );
      // The answer is the same whether or not the account exists. What really happened
      // is only written to this server console.
      if (!user) console.log(`[password reset] No account matches "${identifier}". Nothing sent.`);
      else if (!user.email) console.log(`[password reset] Account ${user.roll} has no email saved. Nothing sent.`);
      if (user && user.email) {
        const id = lower(user.roll);
        const existing = resets.get(id);
        if (existing && Date.now() - existing.sent < RESET_COOLDOWN_MS)
          console.log(`[password reset] A code was already sent to ${user.email} less than a minute ago. Wait and try again.`);
        if (!existing || Date.now() - existing.sent >= RESET_COOLDOWN_MS) {
          const code = String(crypto.randomInt(0, 10 ** RESET_CODE_LENGTH)).padStart(RESET_CODE_LENGTH, "0");
          resets.set(id, { hash: digest(code).toString("hex"), exp: Date.now() + RESET_TTL_MS, tries: 0, sent: Date.now() });
          try {
            await sendResetMail(user.email, user.name, code);
            if (process.env.SMTP_HOST) console.log(`[password reset] Code emailed to ${user.email}.`);
          } catch (error) {
            // With RESET_CODE_IN_CONSOLE=true the code was already shown in the console, so keep it valid.
            if (process.env.RESET_CODE_IN_CONSOLE !== "true") resets.delete(id);
            console.error("Could not send the reset email:", error.message);
          }
        }
      }
      return send(res, 200, {
        ok: true,
        message: `If this account has an email address on file, a ${RESET_CODE_LENGTH}-digit code has been sent to it.`,
        codeLength: RESET_CODE_LENGTH,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/reset") {
      const incoming = await readBody(req);
      const identifier = String(incoming.identifier || "").trim().toLowerCase();
      const code = String(incoming.code || "").trim();
      const newPassword = typeof incoming.newPassword === "string" ? incoming.newPassword : "";
      if (newPassword.length < 6) return send(res, 400, { error: "New password must be at least 6 characters." });
      const key = throttleKey(req, "reset|" + identifier);
      throttleCheck(key);
      const invalid = () => {
        throttleFail(key);
        return send(res, 400, { error: "Invalid or expired code." });
      };
      const current = await readState();
      const user = current.users.find(
        (candidate) => lower(candidate.roll) === identifier || (candidate.email && lower(candidate.email) === identifier),
      );
      const entry = user && resets.get(lower(user.roll));
      if (!entry || entry.exp < Date.now() || entry.tries >= RESET_MAX_TRIES) {
        if (user) resets.delete(lower(user.roll));
        return invalid();
      }
      if (!crypto.timingSafeEqual(digest(code), Buffer.from(entry.hash, "hex"))) {
        entry.tries += 1;
        return invalid();
      }
      const pw = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      await exclusive(async () => {
        const state = await readState();
        const target = state.users.find((candidate) => lower(candidate.roll) === lower(user.roll));
        if (!target) throw httpError(400, "Invalid or expired code.");
        target.pw = pw;
        await writeState(state);
      });
      resets.delete(lower(user.roll));
      attempts.delete(key);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/password") {
      const incoming = await readBody(req);
      const currentPassword = typeof incoming.currentPassword === "string" ? incoming.currentPassword : "";
      const newPassword = typeof incoming.newPassword === "string" ? incoming.newPassword : "";
      if (newPassword.length < 6) return send(res, 400, { error: "New password must be at least 6 characters." });
      const pw = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      await exclusive(async () => {
        const state = await readState();
        // You can only change your own password.
        const target = authenticate(req, state);
        const key = throttleKey(req, "password|" + target.roll);
        throttleCheck(key);
        if (!(await passwordMatches(target, currentPassword))) {
          throttleFail(key);
          throw httpError(403, "Current password is incorrect.");
        }
        attempts.delete(key);
        target.pw = pw;
        await writeState(state);
      });
      return send(res, 200, { ok: true });
    }

    if (req.method === "PUT" && url.pathname === "/api/state") {
      const incoming = await readBody(req);
      const deletedPdfs = [];
      const version = await exclusive(async () => {
        const current = await readState();
        const me = authenticate(req, current);
        if (Number(incoming.version) !== (Number(current.version) || 0))
          throw httpError(
            409,
            "The library data was changed by someone else, so your last change was not saved. The screen has been refreshed: please repeat it.",
          );
        const next = me.role === "admin" ? mergeAdmin(current, incoming) : mergeStudent(current, incoming, me);
        next.version = (Number(current.version) || 0) + 1;
        const saved = await writeState(next);
        const remainingPdfIds = new Set(saved.books.map((book) => book.pdfId).filter(Boolean));
        for (const book of current.books || []) {
          if (book.pdfId && !remainingPdfIds.has(book.pdfId)) deletedPdfs.push(book.pdfId);
        }
        return saved.version;
      });
      await Promise.all(deletedPdfs.map(removeBookPdf));
      return send(res, 200, { ok: true, version });
    }

    if (req.method === "POST" && url.pathname === "/api/migrate") {
      const incoming = await readBody(req);
      const state = await exclusive(async () => {
        const current = await readState();
        if (authenticate(req, current).role !== "admin") throw httpError(403, "Administrators only.");
        const merged = {
          ...EMPTY_STATE,
          ...current,
          users: current.users.length ? current.users : incoming.users || [],
          books: current.books.length ? current.books : incoming.books || [],
          fines: current.fines.length ? current.fines : incoming.fines || [],
          bookings: current.bookings.length ? current.bookings : incoming.bookings || [],
          issues: current.issues.length ? current.issues : incoming.issues || [],
          history: current.history.length ? current.history : incoming.history || [],
          preferences: { ...incoming.preferences, ...current.preferences },
          storage: { ...incoming.storage, ...current.storage },
          version: (Number(current.version) || 0) + 1,
        };
        return writeState(merged);
      });
      return send(res, 200, { ...clientState(state), migrated: true, migrationId: crypto.randomUUID() });
    }

    if (req.method === "GET" && serveFile(res, url.pathname)) return;
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    return send(res, status, { error: status >= 500 ? "Internal server error." : error.message });
  }
});

initDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Library backend running at http://localhost:${PORT}`);
      console.log("MSSQL database connected");
      checkMail();
    });
  })
  .catch((error) => {
    console.error("Could not connect to MSSQL.");
    console.error(error.message);
    process.exitCode = 1;
  });