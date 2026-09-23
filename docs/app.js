(function () {
  "use strict";

  var DEFAULT_API =
    (window.CPS_DEFAULT_API_BASE ||
      "https://crypto-pump-screener.jakahome2.workers.dev").replace(/\/$/, "");

  function apiBase() {
    try {
      var q = new URLSearchParams(location.search).get("api");
      if (q) return String(q).replace(/\/$/, "");
    } catch (e) {}
    try {
      var saved = localStorage.getItem("cps_api_base");
      if (saved) return saved.replace(/\/$/, "");
    } catch (e2) {}
    return DEFAULT_API;
  }

  var state = {
    rows: [],
    updatedAt: null,
    meta: null,
    error: null,
  };

  var el = {
    tbody: document.getElementById("tbody"),
    status: document.getElementById("status"),
    banner: document.getElementById("banner"),
    updated: document.getElementById("updated"),
    apiLabel: document.getElementById("apiLabel"),
    mode: document.getElementById("mode"),
    minVol: document.getElementById("minVol"),
    minScore: document.getElementById("minScore"),
    nowOnly: document.getElementById("nowOnly"),
    refreshBtn: document.getElementById("refreshBtn"),
    workersLink: document.getElementById("workersLink"),
  };

  el.apiLabel.textContent = apiBase();
  el.workersLink.href = apiBase() + "/";

  function fmtPct(n) {
    if (n == null || !isFinite(n)) return "—";
    var s = (n >= 0 ? "+" : "") + Number(n).toFixed(2) + "%";
    return s;
  }
  function fmtPrice(n) {
    if (n == null || !isFinite(n)) return "—";
    var x = Number(n);
    if (x >= 1000) return x.toFixed(2);
    if (x >= 1) return x.toFixed(4);
    if (x >= 0.01) return x.toFixed(5);
    return x.toPrecision(4);
  }
  function fmtVol(n) {
    if (n == null || !isFinite(n)) return "—";
    var x = Number(n);
    if (x >= 1e9) return (x / 1e9).toFixed(2) + "B";
    if (x >= 1e6) return (x / 1e6).toFixed(2) + "M";
    if (x >= 1e3) return (x / 1e3).toFixed(1) + "K";
    return String(Math.round(x));
  }
  function fmtFunding(n) {
    if (n == null || !isFinite(n)) return "—";
    return (Number(n) * 100).toFixed(4) + "%";
  }
  function bangkok(iso) {
    try {
      return new Date(iso).toLocaleString("th-TH", {
        timeZone: "Asia/Bangkok",
        hour12: false,
      }) + " ICT";
    } catch (e) {
      return iso || "—";
    }
  }

  function scoreOf(row, mode) {
    return mode === "short" ? Number(row.shortScore || 0) : Number(row.score || 0);
  }
  function isNow(u) {
    return u === "now_long" || u === "now_short";
  }

  function filtered() {
    var mode = el.mode.value;
    var minVol = Number(el.minVol.value) || 0;
    var minScore = Number(el.minScore.value) || 0;
    var nowOnly = el.nowOnly.checked;
    return state.rows
      .filter(function (r) {
        if (Number(r.quoteVolume || 0) < minVol) return false;
        if (scoreOf(r, mode) < minScore) return false;
        if (nowOnly && !isNow(r.urgency)) return false;
        if (mode === "long" && Number(r.score || 0) <= 0) return false;
        if (mode === "short" && Number(r.shortScore || 0) <= 0) return false;
        return true;
      })
      .sort(function (a, b) {
        return scoreOf(b, mode) - scoreOf(a, mode);
      })
      .slice(0, 120);
  }

  function showBanner(text, kind) {
    if (!text) {
      el.banner.className = "banner hidden";
      el.banner.textContent = "";
      return;
    }
    el.banner.className = "banner " + (kind || "");
    el.banner.textContent = text;
  }

  function render() {
    var mode = el.mode.value;
    var rows = filtered();
    if (!rows.length) {
      el.tbody.innerHTML =
        '<tr><td colspan="9" class="muted">ไม่มีแถวตามตัวกรอง (หรือ API ว่าง)</td></tr>';
    } else {
      el.tbody.innerHTML = rows
        .map(function (r, i) {
          var sc = scoreOf(r, mode);
          var pct = Number(r.priceChangePercent || 0);
          var urg = r.urgencyLabelTh || r.urgency || "—";
          var badgeClass = isNow(r.urgency) ? "now" : "wait";
          return (
            "<tr>" +
            "<td>" +
            (i + 1) +
            "</td>" +
            "<td><strong>" +
            (r.symbol || "") +
            "</strong></td>" +
            "<td>" +
            sc +
            "</td>" +
            '<td class="' +
            (pct >= 0 ? "pos" : "neg") +
            '">' +
            fmtPct(pct) +
            "</td>" +
            "<td>" +
            fmtPrice(r.price) +
            "</td>" +
            "<td>" +
            fmtVol(r.quoteVolume) +
            "</td>" +
            "<td>" +
            fmtFunding(r.lastFundingRate) +
            "</td>" +
            '<td><span class="badge ' +
            badgeClass +
            '">' +
            urg +
            "</span></td>" +
            "<td>" +
            (mode === "short"
              ? r.shortQualityGrade || r.qualityGrade || "—"
              : r.qualityGrade || "—") +
            "</td>" +
            "</tr>"
          );
        })
        .join("");
    }
    el.updated.textContent = state.updatedAt
      ? "อัปเดต: " + bangkok(state.updatedAt) + " · แสดง " + rows.length + "/" + state.rows.length
      : "";
  }

  async function load() {
    var base = apiBase();
    el.apiLabel.textContent = base;
    el.status.textContent = "กำลังโหลด…";
    showBanner("", "");
    try {
      var res = await fetch(base + "/api/screen?oiTop=0", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      var via = res.headers.get("X-Upstream-Via") || "";
      var stale = res.headers.get("X-Screen-Stale") === "1";
      if (!res.ok) {
        var errBody = await res.json().catch(function () {
          return {};
        });
        throw new Error(
          (errBody && (errBody.error || errBody.meta && errBody.meta.reason)) ||
            "HTTP " + res.status
        );
      }
      var json = await res.json();
      state.rows = Array.isArray(json.rows) ? json.rows : [];
      state.updatedAt = json.updatedAt || null;
      state.meta = json.meta || null;
      state.error = null;
      el.status.textContent =
        "OK · " +
        state.rows.length +
        " rows" +
        (via ? " · " + via : "") +
        (stale ? " · stale" : "");
      if (!state.rows.length) {
        showBanner(
          "API ตอบ 200 แต่ไม่มีแถว — ตรวจ BOT_UPSTREAM / tunnel บนเครื่องบอท",
          "err"
        );
      } else if (stale) {
        showBanner("กำลังแสดงข้อมูลล่าสุดที่สำเร็จ (stale fallback)", "");
      } else {
        showBanner(
          "GitHub Pages โหลดข้อมูลจาก Workers ได้ปกติ — HTML ถาวรแม้ Workers UI จะเคยพัง",
          "ok"
        );
      }
      render();
    } catch (e) {
      state.error = String(e);
      el.status.textContent = "API error";
      showBanner(
        "ดึง /api/screen ไม่ได้: " +
          e +
          " — หน้านี้ยังเปิดได้ (GitHub Pages) แต่ยังไม่มีข้อมูลจริง (ไม่สร้างแถวปลอม)",
        "err"
      );
      el.tbody.innerHTML =
        '<tr><td colspan="9" class="muted">รอ API · ' +
        String(e).replace(/</g, "&lt;") +
        "</td></tr>";
    }
  }

  ["change", "input"].forEach(function (ev) {
    el.mode.addEventListener(ev, render);
    el.minVol.addEventListener(ev, render);
    el.minScore.addEventListener(ev, render);
    el.nowOnly.addEventListener(ev, render);
  });
  el.refreshBtn.addEventListener("click", function () {
    load();
  });

  load();
  setInterval(load, 50000);
})();
