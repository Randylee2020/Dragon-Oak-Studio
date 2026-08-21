const menuToggle = document.getElementById("menuToggle");
const navMenu = document.getElementById("navMenu");
const year = document.getElementById("year");
const introOverlay = document.getElementById("introOverlay");
const introSkip = document.getElementById("introSkip");
const introStart = document.getElementById("introStart");
const introVideo = document.getElementById("introVideo");
const introBurnVideo = document.getElementById("introBurnVideo");
const introBurnCanvas = document.getElementById("introBurnCanvas");
const contactForm = document.getElementById("contactForm");
const contactSubmit = document.getElementById("contactSubmit");
const contactStatus = document.getElementById("contactStatus");
const contactStartedAt = document.getElementById("contactStartedAt");
const contactReferenceImages = document.getElementById("contactReferenceImages");
const contactFileSummary = document.getElementById("contactFileSummary");
const contactFileReset = document.getElementById("contactFileReset");

const introSessionKey = "dragonOakIntroViewed";
const introRevealPrepTime = 5.75;
const introBurnStartTime = 6.05;
const introSkipFadeDuration = 520;
const introBurnRevealDuration = 2400;
const introBurnPlaybackRate = 2.05;
const maxReferenceFiles = 3;
const maxReferenceFileSize = 5 * 1024 * 1024;
let burnAnimationFrame = null;
let burnPrepared = false;
let burnStarted = false;
let burnContext = null;
let burnSourceCanvas = null;
let burnSourceContext = null;

const loadIntroMedia = (video) => {
  if (!video || video.dataset.loaded === "true") {
    return;
  }

  const source = video.dataset.src;

  if (!source) {
    return;
  }

  video.src = source;
  video.preload = "auto";
  video.dataset.loaded = "true";
  video.load();
};

const releaseIntroMedia = () => {
  [introVideo, introBurnVideo].forEach((video) => {
    if (!video) {
      return;
    }

    video.pause();
    video.removeAttribute("src");
    video.load();
  });
};

const getIntroViewed = () => {
  try {
    return (
      typeof sessionStorage !== "undefined" &&
      sessionStorage.getItem(introSessionKey) === "true"
    );
  } catch {
    return false;
  }
};

const setIntroViewed = () => {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(introSessionKey, "true");
    }
  } catch {
    // Storage can be unavailable in strict/private browser contexts.
  }
};

const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

const playIntroVideo = () => {
  if (!introVideo) {
    return;
  }

  loadIntroMedia(introVideo);
  introOverlay?.classList.remove("needs-start");
  introVideo.play().catch(() => {
    introOverlay?.classList.add("needs-start");
  });
};

const fadeIntroAudio = (duration = introBurnRevealDuration) => {
  if (!introVideo || introVideo.muted) {
    return;
  }

  const startingVolume = introVideo.volume;
  const fadeStart = performance.now();

  const fadeStep = (now) => {
    const progress = Math.min(
      Math.max((now - fadeStart) / duration, 0),
      1
    );
    introVideo.volume = Math.max(startingVolume * (1 - progress), 0);

    if (progress < 1) {
      requestAnimationFrame(fadeStep);
    }
  };

  requestAnimationFrame(fadeStep);
};

const resizeBurnCanvas = () => {
  if (!introBurnCanvas) {
    return;
  }

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  const width = window.innerWidth;
  const height = window.innerHeight;

  introBurnCanvas.width = Math.ceil(width * pixelRatio);
  introBurnCanvas.height = Math.ceil(height * pixelRatio);
  introBurnCanvas.style.width = `${width}px`;
  introBurnCanvas.style.height = `${height}px`;

  burnContext = introBurnCanvas.getContext("2d", { willReadFrequently: true });
  burnContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

  burnSourceCanvas = document.createElement("canvas");
  burnSourceCanvas.width = introBurnCanvas.width;
  burnSourceCanvas.height = introBurnCanvas.height;
  burnSourceContext = burnSourceCanvas.getContext("2d", { willReadFrequently: true });
  burnSourceContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
};

const getCoverRect = (sourceWidth, sourceHeight, targetWidth, targetHeight) => {
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  return {
    height,
    width,
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
  };
};

