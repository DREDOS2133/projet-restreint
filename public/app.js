const $ = (selector) => document.querySelector(selector);
const state = {
  user: null, users: [], recipient: null, messages: [], replyTo: null,
  attachment: null, mediaRecorder: null, chunks: [], polling: null,
  seenIds: new Set(), firstLoad: true, lastPrivateKey: ""
};

async function api(path, options = {}) {
  const headers = { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options, headers });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || data.ok === false) throw new Error(data.error || `Erreur ${response.status}`);
  return data;
}
const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });
function toast(message) {
  const element = $("#toast"); element.textContent = message; element.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove("show"), 3200);
}
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
}
function initials(name = "?") { return Array.from(name)[0]?.toUpperCase() || "?"; }
function time(timestamp) { return new Date(timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function formatBody(text) {
  return escapeHtml(text).replace(/(^|\s)@([A-Za-z0-9_]{3,20})/g, '$1<span class="mention">@$2</span>');
}
function showAuth() { $("#auth-screen").classList.remove("hidden"); $("#chat-screen").classList.add("hidden"); }
function showChat() { $("#auth-screen").classList.add("hidden"); $("#chat-screen").classList.remove("hidden"); }

async function init() {
  try {
    const status = await api("/api/auth/status");
    if (!status.initialized) {
      $("#setup-note").classList.remove("hidden");
      $("#setup-note").textContent = "Première connexion : utilise les identifiants administrateur configurés sur le serveur.";
      $("#tab-register").classList.add("hidden");
      $("#owner-code-wrap").classList.add("hidden");
      $("#invite-wrap").classList.add("hidden");
    } else {
      $("#tab-register").classList.add("hidden");
      $("#owner-code-wrap").classList.add("hidden");
      $("#invite-wrap").classList.remove("hidden");
      $("#register-subtitle").textContent = "Le propriétaire doit te transmettre un code d'invitation.";
    }
    const current = await api("/api/auth/me").catch(() => null);
    if (current?.user) await enterApp(current);
  } catch (error) {
    $("#top-status").innerHTML = "<i></i> Serveur à configurer";
    $("#setup-note").classList.remove("hidden");
    $("#setup-note").textContent = "Le serveur n'est pas encore prêt. Vérifie la base D1 et le secret OWNER_SETUP_CODE dans Cloudflare.";
  }
}
function selectAuthTab(tab) {
  const login = tab === "login";
  $("#tab-login").classList.toggle("active", login);
  $("#tab-register").classList.toggle("active", !login);
  $("#login-form").classList.toggle("hidden", !login);
  $("#register-form").classList.toggle("hidden", login);
}
$("#tab-login").addEventListener("click", () => selectAuthTab("login"));
$("#tab-register").addEventListener("click", async () => {
  selectAuthTab("register");
  try {
    const status = await api("/api/auth/status");
    $("#owner-code-wrap").classList.toggle("hidden", status.initialized);
    $("#invite-wrap").classList.toggle("hidden", !status.initialized);
  } catch {}
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true; $("#login-message").textContent = "";
  try {
    await post("/api/auth/login", { username: form.get("username"), password: form.get("password") });
    await enterApp(await api("/api/auth/me"));
  } catch (error) { $("#login-message").textContent = error.message; }
  finally { button.disabled = false; }
});
$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true; $("#register-message").textContent = "";
  try {
    const result = await post("/api/auth/register", {
      username: form.get("username"), password: form.get("password"),
      owner_code: form.get("owner_code"), invite_code: form.get("invite_code")
    });
    toast(result.message || "Compte créé.");
    await enterApp(await api("/api/auth/me"));
  } catch (error) { $("#register-message").textContent = error.message; }
  finally { button.disabled = false; }
});

