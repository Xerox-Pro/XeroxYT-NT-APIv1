import express from "express";
import { Innertube, UniversalCache } from "youtubei.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// CORS設定
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  next();
});

// YouTubeクライアント作成
const createYoutube = async () => {
  const options = {
    lang: "ja",
    location: "JP",
    cache: new UniversalCache(false),
    generate_session_locally: true
  };
  return await Innertube.create(options);
};

// -------------------------------------------------------------------
// Suggest
// -------------------------------------------------------------------
app.get("/api/suggest", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);

  try {
    const url = `https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(q)}`;
    const response = await fetch(url);
    const text = await response.text();
    const match = text.match(/window\.google\.ac\.h\((.*)\)/);

    if (match && match[1]) {
      const data = JSON.parse(match[1]);
      return res.json(data[1].map(v => v[0]));
    }
    res.json([]);
  } catch {
    res.json([]);
  }
});

// -------------------------------------------------------------------
// Stream info proxy
// -------------------------------------------------------------------
app.get("/api/stream/:videoId", async (req, res) => {
  try {
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ error: "Missing video id" });

    const targetUrl = `https://xeroxdwapi.vercel.app/api/video-info?videoId=${videoId}`;
    const response = await fetch(targetUrl);

    if (!response.ok) {
      return res.status(response.status).json({ error: "Failed to fetch stream info" });
    }

    res.json(await response.json());
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------
// Video proxy (range対応)
// -------------------------------------------------------------------
app.get("/api/video-proxy", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();

  try {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const response = await fetch(url, { headers });
    if (!response.ok && response.status !== 206) return res.status(response.status).end();

    ["content-range", "content-length", "content-type", "accept-ranges"].forEach(h => {
      const v = response.headers.get(h);
      if (v) res.setHeader(h, v);
    });

    res.status(response.status);

    const reader = response.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch {
    if (!res.headersSent) res.status(500).end();
  }
});

// -------------------------------------------------------------------
// Video info
// -------------------------------------------------------------------
app.get("/api/video", async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing video id" });

    const info = await youtube.getInfo(id);

    let candidates = [];
    if (Array.isArray(info.watch_next_feed)) candidates.push(...info.watch_next_feed);
    if (Array.isArray(info.related_videos)) candidates.push(...info.related_videos);

    const seen = new Set();
    const related = [];

    for (const v of candidates) {
      if (v?.id && !seen.has(v.id)) {
        seen.add(v.id);
        related.push(v);
      }
    }

    info.watch_next_feed = related;
    info.related_videos = [];
    info.related = [];
    if (info.secondary_info) info.secondary_info.watch_next_feed = [];

    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------
// Search
// -------------------------------------------------------------------
app.get("/api/search", async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { q, page = "1", sort_by } = req.query;
    if (!q) return res.status(400).json({ error: "Missing search query" });

    const ITEMS = 40;
    const p = parseInt(page);
    const filters = {};
    if (sort_by) filters.sort_by = sort_by;

    let search = await youtube.search(q, filters);
    let videos = [...(search.videos || [])];
    let attempts = 0;

    while (videos.length < p * ITEMS && search.has_continuation && attempts < 15) {
      search = await search.getContinuation();
      videos.push(...(search.videos || []));
      attempts++;
    }

    const start = (p - 1) * ITEMS;
    res.json({
      videos: videos.slice(start, start + ITEMS),
      nextPageToken: videos.length > start + ITEMS ? String(p + 1) : undefined
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------
// Comments
// -------------------------------------------------------------------
app.get("/api/comments", async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id, sort_by } = req.query;
    if (!id) return res.status(400).json({ error: "Missing video id" });

    const sort = sort_by === "newest" ? "NEWEST_FIRST" : "TOP_COMMENTS";
    const comments = await youtube.getComments(id, sort);

    res.json({
      comments: comments.contents || [],
      continuation: comments.continuation_token
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------
// Home feed
// -------------------------------------------------------------------
app.get("/api/fvideo", async (req, res) => {
  try {
    const youtube = await createYoutube();
    const home = await youtube.getHomeFeed();
    res.json({ videos: home.videos || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server ready on port ${PORT}`);
});

export default app;
