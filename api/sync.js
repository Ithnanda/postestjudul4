const fs = require("fs");
const path = require("path");

const TMP_FILE = path.join("/tmp", "osquest_hots_store_v3.json");
const KV_KEY = "osquest_hots_store_v3";

const DEFAULT_STATE = {
    tokens: {
        A: { kelas: "A", token: "OSA-401", active: true },
        B: { kelas: "B", token: "OSB-402", active: true },
        C: { kelas: "C", token: "OSC-403", active: true },
        D: { kelas: "D", token: "OSD-404", active: true },
        E: { kelas: "E", token: "OSE-405", active: true }
    },
    students: []
};

if (!global.__OSQUEST_STATE__) {
    global.__OSQUEST_STATE__ = null;
}

async function readFromVercelKV() {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;

    try {
        const res = await fetch(`${url}/get/${KV_KEY}`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store"
        });
        if (!res.ok) return null;
        const json = await res.json();
        if (json && json.result) {
            return typeof json.result === "string" ? JSON.parse(json.result) : json.result;
        }
    } catch (err) {
        // Fallback ke file/memory
    }
    return null;
}

async function writeToVercelKV(state) {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return false;

    try {
        await fetch(`${url}/set/${KV_KEY}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(JSON.stringify(state))
        });
        return true;
    } catch (err) {
        return false;
    }
}

async function loadState() {
    const kvState = await readFromVercelKV();
    if (kvState && kvState.tokens && Array.isArray(kvState.students)) {
        global.__OSQUEST_STATE__ = kvState;
        return kvState;
    }

    if (global.__OSQUEST_STATE__) {
        return global.__OSQUEST_STATE__;
    }

    try {
        if (fs.existsSync(TMP_FILE)) {
            const raw = fs.readFileSync(TMP_FILE, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed && parsed.tokens && Array.isArray(parsed.students)) {
                global.__OSQUEST_STATE__ = parsed;
                return parsed;
            }
        }
    } catch (err) {
        // Abaikan error baca file sementara
    }

    global.__OSQUEST_STATE__ = JSON.parse(JSON.stringify(DEFAULT_STATE));
    return global.__OSQUEST_STATE__;
}

async function saveState(state) {
    global.__OSQUEST_STATE__ = state;
    try {
        fs.writeFileSync(TMP_FILE, JSON.stringify(state), "utf8");
    } catch (err) {
        // Abaikan jika gagal tulis ke /tmp
    }
    await writeToVercelKV(state);
}

module.exports = async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    const state = await loadState();

    if (req.method === "GET") {
        return res.status(200).json(state);
    }

    if (req.method === "POST") {
        const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
        const { action } = body;

        if (action === "upsert_student" && body.student) {
            const st = body.student;
            const idx = state.students.findIndex(
                s => (st.npm && s.npm === st.npm) || (st.id && s.id === st.id)
            );
            if (idx >= 0) {
                state.students[idx] = { ...state.students[idx], ...st };
            } else {
                state.students.unshift(st);
            }
            await saveState(state);
            return res.status(200).json(state);
        }

        if (action === "delete_student") {
            state.students = state.students.filter(
                s => s.id !== body.studentId && (!body.npm || s.npm !== body.npm)
            );
            await saveState(state);
            return res.status(200).json(state);
        }

        if (action === "save_tokens" && body.tokens) {
            state.tokens = body.tokens;
            await saveState(state);
            return res.status(200).json(state);
        }

        if (action === "reset_all") {
            state.tokens = body.tokens || JSON.parse(JSON.stringify(DEFAULT_STATE.tokens));
            state.students = [];
            await saveState(state);
            return res.status(200).json(state);
        }

        return res.status(400).json({ error: "Invalid action" });
    }

    return res.status(405).json({ error: "Method not allowed" });
};

