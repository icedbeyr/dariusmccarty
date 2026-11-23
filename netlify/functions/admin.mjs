import { getStore } from "@netlify/blobs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ID_PATTERN, json, newKey } from "../lib/common.mjs";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // sign-in lasts 12 hours
const LIST_LIMIT = 200;

const open = (name) => getStore({ name, consistency: "strong" });
const stores = {
  comment: () => open("comments"),
  image: () => open("images"),
  pending: () => open("pending-images"),
  log: () => open("moderation-log"),
};

// ---------- Sign-in ----------
const sha = (value) => createHash("sha256").update(value).digest();

function passwordMatches(input) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof input !== "string") return false;
  return timingSafeEqual(sha(input), sha(expected));
}

const sign = (body) =>
  createHmac("sha256", "dm-admin-token:" + process.env.ADMIN_PASSWORD).update(body).digest("base64url");

function makeToken() {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS })).toString("base64url");
  return `${body}.${sign(body)}`;
}

function tokenIsValid(token) {
  if (!process.env.ADMIN_PASSWORD || typeof token !== "string") return false;
  const [body, signature] = token.split(".");
  if (!body || !signature) return false;
  const a = Buffer.from(signature);
  const b = Buffer.from(sign(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()).exp > Date.now();
  } catch {
    return false;
  }
}

const bearer = (req) => (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

// ---------- Listing helpers ----------
async function newest(store, limit = LIST_LIMIT) {
  const { blobs } = await store.list();
  const keys = blobs.map((b) => b.key).sort();
  return { keys: keys.slice(0, limit), total: keys.length };
}

async function listWithMetadata(store, mapper) {
  const { keys, total } = await newest(store);
  const items = await Promise.all(
    keys.map(async (id) => {
      const entry = await store.getMetadata(id);
      return entry ? mapper(id, entry.metadata) : null;
    })
  );
  return { total, items: items.filter(Boolean) };
}

async function listJson(store) {
  const { keys, total } = await newest(store);
  const items = await Promise.all(
    keys.map(async (id) => {
      const value = await store.get(id, { type: "json" });
      return value ? { id, ...value } : null;
    })
  );
  return { total, items: items.filter(Boolean) };
}

export default async (req, context) => {
  const action = context.params.action;

  if (!process.env.ADMIN_PASSWORD) {
    return json({ error: "Admin is not set up yet. Add an ADMIN_PASSWORD environment variable in Netlify." }, 503);
  }

  if (action === "login") {
    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
    let body = {};
    try {
      body = await req.json();
    } catch {
      /* treated as a wrong password below */
    }
    if (!passwordMatches(body.password)) {
      await new Promise((resolve) => setTimeout(resolve, 1000)); // slows down password guessing
      return json({ error: "Wrong password." }, 401);
    }
    return json({ token: makeToken() });
  }

  if (!tokenIsValid(bearer(req))) return json({ error: "Not signed in." }, 401);

  if (action === "overview" && req.method === "GET") {
    const [pending, images, comments, rejected] = await Promise.all([
      listWithMetadata(stores.pending(), (id, m) => ({
        id,
        name: m.name,
        createdAt: m.createdAt,
        reason: m.reason ?? "",
      })),
      listWithMetadata(stores.image(), (id, m) => ({ id, name: m.name, createdAt: m.createdAt })),
      listJson(stores.comment()),
      listJson(stores.log()),
    ]);
    return json({ pending, images, comments, rejected });
  }

  // Pending pictures are private, so the admin page loads them through this endpoint.
  if (action === "pending-image" && req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!ID_PATTERN.test(id)) return json({ error: "Not found." }, 404);
    const entry = await stores.pending().getWithMetadata(id, { type: "arrayBuffer" });
    if (!entry) return json({ error: "Not found." }, 404);
    return new Response(entry.data, {
      headers: {
        "Content-Type": entry.metadata.type,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (action === "approve" && req.method === "POST") {
    const { id } = await req.json().catch(() => ({}));
    if (!ID_PATTERN.test(id ?? "")) return json({ error: "Invalid picture." }, 400);
    const pending = stores.pending();
    const entry = await pending.getWithMetadata(id, { type: "arrayBuffer" });
    if (!entry) return json({ error: "That picture is no longer waiting for review." }, 404);
    const { name, type, createdAt } = entry.metadata;
    // A new key makes the approved picture appear at the top of "Recent Pictures".
    await stores.image().set(newKey(), entry.data, { metadata: { name, type, createdAt } });
    await pending.delete(id);
    return json({ ok: true });
  }

  if (action === "delete" && req.method === "POST") {
    const { type, id } = await req.json().catch(() => ({}));
    if (!stores[type] || !ID_PATTERN.test(id ?? "")) return json({ error: "Invalid request." }, 400);
    await stores[type]().delete(id);
    return json({ ok: true });
  }

  if (action === "clear-log" && req.method === "POST") {
    const log = stores.log();
    const { blobs } = await log.list();
    await Promise.all(blobs.map((b) => log.delete(b.key)));
    return json({ ok: true });
  }

  return json({ error: "Not found." }, 404);
};

export const config = { path: "/api/admin/:action" };
