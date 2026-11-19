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

function getSupabaseEnv() {
    const url = (
        process.env.SUPABASE_URL ||
        process.env.NEXT_PUBLIC_SUPABASE_URL ||
        "https://ekbwnxiodgeqzjjtmdju.supabase.co"
    ).trim().replace(/\/rest\/v1\/?$/i, "").replace(/\/$/, "");
    const key = (
        process.env.SUPABASE_ANON_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        "sb_publishable_SR7X_nlZnSIJPnui2AwG9Q_4HUO4sd6"
    ).trim();
    if (!url || !key) return null;
    return { url, key };
}

function calculateScore(completedCount) {
    if (!completedCount || completedCount <= 0) return 0;
    if (completedCount >= 10) return 80;
    const ratio = (completedCount - 1) / 8;
    const score = 60 + Math.round(ratio * 16);
    return Math.min(76, Math.max(60, score));
}

async function readFromSupabase(sb) {
    try {
        const headers = {
            apikey: sb.key,
            Authorization: `Bearer ${sb.key}`,
            "Content-Type": "application/json"
        };

        const [tokRes, stuRes] = await Promise.all([
            fetch(`${sb.url}/rest/v1/posttest_tokens?select=*`, { headers, cache: "no-store" }),
            fetch(`${sb.url}/rest/v1/posttest_students?select=*&order=updated_at.desc`, { headers, cache: "no-store" })
        ]);

        if (!tokRes.ok || !stuRes.ok) return null;

        const tokRows = await tokRes.json();
        const stuRows = await stuRes.json();

        const tokens = JSON.parse(JSON.stringify(DEFAULT_STATE.tokens));
        if (Array.isArray(tokRows)) {
            tokRows.forEach(r => {
                if (r.kelas && tokens[r.kelas]) {
                    tokens[r.kelas] = {
                        kelas: r.kelas,
                        token: r.token,
                        active: Boolean(r.active)
                    };
                }
            });
        }

        const students = Array.isArray(stuRows)
            ? stuRows.map(r => ({
                  id: r.id || ("st-" + r.npm),
                  nama: r.nama,
                  npm: r.npm,
                  kelas: r.kelas,
                  paket: r.paket || "-",
                  completedTasks: typeof r.completed_tasks === "number" ? r.completed_tasks : 0,
                  timestamp: r.timestamp || "Selesai"
              }))
            : [];

        return { tokens, students, source: "supabase" };
    } catch (err) {
        return null;
    }
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
        // Fallback
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
    const sb = getSupabaseEnv();
    if (sb) {
        const sbState = await readFromSupabase(sb);
        if (sbState) {
            global.__OSQUEST_STATE__ = sbState;
            return sbState;
        }
    }

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
        // Ignore
    }

    global.__OSQUEST_STATE__ = JSON.parse(JSON.stringify(DEFAULT_STATE));
    return global.__OSQUEST_STATE__;
}

async function saveStateFallback(state) {
    global.__OSQUEST_STATE__ = state;
    try {
        fs.writeFileSync(TMP_FILE, JSON.stringify(state), "utf8");
    } catch (err) {
        // Ignore
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

    const sb = getSupabaseEnv();

    if (req.method === "GET") {
        const state = await loadState();
        return res.status(200).json(state);
    }

    if (req.method === "POST") {
        const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
        const { action } = body;

        if (sb) {
            const headers = {
                apikey: sb.key,
                Authorization: `Bearer ${sb.key}`,
                "Content-Type": "application/json",
                Prefer: "resolution=merge-duplicates,return=minimal"
            };

            if (action === "upsert_student" && body.student) {
                const st = body.student;
                const done = typeof st.completedTasks === "number" ? st.completedTasks : 0;
                await fetch(`${sb.url}/rest/v1/posttest_students?on_conflict=npm`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        npm: st.npm,
                        id: st.id || ("st-" + Date.now()),
                        nama: st.nama,
                        kelas: st.kelas,
                        paket: st.paket || "-",
                        completed_tasks: done,
                        score: calculateScore(done),
                        timestamp: st.timestamp || "Selesai",
                        updated_at: new Date().toISOString()
                    })
                });
                const updated = await loadState();
                return res.status(200).json(updated);
            }

            if (action === "delete_student") {
                const filter = body.npm ? `npm=eq.${encodeURIComponent(body.npm)}` : `id=eq.${encodeURIComponent(body.studentId)}`;
                await fetch(`${sb.url}/rest/v1/posttest_students?${filter}`, {
                    method: "DELETE",
                    headers
                });
                const updated = await loadState();
                return res.status(200).json(updated);
            }

            if (action === "save_tokens" && body.tokens) {
                const rows = Object.values(body.tokens).map(t => ({
                    kelas: t.kelas,
                    token: t.token,
                    active: Boolean(t.active),
                    updated_at: new Date().toISOString()
                }));
                await fetch(`${sb.url}/rest/v1/posttest_tokens?on_conflict=kelas`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(rows)
                });
                const updated = await loadState();
                return res.status(200).json(updated);
            }

            if (action === "reset_all") {
                await fetch(`${sb.url}/rest/v1/posttest_students?npm=neq.__NONE__`, {
                    method: "DELETE",
                    headers
                });
                const defaultTokens = body.tokens || DEFAULT_STATE.tokens;
                const rows = Object.values(defaultTokens).map(t => ({
                    kelas: t.kelas,
                    token: t.token,
                    active: Boolean(t.active),
                    updated_at: new Date().toISOString()
                }));
                await fetch(`${sb.url}/rest/v1/posttest_tokens?on_conflict=kelas`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(rows)
                });
                const updated = await loadState();
                return res.status(200).json(updated);
            }
        }

        // Fallback apabila env Supabase di server belum diset
        const state = await loadState();

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
            await saveStateFallback(state);
            return res.status(200).json(state);
        }

        if (action === "delete_student") {
            state.students = state.students.filter(
                s => s.id !== body.studentId && (!body.npm || s.npm !== body.npm)
            );
            await saveStateFallback(state);
            return res.status(200).json(state);
        }

        if (action === "save_tokens" && body.tokens) {
            state.tokens = body.tokens;
            await saveStateFallback(state);
            return res.status(200).json(state);
        }

        if (action === "reset_all") {
            state.tokens = body.tokens || JSON.parse(JSON.stringify(DEFAULT_STATE.tokens));
            state.students = [];
            await saveStateFallback(state);
            return res.status(200).json(state);
        }

        return res.status(400).json({ error: "Invalid action" });
    }

    return res.status(405).json({ error: "Method not allowed" });
};
