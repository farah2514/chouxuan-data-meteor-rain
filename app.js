import { GIFEncoder, quantize, applyPalette } from "./collage/vendor/gifenc.esm.js";

const state = {
  layout: "horizontal",
  exportMode: "png",
  pngScale: 1,
  gap: 16,
  padding: 24,
  radius: 18,
  backgroundColor: "#f5f7fb",
  shadow: true,
  outline: false,
  gifWidth: 960,
  gifHeight: 960,
  defaultGifDuration: 0.9,
  gifRepeatMode: "forever",
  gifRepeatCount: 3,
  candidates: [],
  selectedCandidateKeys: new Set(),
  draggingId: null,
  gifPreviewUrl: null,
  modalPreviewUrl: null,
};

const elements = {
  fileInput: document.getElementById("fileInput"),
  dropZone: document.getElementById("dropZone"),
  pageUrl: document.getElementById("pageUrl"),
  extractBtn: document.getElementById("extractBtn"),
  statusText: document.getElementById("statusText"),
  candidateGrid: document.getElementById("candidateGrid"),
  clearBtn: document.getElementById("clearBtn"),
  pngSettings: document.getElementById("pngSettings"),
  gapRange: document.getElementById("gapRange"),
  gapValue: document.getElementById("gapValue"),
  paddingRange: document.getElementById("paddingRange"),
  paddingValue: document.getElementById("paddingValue"),
  radiusRange: document.getElementById("radiusRange"),
  radiusValue: document.getElementById("radiusValue"),
  backgroundColor: document.getElementById("backgroundColor"),
  shadowToggle: document.getElementById("shadowToggle"),
  outlineToggle: document.getElementById("outlineToggle"),
  gifSettings: document.getElementById("gifSettings"),
  gifBackgroundColor: document.getElementById("gifBackgroundColor"),
  gifWidthInput: document.getElementById("gifWidthInput"),
  gifHeightInput: document.getElementById("gifHeightInput"),
  gifDurationInput: document.getElementById("gifDurationInput"),
  gifRepeatCountWrap: document.getElementById("gifRepeatCountWrap"),
  gifRepeatCountInput: document.getElementById("gifRepeatCountInput"),
  applyGifDurationBtn: document.getElementById("applyGifDurationBtn"),
  renderBtn: document.getElementById("renderBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  previewCanvas: document.getElementById("previewCanvas"),
  previewGif: document.getElementById("previewGif"),
  emptyPreview: document.getElementById("emptyPreview"),
  previewWrap: document.querySelector(".preview-wrap"),
  previewModal: document.getElementById("previewModal"),
  modalPreviewImage: document.getElementById("modalPreviewImage"),
  modalDownloadBtn: document.getElementById("modalDownloadBtn"),
  modalCloseBtn: document.getElementById("modalCloseBtn"),
  layoutButtons: document.querySelectorAll("[data-layout]"),
  exportModeButtons: document.querySelectorAll("[data-export-mode]"),
  pngScaleButtons: document.querySelectorAll("[data-png-scale]"),
  gifRepeatButtons: document.querySelectorAll("[data-gif-repeat-mode]"),
};

let imageCounter = 0;

function setStatus(message) {
  elements.statusText.textContent = message;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parsePositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function parsePositiveFloat(value, fallback, min, max) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function simplifyName(value) {
  if (!value) return "未命名图片";
  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || url.hostname);
  } catch {
    return value;
  }
}

function getExtractErrorMessage(value, data, fallbackMessage) {
  const base = data?.error || fallbackMessage || "提取失败";
  const hint = data?.hint ? ` ${data.hint}` : "";
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("tiktok.com")) {
    return `${base}。TikTok 链接经常因为动态渲染、地区限制或反爬拿不到真实图片。你也可以换另一个 TikTok 图片帖再试。${hint}`;
  }
  return `${base}${hint ? `。${data.hint}` : ""}`;
}

function getCandidateKey(item) {
  return item.selectionKey || item.originalUrl || item.src || item.id;
}

