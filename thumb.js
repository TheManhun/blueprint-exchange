// Blueprint Exchange -- the preview-image slot + cropper, shared by the
// upload page and the edit page. Load after site.js. Needs the markup from
// src/_thumbfield.html and src/_thumbdlg.html on the page.

// Stage 3 -- the preview image, if any: the cropper (further down)
// stores its WebP blob on window.bpThumbnail; this Worker writes it
// to R2 and hands back the public URL that gets saved as
// thumbnail_url. Proven working stage 2 (browser -> Worker -> R2 ->
// public URL) before this was wired in.
const THUMB_WORKER_URL = "https://blueprint-exchange-thumbnails.blueprint-exchange.workers.dev";

// Upload the always-drawn schematic; returns its public URL or null.
async function uploadSchematicIfAny() {
  if (!window.bpSchematic || !window.bpSchematic.blob) return null;
  try {
    const res = await fetch(THUMB_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "image/webp" },
      body: window.bpSchematic.blob,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) return null;
    return data.url;
  } catch (err) { return null; }
}

async function uploadThumbnailIfAny() {
  if (!window.bpThumbnail || !window.bpThumbnail.blob) return null;
  const res = await fetch(THUMB_WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "image/webp" },
    body: window.bpThumbnail.blob,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.ok) {
    throw new Error((data && data.error) || ("thumbnail upload failed (HTTP " + res.status + ")"));
  }
  return data.url;
}

// One persistent image slot (#thumbSlotImg) -- always shows either the
// placeholder art or the real crop, never blank, never a broken icon.
// A page may set window.bpxThumbDefault (the edit page sets the blueprint's
// current screenshot) to show that instead of the placeholder when no new
// image has been chosen.
function resetThumbSlot() {
  const slotImg = document.getElementById("thumbSlotImg");
  const addBtn = document.getElementById("addThumbBtn");
  const emptyHint = document.getElementById("thumbEmptyHint");
  const readyMsg = document.getElementById("thumbReadyMsg");
  const readyError = document.getElementById("thumbReadyError");
  const readyActions = document.getElementById("thumbReadyActions");
  if (slotImg) { slotImg.onerror = null; slotImg.src = window.bpxThumbDefault || "drop-placeholder.webp"; }
  if (addBtn) addBtn.hidden = false;
  if (emptyHint) emptyHint.hidden = false;
  if (readyMsg) readyMsg.hidden = true;
  if (readyError) readyError.hidden = true;
  if (readyActions) readyActions.hidden = true;
}

function clearThumbnail() {
  if (window.bpThumbnail && window.bpThumbnail.url) URL.revokeObjectURL(window.bpThumbnail.url);
  window.bpThumbnail = null;
  resetThumbSlot();
  window.dispatchEvent(new Event("bpx:thumbchange"));
}

