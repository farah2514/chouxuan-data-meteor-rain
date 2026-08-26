import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.esm.js";

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
  videoClipStart: 0,
  videoClipDuration: 3,
  gifRepeatMode: "forever",
  gifRepeatCount: 3,
  candidateFilter: "all",
  candidates: [],
  selectedCandidateKeys: new Set(),
  draggingId: null,
  gifPreviewUrl: null,
  modalPreviewUrl: null,
  modalGroupKey: null,
  groupPreviewUrls: [],
  assistSessionId: null,
  selectedPreviewGroupKeys: new Set(),
};

const pageParams = new URLSearchParams(window.location.search);
const pageMode = pageParams.get("mode") === "gif" ? "gif" : "png";

const elements = {
  fileInput: document.getElementById("fileInput"),
  dropZone: document.getElementById("dropZone"),
  pageUrl: document.getElementById("pageUrl"),
  extractBtn: document.getElementById("extractBtn"),
  assistExtractBtn: document.getElementById("assistExtractBtn"),
  assistFinishBtn: document.getElementById("assistFinishBtn"),
  assistCancelBtn: document.getElementById("assistCancelBtn"),
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
  gifImageSettings: document.getElementById("gifImageSettings"),
  gifVideoSettings: document.getElementById("gifVideoSettings"),
  gifBackgroundColor: document.getElementById("gifBackgroundColor"),
  gifWidthInput: document.getElementById("gifWidthInput"),
  gifHeightInput: document.getElementById("gifHeightInput"),
  gifDurationInput: document.getElementById("gifDurationInput"),
  gifRepeatCountWrap: document.getElementById("gifRepeatCountWrap"),
  gifRepeatCountInput: document.getElementById("gifRepeatCountInput"),
  applyGifDurationBtn: document.getElementById("applyGifDurationBtn"),
  renderBtn: document.getElementById("renderBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  downloadAllBtn: document.getElementById("downloadAllBtn"),
  previewCanvas: document.getElementById("previewCanvas"),
  previewGif: document.getElementById("previewGif"),
  previewGallery: document.getElementById("previewGallery"),
  videoClipEditors: document.getElementById("videoClipEditors"),
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
  candidateFilterButtons: document.querySelectorAll("[data-candidate-filter]"),
};

let imageCounter = 0;

function setStatus(message) {
  elements.statusText.textContent = message;
}

function updateAssistButtons() {
  const hasSession = Boolean(state.assistSessionId);
  elements.assistFinishBtn.classList.toggle("hidden", !hasSession);
  elements.assistCancelBtn.classList.toggle("hidden", !hasSession);
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

function formatSecondsLabel(value) {
  const safeValue = Math.max(0, Number(value) || 0);
  return `${safeValue.toFixed(1)}s`;
}

function getVideoPreviewTime(duration) {
  if (!Number.isFinite(duration) || duration <= 0.08) return 0;
  return Math.min(0.08, Math.max(0, duration - 0.04));
}

function parseUrlList(rawValue) {
  return Array.from(
    new Set(
      String(rawValue || "")
        .split(/[\n,]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function mapImagesToCandidates(images, groupKey, groupLabel, sourceUrl, groupIndex = 0) {
  return images.map((item, imageIndex) =>
    createCandidate({
      id: `remote-${Date.now()}-${groupIndex}-${imageIndex}`,
      kind: "remote",
      name: simplifyName(item.url),
      source: item.source,
      src: item.url,
      previewSrc: item.url,
      directSrc: item.url,
      renderSrc: `/proxy-media?url=${encodeURIComponent(item.url)}`,
      proxyUrl: `/proxy-media?url=${encodeURIComponent(item.url)}`,
      originalUrl: item.url,
      dedupeKey: item.identity || item.dedupeKey || item.url,
      groupKey,
      groupLabel,
      sourceUrl,
      selectionKey: `${groupKey}::${item.identity || item.dedupeKey || item.url}`,
      mediaType: item.mediaType || "image",
    })
  );
}

async function requestExtract(url) {
  const response = await fetch(`/extract?url=${encodeURIComponent(url)}`);
  const data = await response.json();
  return { response, data };
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
    dedupeKey: base.dedupeKey || base.identity || base.originalUrl || base.src,
    groupKey: base.groupKey || "default",
    groupLabel: base.groupLabel || "当前分组",
    sourceUrl: base.sourceUrl || "",
    selectionKey:
      base.selectionKey ||
      `${base.groupKey || "default"}::${base.dedupeKey || base.identity || base.originalUrl || base.src}`,
    duration: base.duration || state.defaultGifDuration,
    mediaType: base.mediaType || "image",
    fileType: base.fileType || "",
    videoDuration: base.videoDuration || 0,
    clipStart: base.clipStart ?? 0,
    clipEnd: base.clipEnd ?? 0,
    broken: false,
  };
}

function getGifSelectionSummary(groupKey = null) {
  const items = getSelectedImages(groupKey);
  const images = items.filter((item) => item.mediaType !== "video");
  const videos = items.filter((item) => item.mediaType === "video");
  return {
    items,
    images,
    videos,
    hasImage: images.length > 0,
    hasVideo: videos.length > 0,
  };
}

function normalizeVideoClip(item) {
  const duration = item.videoDuration && Number.isFinite(item.videoDuration) ? item.videoDuration : 0;
  const fallbackEnd = item.clipEnd || (item.clipStart || 0) + (state.videoClipDuration || 3);
  const maxEnd = duration > 0 ? duration : Math.max(6, fallbackEnd);
  const start = clamp(item.clipStart || 0, 0, Math.max(0, maxEnd - 0.1));
  const end = clamp(fallbackEnd, start + 0.1, maxEnd);
  item.clipStart = start;
  item.clipEnd = end;
  return { start, end, duration };
}

function dedupeCandidates() {
  const map = new Map();
  state.candidates.forEach((item) => {
    const key = `${item.groupKey || "default"}::${item.dedupeKey || item.originalUrl || item.src || item.id}`;
    if (!map.has(key)) {
      map.set(key, item);
    }
  });
  state.candidates = Array.from(map.values());
}

function getSelectedImages(groupKey = null) {
  return state.candidates.filter(
    (item) =>
      state.selectedCandidateKeys.has(getCandidateKey(item)) &&
      !item.broken &&
      (pageMode === "gif" ? true : item.mediaType !== "video") &&
      (groupKey ? item.groupKey === groupKey : true)
  );
}

function getSelectedGroups() {
  const groups = new Map();
  state.candidates.forEach((item) => {
    if (!state.selectedCandidateKeys.has(getCandidateKey(item)) || item.broken) return;
    if (!groups.has(item.groupKey)) {
      groups.set(item.groupKey, {
        key: item.groupKey,
        label: item.groupLabel || "当前分组",
        sourceUrl: item.sourceUrl || "",
        items: [],
      });
    }
    groups.get(item.groupKey).items.push(item);
  });
  return Array.from(groups.values());
}

function getDownloadTargetGroups(onlyChecked = true) {
  const groups = getSelectedGroups();
  if (!onlyChecked) return groups;
  return groups.filter((group) => state.selectedPreviewGroupKeys.has(group.key));
}

function syncPreviewGroupSelection(groups) {
  const next = new Set(groups.map((group) => group.key));
  const kept = Array.from(state.selectedPreviewGroupKeys).filter((key) => next.has(key));
  state.selectedPreviewGroupKeys = new Set(kept.length ? kept : Array.from(next));
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
    button.disabled = pageMode === "png" || pageMode === "gif";
  });
  elements.pngSettings.classList.toggle("hidden", state.exportMode !== "png");
  elements.gifSettings.classList.toggle("hidden", state.exportMode !== "gif");
  elements.downloadBtn.textContent = state.exportMode === "gif" ? "下载勾选 GIF" : "下载勾选 PNG";
  elements.downloadAllBtn.textContent = state.exportMode === "gif" ? "下载全部 GIF" : "下载全部 PNG";
  elements.emptyPreview.textContent =
    state.exportMode === "gif"
      ? "这里会显示完整动图预览"
      : "这里会显示完整预览";
  updateGifSettingPanels();
}

function updateGifSettingPanels() {
  if (!elements.gifSettings) return;
  const summary = getGifSelectionSummary();
  elements.gifImageSettings?.classList.toggle("hidden", !(state.exportMode === "gif" && summary.hasImage));
  elements.gifVideoSettings?.classList.toggle("hidden", !(state.exportMode === "gif" && summary.hasVideo));
}

function updateGifRepeatButtons() {
  elements.gifRepeatButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.gifRepeatMode === state.gifRepeatMode);
  });
  elements.gifRepeatCountWrap.classList.toggle("hidden", state.gifRepeatMode !== "custom");
}

