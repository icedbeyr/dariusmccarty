import { getStore } from "@netlify/blobs";
import { json, newKey, trimStore } from "../lib/common.mjs";
import { moderateImage, needsFrameReview } from "../lib/moderation.mjs";

const MAX_NAME = 40;
const MAX_BYTES = 4 * 1024 * 1024; // Netlify Functions cap request bodies at 6 MB
const LIST_LIMIT = 20;
const MAX_PENDING = 100; // stop accepting uncertain images if the review queue is this full
const MAX_LOG = 100;

const clean = (s) => s.replace(/[\u0000-\u001F\u007F]/g, "").trim();

const open = (name) => getStore({ name, consistency: "strong" });
const published = () => open("images");
const pendingStore = () => open("pending-images");
const logStore = () => open("moderation-log");

// Identify the real file type from its bytes instead of trusting the browser.
function sniffType(bytes) {
  const startsWith = (sig, offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export default async (req) => {
  if (req.method === "GET") {
    const s = published();
    const { blobs } = await s.list();
    const keys = blobs.map((b) => b.key).sort().slice(0, LIST_LIMIT);
    const items = await Promise.all(
      keys.map(async (key) => {
        const entry = await s.getMetadata(key);
        if (!entry) return null;
        return { id: key, name: entry.metadata.name, createdAt: entry.metadata.createdAt };
      })
    );
    return json(items.filter(Boolean));
  }

  if (req.method === "POST") {
    let form;
    try {
      form = await req.formData();
    } catch {
      return json({ error: "Invalid request." }, 400);
    }

    if (form.get("website")) return json({ ok: true }); // honeypot

    const rawName = form.get("name");
    const file = form.get("image");
    const name = typeof rawName === "string" ? clean(rawName) : "";

    if (!name) return json({ error: "Enter your name." }, 400);
    if (name.length > MAX_NAME) return json({ error: `Name must be ${MAX_NAME} characters or fewer.` }, 400);
    if (!file || typeof file === "string" || file.size === 0) return json({ error: "Choose a picture to upload." }, 400);
    if (file.size > MAX_BYTES) return json({ error: "Picture must be 4 MB or smaller." }, 413);

    const data = await file.arrayBuffer();
    const type = sniffType(new Uint8Array(data, 0, 12));
    if (!type) return json({ error: "Use a JPG, PNG, GIF, or WebP picture." }, 415);

    // Upload -> AI check -> published / human review / trashed
    let result = await moderateImage(data, type);
    if (result.verdict === "ok" && needsFrameReview(type, data)) {
      result = { verdict: "review", reason: "Animated image, needs a manual look" };
    }

    // The uploader pressed "Request manual review" after the AI rejected the image.
    // It is never published automatically: it always waits in the admin review queue.
    if (form.get("appeal") === "1") {
      result = { ...result, verdict: "review", reason: `Uploader requested review. AI said: ${result.reason}` };
    }

    const createdAt = new Date().toISOString();

    if (result.verdict === "reject") {
      // Trashed: the image itself is never stored, only a short note for the admin.
      const log = logStore();
      await log.setJSON(newKey(), {
        name,
        createdAt,
        reason: result.reason,
        top: result.top ?? "",
        score: result.score ?? 0,
      });
      await trimStore(log, MAX_LOG);
      return json({ status: "rejected", error: "That picture was rejected by the content filter." }, 422);
    }

    if (result.verdict === "review") {
      const pending = pendingStore();
      const { blobs } = await pending.list();
      if (blobs.length >= MAX_PENDING) {
        return json({ error: "Too many pictures are waiting for review. Try again later." }, 503);
      }
      await pending.set(newKey(), data, {
        metadata: {
          name,
          type,
          createdAt,
          reason: String(result.reason).slice(0, 120),
          top: result.top ?? "",
          score: result.score ?? 0,
        },
      });
      return json({ status: "pending" }, 202);
    }

    await published().set(newKey(), data, { metadata: { name, type, createdAt } });
    return json({ status: "published" }, 201);
  }

  return json({ error: "Method not allowed." }, 405);
};

export const config = { path: "/api/images" };
