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

function buildSupabaseHeaders(key, extra = {}) {
    const cleanKey = (key || "").trim();
    const headers = {
        apikey: cleanKey,
        "Content-Type": "application/json",
        ...extra
    };
    if (cleanKey.startsWith("eyJ")) {
        headers.Authorization = `Bearer ${cleanKey}`;
    }
    return headers;
}

function isFinishedStudentStatus(st) {
    const ts = String((st && st.timestamp) || "");
    return ts.startsWith("Sesi Selesai") || ts.startsWith("Selesai");
}

function shouldReplaceStudent(current, candidate) {
    if (!current) return true;
    if (!candidate) return false;
    const currDone = Number(current.completedTasks) || 0;
    const candDone = Number(candidate.completedTasks) || 0;
    if (candDone > currDone) return true;
    if (candDone < currDone) return false;

    const currFin = isFinishedStudentStatus(current);
    const candFin = isFinishedStudentStatus(candidate);
    if (candFin && !currFin) return true;
    if (!candFin && currFin) return false;

    const currTime = current.updatedAt ? Date.parse(current.updatedAt) : 0;
    const candTime = candidate.updatedAt ? Date.parse(candidate.updatedAt) : 0;
    if (!isNaN(candTime) && !isNaN(currTime) && candTime !== currTime) {
        return candTime > currTime;
    }
    return false;
}

function mergeStudents(listA, listB) {
    const mergedMap = new Map();
    const applyList = (arr) => {
        if (!Array.isArray(arr)) return;
        arr.forEach(item => {
            if (!item) return;
            const key = item.npm || item.id;
            if (!key) return;
            const existing = mergedMap.get(key);
            if (!existing || shouldReplaceStudent(existing, item)) {
                mergedMap.set(key, {
                    ...item,
                    paket: (item.paket && item.paket !== "-") ? item.paket : ((existing && existing.paket) || "-")
                });
            } else if ((!existing.paket || existing.paket === "-") && item.paket && item.paket !== "-") {
                mergedMap.set(key, { ...existing, paket: item.paket });
            }
        });
    };
    applyList(listA);
    applyList(listB);
    return Array.from(mergedMap.values());
}