function updateCandidateFilterButtons() {
  elements.candidateFilterButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.candidateFilter === state.candidateFilter);
  });
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

function loadVideoElement(src) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    if (/^https?:/i.test(String(src || ""))) {
      video.crossOrigin = "anonymous";
    }
    let settled = false;
    const cleanup = () => {
      video.onloadeddata = null;
      video.onloadedmetadata = null;
      video.oncanplay = null;
      video.onerror = null;
    };
    const finish = async () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const previewTime = getVideoPreviewTime(video.duration);
        if (previewTime > 0) {
          await seekVideo(video, previewTime).catch(() => {});
        }
        video.pause();
        resolve(video);
      } catch (error) {
        reject(error);
      }
    };
    video.onloadedmetadata = () => {
      if (video.readyState >= 1) {
        finish();
      }
    };
    video.oncanplay = () => {
      finish();
    };
    video.onloadeddata = () => {
      finish();
    };
    video.onerror = () => {
      settled = true;
      cleanup();
      reject(new Error("视频加载失败"));
    };
    video.src = src;
    video.load();
  });
}

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const safeTime = Math.max(0, Math.min(time, Math.max(0, duration - 0.04)));
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("视频定位失败"));
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = safeTime;
  });
}

function captureVideoFrame(video) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, video.videoWidth || 1);
  canvas.height = Math.max(1, video.videoHeight || 1);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
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
  if (item.mediaType === "video") {
    const video = await loadVideoElement(item.renderSrc || item.directSrc || item.previewSrc || item.src);
    await seekVideo(video, 0);
    return captureVideoFrame(video);
  }
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

