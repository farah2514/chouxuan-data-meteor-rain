import { GIFEncoder, quantize, applyPalette } from "../node_modules/gifenc/dist/gifenc.esm.js";

const pageParams = new URLSearchParams(window.location.search);
const pageMode = pageParams.get("mode") === "gif" ? "gif" : "png";

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
  gifPreviewTimer: null,
  previewDirty: false,
};

const elements = {
  fileInput: document.getElementById("fileInput"),
  dropZone: document.getElementById("dropZone"),
  pageUrl: document.getElementById("pageUrl"),
  itemIdInput: document.getElementById("itemIdInput"),
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
  gifBackgroundColor: document.getElementById("gifBackgroundColor"),
  gifWidthInput: document.getElementById("gifWidthInput"),
  gifHeightInput: document.getElementById("gifHeightInput"),
  gifImageSettings: document.getElementById("gifImageSettings"),
  gifVideoSettings: document.getElementById("gifVideoSettings"),
  videoTrimPanel: document.getElementById("videoTrimPanel"),
  trimPreviewVideo: document.getElementById("trimPreviewVideo"),
  trimStartRange: document.getElementById("trimStartRange"),
  trimEndRange: document.getElementById("trimEndRange"),
  trimTimelineTrack: document.getElementById("trimTimelineTrack"),
  trimSelectionWindow: document.getElementById("trimSelectionWindow"),
  trimStartHandle: document.getElementById("trimStartHandle"),
  trimEndHandle: document.getElementById("trimEndHandle"),
  trimPlayButton: document.getElementById("trimPlayButton"),
  trimStartLabel: document.getElementById("trimStartLabel"),
  trimDurationLabel: document.getElementById("trimDurationLabel"),
  trimEndLabel: document.getElementById("trimEndLabel"),
  gifDurationInput: document.getElementById("gifDurationInput"),
  gifVideoStartInput: document.getElementById("gifVideoStartInput"),
  gifVideoClipInput: document.getElementById("gifVideoClipInput"),
  gifRepeatCountWrap: document.getElementById("gifRepeatCountWrap"),
  gifRepeatCountInput: document.getElementById("gifRepeatCountInput"),
  applyGifDurationBtn: document.getElementById("applyGifDurationBtn"),
  renderBtn: document.getElementById("renderBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  downloadAllBtn: document.getElementById("downloadAllBtn"),
  downloadVideoBtn: document.getElementById("downloadVideoBtn"),
  previewCanvas: document.getElementById("previewCanvas"),
  previewGif: document.getElementById("previewGif"),
  previewVideo: document.getElementById("previewVideo"),
  previewGallery: document.getElementById("previewGallery"),
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

function resetPreviewArea(emptyText = null) {
  if (emptyText) {
    elements.emptyPreview.textContent = emptyText;
  }
  elements.previewCanvas.style.display = "none";
  elements.previewGif.style.display = "none";
  elements.previewGif.classList.add("hidden");
  clearVideoPreview();
  elements.previewGallery.innerHTML = "";
  elements.previewGallery.classList.add("hidden");
  clearGifPreviewUrl();
  clearGroupPreviewUrls();
  closePreviewModal();
  elements.emptyPreview.style.display = "grid";
}

function markPreviewDirty(message = null) {
  state.previewDirty = true;
  resetPreviewArea(state.exportMode === "gif" ? "这里会显示完整动图预览" : "这里会显示完整预览");
  if (message) {
    setStatus(message);
    return;
  }
  if (!getSelectedImages().length) {
    setStatus("请先勾选素材，再点“刷新预览”");
    return;
  }
  setStatus("已更新设置，点“刷新预览”查看结果");
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

function formatTimeLabel(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  return `${safe.toFixed(1)}s`;
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

function getVideoSourceCandidates(item) {
  if (item?.mediaType === "video") {
    return [...new Set([item.localVideoUrl, item.browserDirectVideoUrl].filter(Boolean))];
  }
  return [...new Set([item.localVideoUrl, item.directSrc, item.previewSrc, item.renderSrc, item.proxyUrl, item.src].filter(Boolean))];
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

function normalizeTikTokItemId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const fromUrlMatch = text.match(/\/video\/([A-Za-z0-9_-]+)/i);
  if (fromUrlMatch) {
    return fromUrlMatch[1].trim();
  }
  return text.replace(/^[^A-Za-z0-9_-]+|[^A-Za-z0-9_-]+$/g, "");
}

function parseItemIdList(rawValue) {
  return Array.from(
    new Set(
      String(rawValue || "")
        .split(/[\n,]+/)
        .map((item) => normalizeTikTokItemId(item))
        .filter(Boolean)
    )
  );
}

function buildTikTokItemUrl(itemId) {
  return `https://www.tiktok.com/@revolve/video/${itemId}`;
}

function buildMergedUrlList() {
  const directUrls = parseUrlList(elements.pageUrl.value);
  const itemUrls = parseItemIdList(elements.itemIdInput?.value).map((itemId) => buildTikTokItemUrl(itemId));
  return Array.from(new Set([...directUrls, ...itemUrls]));
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
      posterUrl: item.posterUrl || "",
    })
  );
}

async function requestExtract(url) {
  const response = await fetch(`/extract?url=${encodeURIComponent(url)}`);
  const data = await response.json();
  return { response, data };
}

async function requestTikTokVideoFallback(url) {
  const response = await fetch("https://mintapi.dev/api/tools/tiktok-video-downloader", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ url }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `TikTok 视频兜底失败：${response.status}`);
  }

  const videoUrl =
    data?.links?.noWatermark ||
    data?.links?.hd ||
    data?.links?.watermark ||
    data?.raw?.data?.play ||
    data?.raw?.data?.hdplay ||
    data?.raw?.data?.wmplay ||
    "";
  const posterUrl =
    data?.cover ||
    data?.raw?.data?.cover ||
    data?.raw?.data?.origin_cover ||
    data?.raw?.data?.ai_dynamic_cover ||
    "";
  if (!videoUrl) {
    throw new Error("TikTok 视频兜底未返回可用地址");
  }

  return {
    pageUrl: url,
    count: 1,
    postType: "video",
    images: [
      {
        url: videoUrl,
        source: "fallback:mintapi-browser",
        mediaType: "video",
        posterUrl,
        identity: videoUrl,
      },
    ],
    methodsUsed: ["mintapi-browser-fallback"],
  };
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
    posterUrl: base.posterUrl || "",
    localVideoUrl: base.localVideoUrl || "",
    browserDirectVideoUrl: base.browserDirectVideoUrl || "",
    videoDownloadPromise: null,
    broken: false,
  };
}

