import express from "express";
import http from "http";
import { Server } from "socket.io";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import simpleGit from "simple-git";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PANEL_SECRET_KEY = process.env.PANEL_KEY || "NARUTO1234";
const TOKEN_EXPIRY_MS = 6 * 60 * 60 * 1000;
const activeTokens = new Map();

const MONGO_ATLAS_URI = process.env.MONGO_URI || "mongodb+srv://maxjihad59_db_user:RCjqzFavFxGCZDE6@cluster0.1rvhfx8.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const APPS_DIR = path.join(__dirname, "apps");
if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });

const bots = new Map();
const serverStartTime = Date.now();

function generateToken(key) {
    const token = uuidv4();
    const expiry = Date.now() + TOKEN_EXPIRY_MS;
    activeTokens.set(token, { expiry, createdAt: Date.now() });
    if (activeTokens.size > 100) cleanupExpiredTokens();
    return token;
}

function verifyToken(token) {
    if (!token) return false;
    const data = activeTokens.get(token);
    if (!data) return false;
    if (Date.now() > data.expiry) {
        activeTokens.delete(token);
        return false;
    }
    return true;
}

function cleanupExpiredTokens() {
    const now = Date.now();
    for (let [token, data] of activeTokens.entries()) {
        if (now > data.expiry) activeTokens.delete(token);
    }
}

function enforceToken(req, res, next) {
    const token = req.query.token || req.body.token;
    if (verifyToken(token)) next();
    else res.status(401).json({ success: false, error: "Access Denied: Invalid or expired token." });
}

function cleanAnsi(s) {
    return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function appendLog(id, chunk) {
    const bot = bots.get(id);
    if (!bot) return;
    const txt = cleanAnsi(String(chunk));
    bot.logs.push(txt);
    if (bot.logs.length > 3000) bot.logs.splice(0, bot.logs.length - 3000);
    io.to(id).emit("log", { id, text: txt });
}

function formatUptime(ms) {
    if (!ms || ms < 0) return "0h 0m 0s";
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}h ${m}m ${sec}s`;
}

function emitBots() {
    const now = Date.now();
    const list = Array.from(bots.values()).map((b) => ({
        id: b.id,
        name: b.name,
        repoUrl: b.repoUrl,
        entry: b.entry,
        status: b.status,
        startTime: b.startTime || null,
        dir: b.dir,
        port: b.port || null,
        botUptime: b.startTime && b.status === "running"
            ? formatUptime(now - b.startTime)
            : b.startTime
            ? formatUptime(b.lastDuration || 0)
            : "N/A",
    }));
    io.emit("bots", list);
}

function getRandomPort(base = 10000) {
    return base + Math.floor(Math.random() * 40000);
}

// ✅ UPDATED: Node.js + Python bot support
function startBot(id, restartCount = 0) {
    const bot = bots.get(id);
    if (!bot || bot.proc) return;

    const entryPath = path.join(bot.dir, bot.entry || "index.js");
    if (!fs.existsSync(entryPath)) {
        appendLog(id, `❌ Entry not found: ${bot.entry}\n`);
        bot.status = "error";
        emitBots();
        return;
    }

    if (!bot.port) bot.port = getRandomPort();

    const memoryLimitMB = 170;
    const botEnv = {
        ...process.env,
        NODE_ENV: "production",
        PORT: bot.port,
        MONGO_URI: MONGO_ATLAS_URI,
    };

    let command, args;
    if (bot.entry.endsWith(".py")) {
        command = "python3";
        args = [bot.entry];
        appendLog(id, `🚀 Starting Python bot: ${bot.entry}\n`);
    } else {
        command = "node";
        args = [`--max-old-space-size=${memoryLimitMB}`, bot.entry];
        appendLog(id, `🚀 Starting Node bot: ${bot.entry} (RAM ${memoryLimitMB}MB)\n`);
    }

    const proc = spawn(command, args, {
        cwd: bot.dir,
        shell: true,
        env: botEnv,
    });

    bot.proc = proc;
    bot.status = "running";
    bot.startTime = Date.now();
    delete bot.lastDuration;
    emitBots();

    proc.stdout.on("data", (d) => appendLog(id, d));
    proc.stderr.on("data", (d) => appendLog(id, d));

    proc.on("error", (err) => appendLog(id, `⚠️ Process error: ${err.message}\n`));

    proc.on("close", (code) => {
        appendLog(id, `🛑 Bot exited (code=${code})\n`);
        if (bot.startTime) bot.lastDuration = (bot.lastDuration || 0) + (Date.now() - bot.startTime);
        bot.proc = null;
        bot.status = "stopped";
        delete bot.startTime;
        emitBots();

        if (code === 0) return;
        if (restartCount < 5) {
            appendLog(id, `🔁 Restarting in 5s (try ${restartCount + 1}/5)\n`);
            setTimeout(() => startBot(id, restartCount + 1), 5000);
        } else {
            appendLog(id, "❌ Max restart attempts reached. Bot stopped.\n");
        }
    });
}

// ✅ Modified deploy route to auto handle Python + Node.js
app.post("/api/deploy", enforceToken, async (req, res) => {
    try {
        const { repoUrl, name, entry = "index.js" } = req.body;
        if (!repoUrl) return res.status(400).json({ error: "repoUrl required" });

        const safeName = (name && name.trim())
            ? name.trim().replace(/\s+/g, "-")
            : path.basename(repoUrl).replace(/\.git$/, "") + "-" + uuidv4().slice(0, 6);

        const appDir = path.join(APPS_DIR, safeName);
        const id = uuidv4();

        bots.set(id, {
            id,
            name: safeName,
            repoUrl,
            dir: appDir,
            entry,
            proc: null,
            logs: [],
            status: "cloning",
            port: getRandomPort(),
        });
        emitBots();
        appendLog(id, `📦 Cloning ${repoUrl} -> ${appDir}\n`);

        const git = simpleGit();
        if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
        await git.clone(repoUrl, appDir);
        appendLog(id, `✅ Clone complete\n`);

        bots.get(id).status = "installing";
        emitBots();

        const isPython = entry.endsWith(".py") || fs.existsSync(path.join(appDir, "requirements.txt"));
        if (isPython) {
            appendLog(id, `🐍 Running pip install -r requirements.txt (if exists)...\n`);
            await new Promise((resolve) => {
                const pip = spawn("pip3", ["install", "-r", "requirements.txt"], {
                    cwd: appDir,
                    shell: true,
                });
                pip.stdout.on("data", (d) => appendLog(id, d));
                pip.stderr.on("data", (d) => appendLog(id, d));
                pip.on("close", () => resolve());
            });
        } else {
            appendLog(id, `📦 Running npm install...\n`);
            await new Promise((resolve, reject) => {
                const npm = spawn("npm", ["install", "--no-audit", "--no-fund"], {
                    cwd: appDir,
                    shell: true,
                });
                npm.stdout.on("data", (d) => appendLog(id, d));
                npm.stderr.on("data", (d) => appendLog(id, d));
                npm.on("close", (code) => (code === 0 ? resolve() : reject(new Error("npm install failed"))));
            });
        }

        bots.get(id).status = "stopped";
        emitBots();
        appendLog(id, `✅ Install done, starting in 2s\n`);
        setTimeout(() => startBot(id), 2000);

        res.json({ id, name: safeName, dir: appDir });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 🧩 বাকি রুটগুলো একই থাকবে
// /api/:id/start, /api/:id/stop, /api/:id/update, /api/:id/restart ইত্যাদি আগের মতোই কাজ করবে

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ LIKHON PANEL running on port ${PORT}`));

setInterval(emitBots, 5000);