async function loadSelectedImages(groupKey = null) {
  return Promise.all(
    getSelectedImages(groupKey).map(async (item) => ({
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
  if (state.candidates[fromIndex].groupKey !== state.candidates[targetIndex].groupKey) return false;

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

function clearGroupPreviewUrls() {
  state.groupPreviewUrls.forEach((url) => {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  });
  state.groupPreviewUrls = [];
}

function bindPreviewRowDrag() {
  elements.previewGallery.querySelectorAll(".preview-group-media-scroll").forEach((track) => {
    let isDown = false;
    let startX = 0;
    let startScrollLeft = 0;

    track.addEventListener("mousedown", (event) => {
      isDown = true;
      startX = event.clientX;
      startScrollLeft = track.scrollLeft;
      track.classList.add("dragging-scroll");
      event.preventDefault();
    });

    track.addEventListener("mousemove", (event) => {
      if (!isDown) return;
      const delta = event.clientX - startX;
      track.scrollLeft = startScrollLeft - delta;
    });

    const stopDrag = () => {
      isDown = false;
      track.classList.remove("dragging-scroll");
    };

    track.addEventListener("mouseleave", stopDrag);
    track.addEventListener("mouseup", stopDrag);
  });
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
  state.modalGroupKey = null;
  clearModalPreviewUrl();
}

function finishPointerDrag(commit = true, clientX = null) {
  if (!state.draggingId) return;
  let targetId = null;
  let position = "before";

  if (typeof clientX === "number") {
    const items = Array.from(elements.candidateGrid.querySelectorAll(".candidate-card"));
    for (const item of items) {
      if (item.dataset.candidateId === state.draggingId) continue;
      const rect = item.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (clientX < mid) {
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
    elements.candidateGrid.innerHTML = "<p>图片会显示在这里</p>";
    return;
  }

  elements.candidateGrid.className = "candidate-list";
  const grouped = new Map();
  const visibleCandidates = state.candidates.filter((item) => {
    if (pageMode === "png" && item.mediaType === "video") return false;
    if (state.candidateFilter === "all") return true;
    return item.mediaType === state.candidateFilter;
  });

  if (!visibleCandidates.length) {
    elements.candidateGrid.className = "candidate-list empty";
    elements.candidateGrid.innerHTML = "<p>当前筛选下没有素材</p>";
    return;
  }

  visibleCandidates.forEach((item) => {
    if (!grouped.has(item.groupKey)) {
      grouped.set(item.groupKey, {
        key: item.groupKey,
        label: item.groupLabel || "当前分组",
        sourceUrl: item.sourceUrl || "",
        items: [],
      });
    }
    grouped.get(item.groupKey).items.push(item);
  });

  const renderItemCard = (item, index) => {
      const candidateKey = getCandidateKey(item);
      const selected = state.selectedCandidateKeys.has(candidateKey);
      const direct = item.directSrc || item.previewSrc || item.src;
      const proxy = item.proxyUrl || item.renderSrc || direct;
      const preferredVideoSrc = item.kind === "local" ? direct : proxy;
      const thumbMarkup =
        item.mediaType === "video"
          ? `
          <div class="candidate-video-shell">
            <video
              class="candidate-thumb candidate-thumb-video"
              src="${escapeHtml(preferredVideoSrc)}"
              data-direct-src="${escapeHtml(direct)}"
              data-proxy-src="${escapeHtml(proxy)}"
              data-candidate-id="${escapeHtml(item.id)}"
              muted
              autoplay
              loop
              playsinline
              preload="metadata"
            ></video>
            <span class="candidate-media-badge">视频</span>
          </div>
          `
          : `
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
          `;
      return `
        <article class="candidate-card ${selected ? "candidate-card-selected" : ""} ${item.broken ? "is-broken" : ""}" data-candidate-id="${escapeHtml(item.id)}">
          <div class="candidate-topline">
            <label class="checkbox">
              <input type="checkbox" data-candidate-key="${escapeHtml(candidateKey)}" ${selected ? "checked" : ""} ${item.broken ? "disabled" : ""} />
              <span>${index + 1}</span>
            </label>
            <div class="candidate-top-actions">
              <button class="mini-btn ghost drag-handle" data-drag-id="${escapeHtml(item.id)}" type="button">拖拽</button>
            </div>
          </div>

          ${thumbMarkup}

          <div class="card-body">
            <div class="selected-controls ${selected ? "" : "hidden"}">
              ${
                item.mediaType === "video"
                  ? `<div class="selected-meta">视频片段请在右侧预览区拖动开始和结束进度条</div>`
                  : `<label class="mini-field">
                      <span>时长</span>
                      <input class="mini-number" type="number" min="0.1" max="20" step="0.1" value="${item.duration}" data-duration-id="${escapeHtml(item.id)}" />
                    </label>`
              }
              <div class="selected-actions">
                <button class="remove-btn" data-remove-id="${escapeHtml(item.id)}" type="button">移除</button>
              </div>
            </div>
          </div>
        </article>
      `;
    };

  elements.candidateGrid.innerHTML = Array.from(grouped.values())
    .map(
      (group) => `
        <section class="candidate-group" data-group-key="${escapeHtml(group.key)}">
          <div class="candidate-group-head">
            <div class="candidate-group-title">
              <strong>${escapeHtml(group.label)}</strong>
              <span class="card-meta">${escapeHtml(group.sourceUrl || `${group.items.length} 张图`)}</span>
            </div>
            <span class="candidate-group-count">${group.items.length} 张</span>
          </div>
          <div class="candidate-group-scroll">
            <div class="candidate-group-grid">
              ${group.items.map((item, index) => renderItemCard(item, index)).join("")}
            </div>
          </div>
        </section>
      `
    )
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
        if (draggingItem?.closest("[data-group-key]") !== target.closest("[data-group-key]")) return;
        const rect = target.getBoundingClientRect();
        const position = moveEvent.clientX < rect.left + rect.width / 2 ? "before" : "after";
        target.classList.add(position === "before" ? "drop-before" : "drop-after");
      };

      const onUp = (upEvent) => {
        document.removeEventListener("mousemove", onMove);
        finishPointerDrag(true, upEvent.clientX);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp, { once: true });
    });
  });

  elements.candidateGrid.querySelectorAll("img.candidate-thumb").forEach((img) => {
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

  elements.candidateGrid.querySelectorAll("video.candidate-thumb-video").forEach((video) => {
    video.addEventListener("loadeddata", async () => {
      try {
        const current = state.candidates.find((item) => item.id === video.dataset.candidateId);
        if (current && Number.isFinite(video.duration) && video.duration > 0) {
          current.videoDuration = video.duration;
          normalizeVideoClip(current);
        }
        await seekVideo(video, getVideoPreviewTime(video.duration));
        video.play().catch(() => {});
      } catch {}
    });
    video.addEventListener("error", () => {
      const current = state.candidates.find((item) => item.id === video.dataset.candidateId);
      if (!current) return;
      if (!video.dataset.triedProxy && video.dataset.proxySrc && video.dataset.proxySrc !== video.dataset.directSrc) {
        video.dataset.triedProxy = "1";
        video.src = video.dataset.proxySrc;
        video.load();
        return;
      }
      current.broken = true;
      state.selectedCandidateKeys.delete(getCandidateKey(current));
      renderCandidates();
    });
  });

  updateGifSettingPanels();
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

async function renderPngPreview(groupKey = null) {
  const canvas = elements.previewCanvas;
  const loaded = await loadSelectedImages(groupKey);
  const previewScale = 1;
  const fullSize = drawPngComposition(document.createElement("canvas"), loaded, 1, 1);
  const previewDisplayScale = getPreviewFitScale(fullSize.logicalWidth, fullSize.logicalHeight);
  const result = drawPngComposition(canvas, loaded, previewScale, previewDisplayScale);

  setStatus(`已生成 1 张拼图，包含 ${result.count} 张图片`);
}

function drawGifFrame(ctx, img, canvasWidth, canvasHeight) {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = state.backgroundColor;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  const innerWidth = canvasWidth - state.padding * 2;
  const innerHeight = canvasHeight - state.padding * 2;
  drawContainedImage(ctx, img, state.padding, state.padding, innerWidth, innerHeight);
}

async function buildGifFrames(groupKey = null) {
  const selected = getSelectedImages(groupKey);
  const frames = [];
  for (const item of selected) {
    if (item.mediaType === "video") {
      const video = await loadVideoElement(item.renderSrc || item.directSrc || item.previewSrc || item.src);
      if (Number.isFinite(video.duration) && video.duration > 0) {
        item.videoDuration = video.duration;
      }
      const clip = normalizeVideoClip(item);
      const videoDuration = clip.duration > 0 ? clip.duration : 1;
      const clipStart = Math.max(0, Math.min(clip.start, Math.max(0, videoDuration - 0.2)));
      const clipDuration = Math.max(
        0.5,
        Math.min(Math.max(0.5, clip.end - clip.start), Math.max(0.5, videoDuration - clipStart))
      );
      const frameCount = Math.max(4, Math.min(18, Math.round(clipDuration * 4)));
      for (let index = 0; index < frameCount; index += 1) {
        const progress = frameCount === 1 ? 0 : index / (frameCount - 1);
        await seekVideo(video, clipStart + progress * clipDuration);
        frames.push({
          item: { ...item, duration: Math.max(0.08, clipDuration / frameCount) },
          img: captureVideoFrame(video),
        });
      }
      continue;
    }
    frames.push({
      item,
      img: await loadRenderableImage(item),
    });
  }
  return frames;
}

function renderVideoClipEditors(groupKey = null) {
  if (!elements.videoClipEditors) return;
  const { videos } = getGifSelectionSummary(groupKey);
  if (!(state.exportMode === "gif" && videos.length)) {
    elements.videoClipEditors.innerHTML = "";
    elements.videoClipEditors.classList.add("hidden");
    return;
  }

  elements.videoClipEditors.innerHTML = videos
    .map((item, index) => {
      const direct = item.directSrc || item.previewSrc || item.src;
      const proxy = item.proxyUrl || item.renderSrc || direct;
      const preferredVideoSrc = item.kind === "local" ? direct : proxy;
      const clip = normalizeVideoClip(item);
      const max = clip.duration > 0 ? clip.duration : Math.max(6, clip.end);
      const clipLength = Math.max(0.1, clip.end - clip.start);
      return `
        <div class="clip-editor-card">
          <div class="clip-editor-head">
            <strong>视频 ${index + 1}</strong>
            <span>${escapeHtml(item.name || "未命名视频")}</span>
          </div>
          <div class="clip-editor-stage">
            <video
              class="clip-editor-video"
              src="${escapeHtml(preferredVideoSrc)}"
              data-direct-src="${escapeHtml(direct)}"
              data-proxy-src="${escapeHtml(proxy)}"
              data-clip-video-id="${escapeHtml(item.id)}"
              controls
              muted
              playsinline
              preload="metadata"
            ></video>
            <button class="mini-btn ghost clip-preview-btn" data-clip-preview-id="${escapeHtml(item.id)}" type="button">预览片段</button>
          </div>
          <div class="clip-editor-labels clip-editor-summary">
            <span data-start-label="${escapeHtml(item.id)}">开始 ${formatSecondsLabel(clip.start)}</span>
            <span data-length-label="${escapeHtml(item.id)}">片段 ${formatSecondsLabel(clipLength)} / 全长 ${formatSecondsLabel(max)}</span>
            <span data-end-label="${escapeHtml(item.id)}">结束 ${formatSecondsLabel(clip.end)}</span>
          </div>
          <div class="clip-editor-track-wrap">
            <div class="clip-editor-track">
              <div class="clip-editor-track-fill" data-clip-fill="${escapeHtml(item.id)}"></div>
            </div>
            <input class="clip-range clip-range-start" type="range" min="0" max="${max}" step="0.1" value="${clip.start}" data-clip-start-id="${escapeHtml(item.id)}" />
            <input class="clip-range clip-range-end" type="range" min="0.1" max="${max}" step="0.1" value="${clip.end}" data-clip-end-id="${escapeHtml(item.id)}" />
          </div>
          <div class="clip-editor-foot">
            <span class="clip-editor-tip">拖动两端进度条，决定 GIF 从哪开始、到哪结束</span>
            <button class="mini-btn ghost" data-clip-reset-id="${escapeHtml(item.id)}" type="button">重置片段</button>
          </div>
        </div>
      `;
    })
    .join("");
  elements.videoClipEditors.classList.remove("hidden");

  const syncClipUI = (item) => {
    const clip = normalizeVideoClip(item);
    const selectorId = CSS.escape(item.id);
    const startLabel = elements.videoClipEditors.querySelector(`[data-start-label="${selectorId}"]`);
    const endLabel = elements.videoClipEditors.querySelector(`[data-end-label="${selectorId}"]`);
    const lengthLabel = elements.videoClipEditors.querySelector(`[data-length-label="${selectorId}"]`);
    const startInput = elements.videoClipEditors.querySelector(`[data-clip-start-id="${selectorId}"]`);
    const endInput = elements.videoClipEditors.querySelector(`[data-clip-end-id="${selectorId}"]`);
    const fill = elements.videoClipEditors.querySelector(`[data-clip-fill="${selectorId}"]`);
    const max = clip.duration > 0 ? clip.duration : Math.max(6, clip.end);
    if (startLabel) startLabel.textContent = `开始 ${formatSecondsLabel(clip.start)}`;
    if (endLabel) endLabel.textContent = `结束 ${formatSecondsLabel(clip.end)}`;
    if (lengthLabel) {
      lengthLabel.textContent = `片段 ${formatSecondsLabel(Math.max(0.1, clip.end - clip.start))} / 全长 ${formatSecondsLabel(max)}`;
    }
    if (startInput) {
      startInput.max = String(max);
      startInput.value = String(clip.start);
    }
    if (endInput) {
      endInput.max = String(max);
      endInput.value = String(clip.end);
    }
    if (fill) {
      const left = max > 0 ? (clip.start / max) * 100 : 0;
      const width = max > 0 ? ((clip.end - clip.start) / max) * 100 : 100;
      fill.style.left = `${left}%`;
      fill.style.width = `${Math.max(0, width)}%`;
    }
  };

  elements.videoClipEditors.querySelectorAll(".clip-editor-video").forEach((video) => {
    video.addEventListener("loadedmetadata", () => {
      const item = state.candidates.find((entry) => entry.id === video.dataset.clipVideoId);
      if (!item) return;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        item.videoDuration = video.duration;
      }
      syncClipUI(item);
      try {
        video.currentTime = getVideoPreviewTime(video.duration);
      } catch {}
    });
    video.addEventListener("timeupdate", () => {
      const item = state.candidates.find((entry) => entry.id === video.dataset.clipVideoId);
      if (!item) return;
      const clip = normalizeVideoClip(item);
      if (!video.paused && video.currentTime >= clip.end - 0.02) {
        video.pause();
        try {
          video.currentTime = clip.start;
        } catch {}
      }
    });
    video.addEventListener("error", () => {
      if (!video.dataset.triedProxy && video.dataset.proxySrc && video.dataset.proxySrc !== video.dataset.directSrc) {
        video.dataset.triedProxy = "1";
        video.src = video.dataset.proxySrc;
        video.load();
      }
    });
  });

  elements.videoClipEditors.querySelectorAll("[data-clip-start-id]").forEach((input) => {
    input.addEventListener("input", () => {
      const item = state.candidates.find((entry) => entry.id === input.dataset.clipStartId);
      if (!item) return;
      item.clipStart = Number.parseFloat(input.value) || 0;
      if (item.clipEnd <= item.clipStart + 0.1) item.clipEnd = item.clipStart + 0.1;
      syncClipUI(item);
      const selectorId = CSS.escape(item.id);
      const video = elements.videoClipEditors.querySelector(`[data-clip-video-id="${selectorId}"]`);
      if (video) {
        try {
          video.currentTime = item.clipStart;
        } catch {}
      }
    });
    input.addEventListener("change", () => {
      renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    });
  });

  elements.videoClipEditors.querySelectorAll("[data-clip-end-id]").forEach((input) => {
    input.addEventListener("input", () => {
      const item = state.candidates.find((entry) => entry.id === input.dataset.clipEndId);
      if (!item) return;
      item.clipEnd = Number.parseFloat(input.value) || item.clipEnd;
      if (item.clipEnd <= item.clipStart + 0.1) item.clipEnd = item.clipStart + 0.1;
      syncClipUI(item);
      const selectorId = CSS.escape(item.id);
      const video = elements.videoClipEditors.querySelector(`[data-clip-video-id="${selectorId}"]`);
      if (video && video.currentTime > item.clipEnd) {
        try {
          video.currentTime = item.clipEnd;
        } catch {}
      }
    });
    input.addEventListener("change", () => {
      renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    });
  });

  elements.videoClipEditors.querySelectorAll("[data-clip-preview-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = state.candidates.find((entry) => entry.id === button.dataset.clipPreviewId);
      if (!item) return;
      const selectorId = CSS.escape(item.id);
      const video = elements.videoClipEditors.querySelector(`[data-clip-video-id="${selectorId}"]`);
      if (!video) return;
      const clip = normalizeVideoClip(item);
      try {
        video.pause();
        video.currentTime = clip.start;
        await video.play();
      } catch {}
    });
  });

  elements.videoClipEditors.querySelectorAll("[data-clip-reset-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.candidates.find((entry) => entry.id === button.dataset.clipResetId);
      if (!item) return;
      const duration = Number.isFinite(item.videoDuration) && item.videoDuration > 0 ? item.videoDuration : 0;
      item.clipStart = 0;
      item.clipEnd = duration > 0 ? Math.max(0.5, Math.min(duration, 3)) : 3;
      syncClipUI(item);
      renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    });
  });
}