// ============================================================
// Preview image cropper -- STAGE 1 ONLY.
// Paste / choose an image, position + zoom it in a fixed 16:9 window,
// export a 480x270 WebP entirely client-side. Nothing here talks to
// R2 or Supabase yet -- "Use image" just stores the blob in memory
// (window.bpThumbnail) and shows a Download link so the output can be
// checked by hand before any upload wiring is built. Deliberately its
// own <script>, independent of the upload flow above: stage 2 will
// read window.bpThumbnail (or null) when the blueprint is submitted,
// nothing here needs to change for that.
(function () {

  const OUT_W = 480, OUT_H = 270;

  const addBtn = document.getElementById("addThumbBtn");
  const changeBtn = document.getElementById("changeThumbBtn");
  const removeBtn = document.getElementById("removeThumbBtn");
  const slotImg = document.getElementById("thumbSlotImg");
  const emptyHint = document.getElementById("thumbEmptyHint");
  const readyMsg = document.getElementById("thumbReadyMsg");
  const readyActions = document.getElementById("thumbReadyActions");
  const downloadLink = document.getElementById("thumbDownloadLink");

  const dlg = document.getElementById("thumbDlg");
  const dropZone = document.getElementById("thumbDropZone");
  const dropHint = document.getElementById("thumbDropHint");
  const fileInput = document.getElementById("thumbFileInput");
  const cropStage = document.getElementById("thumbCropStage");
  const canvas = document.getElementById("thumbCanvas");
  const ctx = canvas.getContext("2d");
  const zoomSlider = document.getElementById("thumbZoom");
  const useBtn = document.getElementById("thumbUseBtn");
  const cancelBtn = document.getElementById("thumbCancelBtn");
  const msg = document.getElementById("thumbMsg");

  // Public hook for the upload step (stage 2): null until "Use image".
  window.bpThumbnail = null; // { blob, url }

  let img = null;         // the loaded HTMLImageElement
  let minScale = 1;        // scale at which the image just covers the 480x270 window
  let scale = 1;
  let offX = 0, offY = 0;  // image-space offset of the window's top-left corner, at scale=1 (pre-scale coords)
  let dragging = false, dragStartX = 0, dragStartY = 0, offStartX = 0, offStartY = 0;

  function setMsg(text, bad) {
    msg.textContent = text || "";
    msg.style.color = bad ? "var(--bad)" : "var(--ink-2)";
  }

  function resetDialogState() {
    img = null;
    cropStage.hidden = true;
    dropZone.hidden = false;
    dropHint.textContent = "Click here, then paste a screenshot — or choose a file below.";
    fileInput.value = "";
    useBtn.disabled = true;
    setMsg("");
  }

  function clampOffset() {
    // Image-space (pre-scale) window size at current scale.
    const winW = OUT_W / scale, winH = OUT_H / scale;
    const maxX = img.naturalWidth - winW;
    const maxY = img.naturalHeight - winH;
    offX = Math.min(Math.max(offX, 0), Math.max(0, maxX));
    offY = Math.min(Math.max(offY, 0), Math.max(0, maxY));
  }

  function draw() {
    if (!img) return;
    clampOffset();
    ctx.clearRect(0, 0, OUT_W, OUT_H);
    ctx.drawImage(
      img,
      offX, offY, OUT_W / scale, OUT_H / scale,
      0, 0, OUT_W, OUT_H
    );
  }

  function loadImage(source) {
    const el = new Image();
    el.onload = function () {
      if (el.naturalWidth < 40 || el.naturalHeight < 40) {
        setMsg("That image is too small to use.", true);
        return;
      }
      img = el;
      minScale = Math.max(OUT_W / img.naturalWidth, OUT_H / img.naturalHeight);
      scale = minScale;
      offX = (img.naturalWidth - OUT_W / scale) / 2;
      offY = (img.naturalHeight - OUT_H / scale) / 2;
      zoomSlider.min = "100";
      zoomSlider.max = "400";
      zoomSlider.value = "100";
      dropZone.hidden = true;
      cropStage.hidden = false;
      useBtn.disabled = false;
      setMsg("Drag the image to reposition it, use the slider to zoom.");
      draw();
    };
    el.onerror = function () {
      setMsg("Couldn't read that image.", true);
    };
    el.src = source;
  }

  function loadFromFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setMsg("Choose a PNG, JPG or WebP image.", true);
      return;
    }
    const reader = new FileReader();
    reader.onload = function () { loadImage(reader.result); };
    reader.readAsDataURL(file);
  }

  // ---- opening / closing the dialog ----

  function openDialog() {
    resetDialogState();
    if (typeof dlg.showModal === "function") {
      dlg.showModal();
    } else {
      dlg.setAttribute("open", "");
    }
    dropZone.focus();
  }

  function closeDialog() {
    if (typeof dlg.close === "function" && dlg.open) dlg.close();
    else dlg.removeAttribute("open");
  }

  addBtn.addEventListener("click", openDialog);
  changeBtn.addEventListener("click", openDialog);

  removeBtn.addEventListener("click", function () {
    if (window.bpThumbnail && window.bpThumbnail.url) {
      URL.revokeObjectURL(window.bpThumbnail.url);
    }
    window.bpThumbnail = null;
    slotImg.src = "drop-placeholder.webp";
    addBtn.hidden = false;
    emptyHint.hidden = false;
    readyMsg.hidden = true;
    document.getElementById("thumbReadyError").hidden = true;
    readyActions.hidden = true;
    window.dispatchEvent(new Event("bpx:thumbchange"));
  });

  cancelBtn.addEventListener("click", closeDialog);

  dlg.addEventListener("cancel", function () {
    // native Esc close -- nothing to clean up, dialog state resets on next open
  });

  // ---- getting an image in: paste or file picker ----

  dropZone.addEventListener("click", function () { dropZone.focus(); });

  dropZone.addEventListener("paste", function (e) {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const item of items) {
      if (item.kind === "file" && /^image\//.test(item.type)) {
        const file = item.getAsFile();
        if (file) { loadFromFile(file); e.preventDefault(); return; }
      }
    }
    setMsg("No image found on the clipboard. Copy a screenshot first, then paste here.", true);
  });

  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) loadFromFile(fileInput.files[0]);
  });

  // ---- zoom + drag ----

  zoomSlider.addEventListener("input", function () {
    if (!img) return;
    const pct = Number(zoomSlider.value) / 100; // 1.0 .. 4.0
    // Keep the window's centre point fixed in image space while zooming.
    const cx = offX + (OUT_W / scale) / 2;
    const cy = offY + (OUT_H / scale) / 2;
    scale = minScale * pct;
    offX = cx - (OUT_W / scale) / 2;
    offY = cy - (OUT_H / scale) / 2;
    draw();
  });

  canvas.addEventListener("pointerdown", function (e) {
    if (!img) return;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    dragStartX = e.clientX; dragStartY = e.clientY;
    offStartX = offX; offStartY = offY;
  });

  canvas.addEventListener("pointermove", function (e) {
    if (!dragging || !img) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = OUT_W / rect.width, scaleY = OUT_H / rect.height;
    const dxCanvas = (e.clientX - dragStartX) * scaleX;
    const dyCanvas = (e.clientY - dragStartY) * scaleY;
    offX = offStartX - dxCanvas / scale;
    offY = offStartY - dyCanvas / scale;
    draw();
  });

  function endDrag(e) {
    if (dragging) {
      dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    }
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // ---- export: 480x270 WebP, target ~0.8 quality, nudged down toward <100KB ----

  function canvasToBlob(c, type, quality) {
    return new Promise(function (resolve) {
      c.toBlob(resolve, type, quality);
    });
  }

  async function exportThumbnail() {
    let quality = 0.8;
    let blob = await canvasToBlob(canvas, "image/webp", quality);

    if (!blob) {
      setMsg("This browser can't export WebP images.", true);
      return null;
    }

    const targetBytes = 100 * 1024;
    let tries = 0;
    while (blob.size > targetBytes && quality > 0.4 && tries < 5) {
      quality -= 0.1;
      blob = await canvasToBlob(canvas, "image/webp", quality);
      tries++;
    }

    return blob;
  }

  useBtn.addEventListener("click", async function () {
    if (!img) return;
    useBtn.disabled = true;
    setMsg("Processing…");

    const blob = await exportThumbnail();

    if (!blob) {
      useBtn.disabled = false;
      return;
    }

    if (window.bpThumbnail && window.bpThumbnail.url) {
      URL.revokeObjectURL(window.bpThumbnail.url);
    }

    const url = URL.createObjectURL(blob);
    window.bpThumbnail = { blob: blob, url: url };

    // A blob: URL assigned to img.src showed broken in earlier testing,
    // even on a fresh page load. A data: URI sidesteps whatever that
    // lifecycle issue was; onerror logs the real reason to the console
    // if this ever fails again, without blanking the slot.
    const readyError = document.getElementById("thumbReadyError");
    readyError.hidden = true;
    slotImg.onerror = function () {
      console.error("Blueprint Exchange: preview thumbnail failed to render -- blob type:", blob.type, "size:", blob.size, "bytes");
      readyError.textContent = `Preview processed (${Math.round(blob.size / 1024)} KB) but couldn't be shown here -- it will still upload fine.`;
      readyError.hidden = false;
    };
    slotImg.src = canvas.toDataURL("image/webp", 0.8);
    downloadLink.href = url;
    const kb = Math.round(blob.size / 1024);
    downloadLink.download = "blueprint-preview.webp";
    setMsg(`Preview ready — ${kb} KB.`);

    addBtn.hidden = true;
    emptyHint.hidden = true;
    readyMsg.hidden = false;
    readyActions.hidden = false;
    window.dispatchEvent(new Event("bpx:thumbchange"));
    closeDialog();
  });

})();

