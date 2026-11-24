const { server, initializationPromise } = require("../backend/server");

module.exports = async function handler(req, res) {
  try {
    await initializationPromise;
    server.emit("request", req, res);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Could not connect to MSSQL." }));
  }
};
