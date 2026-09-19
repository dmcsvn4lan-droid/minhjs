// Deno Deploy - Fshare Media Center & Stream Proxy
// Đọc biến môi trường an toàn từ Deno.env
const FSHARE_EMAIL = Deno.env.get("FSHARE_EMAIL") || "";
const FSHARE_PASSWORD = Deno.env.get("FSHARE_PASSWORD") || "";
const FSHARE_APP_KEY = Deno.env.get("FSHARE_APP_KEY") || "";
const FSHARE_USER_AGENT = Deno.env.get("FSHARE_USER_AGENT") || "Rclone-7M98X6";

const LOGIN_URL = "https://api.fshare.vn/api/user/login";
const DOWNLOAD_URL = "https://api.fshare.vn/api/session/download";

// In-memory cache cho Token
let cachedToken = null;
let cachedSessionId = null;
let tokenExpiry = 0;

async function getFshareSession() {
  const now = Date.now();
  if (cachedToken && cachedSessionId && now < tokenExpiry) {
    return { token: cachedToken, sessionId: cachedSessionId };
  }

  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": FSHARE_USER_AGENT,
    },
    body: JSON.stringify({
      user_email: FSHARE_EMAIL,
      password: FSHARE_PASSWORD,
      app_key: FSHARE_APP_KEY,
    }),
  });

  const data = await res.json();
  if (!res.ok || data.code !== 200) {
    throw new Error(data.msg || "Đăng nhập Fshare thất bại. Kiểm tra lại thông tin tài khoản!");
  }

  cachedToken = data.token;
  cachedSessionId = data.session_id;
  tokenExpiry = now + 45 * 60 * 1000; // Cache 45 phút
  return { token: cachedToken, sessionId: cachedSessionId };
}