async function ensureLocalVideoUrl(item) {
  if (!item || item.mediaType !== "video") return "";
  if (item.localVideoUrl) return item.localVideoUrl;
  if (item.videoDownloadPromise) return item.videoDownloadPromise;

  const downloadUrl = item.originalUrl || item.directSrc || item.previewSrc || item.src;
  const sources = [downloadUrl ? `/download-media?url=${encodeURIComponent(downloadUrl)}` : ""].filter(Boolean);
  item.videoDownloadPromise = (async () => {
    let lastError = null;
    setStatus("正在下载视频，完成后再生成预览…");
    for (const src of sources) {
      try {
        const response = await fetch(src);
        if (!response.ok) {
          throw new Error(`视频下载失败：${response.status}`);
        }
        const blob = await response.blob();
        if (!(blob instanceof Blob) || !blob.size) {
          throw new Error("视频下载失败");
        }
        const objectUrl = URL.createObjectURL(blob);
        item.localVideoUrl = objectUrl;
        setStatus("视频下载完成，正在生成预览…");
        return objectUrl;
      } catch (error) {
        lastError = error;
      }
    }
    if (downloadUrl) {
      try {
        setStatus("服务器下载失败，正在尝试浏览器直连视频…");
        const response = await fetch(downloadUrl);
        if (!response.ok) {
          throw new Error(`视频下载失败：${response.status}`);
        }
        const blob = await response.blob();
        if (!(blob instanceof Blob) || !blob.size) {
          throw new Error("视频下载失败");
        }
        const objectUrl = URL.createObjectURL(blob);
        item.localVideoUrl = objectUrl;
        item.browserDirectVideoUrl = downloadUrl;
        setStatus("浏览器直连成功，正在生成预览…");
        return objectUrl;
      } catch (error) {
        lastError = error;
      }
      item.browserDirectVideoUrl = downloadUrl;
      setStatus("服务器下载失败，正在尝试直接预览视频…");
      return downloadUrl;
    }
    throw lastError || new Error("视频下载失败");
  })();

  try {
    return await item.videoDownloadPromise;
  } finally {
    item.videoDownloadPromise = null;
  }
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
  });
  elements.pngSettings.classList.toggle("hidden", state.exportMode !== "png");
  elements.gifSettings.classList.toggle("hidden", state.exportMode !== "gif");
  elements.downloadBtn.textContent = state.exportMode === "gif" ? "下载勾选 GIF" : "下载勾选 PNG";
  elements.downloadAllBtn.textContent = state.exportMode === "gif" ? "下载全部 GIF" : "下载全部 PNG";
  elements.emptyPreview.textContent =
    state.exportMode === "gif"
      ? "这里会显示完整动图预览"
      : "这里会显示完整预览";
  updateVideoDownloadButton();
}

