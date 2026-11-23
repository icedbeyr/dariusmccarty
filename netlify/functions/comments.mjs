import { getStore } from "@netlify/blobs";

const MAX_NAME = 40;
const MAX_COMMENT = 500;
const LIST_LIMIT = 50;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

// Keys sort lexicographically, so a reversed timestamp puts the newest entry first.
const newKey = () =>
  `${String(9999999999999 - Date.now()).padStart(13, "0")}-${crypto.randomUUID()}`;

// Remove control characters but keep tabs/newlines.
const clean = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

const store = () => getStore({ name: "comments", consistency: "strong" });

export default async (req) => {
  if (req.method === "GET") {
    const s = store();
    const { blobs } = await s.list();
    const keys = blobs.map((b) => b.key).sort().slice(0, LIST_LIMIT);
    const items = await Promise.all(keys.map((k) => s.get(k, { type: "json" })));
    return json(items.filter(Boolean));
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid request." }, 400);
    }

    // Honeypot: real visitors never fill this hidden field.
    if (typeof body.website === "string" && body.website !== "") {
      return json({ ok: true });
    }

    const name = typeof body.name === "string" ? clean(body.name) : "";
    const comment = typeof body.comment === "string" ? clean(body.comment) : "";

    if (!name) return json({ error: "Enter your name." }, 400);
    if (!comment) return json({ error: "Enter a comment." }, 400);
    if (name.length > MAX_NAME) return json({ error: `Name must be ${MAX_NAME} characters or fewer.` }, 400);
    if (comment.length > MAX_COMMENT) return json({ error: `Comment must be ${MAX_COMMENT} characters or fewer.` }, 400);

    await store().setJSON(newKey(), {
      name,
      comment,
      createdAt: new Date().toISOString(),
    });
    return json({ ok: true }, 201);
  }

  return json({ error: "Method not allowed." }, 405);
};

export const config = { path: "/api/comments" };