// ============================================================
// AUTO-THUMBNAIL -- drawn from the blueprint itself (Epod: "when the
// user uploads a blueprint the thumbnail is already there"). The game
// has no screenshot API, but the file carries the full geometry, so
// the page renders a schematic: roads and tracks as ribbons, each
// building's plot as a filled outline -- the same vocabulary as the
// in-game ghost. Fires when a blueprint passes inspection and no
// image has been chosen; picking a real screenshot replaces it, and
// choosing another blueprint redraws (auto images never overwrite a
// hand-picked one).
// ============================================================

// A tiny parser for the blueprint's pure-literal Lua ("return { ... }").
// Numbers, strings, booleans, nested tables; array parts become arrays,
// key parts become object fields. Anything unexpected throws.
function bpxParseLuaLiteral(text) {
  let i = text.indexOf("return");
  if (i < 0) throw new Error("no return");
  i += 6;
  const n = text.length;

  function ws() {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text.startsWith("--", i)) { while (i < n && text[i] !== "\n") i++; continue; }
      break;
    }
  }

  function value() {
    ws();
    const c = text[i];
    if (c === "{") return table();
    if (c === '"') return str();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("nil", i)) { i += 3; return null; }
    const m = /^-?\d+(\.\d+)?(e[-+]?\d+)?/i.exec(text.slice(i, i + 40));
    if (m) { i += m[0].length; return parseFloat(m[0]); }
    throw new Error("unexpected value at " + i);
  }

  function str() {
    i++; // opening quote
    let out = "";
    while (i < n) {
      const c = text[i];
      if (c === "\\") { out += text[i + 1]; i += 2; continue; }
      if (c === '"') { i++; return out; }
      out += c; i++;
    }
    throw new Error("unterminated string");
  }

  function table() {
    i++; // {
    const arr = [];
    const obj = {};
    let hasKeys = false;
    for (;;) {
      ws();
      if (text[i] === "}") { i++; break; }
      // key = value | [expr] = value | value
      const keyMatch = /^([A-Za-z_]\w*)\s*=/.exec(text.slice(i, i + 80));
      if (keyMatch && !/^(true|false|nil)\s*=/.test(keyMatch[0])) {
        i += keyMatch[0].length;
        obj[keyMatch[1]] = value();
        hasKeys = true;
      } else if (text[i] === "[") {
        i++;
        const k = value();
        ws();
        if (text[i] !== "]") throw new Error("bad [key]");
        i++;
        ws();
        if (text[i] !== "=") throw new Error("missing = after [key]");
        i++;
        obj[String(k)] = value();
        hasKeys = true;
      } else {
        arr.push(value());
      }
      ws();
      if (text[i] === "," || text[i] === ";") i++;
    }
    if (arr.length && hasKeys) { obj.__array = arr; return obj; }
    return arr.length || !hasKeys ? (arr.length ? arr : (hasKeys ? obj : arr)) : obj;
  }

  return value();
}