function updateGifRepeatButtons() {
  elements.gifRepeatButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.gifRepeatMode === state.gifRepeatMode);
  });
  elements.gifRepeatCountWrap.classList.toggle("hidden", state.gifRepeatMode !== "custom");
}

function updateGifMediaSettingsVisibility() {
  const selected = getSelectedImages();
  const hasSelection = selected.length > 0;
  const hasImage = selected.some((item) => item.mediaType !== "video");
  const hasVideo = selected.some((item) => item.mediaType === "video");
  elements.gifImageSettings?.classList.toggle("hidden", hasSelection && !hasImage);
  elements.gifVideoSettings?.classList.toggle("hidden", hasSelection && !hasVideo);
  updateVideoDownloadButton();
}

function updateVideoDownloadButton() {
  if (!elements.downloadVideoBtn) return;
  const selectedVideos = getSelectedImages().filter((item) => item.mediaType === "video");
  const visible = state.exportMode === "gif" && selectedVideos.length > 0;
  elements.downloadVideoBtn.classList.toggle("hidden", !visible);
  elements.downloadVideoBtn.textContent =
    selectedVideos.length > 1 ? `保存勾选MP4（${selectedVideos.length}个）` : "保存勾选MP4";
}

function syncTrimLabels(start, end) {
  if (elements.trimStartLabel) elements.trimStartLabel.textContent = formatClockLabel(start);
  if (elements.trimEndLabel) elements.trimEndLabel.textContent = `结束 ${formatClockLabel(end)}`;
  if (elements.trimDurationLabel) elements.trimDurationLabel.textContent = formatClockLabel(end - start);
}