async function renderGifPreview(groupKey = null) {
  const gifBlob = await generateGifBlob(groupKey, false);
  clearGifPreviewUrl();
  state.gifPreviewUrl = URL.createObjectURL(gifBlob);
  elements.previewGif.src = state.gifPreviewUrl;
  elements.previewGif.style.width = "";
  elements.previewGif.style.height = "";
  elements.previewGif.style.display = "block";
  elements.previewGif.classList.remove("hidden");
  elements.previewCanvas.style.display = "none";
  setStatus(`已生成 1 张 GIF，包含 ${getSelectedImages(groupKey).length} 帧`);
}

async function renderPreview() {
  const groups = getSelectedGroups();
  renderVideoClipEditors();
  syncPreviewGroupSelection(groups);
  if (!groups.length) {
    elements.previewCanvas.style.display = "none";
    elements.previewGif.style.display = "none";
    elements.previewGif.classList.add("hidden");
    elements.previewGallery.innerHTML = "";
    elements.previewGallery.classList.add("hidden");
    elements.videoClipEditors.innerHTML = "";
    elements.videoClipEditors.classList.add("hidden");
    clearGifPreviewUrl();
    clearGroupPreviewUrls();
    closePreviewModal();
    elements.emptyPreview.style.display = "grid";
    return;
  }

  setStatus("正在生成预览…");
  if (groups.length === 1) {
    elements.previewGallery.innerHTML = "";
    elements.previewGallery.classList.add("hidden");
    clearGroupPreviewUrls();
    if (state.exportMode === "gif") {
      await renderGifPreview(groups[0].key);
    } else {
      clearGifPreviewUrl();
      elements.previewGif.style.display = "none";
      elements.previewGif.classList.add("hidden");
      await renderPngPreview(groups[0].key);
      elements.previewCanvas.style.display = "block";
    }
    elements.emptyPreview.style.display = "none";
    return;
  }

  elements.previewCanvas.style.display = "none";
  elements.previewGif.style.display = "none";
  elements.previewGif.classList.add("hidden");
  clearGifPreviewUrl();
  clearGroupPreviewUrls();

  const cards = [];
  for (const group of groups) {
    const blob =
      state.exportMode === "gif" ? await generateGifBlob(group.key, false) : await generatePngBlob(group.key);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    state.groupPreviewUrls.push(url);
    const checked = state.selectedPreviewGroupKeys.has(group.key);
    cards.push(`
      <article class="preview-group-card" data-group-key="${escapeHtml(group.key)}">
        <div class="preview-group-head">
          <label class="checkbox preview-group-check">
            <input type="checkbox" data-preview-group-key="${escapeHtml(group.key)}" ${checked ? "checked" : ""} />
            <strong>${escapeHtml(group.label)}</strong>
          </label>
          <div class="preview-group-actions">
            <button type="button" class="mini-btn ghost" data-open-group="${escapeHtml(group.key)}">放大</button>
            <button type="button" class="mini-btn ghost" data-download-group="${escapeHtml(group.key)}">下载</button>
          </div>
        </div>
        <div class="preview-group-media-scroll">
          <div class="preview-group-media">
          <img src="${escapeHtml(url)}" alt="${escapeHtml(group.label)} 预览" data-open-group="${escapeHtml(group.key)}" />
          </div>
        </div>
      </article>
    `);
  }

  elements.previewGallery.innerHTML = cards.join("");
  elements.previewGallery.classList.toggle("is-gif-gallery", state.exportMode === "gif");
  elements.previewGallery.classList.remove("hidden");
  elements.previewGallery.querySelectorAll("[data-open-group]").forEach((node) => {
    node.addEventListener("click", () => {
      openPreviewModal(node.dataset.openGroup).catch((error) => setStatus(`高清预览失败：${error.message}`));
    });
  });
  elements.previewGallery.querySelectorAll("[data-preview-group-key]").forEach((node) => {
    node.addEventListener("change", () => {
      const key = node.dataset.previewGroupKey;
      if (!key) return;
      if (node.checked) state.selectedPreviewGroupKeys.add(key);
      else state.selectedPreviewGroupKeys.delete(key);
    });
  });
  elements.previewGallery.querySelectorAll("[data-download-group]").forEach((node) => {
    node.addEventListener("click", () => {
      downloadCurrentOutput(node.dataset.downloadGroup).catch((error) => setStatus(`导出失败：${error.message}`));
    });
  });
  bindPreviewRowDrag();

  setStatus(`已生成 ${cards.length} 张${state.exportMode === "gif" ? " GIF" : "拼图"}，按链接分开展示`);
  elements.emptyPreview.style.display = "none";
}