const drawMaskedParchmentFrame = (fadeProgress = 0) => {
  if (
    !introBurnCanvas ||
    !introBurnVideo ||
    !burnContext ||
    !burnSourceContext ||
    introBurnVideo.readyState < 2
  ) {
    return;
  }

  const width = window.innerWidth;
  const height = window.innerHeight;
  const videoWidth = introBurnVideo.videoWidth || 1920;
  const videoHeight = introBurnVideo.videoHeight || 1080;
  const drawRect = getCoverRect(videoWidth, videoHeight, width, height);

  burnSourceContext.clearRect(0, 0, width, height);
  burnSourceContext.drawImage(
    introBurnVideo,
    drawRect.x,
    drawRect.y,
    drawRect.width,
    drawRect.height
  );

  const frame = burnSourceContext.getImageData(0, 0, introBurnCanvas.width, introBurnCanvas.height);
  const pixels = frame.data;
  const matteFloor = 42;
  const matteCeiling = 112;
  const finalFade = Math.max(0, Math.min(fadeProgress, 1));

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    const saturation = Math.max(red, green, blue) - Math.min(red, green, blue);
    const fireBias = Math.max(red - blue, 0) * 0.18 + Math.max(green - blue, 0) * 0.08;
    const matte = Math.min(
      Math.max((luminance + fireBias - matteFloor) / (matteCeiling - matteFloor), 0),
      1
    );
    const edgeBoost = luminance > matteFloor && luminance < matteCeiling && saturation > 18 ? 1.16 : 1;

    pixels[index + 3] = Math.round(255 * Math.min(matte * edgeBoost, 1) * (1 - finalFade));
  }

  burnContext.clearRect(0, 0, width, height);
  burnContext.putImageData(frame, 0, 0);
};

const prepareBurnSurface = () => {
  if (!introOverlay || burnPrepared || !introBurnCanvas || !introBurnVideo) {
    return;
  }

  burnPrepared = true;
  loadIntroMedia(introBurnVideo);
  resizeBurnCanvas();
  introBurnVideo.currentTime = 0;
  introBurnVideo.playbackRate = introBurnPlaybackRate;
  introBurnVideo.volume = 0;
  introBurnVideo.play().catch(() => {
    introBurnVideo.muted = true;
    introBurnVideo.play().catch(() => {});
  });
  drawMaskedParchmentFrame();
  introOverlay.classList.add("is-ending");
};

const startBurnThroughReveal = () => {
  if (!introOverlay || burnStarted) {
    return;
  }

  burnStarted = true;
  setIntroViewed();
  prepareBurnSurface();
  fadeIntroAudio(introBurnRevealDuration + 360);
  introOverlay.classList.add("is-burning");
  introOverlay.setAttribute("aria-hidden", "true");

  const burnStart = performance.now();

  const animateBurn = (now) => {
    const progress = Math.min((now - burnStart) / introBurnRevealDuration, 1);
    const fadeProgress = Math.max((progress - 0.82) / 0.18, 0);

    drawMaskedParchmentFrame(fadeProgress);

    if (progress < 1 || (introBurnVideo && !introBurnVideo.ended && introBurnVideo.currentTime < introBurnVideo.duration - 0.05)) {
      burnAnimationFrame = requestAnimationFrame(animateBurn);
      return;
    }

    releaseIntroMedia();
    burnSourceCanvas = null;
    burnSourceContext = null;
    document.body.classList.remove("intro-active");
    introOverlay.remove();
    burnAnimationFrame = null;
  };

  burnAnimationFrame = requestAnimationFrame(animateBurn);
};

const finishIntro = ({ fadeAudio = true } = {}) => {
  if (!introOverlay) {
    return;
  }

  setIntroViewed();

  if (burnAnimationFrame) {
    cancelAnimationFrame(burnAnimationFrame);
    burnAnimationFrame = null;
  }

  if (fadeAudio) {
    fadeIntroAudio(introSkipFadeDuration);
  } else if (introVideo) {
    introVideo.pause();
    introVideo.currentTime = 0;
  }
  introBurnVideo?.pause();
  if (introBurnVideo) {
    introBurnVideo.currentTime = 0;
  }

  introOverlay.classList.add("is-hidden");
  document.body.classList.remove("intro-active");
  introOverlay.setAttribute("aria-hidden", "true");

  window.setTimeout(
    () => {
      releaseIntroMedia();
      introOverlay.remove();
    },
    prefersReducedMotion ? 120 : introSkipFadeDuration + 80
  );
};

