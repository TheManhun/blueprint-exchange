// Blueprint Exchange -- the preview-image slot + cropper, shared by the
// upload page and the edit page. Load after site.js. Needs the markup from
// src/_thumbfield.html and src/_thumbdlg.html on the page.

// Stage 3 -- the preview image, if any: the cropper (further down)
// stores its WebP blob on window.bpThumbnail; this Worker writes it
// to R2 and hands back the public URL that gets saved as
// thumbnail_url. Proven working stage 2 (browser -> Worker -> R2 ->
// public URL) before this was wired in.
const THUMB_WORKER_URL = "https://blueprint-exchange-thumbnails.blueprint-exchange.workers.dev";

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