function createCandidate(base) {
  return {
    id: base.id || `img-${Date.now()}-${imageCounter++}`,
    kind: base.kind || "remote",
    name: base.name || "未命名图片",
    source: base.source || "",
    src: base.src,
    previewSrc: base.previewSrc || base.src,
    directSrc: base.directSrc || base.src,
    renderSrc: base.renderSrc || base.src,
    proxyUrl: base.proxyUrl || base.renderSrc || base.src,
    originalUrl: base.originalUrl || base.src,
    selectionKey: base.selectionKey || base.originalUrl || base.src,
    duration: base.duration || state.defaultGifDuration,
    broken: false,
  };
}

function dedupeCandidates() {
  const map = new Map();
  state.candidates.forEach((item) => {
    const key = item.originalUrl || item.src || item.id;
    if (!map.has(key)) {
      map.set(key, item);
    }
  });
  state.candidates = Array.from(map.values());
}

function getSelectedImages() {
  return state.candidates.filter((item) => state.selectedCandidateKeys.has(getCandidateKey(item)) && !item.broken);
}

function updateRangeLabels() {
  elements.gapValue.textContent = `${state.gap}px`;
  elements.paddingValue.textContent = `${state.padding}px`;
  elements.radiusValue.textContent = `${state.radius}px`;
}

function updateLayoutButtons() {
  elements.layoutButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.layout === state.layout);
  });
}

function updatePngScaleButtons() {
  elements.pngScaleButtons.forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.pngScale) === state.pngScale);
  });
}

function updateExportModeButtons() {
  elements.exportModeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.exportMode === state.exportMode);
  });
  elements.pngSettings.classList.toggle("hidden", state.exportMode !== "png");
  elements.gifSettings.classList.toggle("hidden", state.exportMode !== "gif");
  elements.downloadBtn.textContent = state.exportMode === "gif" ? "下载 GIF" : "下载 PNG";
  elements.emptyPreview.textContent =
    state.exportMode === "gif"
      ? "先勾选至少一张候选图片，右侧会显示 GIF 动态预览。"
      : "先勾选至少一张候选图片，右侧会生成拼图预览。";
}

function updateGifRepeatButtons() {
  elements.gifRepeatButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.gifRepeatMode === state.gifRepeatMode);
  });
  elements.gifRepeatCountWrap.classList.toggle("hidden", state.gifRepeatMode !== "custom");
}

function getGifRepeatValue() {
  if (state.gifRepeatMode === "once") return -1;
  if (state.gifRepeatMode === "custom") return state.gifRepeatCount;
  return 0;
}