if (introOverlay) {
  const introAlreadyViewed = getIntroViewed();

  if (introAlreadyViewed || prefersReducedMotion) {
    setIntroViewed();
    introVideo?.pause();
    introBurnVideo?.pause();
    introOverlay.remove();
  } else {
    document.body.classList.add("intro-active");
    introSkip?.addEventListener("click", () => finishIntro({ fadeAudio: false }));
    introStart?.addEventListener("click", playIntroVideo);
    introVideo?.addEventListener("playing", () => loadIntroMedia(introBurnVideo), { once: true });

    introVideo?.addEventListener("timeupdate", () => {
      if (introVideo.currentTime >= introRevealPrepTime) {
        prepareBurnSurface();
      }

      if (introVideo.currentTime >= introBurnStartTime) {
        startBurnThroughReveal();
      }
    });

    introVideo?.addEventListener("ended", () => {
      startBurnThroughReveal();
    });

    window.addEventListener("resize", () => {
      if (!burnPrepared || burnStarted) {
        return;
      }

      resizeBurnCanvas();
      drawMaskedParchmentFrame();
    });

    playIntroVideo();
  }
}

if (menuToggle && navMenu) {
  menuToggle.addEventListener("click", () => {
    const isOpen = navMenu.classList.toggle("open");
    menuToggle.setAttribute("aria-expanded", String(isOpen));
    menuToggle.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
  });

  navMenu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      navMenu.classList.remove("open");
      menuToggle.setAttribute("aria-expanded", "false");
      menuToggle.setAttribute("aria-label", "Open menu");
    });
  });
}

if (year) {
  year.textContent = new Date().getFullYear();
}

const projectTypes = [
  "Laser Cutting / Engraving",
  "UV Printing",
  "Custom Product",
  "Digital Design File",
  "Business Branding",
  "Bulk / Business Order",
  "Other",
];
const allowedReferenceTypes = new Map([
  ["image/jpeg", new Set(["jpg", "jpeg"])],
  ["image/png", new Set(["png"])],
  ["image/webp", new Set(["webp"])],
  ["application/pdf", new Set(["pdf"])],
  ["image/svg+xml", new Set(["svg"])],
]);
let selectedReferenceFiles = [];

const fieldMessages = {
  name: "Please enter your name.",
  email: "Please enter a valid email address.",
  projectType: "Please choose a project type.",
  message: "Please tell us a little about your project.",
  referenceImages: "Please choose JPG, PNG, WebP, PDF or SVG files under 5 MB.",
};

const setFieldError = (field, message = "") => {
  const error = document.getElementById(`${field.id}Error`);

  field.setAttribute("aria-invalid", message ? "true" : "false");

  if (error) {
    error.textContent = message;
  }
};

const setFormStatus = (message = "", type = "") => {
  if (!contactStatus) {
    return;
  }

  contactStatus.textContent = message;
  contactStatus.classList.toggle("is-success", type === "success");
  contactStatus.classList.toggle("is-error", type === "error");
};

const getContactPayload = () => {
  const formData = new FormData(contactForm);

  return {
    name: String(formData.get("name") || "").trim(),
    email: String(formData.get("email") || "").trim(),
    phone: String(formData.get("phone") || "").trim(),
    company: String(formData.get("company") || "").trim(),
    projectType: String(formData.get("projectType") || "").trim(),
    message: String(formData.get("message") || "").trim(),
    website: String(formData.get("website") || "").trim(),
    startedAt: String(formData.get("startedAt") || "").trim(),
  };
};

