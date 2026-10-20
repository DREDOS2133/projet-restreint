const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};
const now = () => Math.floor(Date.now() / 1000);
const json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { ...JSON_HEADERS, ...extraHeaders }
});
const fail = (message, status = 400) => json({ ok: false, error: message }, status);

function hex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function unhex(value) { return new Uint8Array(value.match(/.{1,2}/g).map((x) => parseInt(x, 16))); }
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}
function randomToken(bytes = 32) { return hex(crypto.getRandomValues(new Uint8Array(bytes))); }
async function passwordHash(password, saltHex) {
  const salt = saltHex ? unhex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return `${hex(salt)}:${hex(new Uint8Array(bits))}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored || "").split(":");
  if (parts.length !== 2) return false;
  const actual = (await passwordHash(password, parts[0])).split(":")[1];
  return actual === parts[1];
}
async function readJson(request, max = 1_600_000) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > max) throw new Error("La requête est trop volumineuse.");
  const text = await request.text();
  if (text.length > max) throw new Error("La requête est trop volumineuse.");
  try { return JSON.parse(text || "{}"); } catch { throw new Error("Données JSON invalides."); }
}
function cookieToken(request) {
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const cookies = request.headers.get("cookie") || "";
  const match = cookies.match(/(?:^|;\s*)pr_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}
function sessionCookie(token, maxAge) {
  return `pr_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
function clearCookie() { return "pr_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"; }
function validUsername(value) { return typeof value === "string" && /^[a-zA-Z0-9_]{3,20}$/.test(value); }
function validPassword(value) { return typeof value === "string" && value.length >= 10 && value.length <= 200; }
function isOwner(user) { return user?.role === "owner"; }
function maxMembers(env) { const n = Math.min(6, Math.max(1, Number(env.MAX_MEMBERS || 6))); return Number.isInteger(n) && n >= 2 && n <= 6 ? n : 6; }

async function currentUser(request, env) {
  const token = cookieToken(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    "SELECT u.id,u.username,u.role,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?"
  ).bind(tokenHash).first();
  if (!row) return null;
  if (row.expires_at < now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(tokenHash).run();
    return null;
  }
  return { id: row.id, username: row.username, role: row.role };
}
async function requireUser(request, env) { return currentUser(request, env); }
function userView(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    online: row.last_seen ? now() - row.last_seen < 90 : false
  };
}
async function messageView(row, userId, env) {
  const result = await env.DB.prepare(
    "SELECT emoji,COUNT(*) AS count,MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS mine FROM reactions WHERE message_id=? GROUP BY emoji"
  ).bind(userId, row.id).all();
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    recipient_id: row.recipient_id,
    body: row.deleted_at ? "Message supprimé" : row.body,
    attachment_name: row.deleted_at ? null : row.attachment_name,
    attachment_type: row.deleted_at ? null : row.attachment_type,
    attachment_data: row.deleted_at ? null : row.attachment_data,
    reply_to: row.reply_to,
    edited_at: row.edited_at,
    deleted: Boolean(row.deleted_at),
    created_at: row.created_at,
    reactions: result.results || []
  };
}
async function getMessageRows(env, user, recipient) {
  if (recipient !== null) {
    return env.DB.prepare(
      `SELECT m.*,u.username FROM messages m JOIN users u ON u.id=m.user_id
       WHERE m.deleted_at IS NULL AND ((m.recipient_id=? AND m.user_id=?) OR (m.recipient_id=? AND m.user_id=?))
       ORDER BY m.created_at DESC LIMIT 100`
    ).bind(recipient, user.id, user.id, recipient).all();
  }
  return env.DB.prepare(
    "SELECT m.*,u.username FROM messages m JOIN users u ON u.id=m.user_id WHERE m.recipient_id IS NULL ORDER BY m.created_at DESC LIMIT 100"
  ).all();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });

      if (url.pathname === "/api/health" && request.method === "GET") {
        const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
        return json({ ok: true, service: "PROJET RESTREINT", status: "online", members: row?.count || 0, max_members: maxMembers(env) });
      }

      if (url.pathname === "/api/auth/status" && request.method === "GET") {
        const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
        const count = row?.count || 0;
        return json({ ok: true, initialized: count > 0, member_count: count, max_members: maxMembers(env) });
      }

      if (url.pathname === "/api/auth/register" && request.method === "POST") {
          const data = await readJson(request, 12000);
          const username = (data.username || "").trim();
          const password = data.password || "";

          if (!validUsername(username)) {
            return fail("Le pseudo doit contenir entre 3 et 20 caractères : lettres, chiffres ou _.", 400);
          }
          if (!validPassword(password)) {
            return fail("Le mot de passe doit contenir au moins 10 caractères.", 400);
          }
          if (username.toLowerCase() === "ghost909") {
            return fail("Ce pseudo est réservé au propriétaire. Utilise Connexion.", 403);
          }

          const existing = await env.DB.prepare(
            "SELECT id FROM users WHERE username=? COLLATE NOCASE"
          ).bind(username).first();

          if (existing) return fail("Ce pseudo est déjà utilisé. Choisis-en un autre.", 409);

          const total = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
          const owner = await env.DB.prepare(
            "SELECT id FROM users WHERE username='ghost909' COLLATE NOCASE AND role='owner'"
          ).first();

          const maxMembers = 6;
          const registrationLimit = owner ? maxMembers : maxMembers - 1;

          if ((total?.count || 0) >= registrationLimit) {
            return fail("Le groupe est complet ou la place du propriétaire doit être réservée.", 403);
          }

          const created = now();
          const hashed = await passwordHash(password);
          let result;

          try {
            result = await env.DB.prepare(
              "INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)"
            ).bind(username, hashed, "member", created).run();
          } catch {
            return fail("Impossible de créer ce compte. Vérifie le pseudo et réessaie.", 409);
          }

          const userId = result.meta.last_row_id;
          const token = randomToken();
          const expires = created + Number(env.SESSION_DAYS || 7) * 86400;

          await env.DB.prepare(
            "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)"
          ).bind(await sha256(token), userId, expires, created).run();

          await env.DB.prepare(
            "INSERT INTO presence(user_id,last_seen) VALUES(?,?)"
          ).bind(userId, created).run();

          return new Response(JSON.stringify({
            ok: true,
            user: { id: userId, username, role: "member" },
            message: "Compte créé."
          }), {
            headers: { ...JSON_HEADERS, "set-cookie": sessionCookie(token, expires - created) }
          });
        }
        if (url.pathname === "/api/auth/login" && request.method === "POST") {
          const data = await readJson(request, 12000);
          const username = (data.username || "").trim();
          const password = data.password || "";

          if (!validUsername(username) || !password) {
            return fail("Entre ton pseudo et ton mot de passe.", 400);
          }

          let row;

          if (username.toLowerCase() === "ghost909") {
            const ownerPassword = env.OWNER_PASSWORD || "";

            if (!ownerPassword) {
              return fail("Le mot de passe administrateur doit être configuré dans les secrets Cloudflare.", 503);
            }

            if (password !== ownerPassword) {
              return fail("Pseudo ou mot de passe incorrect.", 401);
            }

            row = await env.DB.prepare(
              "SELECT * FROM users WHERE username=? COLLATE NOCASE"
            ).bind("ghost909").first();

            const ownerHash = await passwordHash(password);

            if (!row) {
              const total = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();

              if ((total?.count || 0) >= 6) {
                return fail("Le groupe est complet. Une place doit être libérée pour le propriétaire.", 403);
              }

              const created = now();

              await env.DB.prepare(
                "INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)"
              ).bind("ghost909", ownerHash, "owner", created).run();
            } else if (
              row.role !== "owner" ||
              !(await verifyPassword(password, row.password_hash))
            ) {
              await env.DB.prepare(
                "UPDATE users SET password_hash=?,role='owner' WHERE id=?"
              ).bind(ownerHash, row.id).run();
            }

            row = await env.DB.prepare(
              "SELECT * FROM users WHERE username=? COLLATE NOCASE"
            ).bind("ghost909").first();
          } else {
            row = await env.DB.prepare(
              "SELECT * FROM users WHERE username=? COLLATE NOCASE"
            ).bind(username).first();

            if (!row || !(await verifyPassword(password, row.password_hash))) {
              return fail("Pseudo ou mot de passe incorrect.", 401);
            }

            if (row.role === "owner") {
              await env.DB.prepare(
                "UPDATE users SET role='member' WHERE id=?"
              ).bind(row.id).run();

              row.role = "member";
            }
          }

          const created = now();
          const token = randomToken();
          const expires = created + Number(env.SESSION_DAYS || 7) * 86400;

          await env.DB.prepare(
            "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)"
          ).bind(await sha256(token), row.id, expires, created).run();

          await env.DB.prepare(
            "INSERT INTO presence(user_id,last_seen) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_seen=excluded.last_seen"
          ).bind(row.id, created).run();

          return new Response(JSON.stringify({
            ok: true,
            user: { id: row.id, username: row.username, role: row.role }
          }), {
            headers: { ...JSON_HEADERS, "set-cookie": sessionCookie(token, expires - created) }
          });
        }
        if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        const token = cookieToken(request);
        if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
        return json({ ok: true }, 200, { "set-cookie": clearCookie() });
      }

      const user = await requireUser(request, env);
      if (!user) return fail("Connexion requise.", 401);

      if (url.pathname === "/api/auth/me" && request.method === "GET") {
        const result = await env.DB.prepare(
          "SELECT u.id,u.username,u.role,p.last_seen FROM users u LEFT JOIN presence p ON p.user_id=u.id ORDER BY u.created_at"
        ).all();
        return json({ ok: true, user, users: (result.results || []).map(userView), max_members: maxMembers(env) });
      }

      if (url.pathname === "/api/presence" && request.method === "POST") {
        await env.DB.prepare("INSERT INTO presence(user_id,last_seen) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_seen=excluded.last_seen")
          .bind(user.id, now()).run();
        return json({ ok: true });
      }

      if (url.pathname === "/api/invites" && request.method === "POST") {
        if (!isOwner(user)) return fail("Réservé au propriétaire.", 403);
        const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
        if ((count?.count || 0) >= maxMembers(env)) return fail("Le groupe est complet.", 403);
        const code = randomToken(12);
        await env.DB.prepare("INSERT INTO invites(code_hash,created_by,created_at) VALUES(?,?,?)")
          .bind(await sha256(code), user.id, now()).run();
        return json({ ok: true, code, message: "Transmets ce code en privé. Il ne peut être utilisé qu'une seule fois." });
      }

      if (url.pathname === "/api/messages" && request.method === "GET") {
        const withParam = url.searchParams.get("with");
        let recipient = null;
        if (withParam !== null) {
          if (!/^\d+$/.test(withParam)) return fail("Destinataire invalide.");
          recipient = Number(withParam);
          if (recipient === user.id) return fail("Destinataire invalide.");
          const exists = await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(recipient).first();
          if (!exists) return fail("Membre introuvable.", 404);
        }
        const result = await getMessageRows(env, user, recipient);
        const rows = (result.results || []).reverse();
        const messages = await Promise.all(rows.map((row) => messageView(row, user.id, env)));
        return json({ ok: true, messages });
      }

      if (url.pathname === "/api/messages" && request.method === "POST") {
        const data = await readJson(request, 1_600_000);
        const body = typeof data.body === "string" ? data.body.trim() : "";
        const attachment = data.attachment || null;
        if (!body && !attachment) return fail("Écris un message ou joins un fichier.");
        if (body.length > 4000) return fail("Message trop long (4000 caractères maximum).");

        let recipient = data.recipient_id == null || data.recipient_id === "" ? null : Number(data.recipient_id);
        if (recipient !== null) {
          if (!Number.isInteger(recipient) || recipient === user.id) return fail("Destinataire invalide.");
          const exists = await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(recipient).first();
          if (!exists) return fail("Membre introuvable.");
        }

        let replyTo = data.reply_to ? Number(data.reply_to) : null;
        if (replyTo !== null) {
          const parent = await env.DB.prepare("SELECT id,recipient_id,user_id FROM messages WHERE id=? AND deleted_at IS NULL")
            .bind(replyTo).first();
          if (!parent) return fail("Le message cité n'existe plus.");
          if (recipient === null && parent.recipient_id !== null) return fail("Ce message ne fait pas partie du salon général.");
          if (recipient !== null && parent.recipient_id !== null && !((parent.user_id === user.id && parent.recipient_id === recipient) || (parent.user_id === recipient && parent.recipient_id === user.id))) {
            return fail("Ce message ne fait pas partie de cette conversation.");
          }
        }

        let name = null, type = null, contents = null;
        if (attachment) {
          if (typeof attachment.name !== "string" || typeof attachment.type !== "string" || typeof attachment.data !== "string") return fail("Fichier invalide.");
          const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"];
          if (!allowedTypes.includes(attachment.type)) return fail("Type de fichier non autorisé.");
          if (!attachment.data.startsWith(`data:${attachment.type};base64,`) || attachment.data.length > 1_250_000) return fail("Fichier trop volumineux (environ 900 Ko maximum).");
          name = attachment.name.replace(/[\\/\r\n\0]/g, "_").slice(0, 120);
          type = attachment.type;
          contents = attachment.data;
        }
        const result = await env.DB.prepare(
          "INSERT INTO messages(user_id,recipient_id,body,attachment_name,attachment_type,attachment_data,reply_to,created_at) VALUES(?,?,?,?,?,?,?,?)"
        ).bind(user.id, recipient, body, name, type, contents, replyTo, now()).run();
        return json({ ok: true, id: result.meta.last_row_id });
      }

      const messageMatch = url.pathname.match(/^\/api\/messages\/(\d+)$/);
      if (messageMatch && request.method === "PATCH") {
        const id = Number(messageMatch[1]);
        const data = await readJson(request, 10000);
        const body = typeof data.body === "string" ? data.body.trim() : "";
        if (!body || body.length > 4000) return fail("Le message doit contenir entre 1 et 4000 caractères.");
        const row = await env.DB.prepare("SELECT user_id,created_at,deleted_at FROM messages WHERE id=?").bind(id).first();
        if (!row || row.deleted_at) return fail("Message introuvable.", 404);
        if (row.user_id !== user.id) return fail("Tu peux modifier uniquement tes messages.", 403);
        if (now() - row.created_at > 900) return fail("La modification est autorisée pendant 15 minutes.", 403);
        await env.DB.prepare("UPDATE messages SET body=?,edited_at=? WHERE id=?").bind(body, now(), id).run();
        return json({ ok: true });
      }

      if (messageMatch && request.method === "DELETE") {
        const id = Number(messageMatch[1]);
        const row = await env.DB.prepare("SELECT user_id FROM messages WHERE id=?").bind(id).first();
        if (!row) return fail("Message introuvable.", 404);
        if (row.user_id !== user.id && !isOwner(user)) return fail("Action non autorisée.", 403);
        await env.DB.prepare("UPDATE messages SET body='',attachment_data=NULL,attachment_name=NULL,attachment_type=NULL,deleted_at=? WHERE id=?")
          .bind(now(), id).run();
        await env.DB.prepare("DELETE FROM reactions WHERE message_id=?").bind(id).run();
        return json({ ok: true });
      }

      const reactionMatch = url.pathname.match(/^\/api\/messages\/(\d+)\/reactions$/);
      if (reactionMatch && request.method === "POST") {
        const id = Number(reactionMatch[1]);
        const data = await readJson(request, 3000);
        const emoji = data.emoji;
        if (!["❤️", "😂", "👍", "👎", "🔥", "😮", "😢", "🎉"].includes(emoji)) return fail("Réaction non autorisée.");
        const exists = await env.DB.prepare("SELECT id FROM messages WHERE id=? AND deleted_at IS NULL").bind(id).first();
        if (!exists) return fail("Message introuvable.", 404);
        const prior = await env.DB.prepare("SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?").bind(id, user.id, emoji).first();
        if (prior) await env.DB.prepare("DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?").bind(id, user.id, emoji).run();
        else await env.DB.prepare("INSERT INTO reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?)").bind(id, user.id, emoji, now()).run();
        return json({ ok: true });
      }

      return fail("Route API introuvable.", 404);
    } catch (error) {
      console.error("PROJET RESTREINT API error:", error);
      return fail(error?.message || "Erreur serveur.", 500);
    }
  }
};