function extractLinkCode(url) {
  const match = url.match(/(?:folder|file)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // --- XỬ LÝ BACKEND API (POST) ---
  if (req.method === "POST") {
    try {
      const { action, targetUrl, filePassword } = await req.json();
      const { token, sessionId } = await getFshareSession();

      // 1. Quét danh mục Folder
      if (action === "list_folder") {
        const linkcode = extractLinkCode(targetUrl);
        if (!linkcode) throw new Error("Link folder không đúng định dạng!");

        const listRes = await fetch(
          `https://www.fshare.vn/api/v3/files/folder?linkcode=${linkcode}&page=1&per-page=150`,
          {
            headers: {
              "User-Agent": FSHARE_USER_AGENT,
              "Cookie": `session_id=${sessionId}`,
              "Authorization": `Bearer ${token}`,
            },
          }
        );

        const listData = await listRes.json();
        const rawItems = listData.items || listData.data || listData || [];
        const mediaExts = [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".mp3", ".flac"];

        const folders = [];
        const files = [];

        for (const item of rawItems) {
          const isFolder = item.type === 1 || item.type === "1" || item.is_folder === true;
          const name = item.name || "Không tên";
          const code = item.linkcode || item.code;
          const size = item.size ? `${(item.size / (1024 * 1024 * 1024)).toFixed(2)} GB` : "";

          if (isFolder) {
            folders.push({ id: code, name, url: `https://www.fshare.vn/folder/${code}` });
          } else {
            files.push({
              id: code,
              name,
              size,
              isMedia: mediaExts.some((ext) => name.toLowerCase().endsWith(ext)),
              url: `https://www.fshare.vn/file/${code}`,
            });
          }
        }

        return new Response(JSON.stringify({ success: true, folders, files }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 2. Lấy Direct VIP link để Stream
      if (action === "get_stream") {
        const dlRes = await fetch(DOWNLOAD_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": FSHARE_USER_AGENT,
            "Cookie": `session_id=${sessionId}`,
          },
          body: JSON.stringify({
            url: targetUrl,
            password: filePassword || "",
            token: token,
          }),
        });

        const dlData = await dlRes.json();
        if (!dlRes.ok || !dlData.location) {
          cachedToken = null; // Huỷ cache nếu có sự cố
          throw new Error(dlData.msg || "Không thể lấy link direct VIP");
        }

        return new Response(JSON.stringify({ success: true, streamUrl: dlData.location }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      throw new Error("Hành động không hợp lệ");
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // --- PHỤC VỤ GIAO DIỆN HTML (GET) ---
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Fshare Deno Media Player</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/artplayer/dist/artplayer.js"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col p-3 sm:p-5">
  <div class="max-w-7xl w-full mx-auto space-y-3 flex-1 flex flex-col">
    <!-- Header -->
    <header class="flex justify-between items-center pb-2 border-b border-slate-800">
      <div class="flex items-center gap-2">
        <span class="text-xl">🦕</span>
        <h1 class="text-lg sm:text-xl font-bold text-sky-400">Fshare Media Center (Deno)</h1>
      </div>
      <span id="status" class="text-xs px-2.5 py-1 rounded bg-slate-900 border border-slate-700 text-amber-400 hidden"></span>
    </header>

    <!-- Search Input -->
    <div class="flex flex-col sm:flex-row gap-2 bg-slate-900 p-2.5 rounded-xl border border-slate-800">
      <input
        id="inputUrl"
        type="url"
        placeholder="Dán link Folder Fshare (vd: https://www.fshare.vn/folder/...)"
        class="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500"
      />
      <button
        id="btnOpen"
        class="bg-sky-500 hover:bg-sky-600 active:scale-95 px-5 py-2 rounded-lg font-medium text-sm transition"
      >
        Mở Folder
      </button>
    </div>

    <!-- Explorer & Video Player Layout -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-3 flex-1">
      <!-- Cột danh sách (5 cột) -->
      <div class="lg:col-span-5 bg-slate-900 rounded-xl border border-slate-800 p-3 flex flex-col h-[550px] sm:h-[650px]">
        <div id="breadcrumbs" class="text-xs text-slate-400 flex items-center gap-1 overflow-x-auto pb-2 border-b border-slate-800 mb-2">
          <span class="text-slate-500">Root</span>
        </div>
        <div id="itemList" class="overflow-y-auto flex-1 space-y-1 text-sm pr-1">
          <div class="text-slate-500 text-center py-16">Dán link folder và bấm 'Mở Folder' để xem danh sách tập tin</div>
        </div>
      </div>

      <!-- Cột Trình phát Video (7 cột) -->
      <div class="lg:col-span-7 flex flex-col gap-2">
        <div class="w-full aspect-video bg-black rounded-xl overflow-hidden border border-slate-800 shadow-2xl">
          <div id="player" class="w-full h-full"></div>
        </div>
        <div id="nowPlaying" class="p-2.5 bg-slate-900 rounded-xl border border-slate-800 text-xs text-slate-300 truncate">
          <span class="text-slate-500">Đang phát:</span> Chưa chọn video.
        </div>
      </div>
    </div>
  </div>

  <script>
    const art = new Artplayer({
      container: '#player',
      url: '',
      autoplay: true,
      playbackRate: true,
      fullscreen: true,
      pip: true,
      setting: true,
      theme: '#38bdf8'
    });

    const statusEl = document.getElementById('status');
    const listEl = document.getElementById('itemList');
    const breadcrumbs = document.getElementById('breadcrumbs');
    const nowPlaying = document.getElementById('nowPlaying');
    const btnOpen = document.getElementById('btnOpen');
    const inputUrl = document.getElementById('inputUrl');

    let historyStack = [];

    function notify(msg, isError = false) {
      statusEl.textContent = msg;
      statusEl.className = 'text-xs px-2.5 py-1 rounded border ' + (isError ? 'bg-rose-950/60 border-rose-800 text-rose-300' : 'bg-slate-900 border-slate-700 text-amber-400');
      statusEl.classList.remove('hidden');
    }

    async function req(action, targetUrl) {
      const res = await fetch(window.location.pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, targetUrl })
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Thao tác thất bại');
      return data;
    }

    async function loadFolder(url, folderName = 'Root') {
      notify('Đang quét thư mục...');
      btnOpen.disabled = true;

      try {
        const data = await req('list_folder', url);
        updateBreadcrumbs(url, folderName);
        listEl.innerHTML = '';

        if (data.folders.length === 0 && data.files.length === 0) {
          listEl.innerHTML = '<div class="text-slate-500 text-center py-10">Thư mục trống</div>';
          return;
        }

        data.folders.forEach(f => {
          const div = document.createElement('div');
          div.className = 'flex items-center gap-2 p-2 hover:bg-slate-800 rounded-lg cursor-pointer text-amber-300 transition';
          div.innerHTML = '<span class="text-base">📁</span><span class="truncate text-slate-200 font-medium">' + f.name + '</span>';
          div.onclick = () => loadFolder(f.url, f.name);
          listEl.appendChild(div);
        });

        data.files.forEach(f => {
          const div = document.createElement('div');
          div.className = 'flex items-center justify-between gap-2 p-2 rounded-lg cursor-pointer transition ' + (f.isMedia ? 'hover:bg-slate-800 text-slate-200' : 'opacity-40 cursor-not-allowed text-slate-400');
          div.innerHTML = '<div class="flex items-center gap-2 truncate flex-1"><span>' + (f.isMedia ? '🎬' : '📄') + '</span><span class="truncate">' + f.name + '</span></div><span class="text-[11px] text-slate-500 shrink-0 font-mono">' + f.size + '</span>';
          if (f.isMedia) {
            div.onclick = () => playFile(f.url, f.name);
          }
          listEl.appendChild(div);
        });

        statusEl.classList.add('hidden');
      } catch (e) {
        notify(e.message, true);
      } finally {
        btnOpen.disabled = false;
      }
    }

    function updateBreadcrumbs(url, name) {
      const idx = historyStack.findIndex(x => x.url === url);
      if (idx !== -1) {
        historyStack = historyStack.slice(0, idx + 1);
      } else {
        historyStack.push({ name, url });
      }

      breadcrumbs.innerHTML = historyStack
        .map((item, i) => '<button onclick="loadFolder(\\'' + item.url + '\\', \\'' + item.name + '\\')" class="hover:text-sky-400 truncate max-w-[120px] ' + (i === historyStack.length - 1 ? 'text-sky-400 font-bold' : '') + '">' + item.name + '</button>' + (i < historyStack.length - 1 ? '<span class="text-slate-600">/</span>' : ''))
        .join('');
    }

    async function playFile(url, name) {
      notify('Đang lấy link VIP: ' + name + '...');
      try {
        const data = await req('get_stream', url);
        nowPlaying.innerHTML = '<span class="text-sky-400 font-medium">Đang phát:</span> ' + name;
        art.switchUrl(data.streamUrl);
        statusEl.classList.add('hidden');
      } catch (e) {
        notify(e.message, true);
      }
    }

    btnOpen.onclick = () => {
      const u = inputUrl.value.trim();
      if (u) {
        historyStack = [];
        loadFolder(u, 'Gốc');
      }
    };
  <\/script>
</body>
</html>`;

  return new Response(html, {
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
});