async function generateGifBlob(groupKey = null, showProgress = true) {
  const frames = await buildGifFrames(groupKey);
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

async function generatePngBlob(groupKey = null) {
  return new Promise((resolve) => {
    const exportCanvas = document.createElement("canvas");
    loadSelectedImages(groupKey)
      .then((loaded) => {
        drawPngComposition(exportCanvas, loaded, state.pngScale, 1);
        exportCanvas.toBlob(resolve, "image/png");
      })
      .catch(() => resolve(null));
  });
}

async function openPreviewModal(groupKey = null) {
  const selectedImages = getSelectedImages(groupKey);
  if (!selectedImages.length) {
    setStatus("没有可预览的大图");
    return;
  }

  clearModalPreviewUrl();
  let blob = null;
  if (state.exportMode === "gif") {
    blob = await generateGifBlob(groupKey, false);
  } else {
    blob = await generatePngBlob(groupKey);
  }

  if (!blob) {
    setStatus("高清预览生成失败");
    return;
  }

  state.modalPreviewUrl = URL.createObjectURL(blob);
  state.modalGroupKey = groupKey;
  elements.modalPreviewImage.src = state.modalPreviewUrl;
  elements.previewModal.classList.remove("hidden");
  elements.previewModal.setAttribute("aria-hidden", "false");
}

async function downloadCurrentOutput(groupKey = null, withStatus = true) {
  const selectedImages = getSelectedImages(groupKey);
  if (!selectedImages.length) {
    if (withStatus) setStatus("没有可下载的结果");
    return;
  }

  if (state.exportMode === "gif") {
    try {
      const blob = await generateGifBlob(groupKey);
      downloadBlob(blob, buildDownloadFilename(groupKey));
      if (withStatus) setStatus(`GIF 已开始下载，共 ${selectedImages.length} 帧`);
    } catch (error) {
      if (withStatus) setStatus(`GIF 生成失败：${error.message}`);
    }
    return;
  }

  const blob = await generatePngBlob(groupKey);
  if (!blob) {
    if (withStatus) setStatus("PNG 导出失败");
    return;
  }
  downloadBlob(blob, buildDownloadFilename(groupKey));
  if (withStatus) setStatus("PNG 已开始下载");
}

function addLocalFiles(fileList) {
  const files = Array.from(fileList).filter(
    (file) => file.type.startsWith("image/") || file.type.startsWith("video/")
  );
  if (!files.length) {
    setStatus("没有检测到可用图片或视频文件");
    return;
  }

  files.forEach((file) => {
    const objectUrl = URL.createObjectURL(file);
    const mediaType = file.type.startsWith("video/") ? "video" : "image";
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
      groupKey: "local-upload",
      groupLabel: "本地上传",
      sourceUrl: "",
      selectionKey: `local-upload::${objectUrl}`,
      mediaType,
      fileType: file.type,
      clipStart: 0,
      clipEnd: mediaType === "video" ? 3 : 0,
    });
    state.candidates.push(candidate);
    state.selectedCandidateKeys.add(candidate.selectionKey);
  });

  dedupeCandidates();
  renderCandidates();
  renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
  setStatus(`已添加 ${files.length} 个本地素材`);
}