// Draw the schematic onto a 480x270 canvas. Returns the canvas, or null
// when there is nothing drawable.
function bpxDrawBlueprintSchematic(bp) {
  const nodes = Array.isArray(bp.nodes) ? bp.nodes : [];
  const edges = Array.isArray(bp.edges) ? bp.edges : [];
  const cons = Array.isArray(bp.constructions) ? bp.constructions : [];
  if (!edges.length && !cons.length) return null;

  // Bounds over node positions and construction footprints.
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  const seen = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
  for (const nd of nodes) if (nd && nd.relative) seen(nd.relative[0], nd.relative[1]);
  const plots = [];
  for (const c of cons) {
    if (!c || !c.relative) continue;
    const yaw = c.yaw || 0, co = Math.cos(yaw), si = Math.sin(yaw);
    const px = c.relative[0], py = c.relative[1];
    const fp = Array.isArray(c.footprint) ? c.footprint : [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    const poly = fp.map(pt => [px + pt[0] * co - pt[1] * si, py + pt[0] * si + pt[1] * co]);
    poly.forEach(p => seen(p[0], p[1]));
    plots.push(poly);
  }
  if (minX > maxX) return null;

  const W = 480, H = 270, PAD = 22;
  const spanX = Math.max(maxX - minX, 10), spanY = Math.max(maxY - minY, 10);
  const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const ox = (W - spanX * scale) / 2, oy = (H + spanY * scale) / 2;
  const X = x => ox + (x - minX) * scale;
  const Y = y => oy - (y - minY) * scale; // north up

  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d");

  // A proper BLUEPRINT: white linework on Prussian blue, faint drafting
  // grid, framed border (Epod: "as if it's a blue print").
  g.fillStyle = "#123c7c";
  g.fillRect(0, 0, W, H);
  const grad = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.75);
  grad.addColorStop(0, "rgba(255,255,255,0.06)");
  grad.addColorStop(1, "rgba(0,0,30,0.28)");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  g.strokeStyle = "rgba(255,255,255,0.07)";
  g.lineWidth = 1;
  for (let gx = 0; gx <= W; gx += 24) { g.beginPath(); g.moveTo(gx + 0.5, 0); g.lineTo(gx + 0.5, H); g.stroke(); }
  for (let gy = 0; gy <= H; gy += 24) { g.beginPath(); g.moveTo(0, gy + 0.5); g.lineTo(W, gy + 0.5); g.stroke(); }
  g.strokeStyle = "rgba(255,255,255,0.55)";
  g.lineWidth = 1.5;
  g.strokeRect(6.5, 6.5, W - 13, H - 13);

  // Building plots first (under the network): white outlines, light wash.
  for (const poly of plots) {
    g.beginPath();
    poly.forEach((p, k) => k ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])));
    g.closePath();
    g.fillStyle = "rgba(255,255,255,0.10)";
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.85)";
    g.lineWidth = 1.5;
    g.stroke();
  }

  // Edges: white linework -- roads wide and soft, tracks bright with a
  // blue dashed centerline for the rail read.
  const lw = Math.max(1.5, Math.min(5, 4.5 * scale));
  const line = (e, color, width, dash) => {
    const a = nodes[e.n0 - 1], b = nodes[e.n1 - 1];
    if (!a || !b || !a.relative || !b.relative) return;
    g.beginPath();
    g.moveTo(X(a.relative[0]), Y(a.relative[1]));
    g.lineTo(X(b.relative[0]), Y(b.relative[1]));
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineCap = "round";
    g.setLineDash(dash || []);
    g.stroke();
    g.setLineDash([]);
  };
  for (const e of edges) if (e && !e.track) line(e, "rgba(255,255,255,0.7)", lw * 1.35);
  for (const e of edges) if (e && e.track) line(e, "rgba(255,255,255,0.95)", lw);
  for (const e of edges) if (e && e.track) line(e, "#123c7c", Math.max(0.8, lw * 0.3), [6, 5]);

  return cv;
}

