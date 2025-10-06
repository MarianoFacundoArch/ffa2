import http from "node:http";
import path from "node:path";
import express from "express";
import morgan from "morgan";
import { Server as SocketServer } from "socket.io";
import { SessionManager } from "./sessionManager.js";
import { dirs } from "./config.js";

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: "*" } });

const manager = new SessionManager();
manager.bootstrap();

manager.on("settings", (settings) => {
  io.emit("settings:update", settings);
});

app.use(morgan("dev"));
app.use(express.json());
app.use("/static", express.static(path.join(dirs.rootDir, "public")));

const api = express.Router();

api.get("/sessions", (_req, res) => {
  res.json(manager.list());
});

api.post("/sessions", (req, res) => {
  const {
    queueUrl,
    label,
    sourceUrl,
    count = 1,
    autoReloadMs,
  } = req.body || {};
  if (!queueUrl) {
    return res.status(400).json({ error: "queueUrl is required" });
  }
  const created = [];
  try {
    const total = Number(count) || 1;
    for (let i = 0; i < total; i += 1) {
      const labelForSession =
        total > 1 ? `${label || "Queue"} #${i + 1}` : label;
      const session = manager.create({
        queueUrl,
        label: labelForSession,
        sourceUrl,
        autoReloadMs,
      });
      created.push({
        id: session.id,
        label: session.label,
        state: session.state,
      });
    }
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  res.status(201).json(created);
});

api.post("/sessions/:id/bring-to-front", async (req, res) => {
  try {
    const state = await manager.bringToFront(req.params.id);
    res.json(state);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

api.post("/sessions/:id/reload", async (req, res) => {
  try {
    const state = await manager.reload(req.params.id);
    res.json(state);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

api.post("/sessions/:id/auto-reload", (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  try {
    const state = manager.setSessionAutoReload(req.params.id, enabled);
    res.json(state);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

api.post("/sessions/:id/screenshot", async (req, res) => {
  try {
    const state = await manager.screenshot(req.params.id);
    res.json({ screenshotPath: state.screenshotPath });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

api.get("/sessions/:id/screenshot", (req, res) => {
  const session = manager.get(req.params.id);
  if (
    !session ||
    !session.state.screenshotPath ||
    !path.isAbsolute(session.state.screenshotPath)
  ) {
    return res.status(404).end();
  }
  res.sendFile(session.state.screenshotPath);
});

api.post("/auto-reload", (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  manager.setGlobalAutoReload(enabled);
  res.json(manager.getSettings());
});

app.use("/api", api);

app.get("/", (_req, res) => {
  res.sendFile(path.join(dirs.rootDir, "public", "index.html"));
});

io.on("connection", (socket) => {
  socket.emit("sessions:init", manager.list());
  socket.emit("settings:init", manager.getSettings());
  const handleState = (state) => {
    socket.emit("sessions:update", state);
  };
  manager.on("state", handleState);
  socket.on("disconnect", () => {
    manager.off("state", handleState);
  });
});

const PORT = process.env.PORT || 4100;
server.listen(PORT, () => {
  console.log(`[server] queue monitor running on http://localhost:${PORT}`);
});
