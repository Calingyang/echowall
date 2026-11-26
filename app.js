/* =========================================================
   私享播放器 — 只播不存
   音频以 .dat 密文分片存放，浏览器内存内解密为 Blob 播放
   ========================================================= */
(() => {
  "use strict";

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const el = {
    stage: $("#stage"), list: $("#list"), count: $("#count"), search: $("#search"),
    title: $("#title"), artist: $("#artist"), status: $("#statusText"), eyebrow: $(".eyebrow"),
    wave: $("#wave"), waveWrap: $("#waveWrap"), cursor: $("#cursor"), tip: $("#tip"),
    cur: $("#cur"), dur: $("#dur"), play: $("#play"), prev: $("#prev"), next: $("#next"),
    shuffle: $("#shuffle"), repeat: $("#repeat"), vol: $("#vol"), volBtn: $("#volBtn"), volWave: $("#volWave"),
    disc: $("#disc"), labelMark: $("#labelMark"), meta: $(".meta"),
    siteTitle: $("#siteTitle"), siteSub: $("#siteSub"), toPill: $("#toPill"),
    share: $("#shareBtn"), wm: $("#wm"), toast: $("#toast"),
    modal: $("#modal"), modalX: $("#modalX"), modalOk: $("#modalOk"), noteBtn: $("#noteBtn"),
    footNote: $("#footNote"),
  };

  const audio = new Audio();
  audio.preload = "auto";
  audio.volume = 0.85;

  const state = {
    songs: [], view: [], cur: -1, playing: false, seeking: false,
    shuffle: false, repeat: "all", peaks: new Map(), blobs: new Map(), raw: new Map(),
    url: null, loading: false, rendered: 0, tag: "",
  };

  /* ---------------- 工具 ---------------- */
  const fmt = (t) => {
    if (!isFinite(t) || t < 0) return "0:00";
    t = Math.floor(t);
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  };
  const hash32 = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  const hex2bytes = (hex) => {
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  };
  let toastTimer = 0;
  const toast = (msg, ms = 2600) => {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  };

  /* ---------------- 会话标记（水印 / 分享页脚） ---------------- */
  function initTag() {
    const u = new URLSearchParams(location.search).get("u");
    const guest = u ? decodeURIComponent(u).slice(0, 14) : "";
    const fp = hash32(navigator.userAgent + screen.width + screen.height + new Date().getTimezoneOffset())
      .toString(36).slice(-4).toUpperCase();
    state.tag = (guest ? guest + " · " : "") + "#" + fp;
    el.wm.textContent = "仅限收听 · " + state.tag;
    if (guest) {
      el.toPill.hidden = false;
      el.toPill.textContent = "专为 " + guest + " 播放";
    }
  }

  function driftWatermark() {
    el.wm.style.left = (6 + Math.random() * 70) + "%";
    el.wm.style.top = (8 + Math.random() * 72) + "%";
  }

  /* ---------------- 音频解密 ---------------- */
  function decrypt(bytes, keyHex) {
    const k = hex2bytes(keyHex);
    const kl = k.length;
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= k[i % kl];
    return bytes;
  }

  async function fetchSong(song) {
    if (state.blobs.has(song.id)) return state.blobs.get(song.id);
    const res = await fetch(song.file, { cache: "no-store", credentials: "omit" });
    if (!res.ok) throw new Error("音频加载失败（" + res.status + "）");
    const raw = new Uint8Array(await res.arrayBuffer());
    decrypt(raw, song.key);
    if (state.raw.size >= 3) state.raw.delete(state.raw.keys().next().value);
    state.raw.set(song.id, raw);
    const url = URL.createObjectURL(new Blob([raw], { type: "audio/mpeg" }));
    if (state.blobs.size >= 3) {
      const oldest = state.blobs.keys().next().value;
      URL.revokeObjectURL(state.blobs.get(oldest));
      state.blobs.delete(oldest);
    }
    state.blobs.set(song.id, url);
    return url;
  }

  /* ---------------- 波形 ---------------- */
  const BARS = 118;
  async function peaksFor(song) {
    if (state.peaks.has(song.id)) return state.peaks.get(song.id);
    let peaks = null;
    try {
      let bytes = state.raw.get(song.id);
      if (!bytes) {
        bytes = new Uint8Array(await (await fetch(song.file)).arrayBuffer());
        decrypt(bytes, song.key);
        state.raw.set(song.id, bytes);
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const audioBuf = await ctx.decodeAudioData(bytes.slice(0).buffer);
      const data = audioBuf.getChannelData(0);
      const step = Math.floor(data.length / BARS) || 1;
      const acc = new Float32Array(BARS);
      for (let i = 0; i < BARS; i++) {
        let sum = 0, n = 0;
        for (let j = i * step; j < (i + 1) * step; j += 24) { const v = data[j] || 0; sum += v * v; n++; }
        acc[i] = Math.sqrt(sum / Math.max(1, n));
      }
      const max = Math.max(...acc) || 1;
      peaks = Array.from(acc, (v) => Math.max(0.08, Math.min(1, v / max)));
      ctx.close();
    } catch (_) {
      peaks = Array.from({ length: BARS }, (_, i) => {
        const v = Math.sin((i * 1.7 + hash32(song.id) % 40) * 0.9) * 0.5 + 0.5;
        return 0.12 + v * 0.75;
      });
    }
    state.peaks.set(song.id, peaks);
    return peaks;
  }

  async function drawWave(song) {
    const peaks = await peaksFor(song);
    if (!song || state.songs[state.cur] !== song) return;
    el.wave.innerHTML = peaks.map((p) => `<i style="height:${(p * 100).toFixed(1)}%"></i>`).join("");
    state.rendered = 0;
  }

  function paintProgress() {
    const bars = el.wave.children;
    if (!bars.length) return;
    const d = audio.duration || 0;
    const ratio = d ? Math.min(1, audio.currentTime / d) : 0;
    const upto = Math.round(ratio * bars.length);
    if (upto !== state.rendered) {
      const lo = Math.min(upto, state.rendered), hi = Math.max(upto, state.rendered);
      for (let i = lo; i < hi; i++) bars[i].classList.toggle("played", i < upto);
      state.rendered = upto;
    }
    el.cursor.style.left = (ratio * 100) + "%";
    el.cur.textContent = fmt(audio.currentTime);
    el.waveWrap.setAttribute("aria-valuenow", Math.round(ratio * 100));
  }

  /* ---------------- 渲染曲库 ---------------- */
  function renderList() {
    const q = el.search.value.trim().toLowerCase();
    state.view = state.songs.filter((s) =>
      !q || (s.title + " " + (s.artist || "")).toLowerCase().includes(q));
    el.count.textContent = state.songs.length + " 首";
    if (!state.view.length) {
      el.list.innerHTML = `<li class="empty" style="height:90px">${state.songs.length ? "没有匹配的曲目" : "曲库还是空的"}</li>`;
      return;
    }
    el.list.innerHTML = state.view.map((s) => {
      const i = state.songs.indexOf(s);
      const on = i === state.cur;
      return `<li class="row${on ? " on" : ""}${on && state.playing ? " playing" : ""}" role="option"
        tabindex="0" data-i="${i}" aria-selected="${on}">
        <span class="row-idx">${String(i + 1).padStart(2, "0")}</span>
        <span class="row-txt">
          <span class="row-title">${esc(s.title)}</span>
          <span class="row-sub">${esc(s.artist || "未知艺人")}</span>
        </span>
        <span class="bars"><i></i><i></i><i></i></span>
        <span class="row-dur">${fmt(s.duration)}</span>
      </li>`;
    }).join("");
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function markRow() {
    $$(".row", el.list).forEach((r) => {
      const on = +r.dataset.i === state.cur;
      r.classList.toggle("on", on);
      r.classList.toggle("playing", on && state.playing);
      r.setAttribute("aria-selected", String(on));
    });
    const active = el.list.querySelector(".row.on");
    if (active && state.view.length > 12) active.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  /* ---------------- 切歌 ---------------- */
  async function select(i, autoplay = true) {
    if (i < 0 || i >= state.songs.length) return;
    const song = state.songs[i];
    state.cur = i;
    state.loading = true;
    el.title.textContent = song.title;
    el.artist.textContent = song.artist || "未知艺人";
    el.dur.textContent = fmt(song.duration);
    el.status.textContent = "正在解密";
    el.eyebrow.classList.add("busy");
    el.labelMark.textContent = (song.title || "♪").trim().slice(0, 1);
    document.documentElement.style.setProperty("--hue", (hash32(song.id) % 360).toFixed(0));
    markRow();
    el.wave.innerHTML = Array.from({ length: BARS }, (_, k) => `<i style="height:${(10 + (Math.sin(k * 0.6) + 1) * 12).toFixed(0)}%"></i>`).join("");

    try {
      const url = await fetchSong(song);
      if (state.cur !== i) return;
      state.url = url;
      audio.src = url;
      audio.load();
      el.status.textContent = "已就绪";
      setMediaSession(song);
      drawWave(song);
      state.loading = false;
      el.eyebrow.classList.remove("busy");
      if (autoplay) play();
      prefetchNext(i);
    } catch (err) {
      state.loading = false;
      el.eyebrow.classList.remove("busy");
      el.status.textContent = "加载失败";
      toast(err.message || "音频加载失败");
    }
  }

  function prefetchNext(i) {
    const nxt = i + 1;
    if (nxt >= state.songs.length || state.blobs.has(state.songs[nxt].id)) return;
    setTimeout(() => { fetchSong(state.songs[nxt]).catch(() => {}); }, 2500);
  }

  function play() {
    if (state.cur < 0) { if (state.songs.length) select(0, true); return; }
    audio.play().then(() => {
      state.playing = true;
      el.play.classList.add("playing");
      el.play.setAttribute("aria-label", "暂停");
      el.disc.classList.add("spin");
      el.status.textContent = "正在播放";
      el.eyebrow.classList.add("busy");
      markRow();
    }).catch((e) => {
      toast("浏览器阻止了自动播放，请再点一次播放键");
      state.playing = false;
    });
  }
  function pause() {
    audio.pause();
    state.playing = false;
    el.play.classList.remove("playing");
    el.play.setAttribute("aria-label", "播放");
    el.disc.classList.remove("spin");
    el.status.textContent = "已暂停";
    el.eyebrow.classList.remove("busy");
    markRow();
  }
  function toggle() { state.playing ? pause() : play(); }

  function next(auto = false) {
    if (!state.songs.length) return;
    if (state.repeat === "one" && auto) { audio.currentTime = 0; play(); return; }
    let i;
    if (state.shuffle) {
      do { i = Math.floor(Math.random() * state.songs.length); } while (state.songs.length > 1 && i === state.cur);
    } else {
      i = state.cur + 1;
      if (i >= state.songs.length) {
        if (state.repeat === "none" || (auto && state.repeat !== "all")) { pause(); return; }
        i = 0;
      }
    }
    select(i, true);
  }
  function prev() {
    if (!state.songs.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    let i = state.cur - 1;
    if (i < 0) i = state.songs.length - 1;
    select(i, true);
  }

  function setMediaSession(song) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title, artist: song.artist || "未知艺人", album: el.siteTitle.textContent,
      });
      const h = {
        play: () => play(), pause: () => pause(),
        previoustrack: () => prev(), nexttrack: () => next(),
        seekto: (d) => { if (isFinite(d.seekTime)) audio.currentTime = d.seekTime; },
      };
      for (const k in h) { try { navigator.mediaSession.setActionHandler(k, h[k]); } catch (_) {} }
    } catch (_) {}
  }

  /* ---------------- 进度条交互 ---------------- */
  const ratioAt = (clientX) => {
    const r = el.waveWrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  function seekTo(r) {
    if (!isFinite(audio.duration) || !audio.duration) return;
    audio.currentTime = r * audio.duration;
    paintProgress();
  }
  el.waveWrap.addEventListener("pointerdown", (e) => {
    state.seeking = true;
    el.waveWrap.classList.add("seeking");
    el.waveWrap.setPointerCapture?.(e.pointerId);
    seekTo(ratioAt(e.clientX));
    el.tip.hidden = false;
    el.tip.style.left = (ratioAt(e.clientX) * 100) + "%";
    el.tip.textContent = fmt((audio.duration || 0) * ratioAt(e.clientX));
  });
  el.waveWrap.addEventListener("pointermove", (e) => {
    const r = ratioAt(e.clientX);
    el.tip.style.left = (r * 100) + "%";
    el.tip.textContent = fmt((audio.duration || 0) * r);
    el.cursor.style.left = (r * 100) + "%";
    if (state.seeking) seekTo(r);
  });
  const endSeek = () => {
    if (!state.seeking) return;
    state.seeking = false;
    el.waveWrap.classList.remove("seeking");
    el.tip.hidden = true;
  };
  el.waveWrap.addEventListener("pointerup", endSeek);
  el.waveWrap.addEventListener("pointercancel", endSeek);
  el.waveWrap.addEventListener("pointerleave", () => { if (!state.seeking) { el.tip.hidden = true; } });
  el.waveWrap.addEventListener("keydown", (e) => {
    if (!isFinite(audio.duration)) return;
    if (e.key === "ArrowRight") { e.preventDefault(); audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); }
    if (e.key === "ArrowLeft") { e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime - 5); }
  });

  /* ---------------- 音频事件 ---------------- */
  audio.addEventListener("timeupdate", paintProgress);
  audio.addEventListener("durationchange", () => { el.dur.textContent = fmt(audio.duration); });
  audio.addEventListener("loadedmetadata", () => { el.dur.textContent = fmt(audio.duration); paintProgress(); });
  audio.addEventListener("ended", () => { state.playing = false; next(true); });
  audio.addEventListener("waiting", () => { el.status.textContent = "缓冲中"; el.eyebrow.classList.add("busy"); });
  audio.addEventListener("playing", () => {
    el.status.textContent = "正在播放";
    state.playing = true;
    el.play.classList.add("playing");
    el.disc.classList.add("spin");
    el.eyebrow.classList.add("busy");
    markRow();
  });
  audio.addEventListener("error", () => {
    if (!audio.src) return;
    el.status.textContent = "解码失败";
    el.eyebrow.classList.remove("busy");
  });

  /* ---------------- 其它控件 ---------------- */
  el.play.addEventListener("click", toggle);
  el.next.addEventListener("click", () => next());
  el.prev.addEventListener("click", prev);
  el.shuffle.addEventListener("click", () => {
    state.shuffle = !state.shuffle;
    el.shuffle.classList.toggle("on", state.shuffle);
    el.shuffle.setAttribute("aria-pressed", String(state.shuffle));
    toast(state.shuffle ? "随机播放：开" : "随机播放：关");
  });
  el.repeat.addEventListener("click", () => {
    state.repeat = state.repeat === "all" ? "one" : state.repeat === "one" ? "none" : "all";
    el.repeat.classList.toggle("on", state.repeat !== "none");
    el.repeat.setAttribute("aria-pressed", String(state.repeat !== "none"));
    toast({ all: "列表循环", one: "单曲循环", none: "不循环" }[state.repeat]);
  });

  const setVol = (v) => {
    audio.volume = v;
    el.vol.value = v;
    el.vol.style.setProperty("--v", (v * 100) + "%");
    el.volBtn.classList.toggle("muted", v === 0);
    el.volWave.style.opacity = v === 0 ? 0.15 : 1;
  };
  el.vol.addEventListener("input", () => setVol(+el.vol.value));
  el.volBtn.addEventListener("click", () => setVol(audio.volume > 0 ? 0 : 0.85));

  el.search.addEventListener("input", renderList);

  let hoverTimer = 0;
  el.list.addEventListener("mouseover", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    const song = state.songs[+row.dataset.i];
    if (!song || state.blobs.has(song.id)) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => fetchSong(song).catch(() => {}), 260);
  });

  el.list.addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (row) select(+row.dataset.i, true);
  });
  el.list.addEventListener("keydown", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(+row.dataset.i, true); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = $$(".row", el.list);
      const k = rows.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1);
      if (rows[k]) rows[k].focus();
    }
  });

  el.share.addEventListener("click", async () => {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast("链接已复制，发给对方即可收听");
    } catch (_) {
      window.prompt("复制这个链接发给对方：", url);
    }
  });

  const openModal = () => { el.modal.hidden = false; };
  const closeModal = () => { el.modal.hidden = true; };
  el.noteBtn.addEventListener("click", openModal);
  el.modalX.addEventListener("click", closeModal);
  el.modalOk.addEventListener("click", closeModal);
  el.modal.addEventListener("click", (e) => { if (e.target === el.modal) closeModal(); });

  /* ---------------- 防护层 ---------------- */
  function installGuards() {
    document.addEventListener("contextmenu", (e) => {
      if (e.target.closest(".modal")) return;
      e.preventDefault();
      toast("此页面不提供「另存为」", 1800);
    }, { capture: true });

    document.addEventListener("dragstart", (e) => e.preventDefault());
    document.addEventListener("selectstart", (e) => {
      if (!e.target.closest("input,.modal")) e.preventDefault();
    });

    document.addEventListener("keydown", (e) => {
      const meta = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (meta && (k === "s" || k === "u" || (k === "a" && !e.target.closest("input")))) {
        e.preventDefault();
        toast("此页面不支持保存 / 下载");
        return;
      }
      if (meta && e.shiftKey && ["3", "4", "5"].includes(e.key)) {
        flashCapture();
        return;
      }
      if (e.key === "PrintScreen") { flashCapture(); }
      if (e.target.closest("input")) return;
      if (e.key === " ") { e.preventDefault(); toggle(); }
      if (e.key === "ArrowRight" && !e.target.closest("[role=slider]")) {
        if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
      }
      if (e.key === "ArrowLeft" && !e.target.closest("[role=slider]")) {
        if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 5);
      }
      if (e.key.toLowerCase() === "m") setVol(audio.volume > 0 ? 0 : 0.85);
    });

    let flashTimer = 0;
    window.flashCapture = () => {
      document.body.classList.add("capture");
      toast("检测到截屏操作 · 画面已临时模糊并写入水印 " + state.tag, 2400);
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => document.body.classList.remove("capture"), 1200);
    };
    window.addEventListener("blur", () => clearTimeout(flashTimer));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && state.playing) pause();
    });
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    initTag();
    installGuards();
    driftWatermark();
    setInterval(driftWatermark, 11000);
    setVol(0.85);
    renderList();

    try {
      const m = await (await fetch("manifest.json", { cache: "no-store" })).json();
      state.songs = (m.songs || []).slice();
      if (m.site) {
        if (m.site.title) { el.siteTitle.textContent = m.site.title; document.title = m.site.title + " · 只播不存"; }
        if (m.site.subtitle) el.siteSub.textContent = m.site.subtitle;
        if (m.site.note) el.footNote.textContent = m.site.note;
      }
      state.songs.sort((a, b) => (b.added || "").localeCompare(a.added || ""));
      renderList();
      if (state.songs.length) {
        el.title.textContent = state.songs[0].title;
        el.artist.textContent = state.songs[0].artist || "未知艺人";
        el.dur.textContent = fmt(state.songs[0].duration);
        el.labelMark.textContent = (state.songs[0].title || "♪").trim().slice(0, 1);
        document.documentElement.style.setProperty("--hue", (hash32(state.songs[0].id) % 360).toFixed(0));
        await drawWave(state.songs[0]);
        if (state.cur < 0) el.status.textContent = "点击播放";
      } else {
        el.status.textContent = "曲库为空";
        el.title.textContent = "还没有曲目";
        el.artist.textContent = "用 studio 上传第一首 MP3";
      }
    } catch (err) {
      el.status.textContent = "清单加载失败";
      toast("无法读取 manifest.json");
    }
  }

  boot();
})();