async function extractImagesFromPage() {
  const urlList = parseUrlList(elements.pageUrl.value);
  if (!urlList.length) {
    setStatus("请先输入至少一个网页链接");
    return;
  }

  elements.extractBtn.disabled = true;
  setStatus(
    urlList.some((item) => item.toLowerCase().includes("tiktok.com"))
      ? `正在批量提取 ${urlList.length} 个链接，其中包含 TikTok，可能会慢一点`
      : `正在批量提取 ${urlList.length} 个链接…`
  );

  try {
    const mergedCandidates = [];
    const failures = [];

    for (let index = 0; index < urlList.length; index += 1) {
      const value = urlList[index];
      setStatus(`正在提取第 ${index + 1}/${urlList.length} 个链接…`);
      let { response, data } = await requestExtract(value);
      const shouldRetry =
        !response.ok &&
        /(tiktok\.com|instagram\.com|xiaohongshu\.com)/i.test(value);

      if (shouldRetry) {
        setStatus(`第 ${index + 1} 个链接第一次失败，正在自动重试…`);
        await new Promise((resolve) => setTimeout(resolve, 900));
        ({ response, data } = await requestExtract(value));
      }

      if (!response.ok) {
        failures.push(getExtractErrorMessage(value, data, "提取失败"));
        continue;
      }

      const groupLabel = `链接 ${index + 1}`;
      const batch = mapImagesToCandidates(data.images, value, groupLabel, value, index);
      mergedCandidates.push(...batch);
    }

    state.candidates = mergedCandidates;
    dedupeCandidates();
    state.selectedCandidateKeys = new Set(state.candidates.map((item) => item.selectionKey));
    renderCandidates();
    renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    if (!state.candidates.length) {
      throw new Error(failures[0] || "没有提取到可用图片");
    }
    const failureText = failures.length ? `，${failures.length} 个链接提取失败` : "";
    setStatus(`已提取 ${urlList.length - failures.length} 组链接图片，共 ${state.candidates.length} 张${failureText}`);
  } catch (error) {
    setStatus(`提取失败：${error.message}`);
  } finally {
    elements.extractBtn.disabled = false;
  }
}