async function readFromSupabase(sb) {
    try {
        const headers = buildSupabaseHeaders(sb.key);

        const [tokRes, stuRes] = await Promise.all([
            fetch(`${sb.url}/rest/v1/posttest_tokens?select=*`, { headers, cache: "no-store" }),
            fetch(`${sb.url}/rest/v1/posttest_students?select=*&order=updated_at.desc`, { headers, cache: "no-store" })
        ]);

        if (!tokRes.ok && !stuRes.ok) {
            return null;
        }

        let tokens = null;
        let hasTokens = false;
        if (tokRes.ok) {
            const tokRows = await tokRes.json();
            if (Array.isArray(tokRows) && tokRows.length > 0) {
                tokens = JSON.parse(JSON.stringify(DEFAULT_STATE.tokens));
                tokRows.forEach(r => {
                    if (r.kelas && tokens[r.kelas]) {
                        tokens[r.kelas] = {
                            kelas: r.kelas,
                            token: r.token,
                            active: Boolean(r.active)
                        };
                    }
                });
                hasTokens = true;
            }
        }

        let students = [];
        let hasStudents = false;
        if (stuRes.ok) {
            const stuRows = await stuRes.json();
            if (Array.isArray(stuRows)) {
                students = stuRows.map(r => ({
                    id: r.id || ("st-" + r.npm),
                    nama: r.nama,
                    npm: r.npm,
                    kelas: r.kelas,
                    paket: r.paket || "-",
                    completedTasks: typeof r.completed_tasks === "number" ? r.completed_tasks : 0,
                    timestamp: r.timestamp || "Selesai",
                    updatedAt: r.updated_at || null
                }));
                hasStudents = true;
            }
        }

        return { tokens, students, hasTokens, hasStudents, source: "supabase" };
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

async function loadFallbackState() {
    const kvState = await readFromVercelKV();
    if (kvState && kvState.tokens && Array.isArray(kvState.students)) {
        global.__OSQUEST_STATE__ = { tokens: kvState.tokens, students: kvState.students };
        return global.__OSQUEST_STATE__;
    }

    if (global.__OSQUEST_STATE__ && global.__OSQUEST_STATE__.tokens && Array.isArray(global.__OSQUEST_STATE__.students)) {
        return global.__OSQUEST_STATE__;
    }

    try {
        if (fs.existsSync(TMP_FILE)) {
            const raw = fs.readFileSync(TMP_FILE, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed && parsed.tokens && Array.isArray(parsed.students)) {
                global.__OSQUEST_STATE__ = { tokens: parsed.tokens, students: parsed.students };
                return global.__OSQUEST_STATE__;
            }
        }
    } catch (err) {
        // Ignore
    }

    global.__OSQUEST_STATE__ = JSON.parse(JSON.stringify(DEFAULT_STATE));
    return global.__OSQUEST_STATE__;
}

async function loadState() {
    const fallbackState = await loadFallbackState();
    const sb = getSupabaseEnv();
    if (sb) {
        const sbState = await readFromSupabase(sb);
        if (sbState) {
            const tokens = sbState.hasTokens && sbState.tokens ? sbState.tokens : fallbackState.tokens;
            const students = sbState.hasStudents
                ? mergeStudents(sbState.students, fallbackState.students)
                : fallbackState.students;
            const combined = { tokens, students };
            global.__OSQUEST_STATE__ = combined;
            return { ...combined, source: sbState.hasStudents ? "supabase" : "fallback" };
        }
    }

    return { ...fallbackState, source: "fallback" };
}

async function saveStateFallback(state) {
    const cleanState = {
        tokens: state.tokens || JSON.parse(JSON.stringify(DEFAULT_STATE.tokens)),
        students: Array.isArray(state.students) ? state.students : []
    };
    global.__OSQUEST_STATE__ = cleanState;
    try {
        fs.writeFileSync(TMP_FILE, JSON.stringify(cleanState), "utf8");
    } catch (err) {
        // Ignore
    }
    await writeToVercelKV(cleanState);
    return cleanState;
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
        const fallbackState = await loadFallbackState();

        if (action === "upsert_student" && body.student) {
            const st = {
                ...body.student,
                updatedAt: body.student.updatedAt || new Date().toISOString()
            };
            const idx = fallbackState.students.findIndex(
                s => (st.npm && s.npm === st.npm) || (st.id && s.id === st.id)
            );
            if (idx >= 0) {
                fallbackState.students[idx] = { ...fallbackState.students[idx], ...st };
            } else {
                fallbackState.students.unshift(st);
            }
            await saveStateFallback(fallbackState);

            let sbOk = false;
            if (sb) {
                try {
                    const headers = buildSupabaseHeaders(sb.key, {
                        Prefer: "resolution=merge-duplicates,return=minimal"
                    });
                    const done = typeof st.completedTasks === "number" ? st.completedTasks : 0;
                    const sbRes = await fetch(`${sb.url}/rest/v1/posttest_students?on_conflict=npm`, {
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
                            updated_at: st.updatedAt
                        })
                    });
                    sbOk = sbRes.ok;
                } catch (err) {
                    sbOk = false;
                }
            }

            if (sbOk) {
                const updated = await loadState();
                return res.status(200).json(updated);
            }
            return res.status(200).json({ ...fallbackState, source: "fallback" });
        }

        if (action === "delete_student") {
            fallbackState.students = fallbackState.students.filter(
                s => s.id !== body.studentId && (!body.npm || s.npm !== body.npm)
            );
            await saveStateFallback(fallbackState);

            let sbOk = false;
            if (sb) {
                try {
                    const headers = buildSupabaseHeaders(sb.key);
                    const filter = body.npm ? `npm=eq.${encodeURIComponent(body.npm)}` : `id=eq.${encodeURIComponent(body.studentId)}`;
                    const sbRes = await fetch(`${sb.url}/rest/v1/posttest_students?${filter}`, {
                        method: "DELETE",
                        headers
                    });
                    sbOk = sbRes.ok;
                } catch (err) {
                    sbOk = false;
                }
            }

            if (sbOk) {
                const updated = await loadState();
                return res.status(200).json(updated);
            }
            return res.status(200).json({ ...fallbackState, source: "fallback" });
        }

        if (action === "save_tokens" && body.tokens) {
            fallbackState.tokens = body.tokens;
            await saveStateFallback(fallbackState);

            let sbOk = false;
            if (sb) {
                try {
                    const headers = buildSupabaseHeaders(sb.key, {
                        Prefer: "resolution=merge-duplicates,return=minimal"
                    });
                    const rows = Object.values(body.tokens).map(t => ({
                        kelas: t.kelas,
                        token: t.token,
                        active: Boolean(t.active),
                        updated_at: new Date().toISOString()
                    }));
                    const sbRes = await fetch(`${sb.url}/rest/v1/posttest_tokens?on_conflict=kelas`, {
                        method: "POST",
                        headers,
                        body: JSON.stringify(rows)
                    });
                    sbOk = sbRes.ok;
                } catch (err) {
                    sbOk = false;
                }
            }

            if (sbOk) {
                const updated = await loadState();
                return res.status(200).json(updated);
            }
            return res.status(200).json({ ...fallbackState, source: "fallback" });
        }

        if (action === "reset_all") {
            const defaultTokens = body.tokens || JSON.parse(JSON.stringify(DEFAULT_STATE.tokens));
            fallbackState.tokens = defaultTokens;
            fallbackState.students = [];
            await saveStateFallback(fallbackState);

            let sbOk = false;
            if (sb) {
                try {
                    const headers = buildSupabaseHeaders(sb.key, {
                        Prefer: "resolution=merge-duplicates,return=minimal"
                    });
                    const delRes = await fetch(`${sb.url}/rest/v1/posttest_students?npm=neq.__NONE__`, {
                        method: "DELETE",
                        headers
                    });
                    const rows = Object.values(defaultTokens).map(t => ({
                        kelas: t.kelas,
                        token: t.token,
                        active: Boolean(t.active),
                        updated_at: new Date().toISOString()
                    }));
                    const tokRes = await fetch(`${sb.url}/rest/v1/posttest_tokens?on_conflict=kelas`, {
                        method: "POST",
                        headers,
                        body: JSON.stringify(rows)
                    });
                    sbOk = delRes.ok && tokRes.ok;
                } catch (err) {
                    sbOk = false;
                }
            }

            if (sbOk) {
                const updated = await loadState();
                return res.status(200).json(updated);
            }
            return res.status(200).json({ ...fallbackState, source: "fallback" });
        }

        return res.status(400).json({ error: "Invalid action" });
    }

    return res.status(405).json({ error: "Method not allowed" });
};
