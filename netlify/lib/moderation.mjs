// Automatic image moderation using OpenAI's free omni-moderation model.
//
// Verdicts:
//   "ok"     - clearly fine           -> published straight away
//   "review" - uncertain or unchecked -> held for a human in the admin panel
//   "reject" - clearly harmful        -> trashed (never stored)
//
// If anything goes wrong (no API key, timeout, service error) the verdict is
// "review", so an unchecked image is never published automatically.

const ENDPOINT = "https://api.openai.com/v1/moderations";
const MODEL = "omni-moderation-latest";

// Categories the model can score on image input.
const IMAGE_CATEGORIES = [
  "sexual",
  "sexual/minors",
  "violence",
  "violence/graphic",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
];

const number = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export async function moderateImage(bytes, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { verdict: "review", reason: "AI moderation is not set up" };

  // Score at or above this = confirmed harmful; at or above the review score = uncertain.
  const rejectAt = number(process.env.MOD_REJECT_THRESHOLD, 0.9);
  const reviewAt = number(process.env.MOD_REVIEW_THRESHOLD, 0.2);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}` },
          },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return { verdict: "review", reason: `AI service error (${res.status})` };

    const data = await res.json();
    const result = data.results?.[0];
    if (!result) return { verdict: "review", reason: "AI returned no result" };

    const scores = result.category_scores ?? {};
    let top = { category: "", score: 0 };
    for (const category of IMAGE_CATEGORIES) {
      const score = number(scores[category], 0);
      if (score > top.score) top = { category, score };
    }

    const found = { top: top.category, score: Math.round(top.score * 100) / 100 };
    const label = top.category ? `${top.category} ${found.score.toFixed(2)}` : "no category";

    if (result.categories?.["sexual/minors"] || top.score >= rejectAt) {
      return { verdict: "reject", reason: label, ...found };
    }
    if (result.flagged || top.score >= reviewAt) {
      return { verdict: "review", reason: label, ...found };
    }
    return { verdict: "ok", reason: label, ...found };
  } catch {
    return { verdict: "review", reason: "AI check failed or timed out" };
  }
}

// The AI looks at one frame, so animated images always get a human look.
export function needsFrameReview(mimeType, bytes) {
  const buf = Buffer.from(bytes);
  if (mimeType === "image/gif") return true;
  if (mimeType === "image/webp") {
    return buf.length > 20 && buf.toString("ascii", 12, 16) === "VP8X" && (buf[20] & 0x02) !== 0;
  }
  if (mimeType === "image/png") {
    const animation = buf.indexOf("acTL");
    if (animation === -1) return false;
    const firstData = buf.indexOf("IDAT");
    return firstData === -1 || animation < firstData;
  }
  return false;
}