function getShadowLayers() {
  if (!state.shadow) return [];
  return [
    { color: "rgba(15, 23, 42, 0.12)", blur: 28, offsetY: 12 },
    { color: "rgba(15, 23, 42, 0.08)", blur: 12, offsetY: 4 },
  ];
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawDecorations(ctx, x, y, width, height) {
  if (state.outline) {
    ctx.save();
    roundedRect(ctx, x, y, width, height, state.radius);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  getShadowLayers().forEach((layer) => {
    ctx.save();
    ctx.shadowColor = layer.color;
    ctx.shadowBlur = layer.blur;
    ctx.shadowOffsetY = layer.offsetY;
    roundedRect(ctx, x, y, width, height, state.radius);
    ctx.strokeStyle = "rgba(255,255,255,0.001)";
    ctx.lineWidth = 0.001;
    ctx.stroke();
    ctx.restore();
  });
}

function drawCardImage(ctx, img, x, y, width, height) {
  ctx.save();
  roundedRect(ctx, x, y, width, height, state.radius);
  ctx.clip();
  ctx.drawImage(img, x, y, width, height);
  ctx.restore();
  drawDecorations(ctx, x, y, width, height);
}

function getContainedPlacement(img, x, y, width, height) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(safeWidth / img.width, safeHeight / img.height);
  const drawWidth = Math.max(1, Math.round(img.width * scale));
  const drawHeight = Math.max(1, Math.round(img.height * scale));
  const drawX = x + Math.round((safeWidth - drawWidth) / 2);
  const drawY = y + Math.round((safeHeight - drawHeight) / 2);
  return { drawX, drawY, drawWidth, drawHeight };
}

function drawContainedImage(ctx, img, x, y, width, height) {
  const { drawX, drawY, drawWidth, drawHeight } = getContainedPlacement(img, x, y, width, height);

  ctx.save();
  roundedRect(ctx, drawX, drawY, drawWidth, drawHeight, state.radius);
  ctx.clip();
  ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
  ctx.restore();
  drawDecorations(ctx, drawX, drawY, drawWidth, drawHeight);
}

function loadImageWithOptions(src, options = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (options.crossOrigin) {
      img.crossOrigin = options.crossOrigin;
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

async function loadRenderableImage(item) {
  const sources = [
    item.renderSrc ? { src: item.renderSrc } : null,
    item.directSrc ? { src: item.directSrc, crossOrigin: "anonymous" } : null,
    item.previewSrc && item.previewSrc !== item.directSrc
      ? { src: item.previewSrc, crossOrigin: "anonymous" }
      : null,
  ].filter(Boolean);

  let lastError = null;
  for (const source of sources) {
    try {
      return await loadImageWithOptions(source.src, source);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("图片加载失败");
}

async function loadSelectedImages() {
  return Promise.all(
    getSelectedImages().map(async (item) => ({
      item,
      img: await loadRenderableImage(item),
    }))
  );
}

function moveCandidateImage(id, direction) {
  const index = state.candidates.findIndex((item) => item.id === id);
  if (index < 0) return;
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= state.candidates.length) return;
  const [item] = state.candidates.splice(index, 1);
  state.candidates.splice(targetIndex, 0, item);
  renderCandidates();
  renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
}

function reorderCandidates(dragId, targetId, position = "before") {
  const fromIndex = state.candidates.findIndex((item) => item.id === dragId);
  const targetIndex = state.candidates.findIndex((item) => item.id === targetId);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return false;

  const [moved] = state.candidates.splice(fromIndex, 1);
  let insertIndex = targetIndex;
  if (fromIndex < targetIndex) {
    insertIndex -= 1;
  }
  if (position === "after") {
    insertIndex += 1;
  }
  insertIndex = Math.max(0, Math.min(insertIndex, state.candidates.length));
  state.candidates.splice(insertIndex, 0, moved);
  return true;
}

function clearDropMarkers() {
  elements.candidateGrid
    .querySelectorAll(".candidate-card.drop-before, .candidate-card.drop-after, .candidate-card.dragging")
    .forEach((item) => {
      item.classList.remove("drop-before", "drop-after", "dragging");
    });
}

function clearGifPreviewUrl() {
  if (state.gifPreviewUrl) {
    URL.revokeObjectURL(state.gifPreviewUrl);
    state.gifPreviewUrl = null;
  }
}

function clearModalPreviewUrl() {
  if (state.modalPreviewUrl) {
    URL.revokeObjectURL(state.modalPreviewUrl);
    state.modalPreviewUrl = null;
  }
}

function getPreviewFitScale(logicalWidth, logicalHeight) {
  const wrap = elements.previewWrap;
  if (!wrap) return 1;
  const styles = getComputedStyle(wrap);
  const availableWidth =
    wrap.clientWidth - Number.parseFloat(styles.paddingLeft) - Number.parseFloat(styles.paddingRight);
  const availableHeight =
    wrap.clientHeight - Number.parseFloat(styles.paddingTop) - Number.parseFloat(styles.paddingBottom);
  if (availableWidth <= 0 || availableHeight <= 0) return 1;
  return Math.min(availableWidth / logicalWidth, availableHeight / logicalHeight, 1);
}

function closePreviewModal() {
  elements.previewModal.classList.add("hidden");
  elements.previewModal.setAttribute("aria-hidden", "true");
  elements.modalPreviewImage.removeAttribute("src");
  clearModalPreviewUrl();
}

function finishPointerDrag(commit = true, clientY = null) {
  if (!state.draggingId) return;
  let targetId = null;
  let position = "before";

  if (typeof clientY === "number") {
    const items = Array.from(elements.candidateGrid.querySelectorAll(".candidate-card"));
    for (const item of items) {
      if (item.dataset.candidateId === state.draggingId) continue;
      const rect = item.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (clientY < mid) {
        targetId = item.dataset.candidateId;
        position = "before";
        break;
      }
      targetId = item.dataset.candidateId;
      position = "after";
    }
  }

  const dragId = state.draggingId;
  state.draggingId = null;
  clearDropMarkers();

  if (commit && targetId && dragId !== targetId) {
    const changed = reorderCandidates(dragId, targetId, position);
    if (changed) {
      renderCandidates();
      renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    }
  }
}

function removeCandidate(id) {
  const current = state.candidates.find((item) => item.id === id);
  if (current?.kind === "local" && current.previewSrc.startsWith("blob:")) {
    URL.revokeObjectURL(current.previewSrc);
  }
  state.candidates = state.candidates.filter((item) => item.id !== id);
  if (current) {
    state.selectedCandidateKeys.delete(getCandidateKey(current));
  }
  renderCandidates();
  renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
}

function renderCandidates() {
  if (!state.candidates.length) {
    elements.candidateGrid.className = "candidate-list empty";
    elements.candidateGrid.innerHTML = "<p>从链接提图后，候选图片会显示在这里。勾选后会直接参与预览和导出。</p>";
    return;
  }

  elements.candidateGrid.className = "candidate-list";
  elements.candidateGrid.innerHTML = state.candidates
    .map((item, index) => {
      const candidateKey = getCandidateKey(item);
      const selected = state.selectedCandidateKeys.has(candidateKey);
      const direct = item.directSrc || item.previewSrc || item.src;
      const proxy = item.proxyUrl || item.renderSrc || direct;
      return `
        <article class="candidate-card ${selected ? "candidate-card-selected" : ""} ${item.broken ? "is-broken" : ""}" data-candidate-id="${escapeHtml(item.id)}">
          <div class="candidate-topline">
            <label class="checkbox">
              <input type="checkbox" data-candidate-key="${escapeHtml(candidateKey)}" ${selected ? "checked" : ""} ${item.broken ? "disabled" : ""} />
              <span>${selected ? "已选中" : "选中"}</span>
            </label>
            <div class="candidate-top-actions">
              <button class="mini-btn ghost drag-handle" data-drag-id="${escapeHtml(item.id)}" type="button">拖拽</button>
            </div>
          </div>

          <img
            class="candidate-thumb"
            src="${escapeHtml(direct)}"
            data-direct-src="${escapeHtml(direct)}"
            data-proxy-src="${escapeHtml(proxy)}"
            data-candidate-id="${escapeHtml(item.id)}"
            alt="候选图片 ${index + 1}"
            loading="lazy"
            referrerpolicy="no-referrer"
          />

          <div class="card-body">
            <div class="card-meta">${escapeHtml(item.source || (item.kind === "local" ? "本地上传" : "网页提取"))}</div>
            <div class="candidate-name">${escapeHtml(item.name)}</div>

            <div class="selected-controls ${selected ? "" : "hidden"}">
              <label class="mini-field">
                <span>GIF 时长(s)</span>
                <input class="mini-number" type="number" min="0.1" max="20" step="0.1" value="${item.duration}" data-duration-id="${escapeHtml(item.id)}" />
              </label>
              <div class="selected-actions">
                <button class="remove-btn" data-remove-id="${escapeHtml(item.id)}" type="button">移除</button>
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  elements.candidateGrid.querySelectorAll("input[type='checkbox']").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.candidateKey;
      if (!key) return;
      if (input.checked) state.selectedCandidateKeys.add(key);
      else state.selectedCandidateKeys.delete(key);
      renderCandidates();
      renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    });
  });

  elements.candidateGrid.querySelectorAll("[data-duration-id]").forEach((input) => {
    input.addEventListener("change", () => {
      const current = state.candidates.find((item) => item.id === input.dataset.durationId);
      if (!current) return;
      current.duration = parsePositiveFloat(input.value, current.duration, 0.1, 20);
      input.value = current.duration;
      if (state.exportMode === "gif") {
        renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
      }
    });
  });

  elements.candidateGrid.querySelectorAll("[data-remove-id]").forEach((button) => {
    button.addEventListener("click", () => {
      removeCandidate(button.dataset.removeId);
    });
  });

  elements.candidateGrid.querySelectorAll("[data-drag-id]").forEach((handle) => {
    handle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      state.draggingId = handle.dataset.dragId;
      handle.closest(".candidate-card")?.classList.add("dragging");

      const onMove = (moveEvent) => {
        if (!state.draggingId) return;
        clearDropMarkers();
        const draggingItem = elements.candidateGrid.querySelector(`[data-candidate-id="${state.draggingId}"]`);
        draggingItem?.classList.add("dragging");
        const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest(".candidate-card");
        if (!target || target.dataset.candidateId === state.draggingId) return;
        const rect = target.getBoundingClientRect();
        const position = moveEvent.clientY < rect.top + rect.height / 2 ? "before" : "after";
        target.classList.add(position === "before" ? "drop-before" : "drop-after");
      };

      const onUp = (upEvent) => {
        document.removeEventListener("mousemove", onMove);
        finishPointerDrag(true, upEvent.clientY);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp, { once: true });
    });
  });

  elements.candidateGrid.querySelectorAll(".candidate-thumb").forEach((img) => {
    img.addEventListener("error", () => {
      const current = state.candidates.find((item) => item.id === img.dataset.candidateId);
      if (!current) return;
      if (!img.dataset.triedProxy && img.dataset.proxySrc && img.dataset.proxySrc !== img.dataset.directSrc) {
        img.dataset.triedProxy = "1";
        img.src = img.dataset.proxySrc;
        return;
      }
      current.broken = true;
      state.selectedCandidateKeys.delete(getCandidateKey(current));
      renderCandidates();
    });
  });
}

function drawPngComposition(canvas, loaded, renderScale = 1, displayScale = 1) {
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const gap = state.gap;
  const padding = state.padding;
  const targetCrossSize =
    state.layout === "horizontal"
      ? Math.max(...loaded.map(({ img }) => img.height))
      : Math.max(...loaded.map(({ img }) => img.width));

  const cards = loaded.map(({ item, img }) => {
    if (state.layout === "horizontal") {
      const scale = targetCrossSize / img.height;
      return {
        item,
        img,
        width: Math.max(1, Math.round(img.width * scale)),
        height: targetCrossSize,
      };
    }
    const scale = targetCrossSize / img.width;
    return {
      item,
      img,
      width: targetCrossSize,
      height: Math.max(1, Math.round(img.height * scale)),
    };
  });

  const innerWidth =
    state.layout === "horizontal"
      ? cards.reduce((sum, card) => sum + card.width, 0) + gap * Math.max(cards.length - 1, 0)
      : Math.max(...cards.map((card) => card.width));
  const innerHeight =
    state.layout === "vertical"
      ? cards.reduce((sum, card) => sum + card.height, 0) + gap * Math.max(cards.length - 1, 0)
      : Math.max(...cards.map((card) => card.height));

  const logicalWidth = innerWidth + padding * 2;
  const logicalHeight = innerHeight + padding * 2;
  canvas.width = Math.round(logicalWidth * renderScale);
  canvas.height = Math.round(logicalHeight * renderScale);
  canvas.style.width = `${Math.round(logicalWidth * displayScale)}px`;
  canvas.style.height = `${Math.round(logicalHeight * displayScale)}px`;
  ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
  ctx.fillStyle = state.backgroundColor;
  ctx.fillRect(0, 0, logicalWidth, logicalHeight);

  let cursorX = padding;
  let cursorY = padding;

  cards.forEach((card) => {
    const drawX =
      state.layout === "horizontal"
        ? cursorX
        : padding + Math.round((innerWidth - card.width) / 2);
    const drawY =
      state.layout === "vertical"
        ? cursorY
        : padding + Math.round((innerHeight - card.height) / 2);

    drawContainedImage(ctx, card.img, drawX, drawY, card.width, card.height);

    if (state.layout === "horizontal") cursorX += card.width + gap;
    else cursorY += card.height + gap;
  });

  return { logicalWidth, logicalHeight, count: loaded.length };
}

async function renderPngPreview() {
  const canvas = elements.previewCanvas;
  const loaded = await loadSelectedImages();
  const previewScale = 1;
  const fullSize = drawPngComposition(document.createElement("canvas"), loaded, 1, 1);
  const previewDisplayScale = getPreviewFitScale(fullSize.logicalWidth, fullSize.logicalHeight);
  const result = drawPngComposition(canvas, loaded, previewScale, previewDisplayScale);

  setStatus(`当前已选择 ${result.count} 张图片，右侧显示完整缩略预览；点击可查看高清大图`);
}

function drawGifFrame(ctx, img, canvasWidth, canvasHeight) {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = state.backgroundColor;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  const innerWidth = canvasWidth - state.padding * 2;
  const innerHeight = canvasHeight - state.padding * 2;
  drawContainedImage(ctx, img, state.padding, state.padding, innerWidth, innerHeight);
}

async function renderGifPreview() {
  const gifBlob = await generateGifBlob(false);
  clearGifPreviewUrl();
  state.gifPreviewUrl = URL.createObjectURL(gifBlob);
  elements.previewGif.src = state.gifPreviewUrl;
  elements.previewGif.style.width = "";
  elements.previewGif.style.height = "";
  elements.previewGif.style.display = "block";
  elements.previewGif.classList.remove("hidden");
  elements.previewCanvas.style.display = "none";
  setStatus(`当前为 GIF 模式，右侧显示完整动态预览；点击可查看高清大图，共 ${getSelectedImages().length} 帧`);
}

async function renderPreview() {
  const selectedImages = getSelectedImages();
  if (!selectedImages.length) {
    elements.previewCanvas.style.display = "none";
    elements.previewGif.style.display = "none";
    elements.previewGif.classList.add("hidden");
    clearGifPreviewUrl();
    closePreviewModal();
    elements.emptyPreview.style.display = "grid";
    return;
  }

  setStatus("正在生成预览…");
  if (state.exportMode === "gif") {
    await renderGifPreview();
  } else {
    clearGifPreviewUrl();
    elements.previewGif.style.display = "none";
    elements.previewGif.classList.add("hidden");
    await renderPngPreview();
    elements.previewCanvas.style.display = "block";
  }

  elements.emptyPreview.style.display = "none";
}

function addLocalFiles(fileList) {
  const files = Array.from(fileList).filter((file) => file.type.startsWith("image/"));
  if (!files.length) {
    setStatus("没有检测到可用图片文件");
    return;
  }

  files.forEach((file) => {
    const objectUrl = URL.createObjectURL(file);
    const candidate = createCandidate({
      id: `local-${Date.now()}-${imageCounter++}`,
      kind: "local",
      name: file.name,
      source: "本地上传",
      src: objectUrl,
      previewSrc: objectUrl,
      directSrc: objectUrl,
      renderSrc: objectUrl,
      proxyUrl: objectUrl,
      originalUrl: objectUrl,
      selectionKey: objectUrl,
    });
    state.candidates.push(candidate);
    state.selectedCandidateKeys.add(candidate.selectionKey);
  });

  dedupeCandidates();
  renderCandidates();
  renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
}

async function extractImagesFromPage() {
  const value = elements.pageUrl.value.trim();
  if (!value) {
    setStatus("请先输入网页链接");
    return;
  }

  elements.extractBtn.disabled = true;
  setStatus(
    value.toLowerCase().includes("tiktok.com")
      ? "正在从 TikTok 提取图片…这会走增强识别，可能比普通网页慢一点"
      : "正在从链接提取图片…"
  );

  try {
    const response = await fetch(`/extract?url=${encodeURIComponent(value)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(getExtractErrorMessage(value, data, "提取失败"));
    }

    state.candidates = data.images.map((item, index) =>
      createCandidate({
        id: `remote-${Date.now()}-${index}`,
        kind: "remote",
        name: simplifyName(item.url),
        source: item.source,
        src: item.url,
        previewSrc: item.url,
        directSrc: item.url,
        renderSrc: `/proxy-image?url=${encodeURIComponent(item.url)}`,
        proxyUrl: `/proxy-image?url=${encodeURIComponent(item.url)}`,
        originalUrl: item.url,
        selectionKey: item.url,
      })
    );
    state.selectedCandidateKeys = new Set(state.candidates.slice(0, 6).map((item) => item.selectionKey));
    renderCandidates();
    renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    setStatus(`已提取 ${data.count} 张候选图片，默认勾选前 6 张`);
  } catch (error) {
    setStatus(`提取失败：${error.message}`);
  } finally {
    elements.extractBtn.disabled = false;
  }
}

function clearAll() {
  state.candidates.forEach((item) => {
    if (item.kind === "local" && item.previewSrc.startsWith("blob:")) {
      URL.revokeObjectURL(item.previewSrc);
    }
  });
  state.candidates = [];
  state.selectedCandidateKeys.clear();
  closePreviewModal();
  renderCandidates();
  renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
  setStatus("已清空候选图片和勾选状态");
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function generateGifBlob(showProgress = true) {
  const frames = await loadSelectedImages();
  const canvas = document.createElement("canvas");
  canvas.width = state.gifWidth;
  canvas.height = state.gifHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const gif = GIFEncoder();

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    drawGifFrame(ctx, frame.img, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const palette = quantize(imageData.data, 256);
    const indexed = applyPalette(imageData.data, palette);
    gif.writeFrame(indexed, canvas.width, canvas.height, {
      palette,
      delay: Math.round(frame.item.duration * 1000),
      repeat: index === 0 ? getGifRepeatValue() : undefined,
    });
    if (showProgress) {
      setStatus(`正在生成 GIF… ${index + 1}/${frames.length}`);
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  gif.finish();
  return new Blob([gif.bytesView()], { type: "image/gif" });
}

async function generatePngBlob() {
  return new Promise((resolve) => {
    const exportCanvas = document.createElement("canvas");
    loadSelectedImages()
      .then((loaded) => {
        drawPngComposition(exportCanvas, loaded, state.pngScale, 1);
        exportCanvas.toBlob(resolve, "image/png");
      })
      .catch(() => resolve(null));
  });
}

async function openPreviewModal() {
  const selectedImages = getSelectedImages();
  if (!selectedImages.length) {
    setStatus("没有可预览的大图");
    return;
  }

  clearModalPreviewUrl();
  let blob = null;
  if (state.exportMode === "gif") {
    blob = await generateGifBlob(false);
  } else {
    blob = await generatePngBlob();
  }

  if (!blob) {
    setStatus("高清预览生成失败");
    return;
  }

  state.modalPreviewUrl = URL.createObjectURL(blob);
  elements.modalPreviewImage.src = state.modalPreviewUrl;
  elements.previewModal.classList.remove("hidden");
  elements.previewModal.setAttribute("aria-hidden", "false");
}

async function downloadCurrentOutput() {
  const selectedImages = getSelectedImages();
  if (!selectedImages.length) {
    setStatus("没有可下载的结果");
    return;
  }

  if (state.exportMode === "gif") {
    try {
      const blob = await generateGifBlob();
      downloadBlob(blob, `collage-animation-${Date.now()}.gif`);
      setStatus(`GIF 已生成，共 ${selectedImages.length} 帧`);
    } catch (error) {
      setStatus(`GIF 生成失败：${error.message}`);
    }
    return;
  }

  const blob = await generatePngBlob();
  if (!blob) {
    setStatus("PNG 导出失败");
    return;
  }
  downloadBlob(blob, `collage-${state.layout}-${Date.now()}.png`);
}

function bindEvents() {
  elements.fileInput.addEventListener("change", (event) => {
    if (event.target.files?.length) {
      addLocalFiles(event.target.files);
      event.target.value = "";
    }
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("dragging");
    });
  });

  elements.dropZone.addEventListener("drop", (event) => {
    const files = event.dataTransfer?.files;
    if (files?.length) addLocalFiles(files);
  });

  elements.extractBtn.addEventListener("click", extractImagesFromPage);
  elements.clearBtn.addEventListener("click", clearAll);
  elements.renderBtn.addEventListener("click", () => {
    renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
  });
  elements.downloadBtn.addEventListener("click", () => {
    downloadCurrentOutput().catch((error) => setStatus(`导出失败：${error.message}`));
  });
  elements.previewCanvas.addEventListener("click", () => {
    if (state.exportMode === "png") {
      openPreviewModal().catch((error) => setStatus(`高清预览失败：${error.message}`));
    }
  });
  elements.previewGif.addEventListener("click", () => {
    if (state.exportMode === "gif") {
      openPreviewModal().catch((error) => setStatus(`高清预览失败：${error.message}`));
    }
  });
  elements.modalDownloadBtn.addEventListener("click", () => {
    downloadCurrentOutput().catch((error) => setStatus(`导出失败：${error.message}`));
  });
  elements.modalCloseBtn.addEventListener("click", closePreviewModal);
  elements.previewModal.addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.dataset.closePreview === "true") {
      closePreviewModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.previewModal.classList.contains("hidden")) {
      closePreviewModal();
    }
  });

  elements.layoutButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.layout = button.dataset.layout;
      updateLayoutButtons();
      renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    });
  });

  elements.exportModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.exportMode = button.dataset.exportMode;
      updateExportModeButtons();
      renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    });
  });

  elements.pngScaleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.pngScale = Number(button.dataset.pngScale) || 1;
      if (![1, 2, 3].includes(state.pngScale)) {
        state.pngScale = 1;
      }
      updatePngScaleButtons();
      if (state.exportMode === "png") {
        renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
      }
    });
  });

  elements.gapRange.addEventListener("input", () => {
    state.gap = Number(elements.gapRange.value);
    updateRangeLabels();
  });
  elements.paddingRange.addEventListener("input", () => {
    state.padding = Number(elements.paddingRange.value);
    updateRangeLabels();
  });
  elements.radiusRange.addEventListener("input", () => {
    state.radius = Number(elements.radiusRange.value);
    updateRangeLabels();
  });

  [elements.gapRange, elements.paddingRange, elements.radiusRange].forEach((input) => {
    input.addEventListener("change", () => {
      renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    });
  });

  elements.backgroundColor.addEventListener("input", () => {
    state.backgroundColor = elements.backgroundColor.value;
    elements.gifBackgroundColor.value = state.backgroundColor;
    renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
  });

  elements.gifBackgroundColor.addEventListener("input", () => {
    state.backgroundColor = elements.gifBackgroundColor.value;
    elements.backgroundColor.value = state.backgroundColor;
    renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
  });

  elements.shadowToggle.addEventListener("change", () => {
    state.shadow = elements.shadowToggle.checked;
    renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
  });

  elements.outlineToggle.addEventListener("change", () => {
    state.outline = elements.outlineToggle.checked;
    renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
  });

  elements.gifWidthInput.addEventListener("change", () => {
    state.gifWidth = parsePositiveInt(elements.gifWidthInput.value, state.gifWidth, 100, 2400);
    elements.gifWidthInput.value = state.gifWidth;
    if (state.exportMode === "gif") {
      renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    }
  });

  elements.gifHeightInput.addEventListener("change", () => {
    state.gifHeight = parsePositiveInt(elements.gifHeightInput.value, state.gifHeight, 100, 2400);
    elements.gifHeightInput.value = state.gifHeight;
    if (state.exportMode === "gif") {
      renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    }
  });

  elements.gifDurationInput.addEventListener("change", () => {
    state.defaultGifDuration = parsePositiveFloat(
      elements.gifDurationInput.value,
      state.defaultGifDuration,
      0.1,
      20
    );
    elements.gifDurationInput.value = state.defaultGifDuration;
  });

  elements.gifRepeatButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.gifRepeatMode = button.dataset.gifRepeatMode;
      updateGifRepeatButtons();
    });
  });

  elements.gifRepeatCountInput.addEventListener("change", () => {
    state.gifRepeatCount = parsePositiveInt(elements.gifRepeatCountInput.value, state.gifRepeatCount, 1, 99);
    elements.gifRepeatCountInput.value = state.gifRepeatCount;
  });

  elements.applyGifDurationBtn.addEventListener("click", () => {
    getSelectedImages().forEach((item) => {
      item.duration = state.defaultGifDuration;
    });
    renderCandidates();
    setStatus("已把默认 GIF 速度应用到当前勾选图片");
  });

  elements.pageUrl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      extractImagesFromPage();
    }
  });
}

function init() {
  updateRangeLabels();
  updateLayoutButtons();
  updateExportModeButtons();
  updatePngScaleButtons();
  updateGifRepeatButtons();
  elements.gifBackgroundColor.value = state.backgroundColor;
  renderCandidates();
  bindEvents();
}

init();