async function startAssistExtract() {
  const urlList = parseUrlList(elements.pageUrl.value);
  if (urlList.length !== 1) {
    setStatus("辅助提图一次只支持 1 个链接");
    return;
  }

  const targetUrl = urlList[0];
  elements.assistExtractBtn.disabled = true;
  try {
    const response = await fetch(`/extract-assisted/start?url=${encodeURIComponent(targetUrl)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "辅助提图启动失败");
    }
    state.assistSessionId = data.sessionId;
    updateAssistButtons();
    setStatus("已打开辅助浏览器。请在新窗口完成登录、验证或手动打开图片页，然后回来点“继续识别”");
  } catch (error) {
    setStatus(`辅助提图启动失败：${error.message}`);
  } finally {
    elements.assistExtractBtn.disabled = false;
  }
}

async function finishAssistExtract() {
  if (!state.assistSessionId) {
    setStatus("当前没有进行中的辅助提图");
    return;
  }

  elements.assistFinishBtn.disabled = true;
  try {
    const response = await fetch(`/extract-assisted/finish?sessionId=${encodeURIComponent(state.assistSessionId)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "辅助提图失败");
    }
    const sourceUrl = parseUrlList(elements.pageUrl.value)[0] || data.pageUrl || "辅助提图";
    state.candidates = mapImagesToCandidates(data.images || [], sourceUrl, "辅助提图", sourceUrl, 0);
    dedupeCandidates();
    state.selectedCandidateKeys = new Set(state.candidates.map((item) => item.selectionKey));
    state.assistSessionId = null;
    updateAssistButtons();
    renderCandidates();
    renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    setStatus(`辅助提图成功，已识别 ${state.candidates.length} 张图片`);
  } catch (error) {
    setStatus(`继续识别失败：${error.message}`);
  } finally {
    elements.assistFinishBtn.disabled = false;
  }
}

