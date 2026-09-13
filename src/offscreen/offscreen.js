/**
 * Offscreen document: satu-satunya tempat MV3 boleh memutar audio tanpa halaman
 * yang terlihat. Service worker tidak punya DOM/Audio, dan content script tidak
 * boleh dipakai karena tab bisa di-mute atau audio diblokir autoplay policy.
 */

const SRC = {
  notif: chrome.runtime.getURL("assets/sounds/notif.wav"),
  chat: chrome.runtime.getURL("assets/sounds/chat.wav"),
};

/** @type {AudioContext | null} */
let ctx = null;
/** @type {Map<string, AudioBuffer>} */
const buffers = new Map();

/** @param {string} kind */
async function bufferFor(kind) {
  const cached = buffers.get(kind);
  if (cached) return cached;
  const res = await fetch(SRC[kind] ?? SRC.notif);
  const bytes = await res.arrayBuffer();
  ctx ??= new AudioContext();
  const buf = await ctx.decodeAudioData(bytes);
  buffers.set(kind, buf);
  return buf;
}

/**
 * WebAudio dipakai (bukan <audio>) agar dua suara bisa tumpang tindih dan volume
 * bisa diatur presisi tanpa membuat elemen baru setiap kali.
 * @param {string} kind @param {number} volume
 */
async function play(kind, volume) {
  const buf = await bufferFor(kind);
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.value = Math.max(0, Math.min(1, Number(volume) || 0));
  src.connect(gain).connect(ctx.destination);
  src.start();
  await new Promise((resolve) => {
    src.onended = resolve;
    setTimeout(resolve, (buf.duration + 0.5) * 1000);
  });
  src.disconnect();
  gain.disconnect();
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "play") return;
  play(msg.kind === "chat" ? "chat" : "notif", msg.volume ?? 0.8).then(
    () => respond({ ok: true }),
    (err) => respond({ ok: false, error: String(err?.message || err) }),
  );
  return true;
});
