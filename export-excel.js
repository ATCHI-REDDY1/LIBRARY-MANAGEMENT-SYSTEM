const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const useWindowsAuth = process.env.MSSQL_WINDOWS_AUTH === "true";
const sql = useWindowsAuth ? require("mssql/msnodesqlv8") : require("mssql");
const ExcelJS = require("exceljs");

const mssqlServer = process.env.MSSQL_SERVER || "localhost";
const mssqlInstance = process.env.MSSQL_INSTANCE_NAME;

// Tables to export, in sheet order.
const TABLES = ["students", "admins", "books", "fines", "bookings", "issues", "history"];
// Never exported: password hashes and profile pictures.
const SKIP_COLUMNS = new Set(["password_hash", "profile_picture"]);

const config = {
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
    ...(!useWindowsAuth && mssqlInstance ? { instanceName: mssqlInstance } : {}),
  },
};

async function main() {
  const pool = await sql.connect(config);
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  let total = 0;

  for (const table of TABLES) {
    let result;
    try {
      result = await pool.request().query(`SELECT * FROM dbo.${table}`);
    } catch (error) {
      console.warn(`Skipped ${table}: ${error.message}`);
      continue;
    }
    const columns = Object.keys(result.recordset.columns || {}).filter((name) => !SKIP_COLUMNS.has(name));
    const sheet = workbook.addWorksheet(table);
    sheet.columns = columns.map((name) => ({ header: name, key: name, width: Math.max(14, name.length + 4) }));
    for (const row of result.recordset) {
      const clean = {};
      for (const name of columns) {
        const value = row[name];
        clean[name] = Buffer.isBuffer(value) ? "" : value;
      }
      sheet.addRow(clean);
    }
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, columns.length) } };
    total += result.recordset.length;
    console.log(`${table}: ${result.recordset.length} rows`);
  }

  const dir = path.join(__dirname, "..", "exports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  const file = path.join(dir, `library-export-${stamp}.xlsx`);
  await workbook.xlsx.writeFile(file);
  console.log(`\nSaved ${total} rows to ${file}`);
  await pool.close();
}

main().catch((error) => {
  console.error("Export failed:", error.message);
  process.exitCode = 1;
});