async function cancelAssistExtract() {
  if (!state.assistSessionId) return;
  const sessionId = state.assistSessionId;
  state.assistSessionId = null;
  updateAssistButtons();
  try {
    await fetch(`/extract-assisted/cancel?sessionId=${encodeURIComponent(sessionId)}`);
  } catch {}
  setStatus("已取消辅助提图");
}

function clearAll() {
  state.candidates.forEach((item) => {
    if (item.kind === "local" && item.previewSrc.startsWith("blob:")) {
      URL.revokeObjectURL(item.previewSrc);
    }
  });
  state.candidates = [];
  state.selectedCandidateKeys.clear();
  state.selectedPreviewGroupKeys.clear();
  clearGroupPreviewUrls();
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

function buildDownloadFilename(groupKey = null) {
  const ext = state.exportMode === "gif" ? "gif" : "png";
  if (!groupKey) {
    return `collage-${state.layout}-${Date.now()}.${ext}`;
  }
  const group = getSelectedGroups().find((item) => item.key === groupKey);
  const safeLabel = String(group?.label || "result")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return `${safeLabel || "result"}-${Date.now()}.${ext}`;
}

async function downloadMultipleOutputs(groups) {
  if (!groups.length) {
    setStatus("没有可下载的结果");
    return;
  }
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    setStatus(`正在下载 ${index + 1}/${groups.length}…`);
    await downloadCurrentOutput(group.key, false);
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  setStatus(`已开始下载 ${groups.length} 个结果`);
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
  elements.assistExtractBtn.addEventListener("click", () => {
    startAssistExtract().catch((error) => setStatus(`辅助提图启动失败：${error.message}`));
  });
  elements.assistFinishBtn.addEventListener("click", () => {
    finishAssistExtract().catch((error) => setStatus(`继续识别失败：${error.message}`));
  });
  elements.assistCancelBtn.addEventListener("click", () => {
    cancelAssistExtract().catch((error) => setStatus(`取消辅助失败：${error.message}`));
  });
  elements.clearBtn.addEventListener("click", clearAll);
  elements.renderBtn.addEventListener("click", () => {
    renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
  });
  elements.downloadBtn.addEventListener("click", () => {
    const groups = getSelectedGroups();
    if (groups.length <= 1) {
      downloadCurrentOutput(groups[0]?.key ?? null).catch((error) => setStatus(`导出失败：${error.message}`));
      return;
    }
    downloadMultipleOutputs(getDownloadTargetGroups(true)).catch((error) => setStatus(`导出失败：${error.message}`));
  });
  elements.downloadAllBtn.addEventListener("click", () => {
    const groups = getSelectedGroups();
    if (groups.length <= 1) {
      downloadCurrentOutput(groups[0]?.key ?? null).catch((error) => setStatus(`导出失败：${error.message}`));
      return;
    }
    downloadMultipleOutputs(getDownloadTargetGroups(false)).catch((error) => setStatus(`导出失败：${error.message}`));
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
    downloadCurrentOutput(state.modalGroupKey).catch((error) => setStatus(`导出失败：${error.message}`));
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
    if (state.exportMode === "gif" && getGifSelectionSummary().hasImage) {
      renderPreview().catch((error) => setStatus(`预览失败：${error.message}`));
    }
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
      if (item.mediaType !== "video") item.duration = state.defaultGifDuration;
    });
    renderCandidates();
    setStatus("已把默认 GIF 速度应用到当前勾选图片");
  });

  elements.pageUrl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      extractImagesFromPage();
    }
  });

  elements.candidateFilterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.candidateFilter = button.dataset.candidateFilter || "all";
      updateCandidateFilterButtons();
      renderCandidates();
    });
  });
}

function init() {
  state.exportMode = pageMode;
  updateRangeLabels();
  updateLayoutButtons();
  updateExportModeButtons();
  updatePngScaleButtons();
  updateGifRepeatButtons();
  updateCandidateFilterButtons();
  updateAssistButtons();
  elements.gifBackgroundColor.value = state.backgroundColor;
  renderCandidates();
  bindEvents();

  if (pageMode === "png") {
    document.title = "拼图工具";
    const title = document.querySelector(".panel-title h2");
    if (title) title.textContent = "拼图设置";
    const uploadText = elements.dropZone?.querySelector("p");
    const uploadHint = elements.dropZone?.querySelector("span");
    if (uploadText) uploadText.textContent = "上传图片";
    if (uploadHint) uploadHint.textContent = "拖拽或点击选择，只用于拼图";
  } else {
    document.title = "转 GIF 工具";
    const title = document.querySelector(".panel-title h2");
    if (title) title.textContent = "转 GIF 设置";
  }
}

init();
