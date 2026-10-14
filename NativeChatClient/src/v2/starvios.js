/*
 * Starvios source for NativeChat.
 *
 * Reads the public live chat of a Starvios channel (the same data the Starvios web shows)
 * and feeds it to Chat.write, the same way youtube.js does for YouTube.
 *
 * Read-only: no login, nothing is sent to Starvios.
 *
 * Starvios keeps its chat in a Supabase project and exposes it with the public
 * "publishable" key that the Starvios web also uses. The endpoints are not documented,
 * so this may need updating if Starvios changes its backend.
 */
(function () {
  const PROJECT = "https://naiijcvngtkkocligwvk.supabase.co";
  const PUBLIC_KEY = "sb_publishable_4lF1QyQhWOUE1Pw3rWBwEw_bVmkAxm6";
  const MESSAGE_SELECT =
    "id,user_id,body,coins,kind,badges,is_deleted,created_at," +
    "profiles:profiles!live_chat_messages_user_id_fkey(username,display_name,is_partner,is_verified,is_team,chat_color)";

  const HISTORY_LIMIT = 50;          // messages shown when connecting
  const RETRY_MS = 60 * 1000;        // channel offline or not found: try again later
  const EMOTE_URL_TTL = 6 * 60 * 60; // signed emote URLs last 6 hours (seconds)
  const EMOTE_REFRESH_MS = 5 * 60 * 60 * 1000;
  const HEARTBEAT_MS = 25 * 1000;
  const SEEN_MAX = 3000;
  const STALE_AFTER_MS = 15 * 60 * 1000; // like the web: don't show the chat of a stream that ended long ago

  const BADGE_GLYPHS = { owner: "👑", staff: "⚡", admin: "⚡", moderator: "🛡", vip: "♦", subscriber: "♥" };
  const KIND_GLYPHS = { raid: "⚑ ", starfall: "✦ ", sub: "★ ", gift_sub: "★ " };

  let channelName = null;
  let streamId = null;
  let lastCreatedAt = null;
  let socket = null;
  let heartbeatTimer = null;
  let emoteTimer = null;
  let fetching = null;
  let refetchQueued = false;
  const seen = new Set();
  const signedUrls = {}; // storage path -> signed URL

  function headers(extra) {
    return Object.assign({ apikey: PUBLIC_KEY, Authorization: "Bearer " + PUBLIC_KEY }, extra || {});
  }

  async function rest(path) {
    const res = await fetch(PROJECT + path, { headers: headers() });
    if (!res.ok) throw new Error("HTTP " + res.status + " on " + path.split("?")[0]);
    return res.json();
  }

  // display-name is inserted as HTML by Chat.write, so it must be escaped here.
  // (The message body is escaped by Chat.write itself.)
  function escapeText(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function normalizeChannel(value) {
    let v = String(value || "").trim().replace(/\/+$/, "");
    if (v.includes("/")) v = v.split("/").pop();
    return v.toLowerCase();
  }

  function validColor(c) {
    return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c) ? c : undefined;
  }

  function chatIsStale(stream) {
    if (!stream || stream.status === "live") return false;
    const endRef = stream.ended_at || stream.started_at;
    return !!endRef && Date.now() > Date.parse(endRef) + STALE_AFTER_MS;
  }

  async function resolveChannel(name) {
    const profiles = await rest("/rest/v1/profiles?select=id&username=eq." + encodeURIComponent(name));
    if (!profiles.length) throw new Error('No existe el canal "' + name + '" en Starvios');
    const channelId = profiles[0].id;
    const streams = await rest(
      "/rest/v1/live_streams?select=id,status,chat_cleared_at,started_at,ended_at" +
      "&channel_id=eq." + channelId + "&order=started_at.desc"
    );
    return streams.find(function (s) { return s.status === "live"; }) || streams[0] || null;
  }

  async function fetchMessages(afterIso, sinceIso, limit) {
    let q = "/rest/v1/live_chat_messages?select=" + MESSAGE_SELECT +
            "&stream_id=eq." + streamId + "&is_deleted=eq.false";
    if (afterIso) q += "&created_at=gt." + encodeURIComponent(afterIso);
    else if (sinceIso) q += "&created_at=gte." + encodeURIComponent(sinceIso);
    q += "&order=created_at.desc&limit=" + limit;
    const list = await rest(q);
    return list.reverse(); // oldest first
  }

  // Emotes are written as :code: in the chat. Chat.write replaces them through Chat.info.emotes.
  async function loadEmotes() {
    const list = await rest("/rest/v1/channel_emotes?select=code,storage_path,is_animated&order=created_at");
    const paths = list.map(function (e) { return e.storage_path; }).filter(Boolean);
    if (paths.length) {
      // The media bucket is private: request signed URLs in one call, as the web does.
      const res = await fetch(PROJECT + "/storage/v1/object/sign/media", {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ expiresIn: EMOTE_URL_TTL, paths: paths }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status + " signing emotes");
      const signed = await res.json();
      signed.forEach(function (s) {
        if (s.path && s.signedURL) signedUrls[s.path] = PROJECT + "/storage/v1" + s.signedURL;
      });
    }
    const emotes = {};
    list.forEach(function (e) {
      const url = signedUrls[e.storage_path];
      if (url) emotes[":" + e.code + ":"] = { image: url };
    });
    Chat.info.emotes = emotes;
  }

  function toInfo(m) {
    const p = m.profiles || {};
    const glyphs = (Array.isArray(m.badges) ? m.badges : [])
      .map(function (b) { return BADGE_GLYPHS[b]; })
      .filter(Boolean);
    if (p.is_verified) glyphs.push("✔");

    let name = m.kind === "system" ? "Starvios" : (p.display_name || p.username || "—");
    let display = escapeText(name);
    if (glyphs.length) display = glyphs.join(" ") + " " + display;
    if (m.coins > 0) display += " ★ " + m.coins + " Starvies";

    return {
      id: m.id,
      "display-name": display,
      color: validColor(p.chat_color),
      "user-id": m.user_id || "",
      "tmi-sent-ts": String(Date.parse(m.created_at) || Date.now()),
    };
  }

  function writeMessage(m) {
    if (!m || m.is_deleted || seen.has(m.id)) return;
    seen.add(m.id);
    if (seen.size > SEEN_MAX) seen.clear();
    if (!lastCreatedAt || m.created_at > lastCreatedAt) lastCreatedAt = m.created_at;

    const p = m.profiles || {};
    const nick = m.kind === "system" ? "starvios" : (p.username || "starvios");
    // Raw text: Chat.write escapes the body itself.
    const icon = KIND_GLYPHS[m.kind] || "";
    const body = icon + (m.body || "");
    Chat.write(nick, toInfo(m), body, "starvios");
  }

  // Fetches messages newer than the last one shown. Calls are merged, so bursts cost one request.
  function fetchNew() {
    if (!streamId) return Promise.resolve();
    if (fetching) {
      refetchQueued = true;
      return fetching;
    }
    fetching = (async function () {
      try {
        const list = await fetchMessages(lastCreatedAt, null, 100);
        list.forEach(writeMessage);
      } catch (err) {
        console.warn("Starvios: could not fetch messages", err);
      } finally {
        fetching = null;
        if (refetchQueued) {
          refetchQueued = false;
          fetchNew();
        }
      }
    })();
    return fetching;
  }

  function handleChange(data) {
    if (!data) return;
    if (data.type === "INSERT") {
      // The realtime record has no profile, so fetch the new messages with their data.
      fetchNew();
    } else if (data.type === "UPDATE") {
      const rec = data.record || {};
      if (rec.is_deleted && rec.id) Chat.clearMessage(rec.id);
    } else if (data.type === "DELETE") {
      const old = data.old || {};
      if (old.id) Chat.clearMessage(old.id);
    }
  }

  function connectRealtime() {
    const url = PROJECT.replace("https://", "wss://") + "/realtime/v1/websocket?apikey=" + PUBLIC_KEY + "&vsn=1.0.0";
    socket = new ReconnectingWebSocket(url, null, { reconnectInterval: 2000 });

    socket.onopen = function () {
      socket.send(JSON.stringify({
        topic: "realtime:live-chat:" + streamId,
        event: "phx_join",
        ref: "1",
        payload: {
          config: {
            broadcast: { self: false },
            presence: { key: "" },
            postgres_changes: [{ event: "*", schema: "public", table: "live_chat_messages", filter: "stream_id=eq." + streamId }],
          },
          access_token: PUBLIC_KEY,
        },
      }));
      // Catch up on anything missed while disconnected.
      fetchNew();
      if (!heartbeatTimer) {
        heartbeatTimer = setInterval(function () {
          if (socket && socket.readyState === 1) {
            socket.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(Date.now()) }));
          }
        }, HEARTBEAT_MS);
      }
    };

    socket.onmessage = function (ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.event === "postgres_changes") handleChange(msg.payload && msg.payload.data);
    };

    socket.onclose = function () {
      console.log("Starvios: realtime disconnected, reconnecting...");
    };
  }

  function retryLater(channel, reason) {
    SendInfoText(reason + " · reintentando en 1 min");
    setTimeout(function () { start(channel); }, RETRY_MS);
  }

  async function start(channel) {
    channelName = normalizeChannel(channel);
    if (!channelName) {
      SendInfoText("Starvios: escribe tu usuario en la configuración");
      return;
    }
    SendInfoText("Conectando a Starvios: " + channelName);

    let stream;
    try {
      stream = await resolveChannel(channelName);
    } catch (err) {
      console.warn("Starvios:", err);
      return retryLater(channel, "Starvios: " + err.message);
    }
    if (!stream || !stream.id) {
      return retryLater(channel, "Starvios: " + channelName + " no está en directo");
    }

    streamId = stream.id;
    const since = stream.chat_cleared_at || null;
    const stale = chatIsStale(stream);

    try {
      await loadEmotes();
    } catch (err) {
      console.warn("Starvios: could not load emotes", err);
    }
    if (!emoteTimer) {
      emoteTimer = setInterval(function () {
        loadEmotes().catch(function (err) { console.warn("Starvios: emote refresh failed", err); });
      }, EMOTE_REFRESH_MS);
    }

    try {
      if (!stale) {
        const history = await fetchMessages(null, since, HISTORY_LIMIT);
        history.forEach(writeMessage);
      }
    } catch (err) {
      console.warn("Starvios: could not load history", err);
      return retryLater(channel, "Starvios: error al cargar el chat");
    }

    // Anything newer than this is "new": use the stream's own timestamps, not the client clock.
    lastCreatedAt = lastCreatedAt || since || stream.ended_at || stream.started_at || null;

    connectRealtime();
    SendInfoText("Conectado a Starvios: " + channelName);
  }

  window.StarviosSource = { start: start };
})();