const formatFileSize = (bytes) => {
  if (bytes < 1024 * 1024) {
    return `${Math.max(Math.round(bytes / 1024), 1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const getFileExtension = (fileName) => {
  const extension = fileName.split(".").pop();
  return extension ? extension.toLowerCase() : "";
};

const getReadableFileType = (file) => {
  const extension = getFileExtension(file.name);

  if (extension === "jpg" || extension === "jpeg") {
    return "JPEG";
  }

  return extension.toUpperCase();
};

const readFileHeader = async (file, length = 16) => {
  const buffer = await file.slice(0, length).arrayBuffer();
  return new Uint8Array(buffer);
};

const fileHeaderMatchesType = async (file) => {
  const header = await readFileHeader(file, 64);
  const headerText = new TextDecoder("utf-8")
    .decode(header)
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();

  if (file.type === "image/jpeg") {
    return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  }

  if (file.type === "image/png") {
    return (
      header[0] === 0x89 &&
      header[1] === 0x50 &&
      header[2] === 0x4e &&
      header[3] === 0x47 &&
      header[4] === 0x0d &&
      header[5] === 0x0a &&
      header[6] === 0x1a &&
      header[7] === 0x0a
    );
  }

  if (file.type === "image/webp") {
    return (
      header[0] === 0x52 &&
      header[1] === 0x49 &&
      header[2] === 0x46 &&
      header[3] === 0x46 &&
      header[8] === 0x57 &&
      header[9] === 0x45 &&
      header[10] === 0x42 &&
      header[11] === 0x50
    );
  }

  if (file.type === "application/pdf") {
    return header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46 && header[4] === 0x2d;
  }

  if (file.type === "image/svg+xml") {
    return headerText.startsWith("<svg") || headerText.startsWith("<?xml");
  }

  return false;
};

const svgHasUnsafeContent = async (file) => {
  const text = (await file.text()).toLowerCase();

  return (
    !text.includes("<svg") ||
    text.includes("<html") ||
    text.includes("<script") ||
    text.includes("<foreignobject") ||
    text.includes("javascript:") ||
    /\son[a-z]+\s*=/.test(text) ||
    /<(iframe|object|embed|link|meta)\b/.test(text)
  );
};

const validateReferenceFiles = async (files) => {
  if (!files.length) {
    return { files: [], message: "" };
  }

  if (files.length > maxReferenceFiles) {
    return { files: [], message: "Please select no more than 3 reference files." };
  }

  for (const file of files) {
    const extension = getFileExtension(file.name);

    if (!allowedReferenceTypes.has(file.type) || !allowedReferenceTypes.get(file.type).has(extension) || file.size <= 0 || file.size > maxReferenceFileSize) {
      return { files: [], message: fieldMessages.referenceImages };
    }

    if (!(await fileHeaderMatchesType(file))) {
      return { files: [], message: "One selected file does not match its file type." };
    }

    if (file.type === "image/svg+xml" && (await svgHasUnsafeContent(file))) {
      return { files: [], message: "One selected SVG contains unsupported active content." };
    }
  }

  return { files, message: "" };
};

const renderReferenceFiles = () => {
  if (!contactFileSummary || !contactFileReset) {
    return;
  }

  contactFileSummary.innerHTML = "";
  contactFileReset.hidden = selectedReferenceFiles.length === 0;
  contactFileReset.disabled = selectedReferenceFiles.length === 0;

  selectedReferenceFiles.forEach((file, index) => {
    const item = document.createElement("div");
    const details = document.createElement("div");
    const name = document.createElement("strong");
    const meta = document.createElement("span");
    const remove = document.createElement("button");

    item.className = "file-pill";
    details.className = "file-details";
    meta.className = "file-meta";
    remove.className = "file-remove";
    remove.type = "button";
    remove.dataset.fileIndex = String(index);
    remove.textContent = "Remove";
    name.textContent = file.name;
    meta.textContent = `${getReadableFileType(file)} | ${formatFileSize(file.size)}`;

    details.append(name, meta);
    item.append(details, remove);
    contactFileSummary.append(item);
  });
};

const removeReferenceFile = (index) => {
  selectedReferenceFiles = selectedReferenceFiles.filter((_file, fileIndex) => fileIndex !== index);

  if (contactReferenceImages) {
    contactReferenceImages.value = "";
  }

  renderReferenceFiles();
};

const resetReferenceFiles = () => {
  selectedReferenceFiles = [];

  if (contactReferenceImages) {
    contactReferenceImages.value = "";
    setFieldError(contactReferenceImages);
  }

  renderReferenceFiles();
};

const uploadReferenceFile = async (file) => {
  const signatureResponse = await fetch("/api/reference-upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
    }),
  });
  const signature = await signatureResponse.json().catch(() => ({}));

  if (!signatureResponse.ok || !signature.ok) {
    throw new Error("upload_signature_failed");
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("api_key", signature.apiKey);
  formData.append("timestamp", signature.timestamp);
  formData.append("folder", signature.folder);
  formData.append("public_id", signature.publicId);
  formData.append("signature", signature.signature);

  const uploadResponse = await fetch(
    `https://api.cloudinary.com/v1_1/${signature.cloudName}/${signature.resourceType}/upload`,
    {
      method: "POST",
      body: formData,
    }
  );
  const uploadResult = await uploadResponse.json().catch(() => ({}));

  if (!uploadResponse.ok || !uploadResult.secure_url) {
    throw new Error("reference_upload_failed");
  }

  return {
    url: uploadResult.secure_url,
    originalName: file.name,
    size: file.size,
    type: file.type,
    resourceType: signature.resourceType,
  };
};

