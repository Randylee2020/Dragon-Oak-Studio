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

const introSessionKey = "dragonOakIntroViewed";
const introRevealPrepTime = 5.75;
const introBurnStartTime = 6.05;
const introSkipFadeDuration = 520;
const introBurnRevealDuration = 2400;
const introBurnPlaybackRate = 2.05;
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

const fieldMessages = {
  name: "Please enter your name.",
  email: "Please enter a valid email address.",
  projectType: "Please choose a project type.",
  message: "Please tell us a little about your project.",
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