function formatClockLabel(value) {
  const total = Math.max(0, Math.floor(Number(value || 0)));
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function syncTrimTimelineVisual(start, end, duration) {
  if (!elements.trimTimelineTrack) return;
  const safeDuration = Math.max(0.5, Number(duration) || 0.5);
  const startPercent = `${(Math.max(0, start) / safeDuration) * 100}%`;
  const endPercent = `${(Math.max(0, end) / safeDuration) * 100}%`;
  elements.trimTimelineTrack.style.setProperty("--trim-start-percent", startPercent);
  elements.trimTimelineTrack.style.setProperty("--trim-end-percent", endPercent);
}

async function updateVideoTrimUI() {
  if (!elements.videoTrimPanel || !elements.trimPreviewVideo) return;
  const selected = getSelectedImages();
  const videoItem = selected.length === 1 && selected[0].mediaType === "video" ? selected[0] : null;
  if (!videoItem || state.exportMode !== "gif") {
    elements.videoTrimPanel.classList.add("hidden");
    elements.trimPreviewVideo.pause();
    elements.trimPreviewVideo.removeAttribute("src");
    elements.trimPreviewVideo.load();
    return;
  }

  elements.videoTrimPanel.classList.remove("hidden");
  let src = "";
  try {
    src = await ensureLocalVideoUrl(videoItem);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "视频下载失败");
  }
  if (!src) {
    elements.videoTrimPanel.classList.add("hidden");
    return;
  }
  if (elements.trimPreviewVideo.dataset.src !== src) {
    elements.trimPreviewVideo.dataset.src = src;
    elements.trimPreviewVideo.src = src;
    elements.trimPreviewVideo.load();
  }

  const applyTrim = () => {
    const duration = Number.isFinite(elements.trimPreviewVideo.duration) && elements.trimPreviewVideo.duration > 0
      ? elements.trimPreviewVideo.duration
      : Math.max(state.videoClipStart + state.videoClipDuration, 3);
    const maxDuration = Math.max(0.5, duration);
    const start = clamp(state.videoClipStart, 0, Math.max(0, maxDuration - 0.5));
    const end = clamp(start + state.videoClipDuration, start + 0.5, maxDuration);
    state.videoClipStart = start;
    state.videoClipDuration = Math.max(0.5, end - start);
    elements.gifVideoStartInput.value = Number(state.videoClipStart.toFixed(1));
    elements.gifVideoClipInput.value = Number(state.videoClipDuration.toFixed(1));
    elements.trimStartRange.max = String(maxDuration);
    elements.trimEndRange.max = String(maxDuration);
    elements.trimStartRange.value = String(start);
    elements.trimEndRange.value = String(end);
    syncTrimLabels(start, end);
    syncTrimTimelineVisual(start, end, maxDuration);
    elements.trimPreviewVideo.ontimeupdate = () => {
      if (elements.trimPreviewVideo.currentTime >= end) {
        elements.trimPreviewVideo.currentTime = start;
        elements.trimPreviewVideo.play().catch(() => {});
      }
    };
    if (Math.abs(elements.trimPreviewVideo.currentTime - start) > 0.12) {
      elements.trimPreviewVideo.currentTime = start;
    }
  };

  if (Number.isFinite(elements.trimPreviewVideo.duration) && elements.trimPreviewVideo.duration > 0) {
    applyTrim();
    elements.trimPreviewVideo.play().catch(() => {});
    return;
  }

  elements.trimPreviewVideo.onloadedmetadata = () => {
    applyTrim();
    elements.trimPreviewVideo.play().catch(() => {});
  };
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
    video.crossOrigin = "anonymous";
    const cleanup = () => {
      video.onloadeddata = null;
      video.onerror = null;
    };
    video.onloadeddata = () => {
      cleanup();
      resolve(video);
    };
    video.onerror = () => {
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
    let lastError = null;
    try {
      await ensureLocalVideoUrl(item);
    } catch (error) {
      lastError = error;
    }
    for (const src of getVideoSourceCandidates(item)) {
      try {
        const video = await loadVideoElement(src);
        await seekVideo(video, 0);
        return captureVideoFrame(video);
      } catch (error) {
        lastError = error;
      }
    }
    if (item.posterUrl) {
      try {
        return await loadImageWithOptions(item.posterUrl, { src: item.posterUrl });
      } catch {}
    }
    throw lastError || new Error("视频加载失败");
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
  markPreviewDirty("顺序已调整，点“刷新预览”查看结果");
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

function clearVideoPreview() {
  if (!elements.previewVideo) return;
  elements.previewVideo.pause();
  elements.previewVideo.removeAttribute("src");
  elements.previewVideo.load();
  elements.previewVideo.classList.add("hidden");
  elements.previewVideo.style.display = "none";
  elements.previewVideo.onloadedmetadata = null;
  elements.previewVideo.ontimeupdate = null;
}

function scheduleGifPreviewRender() {
  if (state.gifPreviewTimer) {
    clearTimeout(state.gifPreviewTimer);
  }
  state.gifPreviewTimer = setTimeout(() => {
    state.gifPreviewTimer = null;
    if (state.exportMode === "gif") markPreviewDirty("裁剪范围已更新，点“刷新预览”查看结果");
  }, 180);
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
      markPreviewDirty("顺序已调整，点“刷新预览”查看结果");
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
  markPreviewDirty();
}

function renderCandidates() {
  if (!state.candidates.length) {
    elements.candidateGrid.className = "candidate-list empty";
    elements.candidateGrid.innerHTML = "<p>图片会显示在这里</p>";
    updateGifMediaSettingsVisibility();
    updateVideoTrimUI().catch(() => {});
    return;
  }

  elements.candidateGrid.className = "candidate-list";
  const grouped = new Map();
  const visibleCandidates = state.candidates.filter((item) => {
    if (state.candidateFilter === "all") return true;
    return item.mediaType === state.candidateFilter;
  });

  if (!visibleCandidates.length) {
    elements.candidateGrid.className = "candidate-list empty";
    elements.candidateGrid.innerHTML = "<p>当前筛选下没有素材</p>";
    updateGifMediaSettingsVisibility();
    updateVideoTrimUI().catch(() => {});
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
      const thumbMarkup =
        item.mediaType === "video"
          ? `
          <div class="candidate-video-shell">
            <img
              class="candidate-thumb"
              src="${escapeHtml(item.posterUrl || proxy)}"
              data-direct-src="${escapeHtml(item.posterUrl || direct)}"
              data-proxy-src="${escapeHtml(proxy)}"
              data-candidate-id="${escapeHtml(item.id)}"
              alt="候选视频 ${index + 1}"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
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
              <label class="mini-field">
                <span>${item.mediaType === "video" ? "片段时长" : "停留时间"}</span>
                <input class="mini-number" type="number" min="0.1" max="20" step="0.1" value="${item.duration}" data-duration-id="${escapeHtml(item.id)}" />
              </label>
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
  updateGifMediaSettingsVisibility();
  updateVideoTrimUI().catch(() => {});

  elements.candidateGrid.querySelectorAll("input[type='checkbox']").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.candidateKey;
      if (!key) return;
      if (input.checked) state.selectedCandidateKeys.add(key);
      else state.selectedCandidateKeys.delete(key);
      renderCandidates();
      markPreviewDirty();
    });
  });

  elements.candidateGrid.querySelectorAll("[data-duration-id]").forEach((input) => {
    input.addEventListener("change", () => {
      const current = state.candidates.find((item) => item.id === input.dataset.durationId);
      if (!current) return;
      current.duration = parsePositiveFloat(input.value, current.duration, 0.1, 20);
      input.value = current.duration;
      if (state.exportMode === "gif") markPreviewDirty();
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
      let built = false;
      try {
        await ensureLocalVideoUrl(item);
      } catch (error) {
        throw error instanceof Error ? error : new Error("视频下载失败");
      }
      for (const src of getVideoSourceCandidates(item)) {
        try {
          const video = await loadVideoElement(src);
          const videoDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
          const clipStart = Math.max(0, Math.min(state.videoClipStart || 0, Math.max(0, videoDuration - 0.2)));
          const clipDuration = Math.max(
            0.5,
            Math.min(state.videoClipDuration || 3, Math.max(0.5, videoDuration - clipStart))
          );
          const requestedFps = clipDuration <= 3 ? 12 : clipDuration <= 6 ? 10 : 8;
          const maxFrameCount = clipDuration <= 3 ? 48 : clipDuration <= 6 ? 60 : 72;
          const frameCount = Math.max(8, Math.min(maxFrameCount, Math.round(clipDuration * requestedFps)));
          const frameStep = clipDuration / frameCount;
          for (let index = 0; index < frameCount; index += 1) {
            const frameTime = Math.min(
              clipStart + clipDuration - 0.04,
              clipStart + index * frameStep
            );
            await seekVideo(video, frameTime);
            frames.push({
              item: { ...item, duration: Math.max(0.06, frameStep) },
              img: captureVideoFrame(video),
            });
          }
          built = true;
          break;
        } catch {}
      }
      if (!built && item.posterUrl) {
        frames.push({
          item,
          img: await loadImageWithOptions(item.posterUrl, { src: item.posterUrl }),
        });
        built = true;
      }
      if (built) continue;
      throw new Error("视频加载失败");
    }
    frames.push({
      item,
      img: await loadRenderableImage(item),
    });
  }
  return frames;
}

async function renderGifPreview(groupKey = null) {
  const gifBlob = await generateGifBlob(groupKey, false);
  clearGifPreviewUrl();
  clearVideoPreview();
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
  state.previewDirty = false;
  const groups = getSelectedGroups();
  syncPreviewGroupSelection(groups);
  await updateVideoTrimUI();
  if (!groups.length) {
    resetPreviewArea(state.exportMode === "gif" ? "这里会显示完整动图预览" : "这里会显示完整预览");
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
      clearVideoPreview();
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
  clearVideoPreview();
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

function getVideoDownloadExtension(item) {
  const fileType = String(item?.fileType || "").toLowerCase();
  if (fileType.includes("webm")) return "webm";
  if (fileType.includes("quicktime") || fileType.includes("mov")) return "mov";
  return "mp4";
}

function buildOriginalVideoFilename(item, index = 0) {
  const baseName = String(item?.name || item?.groupLabel || `video-${index + 1}`)
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  const ext = getVideoDownloadExtension(item);
  return `${baseName || `video-${index + 1}`}.${ext}`;
}

async function getOriginalVideoBlob(item) {
  if (!item || item.mediaType !== "video") {
    throw new Error("没有可保存的视频");
  }
  if (item.kind === "local" && item.originalUrl) {
    const localResponse = await fetch(item.originalUrl);
    if (!localResponse.ok) throw new Error("本地视频读取失败");
    return await localResponse.blob();
  }
  try {
    await ensureLocalVideoUrl(item);
  } catch {}
  const downloadUrl = item.originalUrl || item.directSrc || item.previewSrc || item.src;
  const sources = [
    item.localVideoUrl,
    downloadUrl ? `/download-media?url=${encodeURIComponent(downloadUrl)}` : "",
    item.browserDirectVideoUrl,
    item.directSrc,
    item.renderSrc,
    item.proxyUrl,
  ].filter(Boolean);
  let lastError = null;
  for (const src of sources) {
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`视频下载失败：${response.status}`);
      const blob = await response.blob();
      if (!(blob instanceof Blob) || !blob.size) throw new Error("视频文件为空");
      return blob;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("视频下载失败");
}

async function downloadSelectedVideos(withStatus = true) {
  const selectedVideos = getSelectedImages().filter((item) => item.mediaType === "video");
  if (!selectedVideos.length) {
    if (withStatus) setStatus("请先勾选视频素材");
    return;
  }
  let successCount = 0;
  let failedCount = 0;
  for (let index = 0; index < selectedVideos.length; index += 1) {
    const item = selectedVideos[index];
    try {
      if (withStatus) setStatus(`正在保存原始视频 ${index + 1}/${selectedVideos.length}…`);
      const blob = await getOriginalVideoBlob(item);
      downloadBlob(blob, buildOriginalVideoFilename(item, index));
      successCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 180));
    } catch {
      failedCount += 1;
    }
  }
  if (!withStatus) return;
  if (successCount && !failedCount) {
    setStatus(`已开始下载 ${successCount} 个原始视频`);
    return;
  }
  if (successCount) {
    setStatus(`已下载 ${successCount} 个原始视频，${failedCount} 个失败`);
    return;
  }
  setStatus("原始视频保存失败");
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
    });
    state.candidates.push(candidate);
    state.selectedCandidateKeys.add(candidate.selectionKey);
  });

  dedupeCandidates();
  renderCandidates();
  markPreviewDirty("素材已加入，选好后点“刷新预览”查看结果");
}

async function extractImagesFromPage() {
  const urlList = buildMergedUrlList();
  const itemIdCount = parseItemIdList(elements.itemIdInput?.value).length;
  if (!urlList.length) {
    setStatus("请先输入至少一个网页链接或 item ID");
    return;
  }

  elements.extractBtn.disabled = true;
  setStatus(
    urlList.some((item) => item.toLowerCase().includes("tiktok.com"))
      ? `正在批量提取 ${urlList.length} 个链接${itemIdCount ? `，其中 ${itemIdCount} 个来自 item ID 自动生成` : ""}，包含 TikTok，可能会慢一点`
      : `正在批量提取 ${urlList.length} 个链接${itemIdCount ? `，其中 ${itemIdCount} 个来自 item ID 自动生成` : ""}…`
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

      const isTikTokVideoUrl = /tiktok\.com/i.test(value) && /\/video\//i.test(value);
      if (!response.ok && isTikTokVideoUrl) {
        try {
          setStatus(`第 ${index + 1} 个链接服务端提取失败，正在尝试短视频兜底…`);
          data = await requestTikTokVideoFallback(value);
          response = { ok: true };
        } catch (fallbackError) {
          failures.push(
            `${getExtractErrorMessage(value, data, "提取失败")}。浏览器短视频兜底也失败：${fallbackError.message}`
          );
          continue;
        }
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
    if (!state.candidates.length) {
      throw new Error(failures[0] || "没有提取到可用图片");
    }
    const failureText = failures.length ? `，${failures.length} 个链接提取失败` : "";
    markPreviewDirty(`已提取 ${urlList.length - failures.length} 组素材，共 ${state.candidates.length} 张${failureText}。选好后点“刷新预览”`);
  } catch (error) {
    setStatus(`提取失败：${error.message}`);
  } finally {
    elements.extractBtn.disabled = false;
  }
}

async function startAssistExtract() {
  const urlList = buildMergedUrlList();
  if (urlList.length !== 1) {
    setStatus("辅助提图一次只支持 1 个链接或 1 个 item ID");
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
    const sourceUrl = buildMergedUrlList()[0] || data.pageUrl || "辅助提图";
    state.candidates = mapImagesToCandidates(data.images || [], sourceUrl, "辅助提图", sourceUrl, 0);
    dedupeCandidates();
    state.selectedCandidateKeys = new Set(state.candidates.map((item) => item.selectionKey));
    state.assistSessionId = null;
    updateAssistButtons();
    renderCandidates();
    markPreviewDirty(`辅助提图成功，已识别 ${state.candidates.length} 张素材。选好后点“刷新预览”`);
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
  state.previewDirty = false;
  clearGroupPreviewUrls();
  closePreviewModal();
  renderCandidates();
  resetPreviewArea("这里会显示完整预览");
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
  elements.downloadVideoBtn?.addEventListener("click", () => {
    downloadSelectedVideos(true).catch((error) => setStatus(`原始视频保存失败：${error.message}`));
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
      markPreviewDirty();
    });
  });

  elements.exportModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.exportMode = button.dataset.exportMode;
      updateExportModeButtons();
      markPreviewDirty();
    });
  });

  elements.pngScaleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.pngScale = Number(button.dataset.pngScale) || 1;
      if (![1, 2, 3].includes(state.pngScale)) {
        state.pngScale = 1;
      }
      updatePngScaleButtons();
      if (state.exportMode === "png") markPreviewDirty();
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
      markPreviewDirty();
    });
  });

  elements.backgroundColor.addEventListener("input", () => {
    state.backgroundColor = elements.backgroundColor.value;
    elements.gifBackgroundColor.value = state.backgroundColor;
    markPreviewDirty();
  });

  elements.gifBackgroundColor.addEventListener("input", () => {
    state.backgroundColor = elements.gifBackgroundColor.value;
    elements.backgroundColor.value = state.backgroundColor;
    markPreviewDirty();
  });

  elements.shadowToggle.addEventListener("change", () => {
    state.shadow = elements.shadowToggle.checked;
    markPreviewDirty();
  });

  elements.outlineToggle.addEventListener("change", () => {
    state.outline = elements.outlineToggle.checked;
    markPreviewDirty();
  });

  elements.gifWidthInput.addEventListener("change", () => {
    state.gifWidth = parsePositiveInt(elements.gifWidthInput.value, state.gifWidth, 100, 2400);
    elements.gifWidthInput.value = state.gifWidth;
    if (state.exportMode === "gif") markPreviewDirty();
  });

  elements.gifHeightInput.addEventListener("change", () => {
    state.gifHeight = parsePositiveInt(elements.gifHeightInput.value, state.gifHeight, 100, 2400);
    elements.gifHeightInput.value = state.gifHeight;
    if (state.exportMode === "gif") markPreviewDirty();
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

  elements.gifVideoStartInput.addEventListener("change", () => {
    state.videoClipStart = parsePositiveFloat(elements.gifVideoStartInput.value, state.videoClipStart, 0, 600);
    elements.gifVideoStartInput.value = state.videoClipStart;
    updateVideoTrimUI().catch(() => {});
    if (state.exportMode === "gif") markPreviewDirty();
  });

  elements.gifVideoClipInput.addEventListener("change", () => {
    state.videoClipDuration = parsePositiveFloat(elements.gifVideoClipInput.value, state.videoClipDuration, 0.5, 60);
    elements.gifVideoClipInput.value = state.videoClipDuration;
    updateVideoTrimUI().catch(() => {});
    if (state.exportMode === "gif") markPreviewDirty();
  });

  elements.trimStartRange?.addEventListener("input", () => {
    const maxEnd = Number(elements.trimEndRange?.value || state.videoClipStart + state.videoClipDuration);
    const nextStart = Math.min(Number(elements.trimStartRange.value), Math.max(0, maxEnd - 0.5));
    state.videoClipStart = nextStart;
    state.videoClipDuration = Math.max(0.5, maxEnd - nextStart);
    updateVideoTrimUI().catch(() => {});
    if (state.exportMode === "gif") {
      scheduleGifPreviewRender();
    }
  });

  elements.trimEndRange?.addEventListener("input", () => {
    const start = Number(elements.trimStartRange?.value || state.videoClipStart);
    const nextEnd = Math.max(start + 0.5, Number(elements.trimEndRange.value));
    state.videoClipStart = start;
    state.videoClipDuration = Math.max(0.5, nextEnd - start);
    updateVideoTrimUI().catch(() => {});
    if (state.exportMode === "gif") {
      scheduleGifPreviewRender();
    }
  });

  elements.trimPlayButton?.addEventListener("click", () => {
    const video = elements.trimPreviewVideo;
    if (!video?.src) return;
    const start = state.videoClipStart;
    video.currentTime = start;
    video.play().catch(() => {});
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
    markPreviewDirty("已把默认停留时间应用到当前勾选图片，点“刷新预览”查看结果");
  });

  elements.pageUrl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      extractImagesFromPage();
    }
  });
  elements.itemIdInput?.addEventListener("keydown", (event) => {
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
  updateGifMediaSettingsVisibility();
  updateCandidateFilterButtons();
  updateAssistButtons();
  elements.gifBackgroundColor.value = state.backgroundColor;
  renderCandidates();
  bindEvents();
  updateVideoTrimUI().catch(() => {});
}

init();