const uploadReferenceFiles = async () => {
  if (!selectedReferenceFiles.length) {
    return [];
  }

  setFormStatus("Uploading reference files...", "");

  const uploadedImages = [];

  for (const file of selectedReferenceFiles) {
    uploadedImages.push(await uploadReferenceFile(file));
  }

  return uploadedImages;
};

const validateContactForm = () => {
  const payload = getContactPayload();
  const fields = {
    name: contactForm.elements.name,
    email: contactForm.elements.email,
    projectType: contactForm.elements.projectType,
    message: contactForm.elements.message,
  };
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  let firstInvalidField = null;

  Object.values(contactForm.elements).forEach((field) => {
    if (field instanceof HTMLElement && field.id) {
      setFieldError(field);
    }
  });

  if (!payload.name) {
    setFieldError(fields.name, fieldMessages.name);
    firstInvalidField ||= fields.name;
  }

  if (!emailPattern.test(payload.email)) {
    setFieldError(fields.email, fieldMessages.email);
    firstInvalidField ||= fields.email;
  }

  if (!projectTypes.includes(payload.projectType)) {
    setFieldError(fields.projectType, fieldMessages.projectType);
    firstInvalidField ||= fields.projectType;
  }

  if (!payload.message) {
    setFieldError(fields.message, fieldMessages.message);
    firstInvalidField ||= fields.message;
  }

  if (firstInvalidField) {
    firstInvalidField.focus();
    setFormStatus("Please check the highlighted fields and try again.", "error");
    return null;
  }

  return payload;
};

if (contactForm && contactSubmit) {
  if (contactStartedAt) {
    contactStartedAt.value = String(Date.now());
  }

  contactForm.addEventListener("input", (event) => {
    const field = event.target;

    if (field instanceof HTMLElement && field.id) {
      setFieldError(field);
    }

    setFormStatus();
  });

  contactReferenceImages?.addEventListener("change", async () => {
    const files = Array.from(contactReferenceImages.files || []);
    const result = await validateReferenceFiles(files);

    selectedReferenceFiles = result.files;
    setFieldError(contactReferenceImages, result.message);
    setFormStatus(result.message ? "Please check the selected reference files." : "");
    renderReferenceFiles();

    if (result.message) {
      contactReferenceImages.value = "";
    }
  });

  contactFileReset?.addEventListener("click", () => {
    resetReferenceFiles();
    setFormStatus();
  });

  contactFileSummary?.addEventListener("click", (event) => {
    const button = event.target.closest(".file-remove");

    if (!button) {
      return;
    }

    removeReferenceFile(Number(button.dataset.fileIndex));
    setFormStatus();
  });

  contactForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (contactSubmit.disabled) {
      return;
    }

    const payload = validateContactForm();

    if (!payload) {
      return;
    }

    contactSubmit.disabled = true;
    contactSubmit.textContent = "Sending...";
    setFormStatus("Sending your project inquiry...", "");

    try {
      payload.referenceImages = await uploadReferenceFiles();

      const response = await fetch(contactForm.action, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok || !result.ok) {
        throw new Error("submission_failed");
      }

      contactForm.reset();
      resetReferenceFiles();

      if (contactStartedAt) {
        contactStartedAt.value = String(Date.now());
      }

      setFormStatus(
        "Your message has been sent to Dragon Oak Studio. We'll be in touch soon.",
        "success"
      );
    } catch {
      setFormStatus(
        "We couldn't send your inquiry just now. Please try again in a moment.",
        "error"
      );
    } finally {
      contactSubmit.disabled = false;
      contactSubmit.textContent = "Send Project Inquiry";
    }
  });
}
