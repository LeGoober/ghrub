/**
 * Receipt capture — everything that touches pixels happens here, on the phone.
 *
 *   1. Load the photo, honouring the camera's orientation.
 *   2. Prepare it for OCR: scale to a size Tesseract reads well, convert to
 *      grey, and stretch the contrast so faded thermal print comes back.
 *   3. Look for a QR code (the browser's own BarcodeDetector when it has one,
 *      jsQR otherwise).
 *   4. Run Tesseract (WebAssembly) over the prepared image.
 *   5. Post only the TEXT it read to /receipts/read, which returns the review
 *      form. The photo itself never leaves the device.
 *
 * Every engine file is served by ghrub itself from /static/vendor — Tesseract's
 * defaults would fetch them from a CDN, which would quietly make this depend on
 * a third party after all.
 */
(() => {
  const root = document.getElementById('receipt-scanner');
  if (!root) return;

  const ORIGIN = window.location.origin;
  const VENDOR = `${ORIGIN}/static/vendor`;

  /** Long edge for OCR. Tesseract wants ~30px tall characters; this gets there on a full-slip photo. */
  const OCR_MAX_EDGE = 2400;
  const OCR_MIN_EDGE = 1400;
  /** QR decoding needs far less, and jsQR is quadratic-ish in pixels. */
  const QR_MAX_EDGE = 1200;
  /** For the optional Claude upload, matching the server's expectations. */
  const UPLOAD_MAX_EDGE = 2048;

  const $ = (id) => document.getElementById(id);
  const cameraInput = $('receipt-camera');
  const fileInput = $('receipt-file');
  const preview = $('receipt-preview');
  const previewImg = preview.querySelector('img');
  const previewCaption = preview.querySelector('figcaption');
  const scanBtn = $('receipt-scan');
  const clearBtn = $('receipt-clear');
  const progress = $('receipt-progress');
  const status = $('receipt-status');
  const result = $('receipt-result');
  const llmWrap = $('receipt-llm-wrap');
  const llmBtn = $('receipt-llm');

  let source = null; // ImageBitmap | HTMLImageElement of the chosen photo
  let previewUrl = null;
  let workerPromise = null;

  const say = (text) => {
    status.textContent = text;
  };

  const showProgress = (value) => {
    if (value === null) {
      progress.hidden = true;
      return;
    }
    progress.hidden = false;
    progress.value = Math.round(value * 100);
  };

  // ---- loading -------------------------------------------------------------

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-src="${src}"]`);
      if (existing) {
        existing.addEventListener('load', resolve);
        if (existing.dataset.loaded) resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.dataset.src = src;
      script.onload = () => {
        script.dataset.loaded = '1';
        resolve();
      };
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(script);
    });
  }

  async function loadPhoto(file) {
    // createImageBitmap applies the EXIF rotation a phone camera writes; an
    // <img> does too in every current browser, so it is the fallback.
    if ('createImageBitmap' in window) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        // fall through
      }
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('That file could not be opened as an image.'));
      };
      img.src = url;
    });
  }

  const sizeOf = (img) => ({
    w: img.width || img.naturalWidth,
    h: img.height || img.naturalHeight,
  });

  function drawScaled(img, maxEdge, minEdge = 0) {
    const { w, h } = sizeOf(img);
    const long = Math.max(w, h);
    let scale = Math.min(1, maxEdge / long);
    if (minEdge && long * scale < minEdge) scale = minEdge / long;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { canvas, ctx };
  }

  /**
   * Grey + contrast stretch between the 2nd and 98th percentile of brightness.
   * Thermal slips fade to grey-on-cream; stretching puts the ink back near
   * black and the paper near white, which is most of what Tesseract needs.
   * (Tesseract binarises on its own, so no threshold is applied here.)
   */
  function prepareForOcr(img) {
    const { canvas, ctx } = drawScaled(img, OCR_MAX_EDGE, OCR_MIN_EDGE);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = frame.data;
    const histogram = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) {
      const grey = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
      px[i] = grey;
      histogram[grey | 0] += 1;
    }
    const total = px.length / 4;
    let lo = 0;
    let hi = 255;
    for (let acc = 0; lo < 255 && (acc += histogram[lo]) < total * 0.02; lo += 1);
    for (let acc = 0; hi > 0 && (acc += histogram[hi]) < total * 0.02; hi -= 1);
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < px.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((px[i] - lo) * 255) / range));
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(frame, 0, 0);
    return canvas;
  }

  // ---- QR ------------------------------------------------------------------

  async function findQr(img) {
    const { canvas, ctx } = drawScaled(img, QR_MAX_EDGE);
    try {
      if ('BarcodeDetector' in window) {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          const codes = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(canvas);
          return codes[0]?.rawValue || null;
        }
      }
      await loadScript(`${VENDOR}/jsqr/jsQR.js`);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(frame.data, frame.width, frame.height, {
        inversionAttempts: 'dontInvert',
      });
      return code?.data || null;
    } catch {
      // A QR is a bonus; failing to find one is never an error.
      return null;
    }
  }

  // ---- OCR -----------------------------------------------------------------

  function getWorker() {
    workerPromise ??= (async () => {
      await loadScript(`${VENDOR}/tesseract/tesseract.min.js`);
      return window.Tesseract.createWorker('eng', 1 /* LSTM only */, {
        workerPath: `${VENDOR}/tesseract/worker.min.js`,
        corePath: `${VENDOR}/tesseract-core`,
        langPath: `${VENDOR}/tesseract-lang`,
        workerBlobURL: false,
        logger: (m) => {
          if (m.status === 'recognizing text') {
            showProgress(m.progress);
            say(`Reading the slip… ${Math.round(m.progress * 100)}%`);
          } else if (/load|initiali/i.test(m.status)) {
            showProgress(m.progress || 0);
            say('Loading the reader (first scan only)…');
          }
        },
      });
    })();
    workerPromise.catch(() => {
      workerPromise = null;
    });
    return workerPromise;
  }

  async function ocr(img) {
    const worker = await getWorker();
    // PSM 4: a single column of text of variable sizes — exactly a till slip.
    // Keeping inter-word spaces preserves the gap between a name and its price.
    await worker.setParameters({ tessedit_pageseg_mode: '4', preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(prepareForOcr(img), {}, { text: true, blocks: true });
    const lines = [];
    for (const block of data.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const line of paragraph.lines || []) {
          lines.push({ text: line.text.trim(), conf: Math.round(line.confidence) });
        }
      }
    }
    if (lines.length) return lines;
    return String(data.text || '')
      .split('\n')
      .map((text) => ({ text, conf: null }));
  }

  // ---- flow ----------------------------------------------------------------

  const render = async (response) => {
    result.innerHTML = await response.text();
    // The returned partial carries hx-post attributes of its own, so HTMX has
    // to be told to bind the markup that just arrived.
    if (window.htmx) window.htmx.process(result);
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const busy = (on) => {
    scanBtn.disabled = on;
    scanBtn.classList.toggle('is-busy', on);
    if (llmBtn) llmBtn.disabled = on;
  };

  function reset() {
    source = null;
    cameraInput.value = '';
    fileInput.value = '';
    preview.hidden = true;
    clearBtn.hidden = true;
    scanBtn.disabled = true;
    if (llmWrap) llmWrap.hidden = true;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    result.innerHTML = '';
    showProgress(null);
    say('');
  }

  async function choose(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    reset();
    say('Opening the photo…');
    try {
      source = await loadPhoto(file);
    } catch (err) {
      say(err.message);
      return;
    }
    previewUrl = URL.createObjectURL(file);
    previewImg.src = previewUrl;
    previewCaption.textContent = file.name;
    preview.hidden = false;
    clearBtn.hidden = false;
    scanBtn.disabled = false;
    if (llmWrap) llmWrap.hidden = false;
    say('Ready. Check the whole slip is in frame, then read it.');
    // Warm the reader while the user is looking at the preview.
    getWorker().catch(() => {});
  }

  async function readLocally() {
    if (!source) return;
    busy(true);
    try {
      say('Looking for a QR code…');
      const qr = await findQr(source);
      say('Reading the slip…');
      const lines = await ocr(source);
      say('Matching items to your kitchen…');
      const response = await fetch('/receipts/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lines, qr }),
      });
      await render(response);
      say(response.ok ? '' : 'That did not work — see below.');
    } catch (err) {
      say(
        navigator.onLine === false
          ? 'You are offline — ghrub needs a connection to save the reading.'
          : `The reader failed: ${err.message || 'unknown error'}. Try again.`
      );
    } finally {
      showProgress(null);
      busy(false);
    }
  }

  async function readWithClaude() {
    if (!source) return;
    busy(true);
    say('Sending the photo to Claude — this takes a few seconds.');
    try {
      const { canvas } = drawScaled(source, UPLOAD_MAX_EDGE);
      const response = await fetch('/receipts/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: canvas.toDataURL('image/jpeg', 0.85) }),
      });
      await render(response);
      say(response.ok ? '' : 'That did not work — see below.');
    } catch {
      say('The upload failed. Check your connection and try again.');
    } finally {
      busy(false);
    }
  }

  cameraInput.addEventListener('change', () => choose(cameraInput));
  fileInput.addEventListener('change', () => choose(fileInput));
  clearBtn.addEventListener('click', reset);
  scanBtn.addEventListener('click', readLocally);
  if (llmBtn) llmBtn.addEventListener('click', readWithClaude);

  // A phone keeps a backgrounded tab's worker alive; ~30MB of WASM heap is not
  // worth holding once the user has left the page.
  window.addEventListener('pagehide', () => {
    if (workerPromise) workerPromise.then((w) => w.terminate()).catch(() => {});
    workerPromise = null;
  });
})();