// Fired by the upload page after a blueprint passes inspection.
function bpxAutoThumbFromBlueprint(luaText) {
  try {
    const bp = bpxParseLuaLiteral(luaText);
    const cv = bpxDrawBlueprintSchematic(bp);
    if (!cv) return;
    cv.toBlob(function (blob) {
      if (!blob) return;
      // The schematic is ALWAYS kept -- it uploads alongside a hand-picked
      // screenshot so the card can switch between the two views.
      window.bpSchematic = { blob: blob };
      if (window.bpThumbnail && window.bpThumbnail.blob && !window.bpThumbnail.auto) return; // never replace a hand-picked image
      try {
        if (window.bpThumbnail && window.bpThumbnail.url) URL.revokeObjectURL(window.bpThumbnail.url);
        const url = URL.createObjectURL(blob);
        window.bpThumbnail = { blob: blob, url: url, auto: true };
        const slotImg = document.getElementById("thumbSlotImg");
        const emptyHint = document.getElementById("thumbEmptyHint");
        const readyMsg = document.getElementById("thumbReadyMsg");
        if (slotImg) slotImg.src = url;
        if (emptyHint) emptyHint.hidden = true;
        if (readyMsg) {
          readyMsg.hidden = false;
          readyMsg.textContent = "Preview drawn from the blueprint — add your own screenshot to replace it.";
        }
        window.dispatchEvent(new Event("bpx:thumbchange"));
      } catch (err) { /* the placeholder stays -- never break the upload */ }
    }, "image/webp", 0.9);
  } catch (err) { /* unparseable geometry: the placeholder stays */ }
}