async function enterApp(data) {
  state.user = data.user; state.users = data.users || []; state.firstLoad = true;
  $("#my-name").textContent = state.user.username;
  $("#my-role").textContent = state.user.role === "owner" ? "Propriétaire" : "Membre";
  $("#my-avatar").textContent = initials(state.user.username);
  $("#owner-tools").classList.toggle("hidden", state.user.role !== "owner");
  $("#top-status").innerHTML = "<i></i> Espace connecté";
  $("#invite-result").classList.add("hidden");
  showChat(); renderMembers();
  await post("/api/presence").catch(() => {});
  await loadMessages(true);
  clearInterval(state.polling);
  state.polling = setInterval(async () => {
    if (!state.user) return;
    try {
      await post("/api/presence");
      await refreshUsers();
      await loadMessages(false);
    } catch (error) {
      if (/Connexion requise/i.test(error.message)) { clearInterval(state.polling); showAuth(); }
    }
  }, 3500);
  if ("Notification" in window && Notification.permission === "default") {
    // L'autorisation n'est demandée qu'après une action explicite plus tard.
    $("#top-status").title = "Les notifications de bureau dépendent des autorisations du navigateur.";
  }
}
async function refreshUsers() {
  const data = await api("/api/auth/me"); state.users = data.users || []; renderMembers();
}
function renderMembers() {
  $("#member-count").textContent = `${state.users.length}/6`;
  const members = state.users.filter((member) => member.id !== state.user.id);
  $("#member-list").innerHTML = members.map((member) => `
    <button class="member ${state.recipient === member.id ? "selected" : ""}" data-user="${member.id}" type="button">
      <span class="avatar">${escapeHtml(initials(member.username))}</span>
      <span class="member-name">${escapeHtml(member.username)}${member.role === "owner" ? " ✦" : ""}</span>
      <span class="online-dot ${member.online ? "on" : ""}" title="${member.online ? "En ligne" : "Hors ligne"}"></span>
    </button>`).join("") || '<div style="padding:12px;color:#81768f;font-size:10px">Tu es le premier membre.</div>';
  $("#member-list").querySelectorAll("[data-user]").forEach((button) => {
    button.addEventListener("click", () => selectRecipient(Number(button.dataset.user)));
  });
}
async function selectRecipient(id) {
  state.recipient = id; state.replyTo = null; state.seenIds.clear(); state.firstLoad = true;
  const member = state.users.find((u) => u.id === id);
  $("#group-room").classList.remove("selected");
  $("#conversation-name").textContent = member ? `Conversation avec ${member.username}` : "Message privé";
  $("#conversation-subtitle").textContent = "Conversation privée entre vous deux";
  $("#conversation-icon").textContent = "✉";
  renderMembers(); clearReply(); await loadMessages(true);
}
$("#group-room").addEventListener("click", async () => {
  state.recipient = null; state.replyTo = null; state.seenIds.clear(); state.firstLoad = true;
  $("#group-room").classList.add("selected");
  $("#conversation-name").textContent = "Discussion générale";
  $("#conversation-subtitle").textContent = "Un espace pour échanger ensemble";
  $("#conversation-icon").textContent = "✦";
  renderMembers(); clearReply(); await loadMessages(true);
});
async function loadMessages(forceBottom = false) {
  if (!state.user) return;
  const area = $("#messages");
  const wasBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 90;
  const path = state.recipient ? `/api/messages?with=${state.recipient}` : "/api/messages";
  const data = await api(path);
  const incoming = (data.messages || []).filter((message) => !state.seenIds.has(message.id) && message.user_id !== state.user.id);
  if (!state.firstLoad && incoming.length && document.hidden) {
    document.title = `(${incoming.length}) Nouveau message — PROJET RESTREINT`;
    if ("Notification" in window && Notification.permission === "granted") {
      const newest = incoming[incoming.length - 1];
      new Notification(`Message de ${newest.username}`, { body: newest.body || "Pièce jointe reçue", tag: `pr-${newest.id}` });
    }
  }
  state.messages = data.messages || [];
  state.messages.forEach((message) => state.seenIds.add(message.id));
  state.firstLoad = false;
  renderMessages();
  if (forceBottom || wasBottom) area.scrollTop = area.scrollHeight;
}
function renderAttachment(message) {
  if (!message.attachment_data) return "";
  const data = message.attachment_data;
  const name = escapeHtml(message.attachment_name || "fichier");
  if (message.attachment_type?.startsWith("image/")) return `<a href="${data}" target="_blank" rel="noopener noreferrer"><img src="${data}" alt="${name}"></a>`;
  if (message.attachment_type?.startsWith("audio/")) return `<audio controls preload="none" src="${data}"></audio><a class="file-link" href="${data}" download="${name}">Télécharger le vocal</a>`;
  return `<a class="file-link" href="${data}" target="_blank" rel="noopener noreferrer">📄 ${name}</a>`;
}
function renderMessages() {
  const wrap = $("#messages");
  if (!state.messages.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-symbol">✦</div><h3>Le début de votre histoire.</h3><p>Envoyez le premier message du cercle.</p></div>'; return;
  }
  wrap.innerHTML = state.messages.map((message) => {
    const mine = message.user_id === state.user.id;
    const reply = message.reply_to ? state.messages.find((candidate) => candidate.id === message.reply_to) : null;
    const reactions = (message.reactions || []).map((reaction) => `<button class="reaction" data-react="${message.id}" data-emoji="${escapeHtml(reaction.emoji)}" title="${reaction.count} réaction(s)">${escapeHtml(reaction.emoji)} ${reaction.count}</button>`).join("");
    const body = message.deleted ? "Message supprimé" : formatBody(message.body);
    const attachment = message.deleted ? "" : renderAttachment(message);
    return `<article class="message ${mine ? "mine" : ""}" data-id="${message.id}">
      <span class="avatar">${escapeHtml(initials(message.username))}</span><div class="message-content">
      <div class="message-meta"><b>${escapeHtml(message.username)}</b><span>${time(message.created_at)}${message.edited_at ? " · modifié" : ""}</span></div>
      <div class="bubble ${message.deleted ? "deleted" : ""}">${reply ? `<div class="reply-quote" data-jump="${reply.id}">↳ ${escapeHtml(reply.username)} : ${escapeHtml(reply.body.slice(0, 100))}</div>` : ""}${body}${attachment}</div>
      <div class="reaction-row">${reactions}</div>
      ${!message.deleted ? `<div class="message-actions"><button data-reply="${message.id}" type="button">↩ Répondre</button>${mine ? `<button data-edit="${message.id}" type="button">Modifier</button>` : ""}<button data-react="${message.id}" data-emoji="❤️" type="button">❤️</button><button data-react="${message.id}" data-emoji="👍" type="button">👍</button><button data-react="${message.id}" data-emoji="😂" type="button">😂</button>${mine || state.user.role === "owner" ? `<button data-delete="${message.id}" type="button">Supprimer</button>` : ""}</div>` : ""}
      </div></article>`;
  }).join("");
  wrap.querySelectorAll("[data-reply]").forEach((button) => button.addEventListener("click", () => setReply(Number(button.dataset.reply))));
  wrap.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => editMessage(Number(button.dataset.edit))));
  wrap.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => deleteMessage(Number(button.dataset.delete))));
  wrap.querySelectorAll("[data-react]").forEach((button) => button.addEventListener("click", () => react(Number(button.dataset.react), button.dataset.emoji)));
  wrap.querySelectorAll("[data-jump]").forEach((button) => button.addEventListener("click", () => document.querySelector(`[data-id="${button.dataset.jump}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })));
}
function setReply(id) {
  const message = state.messages.find((candidate) => candidate.id === id); if (!message) return;
  state.replyTo = id; $("#reply-preview").classList.remove("hidden");
  $("#reply-preview").innerHTML = `<span>↩ Réponse à <b>${escapeHtml(message.username)}</b> : ${escapeHtml(message.body.slice(0, 100))}</span><button type="button" id="cancel-reply">✕</button>`;
  $("#cancel-reply").addEventListener("click", clearReply); $("#message-input").focus();
}
function clearReply() { state.replyTo = null; $("#reply-preview").classList.add("hidden"); $("#reply-preview").replaceChildren(); }
async function editMessage(id) {
  const message = state.messages.find((candidate) => candidate.id === id); if (!message) return;
  const body = prompt("Modifier le message :", message.body); if (body === null || !body.trim()) return;
  try { await api(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify({ body: body.trim() }) }); await loadMessages(false); }
  catch (error) { toast(error.message); }
}
async function deleteMessage(id) {
  if (!confirm("Supprimer ce message ?")) return;
  try { await api(`/api/messages/${id}`, { method: "DELETE" }); await loadMessages(false); }
  catch (error) { toast(error.message); }
}
async function react(id, emoji) {
  try { await post(`/api/messages/${id}/reactions`, { emoji }); await loadMessages(false); }
  catch (error) { toast(error.message); }
}

$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = $("#message-input").value.trim();
  if (!body && !state.attachment) return;
  const button = $(".send-button"); button.disabled = true;
  try {
    await post("/api/messages", { body, recipient_id: state.recipient, reply_to: state.replyTo, attachment: state.attachment });
    $("#message-input").value = ""; state.attachment = null; $("#attachment-name").textContent = ""; clearReply(); await loadMessages(true);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$("#message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#composer").requestSubmit(); }
});
$("#file-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  if (file.size > 900 * 1024) { toast("Fichier trop volumineux : limite environ 900 Ko."); event.target.value = ""; return; }
  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];
  if (!allowed.includes(file.type)) { toast("Formats acceptés : JPG, PNG, GIF, WebP et PDF."); event.target.value = ""; return; }
  try {
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    state.attachment = { name: file.name, type: file.type, data }; $("#attachment-name").textContent = file.name;
  } catch { toast("Impossible de lire ce fichier."); }
  event.target.value = "";
});
$("#invite-button").addEventListener("click", async () => {
  try {
    const result = await post("/api/invites"); $("#invite-result").classList.remove("hidden");
    $("#invite-result").textContent = `Code à usage unique : ${result.code} — copie-le et transmets-le en privé.`;
    try { await navigator.clipboard.writeText(result.code); toast("Invitation créée et copiée si le navigateur l'autorise."); }
    catch { toast("Invitation créée. Copie le code affiché."); }
  } catch (error) { toast(error.message); }
});
$("#logout-button").addEventListener("click", async () => {
  try { await post("/api/auth/logout"); } catch {}
  clearInterval(state.polling); state.user = null; state.users = []; state.messages = []; state.seenIds.clear(); document.title = "PROJET RESTREINT — Espace privé"; showAuth(); toast("Déconnecté.");
});
$("#voice-button").addEventListener("click", async () => {
  if (state.mediaRecorder?.state === "recording") { state.mediaRecorder.stop(); $("#voice-button").textContent = "🎙"; return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("L'enregistrement vocal n'est pas pris en charge par ce navigateur."); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.chunks = [];
    const supported = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((mime) => MediaRecorder.isTypeSupported(mime));
    const recorder = supported ? new MediaRecorder(stream, { mimeType: supported }) : new MediaRecorder(stream);
    state.mediaRecorder = recorder;
    recorder.ondataavailable = (event) => { if (event.data.size) state.chunks.push(event.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(state.chunks, { type: recorder.mimeType || "audio/webm" });
      if (blob.size > 900 * 1024) { toast("Vocal trop long. Essaie un enregistrement plus court."); return; }
      const type = blob.type.split(";")[0];
      if (!["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"].includes(type)) { toast("Format vocal non pris en charge par ce navigateur."); return; }
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
      state.attachment = { name: "message-vocal." + (type === "audio/ogg" ? "ogg" : type === "audio/mp4" ? "mp4" : type === "audio/mpeg" ? "mp3" : "webm"), type, data };
      $("#attachment-name").textContent = "🎙 Vocal prêt à envoyer"; $("#voice-button").textContent = "🎙"; toast("Vocal prêt. Appuie sur ↑ pour l'envoyer.");
    };
    recorder.start(); $("#voice-button").textContent = "■"; toast("Enregistrement en cours. Appuie sur ■ pour arrêter.");
  } catch { toast("Autorise l'accès au microphone dans ton navigateur."); }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { document.title = "PROJET RESTREINT — Espace privé"; if (state.user) loadMessages(false).catch(() => {}); }
});
window.addEventListener("beforeunload", () => clearInterval(state.polling));
init();
